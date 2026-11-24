import { db } from '../db.js';
import { newId } from '../lib/ids.js';
import { chatProviders, type OrchestrationSettings, type TeamMember } from '../types.js';

/** Settings only: kept apart from the engine so store.ts can read them without import cycles. */

export const MAX_TEAM_MEMBERS = 6;
const DEFAULTS: OrchestrationSettings = { enabled: false, members: [], balanceUsage: true };

export function orchestrationFor(row: { orchestration?: string | null }): OrchestrationSettings {
  if (!row?.orchestration) return { ...DEFAULTS, members: [] };
  try {
    const saved = JSON.parse(row.orchestration) as Partial<OrchestrationSettings>;
    const members = Array.isArray(saved.members) ? saved.members.filter(isMember).slice(0, MAX_TEAM_MEMBERS) : [];
    return { enabled: Boolean(saved.enabled) && members.length > 0, members, balanceUsage: saved.balanceUsage !== false };
  } catch {
    return { ...DEFAULTS, members: [] };
  }
}

export const orchestrationForBot = (botId: string) =>
  orchestrationFor(db.prepare('SELECT orchestration FROM bots WHERE id=?').get(botId) as { orchestration?: string | null });

function isMember(value: any): value is TeamMember {
  return value && typeof value.id === 'string' && chatProviders.includes(value.provider)
    && typeof value.model === 'string' && value.model.length > 0 && value.model.length <= 200
    && (value.effort === null || typeof value.effort === 'string')
    && typeof value.label === 'string' && typeof value.role === 'string';
}

/** Clean user input into members (labels unique, so the orchestrator can name them). */
export function normalizeMembers(input: unknown): TeamMember[] {
  if (!Array.isArray(input)) throw new Error('Add the team members as a list.');
  if (input.length > MAX_TEAM_MEMBERS) throw new Error(`A team can have up to ${MAX_TEAM_MEMBERS} members.`);
  const used = new Set<string>();
  return input.map((raw: any) => {
    if (!raw || !chatProviders.includes(raw.provider) || typeof raw.model !== 'string' || !raw.model.trim() || raw.model.length > 200) {
      throw new Error('Choose a model for every team member.');
    }
    if (raw.effort !== null && raw.effort !== undefined && typeof raw.effort !== 'string') throw new Error('Choose a supported effort.');
    let label = String(raw.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || String(raw.model).slice(0, 40);
    for (let n = 2; used.has(label.toLowerCase()); n++) label = `${label.replace(/ \d+$/, '')} ${n}`;
    used.add(label.toLowerCase());
    return {
      id: typeof raw.id === 'string' && /^tm_[\w-]{4,40}$/.test(raw.id) ? raw.id : newId('tm'),
      provider: raw.provider,
      model: raw.model.trim(),
      effort: raw.effort ?? null,
      label,
      role: String(raw.role ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
    };
  });
}

export function saveOrchestration(botId: string, settings: OrchestrationSettings) {
  db.prepare('UPDATE bots SET orchestration=? WHERE id=?').run(JSON.stringify(settings), botId);
}
