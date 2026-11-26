import type { OrchestrationSettings, TeamMember } from '@shared/types';
import type { Bot, ChatModel, ChatModelSelection, ChatModelSettings, ChatProvider, ComputerState, LibraryFile, Memory, Routine, Skill, Task, Toolkit, UniversalSkill } from '@shared/types';
import { ApiError } from './api';

async function req<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    signal,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

export interface BotSettingsBundle {
  memories: Memory[];
  skills: Skill[];
  universalSkills: UniversalSkill[];
  routines: Routine[];
  tasks: Task[];
  memory: { lastConsolidatedAt: number | null; historyChars: number; compactAtChars: number; lastCompaction: { method: string; created_at: number } | null };
}

export interface LibraryListing { status: 'ok' | 'asleep' | 'error'; path: string; files: LibraryFile[]; error?: string }

export interface ComputerDetails {
  computer: ComputerState;
  screens: { botId: string; screenId: string; lastUsedAt: number }[];
  hibernation: { idleMinutes: number; viewers: number; dryRun: boolean };
}

export type BotPatch = Partial<Pick<Bot, 'name' | 'label' | 'description' | 'instructions' | 'avatarShape' | 'avatarColor' | 'avatarStemColor' | 'avatarGlow' | 'workFx' | 'effort' | 'mode' | 'pinned'>>;

export interface LocalModels { selected: string; defaultModel: string; models: string[]; reachable: boolean }
export interface LocalMemory { available: number; total: number }
export interface ChatProviderSettings { provider: ChatProvider; installed: Record<Exclude<ChatProvider, 'local'>, boolean> }
export interface SubscriptionModelSettings { selection: ChatModelSelection; models: ChatModel[]; error?: string }
export interface ComposioStatus { configured: boolean; editable: boolean }

