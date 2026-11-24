import { WebSocket, WebSocketServer } from 'ws';
import { db } from './db.js';
import { env } from './env.js';
import { desktopAccessHeader, hasDesktopAccess, remoteWorkspaceAccess } from './lib/desktop-access.js';
import { remoteWorkspaceUser, userFromCookieHeader } from './lib/auth.js';
import { desktop } from './desktop.js';
import { screenFor } from './computer.js';
import { viewerClosed, viewerOpened } from './idle.js';
/**
 * VNC relay: browser <-> API server <-> isolated desktop.
 * The desktop listener is private to its container. The API checks app authentication
 * before offering the browser an RFB session. In watch mode, client input messages
 * (KeyEvent, PointerEvent, ClientCutText) are dropped server-side.
 */
class ByteQueue {
    buf = Buffer.alloc(0);
    waiters = [];
    closed = null;
    push(b) { this.buf = Buffer.concat([this.buf, b]); this.drain(); }
    close(e) { this.closed = e; for (const w of this.waiters)
        w.reject(e); this.waiters = []; }
    read(n) {
        return new Promise((resolve, reject) => {
            if (this.closed)
                return reject(this.closed);
            this.waiters.push({ n, resolve, reject });
            this.drain();
        });
    }
    takeAll() { const b = this.buf; this.buf = Buffer.alloc(0); return b; }
    drain() {
        while (this.waiters.length && this.buf.length >= this.waiters[0].n) {
            const w = this.waiters.shift();
            const out = this.buf.subarray(0, w.n);
            this.buf = this.buf.subarray(w.n);
            w.resolve(Buffer.from(out));
        }
    }
}
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
async function upstreamHandshake(q, send) {
    await q.read(12); // server ProtocolVersion
    send(Buffer.from('RFB 003.008\n'));
    const n = (await q.read(1))[0];
    if (n === 0) {
        const len = (await q.read(4)).readUInt32BE();
        throw new Error(`VNC refused: ${(await q.read(len)).toString()}`);
    }
    if (!(await q.read(n)).includes(1))
        throw new Error('Desktop does not offer the expected loopback security type');
    send(Buffer.from([1]));
    const result = (await q.read(4)).readUInt32BE();
    if (result !== 0) {
        let reason = '';
        try {
            const len = (await q.read(4)).readUInt32BE();
            reason = (await q.read(len)).toString();
        }
        catch { /* none */ }
        throw new Error(`VNC auth failed ${reason}`);
    }
    send(Buffer.from([1])); // ClientInit: shared
    const head = await q.read(24); // w,h,pixfmt(16),nameLen
    const nameLen = head.readUInt32BE(20);
    const name = await q.read(nameLen);
    return Buffer.concat([head, name]);
}
async function browserHandshake(q, send, serverInit) {
    send(Buffer.from('RFB 003.008\n'));
    await q.read(12);
    send(Buffer.from([1, 1])); // one security type: None
    await q.read(1);
    send(u32(0)); // SecurityResult OK
    await q.read(1); // ClientInit
    send(serverInit);
}
/** Filters a client->server RFB stream, dropping input events. Returns bytes to forward. */
class WatchFilter {
    pending = Buffer.alloc(0);
    feed(chunk) {
        this.pending = Buffer.concat([this.pending, chunk]);
        const out = [];
        for (;;) {
            const b = this.pending;
            if (!b.length)
                break;
            const len = msgLength(b);
            if (len === -1) {
                this.pending = Buffer.alloc(0);
                break;
            } // unknown: fail closed
            if (len === 0 || b.length < len)
                break; // need more bytes
            const msg = b.subarray(0, len);
            const t = b[0];
            if (t !== 4 && t !== 5 && t !== 6)
                out.push(Buffer.from(msg));
            this.pending = b.subarray(len);
        }
        return Buffer.concat(out);
    }
}
/** Length of the client message at the head of `b`, 0 if more bytes are needed to know, -1 if unknown. */
function msgLength(b) {
    const t = b[0];
    switch (t) {
        case 0: return 20; // SetPixelFormat
        case 2: return b.length < 4 ? 0 : 4 + 4 * b.readUInt16BE(2); // SetEncodings
        case 3: return 10; // FramebufferUpdateRequest
        case 4: return 8; // KeyEvent
        case 5: return 6; // PointerEvent
        case 6: return b.length < 8 ? 0 : 8 + Math.abs(b.readInt32BE(4)); // ClientCutText (+extended)
        case 150: return 10; // EnableContinuousUpdates
        case 248: return b.length < 9 ? 0 : 9 + b[8]; // ClientFence
        case 251: return b.length < 8 ? 0 : 8 + 16 * b[6]; // SetDesktopSize
        default: return -1;
    }
}
const sameHost = (origin, host) => {
    try {
        return !!host && new URL(origin).host === host;
    }
    catch {
        return false;
    }
};
export function attachVncRelay(server) {
    const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false) });
    server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url ?? '/', 'http://x');
        const m = url.pathname.match(/^\/api\/bots\/([^/]+)\/screen$/);
        if (!m)
            return; // not ours
        const access = remoteWorkspaceAccess(req.headers.host, req.headers['x-forwarded-proto']);
        if (!hasDesktopAccess(req.headers[desktopAccessHeader]) && !access) {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
        }
        // Browsers always send Origin on WebSocket upgrades; refuse other sites riding the session cookie.
        const origin = req.headers.origin;
        if (access ? origin !== access.origin : origin && !env.trustedOrigins.includes(origin) && !sameHost(origin, req.headers.host)) {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
        }
        const user = access ? remoteWorkspaceUser(req.headers.cookie, access) : userFromCookieHeader(req.headers.cookie);
        const bot = user ? db.prepare('SELECT * FROM bots WHERE id=? AND user_id=?').get(m[1], user.id) : null;
        if (!user || !bot) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }
        const mode = url.searchParams.get('mode') === 'control' ? 'control' : 'watch';
        wss.handleUpgrade(req, socket, head, (client) => relay(client, user.id, bot.id, mode));
    });
}
async function relay(client, userId, botId, mode) {
    const fromClient = new ByteQueue();
    const fromUp = new ByteQueue();
    let upstream = null;
    let piping = false;
    const filter = new WatchFilter();
    const closeAll = (code = 1000, reason = '') => {
        try {
            client.close(code, reason.slice(0, 120));
        }
        catch { /* */ }
        try {
            upstream?.kill();
        }
        catch { /* */ }
    };
    client.on('message', (data) => {
        if (!piping)
            return fromClient.push(Buffer.from(data));
        const fwd = mode === 'watch' ? filter.feed(Buffer.from(data)) : Buffer.from(data);
        if (fwd.length && upstream?.stdin.writable)
            upstream.stdin.write(fwd);
    });
    client.on('close', () => { viewerClosed(userId); fromClient.close(new Error('client closed')); try {
        upstream?.kill();
    }
    catch { /* */ } });
    viewerOpened(userId); // keeps the computer awake while someone is watching (see idle.ts)
    try {
        const desktopId = await screenFor(userId, botId);
        if (client.readyState !== WebSocket.OPEN)
            return;
        upstream = desktop.vnc(desktopId);
        upstream.stderr.resume();
        upstream.stdin.on('error', error => fromUp.close(error));
        upstream.stdout.on('data', (data) => {
            if (!piping)
                return fromUp.push(Buffer.from(data));
            if (client.readyState === WebSocket.OPEN)
                client.send(data);
        });
        upstream.on('close', () => { fromUp.close(new Error('Desktop disconnected')); closeAll(); });
        upstream.on('error', (e) => { fromUp.close(e); closeAll(1011, String(e)); });
        const serverInit = await upstreamHandshake(fromUp, (b) => upstream.stdin.write(b));
        await browserHandshake(fromClient, (b) => client.send(b), serverInit);
        // Flush anything that arrived during the handshake, then switch to piping.
        piping = true;
        const leftoverUp = fromUp.takeAll();
        if (leftoverUp.length)
            client.send(leftoverUp);
        const leftoverClient = fromClient.takeAll();
        if (leftoverClient.length) {
            const fwd = mode === 'watch' ? filter.feed(leftoverClient) : leftoverClient;
            if (fwd.length)
                upstream.stdin.write(fwd);
        }
    }
    catch (e) {
        console.warn('[vnc] relay failed', e?.message ?? e);
        closeAll(1011, String(e?.message ?? e));
    }
}
//# sourceMappingURL=vnc.js.map