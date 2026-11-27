import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Read-only view of the coding sessions on this Mac: Claude Code, Codex and Gemini (Antigravity).
 * Nothing here writes to those apps' files. Everything is best effort: a provider that isn't
 * installed, or whose storage format changed, simply contributes no sessions.
 */

export type SessionProvider = 'claude' | 'codex' | 'gemini';

export interface CodingSession {
  id: string;
  provider: SessionProvider;
  title: string;
  project: string;
  path: string;
  updatedAt: number;
  active: boolean;
  steps?: number;
}

export interface SessionMessage { role: 'user' | 'assistant'; text: string; at?: number }

const HOME = process.env.MARION_SESSIONS_HOME || os.homedir();
const ACTIVE_MS = 3 * 60_000;
const LIMIT = 60;

const clean = (text: string, max = 140) => text
  .replace(/<[^>]{1,60}>[\s\S]*?<\/[^>]{1,60}>/g, ' ')
  .replace(/^#+\s.*$/gm, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

const projectName = (dir: string) => {
  if (!dir) return '';
  const base = path.basename(dir.replace(/\/+$/, ''));
  return base || dir;
};

/** Codex stores the request after "## My request:" when files were attached. */
const userRequest = (text: string) => {
  const marker = text.lastIndexOf('## My request:');
  return marker >= 0 ? text.slice(marker + 14) : text;
};

function readHead(file: string, bytes = 96 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString('utf8');
  } finally { fs.closeSync(fd); }
}