export const configApi = {
  models: () => req<LocalModels>('GET', '/settings/models'),
  localMemory: (signal: AbortSignal) => req<{ memory: LocalMemory | null }>('GET', '/settings/local-memory', undefined, signal),
  selectModel: (model: string) => req<{ selected: string }>('PUT', '/settings/models', { model }),
  chatProvider: () => req<ChatProviderSettings>('GET', '/settings/chat-provider'),
  selectChatProvider: (provider: ChatProvider) => req<ChatProviderSettings>('PUT', '/settings/chat-provider', { provider }),
  subscriptionModel: (provider: ChatProvider) => req<SubscriptionModelSettings>('GET', `/settings/subscription-model/${provider}`),
  selectSubscriptionModel: (selection: ChatModelSelection) => req<SubscriptionModelSettings>('PUT', `/settings/subscription-model/${selection.provider}`, selection),
  orchestration: (botId: string) => req<{ settings: OrchestrationSettings; orchestrator: ChatModelSelection }>('GET', `/bots/${botId}/orchestration`),
  saveOrchestration: (botId: string, settings: { enabled: boolean; members: Omit<TeamMember, 'id'>[] | TeamMember[]; balanceUsage: boolean }) =>
    req<{ settings: OrchestrationSettings; bot: Bot }>('PUT', `/bots/${botId}/orchestration`, settings),
  chatModels: (botId: string, discover = false) => req<ChatModelSettings>('GET', `/bots/${botId}/chat-model${discover ? '?discover=1' : ''}`),
  selectChatModel: (botId: string, selection: ChatModelSelection) => req<{ selection: ChatModelSelection; bot: Bot }>('PUT', `/bots/${botId}/chat-model`, selection),
  deviceAccess: (kind: 'mobile' | 'browser', reveal = false) => req<{ origin: string | null; passphrase: string | null; sessionHours?: number; sessionChoices?: number[] }>('GET', `/settings/${kind}-access${reveal ? '?reveal=1' : ''}`),
  saveBrowserSession: (hours: number) => req<{ sessionHours: number }>('PUT', '/settings/browser-session', { hours }),
  composio: () => req<ComposioStatus>('GET', '/settings/composio'),
  saveComposioKey: (key: string) => req<ComposioStatus>('PUT', '/settings/composio', { key }),
  settings: (botId: string) => req<BotSettingsBundle>('GET', `/bots/${botId}/settings`),
  updateBot: (botId: string, p: BotPatch) => req<{ bot: Bot }>('PATCH', `/bots/${botId}`, p),
  deleteBot: (botId: string) => req<{ ok: true }>('DELETE', `/bots/${botId}`),
  deletedBots: () => req<{ bots: (Bot & { deletedAt: number; purgeAt: number })[] }>('GET', '/bots/deleted'),
  restoreBot: (botId: string) => req<{ bot: Bot }>('POST', `/bots/${botId}/restore`),
  makePrimary: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/primary`),
  clearPrimary: (botId: string) => req<{ ok: true }>('DELETE', `/bots/${botId}/primary`),
  fresh: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/fresh`),

  deleteMemory: (id: string) => req<{ ok: true }>('DELETE', `/memories/${id}`),

  createSkill: (botId: string, s: Pick<Skill, 'name' | 'description' | 'body'>) => req<{ skill: Skill }>('POST', `/bots/${botId}/skills`, s),
  updateSkill: (id: string, s: Partial<Pick<Skill, 'name' | 'description' | 'body'>>) => req<{ skill: Skill }>('PATCH', `/skills/${id}`, s),
  deleteSkill: (id: string) => req<{ ok: true }>('DELETE', `/skills/${id}`),
  createUniversalSkill: (s: Pick<Skill, 'name' | 'description' | 'body'>) => req<{ skill: UniversalSkill }>('POST', '/skills/universal', s),
  updateUniversalSkill: (id: string, s: Partial<Pick<Skill, 'name' | 'description' | 'body'>>) => req<{ skill: UniversalSkill }>('PATCH', `/skills/universal/${id}`, s),
  deleteUniversalSkill: (id: string) => req<{ ok: true }>('DELETE', `/skills/universal/${id}`),

  setRoutine: (id: string, enabled: boolean) => req<{ routine: Routine }>('PATCH', `/routines/${id}`, { enabled }),
  runRoutine: (id: string) => req<{ ok: true }>('POST', `/routines/${id}/run`),
  deleteRoutine: (id: string) => req<{ ok: true }>('DELETE', `/routines/${id}`),

  tasks: () => req<{ tasks: Task[] }>('GET', '/tasks'),
  botTasks: (botId: string) => req<{ tasks: Task[] }>('GET', `/bots/${botId}/tasks`),
  setTaskState: (id: string, state: 'working' | 'done') => req<{ task: Task }>('PATCH', `/tasks/${encodeURIComponent(id)}`, { state }),

  files: (botId: string, path = '', wake = false) => req<LibraryListing>('GET', `/bots/${botId}/files?path=${encodeURIComponent(path)}${wake ? '&wake=1' : ''}`),
  async downloadFile(botId: string, path: string) {
    const response = await fetch(`/api/bots/${botId}/files/download`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }),
    });
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `Download failed (${response.status})`);
    return response.blob();
  },

  computerDetails: () => req<ComputerDetails>('GET', '/computer/details'),
  wake: () => req<{ computer: ComputerState }>('POST', '/computer/ensure'),
  sleep: () => req<{ computer: ComputerState }>('POST', '/computer/suspend'),
  resetScreen: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/screen/reset`),

  policies: () => req<{ policies: { tool: string; mode: string }[] }>('GET', '/policies'),
  deletePolicy: (tool: string) => req<{ ok: true }>('DELETE', `/policies/${encodeURIComponent(tool)}`),

  connectedApps: () => req<{ connectedApps?: Toolkit[]; connected: string[] }>('GET', '/apps?limit=1'),
  logout: () => req<{ ok: true }>('POST', '/auth/logout'),
};
