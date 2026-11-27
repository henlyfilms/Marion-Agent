// Strict Cloud mode: find the GitHub repository a Cloud request is about, using the GitHub CLI only.
// Nothing here looks at, clones or uses a folder on this Mac. When the repository can't be used, the result names the exact
// blocker and concrete fixes; the caller shows them as an in-app action card (see cloud-cards.ts).
import { spawn } from 'node:child_process';
import { cliEnvironment } from '../agent/subscriptions.js';

export interface CloudRepo { nameWithOwner: string; url: string; isPrivate?: boolean; canPush?: boolean; pushedAt?: string }

import type { CloudBlocker, CloudOption } from '../types.js';
export type { CloudBlocker, CloudOption, CloudOptionKind } from '../types.js';

export type CloudResolution =
  | { ok: true; repo: CloudRepo }
  | { ok: false; blocker: CloudBlocker; problem: string; solution: string; options: CloudOption[]; candidates?: CloudRepo[] };

export type GhRun = (args: string[]) => Promise<string>;

/** Scopes Cloud work needs from the GitHub CLI token: private repositories and org membership (to list org repositories). */
export const GH_SCOPES = ['repo', 'read:org'];

/** Shared by the bot system prompts (local model and subscription-backed). */
export const CLOUD_PROMPT_LINE = 'Cloud work (strict): when the owner asks to work in the cloud (Claude Cloud, a cloud session, --cloud), call start_cloud_session with the full task and the GitHub repository (owner/repo, URL, or the name they said). Never look for, list or use a folder or local checkout on this Mac for it, and never switch to ask_subscription or shell instead. If the repository is missing, ambiguous or needs access or sign-in, Marion puts an in-app card with concrete fixes in this chat (pick a repository, sign in to GitHub, grant access, create or fork it); relay that briefly and stop, and the owner approves it right there.';

/** "work on this in the cloud", "use Claude Cloud", "start a cloud session", "--cloud"… */
export function wantsCloud(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  return /--cloud\b|\b(?:in|on|via|using|with|through)\s+(?:the\s+)?(?:claude\s+)?cloud\b|\bclaude\s+cloud\b|\bcloud\s+(?:session|work|agent|mode|task)s?\b|\bclaude(?:\s+code)?\s+(?:on\s+the\s+)?web\b|\b(?:run|work|do|start|launch|kick\s+off)\s+(?:it|this|that)?\s*(?:remotely|in\s+the\s+cloud)\b/i.test(text);
}

const OWNER = '[a-z\\d](?:[a-z\\d-]{0,38})';
const NAME = '[a-z\\d._-]{1,100}';

/** "owner/repo", "github.com/owner/repo(.git)", "git@github.com:owner/repo.git" → "owner/repo". */
export function exactRepo(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const url = new RegExp(`github\\.com[/:](${OWNER})/(${NAME}?)(?:\\.git)?(?:[/#?\\s]|$)`, 'i').exec(text);
  if (url) return `${url[1]}/${url[2].replace(/\.git$/i, '')}`;
  const plain = new RegExp(`^\\s*(${OWNER})/(${NAME})\\s*$`, 'i').exec(text);
  return plain ? `${plain[1]}/${plain[2].replace(/\.git$/i, '')}` : null;
}

