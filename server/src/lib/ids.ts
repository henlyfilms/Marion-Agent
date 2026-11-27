import crypto from 'node:crypto';

export const newId = (prefix: string) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
export const token = () => crypto.randomBytes(32).toString('base64url');
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

let runCounter = 0;
/**
 * A short id that is unique within this server process, for relayed runs started in the same millisecond (concurrent
 * ask_subscription calls, parallel team assignments): a per-process counter plus random bytes, so ids never collide.
 */
export const runId = () => `${(++runCounter).toString(36)}${crypto.randomBytes(3).toString('hex')}`;
