import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { db } from '../db.js';
import { appEnv } from '../env.js';
import { busyCount, installedBuild, installedIdentity } from '../lib/lifecycle.js';
import { fingerprint, pathspec } from '../lib/update-inputs.cjs';
import { getSetting, setSetting } from './schema.js';

/**
 * "Check for updates" for the Mac app. Marion Agent is built from a local Git checkout, so an
 * update is a change to the app inputs in that checkout compared to the installed build. Installing
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
  /** Settings → Updates → Auto-update. On unless the owner turned it off. */
  autoUpdate?: boolean;
}

// ---------- Auto-update setting ----------

export interface UpdateSettings { autoUpdate: boolean; lastAutoCommit: string | null; lastAutoAt: number }
/** Auto-update is ON by default: a saved value only exists once the owner has changed it. */
const UPDATE_DEFAULTS: UpdateSettings = { autoUpdate: true, lastAutoCommit: null, lastAutoAt: 0 };
export const updateSettings = (userId: string) => getSetting<UpdateSettings>(userId, 'app-update', UPDATE_DEFAULTS);
export const setAutoUpdate = (userId: string, on: boolean) => {
  const next = { ...updateSettings(userId), autoUpdate: on };
  setSetting(userId, 'app-update', next);
  return next;
};

function candidates() {
  const own = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  return appEnv('SOURCE_DIR') ? [appEnv('SOURCE_DIR')!] : [own, path.join(os.homedir(), 'Desktop', 'CODEX', 'Projects', 'Marion Agent')].filter(Boolean) as string[];
}

export function sourceDir() {
  return candidates().find(dir => fs.existsSync(path.join(dir, '.git')) && fs.existsSync(path.join(dir, 'scripts', 'package-distributions.sh')));
}

const stateFile = () => path.join(appEnv('APP_DATA') || os.tmpdir(), 'marion-update.json');

function installState(identity = installedIdentity(null)): UpdateStatus['install'] {
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as UpdateStatus['install'] & { target?: string };
    if (saved.state === 'installing' && saved.target && saved.target === identity) return { state: 'idle', message: 'Updated.', at: saved.at };
    // A build that has said nothing for 20 minutes died with the old app.
    if ((saved.state === 'building' || saved.state === 'installing') && Date.now() - saved.at > 20 * 60_000) return { state: 'idle', message: '', at: saved.at };
    return saved;
  } catch { return { state: 'idle', message: '', at: 0 }; }
}

const git = async (dir: string, ...args: string[]) => (await run('git', ['-C', dir, ...args], { timeout: 8000 })).stdout.trim();

