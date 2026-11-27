import type { Bot, ChatModelSelection, ChatSort, ComputerState, LiveState, Routine, Row, SubscriptionUsage, Toolkit, User } from '@shared/types';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function req<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const form = body instanceof FormData;
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined && !form ? { 'Content-Type': 'application/json' } : undefined,
    body: form ? body : body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface AppsResponse { configured: boolean; apps: Toolkit[]; connected: string[]; categories: string[]; total: number }

export interface RoomMember { id: string; name: string; label: string; avatarShape: string; avatarColor: string; avatarStemColor: string | null }

export const api = {
  me: () => req<{ user: User | null; devLogin: boolean; googleLogin: boolean; localWorkspace: boolean; mobileLogin?: boolean }>('GET', '/auth/me'),
  mobileLogin: (passphrase: string) => req<{ ok: true }>('POST', '/auth/mobile', { passphrase }),
  devLogin: (email: string, name?: string) => req<{ ok: true }>('POST', '/auth/dev', { email, name }),
  logout: () => req<{ ok: true }>('POST', '/auth/logout'),

  bots: () => req<{ bots: Bot[]; live: LiveState[]; chatSort: ChatSort }>('GET', '/bots'),
  orderChats: (body: { sort: ChatSort } | { id: string; targetId: string; after: boolean }) =>
    req<{ chatSort: ChatSort; positions: Record<string, number> }>('PUT', '/bots/order', body),
  createBot: (b: Pick<Bot, 'name' | 'avatarShape' | 'avatarColor' | 'avatarStemColor' | 'avatarGlow' | 'mode'>) => req<{ bot: Bot }>('POST', '/bots', b),
  markRead: (id: string) => req<{ ok: true }>('POST', `/bots/${id}/read`),
  rows: (id: string) => req<{ generation: number; rows: Row[] }>('GET', `/bots/${id}/rows`),
  /** A message spoken on a voice call (optionally to a different model than the chat's). */
  sendCall: (id: string, text: string, call: string, model?: ChatModelSelection | null, signal?: AbortSignal) =>
    req<{ row: Row }>('POST', `/bots/${id}/messages`, { text, call, ...(model ? { model } : {}) }, signal),
  /** `replyTo` is the seq of the message being answered; `forwardedFrom` the name of the chat a message was forwarded from;
   * `clientId` lets the server drop a retried copy of the same prompt (offline queue). */
  send: (id: string, text: string, files: File[] = [], extra: { replyTo?: number; forwardedFrom?: string; clientId?: string } = {}) => {
    const path = `/bots/${id}/messages`;
    if (!files.length) return req<{ row: Row }>('POST', path, { text, ...extra });
    const form = new FormData();
    form.set('text', text);
    if (extra.replyTo !== undefined) form.set('replyTo', String(extra.replyTo));
    if (extra.forwardedFrom) form.set('forwardedFrom', extra.forwardedFrom);
    if (extra.clientId) form.set('clientId', extra.clientId);
    files.forEach(file => form.append('attachments', file));
    return req<{ row: Row }>('POST', path, form);
  },
  attachmentUrl: (id: string, fileId: string) => `/api/bots/${encodeURIComponent(id)}/attachments/${encodeURIComponent(fileId)}`,
  subscriptionUsage: (refresh: boolean, signal?: AbortSignal, provider?: SubscriptionUsage['provider']) => req<{ subscriptions: SubscriptionUsage[] }>(
    'GET', `/subscriptions/usage?refresh=${Number(refresh)}${provider ? `&provider=${provider}` : ''}`, undefined, signal,
  ),
  subscriptionPlans: () => req<{ plans: Record<SubscriptionUsage['provider'], string>; options: Record<SubscriptionUsage['provider'], string[]> }>('GET', '/subscriptions/plans'),
  saveSubscriptionPlan: (provider: SubscriptionUsage['provider'], plan: string) => req<{ plans: Record<SubscriptionUsage['provider'], string> }>('PUT', '/subscriptions/plans', { [provider]: plan }),
  interrupt: (id: string) => req<{ ok: true }>('POST', `/bots/${id}/interrupt`),
  fresh: (id: string) => req<{ ok: true }>('POST', `/bots/${id}/fresh`),

  approve: (approvalId: string, decision: 'allow' | 'always' | 'deny') => req<{ ok: true }>('POST', `/approvals/${approvalId}`, { decision }),
  answer: (id: string, seq: number, answer: string) => req<{ ok: true }>('POST', `/bots/${id}/cards/${seq}/answer`, { answer }),
  dismiss: (id: string, seq: number) => req<{ ok: true }>('POST', `/bots/${id}/cards/${seq}/dismiss`),

  routines: (id: string) => req<{ routines: Routine[] }>('GET', `/bots/${id}/routines`),
  setRoutine: (rid: string, enabled: boolean) => req<{ routine: Routine }>('PATCH', `/routines/${rid}`, { enabled }),

  computer: () => req<{ computer: ComputerState }>('GET', '/computer'),
  ensureComputer: (botId: string) => req<{ computer: ComputerState }>('POST', '/computer/ensure', { botId }),

  apps: (search = '', category = '') => req<AppsResponse>('GET', `/apps?search=${encodeURIComponent(search)}&category=${encodeURIComponent(category)}`),
  connect: (slug: string, botId?: string, seq?: number) => req<{ redirectUrl: string }>('POST', `/apps/${slug}/connect`, { botId, seq }),
  disconnect: (slug: string) => req<{ ok: true }>('DELETE', `/apps/${slug}`),

  roomMembers: (id: string) => req<{ members: RoomMember[] }>('GET', `/rooms/${id}/members`),
  setRoomMembers: (id: string, botIds: string[]) => req<{ ok: true; members: string[] }>('PUT', `/rooms/${id}/members`, { botIds }),
  createRoom: (name: string, botIds: string[]) => req<{ id: string }>('POST', '/rooms', { name, botIds }),
};

let connectPopup: Window | null = null;

/** Open a Composio redirect in a centered popup. */
export function openPopup(url: string) {
  const w = 520, h = 680;
  const left = window.screenX + (window.outerWidth - w) / 2;
  const top = window.screenY + (window.outerHeight - h) / 2;
  connectPopup = window.open(url, 'marion-agent-connect', `width=${w},height=${h},left=${left},top=${top}`);
  return connectPopup;
}

/** True for the "app connected" message posted by our OAuth callback page (from our popup or our own origin). */
export function isConnectedMessage(e: MessageEvent): boolean {
  if ((e.data as { type?: string } | null)?.type !== 'marion-agent-connected') return false;
  return e.origin === window.location.origin || (connectPopup !== null && e.source === connectPopup);
}
