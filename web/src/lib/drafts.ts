/**
 * Unsent text for each bot's chat box. Kept in localStorage (not just memory) so it survives switching
 * chats, reloads, app updates and crashes: the owner never loses a half-written or dictated message.
 */
const KEY = 'marion.drafts.v1';

function load(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') ?? {}; } catch { return {}; }
}

const all = load();

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* Storage full or blocked: memory copy still holds it. */ }
}

export const getDraft = (botId: string) => all[botId] ?? '';

export function setDraft(botId: string, text: string) {
  if ((all[botId] ?? '') === text) return;
  if (text) all[botId] = text;
  else delete all[botId];
  save();
}

export const clearDraft = (botId: string) => setDraft(botId, '');

/** Adds words to a draft (used when a dictation finishes after its chat was closed). */
export function appendToDraft(botId: string, words: string, join: (current: string, words: string) => string) {
  if (words.trim()) setDraft(botId, join(getDraft(botId), words));
}
