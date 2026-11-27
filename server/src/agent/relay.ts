import { isVideoMime, latestUserAttachments, type UploadedAttachment } from '../attachments.js';
import { getBotRow } from '../store.js';
import { lookableMedia } from '../video-frames.js';
import { tokenOptimizerFor } from './skills.js';

/**
 * Shared plumbing for everything Marion relays to Claude, Codex or Gemini (ask_subscription, orchestrate,
 * subscription-backed bots): the user's screenshots and screen recordings, lean prompts, and when to
 * start a fresh session instead of carrying old context along.
 */

// ---------- screenshots and screen recordings ----------

/**
 * The screenshots (and frames of screen recordings) on the message being handled, for a relayed agent.
 * A relay only sees what the chat model writes in `prompt`, so without this the pictures never arrive.
 * Pass the turn's `triggerAttachments` when known: the newest stored message may be a later one than the turn's own.
 */
export async function relayMedia(botId: string, triggerAttachments?: UploadedAttachment[]): Promise<{ images: UploadedAttachment[]; note: string }> {
  const bot = getBotRow(botId);
  if (!bot) return { images: [], note: '' };
  const source = triggerAttachments ?? latestUserAttachments(botId, bot.generation);
  const files = source.filter(file => file.mime.startsWith('image/') || isVideoMime(file.mime));
  return files.length ? lookableMedia(files) : { images: [], note: '' };
}

// ---------- token optimizer ----------

const TOOL_LEAN = 'Search before reading, never re-read a file you just edited, trim command output (head/tail/grep), and end with a brief result, not a recap.';

/** One line from the owner's own "Token optimizer" universal skill (their edit wins; deleted = nothing), plus tool habits when the agent works in a folder. */
export function leanLine(botId: string, tools: boolean): string {
  const rule = tokenOptimizerFor(botId).replace(/\s+/g, ' ').trim().slice(0, 600);
  if (!rule) return '';
  return `Token optimizer: ${rule}${tools && !/re-?read/i.test(rule) ? ` ${TOOL_LEAN}` : ''}`;
}

// ---------- fresh sessions ----------

export const SESSION_LIMITS = {
  /** Requests handled in one relay session before the next one starts fresh. */
  maxTurns: 8,
  /** Estimated tokens a relay session may have used (prompts + replies) before the next one starts fresh. */
  maxTokens: 30_000,
  /** A session idle this long is over. */
  idleMs: 30 * 60_000,
  /** Earlier requests carried into a follow-up. */
  carry: 2,
};

const STOP = new Set(('this that with from have will would could should about into your then than them they there their what when where which while also just like make sure need want please using used does done been being more most some such only over after before again here very much many each other those these because without within between through under until upon onto across around the and for are not but you all can her was one our out has had how its let now new say see she too use who way any').split(' '));
const stem = (word: string) => word.length > 5 ? word.replace(/(?:ing|ed|es|s)$/, '') : word.replace(/s$/, '');

/** The distinctive words of a request, for judging whether a new request is about something else. */
export function topicWords(text: string): string[] {
  return [...new Set(text.toLowerCase().replace(/https?:\/\/\S+/g, ' ').split(/[^a-z0-9_.-]+/).filter(word => word.length > 3 && !STOP.has(word)).map(stem))];
}

const NEW_TOPIC = /\b(new (task|topic|session|project|chat)|different (task|topic|project|thing)|unrelated|something else|start (over|fresh|from scratch|a new)|forget (that|this|the previous|everything))\b/i;
const FOLLOW_UP = /^\W*(also|and|then|now|next|continue|keep going|same|ok(ay)?|yes|yep|no|thanks|thank you|retry|try again|again|fix|go on|do it)\b|\b(that|those|them|previous|above|earlier|last time|same (file|thing|bug|task))\b/i;

/** True when `prompt` is clearly about something else than `topic` (words of the session so far). Short or follow-up requests never count. */
export function isNewTopic(topic: string[], prompt: string): boolean {
  if (NEW_TOPIC.test(prompt)) return true;
  if (FOLLOW_UP.test(prompt.slice(0, 160))) return false;
  const words = topicWords(prompt);
  if (words.length < 4 || topic.length < 4) return false;
  const known = new Set(topic);
  return words.filter(word => known.has(word)).length / words.length < 0.1;
}

export interface RelaySession {
  startedAt: number;
  lastAt: number;
  turns: number;
  tokens: number;
  folder: string;
  topic: string[];
  exchanges: { ask: string; answer: string }[];
}

const sessions = new Map<string, RelaySession>();
const keyOf = (botId: string, generation: number, provider: string) => `${botId}:${generation}:${provider}`;
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export interface RelayPlan {
  session: RelaySession;
  /** Why the previous session was dropped (shown on the card), or null if this continues one. */
  rotated: string | null;
  /** Earlier requests and results to prepend when continuing; empty for a fresh session. */
  carried: string;
}

/**
 * Decide whether this request continues the relay session for this chat and provider, or starts a new one:
 * explicit `newSession`, another folder, too many turns or too many tokens, a long idle gap, or a clear topic change.
 */