function readTail(file: string, bytes = 256 * 1024) {
  const { size } = fs.statSync(file);
  const start = Math.max(0, size - bytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally { fs.closeSync(fd); }
}

const jsonLines = (text: string) => text.split('\n').flatMap(line => {
  if (!line.trim()) return [];
  try { return [JSON.parse(line)]; } catch { return []; }
});

/** Text of a Claude/Codex message content field, ignoring tool calls, tool results and images. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (!part || typeof part !== 'object') return '';
    const p = part as { type?: string; text?: string };
    return p.type === 'text' || p.type === 'input_text' || p.type === 'output_text' ? p.text ?? '' : '';
  }).join(' ');
}

const isNoise = (text: string) => !text.trim()
  || /^<(command-|local-command|system-reminder|user-prompt-submit-hook)/.test(text.trim())
  || text.startsWith('Caveat:') || text.includes('<environment_context>');

// ---------- Claude Code: ~/.claude/projects/<project>/<session>.jsonl ----------

/** Marion's own relayed runs work in temporary provider folders; they are not your sessions. */
const MARION_TEMP = /marion-provider-|\/T\/marion-|marion-usage-probe/;
/** Project folder names encode the session's cwd with "/" (and other symbols) turned into "-". */
const MARION_TEMP_DIR = /-T-marion-provider-|-T-marion-|marion-usage-probe/;
const CLAUDE_APP_LIMIT = 150;

/** Title and working folder of one Claude Code transcript. */
function claudeTranscriptInfo(file: string) {
  // The app keeps re-saving a "custom-title" record; the newest one is near the end of the file.
  let title = '';
  let cwd = '';
  for (const line of jsonLines(readTail(file, 192 * 1024)).reverse()) {
    if (!title && line.type === 'custom-title' && typeof line.customTitle === 'string') title = line.customTitle;
    if (!cwd && typeof line.cwd === 'string') cwd = line.cwd;
    if (title && cwd) break;
  }
  // Otherwise use the first thing you asked. Pasted images can make that line huge, so read further in steps.
  for (const bytes of [96 * 1024, 1024 * 1024, 6 * 1024 * 1024]) {
    if (title && cwd) break;
    for (const line of jsonLines(readHead(file, bytes))) {
      if (!cwd && typeof line.cwd === 'string') cwd = line.cwd;
      if (!title && line.type === 'user' && !line.isMeta && !line.isSidechain) {
        const text = contentText(line.message?.content);
        if (!isNoise(text)) title = clean(text);
      }
      if (title && cwd) break;
    }
    if (fs.statSync(file).size <= bytes) break;
  }
  return { title, cwd };
}

interface ClaudeAppSession { cliId: string; title: string; cwd: string; activityAt: number; archived: boolean }
const appIndexCache = new Map<string, { mtime: number; session: ClaudeAppSession | null }>();

/**
 * The Claude app's own list of Code sessions (Library/Application Support/Claude/claude-code-sessions/<account>/<org>/local_*.json):
 * the sessions you see in the app, with the titles you gave them and whether you archived them. Each points at its
 * transcript in ~/.claude/projects by `cliSessionId`.
 */
function claudeAppSessions(): ClaudeAppSession[] {
  const root = path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
  const out: ClaudeAppSession[] = [];
  const seen = new Set<string>();
  let accounts: string[] = [];
  try { accounts = fs.readdirSync(root); } catch { return out; }
  for (const account of accounts) {
    let orgs: string[] = [];
    try { orgs = fs.readdirSync(path.join(root, account)); } catch { continue; }
    for (const org of orgs) {
      let names: string[] = [];
      try { names = fs.readdirSync(path.join(root, account, org)); } catch { continue; }
      for (const name of names) {
        if (!/^local_[\w-]+\.json$/.test(name)) continue;
        const file = path.join(root, account, org, name);
        seen.add(file);
        try {
          const mtime = fs.statSync(file).mtimeMs;
          let cached = appIndexCache.get(file);
          if (!cached || cached.mtime !== mtime) {
            const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
            const cliId = typeof raw.cliSessionId === 'string' ? raw.cliSessionId : '';
            const cwd = typeof raw.cwd === 'string' ? raw.cwd : typeof raw.originCwd === 'string' ? raw.originCwd : '';
            const activityAt = Number(raw.lastActivityAt ?? raw.lastTurnEdgeAt ?? raw.createdAt) || 0;
            cached = { mtime, session: cliId ? { cliId, cwd, activityAt, archived: raw.isArchived === true, title: typeof raw.title === 'string' ? clean(raw.title) : '' } : null };
            appIndexCache.set(file, cached);
          }
          if (cached.session) out.push(cached.session);
        } catch { /* being rewritten; next poll */ }
      }
    }
  }
  for (const file of appIndexCache.keys()) if (!seen.has(file)) appIndexCache.delete(file);
  return out;
}

/**
 * Claude Code sessions: every session listed in the Claude app (unless archived there), plus the newest other transcripts
 * (CLI and headless runs). Marion's own relayed runs are skipped before the cap, so they never crowd your sessions out.
 */
function claudeSessions(): CodingSession[] {
  const root = path.join(HOME, '.claude', 'projects');
  const transcripts = new Map<string, { file: string; mtime: number }>();
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(root); } catch { /* no CLI transcripts; the app index may still list sessions */ }
  for (const dir of dirs) {
    if (MARION_TEMP_DIR.test(dir)) continue;
    const full = path.join(root, dir);
    let entries: string[] = [];
    try { entries = fs.readdirSync(full); } catch { continue; }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(full, name);
      try { transcripts.set(path.basename(name, '.jsonl'), { file, mtime: fs.statSync(file).mtimeMs }); } catch { /* removed meanwhile */ }
    }
  }
  const app = claudeAppSessions();
  const archived = new Set(app.filter(s => s.archived).map(s => s.cliId));
  const out: CodingSession[] = [];
  const listed = new Set<string>();
  const add = (id: string, title: string, cwd: string, updatedAt: number, activeAt: number) => {
    if (!title || listed.has(id) || MARION_TEMP.test(cwd)) return;
    listed.add(id);
    out.push({
      id: `claude:${id}`, provider: 'claude', title, path: cwd,
      project: projectName(cwd), updatedAt: Math.round(updatedAt), active: Date.now() - activeAt < ACTIVE_MS,
    });
  };
  const appSessions = app.filter(s => !s.archived)
    .map(s => ({ ...s, transcript: transcripts.get(s.cliId) }))
    .sort((a, b) => Math.max(b.activityAt, b.transcript?.mtime ?? 0) - Math.max(a.activityAt, a.transcript?.mtime ?? 0))
    .slice(0, CLAUDE_APP_LIMIT);
  for (const s of appSessions) {
    try {
      const info = s.transcript && (!s.title || !s.cwd) ? claudeTranscriptInfo(s.transcript.file) : null;
      const updatedAt = Math.max(s.activityAt, s.transcript?.mtime ?? 0);
      add(s.cliId, s.title || info?.title || 'Untitled session', s.cwd || info?.cwd || '', updatedAt, s.transcript?.mtime ?? s.activityAt);
    } catch { /* unreadable transcript */ }
  }
  const rest = [...transcripts].filter(([id]) => !listed.has(id) && !archived.has(id))
    .sort((a, b) => b[1].mtime - a[1].mtime).slice(0, LIMIT);
  for (const [id, { file, mtime }] of rest) {
    try {
      const { title, cwd } = claudeTranscriptInfo(file);
      add(id, title, cwd, mtime, mtime);
    } catch { /* unreadable transcript */ }
  }
  return out;
}

