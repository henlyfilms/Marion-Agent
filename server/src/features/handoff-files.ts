import { execFile } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const handoffIdPattern = /^[0-9a-f-]{36}$/;

export async function gitSnapshot(path: string) {
  const git = async (...args: string[]) => (await exec('git', ['--no-optional-locks', '-C', path, ...args],
    { timeout: 3500, maxBuffer: 256_000 })).stdout.trimEnd();
  try {
    const root = await git('rev-parse', '--show-toplevel');
    const [head, status] = await Promise.all([
      git('rev-parse', '--verify', 'HEAD').catch(() => null),
      git('status', '--porcelain=v1', '--branch', '--untracked-files=normal', '--', '.'),
    ]);
    return { root, head, status: status.slice(0, 24_000), truncated: status.length > 24_000 };
  } catch {
    return { unavailable: 'No Git state could be read for the selected folder.' };
  }
}

export async function writeHandoff(directory: string, id: string, record: object) {
  if (!handoffIdPattern.test(id)) throw new Error('Invalid handoff ID.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const dir = await realpath(directory);
  // A custom DB_PATH can point into a Git checkout. Never place a handoff in
  // such a checkout unless Git confirms that the entire directory is ignored.
  const git = (...args: string[]) => exec('git', ['-C', dir, ...args], { timeout: 3500 });
  const root = await git('rev-parse', '--show-toplevel').then(r => r.stdout.trim(), (error: any) => {
    if (/not a git repository/i.test(error.stderr ?? '')) return '';
    throw error;
  });
  if (root) {
    const sub = relative(root, dir);
    if (!sub || sub === '..' || sub.startsWith('..' + sep)) throw new Error('Handoff storage must be outside Git or ignored.');
    await exec('git', ['-C', root, 'check-ignore', '--', sub + '/'], { timeout: 3500 }).catch(() => {
      throw new Error('Handoff storage must be outside Git or ignored.');
    });
    // An ignore rule does not hide already tracked files. Never write into a tracked directory.
    const tracked = await exec('git', ['-C', root, 'ls-files', '--', sub + '/'], { timeout: 3500 });
    if (tracked.stdout.trim()) throw new Error('Handoff storage contains tracked files.');
  }
  const path = resolve(dir, id + '.json');
  await writeFile(path, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return path;
}