/** The repository a free-form request names, if it names one: a URL/owner/repo anywhere, or "the X repo". */
export function repoHint(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const full = new RegExp(`(?:github\\.com[/:])?\\b(${OWNER}/${NAME})\\b`, 'i').exec(text);
  if (full && !/^(?:and|or|https?|www)\//i.test(full[1]) && /[a-z]/i.test(full[1].split('/')[1])) return exactRepo(full[0].replace(/^.*github\.com[/:]/i, '')) ?? full[1];
  const quoted = /\b(?:repo(?:sitory)?|project)\s+(?:called\s+|named\s+)?["“']([^"”'\n]{1,60})["”']/i.exec(text)
    ?? /\b(?:repo(?:sitory)?|project)\s+(?:called|named)\s+([\w.-]+(?:\s+[\w.-]+){0,3}?)(?=\s*(?:[,.;:!?]|$|\s(?:in|on|to|and|for|with)\b))/i.exec(text);
  if (quoted) return quoted[1].trim();
  const STOP = /^(?:the|a|an|in|on|of|to|for|and|this|that|it|my|our)$/i;
  for (const match of text.matchAll(/\b(?:the|my|our)\s+((?:[\w.-]+\s+){0,3}?[\w.-]+)\s+(?:repo(?:sitory)?|project)\b/gi)) {
    const words = match[1].trim().split(/\s+/);
    if (!words.some(word => STOP.test(word))) return match[1].trim();
  }
  return null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z\d]/g, '');

/** Repositories ranked by how well they match `query`; only the best tier is returned (several = ambiguous). */
export function matchRepos(repos: CloudRepo[], query: string): CloudRepo[] {
  const q = query.trim().toLowerCase().replace(/\.git$/, '');
  const nq = norm(q);
  if (!nq) return [];
  const words = q.split(/[\s/_.-]+/).map(norm).filter(Boolean);
  const score = (repo: CloudRepo) => {
    const full = repo.nameWithOwner.toLowerCase();
    const name = full.split('/')[1] ?? full;
    if (full === q) return 100;
    if (name === q) return 90;
    if (norm(name) === nq) return 80;
    if (norm(name).startsWith(nq)) return 60;
    if (norm(name).includes(nq)) return 50;
    if (words.length > 1 && words.every(word => norm(full).includes(word))) return 40;
    return 0;
  };
  const scored = repos.map(repo => ({ repo, score: score(repo) })).filter(entry => entry.score > 0);
  const best = Math.max(0, ...scored.map(entry => entry.score));
  return scored.filter(entry => entry.score === best).map(entry => entry.repo);
}

const short = (error: unknown) => String((error as any)?.stderr?.trim?.() || (error as Error)?.message || error).replace(/\s+/g, ' ').slice(0, 400);
const repoOption = (repo: CloudRepo, hint?: string): CloudOption =>
  ({ id: 'repo:' + repo.nameWithOwner, kind: 'repo', repo: repo.nameWithOwner, label: `Use ${repo.nameWithOwner}`, hint: hint ?? (repo.isPrivate ? 'Private' : 'Public') });
const RETRY: CloudOption = { id: 'retry', kind: 'retry', label: 'Check again', hint: 'After fixing access elsewhere' };
const CANCEL: CloudOption = { id: 'cancel', kind: 'cancel', label: 'Cancel' };
const LOGIN: CloudOption = { id: 'gh-login', kind: 'gh-login', label: 'Sign in to GitHub', hint: `Runs gh auth login (scopes ${GH_SCOPES.join(', ')}); shows the one-time code here` };
const blocked = (blocker: CloudBlocker, problem: string, solution: string, options: CloudOption[], candidates?: CloudRepo[]): CloudResolution =>
  ({ ok: false, blocker, problem, solution, options: [...options, CANCEL], ...(candidates ? { candidates } : {}) });

/** Parse `gh auth status` output: the scopes the token has ('' when gh doesn't list them, e.g. fine-grained tokens). */
export function tokenScopes(status: string): string[] | null {
  const line = /Token scopes:\s*(.*)/i.exec(status);
  if (!line) return null;
  return [...line[1].matchAll(/'([^']+)'|([\w:-]+)/g)].map(m => m[1] ?? m[2]).filter(Boolean);
}

async function myRepos(gh: GhRun): Promise<CloudRepo[]> {
  const out = await gh(['api', '--paginate', 'user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member',
    '--jq', '.[] | {nameWithOwner: .full_name, url: .html_url, isPrivate: .private, canPush: (.permissions.push // false), pushedAt: .pushed_at}']);
  return out.split('\n').map(line => { try { return JSON.parse(line) as CloudRepo; } catch { return null; } }).filter((r): r is CloudRepo => !!r?.nameWithOwner);
}

