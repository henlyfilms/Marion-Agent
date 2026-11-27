import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { cliEnvironment, executable, parseLine, requireClaudeSubscription } from '../agent/subscriptions.js';
import { checkUsageLimit, isUsageLimitError } from '../agent/usage-limit.js';
import { appendRow, getBotRow } from '../store.js';
import { runExternalSession } from '../agent/loop.js';
import { beginAgentSession, finishAgentSession, linkCloudSession } from './agent-sessions.js';
import { offerHandoff, reportHandoffError } from './handoffs.js';
import type { SessionTrack } from './life-outbox.js';
import type { CloudRepo } from './cloud-repo.js';
import { miniTitle, WorkCard } from '../agent/work-feed.js';

export const cloudArgs = [
  '--cloud', '--input-format', 'stream-json', '--output-format', 'stream-json',
  '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--no-chrome',
];

export function cloudSessionUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /https:\/\/claude\.ai\/code\/(?:session|cse)_[a-z0-9_-]+/i.exec(value);
  return match?.[0] ?? null;
}

type CloudFrame = {
  type?: string; subtype?: string; is_error?: boolean; result?: string; errors?: unknown;
  cloud_session?: { id?: string; view_url?: string };
  request_id?: string; request?: { subtype?: string };
  session_id?: string; session_url?: string; view_url?: string; content?: unknown;
  response?: { request_id?: string; error?: string; response?: { session_id?: string; session_url?: string; view_url?: string } };
  message?: { content?: { type?: string; text?: string; name?: string }[] };
};

/** A permission the Cloud session asks for mid-run; answered from an in-app card in the chat (true = allow). */
export type CloudPermission = (request: { tool: string; input: unknown; detail: string }) => Promise<boolean>;

export async function relayCloud(program: string, folder: string, goal: string, signal: AbortSignal,
  onUrl: (url: string) => void, onProgress: (line: string) => void, onPermission?: CloudPermission) {
  const env = { ...cliEnvironment(), GIT_OPTIONAL_LOCKS: '0' };
  const child = spawn(program, cloudArgs, { cwd: folder, env, signal, stdio: ['pipe', 'pipe', 'pipe'] });
  let diagnostic = '';
  let lastUrl: string | undefined;
  const link = (value: unknown) => {
    const url = cloudSessionUrl(value);
    if (url && !lastUrl) { lastUrl = url; onUrl(url); }
  };
  let processError = '';
  child.on('error', error => { processError = error.message; });
  child.stderr.setEncoding('utf8').on('data', chunk => {
    diagnostic = (diagnostic + chunk).slice(-8000);
    // Give URLs split across stderr chunks time to arrive; ignore unrelated links.
    for (const line of diagnostic.split('\n').slice(0, -1)) if (/cloud session|^view:/i.test(line)) link(line);
  });
  child.stdin.on('error', () => {});
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const initialize = randomUUID();
  const send = (frame: unknown) => child.stdin.write(JSON.stringify(frame) + '\n');
  send({ type: 'control_request', request_id: initialize, request: { subtype: 'initialize' } });
  send({ type: 'user', uuid: randomUUID(), message: { role: 'user', content: [{ type: 'text', text: goal }] }, parent_tool_use_id: null, session_id: '' });
  try {
    for await (const line of lines) {
      const frame = parseLine<CloudFrame>(line);
      if (!frame) continue;
      // Only metadata supplied by the CLI can become a clickable Cloud URL.
      link(frame.cloud_session?.view_url ?? frame.session_url ?? frame.view_url ?? frame.response?.response?.session_url ?? frame.response?.response?.view_url);
      const id = frame.cloud_session?.id ?? frame.session_id ?? frame.response?.response?.session_id;
      if (/^(?:session|cse)_[a-z\d_-]+$/i.test(id ?? '')) link('https://claude.ai/code/' + id);
      if (frame.type === 'control_request' && frame.request_id) {
        const request = frame.request as { subtype?: string; tool_name?: string; input?: unknown } | undefined;
        if (request?.subtype === 'can_use_tool' && onPermission) {
          // The Cloud session wants a tool in its own cloud sandbox: ask the owner in the Marion chat, not in another app.
          const input = request.input ?? {};
          const allowed = await onPermission({ tool: String(request.tool_name ?? 'a tool'), input, detail: JSON.stringify(input).slice(0, 1500) }).catch(() => false);
          send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id,
            response: allowed ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'The owner declined this in Marion Agent.' } } });
          continue;
        }
        send({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id,
          error: 'This Cloud session runs on GitHub, not on this Mac: Marion does not hand it local access.' } });
        continue;
      }
      if (frame.type === 'control_response' && frame.response?.error) {
        checkUsageLimit(frame.response.error);
        if (frame.response.request_id === initialize) throw new Error(frame.response.error);
      }
      if (frame.type === 'system') {
        if (typeof frame.content === 'string' && /cloud session/i.test(frame.content)) link(frame.content);
        if (frame.subtype === 'error') checkUsageLimit(frame, frame.content);
      }
      if (frame.type === 'assistant') for (const block of frame.message?.content ?? []) {
        if (block.type === 'text' && block.text) onProgress(block.text);
        if (block.type === 'tool_use' && block.name) onProgress('Used ' + block.name);
      }
      if (frame.type !== 'result') continue;
      if (frame.is_error || frame.subtype !== 'success') {
        checkUsageLimit(frame, frame.result, diagnostic);
        const reason = frame.result || (Array.isArray(frame.errors) ? frame.errors.join('; ') : '') || diagnostic.trim() || frame.subtype || 'Unknown error';
        throw new Error(reason.slice(0, 800));
      }
      if (/^(?:you.ve hit|you have reached|usage limit|rate limit|credit balance)/i.test(frame.result ?? '')) checkUsageLimit(frame.result);
      if (!lastUrl) throw new Error('Claude returned a result but did not identify a Cloud session. Check the CLI version.');
      return frame.result ?? '';
    }
    await closed;
    if (signal.aborted) throw signal.reason;
    // This CLI/account only starts Cloud sessions from a terminal: the caller retries through Marion's pseudo-terminal.
    if (!lastUrl && HEADLESS_REFUSED.test(diagnostic)) throw new HeadlessUnsupported(diagnostic.trim().slice(-400));
    checkUsageLimit(diagnostic);
    throw new Error(processError || diagnostic.trim().slice(-800) || 'Claude Cloud disconnected before returning a result.');
  } finally {
    lines.close();
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}


