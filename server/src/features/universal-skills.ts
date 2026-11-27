import { db, now } from '../db.js';
import '../db-config.js';
import { hub } from '../lib/hub.js';
import { newId } from '../lib/ids.js';
import type { UniversalSkill } from '../types.js';

/**
 * Universal skills: playbooks that belong to the user's whole team instead of one Bot.
 * They are injected into every Bot's prompt (existing and future), so editing one here
 * changes it for everybody. There is one row per user and name, never a copy per Bot.
 */

export const MAX_UNIVERSAL_SKILLS = 30;
export const MAX_UNIVERSAL_BODY = 12_000;

export const TOKEN_OPTIMIZER_BODY = 'Reuse verified results, read only what the task needs, and batch independent work. Keep handoffs and tool output short. Verify the outcome and report it once. Save durable corrections as a short lesson or revise the existing playbook.';

const GUIDE_BODY = `Marion Agent is a team of Bots. Each Bot has its own chat, memories, skills, routines and a private Linux desktop that only it uses.
- Computer: computer_* tools, open_browser and shell work on your own desktop. Take a screenshot before clicking and check it after. Save finished deliverables with save_file so they appear in the user's Library.
- Apps: prefer connected apps (Composio) over the browser. If an app is not connected, call request_app_connection.
- Team: list_team shows the other Bots, their jobs and live status; name a Bot in messages_from only to read its latest message. Delegate with send_to_bot when another Bot's job fits better; the reply comes back as a message, so end your turn. Share images by adding attach to send_to_bot or post_to_group: ["user_images"] forwards the images on the message you are handling (including ones another Bot sent you), ["screenshot"] sends a fresh screenshot of your computer, or give an image path under /workspace/files/<your id>/ (PNG, JPEG, WebP or GIF, up to 4 MB each). Use Team tools (team_models, team_setup, team_delegate, team_discuss) for multi-model orchestration.
- Parallel work: there is no limit on concurrency. spawn_subagent starts as many helpers (each with its own computer) as the work needs, all at once. ask_subscription, orchestrate, team_delegate and team_discuss sessions also run side by side, even on the same provider or folder (give sessions in one folder separate files or tasks). You keep answering the user and other Bots while long work runs.
- Memory: remember stores durable facts about the user. Universal memories are shared by every Bot (Bot settings > Memories, or remember with universal: true); recall searches both. Lessons and corrections become skills.
- Skills: a per-Bot skill is private to one Bot. A universal skill applies to every Bot on the team and is edited in one place (Bot settings > Skills > Universal skills, or save_skill with universal: true). Prefer updating an existing skill over making a near-duplicate.
- Work tracking: create_task for multi-part requests (bot_name assigns another Bot; a repeat returns the open task), update_task only claims a change on ok: true, create_routine for scheduled work, ask_user only for real decisions. Some actions need the user's approval; if one is denied, do not retry it.
- Never claim something is done unless a tool result shows it.`;

export const PROMPT_ENGINEERING_BODY = `Goal: a prompt another AI can follow on the first try, with the user's exact intent kept and no filler.
Modes: (1) Upgrade: the user gives a rough prompt. (2) Create: the user gives a goal. Either way, return one ready-to-use prompt in a code block.
Workflow:
1. Find the real goal, the audience or reader, and the deliverable. Never add goals, tools or facts the user did not imply; mark unknowns as [placeholders] instead of inventing them.
2. If one critical detail is missing and cannot be reasonably assumed, ask at most 2 short questions. Otherwise write the prompt now.
3. Add a 1-line note on the key upgrades only when it helps.
Structure (keep only what earns its tokens):
- Role/goal: one line, outcome first ("Act as X. Produce Y for Z.").
- Context: only facts that change the answer (inputs, audience, source material, current state).
- Task: specific numbered steps or the exact question. Put the most important instruction first and last.
- Constraints: scope, length, tone, must/must-not, tools, what to do when unsure ("say so, don't guess").
- Output format: exact shape (sections, JSON schema, table, file type, length).
- Success criteria: how to check the result is right.
- Examples: 1-2 short ones only when format or style is hard to describe; show the pattern, not the content.
Craft: use positive, concrete, testable wording over vague adjectives ("under 120 words" not "short"). Separate instructions from data with delimiters or tags. For reasoning-heavy work, ask for a plan or checks, not hidden chain of thought. For long tasks, split into stages.
By type: Coding: language, versions, files, input/output, tests, "change only what is needed". Writing: audience, voice, length, angle, what to avoid. Research: question, scope, source standards, citations, uncertainty. System/bot prompts: identity, duties, tools, boundaries, tone, failure handling. Image/creative: subject, style, composition, lighting, mood, medium, negatives, aspect ratio.
Cut: politeness padding, repeated rules, generic advice ("be accurate"), and anything the model does by default.`;