async function viewRepo(gh: GhRun, full: string): Promise<CloudRepo | null> {
  try {
    const repo = JSON.parse(await gh(['repo', 'view', full, '--json', 'nameWithOwner,url,isPrivate,viewerPermission']));
    return { nameWithOwner: repo.nameWithOwner, url: repo.url, isPrivate: repo.isPrivate, canPush: ['ADMIN', 'MAINTAIN', 'WRITE'].includes(repo.viewerPermission) };
  } catch (error) {
    if (/could not resolve|not found|404/i.test(short(error))) return null;
    throw error;
  }
}

async function login(gh: GhRun) { try { return (await gh(['api', 'user', '--jq', '.login'])).trim(); } catch { return ''; } }

/**
 * Find the GitHub repository for Cloud work. `query` is "owner/repo", a GitHub URL, or a name to fuzzy-match against every
 * repository the signed-in GitHub user can reach. Never consults the local disk.
 */
export async function resolveCloudRepo(query: string | null | undefined, gh: GhRun = runGh): Promise<CloudResolution> {
  let status = '';
  try { status = await gh(['auth', 'status', '--hostname', 'github.com']); }
  catch (error: any) {
    if (error?.code === 'ENOENT') return blocked('gh-missing', 'The GitHub CLI (gh) is not installed, so Marion cannot look up your GitHub repositories.',
      'Install it right here, then sign in to GitHub; Marion then finds the repository and starts the Cloud session.',
      [{ id: 'gh-install', kind: 'gh-install', label: 'Install GitHub CLI', hint: 'Runs brew install gh on this Mac' }, LOGIN, RETRY]);
    return blocked('gh-auth', `GitHub CLI is not signed in (${short(error)}).`,
      'Sign in to GitHub from this card; Marion shows the one-time code here and continues in the Cloud once you finish.', [LOGIN, RETRY]);
  }
  const scopes = tokenScopes(status);
  const missing = scopes && scopes.length ? GH_SCOPES.filter(scope => !scopes.includes(scope)) : [];
  if (missing.length) return blocked('gh-scopes', `Your GitHub CLI token is missing the ${missing.join(' and ')} scope${missing.length > 1 ? 's' : ''} needed to reach private and organization repositories.`,
    'Grant the missing scopes from this card (one-time code shown here); Marion then retries automatically.',
    [{ id: 'gh-scopes', kind: 'gh-scopes', label: `Grant ${missing.join(', ')} access`, hint: 'Runs gh auth refresh' }, RETRY]);

  const wanted = (query ?? '').trim();
  const exact = exactRepo(wanted);
  if (exact) {
    const repo = await viewRepo(gh, exact);
    if (repo && repo.canPush) return { ok: true, repo };
    if (repo) return blocked('no-access', `You can read ${repo.nameWithOwner} but cannot push to it, so a Cloud session could not save its branch or pull request.`,
      'Fork it to your account and work there, or ask the owner for write access and check again.',
      [{ id: 'fork:' + repo.nameWithOwner, kind: 'fork', repo: repo.nameWithOwner, label: `Fork ${repo.nameWithOwner} and start`, hint: 'Runs gh repo fork' }, RETRY]);
  }
  let repos: CloudRepo[];
  try { repos = await myRepos(gh); }
  catch (error) {
    return blocked('gh-auth', `GitHub did not list your repositories (${short(error)}).`, 'Sign in to GitHub again from this card, then Marion retries.', [LOGIN, RETRY]);
  }
  const name = exact ? exact.split('/')[1] : wanted;
  const matches = name ? matchRepos(repos, exact ?? name) : [];
  const fallback = exact && !matches.length ? matchRepos(repos, name) : matches;
  if (fallback.length === 1 && fallback[0].canPush !== false) return { ok: true, repo: fallback[0] };
  if (fallback.length === 1) return blocked('no-access', `You can read ${fallback[0].nameWithOwner} but cannot push to it.`,
    'Fork it to your account and start the Cloud session there, or get write access and check again.',
    [{ id: 'fork:' + fallback[0].nameWithOwner, kind: 'fork', repo: fallback[0].nameWithOwner, label: `Fork ${fallback[0].nameWithOwner} and start`, hint: 'Runs gh repo fork' }, RETRY]);
  if (fallback.length > 1) {
    const top = fallback.slice(0, 6);
    return blocked('ambiguous', `${fallback.length} of your GitHub repositories match “${wanted}”.`, 'Pick the one to work on; the Cloud session starts right away.',
      top.map(repo => repoOption(repo, repo.canPush === false ? 'Read-only: Marion will offer a fork' : undefined)), top);
  }
  const user = await login(gh);
  const slug = (exact ? name : wanted).trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
  const owner = exact ? exact.split('/')[0] : user;
  const recent = repos.filter(repo => repo.canPush !== false).slice(0, 4);
  const create: CloudOption[] = slug && owner ? [{ id: 'create:' + owner + '/' + slug, kind: 'create-repo', repo: `${owner}/${slug}`,
    label: `Create private ${owner}/${slug} and start`, hint: 'Runs gh repo create --private' }] : [];
  return blocked('not-found', wanted ? `No GitHub repository you can reach matches “${wanted}”.` : 'The request does not say which GitHub repository to work on.',
    wanted ? 'Pick one of your recent repositories, create it on GitHub, or grant access and check again.' : 'Pick the repository for this Cloud session.',
    [...recent.map(repo => repoOption(repo)), ...create, RETRY], recent);
}

