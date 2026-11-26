import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * One relayed session at a time per project folder. Two Claude Code / Codex / Gemini runs (from different bots, or an
 * orchestrated team and a single ask) must never edit the same folder or its git state together, so the second one
 * waits its turn. Folders that contain each other count as the same place. Waiting is first come, first served.
 */
interface Waiter { path: string; grant: () => void }

const active = new Set<string>();
const waiters: Waiter[] = [];

const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

function pump() {
  for (let i = 0; i < waiters.length;) {
    const waiter = waiters[i];
    const blocked = [...active].some(path => overlaps(path, waiter.path)) || waiters.slice(0, i).some(earlier => overlaps(earlier.path, waiter.path));
    if (blocked) { i++; continue; }
    waiters.splice(i, 1);
    active.add(waiter.path);
    waiter.grant();
  }
}

/** Synchronous on purpose: the line forms in the order sessions ask, not in the order the disk answers. */
function canonical(path: string) {
  let full: string;
  try { full = realpathSync(path); } catch { full = resolve(path); }
  return full.length > 1 ? full.replace(/\/+$/, '') : full;
}

/** True when a session already holds this folder (or one inside / around it). */
export function folderInUse(path: string) {
  const key = canonical(path);
  return [...active].some(held => overlaps(held, key));
}

/**
 * Wait for the folder, then hold it until the returned function is called (call it exactly once, in a `finally`).
 * `onWait` runs once, only when the folder is busy, so the chat can say why nothing is happening yet.
 */
export async function acquireFolder(path: string, signal?: AbortSignal, onWait?: () => void): Promise<() => void> {
  const key = canonical(path);
  if (signal?.aborted) throw signal.reason ?? new Error('Stopped.');
  let waiter!: Waiter;
  const granted = new Promise<void>(grant => { waiter = { path: key, grant }; });
  const mustWait = [...active].some(held => overlaps(held, key)) || waiters.some(other => overlaps(other.path, key));
  waiters.push(waiter);
  if (mustWait) onWait?.();
  pump();
  if (signal) {
    await new Promise<void>((done, fail) => {
      const stop = () => {
        const at = waiters.indexOf(waiter);
        if (at < 0) return; // already granted; the caller still releases it
        waiters.splice(at, 1);
        fail(signal.reason ?? new Error('Stopped.'));
        pump();
      };
      signal.addEventListener('abort', stop, { once: true });
      granted.then(() => { signal.removeEventListener('abort', stop); done(); });
    });
  } else await granted;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active.delete(key);
    pump();
  };
}

/** Run `job` while holding the folder. A read-only task (no folder, or `write` false) doesn't wait. */
export async function withFolder<T>(folder: { path: string; write: boolean } | undefined, signal: AbortSignal | undefined, onWait: (() => void) | undefined, job: () => Promise<T>): Promise<T> {
  if (!folder?.write) return job();
  const release = await acquireFolder(folder.path, signal, onWait);
  try { return await job(); } finally { release(); }
}
