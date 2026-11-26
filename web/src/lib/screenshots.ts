// Recent-screenshots picker: server calls, the keyboard shortcut, and getting a picture ready to attach.

/** Window event the picker uses to hand files to the open chat box (Composer). */
export const ATTACH_EVENT = 'marion-agent:attach-files';

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** ⇧⌘S on a Mac, Ctrl+Shift+S elsewhere. Command/Control is the "mod" key like ⌘K and ⌘B. */
export const SCREENSHOT_SHORTCUT_LABEL = isMac ? '⇧⌘S' : 'Ctrl+Shift+S';

export function isScreenshotShortcut(event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'code'>) {
  return event.code === 'KeyS' && event.shiftKey && !event.altKey && (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
}

export interface ScreenshotEntry { name: string; at: number; size: number }
export interface ScreenshotPage { folder: string; items: ScreenshotEntry[]; total: number }

async function fail(res: Response): Promise<never> {
  let message = res.statusText;
  try { message = ((await res.json()) as { error?: string }).error ?? message; } catch { /* not json */ }
  throw new Error(message);
}

export async function listScreenshots(limit: number, offset: number, signal?: AbortSignal): Promise<ScreenshotPage> {
  const res = await fetch(`/api/screenshots?limit=${limit}&offset=${offset}`, { credentials: 'include', cache: 'no-store', signal });
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

export function attachFiles(botId: string, files: File[]) {
  // A Composer acknowledges it only after adding the files to its draft.
  return !window.dispatchEvent(new CustomEvent(ATTACH_EVENT, { cancelable: true, detail: { botId, files } }));
}
