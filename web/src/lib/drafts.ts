/**
 * Unsent text for each bot's chat box. Kept in localStorage (not just memory) so it survives switching
 * chats, reloads, app updates and crashes: the owner never loses a half-written or dictated message.
 */
const KEY = 'marion.drafts.v1';

function load(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') ?? {}; } catch { return {}; }
}

const all = load();

function write() {
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* Storage full or blocked: memory copy still holds it. */ }
}

// The in-memory copy is updated at once (chat switches read it), but the synchronous localStorage write is
// coalesced so a burst of dictated words or keystrokes costs one write, and it is flushed when the page hides.
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function save() {
  if (saveTimer !== undefined) return;
  saveTimer = setTimeout(flushDrafts, 120);
}
export function flushDrafts() {
  if (saveTimer !== undefined) { clearTimeout(saveTimer); saveTimer = undefined; }
  write();
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushDrafts);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushDrafts(); });
}

export const getDraft = (botId: string) => all[botId] ?? '';

export function setDraft(botId: string, text: string) {
  if ((all[botId] ?? '') === text) return;
  if (text) all[botId] = text;
  else delete all[botId];
  save();
}

export const clearDraft = (botId: string) => setDraft(botId, '');
