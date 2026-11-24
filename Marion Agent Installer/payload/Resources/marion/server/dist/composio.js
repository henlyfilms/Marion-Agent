import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Composio } from '@composio/core';
import { OpenAIResponsesProvider } from '@composio/openai';
import { db } from './db.js';
import { env } from './env.js';
const keyManagedByEnvironment = Boolean(env.composioKey);
const connectorFile = join(dirname(env.dbPath), 'composio.key');
export const canManageComposio = env.devLogin && !keyManagedByEnvironment;
if (canManageComposio) {
    try {
        env.composioKey = readFileSync(connectorFile, 'utf8').trim();
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            console.warn('[composio] Could not read local project key');
    }
}
let credentialRevision = 0;
export function composioStatus() {
    return { configured: Boolean(env.composioKey), editable: canManageComposio };
}
export async function updateComposioKey(key) {
    if (!canManageComposio)
        throw new Error('Manage the project key through COMPOSIO_API_KEY on the server');
    if (key) {
        let response;
        try {
            response = await fetch(`${REST}/toolkits?limit=1`, {
                headers: { 'x-api-key': key }, signal: AbortSignal.timeout(10000), redirect: 'error',
            });
        }
        catch {
            throw new Error('Could not reach Composio to verify the project key');
        }
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403)
            throw new Error('Composio rejected the project key or access is blocked');
        if (!response.ok)
            throw new Error(`Composio key verification failed (HTTP ${response.status})`);
        mkdirSync(dirname(connectorFile), { recursive: true });
        const pending = `${connectorFile}.${randomUUID()}.tmp`;
        try {
            writeFileSync(pending, key + '\n', { mode: 0o600, flag: 'wx' });
            renameSync(pending, connectorFile);
        }
        finally {
            rmSync(pending, { force: true });
        }
    }
    else {
        rmSync(connectorFile, { force: true });
    }
    env.composioKey = key;
    credentialRevision++;
    const previous = client;
    client = undefined;
    void previous?.triggers.unsubscribe().catch(() => console.warn('[composio] Could not close previous trigger subscription'));
    catalogCache = null;
    sessionCache.clear();
    db.exec('DELETE FROM composio_sessions; DELETE FROM app_link_attempts');
    return composioStatus();
}
let client;
export function composio() {
    if (!env.composioKey)
        throw new Error('Configure COMPOSIO_API_KEY for connected apps');
    return client ??= new Composio({ apiKey: env.composioKey, provider: new OpenAIResponsesProvider() });
}
const REST = 'https://backend.composio.dev/api/v3.1';
async function rest(path) {
    if (!env.composioKey)
        throw new Error('Configure COMPOSIO_API_KEY for connected apps');
    const res = await fetch(`${REST}${path}`, { headers: { 'x-api-key': env.composioKey }, signal: AbortSignal.timeout(12000), redirect: 'error' });
    if (!res.ok)
        throw new Error(`Composio catalog request failed (HTTP ${res.status})`);
    return res.json();
}
let catalogCache = null;
export async function catalog() {
    if (!env.composioKey)
        return [];
    const revision = credentialRevision;
    if (catalogCache && Date.now() - catalogCache.at < 3600_000)
        return catalogCache.items;
    const items = [];
    let cursor;
    for (let page = 0; page < 3; page++) {
        const r = await rest(`/toolkits?sort_by=usage&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        for (const t of r.items ?? []) {
            items.push({
                slug: t.slug,
                name: t.name,
                logo: t.meta?.logo,
                description: t.meta?.description,
                categories: (t.meta?.categories ?? []).map((c) => c.name ?? c.id),
                managedAuth: (t.composio_managed_auth_schemes ?? []).length > 0,
                noAuth: !!t.no_auth,
            });
        }
        cursor = r.next_cursor;
        if (!cursor)
            break;
    }
    if (revision !== credentialRevision)
        return [];
    catalogCache = { at: Date.now(), items };
    return items;
}
export async function toolkitInfo(slug) {
    return (await catalog()).find((t) => t.slug === slug);
}
// ---------- per-user connections ----------
export async function connectedToolkits(userId) {
    if (!env.composioKey)
        return new Set();
    const r = await composio().connectedAccounts.list({ userIds: [userId], statuses: ['ACTIVE'] });
    const items = r.items ?? [];
    return new Set(items.map((i) => i.toolkit?.slug ?? i.toolkitSlug).filter(Boolean));
}
export async function connectionsDetail(userId) {
    const r = await composio().connectedAccounts.list({ userIds: [userId] });
    return (r.items ?? []).map((i) => ({ id: i.id, toolkit: i.toolkit?.slug ?? i.toolkitSlug, status: i.status }));
}
export async function disconnect(userId, toolkit) {
    for (const c of await connectionsDetail(userId)) {
        if (c.toolkit === toolkit)
            await composio().connectedAccounts.delete(c.id);
    }
    sessionCache.delete(userId);
}
// ---------- sessions (tool router) ----------
const sessionCache = new Map();
export async function sessionFor(userId) {
    const revision = credentialRevision;
    const cached = sessionCache.get(userId);
    if (cached)
        return cached;
    const row = db.prepare('SELECT session_id FROM composio_sessions WHERE user_id=?').get(userId);
    let session;
    if (row) {
        try {
            session = await composio().use(row.session_id);
        }
        catch {
            session = null;
        }
    }
    if (!session) {
        session = await composio().create(userId, { manageConnections: false });
        if (revision !== credentialRevision)
            throw new Error('Composio project changed. Try again.');
        db.prepare('INSERT OR REPLACE INTO composio_sessions(user_id, session_id) VALUES (?,?)').run(userId, session.sessionId);
    }
    if (revision !== credentialRevision)
        throw new Error('Composio project changed. Try again.');
    sessionCache.set(userId, session);
    return session;
}
/** Start a connect flow; returns the hosted Connect Link URL. */
export async function startConnect(userId, toolkit, callbackUrl) {
    const session = await sessionFor(userId);
    const req = await session.authorize(toolkit, { callbackUrl });
    return { redirectUrl: req.redirectUrl, connectedAccountId: req.id };
}
/** OpenAI-Responses-format function tools for this user's Composio session (meta tools). */
export async function composioTools(userId) {
    if (!env.composioKey)
        return [];
    try {
        const session = await sessionFor(userId);
        const tools = await session.tools();
        return Array.isArray(tools) ? tools : [];
    }
    catch (e) {
        console.warn('[composio] tools unavailable', e.message);
        return [];
    }
}
export async function executeComposio(userId, name, args) {
    const session = await sessionFor(userId);
    const r = await session.execute(name, args);
    return r;
}
/** Which inner tool slugs a Composio meta-tool call would run (for approval checks). */
export function innerToolSlugs(name, args) {
    if (name === 'COMPOSIO_MULTI_EXECUTE_TOOL') {
        const list = args?.tools ?? args?.tool_calls ?? args?.actions ?? [];
        return (Array.isArray(list) ? list : []).map((t) => String(t.tool_slug ?? t.slug ?? t.name ?? t.tool ?? '')).filter(Boolean);
    }
    if (name.startsWith('COMPOSIO_'))
        return [];
    return [name];
}
const READ_RE = /_(GET|LIST|SEARCH|FETCH|FIND|READ|RETRIEVE|QUERY|LOOKUP|CHECK|DESCRIBE|VIEW|COUNT)(_|$)/;
// A read word alone isn't enough: e.g. GITHUB_CREATE_CHECK_RUN contains CHECK but writes.
const WRITE_RE = /_(CREATE|UPDATE|DELETE|REMOVE|SEND|POST|PUT|PATCH|ADD|INSERT|MOVE|COPY|UPLOAD|SET|EDIT|MODIFY|REPLY|FORWARD|INVITE|SHARE|ARCHIVE|TRASH|ENABLE|DISABLE|RUN|EXECUTE|START|STOP|CANCEL|APPROVE|MERGE|CLOSE|PUBLISH|ASSIGN|TRANSFER|PAY|REFUND|MARK)(_|$)/;
export const isReadOnlySlug = (slug) => READ_RE.test(slug.toUpperCase()) && !WRITE_RE.test(slug.toUpperCase());
// ---------- sign-in via Composio-managed Google (Gmail) connection ----------
export async function startGoogleLogin(provisionalUserId, callbackUrl) {
    const session = await composio().create(provisionalUserId, { manageConnections: false });
    const req = await session.authorize('gmail', { callbackUrl });
    return { redirectUrl: req.redirectUrl, connectedAccountId: req.id };
}
export async function googleProfile(connectedAccountId) {
    const r = await composio().tools.proxyExecute({
        endpoint: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
        method: 'GET',
        connectedAccountId,
    });
    const data = r?.data ?? r;
    const email = data?.emailAddress ?? data?.email;
    if (!email)
        throw new Error(`Could not read Google profile: ${JSON.stringify(r).slice(0, 300)}`);
    return { email, name: undefined };
}
export async function deleteConnection(id) {
    try {
        await composio().connectedAccounts.delete(id);
    }
    catch { /* ignore */ }
}
//# sourceMappingURL=composio.js.map