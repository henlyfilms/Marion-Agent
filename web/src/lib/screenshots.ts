// Recent-screenshots picker: server calls, the keyboard shortcut, and getting a picture ready to attach.

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** ⇧⌘S on a Mac, Ctrl+Shift+S elsewhere. Command/Control is the "mod" key like ⌘K and ⌘B. */
export const SCREENSHOT_SHORTCUT_LABEL = isMac ? '⇧⌘S' : 'Ctrl+Shift+S';

export function isScreenshotShortcut(event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'code' | 'key'>) {
  // The letter S wherever the layout puts it (Dvorak, AZERTY…); the physical S key for non-Latin layouts.
  const letter = event.key?.toLowerCase() ?? '';
  return (/^[a-z]$/.test(letter) ? letter === 's' : event.code === 'KeyS') && event.shiftKey && !event.altKey && (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
}

export interface ScreenshotEntry { name: string; at: number; size: number }
/** `total` counts what the query matches; `pastHour` counts every screenshot from the last 60 minutes. */
export interface ScreenshotPage { folder: string; items: ScreenshotEntry[]; total: number; pastHour: number }

/** The shortcut shows this many newest screenshots; "Past hour" lists the rest from the last 60 minutes. */
export const RECENT_SHOTS = 3;
export const PAST_HOUR_MS = 60 * 60 * 1000;

export interface ScreenshotQuery { limit: number; offset?: number; since?: number }
export const screenshotsPath = ({ limit, offset = 0, since }: ScreenshotQuery) =>
  `/api/screenshots?limit=${limit}&offset=${offset}${since === undefined ? '' : `&since=${Math.floor(since)}`}`;
/** The quick view: the three newest, however old. */
export const recentQuery = (): ScreenshotQuery => ({ limit: RECENT_SHOTS });
/** Past hour: the screenshots from the last 60 minutes after the three the quick view already shows. */
export const pastHourQuery = (now = Date.now(), limit = 60, offset = 0): ScreenshotQuery =>
  ({ limit, offset: RECENT_SHOTS + offset, since: now - PAST_HOUR_MS });
/** How many past-hour screenshots the quick view is not showing (they are always its newest ones). */
export const moreInPastHour = (page: Pick<ScreenshotPage, 'pastHour'>) => Math.max(0, page.pastHour - RECENT_SHOTS);
/** How many screenshots a view pages through. The server's past-hour `total` includes the three the quick view shows. */
export const listedTotal = (page: Pick<ScreenshotPage, 'total'>, pastHourView: boolean) =>
  pastHourView ? Math.max(0, page.total - RECENT_SHOTS) : page.total;

async function fail(res: Response): Promise<never> {
  let message = res.statusText;
  try { message = ((await res.json()) as { error?: string }).error ?? message; } catch { /* not json */ }
  throw new Error(message);
}

export async function listScreenshots(query: ScreenshotQuery, signal?: AbortSignal): Promise<ScreenshotPage> {
  const res = await fetch(screenshotsPath(query), { credentials: 'include', cache: 'no-store', signal });
  return res.ok ? res.json() : fail(res);
}

export const screenshotUrl = (entry: ScreenshotEntry, thumbnail: boolean) =>
  `/api/screenshots/image?name=${encodeURIComponent(entry.name)}&v=${entry.at}${thumbnail ? '&thumb=1' : ''}`;

const MAX_PHOTO = 4 * 1024 * 1024;

/** Downloads a screenshot as a File, shrinking it if a retina capture is over the 4 MB photo limit. */
export async function screenshotFile(entry: ScreenshotEntry, signal?: AbortSignal): Promise<File> {
  const res = await fetch(screenshotUrl(entry, false), { credentials: 'include', signal });
  if (!res.ok) return fail(res);
  const blob = await res.blob();
  if (blob.size <= MAX_PHOTO) return new File([blob], entry.name, { type: blob.type, lastModified: entry.at });
  const bitmap = await createImageBitmap(blob);
  const jpeg = entry.name.replace(/\.[^.]+$/, '') + '.jpg';
  for (let scale = 0.8; scale > 0.15; scale *= 0.75) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) break;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const smaller = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (smaller && smaller.size <= MAX_PHOTO) { bitmap.close(); return new File([smaller], jpeg, { type: 'image/jpeg', lastModified: entry.at }); }
  }
  bitmap.close();
  throw new Error('That screenshot is too large to attach.');
}
