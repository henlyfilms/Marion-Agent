// What a message sent to a busy bot means: stop everything, do this first, or just add it to the work (the default).
// Pure functions, no I/O, so they are easy to test.

export type MessageIntent = 'stop' | 'override' | 'additive';

/** Drop the bracketed notes (reply quotes, media notes) the server puts in front of the user's own words. */
export function userWords(text: string) {
  let t = text.trim();
  while (/^\[[^\n]*\]\s*\n/.test(t)) t = t.replace(/^\[[^\n]*\]\s*\n/, '');
  return t.trim();
}

/** Lower-case, drop punctuation (dictation adds it freely: "Stop.", "Work on this, first!") and collapse spaces. */
export function normalizeWords(text: string) {
  return userWords(text).toLowerCase().replace(/[’‘`]/g, "'").replace(/[^a-z0-9'\s]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const STOP_LEAD = '(?:(?:ok|okay|hey|please|pls|just|wait|hold on|no|oh|um|uh|sorry|actually|and|so)\\s)*';
const STOP_CORE = "(?:stop(?:\\s(?:that|it|this|now|everything|all|all of that|all of it|working|right now|what you're doing|what you are doing|doing that))*|cancel(?:\\s(?:that|it|this|all|all of that|everything))*|abort(?:\\s(?:that|it|this|all|everything|mission))*|halt(?:\\s(?:that|it|this|now))*|never ?mind(?:\\s(?:that|it|all of that))*|forget (?:it|that|about it)|quit|kill (?:it|that))";
const STOP = new RegExp(`^${STOP_LEAD}${STOP_CORE}(?:\\s(?:${STOP_CORE}|please|pls|now|thanks|thank you))*$`);

const OVERRIDE = [
  /\b(?:work(?:ing)?\s+on|do|handle|take\s+care\s+of|fix|address|start|run|answer|look\s+at|focus\s+on)\s+(?:this|that|these|those|it)\s+first\b/,
  /\bfirst\s+(?:work\s+on|do|handle|fix|focus\s+on)\s+(?:this|that|these|those|it)\b/,
  /\b(?:prioriti[sz]e|prioriti[sz]ing)\s+(?:this|that|these|those|it)\b/,
  /\b(?:this|that|it)\s+(?:is|takes?)\s+(?:a\s+)?(?:priority|precedence)\b/,
  /\bactually\s+(?:do|work\s+on|handle|fix|run|try)\s+(?:this|that)\s+(?:first|instead)\b/,
  /\b(?:do|work\s+on|handle)\s+(?:this|that)\s+instead\b/,
  /^(?:actually\s+)?instead(?:\s+(?:do|work|handle|run|try|check|use|let's|please)\b|$)/,
  /\boverride\b/,
  /\bdrop\s+(?:everything|what\s+you(?:'re|\s+are)\s+doing)\b/,
  /\bbefore\s+(?:anything|everything)\s+else\b/,
];

export function classifyIntent(text: string): MessageIntent {
  const words = normalizeWords(text);
  if (!words) return 'additive';
  // A stop is a short message of its own; a long message that merely mentions "stop" is normal work.
  if (words.length <= 80 && STOP.test(words)) return 'stop';
  if (OVERRIDE.some(re => re.test(words))) return 'override';
  return 'additive';
}

/** A queued user message, as far as merging is concerned. */
export interface QueuedUser {
  text: string;
  attachments?: any[];
  generation?: number;
  queued?: boolean;
  [key: string]: any;
}

/**
 * Several messages that waited behind a running turn become one turn, in the order they were sent. The newest message's
 * model choice, voice and settings win; attachments are all kept. One message is returned unchanged.
 */
export function mergeQueuedUser<T extends QueuedUser>(items: T[]): T {
  if (items.length === 1) return items[0];
  const last = items[items.length - 1];
  const attachments = items.flatMap(i => i.attachments ?? []);
  const body = items.map((i, n) => `${n + 1}. ${i.text.trim()}`).join('\n');
  return {
    ...last,
    text: `[The user sent ${items.length} messages while you were busy. Handle all of them together in this one turn, in this order:]\n${body}`,
    ...(attachments.length ? { attachments } : {}),
    queued: true,
  };
}

/** Told to the bot in front of a message the user wants handled first. Nothing is interrupted: the other work keeps running. */
export const PRIORITY_NOTE = '[The user asked you to handle this FIRST. Your other work is NOT stopped; it keeps running in parallel. Answer this right away.]';
