import { timingSafeEqual } from 'node:crypto';
import { appEnv, env } from '../env.js';
export const desktopAccessHeader = 'x-marion-desktop-session';
const token = appEnv('DESKTOP_TOKEN');
const expected = token ? Buffer.from(token) : null;
export const isDesktop = expected !== null && env.host === '127.0.0.1' && env.openSignup;
export function hasDesktopAccess(value) {
    if (!expected)
        return true;
    if (typeof value !== 'string')
        return false;
    const candidate = Buffer.from(value);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
const mobileAccess = env.mobileAccess && { ...env.mobileAccess, kind: 'mobile' };
const browserAccess = env.browserAccess && { ...env.browserAccess, kind: 'browser' };
export function remoteWorkspaceAccess(host, forwardedProto) {
    if (!isDesktop || forwardedProto !== 'https')
        return null;
    if (mobileAccess && host === env.mobileAccess?.host)
        return mobileAccess;
    if (browserAccess && host === env.browserAccess?.host)
        return browserAccess;
    return null;
}
//# sourceMappingURL=desktop-access.js.map