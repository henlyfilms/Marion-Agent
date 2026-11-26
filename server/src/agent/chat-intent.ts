// What a message sent to a busy bot means: stop everything, do this first, or just add it to the work (the default).
// Pure functions, no I/O, so they are easy to test.

export type MessageIntent = 'stop' | 'override' | 'additive';

/** Drop the bracketed notes (reply quotes, media notes) the server puts in front of the user's own words. */
export function userWords(text: string) {
  let t = text.trim();
  while (/^\[[^\n]*\]\s*\n/.test(t)) t = t.replace(/^\[[^\n]*\]\s*\n/, '');
  return t.trim();
}

const STOP = /^(?:(?:ok(?:ay)?|hey|please|pls|just|wait|no|actually|and)[\s,.!:-]+)*(?:stop(?:\s+(?:that|it|this|now|everything|all|please|pls|working|right\s+now|what\s+you(?:'|’)re\s+doing))*|cancel(?:\s+(?:that|it|this|all|everything|please|pls|now))*|abort(?:\s+(?:that|it|this|all|everything|please|pls|now))*|halt(?:\s+(?:that|it|this|now|please|pls))*|never\s*mind(?:\s+that)?|nevermind(?:\s+that)?|forget\s+(?:it|that)|quit|kill\s+(?:it|that))(?:\s+(?:please|pls|now))?[\s.!]*$/i;

const OVERRIDE = [
  /\b(?:work(?:ing)?\s+on|do|handle|take\s+care\s+of|fix|address|start|run|answer|look\s+at|focus\s+on)\s+(?:this|that|these|those|it)\s+first\b/i,
  /\bfirst\s+(?:work\s+on|do|handle|fix|focus\s+on)\s+(?:this|that|these|those|it)\b/i,
  /\b(?:prioriti[sz]e|prioriti[sz]ing)\s+(?:this|that|these|those|it)\b/i,
  /\b(?:this|that|it)\s+(?:is|takes?)\s+(?:a\s+)?(?:priority|precedence)\b/i,
  /\bactually[,\s]+(?:do|work\s+on|handle|fix|run|try)\s+(?:this|that)\s+instead\b/i,
  /\b(?:do|work\s+on|handle)\s+(?:this|that)\s+instead\b/i,
  /\boverride\b/i,
  /\bdrop\s+(?:everything|what\s+you(?:'|’)re\s+doing)\b/i,
  /\bbefore\s+(?:anything|everything)\s+else\b/i,
];

export function classifyIntent(text: string): MessageIntent {
  const words = userWords(text).replace(/\s+/g, ' ');
  if (!words) return 'additive';
  // A stop is a short message of its own; a long message that merely mentions "stop" is normal work.
  if (words.length <= 60 && STOP.test(words)) return 'stop';
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

/** Told to the bot in front of a message the user wants handled first. */
export const OVERRIDE_NOTE = '[The user asked you to work on this FIRST, so your earlier work was interrupted. Do this now. Anything they sent before it is still queued and arrives right after; your chat history shows what you were doing, so pick that up again afterwards if it still makes sense.]';
