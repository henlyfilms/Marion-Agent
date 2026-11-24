import { timingSafeEqual } from 'node:crypto';
import { appEnv, env } from '../env.js';

export const desktopAccessHeader = 'x-marion-desktop-session';
const token = appEnv('DESKTOP_TOKEN');
const expected = token ? Buffer.from(token) : null;
export const isDesktop = expected !== null && env.host === '127.0.0.1' && env.openSignup;

export function hasDesktopAccess(value: unknown) {
  if (!expected) return true;
  if (typeof value !== 'string') return false;
  const candidate = Buffer.from(value);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export interface RemoteWorkspaceAccess {
  kind: 'mobile' | 'browser';
  origin: string;
  passphrase: string;
}

const mobileAccess: RemoteWorkspaceAccess | null = env.mobileAccess && { ...env.mobileAccess, kind: 'mobile' };
const browserAccess: RemoteWorkspaceAccess | null = env.browserAccess && { ...env.browserAccess, kind: 'browser' };

export function remoteWorkspaceAccess(host: unknown, forwardedProto: unknown): RemoteWorkspaceAccess | null {
  if (!isDesktop || forwardedProto !== 'https') return null;
  if (mobileAccess && host === env.mobileAccess?.host) return mobileAccess;
  if (browserAccess && host === env.browserAccess?.host) return browserAccess;
  return null;
}
