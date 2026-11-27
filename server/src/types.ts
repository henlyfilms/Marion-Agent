// Shared API contract between server and web (web imports these as types only).

import type { AvatarShapeId, LegacyAvatarShape } from './avatarShapes.js';

/** An icon id: the current catalog, or an id saved by an older version (shown as its replacement). */
export type AvatarShape = AvatarShapeId | LegacyAvatarShape;

/** A named bot color, or a custom six-digit hex color picked with the color picker. */
export type AvatarColor = NamedAvatarColor | `#${string}`;
export type NamedAvatarColor =
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
  /** Soft bloom around the avatar in its own color. */
  avatarGlow?: boolean;
  /** Working animation around the avatar: 'auto' (from the bot's place in the list) or a fixed style. */
  workFx?: 'auto' | 'halo' | 'orbit' | 'comet' | 'ripple' | 'sparkle' | 'swirl';
  /** Uploaded photo (data URL) shown instead of the berry; null = use the berry. */
  avatarImage?: string | null;
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
  /** A short "Got it" sent right away when the user texts a busy bot. Chat-only: never part of the bot's history or its reply. */
  ack?: boolean;
  attachments?: ChatAttachment[];
  /** Set when a message came from another bot, a routine or a voice call rather than the user typing. */
  from?: { kind: 'bot' | 'routine' | 'voice' | 'model'; id: string; name: string; provider?: ChatProvider };
  citations?: { url: string; title?: string }[];
  usage?: ResponseUsage[];
  /** The earlier message this one answers (Message menu → Reply). `text` is a short quote taken by the server. */
  replyTo?: { seq: number; role: 'user' | 'assistant'; name: string; text: string };
  /** Set when the user forwarded this message from another chat (Message menu → Forward). */
  forwarded?: { name: string };
  /** The browser's id for this prompt (offline queue): a retried send with the same id returns this row instead of posting again. */
  clientId?: string;
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
    }
  | WorkCardBody
  | CloudCardBody
  | SignInCardBody
  | { type: 'card'; card: 'handoff'; id: string; provider: RelayProvider; goal: string; status: 'pending' | 'started'; fallback: ChatModelSelection | null };

/** A provider CLI needs the owner to sign in (Gemini → Google): the chat shows this instead of a plain error. */
export interface SignInCardBody {
  type: 'card'; card: 'sign-in'; id: string; provider: 'gemini'; providerName: string;
  /** Why it is shown, in plain words. */
  reason: string;
  /** The Terminal command that signs in (the resolved agy path when Marion found one), shown so it can be copied. */
  command: string;
  status: 'pending' | 'working' | 'signed-in' | 'dismissed';
  note?: string;
}

/** Strict Cloud mode: why Cloud work can't start yet, and the fixes the owner can approve from the card. */
export type CloudBlocker = 'gh-missing' | 'gh-auth' | 'gh-scopes' | 'not-found' | 'ambiguous' | 'no-access' | 'cloud-connect' | 'claude-missing' | 'launch-failed' | 'folder-trust';
export type CloudOptionKind = 'repo' | 'gh-install' | 'gh-login' | 'gh-scopes' | 'create-repo' | 'fork' | 'retry' | 'open' | 'cancel';
export interface CloudOption { id: string; kind: CloudOptionKind; label: string; hint?: string; repo?: string; url?: string }
export type CloudCardStatus = 'pending' | 'working' | 'started' | 'cancelled' | 'allowed' | 'denied' | 'expired';
/** In-app Cloud card: 'setup' shows a repository/access blocker with fixes; 'permission' asks before a running Cloud session uses a tool. */
export interface CloudCardBody {
  type: 'card'; card: 'cloud'; id: string; mode: 'setup' | 'permission';
  goal: string; title?: string; query: string; generation: number;
  blocker?: CloudBlocker; problem: string; solution: string; options: CloudOption[];
  status: CloudCardStatus; note?: string; repo?: string; sessionId?: string;
  device?: { code: string; url: string };
}

/** Who is doing the work in a work card: a model reached through a CLI or a local server. */
export interface WorkAgent {
  id: string; label: string; provider: ChatProvider; model: string; role: 'orchestrator' | 'worker';
  /** The exact model in use, short ("Opus 5.5", "6.2 Sol", "Gemini 4 Neon"); updated once the CLI resolves it. */
  modelLabel?: string;
  effort?: string | null;
  /** What this agent's run used so far (live while it works, kept on the finished card). */
  usage?: WorkUsage;
}

