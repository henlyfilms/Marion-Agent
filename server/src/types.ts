// Shared API contract between server and web (web imports these as types only).

import type { BerryShape, ClassicShape } from './avatarShapes.js';

export type AvatarShape = ClassicShape | BerryShape;

export type AvatarColor =
  | 'black' | 'brown' | 'red' | 'orange' | 'yellow' | 'green' | 'cyan' | 'blue' | 'violet' | 'magenta' | 'gray';

export interface User { id: string; email: string; name: string; avatarUrl: string | null }

export interface Bot {
  id: string;
  name: string;
  label: string;
  description: string;
  instructions: string;
  avatarShape: AvatarShape;
  avatarColor: AvatarColor;
  avatarStemColor: string | null;
  mode: 'personal' | 'teammate';
  isPrimary: boolean;
  /** 'room' = group chat (members answer instead of the bot itself). */
  kind?: 'agent' | 'room';
  pinned: boolean;
  sortPosition?: number | null;
  chatModel?: ChatModelSelection;
  effort: 'low' | 'medium' | 'high' | 'xhigh';
  /** Voice chat settings: xAI voice id, speed multiplier (0.7–1.5), BCP-47 language or 'auto'. */
  voice: string;
  voiceSpeed: number;
  voiceLanguage: string;
  generation: number;
  unread: number;
  lastPreview: string | null;
  lastActivityAt: number;
  completedAt?: number | null;
  createdAt: number;
  /** 'executive' bots coordinate the rest of the team. */
  role?: 'executive' | null;
  templateId?: string | null;
  /** Estimated tokens the bot sends the model each turn (history + instructions). */
  contextTokens?: number | null;
  /** Auto-compact when context passes this many tokens; 0 = never; null = app default. */
  compactAtTokens?: number | null;
  /** Multi-model team: the bot's own model orchestrates these members. */
  orchestration?: OrchestrationSettings;
  /** Toolkit slugs this bot is meant to use (shown on its profile). */
  integrations?: string[];
}

/** A transcript row. `seq` orders rows; `updatedSeq` is a per-bot revision counter (rows are rewritten while streaming). */
export interface Row {
  botId: string;
  generation: number;
  seq: number;
  updatedSeq: number;
  kind: RowKind;
  body: RowBody;
  createdAt: number;
}

export type RowKind = 'message' | 'tool-call' | 'card' | 'event' | 'notice';

export type RowBody =
  | MessageBody
  | ToolCallBody
  | CardBody
  | EventBody
  | NoticeBody;

export const chatProviders = ['local', 'codex', 'gemini', 'claude'] as const;
export const localEfforts = ['low', 'medium', 'high', 'xhigh'] as const;
export type ChatProvider = typeof chatProviders[number];
export const chatSortOptions = ['recent', 'name', 'custom'] as const;
export type ChatSort = typeof chatSortOptions[number];

export interface ChatModel {
  provider: ChatProvider;
  id: string;
  label: string;
  efforts: string[];
  defaultEffort: string | null;
}

export interface ChatModelSelection {
  provider: ChatProvider;
  model: string;
  effort: string | null;
  label?: string;
}

/** One model on an orchestrated team (any provider: local, Codex, Gemini or Claude). */
export interface TeamMember {
  id: string;
  provider: ChatProvider;
  model: string;
  effort: string | null;
  label: string;
  /** What this member is best at, e.g. "Coder", "Reviewer", "Researcher". */
  role: string;
}

export interface OrchestrationSettings {
  enabled: boolean;
  members: TeamMember[];
  /** Spread work across members by their remaining plan usage and hand off when one runs out. */
  balanceUsage: boolean;
}

export interface ResponseUsage extends ChatModelSelection {
  input: number;
  output: number;
  estimated: boolean;
}

export interface ChatModelSettings {
  selection: ChatModelSelection;
  models: ChatModel[];
  unavailable: Partial<Record<ChatProvider, string>>;
}

export interface UsageWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt?: number;
  resetLabel?: string;
}

export interface SubscriptionUsage {
  provider: Exclude<ChatProvider, 'local'>;
  status: 'ready' | 'unavailable' | 'sign-in' | 'missing' | 'stale';
  windows: UsageWindow[];
  plan?: string;
  checkedAt?: number;
  detail?: string;
}

export interface ChatAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export interface MessageBody {
  type: 'message';
  role: 'user' | 'assistant';
  text: string;
  streaming?: boolean;
  attachments?: ChatAttachment[];
  /** Set when a message came from another bot, a routine or a voice call rather than the user typing. */
  from?: { kind: 'bot' | 'routine' | 'voice' | 'model'; id: string; name: string; provider?: ChatProvider };
  citations?: { url: string; title?: string }[];
  usage?: ResponseUsage[];
}

export interface ToolCallBody {
  type: 'tool-call';
  callId: string;
  name: string;
  /** Human phrase, e.g. "Clicking on screen". */
  label: string;
  status: 'running' | 'done' | 'error' | 'awaiting-approval' | 'denied';
  args?: unknown;
  summary?: string;
  /** Data URL thumbnail for computer actions. */
  screenshot?: string;
}

