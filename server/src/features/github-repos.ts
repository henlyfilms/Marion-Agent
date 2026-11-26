import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cliEnvironment } from '../agent/subscriptions.js';
import { withFolder } from '../agent/folder-lock.js';
import { checkFolder } from './folders.js';

type RepoSpec = { name: string; description: string; visibility: 'public' | 'private'; folder?: string };

export function repoSpec(input: unknown): RepoSpec {
  const body = input as Record<string, unknown> | null;
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const [owner, repo, extra] = name.includes('/') ? name.split('/') : ['', name, undefined];
  if (!repo || !/^[a-z\d._][a-z\d._-]{0,99}$/i.test(repo) || /^(?:\.|\.\.|\.git)$/i.test(repo)
    || extra !== undefined || (name.includes('/') && !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(owner))) {
    throw new Error('Enter a GitHub repository name or owner/name.');
  }
  if (body?.visibility !== 'public' && body?.visibility !== 'private') throw new Error('Choose Public or Private.');
  const description = body.description ?? '';
  if (typeof description !== 'string' || description.length > 350 || description.includes('\0'))
    throw new Error('Enter a description of up to 350 characters.');
  if (body.folder != null && (typeof body.folder !== 'string' || !body.folder.trim() || body.folder.includes('\0')))
    throw new Error('Choose a local folder to push.');
  if (body.folder && body.confirmPush !== true) throw new Error('Confirm that you reviewed the files and history before pushing.');
  return { name, visibility: body.visibility, description: description.trim(), folder: body.folder as string | undefined };
}

export function repoCreateArgs(spec: RepoSpec) {
  return ['repo', 'create', spec.name, '--' + spec.visibility, ...(spec.description ? ['--description=' + spec.description] : [])];
}

const exec = promisify(execFile);
type Run = (cmd: 'git' | 'gh', args: string[], cwd?: string) => Promise<string>;
const runCommand: Run = async (program, args, cwd) => {
  const env = cliEnvironment();
  env.PATH = [env.PATH, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':');
  const { stdout } = await exec(program, args, { cwd, timeout: 120_000, maxBuffer: 1_048_576,
    env: { ...env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_HOST: 'github.com' } });
  return stdout.trim();
};

const detail = (error: any) => String(error.stderr?.trim() || error.message || error).slice(0, 600);
const missingSecret = (path: string) => path.split('/').some(file =>
  /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.git-credentials|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12))$/i.test(file)
  && !/^\.env\.(?:example|sample|template)$/i.test(file));

export async function createGitHubRepo(input: unknown, run: Run = runCommand, resolveFolder = checkFolder) {
  const spec = repoSpec(input);
  try { await run('gh', ['auth', 'status', '--hostname', 'github.com']); }
  catch (error: any) {
    if (error.code === 'ENOENT') throw new Error('GitHub CLI (gh) is not installed. Install it, then run gh auth login.');
    throw new Error(`GitHub authentication unavailable. Check gh auth status or run gh auth login. ${detail(error)}`);
  }
  const cwd = spec.folder ? await resolveFolder(spec.folder) : undefined;
  return withFolder(cwd ? { path: cwd, write: true } : undefined, undefined, undefined, async () => {
    const git = (...args: string[]) => run('git', args, cwd);
    let branch = '';
    let remote = 'origin';
    if (cwd) {
      let root = '';
      try { root = await git('rev-parse', '--show-toplevel'); }
      catch (error) { if (!/not a git repository/i.test(detail(error))) throw error; }
      if (root && root !== cwd) throw new Error('Choose the root of the Git repository, not a folder inside it.');
      if (!root) await git('init', '-b', 'main');
      const hasHead = await git('rev-parse', '--verify', 'HEAD').then(() => true, () => false);
      if (!hasHead) {
        if (await git('ls-files')) throw new Error('This repository has staged files. Review them and make the initial commit before publishing.');
        // Review the prospective file set before staging or creating a remote.
        const files = (await git('ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(Boolean);
        if (!files.length) throw new Error('There are no files to publish. Add files and make an initial commit.');
        if (files.some(missingSecret)) throw new Error('Potential credentials found. Add them to .gitignore, review the files, then make the initial commit yourself.');
        await git('add', '--all', '--', '.');
        await git('commit', '-m', 'Initial commit');
      }
      branch = await git('branch', '--show-current');
      if (!branch) throw new Error('Check out a local branch before publishing.');
      if ((await git('status', '--porcelain')).length) throw new Error('Commit or set aside local changes before publishing; only committed history is pushed.');
      const remotes = new Set((await git('remote')).split(/\s+/));
      if (remotes.has(remote)) {
        remote = 'marion-github';
        for (let counter = 2; remotes.has(remote); counter++) remote = 'marion-github-' + counter;
      }
    }
    let output: string;
    try { output = await run('gh', repoCreateArgs(spec), cwd); }
    catch (error) { throw new Error(`GitHub could not create the repository: ${detail(error)}`); }
    const url = /^https:\/\/github\.com\/[\w-]+\/[\w.-]+$/im.exec(output)?.[0];
    if (!url) throw new Error('GitHub CLI reported success but returned no GitHub URL. Check GitHub before trying again.');
    if (!cwd) return { url, pushed: false };
    try {
      await git('remote', 'add', remote, url + '.git');
      await git('-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', ...(remote === 'origin' ? ['-u'] : []), remote, 'HEAD:refs/heads/' + branch);
      return { url, pushed: true };
    } catch (error) {
      return { url, pushed: false, warning: `The repository was created, but the local push did not finish. Check the ${remote} remote and retry the push from Terminal. ${detail(error)}` };
    }
  });
}
