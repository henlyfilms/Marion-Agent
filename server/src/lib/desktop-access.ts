import { timingSafeEqual } from 'node:crypto';

export const desktopAccessHeader = 'x-marion-desktop-session';

const expected = process.env.MARION_DESKTOP_TOKEN;
const secret = expected ? Buffer.from(expected) : null;

export function hasDesktopAccess(value: string | string[] | undefined) {
  if (!secret) return true;
  if (typeof value !== 'string') return false;
  const candidate = Buffer.from(value);
  return candidate.length === secret.length && timingSafeEqual(candidate, secret);
}
