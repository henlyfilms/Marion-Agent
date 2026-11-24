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
  settings: { enabled: boolean; supabaseUrl: string; lifeEmail: string; lifeUserId: string; lastSyncAt: number | null; lastError: string | null; syncedChats: number };
  hasKey: boolean;
}

export const featuresApi = {
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
  lifeLink: () => req<LifeLink>('GET', '/life-link'),
  saveLifeLink: (body: { supabaseUrl?: string; serviceKey?: string; lifeEmail?: string; enabled?: boolean }) => req<LifeLink>('PUT', '/life-link', body),
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
