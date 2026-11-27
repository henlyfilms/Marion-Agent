import type { Bot, ChatModelSelection, MarionSession, NotificationSettings, StatsRange, StatsSummary } from '@shared/types';
import { create } from 'zustand';
import { ApiError } from './api';

async function req<T>(method: string, path: string, body?: unknown, signal?: AbortSignal, cache?: RequestCache): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(`/api${path}`, {
    method, credentials: 'include',
    headers: body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : undefined,
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    signal, cache,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
    throw new ApiError(res.status, msg || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface BotFolder { path: string; label: string; write: boolean }
export interface AgentSettings { appControl: boolean; liveFeed: boolean; recordingDays: number; autoHandoff: boolean; handoffFallback: ChatModelSelection | null }
export interface TeachRecording { id: string; botId: string; title: string; narration: string; notes: string; seconds: number; frames: { name: string; at: number }[]; source: 'screen' | 'upload'; createdAt: number; expiresAt: number }
export interface ProfileSkill { name: string; description: string; body: string }
export interface ProfileRoutine { name: string; prompt: string; schedule: string; enabled: boolean }
export interface BotProfileData {
  id: string;
  name: string;
  author: string;
  label: string;
  tagline?: string;
  description: string;
  instructions: string;
  avatarShape?: string;
  avatarColor?: string;
  avatarStemColor?: string | null;
  avatarGlow?: boolean;
  custom?: boolean;
  role: 'executive' | null;
  memories: string[];
  skills: ProfileSkill[];
  routines: ProfileRoutine[];
  integrations: string[];
  connected?: string[];
}

export interface ContextInfo {
  tokens: number;
  historyTokens: number;
  items: number;
  limit: number;
  compactAtTokens: number | null;
  defaultCompactAtTokens: number;
  provider: string;
  lastCompaction: { at: number; tokensBefore: number; tokensAfter: number } | null;
}

export interface PushDevice { id: string; endpoint: string; label: string; createdAt: number; lastOkAt: number | null }
export interface LifeLink {
  settings: { enabled: boolean; autoSync: boolean; endpoint: string; lifeEmail: string; lastSyncAt: number | null; lastError: string | null; syncedChats: number; blockedBots?: string[] };
  hasKey: boolean;
  /** Claude session summaries and deleted chats/bots waiting to be sent to Marion Life (they are never lost). */
  outbox?: { pendingSessions: number; sentSessions: number; pendingDeleted: number; sentDeleted: number; lastError: string | null };
}

export type SessionProvider = 'claude' | 'codex' | 'gemini';
export interface CodingSession { id: string; provider: SessionProvider; title: string; project: string; path: string; updatedAt: number; active: boolean; steps?: number }
export interface SessionMessage { role: 'user' | 'assistant'; text: string; at?: number }
export type { MarionSession };
/** Filters for Marion Agent's own sessions (bot chats and relayed Claude / Codex / Gemini runs). */
export interface MarionSessionFilter { botId?: string; type?: 'chat' | 'relay' | 'builders'; kind?: string; provider?: SessionProvider; status?: string; limit?: number }
const sessionParams = (filter: MarionSessionFilter) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== '') params.set(key, String(value));
  const text = params.toString();
  return text ? `?${text}` : '';
};
export interface UpdateStatus {
  supported: boolean; current: string | null; latest: string | null; behind: number; changes: string[]; dirty: boolean; reason?: string;
  install: { state: 'idle' | 'building' | 'installing' | 'failed'; message: string; at: number };
  /** Settings → Updates → Auto-update. On unless the owner turned it off. */
  autoUpdate?: boolean;
}

export const featuresApi = {
  sessions: (provider?: SessionProvider) => req<{ sessions: CodingSession[] }>('GET', `/sessions${provider ? `?provider=${provider}` : ''}`),
  stats: (range: StatsRange, signal?: AbortSignal) => req<StatsSummary>('GET', `/stats?range=${range}`, undefined, signal),
  marionSessions: (filter: MarionSessionFilter = {}) => req<{ sessions: MarionSession[]; running: number }>('GET', `/sessions/marion${sessionParams(filter)}`),
  botSessions: (botId: string, filter: Omit<MarionSessionFilter, 'botId'> = {}) => req<{ sessions: MarionSession[]; running: number }>('GET', `/bots/${encodeURIComponent(botId)}/sessions${sessionParams(filter)}`),
  chatSessionMessages: (botId: string, generation: number) => req<{ messages: SessionMessage[] }>('GET', `/bots/${encodeURIComponent(botId)}/sessions/${generation}/messages`),
  sessionMessages: (id: string) => req<{ messages: SessionMessage[] }>('GET', `/sessions/${encodeURIComponent(id)}/messages`),
  updateStatus: (current: string) => req<UpdateStatus>('GET', `/app/update?current=${encodeURIComponent(current)}`, undefined, undefined, 'no-store'),
  installUpdate: () => req<{ ok: true }>('POST', '/app/update', {}),
  setAutoUpdate: (autoUpdate: boolean) => req<{ autoUpdate: boolean }>('PUT', '/app/update/settings', { autoUpdate }),
  templates: () => req<{ templates: BotProfileData[] }>('GET', '/templates'),
  saveTemplate: (botId: string) => req<{ id: string; name: string }>('POST', `/bots/${botId}/template`),
  removeTemplate: (id: string) => req<{ ok: true }>('DELETE', `/templates/${encodeURIComponent(id)}`),
  importTemplate: (id: string) => req<{ bot: Bot }>('POST', `/templates/${encodeURIComponent(id)}/import`, {}),
  profile: (botId: string) => req<{ profile: BotProfileData }>('GET', `/bots/${botId}/profile`),
  importBot: (spec: unknown) => req<{ bot: Bot }>('POST', '/bots/import', spec),
  context: (botId: string) => req<ContextInfo>('GET', `/bots/${botId}/context`),
  compact: (botId: string) => req<{ itemsBefore: number; itemsAfter: number; tokens: number }>('POST', `/bots/${botId}/context/compact`),
  improve: (botId: string) => req<{ lessons: number; skills: number }>('POST', `/bots/${botId}/improve`),
  setBot: (botId: string, patch: { role?: 'executive' | null; compactAtTokens?: number | null }) => req<{ bot: Bot }>('PATCH', `/bots/${botId}`, patch),
  setComputerAwake: (botId: string, awake: boolean) => req<{ ok: true }>('POST', `/bots/${botId}/computer`, { awake }),
  teach: (botId: string, form: FormData) => req<{ row: unknown }>('POST', `/bots/${botId}/teach`, form),
  notifications: () => req<{ settings: NotificationSettings; publicKey: string; devices: PushDevice[] }>('GET', '/notifications'),
  saveNotifications: (patch: Partial<NotificationSettings>) => req<{ settings: NotificationSettings }>('PUT', '/notifications', patch),
  addDevice: (subscription: PushSubscriptionJSON, label: string) => req<{ ok: true }>('POST', '/notifications/devices', { ...subscription, label }),
  removeDevice: (endpoint: string) => req<{ ok: true }>('DELETE', '/notifications/devices', { endpoint }),
  testNotification: () => req<{ devices: number; delivered: number }>('POST', '/notifications/test'),
  folders: (botId: string) => req<{ folders: BotFolder[]; fullAccess?: boolean; suggestion: string | null }>('GET', `/bots/${botId}/folders`),
  setFullAccess: (botId: string, enabled: boolean, confirm?: string) => req<{ fullAccess: boolean }>('PUT', `/bots/${botId}/full-access`, { enabled, confirm }),
  continueHandoff: (botId: string, id: string, seq: number, selection: ChatModelSelection) =>
    req<{ ok: true }>('POST', `/bots/${encodeURIComponent(botId)}/handoffs/${encodeURIComponent(id)}/continue`, { seq, selection }),
  startCloudSession: (botId: string, body: { goal: string; folder: string; allowLocalEdits: boolean }) =>
    req<{ id: string }>('POST', `/bots/${encodeURIComponent(botId)}/cloud-session`, body),
  createGitHubRepo: (body: { name: string; description: string; visibility: 'private' | 'public'; folder?: string; confirmPush: boolean }) =>
    req<{ url: string; pushed: boolean; warning?: string }>('POST', '/github/repos', body),
  agentSettings: () => req<{ settings: AgentSettings; recordingDayOptions: number[] }>('GET', '/agent-settings'),
  saveAgentSettings: (patch: Partial<AgentSettings>) => req<{ settings: AgentSettings }>('PUT', '/agent-settings', patch),
  recordings: (botId?: string) => req<{ recordings: TeachRecording[]; keepDays: number }>('GET', `/recordings${botId ? `?botId=${encodeURIComponent(botId)}` : ''}`),
  saveRecording: (botId: string, form: FormData) => req<{ id: string }>('POST', `/bots/${botId}/recordings`, form),
  deleteRecording: (id: string) => req<{ ok: boolean }>('DELETE', `/recordings/${encodeURIComponent(id)}`),
  clearRecordings: () => req<{ removed: number }>('DELETE', '/recordings'),
  addFolder: (botId: string, body: { path?: string; pick?: boolean; label?: string; write?: boolean }) => req<{ folders: BotFolder[]; cancelled?: boolean }>('POST', `/bots/${botId}/folders`, body),
  updateFolder: (botId: string, body: { path: string; label?: string; write?: boolean }) => req<{ folders: BotFolder[] }>('PATCH', `/bots/${botId}/folders`, body),
  removeFolder: (botId: string, path: string) => req<{ folders: BotFolder[] }>('DELETE', `/bots/${botId}/folders`, { path }),
  lifeLink: () => req<LifeLink>('GET', '/life-link'),
  saveLifeLink: (body: { endpoint?: string; linkKey?: string; enabled?: boolean; autoSync?: boolean; blockedBots?: string[] }) => req<LifeLink>('PUT', '/life-link', body),
  removeLifeLink: () => req<{ ok: true }>('DELETE', '/life-link'),
  syncLife: () => req<{ synced: number; settings: LifeLink['settings'] }>('POST', '/life-link/sync'),
};

export type ProfileTarget = { kind: 'bot'; id: string } | { kind: 'template'; id: string; back?: boolean };

/** UI state for the feature screens, kept apart from the main store. */
export const useFeatureUI = create<{
  gallery: boolean;
  profile: ProfileTarget | null;
  teachBotId: string | null;
  set: (patch: Partial<{ gallery: boolean; profile: ProfileTarget | null; teachBotId: string | null }>) => void;
}>((set) => ({ gallery: false, profile: null, teachBotId: null, set }));

export function formatTokens(n: number) {
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}
