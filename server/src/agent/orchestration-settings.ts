import { availableLocalModels } from './models.js';
import { subscriptionModels } from './subscriptions.js';
import { env } from '../env.js';
import { db } from '../db.js';
import { newId } from '../lib/ids.js';
import { chatProviders, localEfforts, type ChatModel, type OrchestrationSettings, type TeamMember } from '../types.js';

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

export async function teamModels(subscriptionAllowed: boolean): Promise<ChatModel[]> {
  const local = availableLocalModels().catch((): string[] => []).then(models =>
    [...new Set([env.localModelName, ...models])].map((id): ChatModel =>
      ({ provider: 'local', id, label: id, efforts: [...localEfforts], defaultEffort: 'medium' })));
  const subscribed = subscriptionAllowed ? ['codex', 'gemini', 'claude'] as const : [];
  const available = await Promise.all([
    local,
    ...subscribed.map(provider => subscriptionModels(provider).then(catalog => catalog.models).catch((): ChatModel[] => [])),
  ]);
  return available.flat();
}

export class TeamSettingsError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 503) { super(message); }
}

export async function validateTeamSettings(
  input: { enabled?: unknown; members?: unknown; balanceUsage?: unknown }, subscriptionAllowed: boolean,
): Promise<OrchestrationSettings> {
  const members = normalizeMembers(input.members ?? []);
  const catalogs = new Map<TeamMember['provider'], ChatModel[]>();
  let localModels: string[] | undefined;
  for (const member of members) {
    if (member.provider === 'local') {
      if (member.effort && !localEfforts.some(option => option === member.effort)) throw new TeamSettingsError(`Choose a supported effort for ${member.label}.`, 400);
      if (member.model !== env.localModelName) {
        localModels ??= await availableLocalModels().catch((): string[] => []);
        if (!localModels.includes(member.model)) throw new TeamSettingsError(`${member.model} isn't on your local model server.`, 400);
      }
      continue;
    }
    if (!subscriptionAllowed) throw new TeamSettingsError('Configure subscription team members from the local Mac workspace.', 403);
    let models = catalogs.get(member.provider);
    if (!models) {
      models = (await subscriptionModels(member.provider).catch(() => null))?.models;
      if (!models) throw new TeamSettingsError(`The ${member.provider} model list is unavailable. Check its CLI and sign-in.`, 503);
      catalogs.set(member.provider, models);
    }
    const option = models.find(entry => entry.id === member.model);
    if (!option) throw new TeamSettingsError(`${member.model} isn't available for ${member.label}.`, 400);
    member.effort ??= option.defaultEffort;
    if (member.effort ? !option.efforts.includes(member.effort) : option.efforts.length > 0) throw new TeamSettingsError(`Choose a supported effort for ${member.label}.`, 400);
  }
  return { enabled: Boolean(input.enabled) && members.length > 0, members, balanceUsage: input.balanceUsage !== false };
}
