import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { cliEnvironment, executable, parseLine, requireClaudeSubscription } from '../agent/subscriptions.js';
import { checkUsageLimit, isUsageLimitError } from '../agent/usage-limit.js';
import { appendRow, getBotRow } from '../store.js';
import { runExternalSession } from '../agent/loop.js';
import { beginAgentSession, finishAgentSession, linkCloudSession } from './agent-sessions.js';
import { offerHandoff, reportHandoffError } from './handoffs.js';
import type { SessionTrack } from './life-outbox.js';
import type { BotFolder } from './folders.js';

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

export async function relayCloud(program: string, folder: string, goal: string, signal: AbortSignal,
  onUrl: (url: string) => void, onProgress: (line: string) => void) {
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
        send({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id,
          error: 'Marion cannot authorize a Cloud request to use this Mac. Open the session in Claude if it needs input.' } });
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
    if (/requires an interactive terminal|not available|not supported/i.test(diagnostic))
      throw new Error('This Claude CLI or account does not support headless Cloud sessions. Update Claude Code and check that Cloud sessions are enabled for your account.');
    checkUsageLimit(diagnostic);
    throw new Error(processError || diagnostic.trim().slice(-800) || 'Claude Cloud disconnected before returning a result.');
  } finally {
    lines.close();
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

export function startCloudSession(userId: string, botId: string, generation: number, goal: string, folder: BotFolder) {
  const program = executable('claude');
  if (!program) throw new Error('Install Claude Code and run claude auth login --claudeai first.');
  const track: SessionTrack = { id: randomUUID(), kind: 'cloud', userId, botId, request: goal, folder };
  const startedAt = Date.now();
  beginAgentSession(track, 'claude', startedAt);
  appendRow(botId, 'notice', { type: 'notice', tone: 'info',
    text: `Starting Claude Cloud in ${folder.label}: ${goal.replace(/\s+/g, ' ').slice(0, 160)}` });
  const inChat = () => {
    const bot = getBotRow(botId);
    return bot && !bot.deleted_at && bot.generation === generation;
  };
  void runExternalSession(botId, async signal => {
    let cloudUrl: string | null = null;
    const progress: string[] = [];
    const saveProgress = (line: string) => { progress.push(line.slice(0, 2000)); if (progress.length > 40) progress.shift(); };
    try {
      await requireClaudeSubscription(program, folder.path, signal);
      const reply = await relayCloud(program, folder.path, goal, signal, url => {
        cloudUrl = url;
        linkCloudSession(track, url);
      }, saveProgress);
      finishAgentSession(track, 'claude', { status: 'completed', reply, startedAt, endedAt: Date.now() });
      if (reply && inChat()) appendRow(botId, 'message', { type: 'message', role: 'assistant', text: reply });
    } catch (error) {
      const message = signal.aborted
        ? 'Marion disconnected; the Cloud session may still be running on Claude.'
        : (error as Error).message;
      finishAgentSession(track, 'claude', { status: signal.aborted ? 'stopped' : 'failed', error: message, startedAt, endedAt: Date.now() });
      if (inChat()) appendRow(botId, 'notice', { type: 'notice', tone: signal.aborted ? 'info' : 'warn', text: `Claude Cloud: ${message}` });
      if (!signal.aborted && isUsageLimitError(error)) {
        await offerHandoff({ track, generation, cloudUrl, progress, folder,
          selection: { provider: 'claude', model: '', effort: null }, error, signal }).catch(failure => reportHandoffError(botId, generation, failure));
      }
    }
  }).catch(error => reportHandoffError(botId, generation, error));
  return track.id;
}