// ---------- Codex: ~/.codex/state_5.sqlite (threads) + session_index.jsonl names ----------

function codexStateFile() {
  const dir = path.join(HOME, '.codex');
  try {
    return fs.readdirSync(dir).filter(name => /^state_\d+\.sqlite$/.test(name))
      .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]))
      .map(name => path.join(dir, name))[0];
  } catch { return undefined; }
}

function codexNames() {
  const names = new Map<string, string>();
  try {
    for (const line of jsonLines(readTail(path.join(HOME, '.codex', 'session_index.jsonl'), 512 * 1024))) {
      if (typeof line.id === 'string' && typeof line.thread_name === 'string') names.set(line.id, line.thread_name);
    }
  } catch { /* names are optional */ }
  return names;
}

function codexSessions(): CodingSession[] {
  const file = codexStateFile();
  if (!file) return [];
  let state: Database.Database | undefined;
  try {
    state = new Database(file, { readonly: true, fileMustExist: true });
    state.pragma('busy_timeout = 400');
    const rows = state.prepare(`SELECT id, rollout_path, cwd, title, name, first_user_message, updated_at, updated_at_ms, source
      FROM threads WHERE archived=0 AND (thread_source IS NULL OR thread_source IN ('user', 'voice_chat')) AND source NOT LIKE '%subagent%'
      ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC LIMIT ?`).all(LIMIT) as Record<string, any>[];
    const names = codexNames();
    return rows.filter(row => !/marion-provider-/.test(String(row.cwd ?? ''))).map(row => {
      const updatedAt = Number(row.updated_at_ms ?? row.updated_at * 1000);
      const title = names.get(row.id) || row.name || clean(userRequest(String(row.first_user_message || row.title || ''))) || 'Untitled thread';
      return {
        id: `codex:${row.id}`, provider: 'codex' as const, title: clean(title), path: row.cwd ?? '',
        project: projectName(row.cwd ?? ''), updatedAt, active: Date.now() - updatedAt < ACTIVE_MS,
      };
    });
  } catch { return []; }
  finally { state?.close(); }
}

function codexRollout(id: string) {
  const file = codexStateFile();
  if (!file) return undefined;
  const state = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const row = state.prepare('SELECT rollout_path FROM threads WHERE id=?').get(id) as { rollout_path: string } | undefined;
    return row?.rollout_path;
  } finally { state.close(); }
}

// ---------- Gemini (Antigravity app and CLI): conversation_summaries.db ----------

function geminiSessions(): CodingSession[] {
  const out: CodingSession[] = [];
  const seen = new Set<string>();
  for (const app of ['antigravity', 'antigravity-cli']) {
    const file = path.join(HOME, '.gemini', app, 'conversation_summaries.db');
    if (!fs.existsSync(file)) continue;
    let db: Database.Database | undefined;
    try {
      db = new Database(file, { readonly: true, fileMustExist: true });
      db.pragma('busy_timeout = 400');
      const rows = db.prepare(`SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, not_fully_idle
        FROM conversation_summaries WHERE nesting_depth=0 AND killed=0 ORDER BY last_modified_time DESC LIMIT ?`).all(LIMIT) as Record<string, any>[];
      for (const row of rows) {
        let workspace = '';
        try { workspace = decodeURIComponent(String((JSON.parse(row.workspace_uris) as string[])[0] ?? '').replace(/^file:\/\//, '')); } catch { /* none */ }
        // Marion's own background calls run in temporary provider folders; they are not your sessions.
        if (/marion-provider-|marion-usage-probe/.test(workspace) || seen.has(row.conversation_id)) continue;
        seen.add(row.conversation_id);
        const updatedAt = Date.parse(String(row.last_modified_time).replace(' ', 'T')) || 0;
        const title = clean(String(row.title || row.preview || ''));
        if (!title || /^@attachment/.test(title)) continue;
        out.push({
          id: `gemini:${row.conversation_id}`, provider: 'gemini', title, path: workspace, project: projectName(workspace),
          updatedAt, steps: Number(row.step_count) || undefined,
          active: Boolean(Number(row.not_fully_idle)) || (row.status && row.status !== 'CASCADE_RUN_STATUS_IDLE') || Date.now() - updatedAt < ACTIVE_MS,
        });
      }
    } catch { /* format changed or locked */ }
    finally { db?.close(); }
  }
  return out;
}

// ---------- running Claude Code processes ----------

/** Working folders of the Claude Code (`claude`) processes running on this Mac right now, one entry per process. */
export type ProcessProbe = () => string[];

function probeClaudeProcesses(): string[] {
  if (process.platform === 'win32') return [];
  try {
    const ps = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 2500, maxBuffer: 4 * 1024 * 1024 });
    const pids = ps.split('\n').flatMap(line => {
      const match = line.trim().match(/^(\d+)\s+(\S+)/);
      if (!match || Number(match[1]) === process.pid) return [];
      // The Claude Code CLI: `claude` (or .../claude), not helpers such as claude-code-guide or the desktop app's renderers.
      return /(^|\/)claude$/.test(match[2]) ? [match[1]] : [];
    });
    if (!pids.length) return [];
    const lsof = execFileSync('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')], { encoding: 'utf8', timeout: 2500, maxBuffer: 1024 * 1024 });
    return lsof.split('\n').filter(line => line.startsWith('n/')).map(line => line.slice(1));
  } catch { return []; }
}

