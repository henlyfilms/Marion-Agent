// Strict Cloud mode, end to end: resolve the GitHub repository, start Claude Cloud on it, and when something blocks that,
// put the exact problem and concrete fixes on an in-app card in the chat. The owner approves or picks right there; Marion
// runs the fix and carries on in the Cloud. Nothing here ever falls back to a folder on this Mac.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { appendRow, getBotRow, getRow, updateRow } from '../store.js';
import { executable } from '../agent/subscriptions.js';
import { notify } from './notify.js';
import { createGitHubRepo } from './github-repos.js';
import { CloudLaunchError, startCloudSession, type CloudLaunchHooks, type TrustAnswer } from './cloud-sessions.js';
import { recordCloudRequest, settleCloudRequest } from './agent-sessions.js';
import type { CloudCardBody } from '../types.js';
import {
  exactRepo, fetchPublicRepo, ghDeviceAuth, ghLoginArgs, ghScopeArgs, resolveCloudRepo, runGh,
  type PublicRepoLookup, type CloudBlocker, type CloudOption, type CloudRepo, type CloudResolution, type DeviceAuth, type GhRun,
} from './cloud-repo.js';


const exec = promisify(execFile);
export interface CloudDeps {
  gh: GhRun;
  deviceAuth: DeviceAuth;
  installGh: () => Promise<void>;
  createRepo: (fullName: string) => Promise<void>;
  claudeInstalled: () => boolean;
  /** Resolves with the Sessions id once Claude confirmed the Cloud session; rejects (CloudLaunchError) if it did not start. */
  launch: (userId: string, botId: string, generation: number, goal: string, repo: CloudRepo, hooks: CloudLaunchHooks, sessionId?: string) => Promise<string>;
  /** Public repositories looked up without the GitHub CLI (owner/repo or a URL). */
  publicRepo: PublicRepoLookup;
}
const defaults: CloudDeps = {
  gh: runGh,
  deviceAuth: ghDeviceAuth,
  installGh: async () => {
    const brew = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find(path => existsSync(path)) ?? 'brew';
    await exec(brew, ['install', 'gh'], { timeout: 10 * 60_000, env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1' } });
  },
  createRepo: async fullName => { await createGitHubRepo({ name: fullName, visibility: 'private', description: 'Created by Marion Agent for Claude Cloud work' }); },
  claudeInstalled: () => !!executable('claude'),
  launch: startCloudSession,
  publicRepo: fetchPublicRepo,
};
let deps: CloudDeps = { ...defaults };
/** Tests swap the GitHub CLI and Cloud launcher for fakes. */
export function setCloudDeps(patch: Partial<CloudDeps>) { deps = { ...deps, ...patch }; }
export function resetCloudDeps() { deps = { ...defaults }; }

/** Pending permission questions from running Cloud sessions, answered from their cards ('aborted' = nobody can any more). */
const permissionWaits = new Map<string, (answer: TrustAnswer) => void>();
/** Tests: how many permission questions are still waiting on an answer. */
export const pendingCloudPermissions = () => permissionWaits.size;

const current = (botId: string, generation: number) => {
  const bot = getBotRow(botId);
  return bot && !bot.deleted_at && bot.generation === generation ? bot : null;
};

/** Ends the wait of a permission card that can no longer be answered (its launch ended) and marks the card expired. */
function expirePermission(botId: string, id: string, seq: number, note: string) {
  const wait = permissionWaits.get(id);
  if (!wait) return;
  permissionWaits.delete(id);
  const now = getRow(botId, seq)?.body as CloudCardBody | undefined;
  if (now?.type === 'card' && now.card === 'cloud' && now.status === 'pending') updateRow(botId, seq, { ...now, status: 'expired', note });
  wait('aborted');
}

type LaunchHooks = CloudLaunchHooks & { onEnd: NonNullable<CloudLaunchHooks['onEnd']> };

function hooksFor(userId: string, botId: string, generation: number, goal: string, title: string | undefined, repo: CloudRepo): LaunchHooks {
  /** This launch's permission cards still waiting on the owner (card id → row seq). */
  const open = new Map<string, number>();
  /** 'aborted' (no card, or a card that can no longer be answered) is never reported as the owner's decline. */
  const ask = (problem: string, solution: string, labels: { allow: string; deny: string }, alertText: string, blocker?: CloudBlocker) =>
    new Promise<TrustAnswer>(resolve => {
      if (!current(botId, generation)) return resolve('aborted');
      const id = randomUUID();
      const card: CloudCardBody = {
        type: 'card', card: 'cloud', id, mode: 'permission', goal, title, query: repo.nameWithOwner, generation, repo: repo.nameWithOwner,
        ...(blocker ? { blocker } : {}), problem, solution,
        options: [{ id: 'allow', kind: 'retry', label: labels.allow }, { id: 'deny', kind: 'cancel', label: labels.deny }], status: 'pending',
      };
      const row = appendRow(botId, 'card', card);
      open.set(id, row.seq as number);
      permissionWaits.set(id, answer => { open.delete(id); resolve(answer); });
      alert(userId, botId, alertText);
    });
  return {
    // A tool or launch question nobody can answer any more is simply not allowed.
    onPermission: async ({ tool, detail }) => await ask(
      // 'Claude Code' = a question the CLI asks while launching (access, auth, repository); anything else is a tool in the Cloud sandbox.
      tool === 'Claude Code'
        ? `Claude Code is asking before it starts Cloud work on ${repo.nameWithOwner}.`
        : `Claude Cloud wants to use ${tool} in its cloud sandbox for ${repo.nameWithOwner}.`,
      detail, { allow: 'Allow', deny: "Don't allow" }, `Claude Cloud wants to use ${tool}`) === 'approved',
    onTrust: detail => ask(
      `Claude Code is asking whether to trust the folder it starts in. That folder is Marion's temporary Git launch folder for ${repo.nameWithOwner}: it is empty apart from a Git remote naming the GitHub repository (no project files, nothing else on this Mac), and is deleted afterwards. Claude Code will not start the Cloud session until this is answered.`,
      `Trust folder lets Claude Code start the Cloud session on ${repo.nameWithOwner}; Cancel stops the launch.` + (detail ? `\n\nClaude Code shows: ${detail.slice(0, 600)}` : ''),
      { allow: 'Trust folder', deny: 'Cancel' }, `Claude Code asks to trust its launch folder for ${repo.nameWithOwner}`, 'folder-trust'),
    onEnd: outcome => {
      const note = outcome === 'stopped' ? 'Expired: the Cloud launch was stopped.'
        : outcome === 'failed' ? 'Expired: the Cloud launch ended before this was answered.' : 'Expired: the Cloud session finished.';
      for (const [id, seq] of [...open]) expirePermission(botId, id, seq, note);
    },
    onConnectionNeeded: message => showCard(userId, botId, generation, goal, title, repo.nameWithOwner, {
      ok: false, blocker: 'cloud-connect',
      problem: `Claude Cloud cannot reach ${repo.nameWithOwner} yet: ${message.slice(0, 300)}`,
      solution: 'Connect GitHub to Claude (install the Claude GitHub app on this repository), then press Start again here.',
      options: [
        { id: 'open-github-app', kind: 'open', label: 'Connect GitHub to Claude', url: 'https://github.com/apps/claude/installations/new', hint: 'Grant the Claude GitHub app access to this repository' },
        { id: 'repo:' + repo.nameWithOwner, kind: 'repo', repo: repo.nameWithOwner, label: `Start again on ${repo.nameWithOwner}` },
        { id: 'cancel', kind: 'cancel', label: 'Cancel' },
      ],
    }),
  };
}

function alert(userId: string, botId: string, body: string) {
  const bot = getBotRow(botId);
  if (bot && !bot.hidden) notify(userId, { kind: 'approval', botId, title: `${bot.name} needs your OK`, body });
}

function showCard(userId: string, botId: string, generation: number, goal: string, title: string | undefined, query: string,
  resolution: Extract<CloudResolution, { ok: false }>, sessionId?: string) {
  const card: CloudCardBody = {
    type: 'card', card: 'cloud', id: randomUUID(), mode: 'setup', goal, title, query, generation,
    blocker: resolution.blocker, problem: resolution.problem, solution: resolution.solution, options: resolution.options, status: 'pending',
    ...(sessionId ? { sessionId } : {}),
  };
  const row = appendRow(botId, 'card', card);
  alert(userId, botId, resolution.problem);
  return row.seq as number;
}

/** What a waiting Cloud request shows as its repository: the exact one when named, else a GitHub search for the name. */
const requestedRepo = (query: string) => {
  const exact = exactRepo(query);
  return exact ? { path: `https://github.com/${exact}`, label: exact }
    : { path: `https://github.com/search?type=repositories&q=${encodeURIComponent(query)}`, label: query };
};

export type CloudLaunchResult =
  | { started: true; repo: CloudRepo; sessionId: string }
  | { started: false; seq: number; blocker: CloudBlocker; problem: string; solution: string; options: CloudOption[] };

/** Launch and wait for Claude to confirm the Cloud session; a launch that fails throws (CloudLaunchError) with the reason. */
async function launchConfirmed(userId: string, botId: string, generation: number, goal: string, title: string | undefined, repo: CloudRepo, sessionId?: string) {
  const hooks = hooksFor(userId, botId, generation, goal, title, repo);
  try { return await deps.launch(userId, botId, generation, goal, repo, hooks, sessionId); }
  catch (error) {
    // It did not start: nothing can answer this launch's questions any more.
    hooks.onEnd('failed');
    throw error instanceof CloudLaunchError ? error : new CloudLaunchError(String((error as Error)?.message ?? error));
  }
}

/**
 * Start Cloud work for a request. `query` names the repository (owner/repo, URL, or a name to search for).
 * Resolves on GitHub only; on any blocker an in-app card with concrete fixes goes into the chat instead.
 */
export async function launchCloudWork(input: { userId: string; botId: string; generation: number; goal: string; title?: string; query?: string | null }): Promise<CloudLaunchResult> {
  const { userId, botId, generation, goal, title } = input;
  const query = (input.query ?? '').trim();
  // One Sessions record from the moment Cloud work is asked for: Waiting while a card holds it, then Running in the Cloud.
  const sessionId = randomUUID();
  const waiting = (problem: string) => recordCloudRequest({ id: sessionId, kind: 'cloud', userId, botId, request: goal, title,
    folder: query ? requestedRepo(query) : undefined }, `Waiting for you: ${problem}`);
  if (!deps.claudeInstalled()) {
    const resolution = { ok: false as const, blocker: 'claude-missing' as const, problem: 'Claude Code is not installed on this Mac, so Marion cannot start a Claude Cloud session.',
      solution: 'Install Claude Code and sign in with your Claude account, then check again here.',
      options: [{ id: 'open-claude', kind: 'open' as const, label: 'Get Claude Code', url: 'https://claude.com/claude-code' }, { id: 'retry', kind: 'retry' as const, label: 'Check again' }, { id: 'cancel', kind: 'cancel' as const, label: 'Cancel' }] };
    waiting(resolution.problem);
    const seq = showCard(userId, botId, generation, goal, title, query, resolution, sessionId);
    return { started: false, seq, blocker: resolution.blocker, problem: resolution.problem, solution: resolution.solution, options: resolution.options };
  }
  const resolution = await resolveCloudRepo(query, deps.gh, deps.publicRepo);
  if (resolution.ok) {
    const started = await launchConfirmed(userId, botId, generation, goal, title, resolution.repo, sessionId);
    return { started: true, repo: resolution.repo, sessionId: started };
  }
  waiting(resolution.problem);
  const seq = showCard(userId, botId, generation, goal, title, query, resolution, sessionId);
  return { started: false, seq, blocker: resolution.blocker, problem: resolution.problem, solution: resolution.solution, options: resolution.options };
}

/** Options that run a command on this Mac (GitHub sign-in, install, create, fork): only approvable in the Mac app. */
const LOCAL_ONLY = new Set(['gh-install', 'gh-login', 'gh-scopes', 'create-repo', 'fork']);

/**
 * The owner picked an option on a Cloud card. Returns once the choice is accepted; `done` settles when the follow-up
 * (sign-in, fix, re-check, launch) finishes and the card shows the outcome.
 */
export function actOnCloudCard(userId: string, botId: string, seq: number, optionId: string, opts: { local: boolean }): { done: Promise<void> } {
  const bot = getBotRow(botId);
  if (!bot || bot.user_id !== userId || bot.deleted_at) throw new Error('Bot not found.');
  const row = getRow(botId, seq);
  const body = row?.body as CloudCardBody | undefined;
  if (!row || body?.type !== 'card' || body.card !== 'cloud') throw new Error('Not a Cloud card.');
  if (body.status !== 'pending') throw new Error(body.status === 'working' ? 'Marion is already working on this.' : 'This card is already done.');
  const option = body.options.find(o => o.id === optionId);
  if (!option) throw new Error('Unknown option.');
  if (option.kind === 'open') throw new Error('Open this link from the card.');
  const save = (patch: Partial<CloudCardBody>) => { const now = getRow(botId, seq)?.body as CloudCardBody; updateRow(botId, seq, { ...now, ...patch }); };

  if (body.mode === 'permission') {
    const allowed = optionId === 'allow';
    save({ status: allowed ? 'allowed' : 'denied' });
    const wait = permissionWaits.get(body.id);
    permissionWaits.delete(body.id);
    wait?.(allowed ? 'approved' : 'declined');
    return { done: Promise.resolve() };
  }
  if (option.kind === 'cancel') {
    save({ status: 'cancelled', note: 'Cancelled. Nothing ran on this Mac.' });
    if (body.sessionId) settleCloudRequest(userId, body.sessionId, 'Cancelled before it started.');
    return { done: Promise.resolve() };
  }
  if (LOCAL_ONLY.has(option.kind) && !opts.local) throw new Error('Approve this in Marion Agent on the Mac: it runs the GitHub CLI there.');
  if (!current(botId, body.generation)) {
    save({ status: 'cancelled', note: 'The conversation changed.' });
    if (body.sessionId) settleCloudRequest(userId, body.sessionId, 'The conversation changed before it started.');
    throw new Error('The conversation changed. Ask again.');
  }
  save({ status: 'working', note: workingNote(option), device: undefined });

  const proceed = async (query: string) => {
    const result = await launchFollowUp(userId, botId, body, query);
    if (result.started) save({ status: 'started', repo: result.repo.nameWithOwner, sessionId: result.sessionId, device: undefined, note: `Started Claude Cloud on ${result.repo.nameWithOwner}.` });
    else save({ status: 'pending', blocker: result.blocker, problem: result.problem, solution: result.solution, options: result.options, note: undefined, device: undefined });
  };
  const done = (async () => {
    try {
      switch (option.kind) {
        case 'repo': return await proceed(option.repo!);
        case 'retry': return await proceed(body.repo ?? body.query);
        case 'gh-install': await deps.installGh(); return await proceed(body.query);
        case 'gh-login':
        case 'gh-scopes':
          await deps.deviceAuth(option.kind === 'gh-login' ? ghLoginArgs() : ghScopeArgs(), (code, url) =>
            save({ device: { code, url }, note: `Enter code ${code} at ${url} to finish GitHub sign-in. Marion continues automatically.` }));
          return await proceed(body.query);
        case 'create-repo': await deps.createRepo(option.repo!); return await proceed(option.repo!);
        case 'fork': {
          await deps.gh(['repo', 'fork', option.repo!, '--clone=false', '--default-branch-only']);
          const me = (await deps.gh(['api', 'user', '--jq', '.login']).catch(() => '')).trim();
          return await proceed(me ? `${me}/${option.repo!.split('/')[1]}` : option.repo!.split('/')[1]);
        }
      }
    } catch (error) {
      save({ status: 'pending', note: `That did not work: ${String((error as Error).message ?? error).slice(0, 300)}. Pick another option or check again.`, device: undefined });
    }
  })();
  return { done };
}

function workingNote(option: CloudOption) {
  switch (option.kind) {
    case 'repo': return `Checking ${option.repo} and starting Claude Cloud…`;
    case 'gh-install': return 'Installing the GitHub CLI…';
    case 'gh-login': return 'Starting GitHub sign-in…';
    case 'gh-scopes': return 'Requesting GitHub access…';
    case 'create-repo': return `Creating ${option.repo} on GitHub…`;
    case 'fork': return `Forking ${option.repo}…`;
    default: return 'Checking again…';
  }
}

/** Re-resolve after a fix without posting a second card: the same card updates in place. */
async function launchFollowUp(userId: string, botId: string, body: CloudCardBody, query: string): Promise<CloudLaunchResult> {
  if (!deps.claudeInstalled()) return { started: false, seq: -1, blocker: 'claude-missing', problem: 'Claude Code is still not installed on this Mac.',
    solution: 'Install Claude Code, sign in, then check again.', options: body.options };
  const resolution = await resolveCloudRepo(query, deps.gh, deps.publicRepo);
  if (!resolution.ok) return { started: false, seq: -1, blocker: resolution.blocker, problem: resolution.problem, solution: resolution.solution, options: resolution.options };
  const sessionId = await launchConfirmed(userId, botId, body.generation, body.goal, body.title, resolution.repo, body.sessionId);
  return { started: true, repo: resolution.repo, sessionId };
}