/** Run gh without prompts; resolves stdout+stderr (gh auth status prints to either, by version). */
export const runGh: GhRun = (args) => new Promise((resolve, reject) => {
  const env = cliEnvironment();
  env.PATH = [env.PATH, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':');
  const child = spawn('gh', args, { env: { ...env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_HOST: 'github.com', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { if (stdout.length < 4_000_000) stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve((stdout + (args[0] === 'auth' ? '\n' + stderr : '')).trim())
    : reject(Object.assign(new Error(stderr.trim() || `gh exited with ${code}`), { stderr, code: undefined })));
});

/**
 * GitHub sign-in or scope grant started from an in-app card. gh's device flow prints a one-time code; it is passed to
 * `onCode` (the card shows it with the github.com/login/device link) and gh opens the browser after one Enter.
 */
export type DeviceAuth = (args: string[], onCode: (code: string, url: string) => void, signal?: AbortSignal) => Promise<void>;
export const ghDeviceAuth: DeviceAuth = (args, onCode, signal) => new Promise((resolve, reject) => {
  const env = cliEnvironment();
  env.PATH = [env.PATH, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':');
  const child = spawn('gh', args, { env: { ...env, GH_HOST: 'github.com', NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'], signal, timeout: 15 * 60_000 });
  let text = '';
  let shown = false;
  const read = (chunk: string) => {
    text = (text + chunk).slice(-8000);
    const code = /one-time code:\s*([A-Z\d]{4}-[A-Z\d]{4})/i.exec(text)?.[1];
    if (code && !shown) {
      shown = true;
      onCode(code, /https:\/\/github\.com\/login\/device\S*/.exec(text)?.[0] ?? 'https://github.com/login/device');
      child.stdin.write('\n');
    }
  };
  child.stdout.setEncoding('utf8').on('data', read);
  child.stderr.setEncoding('utf8').on('data', read);
  child.stdin.on('error', () => {});
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve() : reject(new Error(text.trim().split('\n').pop() || `gh exited with ${code}`)));
});

export const ghLoginArgs = () => ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--scopes', GH_SCOPES.join(',')];
export const ghScopeArgs = () => ['auth', 'refresh', '--hostname', 'github.com', '--scopes', GH_SCOPES.join(',')];