let probe: ProcessProbe = probeClaudeProcesses;
/** Tests replace the process lookup so they never depend on what is running on the machine. */
export const setClaudeProcessProbe = (next: ProcessProbe | null) => { probe = next ?? probeClaudeProcesses; cache = undefined; };

/**
 * A Claude Code session is working when its transcript was written lately, or when a `claude` process is running in its
 * folder (a long tool call or a long think writes nothing for minutes). With N processes in one folder, the N newest
 * transcripts of that folder are the live ones.
 */
export function markRunningClaude(sessions: CodingSession[], folders: string[]): CodingSession[] {
  const live = new Map<string, number>();
  for (const folder of folders) live.set(folder, (live.get(folder) ?? 0) + 1);
  const claimed = new Map<string, number>();
  return sessions.map(session => {
    if (session.provider !== 'claude' || !session.path) return session;
    if (session.active) { // already shown as working: it is one of that folder's live processes
      if (live.has(session.path)) claimed.set(session.path, (claimed.get(session.path) ?? 0) + 1);
      return session;
    }
    const left = (live.get(session.path) ?? 0) - (claimed.get(session.path) ?? 0);
    if (left <= 0) return session;
    claimed.set(session.path, (claimed.get(session.path) ?? 0) + 1);
    return { ...session, active: true };
  });
}

const readers: Record<SessionProvider, () => CodingSession[]> = { claude: claudeSessions, codex: codexSessions, gemini: geminiSessions };

let cache: { at: number; sessions: CodingSession[] } | undefined;

export function listCodingSessions(provider?: SessionProvider): CodingSession[] {
  if (!cache || Date.now() - cache.at > 4000) {
    const all = (Object.keys(readers) as SessionProvider[]).flatMap(key => readers[key]());
    // Newest first, so a folder's live processes claim its newest transcripts.
    const sessions = markRunningClaude(all.sort((a, b) => b.updatedAt - a.updatedAt), probe());
    cache = { at: Date.now(), sessions: sessions.sort((a, b) => Number(b.active) - Number(a.active) || b.updatedAt - a.updatedAt) };
  }
  return provider ? cache.sessions.filter(s => s.provider === provider) : cache.sessions;
}

/** The last messages of a session, newest last. Gemini stores its turns in a binary format, so it has none. */
export function codingSessionMessages(id: string): SessionMessage[] {
  const [provider, rawId] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
  if (!/^[\w-]+$/.test(rawId)) return [];
  let file: string | undefined;
  if (provider === 'claude') {
    const root = path.join(HOME, '.claude', 'projects');
    for (const dir of fs.readdirSync(root)) {
      const candidate = path.join(root, dir, `${rawId}.jsonl`);
      if (fs.existsSync(candidate)) { file = candidate; break; }
    }
  } else if (provider === 'codex') {
    file = codexRollout(rawId);
  }
  if (!file || !fs.existsSync(file)) return [];
  const messages: SessionMessage[] = [];
  for (const line of jsonLines(readTail(file, 1536 * 1024))) {
    if (provider === 'claude') {
      if ((line.type !== 'user' && line.type !== 'assistant') || line.isMeta || line.isSidechain) continue;
      const text = contentText(line.message?.content);
      if (isNoise(text)) continue;
      messages.push({ role: line.type, text: text.trim().slice(0, 1200), at: Date.parse(line.timestamp) || undefined });
    } else {
      const item = line.payload;
      if (line.type !== 'response_item' || item?.type !== 'message' || (item.role !== 'user' && item.role !== 'assistant')) continue;
      const text = item.role === 'user' ? userRequest(contentText(item.content)) : contentText(item.content);
      if (isNoise(text)) continue;
      messages.push({ role: item.role, text: text.trim().slice(0, 1200), at: Date.parse(line.timestamp) || undefined });
    }
  }
  return messages.slice(-16);
}