/** What the CLI prints when its stream-json Cloud mode is off for the account (a server-side gate) or not in this build. */
const HEADLESS_REFUSED = /requires an interactive terminal|interactive only|cannot be combined with --print|not available|not supported/i;

/** The headless (stream-json) Cloud mode is not available here; Marion falls back to running the CLI in a pseudo-terminal. */
export class HeadlessUnsupported extends Error {
  constructor(readonly diagnostic: string) { super('Headless Cloud sessions are not enabled for this Claude account: ' + diagnostic); }
}

/** Arguments for the terminal launch: `claude --cloud "<task>"` creates the Cloud session from the task (no stream-json). */
export const cloudTerminalArgs = (goal: string) => ['--cloud', goal, '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--no-chrome'];

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Runs `program args` attached to a pseudo-terminal (the CLI refuses `--cloud` without one), with a channel Marion can
 * type into (trust prompt, approvals). script(1) reads the terminal settings of its stdin and only carries on when that
 * fails with ENOTTY. Node's stdio pipes are socketpairs and macOS FIFOs are sockets too (EOPNOTSUPP: "tcgetattr/ioctl:
 * Operation not supported on socket"), so Node's stdin is copied by a background `cat` into a real pipe(2) instead.
 * When the CLI ends, that `cat` is stopped and the shell exits with script's status. macOS: BSD script(1); Linux:
 * util-linux script(1). stty gives the terminal a wide, fixed size so URLs never wrap.
 */
export function ptyCommand(program: string, args: string[]): [string, string[]] {
  const inner = 'stty cols 200 rows 50 2>/dev/null; exec "$@"';
  const run = process.platform === 'darwin'
    ? `/usr/bin/script -q /dev/null /bin/sh -c ${shellQuote(inner)} marion-pty "$@"`
    : `script -qfec ${shellQuote(['/bin/sh', '-c', inner, 'marion-pty', program, ...args].map(shellQuote).join(' '))} /dev/null`;
  const script = [
    'p="${TMPDIR:-/tmp}/marion-pty-$$"', 'rm -f "$p"', 'exec 3<&0',
    '{ cat <&3 & echo $! >"$p"; wait; } 2>/dev/null | {',
    `  ${run} 3<&-`, '  s=$?',
    '  i=0; while [ ! -s "$p" ] && [ $i -lt 20 ]; do sleep 0.1; i=$((i+1)); done',
    '  kill "$(cat "$p" 2>/dev/null)" 2>/dev/null; rm -f "$p"; exit $s', '}',
  ].join('\n');
  return ['/bin/sh', ['-c', script, 'marion-cloud', program, ...args]];
}

/** Tests swap the terminal wrapper (a sandbox may forbid opening a pseudo-terminal). */
let terminal: (program: string, args: string[]) => [string, string[]] = ptyCommand;
export function setCloudTerminal(wrap?: (program: string, args: string[]) => [string, string[]]) { terminal = wrap ?? ptyCommand; }

/**
 * Terminal output as plain text: escape sequences removed, cursor jumps turned into line breaks. Claude Code's renderer
 * often skips blanks with cursor moves instead of printing spaces (`ESC[nC` forward, `ESC[nG` to a column), so those
 * become spaces: otherwise words run together ("Yes,Itrustthisfolder"). `ESC[nX` erases cells without moving the cursor,
 * so it adds nothing. `gaps: false` reads tokens instead (session URLs and IDs): a column jump adds nothing either, so a
 * redraw that lands mid-token (`session_ab` `ESC[30G` `cd`, `ESC[2C`, `ESC[1G`) cannot split it. Prompt matching is
 * whitespace-tolerant. An escape sequence cut off at the end (the rest is still on its way, e.g. `ESC[3` before `0G`) is
 * dropped: left alone, its tail (`[3`) would read as text and end a token early.
 */
