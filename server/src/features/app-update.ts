import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { appEnv } from '../env.js';

/**
 * "Check for updates" for the Mac app. Marion Agent is built from a local Git checkout, so an
 * update is simply newer commits in that checkout than the build that is running. Installing
 * runs the normal packaging script and installer in a detached process that survives the app
 * quitting, then reopens the new app.
 */

const run = promisify(execFile);

export interface UpdateStatus {
  supported: boolean;
  current: string | null;
  latest: string | null;
  behind: number;
  changes: string[];
  dirty: boolean;
  install: { state: 'idle' | 'building' | 'installing' | 'failed'; message: string; at: number };
  reason?: string;
}

function candidates() {
  const own = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  return [appEnv('SOURCE_DIR'), own, path.join(os.homedir(), 'Desktop', 'CODEX', 'Projects', 'Marion Agent')].filter(Boolean) as string[];
}

export function sourceDir() {
  return candidates().find(dir => fs.existsSync(path.join(dir, '.git')) && fs.existsSync(path.join(dir, 'scripts', 'package-distributions.sh')));
}

const stateFile = () => path.join(appEnv('APP_DATA') || os.tmpdir(), 'marion-update.json');

function installState(): UpdateStatus['install'] {
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as UpdateStatus['install'];
    // A build that has said nothing for 20 minutes died with the old app.
    if ((saved.state === 'building' || saved.state === 'installing') && Date.now() - saved.at > 20 * 60_000) return { state: 'idle', message: '', at: saved.at };
    return saved;
  } catch { return { state: 'idle', message: '', at: 0 }; }
}

const git = async (dir: string, ...args: string[]) => (await run('git', ['-C', dir, ...args], { timeout: 8000 })).stdout.trim();

export async function updateStatus(current: string | null): Promise<UpdateStatus> {
  const install = installState();
  const dir = sourceDir();
  const base = { current, install, changes: [] as string[], behind: 0, dirty: false };
  if (!dir) return { ...base, supported: false, latest: null, reason: 'Updates need the Marion Agent source folder on this Mac.' };
  try {
    const latest = await git(dir, 'rev-parse', '--short=7', 'HEAD');
    const dirty = (await git(dir, 'status', '--porcelain', '--untracked-files=no')).length > 0;
    if (!current || current === 'dev') return { ...base, supported: true, latest, dirty };
    const known = await git(dir, 'cat-file', '-e', `${current}^{commit}`).then(() => true, () => false);
    if (!known) return { ...base, supported: true, latest, dirty, behind: 1, changes: ['A newer build is available.'] };
    const behind = Number(await git(dir, 'rev-list', '--count', `${current}..HEAD`)) || 0;
    const changes = behind ? (await git(dir, 'log', '--format=%s', '-6', `${current}..HEAD`)).split('\n').filter(Boolean) : [];
    return { ...base, supported: true, latest, dirty, behind, changes };
  } catch {
    return { ...base, supported: false, latest: null, reason: 'Couldn’t read the source folder.' };
  }
}

/** Builds the installer from the source folder, quits the app, installs, and reopens it. */
export function startUpdate(): { ok: true } | { error: string } {
  const dir = sourceDir();
  if (!dir) return { error: 'The Marion Agent source folder wasn’t found.' };
  if (process.platform !== 'darwin') return { error: 'Updating from the app works on macOS.' };
  const current = installState();
  if (current.state === 'building' || current.state === 'installing') return { error: 'An update is already being prepared.' };
  const state = stateFile();
  const write = (s: UpdateStatus['install']) => fs.writeFileSync(state, JSON.stringify(s));
  write({ state: 'building', message: 'Building the new version…', at: Date.now() });
  const script = `
set -uo pipefail
state=${JSON.stringify(state)}
say() { printf '{"state":"%s","message":"%s","at":%s}' "$1" "$2" "$(($(date +%s)*1000))" > "$state"; }
cd ${JSON.stringify(dir)} || { say failed "Source folder missing."; exit 1; }
if ! ./scripts/package-distributions.sh > "$state.log" 2>&1; then say failed "The build failed. Details: $state.log"; exit 1; fi
work="$(mktemp -d)"
/usr/bin/unzip -q releases/Marion-Agent-Mac-Installer.zip -d "$work" || { say failed "Couldn't open the new installer."; exit 1; }
say installing "Getting the new version ready… Marion Agent restarts by itself when it’s done."
if "$work/Marion Agent Installer/Install Marion Agent.command" --replace-running >> "$state.log" 2>&1; then say idle "Updated."; else say failed "The install stopped, so the current version was kept. Details: $state.log"; fi
# Whatever happened, never leave the owner without the app.
sleep 2
/bin/ps -axo comm= | /usr/bin/grep -q "Marion Agent.app/Contents/MacOS/Electron" || /usr/bin/open -b com.henlyfilms.marion-agent || /usr/bin/open -a "Marion Agent" || true
rm -rf "$work"
`;
  const child = spawn('/bin/bash', ['-c', script], { detached: true, stdio: 'ignore', env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}` } });
  child.unref();
  return { ok: true };
}