/**
 * One builder run's usage, read from what Claude, Codex or Gemini print while they work (no extra model calls).
 * Tokens follow one convention for every CLI: `input` is fresh (uncached) input, `cached` cache reads,
 * `cacheWrite` cache writes and `output` includes reasoning; `total` is their sum.
 */
export interface WorkUsage {
  tokens: { input: number; cached: number; cacheWrite: number; output: number; reasoning: number; total: number };
  /** API-equivalent cost when the CLI reports one (Claude Code does). */
  costUsd?: number;
  /** A plan limit window the CLI reported during the run: where it started and where it is now. */
  limit?: { label: string; startPercent: number; usedPercent: number; resetsAt?: number };
  /** The session's context: tokens in its latest request and the model's window. */
  context?: { tokens: number; window: number; percent: number; windowKnown: boolean };
  /**
   * 0–100, drives the task ring and its blue → red color: the share of the plan limit this run took when the CLI
   * reported the limit twice, otherwise cost-weighted tokens against a large task budget.
   */
  taskPercent: number;
  taskBasis: 'limit' | 'tokens';
  /** False once the run has finished. */
  live: boolean;
}
export interface WorkStep { at: number; agent: string; kind: 'command' | 'edit' | 'read' | 'search' | 'note' | 'review' | 'approve' | 'error' | 'question'; text: string }
export interface WorkPhase { title: string; status: 'pending' | 'running' | 'done' | 'failed' }

/**
 * Live work from Claude, Codex or Gemini (one assistant, or an orchestrated team). The bot that
 * started it only reports: this card mirrors what the models are doing, at no model cost.
 */
export interface WorkCardBody {
  type: 'card';
  card: 'work';
  /** A short mini title for what the relayed agent is doing (about 56 characters). */
  title: string;
  /** The request it came from (first line), shown as a tooltip. */
  detail?: string;
  /** The chat's own model, which only relays and reports. */
  reporter?: string;
  agents: WorkAgent[];
  phases: WorkPhase[];
  /** Newest last; only reviews, approvals and questions when Settings → Live work steps is off. */
  steps: WorkStep[];
  live: boolean;
  status: 'running' | 'done' | 'failed' | 'stopped' | 'needs-input';
  startedAt: number;
  endedAt?: number;
  question?: string;
  /** Choices offered with the question (also shown as a question card the owner can tap). */
  options?: string[];
  /** Links for the run (e.g. the Claude Cloud session), shown as buttons on the card. */
  links?: { label: string; url: string }[];
  /** A run the card can stop by itself (only shown while it is running). */
  stop?: { kind: 'cloud'; sessionId: string };
}

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

export interface NoticeBody {
  type: 'notice'; text: string; tone?: 'info' | 'warn' | 'error';
  /** An unresolved blocker this card stands for (one card per key): see agent/runner-settings.ts. */
  blocker?: { kind: 'runner_settings'; key: string; provider: string; setting: 'model' | 'effort' };
}

export type ActivityKind =
  | 'thinking' | 'working' | 'searching_web' | 'reading_web' | 'browsing_web' | 'on_its_computer'
  | 'running_commands' | 'waiting_on_command' | 'messaging_named' | 'connecting_service'
  | 'waiting_for_you' | 'drafting_file' | 'remembering' | 'loading_model';

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

/** botId is the assignee (the Bot doing the work); assignedBy is the Bot that handed it out, when another Bot did. */
export interface Task { id: string; botId: string; title: string; state: 'working' | 'needs_input' | 'done'; note: string; updatedAt: number; assignedBy?: string }

export interface Memory { id: string; botId: string; text: string; createdAt: number; source?: 'chat' | 'learned' }

/** A memory shared by every Bot on the user's team (one copy, injected into each prompt). */
export interface UniversalMemory { id: string; text: string; createdAt: number; updatedAt: number; universal: true }

export interface Skill { id: string; botId: string; name: string; description: string; body: string; createdAt: number; updatedAt: number; universal?: false }

/** A skill shared by every Bot on the user's team (one copy, injected into each prompt). */
export interface UniversalSkill { id: string; name: string; description: string; body: string; createdAt: number; updatedAt: number; universal: true }

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

// ---------- sessions (bot chats and relayed agents) ----------