export function cleanTerminal(raw: string, { gaps = true }: { gaps?: boolean } = {}) {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*\x1b?|[()])?$/, '')
    .replace(/\x1b\[(\d*)C/g, (_, n) => gaps ? ' '.repeat(Math.min(Number(n || 1), 200)) : '')
    // Column 1 starts the line over (when reading the screen); any other column is a jump within it.
    .replace(/\x1b\[(\d*)G/g, (_, n) => !gaps ? '' : Number(n || 1) <= 1 ? '\n' : ' ')
    .replace(/\x1b\[\d*X/g, '')
    // Absolute positioning (row;col): another place on screen, never the same word.
    .replace(/\x1b\[[0-?]*[ -/]*[ABEFHJKf]/g, '\n')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMNOc]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

/**
 * The Cloud session a terminal launch created: its claude.ai/code URL, or the printed session ID. `complete`: only once
 * something follows it, so a URL cut off at the end of the output so far is not taken (the rest may be on its way).
 */
export function terminalCloudUrl(text: string, { complete = false }: { complete?: boolean } = {}) {
  const end = complete ? '(?=[^a-z0-9_-])' : '';
  const url = new RegExp('https://claude\\.ai/code/(?:session|cse)_[a-z0-9_-]+' + end, 'i').exec(text)?.[0];
  if (url) return cloudSessionUrl(url);
  const id = new RegExp('Session ID:\\s*((?:session|cse)_[a-z0-9_-]+)' + end, 'i').exec(text)?.[1];
  return id ? cloudSessionUrl('https://claude.ai/code/' + id) : null;
}

/** Folder-trust prompt, whitespace-tolerant (the terminal renderer may drop or move the spaces: "Yes,Itrustthisfolder"). */
const TRUST_PROMPT = /trust\s*this\s*folder|trust\s*the\s*files\s*in\s*this\s*folder|Do\s*you\s*trust|read,\s*edit,\s*and\s*execute\s*files\s*here/i;
const squash = (text: string) => text.toLowerCase().replace(/\s+/g, '');
export const isTrustPrompt = (text: string) => TRUST_PROMPT.test(text);

const DOWN = '\x1b[B', UP = '\x1b[A';
/** Where the latest render of the folder-trust prompt starts (its header); options after it belong to that render. */
const TRUST_HEADER = /doyoutrust|read,edit,andexecute/g;
const TRUST_POINTER = /[❯›]|>(?=(?:\d+\.)?[a-z])/g;
/** The trust prompt's own questions (squashed); any other "?" after its header belongs to a different prompt. */
const TRUST_QUESTION = /(?:doyoutrust|oneyoutrust)[^?]{0,80}\?/g;

export interface TrustState { number: string | null; key: '\r' | typeof DOWN | typeof UP | null }
export interface TrustReadOptions {
  /** The text is known to be the trust prompt (read right after an arrow key, which cannot answer it): a bare
   *  "Yes, proceed" counts without the header in view. Otherwise "Yes, proceed" (also the label of other prompts) only
   *  counts under the trust header. */
  known?: boolean;
  /** A whole screen (not just the output since a key): more than one ❯ in the trust render is ambiguous, nothing is pressed. */
  screen?: boolean;
}

/**
 * Reads the latest render of the trust prompt: `number` = the digit of "Yes, I trust this folder" when the options are
 * numbered; `key` = Enter when ❯ is on the Yes option, one arrow step toward it when ❯ is on another option (any number of
 * options), null when no pointer is drawn yet. null overall = no Yes option of the trust prompt in the latest render,
 * including when another question follows it (the next prompt, e.g. "Do you want to proceed? ❯ 1. Yes, proceed").
 */
export function trustSelection(text: string, { known = false, screen = false }: TrustReadOptions = {}): TrustState | null {
  let flat = squash(text);
  const headers = [...flat.matchAll(TRUST_HEADER)];
  if (headers.length) flat = flat.slice(headers.at(-1)!.index);
  if (flat.replace(TRUST_QUESTION, '').includes('?')) return null;
  const proceed = headers.length || known ? flat.lastIndexOf('yes,proceed') : -1;
  const yesAt = Math.max(flat.lastIndexOf('yes,itrustthisfolder'), proceed);
  if (yesAt < 0) return null;
  // Any number of options: "❯10.Yes" is option 10 (a single-digit match would miss it and step away from Yes).
  const number = /(?:^|\D)(\d{1,3})\.$/.exec(flat.slice(Math.max(0, yesAt - 12), yesAt))?.[1] ?? null;
  const pointers = [...flat.matchAll(TRUST_POINTER)];
  const pointerAt = pointers.at(-1)?.index;
  if (pointerAt === undefined || screen && pointers.length > 1) return { number, key: null };
  if (pointerAt < yesAt && /^(?:\d+\.)?$/.test(flat.slice(pointerAt + 1, yesAt))) return { number, key: '\r' };
  return { number, key: pointerAt < yesAt ? DOWN : UP };
}

/**
 * The visible screen a terminal shows after `raw` (rows × cols, unset cells blank): cursor moves, erases and overwrites
 * applied, so a redraw of only the changed cells (just ❯ moved) still reads as the whole prompt.
 */
export function terminalScreen(raw: string, { rows = 50, cols = 200 }: { rows?: number; cols?: number } = {}) {
  let lines: string[][] = [[]];
  let top = 0, r = 0, c = 0, saved = [0, 0];
  const row = () => { while (lines.length <= r) lines.push([]); return lines[r]; };
  const down = () => { r++; if (r - top >= rows) top = r - rows + 1; row(); };
  const clear = (from: number, to: number) => { const line = row(); for (let i = from; i < Math.min(to, line.length); i++) line[i] = ' '; };
  const clearScreen = () => { for (let i = top; i < lines.length; i++) lines[i] = []; };
  const pattern = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[([0-?]*)[ -/]*([@-~])|\x1b[()][0-9A-Za-z]|\x1b([78DEMc=>])|([\s\S])/gu;
  for (const m of raw.matchAll(pattern)) {
    const [, params, final, esc, ch] = m;
    if (final) {
      const nums = params.replace(/^[?>=]/, '').split(';').map(n => Number(n) || 0);
      const n = Math.max(1, nums[0] || 1);
      switch (final) {
        case 'A': r = Math.max(top, r - n); break;
        case 'B': r = Math.min(top + rows - 1, r + n); break;
        case 'C': c = Math.min(cols - 1, c + n); break;
        case 'D': c = Math.max(0, c - n); break;
        case 'E': r = Math.min(top + rows - 1, r + n); c = 0; break;
        case 'F': r = Math.max(top, r - n); c = 0; break;
        case 'G': case '`': c = Math.min(cols - 1, n - 1); break;
        case 'd': r = top + Math.min(rows - 1, n - 1); break;
        case 'H': case 'f': r = top + Math.min(rows - 1, Math.max(1, nums[0] || 1) - 1); c = Math.min(cols - 1, Math.max(1, nums[1] || 1) - 1); break;
        case 'J':
          if (nums[0] === 0) { clear(c, cols); for (let i = r + 1; i < lines.length; i++) lines[i] = []; }
          else if (nums[0] === 1) { for (let i = top; i < r; i++) lines[i] = []; clear(0, c + 1); }
          else clearScreen();
          break;
        case 'K': if (nums[0] === 0) clear(c, cols); else if (nums[0] === 1) clear(0, c + 1); else lines[r] = []; break;
        case 'X': clear(c, c + n); break;
        case 'P': row().splice(c, n); break;
        case '@': { const line = row(); while (line.length < c) line.push(' '); line.splice(c, 0, ...' '.repeat(n)); break; }
        case 's': saved = [r, c]; break;
        case 'u': [r, c] = saved; row(); break;
        case 'h': case 'l': if (/^\?(?:1049|1047|47)$/.test(params)) { clearScreen(); r = top; c = 0; } break;
      }
      continue;
    }
    if (esc) {
      if (esc === '7') saved = [r, c];
      else if (esc === '8') { [r, c] = saved; row(); }
      else if (esc === 'D') down();
      else if (esc === 'E') { down(); c = 0; }
      else if (esc === 'M') r = Math.max(top, r - 1);
      else if (esc === 'c') { lines = [[]]; top = r = c = 0; }
      continue;
    }
    if (ch === undefined) continue;
    if (ch === '\r') c = 0;
    else if (ch === '\n') down();
    else if (ch === '\b') c = Math.max(0, c - 1);
    else if (ch === '\t') c = Math.min(cols - 1, (Math.floor(c / 8) + 1) * 8);
    else if (ch >= ' ' && ch !== '\x7f') {
      if (c >= cols) { down(); c = 0; }
      const line = row();
      while (line.length < c) line.push(' ');
      line[c++] = ch;
    }
  }
  return lines.slice(top, top + rows).map(line => line.join('').trimEnd()).join('\n').replace(/\n+$/, '');
}

/** The terminal as the folder-trust selection sees it. */
export interface TrustTerminal {
  /** Cleaned terminal text written since the last key was typed (before the first key: the current screen). */
  read: () => string;
  /** The whole visible screen, partial redraws applied (see terminalScreen): read when the output since a key redrew
   *  only part of the prompt (e.g. just ❯). Without it such a redraw cannot be read, and Enter is never pressed on it. */
  screen?: () => string;
  type: (key: string) => void;
  wait: (ms: number) => Promise<void>;
  /** The launch already ended: stop without pressing anything. */
  ended?: () => boolean;
}
export interface TrustSelectOptions {
  /** Gap before each key (Ink reads one key per input event) and between re-reads. */
  pollMs?: number;
  /** How long a key may go without a redraw before it counts as dropped and the step is tried again. */
  redrawMs?: number;
  /** After a number key: how long to watch for the prompt to redraw with ❯ on Yes and stay there (then it also needs
   *  Enter). The whole window is watched, so a next screen drawn right after a last (stale) render of the prompt shows. */
  numberMs?: number;
  /** ❯ on Yes must still be the latest render after this quiet spell before Enter (a late redraw would show otherwise). */
  settleMs?: number;
  /** Arrow keys in total, and the whole selection's time limit. */
  maxSteps?: number;
  timeoutMs?: number;
}
export type TrustSelectResult = { ok: true; keys: string[] } | { ok: false; reason: string; keys: string[] };

/**
 * Selects "Yes, I trust this folder" and confirms it: presses its number when the options are numbered, otherwise moves ❯
 * one arrow at a time, re-reading the terminal after every key, and presses Enter only once the latest render shows ❯ on
 * the Yes option of the folder-trust prompt. A dropped arrow (no redraw) is stepped again, an overshoot steps back; a
 * redraw of only the changed cells is read from the whole screen (never counted as dropped); when ❯ never reaches Yes
 * within the bounds it fails without pressing Enter (never a blind Enter, which could land on "No, exit"). After a number
 * key the prompt may already be answered: a different prompt that follows (even one offering "Yes, proceed") is never
 * confirmed here, it is left to the owner's own card.
 */
export async function selectTrustOption(term: TrustTerminal, options: TrustSelectOptions = {}): Promise<TrustSelectResult> {
  const { pollMs = 150, redrawMs = 1500, numberMs = 1200, settleMs = 250, maxSteps = 8, timeoutMs = 10_000 } = options;
  const keys: string[] = [];
  const fail = (reason: string): TrustSelectResult => ({ ok: false, reason, keys });
  const ended = () => term.ended?.() ?? false;
  const press = async (key: string) => { await term.wait(pollMs); if (ended()) return false; term.type(key); keys.push(key); return true; };
  const deadline = Date.now() + timeoutMs;
  /** The last key was an arrow: the CLI cannot have left the trust prompt since (arrows never answer it). */
  let afterArrow = false;
  /** Output arrived since the last key, but ❯ on the trust prompt could not be read from it. */
  let unreadable = false;
  const look = (): TrustState | null => {
    const since = term.read();
    let state = trustSelection(since, { known: afterArrow });
    // Only part of the prompt was redrawn (e.g. just ❯): read the whole screen. Not after a number key, which may have
    // answered the prompt already (its last render could still be on screen above the next one).
    if (since.trim() && !state?.key && afterArrow && term.screen) state = trustSelection(term.screen(), { known: true, screen: true }) ?? state;
    unreadable = !!since.trim() && !state?.key;
    return state;
  };
  let state = look();
  // Single digits only: "10" could be read as "1" then "0" (option 1 could be "No, exit"); ❯ is moved with arrows instead.
  if (state?.number && /^\d$/.test(state.number)) {
    if (!await press(state.number)) return fail('The launch ended.');
    // A number picks the option and usually answers the prompt; one last (stale) render of the prompt with ❯ on Yes can
    // still arrive just before the next screen, and an Enter then would land on that screen. Should this CLI only move ❯
    // to Yes, the prompt redraws and waits for Enter. So Enter only when all of this holds: the prompt redrew with ❯ on
    // Yes after the number, the whole numberMs window passed, no output arrived for settleMs since, and the visible
    // screen (the next screen erases the prompt) still shows ❯ on Yes of the trust prompt. Never arrows after a number.
    const until = Date.now() + numberMs;
    let seen = term.read(), quietAt = Date.now();
    while (Date.now() < deadline && (Date.now() < until || Date.now() - quietAt < settleMs)) {
      await term.wait(pollMs);
      if (ended()) return { ok: true, keys };
      const now = term.read();
      if (now !== seen) { seen = now; quietAt = Date.now(); }
    }
    const waiting = Date.now() - quietAt >= settleMs && trustSelection(seen)?.key === '\r'
      && !!term.screen && trustSelection(term.screen(), { screen: true })?.key === '\r';
    if (!waiting) return { ok: true, keys };
    return await press('\r') ? { ok: true, keys } : fail('The launch ended.');
  }
  let lastMove: string | null = null;
  let keyAt = Date.now();
  while (Date.now() < deadline) {
    if (ended()) return fail('The launch ended.');
    if (state?.key === '\r') {
      // Wait for the screen to settle, then confirm ❯ is still on Yes in the newest render before Enter.
      await term.wait(settleMs);
      if (ended()) return fail('The launch ended.');
      const settled = look();
      if (settled?.key !== '\r') { state = settled; continue; }
      return await press('\r') ? { ok: true, keys } : fail('The launch ended.');
    }
    // A key with no redraw at all counts as dropped; one that redrew something unreadable is not stepped again.
    const move: string | null = state?.key ?? (!unreadable && Date.now() - keyAt >= redrawMs ? lastMove : null);
    if (move) {
      if (keys.filter(key => key === DOWN || key === UP).length >= maxSteps) break;
      if (!await press(move)) return fail('The launch ended.');
      lastMove = move; keyAt = Date.now(); state = null; afterArrow = true; unreadable = false;
      continue;
    }
    await term.wait(pollMs);
    state = look();
  }
  return fail(unreadable ? 'the prompt redrew only in part, so ❯ on "Yes, I trust this folder" could not be confirmed'
    : '❯ never reached "Yes, I trust this folder"');
}

const SIGN_IN_PROMPT = /Select login method|Please run \/login|not logged in|Invalid API key|OAuth token has expired/i;
/** The error a launch fails with when the owner answers Cancel on the folder-trust card. */
export const FOLDER_TRUST_DECLINED = 'Owner declined folder trust';
/** The error a launch fails with when its folder-trust question can no longer be answered (the conversation reset). */
export const FOLDER_TRUST_ABORTED = 'The conversation changed before the folder-trust question was answered, so the Cloud launch stopped.';
/** The owner's answer to the folder-trust question; 'aborted' = nobody can answer it any more (not a decline). */
export type TrustAnswer = 'approved' | 'declined' | 'aborted';
const trustAnswer = (answer: TrustAnswer | boolean): TrustAnswer => answer === true ? 'approved' : answer === false ? 'declined' : answer;

/** The trust question as the owner sees it: from its first line on, or the latest output when that line is not in view. */
export function trustDetail(recent: string) {
  // The latest render: its question line, or its "read, edit" line when the question is not part of that render.
  const marks = [...recent.matchAll(/(do\s*you\s*trust|trust\s*the\s*files)|read,\s*edit/gi)];
  const last = marks.at(-1), before = marks.at(-2);
  const at = !last ? -1 : !last[1] && before?.[1] ? before.index! : last.index!;
  return (at >= 0 ? recent.slice(at) : recent.slice(-1500)).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim().slice(0, 1500);
}
/** Which question the CLI's latest screen waits on, in plain words (null = none Marion recognises). */
export function waitingPrompt(screen: string): string | null {
  if (isTrustPrompt(screen)) return 'its folder-trust question ("Do you trust the files in this folder?")';
  if (SIGN_IN_PROMPT.test(screen)) return 'a Claude sign-in';
  if (CHOICE_PROMPT.test(screen)) return 'a question for the owner';
  return null;
}
/** A question the CLI waits on (a numbered choice under a "Do you want…?" line): the owner answers it on an in-app card. */
const CHOICE_PROMPT = /(?:Do\s*you\s*want|Would\s*you\s*like|Allow|Approve|Continue|Proceed)[^\n]{0,160}\?[\s\S]{0,400}?(?:❯|›|>)\s*1\.\s*\S/i;
const NOISE = /^[\s─━│┃╭╮╰╯┌┐└┘├┤┬┴┼═║╔╗╚╝▐▛▜▌▝▘█▔▁·•✻✶✳✢✽*+\-=_>❯›?]*$|esc to interrupt|for shortcuts|^\s*(?:[✻✶✳✢✽·*]\s*)?\w+…\s*\(/i;

export interface CloudTerminalHooks {
  onUrl: (url: string) => void;
  onProgress: (line: string) => void;
  /** The CLI waits on a question: show it to the owner (true = confirm, false = decline). */
  onPrompt?: (text: string) => Promise<boolean>;
  /** Claude Code asks whether to trust the launch folder: the owner decides (true = 'approved', false = 'declined'). */
  onTrust?: (detail: string) => Promise<TrustAnswer | boolean>;
}
export interface CloudTerminalOptions { startupMs?: number; idleMs?: number; maxMs?: number; trust?: TrustSelectOptions }

/**
 * Starts the Cloud session through a pseudo-terminal. Resolves once the CLI is done with it: either it printed the new
 * session (ID / View URL) and exited, or it stayed attached and went quiet (Marion then detaches; the session keeps
 * running on claude.ai). Rejects, with the CLI's own error, whenever no Cloud session was created.
 */
export function relayCloudTerminal(program: string, folder: string, goal: string, signal: AbortSignal, hooks: CloudTerminalHooks,
  options: CloudTerminalOptions = {}): Promise<{ url: string; attached: boolean; output: string }> {
  const { startupMs = 150_000, idleMs = 90_000, maxMs = 6 * 3600_000 } = options;
  const [command, args] = terminal(program, cloudTerminalArgs(goal));
  const env = { ...cliEnvironment(), GIT_OPTIONAL_LOCKS: '0', TERM: 'xterm-256color', COLUMNS: '200', LINES: '50' };
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const child = spawn(command, args, { cwd: folder, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let raw = '';
    let url: string | null = null;
    let trusted = false;
    let asking = false;
    /** The owner's folder-trust card is open: an abort now (conversation reset, interrupt) leaves it unanswered. */
    let trustWaiting = false;
    /** Raw output since the trust selection's last key (null = no selection running). */
    let sinceTrustKey: string | null = null;
    /** Decided outcome while the CLI is still reacting to the last key (e.g. Esc on a declined trust prompt). */
    let ending: Error | null = null;
    const answered = new Set<string>();
    const seen = new Set<string>();
    let settled = false;
    let idle: NodeJS.Timeout | undefined;
    const kill = () => { try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); } };
    const text = () => cleanTerminal(raw);
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      if (startup) clearTimeout(startup);
      clearTimeout(cap); if (idle) clearTimeout(idle);
      signal.removeEventListener('abort', onAbort);
      child.stdin.destroy();
      kill();
      if (error) reject(error);
      else resolve({ url: url!, attached: child.exitCode === null && child.signalCode === null, output: text().slice(-6000) });
    };
    const failure = (fallback: string) => {
      const out = text();
      const error = out.split('\n').map(line => line.trim()).filter(line => /^Error\b|error:/i.test(line)).slice(-3).join(' ');
      checkUsageLimit(out);
      // Waiting on a question Marion recognised: say so plainly instead of dumping the terminal screen.
      const waitingOn = !error && !url && waitingPrompt(out.slice(-12_000));
      if (waitingOn) return new CloudLaunchError(`${fallback} Claude Code was still waiting on ${waitingOn}.`);
      return new Error((error || out.split('\n').map(line => line.trim()).filter(Boolean).slice(-6).join(' ') || fallback).slice(0, 800));
    };
    const onAbort = () => finish(ending ?? (trustWaiting ? new CloudLaunchError(FOLDER_TRUST_ABORTED)
      : signal.reason instanceof Error ? signal.reason : new Error('Stopped.')));
    signal.addEventListener('abort', onAbort, { once: true });
    // The startup clock stops while the owner answers a card, and starts over once they did.
    let startup: NodeJS.Timeout | undefined;
    const startClock = () => {
      if (startup) clearTimeout(startup);
      startup = settled || url ? undefined
        : setTimeout(() => finish(failure(`Claude Cloud did not start within ${Math.round(startupMs / 1000)} seconds.`)), startupMs);
    };
    const pauseClock = () => { if (startup) clearTimeout(startup); startup = undefined; };
    startClock();
    const cap = setTimeout(() => finish(url ? null : failure('Claude Cloud did not start.')), maxMs);
    const type = (keys: string) => { if (!settled && !child.stdin.destroyed) child.stdin.write(keys); };
    /** Unexpected failures while handling an answer fail the launch now: never a paused clock or an unhandled rejection. */
    const crashed = (error: unknown) => { if (!settled) finish(error instanceof Error ? error : new Error(String(error))); };
    const ask = <T,>(question: () => Promise<T>, fallback: T, answer: (ok: T) => void) => {
      asking = true;
      pauseClock();
      let pending: Promise<T>;
      // A hook that throws instead of rejecting counts as no answer, like a rejection.
      try { pending = Promise.resolve(question()); } catch (error) { pending = Promise.reject(error); }
      void pending.catch(() => fallback).then(ok => {
        asking = false;
        if (settled) return;
        startClock();
        answer(ok);
      }).catch(crashed);
    };
    const trustFolder = () => {
      // Re-read the terminal after every key; Enter only once ❯ is confirmed on "Yes, I trust this folder". The selection
      // has its own time limit, so the startup clock waits for it and starts over afterwards.
      sinceTrustKey = null;
      pauseClock();
      void selectTrustOption({
        read: () => sinceTrustKey === null ? cleanTerminal(raw.slice(-12_000)) : cleanTerminal(sinceTrustKey),
        screen: () => terminalScreen(raw),
        type: key => { sinceTrustKey = ''; type(key); },
        wait: ms => new Promise(done => setTimeout(done, ms)),
        ended: () => settled,
      }, options.trust).catch((error: unknown): TrustSelectResult => ({
        // A failure inside the selection (e.g. reading the terminal) fails the launch cleanly instead of leaving the
        // startup clock paused for good and the rejection unhandled.
        ok: false, reason: error instanceof Error ? error.message : String(error), keys: [],
      })).then(result => {
        sinceTrustKey = null;
        if (result.ok) startClock();
        else if (!settled) finish(new Error(`Claude Code asked to trust its launch folder, but Marion could not confirm "Yes, I trust this folder" was selected (${result.reason}), so it did not press Enter.`));
      }).catch(crashed);
    };
    const onData = (chunk: Buffer) => {
      raw = (raw + chunk.toString('utf8')).slice(-400_000);
      if (sinceTrustKey !== null) sinceTrustKey = (sinceTrustKey + chunk.toString('utf8')).slice(-20_000);
      const recent = cleanTerminal(raw.slice(-12_000));
      if (!url) {
        // Read as tokens (no gaps from cursor jumps), and only a URL something already follows: never a cut-off link.
        const found = terminalCloudUrl(cleanTerminal(raw.slice(-12_000), { gaps: false }), { complete: true });
        if (found) {
          url = found;
          pauseClock();
          hooks.onUrl(found);
        }
      }
      // The CLI cannot continue until its folder-trust question is answered: the owner decides on an in-app card.
      if (!trusted && !url && isTrustPrompt(recent)) {
        trusted = true;
        // A dedicated folder-trust card when the caller has one; otherwise the generic prompt card. Never a blind Enter.
        const askTrust = hooks.onTrust ?? hooks.onPrompt;
        if (!askTrust) return finish(new CloudLaunchError('Claude Code asked to trust its launch folder and nobody can answer it here.'));
        trustWaiting = true;
        ask<TrustAnswer | boolean>(() => askTrust(trustDetail(recent)), 'aborted', given => {
          trustWaiting = false;
          const answer = trustAnswer(given);
          if (answer === 'approved') return trustFolder();
          // Esc answers "no" in Claude Code; give it a moment to read the key before the terminal closes. A reset
          // conversation is no decline: no card answered it, so the caller reports the failure itself.
          ending = answer === 'declined' ? new CloudLaunchError(FOLDER_TRUST_DECLINED, true) : new CloudLaunchError(FOLDER_TRUST_ABORTED);
          pauseClock();
          type('\x1b');
          setTimeout(() => finish(ending), 300);
        });
        return;
      }
      if (!url && SIGN_IN_PROMPT.test(recent)) return finish(new Error(claudeSignInMessage));
      const choice = CHOICE_PROMPT.exec(recent);
      if (choice && !asking && !answered.has(choice[0]) && !isTrustPrompt(choice[0])) {
        answered.add(choice[0]);
        if (!hooks.onPrompt) type('\x1b');
        else ask(() => hooks.onPrompt!(choice[0].replace(/\s+\n/g, '\n').trim().slice(0, 1500)), false, ok => type(ok ? '\r' : '\x1b'));
      }
      if (url) {
        for (const line of cleanTerminal(chunk.toString('utf8')).split('\n')) {
          const clean = line.replace(/\s+/g, ' ').trim();
          if (clean.length < 4 || NOISE.test(clean) || seen.has(clean)) continue;
          if (seen.size > 2000) seen.clear();
          seen.add(clean);
          hooks.onProgress(clean.slice(0, 2000));
        }
        // Stayed attached (a live terminal view of the remote session): once it goes quiet, detach; the session keeps running.
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => finish(null), idleMs);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.stdin.on('error', () => {});
    child.on('error', error => finish(new Error(`Could not open a terminal for Claude Code: ${error.message}`)));
    child.on('exit', code => {
      // Give the last output a moment to arrive before deciding.
      setTimeout(() => {
        if (ending) return finish(ending);
        // A URL at the very end of the output (nothing after it) is complete once the CLI exited.
        if (!url) { url = terminalCloudUrl(cleanTerminal(raw.slice(-12_000), { gaps: false })); if (url) hooks.onUrl(url); }
        if (url) return finish(null);
        finish(failure(`Claude Code exited (${code ?? 'signal'}) without creating a Cloud session.`));
      }, 100);
    });
  });
}

const claudeSignInMessage = 'Claude Code is not signed in on this Mac. Run claude auth login --claudeai (or sign in from Settings → Assistants), then try again.';

const git = promisify(execFile);

/**
 * Claude Code picks the Cloud repository from the Git remote of the folder it starts in. Marion starts it in an empty
 * temporary folder of its own whose only content is a Git remote naming the GitHub repository: no project files, no
 * clone, and never one of the owner's local folders. Claude Cloud clones the repository on its side.
 */
export async function cloudPointer(repo: CloudRepo) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo.nameWithOwner)) throw new Error('Unexpected GitHub repository name.');
  const dir = await mkdtemp(join(tmpdir(), 'marion-cloud-'));
  try {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    await git('git', ['init', '-q'], { cwd: dir, env });
    await git('git', ['remote', 'add', 'origin', `https://github.com/${repo.nameWithOwner}.git`], { cwd: dir, env });
    return dir;
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
}

export function cloudGoal(goal: string, repo: CloudRepo) {
  const work = repo.canPush === false
    // A public repository the owner can read but not push to: inspect it, and hand back changes instead of pushing.
    ? 'This is a public repository with read-only access: clone and inspect it, read its files, issues and pull requests as needed, and do not push. If the task needs changes, make them in the Cloud checkout and finish with the full diff and a short summary (the owner can fork it to open a pull request).'
    : 'Work only in the Cloud checkout of this repository. Commit to a new branch, push it, and open a pull request when you changed files. Finish with a short summary and the PR link.';
  return `GitHub repository: ${repo.nameWithOwner} (${repo.url})\n${work}\n\n${goal}`;
}

/** Recognises Cloud launch failures that mean Claude Cloud itself can't reach the repository yet (GitHub app / connection). */
export const needsCloudConnection = (message: string) =>
  /github/i.test(message) && /(?:not\s+)?(?:install|connect|authori[sz]|access|permission|link)/i.test(message)
  || /repositor(?:y|ies).*(?:not\s+(?:found|accessible|available|connected)|no access|access denied)/i.test(message);

export interface CloudLaunchHooks {
  /** Ask the owner (in-app card) before the Cloud session uses a tool that needs permission. */
  onPermission?: CloudPermission;
  /** The launch failed because Claude Cloud cannot reach the repository: show the in-app fix card. */
  onConnectionNeeded?: (message: string) => void;
  /** Claude Code asks to trust Marion's temporary launch folder (terminal launch): ask the owner ('aborted' = nobody can answer). */
  onTrust?: (detail: string) => Promise<TrustAnswer>;
  /** The launch ended (finished, failed or stopped): questions still waiting on the owner are void. */
  onEnd?: (outcome: 'completed' | 'failed' | 'stopped') => void;
}

/** The Cloud session did not start. `cardShown`: an in-app card with the fix is already in the chat. */
export class CloudLaunchError extends Error {
  constructor(message: string, readonly cardShown = false) { super(message); }
}

/** The session label of a Cloud run: the repository it works on, marked so the Sessions view says where it runs. */
export const cloudFolder = (repo: CloudRepo) => ({ path: repo.url, label: repo.nameWithOwner });

/** Running Cloud launches by session id, so the work card's Stop button ends exactly that one. */
const running = new Map<string, { userId: string; botId: string; stop: AbortController }>();

/** Stop one Cloud run from its work card. The remote session keeps whatever it already did on claude.ai. */
export function stopCloudSession(userId: string, botId: string, sessionId: string) {
  const run = running.get(sessionId);
  if (!run || run.userId !== userId || run.botId !== botId) throw new Error('This Cloud session is no longer running in Marion.');
  run.stop.abort(new Error('Stopped from the work card.'));
}

/** Once the stream-json Cloud mode was refused, go straight to the terminal launch for the rest of this run of Marion. */
let headlessRefused = false;

/**
 * Starts a Cloud session and resolves with its Sessions id only once Claude confirmed it (a Cloud session URL or ID).
 * If it fails to start, the promise rejects with the reason, so a bot never reports a session that does not exist.
 * `sessionId` continues the record of a Cloud request that first waited on an in-app card, so it stays one session.
 */
export function startCloudSession(userId: string, botId: string, generation: number, goal: string, repo: CloudRepo, hooks: CloudLaunchHooks = {}, sessionId?: string): Promise<string> {
  const program = executable('claude');
  if (!program) return Promise.reject(new CloudLaunchError('Install Claude Code and run claude auth login --claudeai first.'));
  // The session record names the GitHub repository; Cloud runs never use a folder on this Mac.
  const track: SessionTrack = { id: sessionId || randomUUID(), kind: 'cloud', userId, botId, request: goal, folder: cloudFolder(repo) };
  const startedAt = Date.now();
  const inChat = () => {
    const bot = getBotRow(botId);
    return bot && !bot.deleted_at && bot.generation === generation;
  };
  beginAgentSession(track, 'claude', startedAt);
  // A real builder card in the transcript: live status, steps, a link to the session and a Stop button.
  const card = inChat() ? new WorkCard(botId, userId, {
    title: miniTitle(goal), detail: `GitHub ${repo.nameWithOwner}: ${goal.split('\n')[0]}`, reporter: getBotRow(botId)?.name,
    agents: [{ id: 'cloud-0', label: 'Claude Cloud', provider: 'claude', model: '', modelLabel: 'Cloud', role: 'worker' }],
  }) : null;
  const who = 'Claude Cloud';
  card?.step(who, 'note', `Starting a Cloud session on GitHub ${repo.nameWithOwner}`);
  card?.setStop({ kind: 'cloud', sessionId: track.id });
  const stop = new AbortController();
  running.set(track.id, { userId, botId, stop });

  let confirm!: (id: string) => void;
  let refuse!: (error: Error) => void;
  const launched = new Promise<string>((resolve, reject) => { confirm = resolve; refuse = reject; });
  let settled = false;
  const started = () => { if (!settled) { settled = true; confirm(track.id); } };
  const notStarted = (error: Error) => { if (!settled) { settled = true; refuse(error); } };

  void runExternalSession(botId, async outer => {
    const signal = AbortSignal.any([outer, stop.signal]);
    let cloudUrl: string | null = null;
    const progress: string[] = [];
    const saveProgress = (line: string) => {
      progress.push(line.slice(0, 2000)); if (progress.length > 40) progress.shift();
      card?.step(who, /^Used /.test(line) ? 'command' : 'note', line);
    };
    const onUrl = (url: string) => {
      cloudUrl = url;
      linkCloudSession(track, url);
      card?.setLink('Open in Claude', url);
      card?.step(who, 'note', `Cloud session started: ${url}`);
      started();
    };
    let pointer: string | undefined;
    let outcome: 'completed' | 'failed' | 'stopped' = 'failed';
    try {
      pointer = await cloudPointer(repo);
      await requireClaudeSubscription(program, pointer, signal);
      const task = cloudGoal(goal, repo);
      let reply: string;
      let handedOff = false;
      try {
        if (headlessRefused) throw new HeadlessUnsupported('stream-json Cloud mode refused earlier');
        reply = await relayCloud(program, pointer, task, signal, onUrl, saveProgress, hooks.onPermission);
      } catch (error) {
        if (!(error instanceof HeadlessUnsupported) || cloudUrl) throw error;
        // The CLI only starts Cloud sessions from a terminal on this account: run it in Marion's pseudo-terminal.
        headlessRefused = true;
        card?.step(who, 'note', 'Starting through Claude Code\'s terminal launcher');
        const result = await relayCloudTerminal(program, pointer, task, signal, { onUrl, onProgress: saveProgress,
          onPrompt: hooks.onPermission && (text => hooks.onPermission!({ tool: 'Claude Code', input: { question: text }, detail: text })),
          onTrust: hooks.onTrust });
        handedOff = true;
        reply = `Claude Cloud is working on GitHub ${repo.nameWithOwner}: ${result.url}\nIt keeps running on claude.ai; open it there to follow along, steer it, or pick up its pull request.`;
      }
      outcome = 'completed';
      finishAgentSession(track, 'claude', { status: 'completed', reply, startedAt, endedAt: Date.now() });
      card?.step(who, 'note', handedOff ? 'Handed off: the session keeps running on claude.ai' : 'Finished');
      card?.finish('done');
      if (reply && inChat()) appendRow(botId, 'message', { type: 'message', role: 'assistant', text: reply });
    } catch (error) {
      const stopped = signal.aborted;
      outcome = stopped ? 'stopped' : 'failed';
      // Interrupted (conversation reset) while the folder-trust card was open: say so, not a plain stop. The work
      // card's own Stop button stays a stop.
      const trustAborted = error instanceof CloudLaunchError && error.message === FOLDER_TRUST_ABORTED && !stop.signal.aborted;
      const message = trustAborted ? FOLDER_TRUST_ABORTED : stopped
        ? (cloudUrl ? 'Stopped in Marion; the Cloud session may still be running on Claude.' : 'Stopped before the Cloud session started.')
        : (error as Error).message;
      finishAgentSession(track, 'claude', { status: stopped ? 'stopped' : 'failed', error: message, startedAt, endedAt: Date.now() });
      card?.step(who, 'error', message);
      card?.finish(stopped ? 'stopped' : 'failed');
      const connect = !stopped && !cloudUrl && needsCloudConnection(message) && !!hooks.onConnectionNeeded && !!inChat();
      if (connect) hooks.onConnectionNeeded!(message);
      // Before the session existed, the caller reports the failure (the tool result or the card); afterwards, the chat does.
      if (cloudUrl && inChat()) appendRow(botId, 'notice', { type: 'notice', tone: stopped ? 'info' : 'warn', text: `Claude Cloud: ${message}` });
      notStarted(new CloudLaunchError(message, connect || (error instanceof CloudLaunchError && error.cardShown)));
      if (!stopped && isUsageLimitError(error)) {
        // The handoff never gets a local folder; it inspects the Cloud session and the GitHub repository.
        await offerHandoff({ track, generation, cloudUrl, progress,
          selection: { provider: 'claude', model: '', effort: null }, error, signal }).catch(failure => reportHandoffError(botId, generation, failure));
      }
    } finally {
      running.delete(track.id);
      try { hooks.onEnd?.(outcome); } catch { /* cleanup only */ }
      if (pointer) await rm(pointer, { recursive: true, force: true }).catch(() => {});
    }
  }).catch(error => { notStarted(error as Error); reportHandoffError(botId, generation, error); });
  return launched;
}
