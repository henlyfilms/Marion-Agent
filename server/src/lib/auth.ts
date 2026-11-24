import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { createHmac } from 'node:crypto';
import { db, now } from '../db.js';
import { env } from '../env.js';
import { remoteWorkspaceAccess, type RemoteWorkspaceAccess } from './desktop-access.js';
import { token } from './ids.js';
import type { User } from '../types.js';

const COOKIE = 'marion_agent_session';
const BROWSER_COOKIE = '__Host-marion_agent_browser';
const TTL_MS = 30 * 24 * 3600 * 1000;
const BROWSER_TTL_MS = 8 * 60 * 60 * 1000;

export type AuthVars = { Variables: { user: User } };

const cookieName = (access?: RemoteWorkspaceAccess | null) => access?.kind === 'browser' ? BROWSER_COOKIE : COOKIE;

// Browser credentials can be revoked by rotating the browser passphrase. Existing local and iPhone
// sessions retain their original cookie names and keys.
function sessionKey(t: string | undefined, access?: RemoteWorkspaceAccess | null) {
  if (!t || access?.kind !== 'browser') return t;
  return createHmac('sha256', access.passphrase).update(access.origin).update('\0').update(t).digest('hex');
}

export function remoteAccessFor(c: Context) {
  return remoteWorkspaceAccess(c.req.header('host'), c.req.header('x-forwarded-proto'));
}

export function createSession(c: Context, userId: string, access?: RemoteWorkspaceAccess) {
  const t = token();
  const ttl = access?.kind === 'browser' ? BROWSER_TTL_MS : TTL_MS;
  const issued = now();
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(sessionKey(t, access), userId, issued, issued + ttl);
  setCookie(c, cookieName(access), t, { httpOnly: true, secure: !!access || env.secureCookies, sameSite: 'Lax', path: '/', maxAge: ttl / 1000 });
}

export function destroySession(c: Context, access: RemoteWorkspaceAccess | null) {
  const name = cookieName(access);
  const key = sessionKey(getCookie(c, name), access);
  if (key) db.prepare('DELETE FROM auth_sessions WHERE token=?').run(key);
  deleteCookie(c, name, { path: '/', secure: !!access || env.secureCookies });
}

export function remoteWorkspaceUser(cookie: string | undefined, access: RemoteWorkspaceAccess): User | null {
  const user = userFromCookieHeader(cookie, access);
  if (!user) return null;
  const workspace = db.prepare('SELECT user_id FROM desktop_workspace WHERE slot=1').get() as { user_id: string } | undefined;
  return workspace?.user_id === user.id ? user : null;
}

export function userFromToken(t: string | undefined): User | null {
  if (!t) return null;
  const r = db
    .prepare('SELECT u.* FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?')
    .get(t, now()) as any;
  return r ? { id: r.id, email: r.email, name: r.name, avatarUrl: r.avatar_url } : null;
}

export function userFromCookieHeader(cookieHeader: string | undefined, access?: RemoteWorkspaceAccess | null): User | null {
  const name = cookieName(access);
  const parts = cookieHeader?.split(/;\s*/) ?? [];
  const entry = parts.find((part) => part.startsWith(`${name}=`));
  if (!entry) return null;
  try { return userFromToken(sessionKey(decodeURIComponent(entry.slice(name.length + 1)), access)); } catch { return null; }
}

export const requireUser: MiddlewareHandler<AuthVars> = async (c, next) => {
  const access = remoteAccessFor(c);
  const u = access ? remoteWorkspaceUser(c.req.header('cookie'), access) : userFromToken(getCookie(c, COOKIE));
  if (!u) return c.json({ error: 'unauthenticated' }, 401);
  c.set('user', u);
  await next();
};
