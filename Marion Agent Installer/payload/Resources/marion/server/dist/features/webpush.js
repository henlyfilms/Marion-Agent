import { createECDH, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, createCipheriv, randomBytes, sign } from 'node:crypto';
import { getSecret, setSecret } from './schema.js';
/**
 * Minimal Web Push sender (RFC 8291 aes128gcm payload encryption + RFC 8292 VAPID),
 * using only node:crypto so the packaged app needs no extra dependency.
 * iPhone delivery works for Home Screen web apps on iOS 16.4+ over HTTPS.
 */
const b64url = (buf) => buf.toString('base64url');
const fromB64url = (s) => Buffer.from(s, 'base64url');
let vapid;
export function vapidKeys() {
    if (vapid)
        return vapid;
    let jwk = getSecret('vapid_jwk');
    if (!jwk) {
        const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        jwk = JSON.stringify(privateKey.export({ format: 'jwk' }));
        setSecret('vapid_jwk', jwk);
    }
    const privateKey = createPrivateKey({ key: JSON.parse(jwk), format: 'jwk' });
    const pub = createPublicKey(privateKey).export({ format: 'jwk' });
    vapid = { privateKey, publicRaw: Buffer.concat([Buffer.from([4]), fromB64url(pub.x), fromB64url(pub.y)]) };
    return vapid;
}
export const vapidPublicKey = () => b64url(vapidKeys().publicRaw);
function vapidJwt(audience, subject) {
    const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
    const claims = b64url(Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
    const data = `${header}.${claims}`;
    const signature = sign('sha256', Buffer.from(data), { key: vapidKeys().privateKey, dsaEncoding: 'ieee-p1363' });
    return `${data}.${b64url(signature)}`;
}
export function encryptPayload(p256dh, auth, payload) {
    const clientPublic = fromB64url(p256dh);
    const authSecret = fromB64url(auth);
    if (clientPublic.length !== 65 || authSecret.length < 16)
        throw new Error('Invalid push subscription keys');
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const serverPublic = ecdh.getPublicKey();
    const shared = ecdh.computeSecret(clientPublic);
    const salt = randomBytes(16);
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), clientPublic, serverPublic]);
    const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const cipher = createCipheriv('aes-128-gcm', cek, nonce);
    const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
    const header = Buffer.alloc(21);
    salt.copy(header, 0);
    header.writeUInt32BE(4096, 16);
    header.writeUInt8(serverPublic.length, 20);
    return Buffer.concat([header, serverPublic, body]);
}
/** Send one notification. Returns the push service's HTTP status (201 = accepted, 404/410 = subscription gone). */
export async function sendPush(target, message, subject) {
    const url = new URL(target.endpoint);
    if (url.protocol !== 'https:')
        throw new Error('Push endpoints must use HTTPS');
    const body = encryptPayload(target.p256dh, target.auth, Buffer.from(JSON.stringify(message)));
    const response = await fetch(target.endpoint, {
        method: 'POST',
        headers: {
            Authorization: `vapid t=${vapidJwt(url.origin, subject)}, k=${vapidPublicKey()}`,
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            TTL: '86400',
            Urgency: 'high',
        },
        body,
        signal: AbortSignal.timeout(15_000),
    });
    return response.status;
}
//# sourceMappingURL=webpush.js.map