export type CardBody =
  | {
      type: 'card';
      card: 'approval';
      approvalId: string;
      title: string;
      detail: string;
      tool: string;
      toolkit?: string;
      toolkitName?: string;
      logo?: string;
      args: unknown;
      status: 'pending' | 'allowed' | 'always' | 'denied' | 'expired';
    }
  | {
      type: 'card';
      card: 'question';
      question: string;
      options: string[];
      status: 'pending' | 'answered' | 'dismissed';
      answer?: string;
    }
  | {
      type: 'card';
      card: 'connect';
      toolkit: string;
      toolkitName: string;
      logo?: string;
      reason: string;
      status: 'pending' | 'connected' | 'skipped';
    }
  | {
      type: 'card';
      card: 'draft';
      channel: 'email' | 'slack' | 'message';
      to: string;
      subject?: string;
      text: string;
      approvalId: string;
      status: 'pending' | 'sent' | 'discarded';
    };

export interface EventBody {
  type: 'event';
  event: 'routine-created' | 'routine-updated' | 'routine-run' | 'task-changed' | 'bot-message' | 'conversation-cleared' | 'computer' | 'voice-call';
  text: string;
  ref?: string;
  /** voice-call only: the call record (set on the end-of-call row). */
  call?: VoiceCallRecord;
}

export interface VoiceCallRecord {
  id: string;
  phase: 'started' | 'ended';
  durationMs?: number;
  summary?: string;
  transcript?: { role: 'user' | 'assistant'; text: string }[];
  tasks?: string[];
}

export interface VoiceOption { id: string; name: string; gender?: string }

export interface NoticeBody { type: 'notice'; text: string; tone?: 'info' | 'warn' | 'error' }

export type ActivityKind =
  | 'thinking' | 'working' | 'searching_web' | 'reading_web' | 'browsing_web' | 'on_its_computer'
  | 'running_commands' | 'waiting_on_command' | 'messaging_named' | 'connecting_service'
  | 'waiting_for_you' | 'drafting_file' | 'remembering';

export interface LiveState {
  botId: string;
  activeModel?: ChatModelSelection;
  modelUsage?: ResponseUsage[];
  voiceReply?: { call: string; seq: number; generation: number; text: string };
  isRunning: boolean;
  activity: { kind: ActivityKind; detail?: string; since: number } | null;
  awaiting: { reason: string; since: number } | null;
  startedAt: number | null;
}

export interface Routine {
  id: string; botId: string; name: string; prompt: string; schedule: string; timezone: string;
  enabled: boolean; nextRunAt: number | null; lastRunAt: number | null; description: string;
}

export interface Task { id: string; botId: string; title: string; state: 'working' | 'needs_input' | 'done'; note: string; updatedAt: number }

export interface Memory { id: string; botId: string; text: string; createdAt: number; source?: 'chat' | 'learned' }

export interface Skill { id: string; botId: string; name: string; description: string; body: string; createdAt: number; updatedAt: number }

export interface LibraryFile { name: string; size: number; modifiedAt: number; isDir: boolean }

export interface ComputerState {
  status: 'absent' | 'creating' | 'starting' | 'running' | 'suspending' | 'suspended' | 'resuming' | 'error' | 'stopped';
  error: string | null;
  screens: { botId: string; screenId: string; running: boolean }[];
}

export interface Toolkit {
  slug: string; name: string; logo?: string; description?: string; categories: string[];
  managedAuth: boolean; noAuth: boolean; connected: boolean;
}

/** Server-sent events on GET /api/events */
export type ServerEvent =
  | { type: 'hello'; serverTime: number }
  | { type: 'rows'; botId: string; generation: number; rows: Row[] }
  | { type: 'cleared'; botId: string; generation: number }
  | { type: 'live'; state: LiveState }
  | { type: 'roster' }
  | { type: 'chat-order'; chatSort: ChatSort; positions: Record<string, number> }
  | { type: 'bot'; bot: Bot }
  | { type: 'computer'; state: ComputerState }
  | { type: 'routines'; botId: string }
  | { type: 'tasks'; botId: string }
  | { type: 'memories'; botId: string }
  | { type: 'connections' }
  | { type: 'model-settings' }
  | { type: 'notify'; notification: AppNotification }
  | { type: 'ping' };

export type NotificationKind = 'finished' | 'approval' | 'question' | 'error' | 'bot-message' | 'routine' | 'learned';

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  botId?: string;
  /** Display name of the bot this is about, so banners can lead with who it is. */
  botName?: string;
  /** One-line status for the banner, e.g. "Has a question" or "Needs your OK". */
  status?: string;
  title: string;
  body: string;
  at: number;
}

export interface NotificationSettings {
  /** Banners on the Mac (or any open browser) when Marion Agent is in the background. */
  desktop: boolean;
  /** Web push to paired iPhones and other devices that turned notifications on. */
  push: boolean;
  /** Which events notify. */
  events: Record<NotificationKind, boolean>;
  /** Include the message text in the banner (off = "Barry finished" only). */
  previews: boolean;
  /** Quiet hours in local "HH:MM" (both empty = off). Push only. */
  quietStart: string;
  quietEnd: string;
  /** Play the interface sound with desktop banners. */
  sound: boolean;
}
