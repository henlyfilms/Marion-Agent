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
 * type into (trust prompt, approvals). script(1) needs a non-socket stdin, so Node's stdin is copied into a private FIFO
 * by a background `cat`; the shell exits with script's status as soon as the CLI ends. macOS: BSD script(1); Linux:
 * util-linux script(1). stty gives the terminal a wide, fixed size so URLs never wrap.
 */
export function ptyCommand(program: string, args: string[]): [string, string[]] {
  const inner = 'stty cols 200 rows 50 2>/dev/null; exec "$@"';
  const run = process.platform === 'darwin'
    ? `/usr/bin/script -q /dev/null /bin/sh -c ${shellQuote(inner)} marion-pty "$@"`
    : `script -qfec ${shellQuote(['/bin/sh', '-c', inner, 'marion-pty', program, ...args].map(shellQuote).join(' '))} /dev/null`;
  const script = [
    'f="${TMPDIR:-/tmp}/marion-pty-$$"', 'rm -f "$f"', 'mkfifo -m 600 "$f" || exit 97', 'exec 3<&0',
    'cat <&3 >"$f" 2>/dev/null & c=$!', `${run} <"$f" 3<&-`, 's=$?', '{ kill $c; wait $c; } 2>/dev/null', 'rm -f "$f"', 'exit $s',
  ].join('\n');
  return ['/bin/sh', ['-c', script, 'marion-cloud', program, ...args]];
}

/** Tests swap the terminal wrapper (a sandbox may forbid opening a pseudo-terminal). */
let terminal: (program: string, args: string[]) => [string, string[]] = ptyCommand;
export function setCloudTerminal(wrap?: (program: string, args: string[]) => [string, string[]]) { terminal = wrap ?? ptyCommand; }

