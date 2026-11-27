import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exactRepo, repoHint } from '../features/cloud-repo.js';
import { cliEnvironment } from './subscriptions.js';

/**
 * Public GitHub repositories for builders on every provider (Claude, Codex, Gemini, orchestrated and team workers).
 * Marion clones a named repository itself, once, into a scratch folder of its own before any builder starts, so every
 * provider gets the same ready checkout as its working folder: nothing depends on one CLI's sandbox reaching the network,
 * and no folder on this Mac needs to be shared. If the clone can't be made (private repository, offline), the builder is
 * told to clone it itself with the GitHub access it already has.
 */

export interface RepoFolder { path: string; label: string; write: boolean }
export interface RepoCheckout {
  repo: string;
  /** The scratch folder every builder works in (the checkout is inside it). */
  folder: RepoFolder;
  /** Full path of the cloned repository, or null when Marion couldn't clone it ahead. */
  checkout: string | null;
  /** One paragraph for the builder's task: where the repository is and how to use it. */
  note: string;
  cleanup: () => Promise<void>;
}

const CLONE_TIMEOUT_MS = 180_000;

/** "owner/repo" or a GitHub URL from a tool argument; anything else is refused with a clear message. */
export function githubRepoArg(value: unknown): string | null {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return null;
  const repo = exactRepo(value) ?? (typeof value === 'string' ? repoHint(value) : null);
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('Give the GitHub repository as owner/repo or a github.com URL.');
  }
  return repo;
}

/** An empty folder of Marion's own for a builder to clone a GitHub repository into; removed when the run ends. */
export async function repoScratch(repo: string): Promise<RepoFolder> {
  const path = await mkdtemp(join(tmpdir(), 'marion-repo-'));
  return { path, label: `GitHub ${repo}`, write: true };
}

/** Proxy and certificate settings, so the clone works on networks that need them (no credentials are passed). */
const proxyEnvironment = () => Object.fromEntries(['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy', 'SSL_CERT_FILE', 'GIT_SSL_CAINFO', 'GIT_CONFIG_PARAMETERS']
  .filter(key => process.env[key]).map(key => [key, process.env[key]]));

/** Shallow, anonymous clone of a public repository: no credential helper, no prompts, no tokens from the environment. */
function cloneRepo(repo: string, into: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'credential.helper=', '-c', 'core.askPass=', 'clone', '--depth', '1', '--quiet', '--', `https://github.com/${repo}.git`, into], {
      env: { ...cliEnvironment(), ...proxyEnvironment(), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' },
      timeout: CLONE_TIMEOUT_MS, signal, maxBuffer: 1024 * 1024,
    }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      const why = String(stderr || error.message).trim().split('\n').filter(Boolean).at(-1) ?? 'git clone failed';
      reject(new Error(why.slice(0, 300)));
    });
  });
}

/** The builder-facing paragraph for a repository; `checkout` null means the builder clones it itself. */
export function repoNote(repo: string, folderPath: string, checkout: string | null, failure?: string) {
  const url = `https://github.com/${repo}`;
  return checkout
    ? `GitHub repository: ${repo} (${url}). Marion already cloned it for you (shallow, default branch) at ${checkout}, inside your working folder ${folderPath}: work from that copy. Run git fetch --unshallow there if you need history, and never push unless the owner asked for it.`
    : `GitHub repository: ${repo} (${url}). ${failure ? `Marion could not clone it ahead (${failure}). ` : ''}Clone it into your working folder ${folderPath} (git clone --depth 1 ${url}.git is enough to read it) and work from that copy.`;
}

/**
 * A ready checkout of a GitHub repository in a fresh scratch folder, the same for every provider. Never throws for a
 * failed clone (the builder gets the clone instructions instead); throws only when the run was stopped.
 */
export async function prepareRepoCheckout(repo: string, signal?: AbortSignal): Promise<RepoCheckout> {
  const folder = await repoScratch(repo);
  const cleanup = () => rm(folder.path, { recursive: true, force: true }).catch(() => {});
  const target = join(folder.path, repo.split('/')[1].replace(/\.git$/i, '') || 'repo');
  try {
    await cloneRepo(repo, target, signal);
    return { repo, folder, checkout: target, note: repoNote(repo, folder.path, target), cleanup };
  } catch (error) {
    if (signal?.aborted) { await cleanup(); throw error; }
    await rm(target, { recursive: true, force: true }).catch(() => {});
    return { repo, folder, checkout: null, note: repoNote(repo, folder.path, null, (error as Error).message), cleanup };
  }
}