/** Shipped universal skills. A new user gets them once; deleting one keeps it deleted. */
export const DEFAULT_UNIVERSAL_SKILLS = [
  { key: 'token-optimizer', name: 'Token optimizer', description: 'Spend as few tokens as possible without lowering quality.', body: TOKEN_OPTIMIZER_BODY },
  { key: 'marion-agent-guide', name: 'Marion Agent guide', description: 'How Marion Agent, its tools and its team work.', body: GUIDE_BODY },
  { key: 'prompt-engineering', name: 'Prompt engineering', description: 'Upgrade rough prompts or write new ones that are clear, structured and ready to use.', body: PROMPT_ENGINEERING_BODY },
] as const;

const norm = (name: string) => name.replace(/\s+/g, ' ').trim().toLowerCase();
const cleanName = (name: unknown) => String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);

export const toUniversalSkill = (r: any): UniversalSkill => ({
  id: r.id, name: r.name, description: r.description ?? '', body: r.body, createdAt: r.created_at, updatedAt: r.updated_at ?? r.created_at, universal: true,
});

/**
 * Seed the shipped universal skills for a user and fold any per-Bot copies of them into the shared one.
 * If the user had edited a per-Bot copy, the most recently edited copy becomes the universal text so nothing is lost.
 * Idempotent: each shipped skill is handled once per user.
 */