/** Terminal output as plain text: escape sequences removed, cursor jumps turned into line breaks. */
export function cleanTerminal(raw: string) {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[(\d*)C/g, (_, n) => ' '.repeat(Math.min(Number(n || 1), 200)))
    .replace(/\x1b\[[0-?]*[ -/]*[ABEFHJKf]/g, '\n')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMNOc]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

/** The Cloud session a terminal launch created: its claude.ai/code URL, or the printed session ID. */
export function terminalCloudUrl(text: string) {
  const url = /https:\/\/claude\.ai\/code\/(?:session|cse)_[a-z0-9_-]+/i.exec(text)?.[0];
  if (url) return cloudSessionUrl(url);
  const id = /Session ID:\s*((?:session|cse)_[a-z0-9_-]+)/i.exec(text)?.[1];
  return id ? cloudSessionUrl('https://claude.ai/code/' + id) : null;
}

const TRUST_PROMPT = /trust (?:the files in )?this folder|Do you trust/i;
const SIGN_IN_PROMPT = /Select login method|Please run \/login|not logged in|Invalid API key|OAuth token has expired/i;
/** A question the CLI waits on (a numbered choice under a "Do you want…?" line): the owner answers it on an in-app card. */
const CHOICE_PROMPT = /(?:Do you want|Would you like|Allow|Approve|Continue|Proceed)[^\n]{0,160}\?[\s\S]{0,400}?(?:❯|›|>)\s*1\.\s*\S/i;
const NOISE = /^[\s─━│┃╭╮╰╯┌┐└┘├┤┬┴┼═║╔╗╚╝▐▛▜▌▝▘█▔▁·•✻✶✳✢✽*+\-=_>❯›?]*$|esc to interrupt|for shortcuts|^\s*(?:[✻✶✳✢✽·*]\s*)?\w+…\s*\(/i;

export interface CloudTerminalHooks {
  onUrl: (url: string) => void;
  onProgress: (line: string) => void;
  /** The CLI waits on a question: show it to the owner (true = confirm, false = decline). */
  onPrompt?: (text: string) => Promise<boolean>;
}
export interface CloudTerminalOptions { startupMs?: number; idleMs?: number; maxMs?: number }

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
    const answered = new Set<string>();
    const seen = new Set<string>();
    let settled = false;
    let idle: NodeJS.Timeout | undefined;
    const kill = () => { try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); } };
    const text = () => cleanTerminal(raw);
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(startup); clearTimeout(cap); if (idle) clearTimeout(idle);
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
      return new Error((error || out.split('\n').map(line => line.trim()).filter(Boolean).slice(-6).join(' ') || fallback).slice(0, 800));
    };
    const onAbort = () => finish(signal.reason instanceof Error ? signal.reason : new Error('Stopped.'));
    signal.addEventListener('abort', onAbort, { once: true });
    const startup = setTimeout(() => finish(failure(`Claude Cloud did not start within ${Math.round(startupMs / 1000)} seconds.`)), startupMs);
    const cap = setTimeout(() => finish(url ? null : failure('Claude Cloud did not start.')), maxMs);
    const type = (keys: string) => { if (!child.stdin.destroyed) child.stdin.write(keys); };
    const onData = (chunk: Buffer) => {
      raw = (raw + chunk.toString('utf8')).slice(-400_000);
      const recent = cleanTerminal(raw.slice(-12_000));
      if (!url) {
        const found = terminalCloudUrl(recent);
        if (found) {
          url = found;
          clearTimeout(startup);
          hooks.onUrl(found);
        }
      }
      // Marion's own empty pointer folder: trusting it is safe and the CLI cannot continue until it is answered.
      if (!trusted && TRUST_PROMPT.test(recent)) { trusted = true; setTimeout(() => type('\r'), 150); return; }
      if (!url && SIGN_IN_PROMPT.test(recent)) return finish(new Error(claudeSignInMessage));
      const choice = CHOICE_PROMPT.exec(recent);
      if (choice && !asking && !answered.has(choice[0]) && !TRUST_PROMPT.test(choice[0])) {
        answered.add(choice[0]);
        if (!hooks.onPrompt) type('\x1b');
        else {
          asking = true;
          void hooks.onPrompt(choice[0].replace(/\s+\n/g, '\n').trim().slice(0, 1500)).catch(() => false)
            .then(ok => { asking = false; type(ok ? '\r' : '\x1b'); });
        }
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
          onPrompt: hooks.onPermission && (text => hooks.onPermission!({ tool: 'Claude Code', input: { question: text }, detail: text })) });
        handedOff = true;
        reply = `Claude Cloud is working on GitHub ${repo.nameWithOwner}: ${result.url}\nIt keeps running on claude.ai; open it there to follow along, steer it, or pick up its pull request.`;
      }
      finishAgentSession(track, 'claude', { status: 'completed', reply, startedAt, endedAt: Date.now() });
      card?.step(who, 'note', handedOff ? 'Handed off: the session keeps running on claude.ai' : 'Finished');
      card?.finish('done');
      if (reply && inChat()) appendRow(botId, 'message', { type: 'message', role: 'assistant', text: reply });
    } catch (error) {
      const stopped = signal.aborted;
      const message = stopped
        ? (cloudUrl ? 'Stopped in Marion; the Cloud session may still be running on Claude.' : 'Stopped before the Cloud session started.')
        : (error as Error).message;
      finishAgentSession(track, 'claude', { status: stopped ? 'stopped' : 'failed', error: message, startedAt, endedAt: Date.now() });
      card?.step(who, 'error', message);
      card?.finish(stopped ? 'stopped' : 'failed');
      const connect = !stopped && !cloudUrl && needsCloudConnection(message) && !!hooks.onConnectionNeeded && !!inChat();
      if (connect) hooks.onConnectionNeeded!(message);
      // Before the session existed, the caller reports the failure (the tool result or the card); afterwards, the chat does.
      if (cloudUrl && inChat()) appendRow(botId, 'notice', { type: 'notice', tone: stopped ? 'info' : 'warn', text: `Claude Cloud: ${message}` });
      notStarted(new CloudLaunchError(message, connect));
      if (!stopped && isUsageLimitError(error)) {
        // The handoff never gets a local folder; it inspects the Cloud session and the GitHub repository.
        await offerHandoff({ track, generation, cloudUrl, progress,
          selection: { provider: 'claude', model: '', effort: null }, error, signal }).catch(failure => reportHandoffError(botId, generation, failure));
      }
    } finally {
      running.delete(track.id);
      if (pointer) await rm(pointer, { recursive: true, force: true }).catch(() => {});
    }
  }).catch(error => { notStarted(error as Error); reportHandoffError(botId, generation, error); });
  return launched;
}
