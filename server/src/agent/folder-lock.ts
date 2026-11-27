import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Which project folders relayed sessions (Claude Code / Codex / Gemini runs, orchestrated teams, single asks) are working
 * in right now. This is a registry, not a lock: any number of sessions — from one bot or many, on the same provider or
 * not, in the same folder or not — run at the same time and nothing ever waits for another session to finish.
 * Each hold is its own token, so concurrent holders of one folder never release each other's hold.
 * Folders that contain each other count as the same place.
 */

/** Every live hold: a unique token per session, mapped to the canonical folder it works in. */
const holds = new Map<symbol, string>();

const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/** Synchronous on purpose: a hold is registered in the order sessions start, not in the order the disk answers. */
function canonical(path: string) {
  let full: string;
  try { full = realpathSync(path); } catch { full = resolve(path); }
  return full.length > 1 ? full.replace(/\/+$/, '') : full;
}

/** How many sessions currently work in this folder (or one inside / around it). */
export function sessionsInFolder(path: string) {
  const key = canonical(path);
  let count = 0;
  for (const held of holds.values()) if (overlaps(held, key)) count++;
  return count;
}

/** True when a session already works in this folder (or one inside / around it). */
export const folderInUse = (path: string) => sessionsInFolder(path) > 0;

/**
 * Register a session in the folder and return the function that ends the hold (safe to call more than once).
 * Never waits: `onShared` runs once, before the session starts, with how many other sessions already work there, so the
 * chat can say that it runs alongside them.
 */
export async function acquireFolder(path: string, signal?: AbortSignal, onShared?: (others: number) => void): Promise<() => void> {
  if (signal?.aborted) throw signal.reason ?? new Error('Stopped.');
  const key = canonical(path);
  const others = sessionsInFolder(key);
  const token = Symbol(key);
  holds.set(token, key);
  if (others) {
    try { onShared?.(others); } catch { /* a status note must never stop the session */ }
  }
  return () => { holds.delete(token); };
}

/** Run `job` while registered in the folder. A read-only task (no folder, or `write` false) is not registered. */
export async function withFolder<T>(folder: { path: string; write: boolean } | undefined, signal: AbortSignal | undefined, onShared: ((others: number) => void) | undefined, job: () => Promise<T>): Promise<T> {
  if (!folder?.write) return job();
  const release = await acquireFolder(folder.path, signal, onShared);
  try { return await job(); } finally { release(); }
}