export function planRelaySession(input: { botId: string; generation: number; provider: string; prompt: string; folder?: string; newSession?: boolean; at?: number }): RelayPlan {
  const at = input.at ?? Date.now();
  const key = keyOf(input.botId, input.generation, input.provider);
  const folder = input.folder ?? '';
  const previous = sessions.get(key);
  let rotated: string | null = null;
  if (previous) {
    if (input.newSession) rotated = 'you asked for a new session';
    else if (previous.folder !== folder) rotated = 'the folder changed';
    else if (previous.turns >= SESSION_LIMITS.maxTurns) rotated = `the last session had ${previous.turns} requests`;
    else if (previous.tokens >= SESSION_LIMITS.maxTokens) rotated = `the last session was using about ${Math.round(previous.tokens / 1000)}k tokens`;
    else if (at - previous.lastAt > SESSION_LIMITS.idleMs) rotated = 'the last session was idle';
    else if (isNewTopic(previous.topic, input.prompt)) rotated = 'this is a different topic';
  }
  const session: RelaySession = !previous || rotated
    ? { startedAt: at, lastAt: at, turns: 0, tokens: 0, folder, topic: [], exchanges: [] }
    : previous;
  sessions.set(key, session);
  if (sessions.size > 200) sessions.delete(sessions.keys().next().value!);
  const recent = session.exchanges.slice(-SESSION_LIMITS.carry);
  const carried = recent.length
    ? `Earlier in this session (context only; do not redo it):\n${recent.map(item => `Request: ${item.ask}\nResult: ${item.answer}`).join('\n\n')}`
    : '';
  return { session, rotated, carried };
}

/** Remember a finished request so a follow-up can build on it and the session's size is known. */
export function recordRelayTurn(session: RelaySession, prompt: string, answer: string, usedTokens?: number, at = Date.now()) {
  session.turns += 1;
  session.lastAt = at;
  session.tokens += usedTokens ?? Math.ceil((prompt.length + answer.length) / 4);
  session.topic = [...new Set([...session.topic, ...topicWords(prompt)])].slice(-80);
  session.exchanges.push({ ask: cut(prompt.replace(/\s+/g, ' ').trim(), 300), answer: cut(answer.replace(/\s+/g, ' ').trim(), 900) });
  if (session.exchanges.length > SESSION_LIMITS.carry) session.exchanges.splice(0, session.exchanges.length - SESSION_LIMITS.carry);
}

export const forgetRelaySessions = () => sessions.clear();

// ---------- subscription-backed bots ----------

const HISTORY_CHARS = 48_000;
const HISTORY_TURNS = 10;

const textOf = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((part: any) => part?.text ?? '').filter(Boolean).join(' ') : '';

/** A subscription CLI replays a history window on each call, including tool steps. */
export function freshStart(history: any[], provider: string): { history: any[]; reason: string | null; checkpoint?: { item: any; carryReply: boolean } } {
  const isSummary = (item: any) => item?.role === 'user' && textOf(item.content).startsWith('[Automatic summary');
  const isRequest = (item: any) => item?.role === 'user' && item.type !== 'function_call_output' && !isSummary(item);
  const start = history.findLastIndex(isRequest);
  if (start < 0) return { history, reason: null };

  // A rotation marks the first request of the new session in model history, not in the visible chat.
  // Anything before that request is reference material and must not count toward the next rotation.
  const boundary = history.findLastIndex(item => isRequest(item) && typeof item.marionSubscriptionStarts?.[provider] === 'boolean');
  const summary = isSummary(history[0]) ? [history[0]] : [];
  const prior = history.slice(Math.max(boundary, summary.length), start);
  const userTurns = prior.filter(isRequest);
  const chars = prior.reduce((sum, item) => sum + (item?.type === 'function_call' ? String(item.arguments ?? '').length : textOf(item?.content ?? item?.output).length), 0);
  const topic = userTurns.slice(-3).flatMap(item => topicWords(textOf(item.content)));
  let reason: string | null = null;
  if (chars > HISTORY_CHARS) reason = 'the conversation had grown large';
  else if (userTurns.length >= HISTORY_TURNS) reason = `the conversation had ${userTurns.length} earlier requests`;
  else if (userTurns.length && isNewTopic(topic, textOf(history[start].content))) reason = 'this is a different topic';
  if (!reason && boundary < 0) return { history, reason: null };

  const from = reason ? start : boundary;
  const carryReply = reason ? reason !== 'this is a different topic' : history[from].marionSubscriptionStarts[provider];
  const lastReply = carryReply ? history.slice(0, from).findLast(item => item?.role === 'assistant') : undefined;
  const reply = lastReply ? [{ role: 'user', content: `[Your previous reply, for reference]\n${cut(textOf(lastReply.content), 800)}` }] : [];
  return { history: [...summary, ...reply, ...history.slice(from)], reason, ...(reason ? { checkpoint: { item: history[from], carryReply } } : {}) };
}
