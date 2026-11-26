import type { Bot, NotificationSettings } from '@shared/types';
import { create } from 'zustand';
import { ApiError } from './api';

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(`/api${path}`, {
    method, credentials: 'include',
    headers: body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : undefined,
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
    throw new ApiError(res.status, msg || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface BotFolder { path: string; label: string; write: boolean }
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
}

export type SessionProvider = 'claude' | 'codex' | 'gemini';
export interface CodingSession { id: string; provider: SessionProvider; title: string; project: string; path: string; updatedAt: number; active: boolean; steps?: number }
export interface SessionMessage { role: 'user' | 'assistant'; text: string; at?: number }
export interface UpdateStatus {
  supported: boolean; current: string | null; latest: string | null; behind: number; changes: string[]; dirty: boolean; reason?: string;
  install: { state: 'idle' | 'building' | 'installing' | 'failed'; message: string; at: number };
}

export const featuresApi = {
  sessions: (provider?: SessionProvider) => req<{ sessions: CodingSession[] }>('GET', `/sessions${provider ? `?provider=${provider}` : ''}`),
  sessionMessages: (id: string) => req<{ messages: SessionMessage[] }>('GET', `/sessions/${encodeURIComponent(id)}/messages`),
  updateStatus: (current: string) => req<UpdateStatus>('GET', `/app/update?current=${encodeURIComponent(current)}`),
  installUpdate: () => req<{ ok: true }>('POST', '/app/update', {}),
  templates: () => req<{ templates: BotProfileData[] }>('GET', '/templates'),
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
  folders: (botId: string) => req<{ folders: BotFolder[]; suggestion: string | null }>('GET', `/bots/${botId}/folders`),
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