export function ensureUniversalSkills(userId: string) {
  const seeded = new Set((db.prepare('SELECT key FROM universal_skill_seeds WHERE user_id=?').all(userId) as { key: string }[]).map(r => r.key));
  const pending = DEFAULT_UNIVERSAL_SKILLS.filter(d => !seeded.has(d.key));
  if (!pending.length) return;
  db.transaction(() => {
    for (const d of pending) {
      const copies = db.prepare(`SELECT s.id, s.body, s.description FROM skills s JOIN bots b ON b.id=s.bot_id
        WHERE b.user_id=? AND lower(trim(s.name))=? ORDER BY coalesce(s.updated_at, s.created_at) DESC, s.created_at DESC`).all(userId, norm(d.name)) as { id: string; body: string; description: string }[];
      const exists = db.prepare('SELECT 1 FROM universal_skills WHERE user_id=? AND lower(name)=lower(?)').get(userId, d.name);
      if (!exists) {
        const from = copies[0];
        db.prepare('INSERT INTO universal_skills(id,user_id,name,description,body,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
          .run(newId('usk'), userId, d.name, from?.description || d.description, from?.body || d.body, now(), now());
      }
      for (const copy of copies) db.prepare('DELETE FROM skills WHERE id=?').run(copy.id);
      db.prepare('INSERT OR IGNORE INTO universal_skill_seeds(user_id,key) VALUES (?,?)').run(userId, d.key);
    }
  })();
}

/** Run the seeding and deduplication for every existing user (called once at startup). */
export function migrateUniversalSkills() {
  for (const u of db.prepare('SELECT id FROM users').all() as { id: string }[]) ensureUniversalSkills(u.id);
}

export function listUniversalSkills(userId: string): UniversalSkill[] {
  ensureUniversalSkills(userId);
  return (db.prepare('SELECT * FROM universal_skills WHERE user_id=? ORDER BY created_at ASC, name ASC').all(userId) as any[]).map(toUniversalSkill);
}

export const getUniversalSkill = (userId: string, id: string) =>
  db.prepare('SELECT * FROM universal_skills WHERE id=? AND user_id=?').get(id, userId) as any | undefined;

export const universalSkillByName = (userId: string, name: string) =>
  db.prepare('SELECT * FROM universal_skills WHERE user_id=? AND lower(name)=lower(?)').get(userId, cleanName(name)) as any | undefined;

/** Lower-cased names of the user's universal skills (a per-Bot skill with the same name is shadowed by the universal one). */
export function universalNames(userId: string): Set<string> {
  return new Set((db.prepare('SELECT name FROM universal_skills WHERE user_id=?').all(userId) as { name: string }[]).map(r => norm(r.name)));
}

/** Tell open settings screens that a shared skill changed. */
function announce(userId: string) {
  for (const b of db.prepare('SELECT id FROM bots WHERE user_id=?').all(userId) as { id: string }[]) hub.emit(userId, { type: 'memories', botId: b.id });
}

export type UniversalResult = { ok: true; skill: UniversalSkill; created: boolean } | { ok: false; message: string };

export interface UniversalInput { name?: unknown; description?: unknown; body?: unknown }

/** Create a universal skill, or update the one with the same name (case-insensitive). */
export function upsertUniversalSkill(userId: string, input: UniversalInput): UniversalResult {
  ensureUniversalSkills(userId);
  const name = cleanName(input.name);
  const body = String(input.body ?? '').trim().slice(0, MAX_UNIVERSAL_BODY);
  const description = String(input.description ?? '').trim().slice(0, 300);
  if (!name || !body) return { ok: false, message: 'A skill needs a name and steps.' };
  const existing = universalSkillByName(userId, name);
  if (existing) {
    db.prepare('UPDATE universal_skills SET body=?, description=?, updated_at=? WHERE id=?').run(body, input.description === undefined ? existing.description : description, now(), existing.id);
    announce(userId);
    return { ok: true, created: false, skill: toUniversalSkill(db.prepare('SELECT * FROM universal_skills WHERE id=?').get(existing.id)) };
  }
  const count = (db.prepare('SELECT COUNT(*) n FROM universal_skills WHERE user_id=?').get(userId) as { n: number }).n;
  if (count >= MAX_UNIVERSAL_SKILLS) return { ok: false, message: `You already have ${MAX_UNIVERSAL_SKILLS} universal skills. Update one instead.` };
  const id = newId('usk');
  db.prepare('INSERT INTO universal_skills(id,user_id,name,description,body,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id, userId, name, description, body, now(), now());
  announce(userId);
  return { ok: true, created: true, skill: toUniversalSkill(db.prepare('SELECT * FROM universal_skills WHERE id=?').get(id)) };
}

/** Partial edit by id (rename, description, steps). */
export function updateUniversalSkill(userId: string, id: string, patch: UniversalInput): UniversalResult {
  const cur = getUniversalSkill(userId, id);
  if (!cur) return { ok: false, message: 'not found' };
  const name = patch.name === undefined ? cur.name : cleanName(patch.name);
  const body = patch.body === undefined ? cur.body : String(patch.body).trim().slice(0, MAX_UNIVERSAL_BODY);
  const description = patch.description === undefined ? cur.description : String(patch.description).trim().slice(0, 300);
  if (!name) return { ok: false, message: 'Give the skill a name' };
  if (!body) return { ok: false, message: 'Write the steps for this skill' };
  const clash = universalSkillByName(userId, name);
  if (clash && clash.id !== cur.id) return { ok: false, message: `A universal skill named "${clash.name}" already exists.` };
  db.prepare('UPDATE universal_skills SET name=?, body=?, description=?, updated_at=? WHERE id=?').run(name, body, description, now(), cur.id);
  announce(userId);
  return { ok: true, created: false, skill: toUniversalSkill(db.prepare('SELECT * FROM universal_skills WHERE id=?').get(cur.id)) };
}

export function deleteUniversalSkill(userId: string, id: string): boolean {
  const cur = getUniversalSkill(userId, id);
  if (!cur) return false;
  db.prepare('DELETE FROM universal_skills WHERE id=?').run(cur.id);
  announce(userId);
  return true;
}