export type RelayProvider = 'claude' | 'codex' | 'gemini';
export type RelayKind = 'ask_subscription' | 'subscription_bot' | 'orchestration' | 'team' | 'cloud' | 'handoff';
/** 'waiting': a Cloud request held by an in-app card (pick a repository, sign in, grant access) before it can start. */
export type RelayStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'stopped';

/**
 * One row of the Sessions views. `type: 'chat'` is one conversation of a bot (a "generation": a new one starts when the
 * chat is cleared); `type: 'relay'` is one run Marion relayed to Claude, Codex or Gemini.
 */
export interface MarionSession {
  id: string;
  type: 'chat' | 'relay';
  kind: 'chat' | RelayKind;
  cloudUrl?: string | null;
  provider: RelayProvider | null;
  /** Chats: 'active' (the conversation on screen) or 'archived' (an earlier one). Relays: running, completed, failed, stopped. */
  status: 'active' | 'archived' | RelayStatus;
  title: string;
  summary: string;
  request: string | null;
  error: string | null;
  botId: string;
  botName: string;
  chatId: string;
  generation: number | null;
  folder: { name: string; path: string } | null;
  model: string | null;
  modelLabel: string | null;
  effort: string | null;
  tokens: { input: number; output: number } | null;
  startedAt: number;
  endedAt: number | null;
  /** Last activity: the newest message of a chat, or when a relayed run last started or finished. */
  updatedAt: number;
  durationMs: number;
  /** Relayed runs: model calls merged into this session (an orchestration makes several). */
  calls: number;
  /** Chats: messages in this conversation. */
  messageCount: number | null;
  role: string | null;
  agent: string | null;
  /** Relayed runs of one provider in one chat share this until Marion rotates to a fresh session. */
  groupId: string | null;
  /** Why this run started a fresh provider session instead of continuing the last one. */
  rotated: string | null;
}

// ---------- statistics (GET /api/stats) ----------

export type StatsRange = '7d' | '30d' | 'all';
export interface StatsTokens { input: number; output: number; total: number }
/** One calendar day of activity. `messages` are the ones the user sent; `runs` are relayed agent runs that started that day. */
export interface StatsDay { date: string; messages: number; runs: number; tokens: number }
export interface StatsBot {
  id: string;
  name: string;
  label: string;
  kind: 'agent' | 'room';
  avatarShape: AvatarShape;
  avatarColor: AvatarColor;
  avatarStemColor: string | null;
  /** Conversations (generations) with at least one message in the range. */
  chats: number;
  /** Messages the user sent to this bot. */
  messages: number;
  /** Every message in the chat (user + replies). */
  totalMessages: number;
  relayedRuns: number;
  tokens: StatsTokens;
  lastActiveAt: number | null;
}
export interface StatsProvider {
  /** 'local' = the built-in chat models; the others are relayed to the Claude, Codex and Gemini CLIs. */
  provider: ChatProvider;
  runs: number;
  completed: number;
  failed: number;
  stopped: number;
  /** completed / finished runs (0–1); null when nothing has finished or the provider isn't relayed. */
  completionRate: number | null;
  tokens: StatsTokens;
  durationMs: number;
}
export interface StatsModel { provider: ChatProvider; model: string; label: string; runs: number; tokens: StatsTokens }
export interface StatsFolder { path: string; name: string; runs: number; tokens: number }
export interface StatsSummary {
  range: StatsRange;
  generatedAt: number;
  /** First and last day of `days` (YYYY-MM-DD, local). */
  from: string;
  to: string;
  /** First day with any counted activity in the whole history (YYYY-MM-DD), or null when there is none. */
  since: string | null;
  streak: { current: number; longest: number; activeDays: number; activeToday: boolean; lastActiveDate: string | null };
  totals: {
    userMessages: number; totalMessages: number; chats: number; relayedRuns: number; completedRuns: number;
    tokens: StatsTokens; agentTimeMs: number; activeDays: number; activeBots: number;
  };
  days: StatsDay[];
  bots: StatsBot[];
  mostWorkedBot: StatsBot | null;
  providers: StatsProvider[];
  models: StatsModel[];
  insights: {
    busiestWeekday: { day: number; count: number } | null;
    peakHour: { hour: number; count: number } | null;
    weekdayCounts: number[];
    hourCounts: number[];
    avgMessagesPerActiveDay: number;
    agentSuccessRate: number | null;
    topFolders: StatsFolder[];
  };
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
  /** A relayed agent session started, finished or rotated (or a bot's chat session changed): Sessions views reload. */
  | { type: 'sessions'; botId?: string }
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