export async function updateStatus(reported: string | null): Promise<UpdateStatus> {
  const identity = installedIdentity(reported);
  const current = installedBuild(reported, identity);
  const install = installState(identity);
  const dir = sourceDir();
  const base = { current, install, changes: [] as string[], behind: 0, dirty: false };
  if (!dir) return { ...base, supported: false, latest: null, reason: 'Updates need the Marion Agent source folder on this Mac.' };
  try {
    const latest = await git(dir, 'rev-parse', '--verify', 'HEAD');
    const dirty = Boolean(await git(dir, 'status', '--porcelain', '--untracked-files=no', '--', ...pathspec));
    if (!current || current === 'dev') return { ...base, supported: false, latest, dirty, reason: 'This build has no installed Git version to check.' };
    const stamped = identity?.split('.')[2];
    if (stamped ? stamped === fingerprint(dir, latest) : current === latest) {
      return { ...base, supported: true, latest, dirty };
    }
    const known = await git(dir, 'rev-parse', '--verify', `${current}^{commit}`).catch(() => null);
    if (!stamped && !known) {
      return { ...base, supported: false, latest, dirty, reason: 'The installed build is not in this checkout’s history.' };
    }
    if (!stamped && known && fingerprint(dir, known) === fingerprint(dir, latest)) {
      return { ...base, supported: true, latest, dirty };
    }
    // Compare pinned trees, not the moving HEAD. History is only used to describe an update.
    const range = known ? `${known}..${latest}` : null;
    const behind = range ? Math.max(1, Number(await git(dir, 'rev-list', '--count', range, '--', ...pathspec)) || 0) : 1;
    const listed = range ? (await git(dir, 'log', '--format=%s', '-6', range, '--', ...pathspec)).split('\n').filter(Boolean) : [];
    return { ...base, supported: true, latest, dirty, behind, changes: listed.length ? listed : ['A different app build is available.'] };
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
  const buildFile = appEnv('APP_BUILD_FILE');
  const data = appEnv('APP_DATA');
  if (!data || !buildFile || !appEnv('DESKTOP_TOKEN')) return { error: 'Install updates from the Mac app.' };
  const destination = path.resolve(path.dirname(buildFile), '../..');
  if (buildFile !== path.join(destination, 'Contents', 'Resources', 'BUILD_ID') || path.basename(destination) !== 'Marion Agent.app') {
    return { error: 'Could not identify the running Marion Agent app.' };
  }
  const state = stateFile();
  fs.writeFileSync(`${state}.new`, JSON.stringify({ state: 'building', message: 'Building the new version…', at: Date.now() }));
  fs.renameSync(`${state}.new`, state);
  const script = `
set -uo pipefail
state="$1"
source="$2"
apps="$3"
data="$4"
target=""
say() {
  printf '{"state":"%s","message":"%s","at":%s,"target":"%s"}' "$1" "$2" "$(($(date +%s)*1000))" "$target" > "$state.new"
  mv -f "$state.new" "$state"
}
cd "$source" || { say failed "Source folder missing."; exit 1; }
work="$(mktemp -d "$data/.marion-update.XXXXXXXX")" || { say failed "Could not prepare the update."; exit 1; }
trap 'rm -rf "$work"' EXIT
if ! ./scripts/package-distributions.sh --installer-output "$work/installer.zip" > "$state.log" 2>&1; then say failed "The build failed. See marion-update.json.log in App Data."; exit 1; fi
/usr/bin/unzip -q "$work/installer.zip" -d "$work" || { say failed "Could not open the new installer."; exit 1; }
target="$(cat "$work/Marion Agent Installer/payload/Resources/BUILD_ID")"
if [[ ! "$target" =~ ^[0-9a-f]{7,64}\\.[0-9a-z-]+\\.[0-9a-f]{64}$ ]]; then
  target=""
  say failed "The new installer is missing a valid build identity."
  exit 1
fi
say installing "Getting the new version ready… Marion Agent restarts by itself when it’s done."
if "$work/Marion Agent Installer/Install Marion Agent.command" --replace-running --app-dir "$apps" >> "$state.log" 2>&1; then
  say idle "Updated."
else
  say failed "The install stopped. See marion-update.json.log in App Data."
fi
`;
  const child = spawn('/bin/bash', ['-c', script, 'marion-update', state, dir, path.dirname(destination), data], { detached: true, stdio: 'ignore', env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}` } });
  child.on('error', () => {
    fs.writeFileSync(`${state}.new`, JSON.stringify({ state: 'failed', message: 'Could not start the installer.', at: Date.now() }));
    fs.renameSync(`${state}.new`, state);
  });
  child.unref();
  return { ok: true };
}

// ---------- Auto-update ----------

const QUIET_MS = 5 * 60_000;
const RETRY_MS = 6 * 3600_000;
const CHECK_MS = 30 * 60_000;

export type AutoUpdateOutcome = 'started' | 'off' | 'not-the-app' | 'unsupported' | 'current' | 'dirty' | 'installing' | 'busy' | 'recently-active' | 'retry-later';

/**
 * One auto-update check. It only installs when the owner has Auto-update on, a newer clean commit exists, no update
 * is already running, no bot or relay is working, and nobody has chatted for a few minutes. Installing keeps bots
 * and relayed assistants running: the app restarts onto the same background server, which is swapped for the
 * new build only once it is idle (see the Mac app's server-host.cjs).
 */
export async function autoUpdateTick(deps: { busy?: () => number; start?: typeof startUpdate; at?: number } = {}): Promise<AutoUpdateOutcome> {
  const at = deps.at ?? Date.now();
  const build = installedBuild(null);
  if (!appEnv('DESKTOP_TOKEN') || !build || !/^[0-9a-f]{7,64}$/.test(build)) return 'not-the-app';
  const owner = (db.prepare('SELECT user_id FROM desktop_workspace WHERE slot=1').get() as { user_id: string } | undefined)?.user_id
    ?? (db.prepare('SELECT id FROM users ORDER BY created_at LIMIT 1').get() as { id: string } | undefined)?.id;
  if (!owner) return 'not-the-app';
  const settings = updateSettings(owner);
  if (!settings.autoUpdate) return 'off';
  const status = await updateStatus(null);
  if (!status.supported) return 'unsupported';
  if (status.behind <= 0) return 'current';
  if (status.dirty) return 'dirty';
  if (status.install.state === 'building' || status.install.state === 'installing') return 'installing';
  if ((deps.busy ?? busyCount)() > 0) return 'busy';
  const last = (db.prepare("SELECT MAX(r.created_at) at FROM rows r JOIN bots b ON b.id=r.bot_id WHERE b.user_id=? AND r.kind='message'").get(owner) as { at: number | null }).at ?? 0;
  if (at - last < QUIET_MS) return 'recently-active';
  if (settings.lastAutoCommit === status.latest && at - settings.lastAutoAt < RETRY_MS) return 'retry-later';
  setSetting(owner, 'app-update', { ...settings, lastAutoCommit: status.latest, lastAutoAt: at });
  const result = (deps.start ?? startUpdate)();
  return 'error' in result ? 'installing' : 'started';
}

export function startAutoUpdate() {
  if (!appEnv('DESKTOP_TOKEN') || !appEnv('APP_BUILD_FILE') || process.platform !== 'darwin') return;
  const tick = () => { void autoUpdateTick().catch(error => console.warn('[auto-update]', (error as Error).message)); };
  setTimeout(tick, 3 * 60_000).unref();
  setInterval(tick, CHECK_MS).unref();
}
