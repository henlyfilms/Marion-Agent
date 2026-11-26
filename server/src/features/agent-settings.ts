import type { ChatModelSelection } from '../types.js';
import { getSetting, setSetting } from './schema.js';

/**
 * App-wide switches for how bots work (Settings → General → Bots):
 * - appControl: every bot can change Marion Agent itself (bots, colors, models, teams) with marion_app.
 * - liveFeed: work cards show what Claude, Codex and Gemini are doing, step by step.
 * - recordingDays: how long Teach-by-recording drafts are kept.
 * All three default on / 7 days.
 */
export interface AgentSettings { appControl: boolean; liveFeed: boolean; recordingDays: number; autoHandoff: boolean; handoffFallback: ChatModelSelection | null }
export const AGENT_DEFAULTS: AgentSettings = { appControl: true, liveFeed: true, recordingDays: 7, autoHandoff: false, handoffFallback: null };
export const RECORDING_DAY_OPTIONS = [1, 3, 7, 14, 30, 90];

export const agentSettings = (userId: string) => getSetting<AgentSettings>(userId, 'agent-settings', AGENT_DEFAULTS);

export function saveAgentSettings(userId: string, patch: Partial<AgentSettings>) {
  const next = { ...agentSettings(userId) };
  if (typeof patch.appControl === 'boolean') next.appControl = patch.appControl;
  if (typeof patch.liveFeed === 'boolean') next.liveFeed = patch.liveFeed;
  if (typeof patch.autoHandoff === 'boolean') next.autoHandoff = patch.autoHandoff;
  if (patch.handoffFallback !== undefined) next.handoffFallback = patch.handoffFallback;
  if (next.autoHandoff && !next.handoffFallback) throw new Error('Choose a fallback provider, model and effort before turning on Auto-handoff.');
  if (patch.recordingDays !== undefined) {
    if (!RECORDING_DAY_OPTIONS.includes(Number(patch.recordingDays))) throw new Error('Choose how many days to keep recordings.');
    next.recordingDays = Number(patch.recordingDays);
  }
  setSetting(userId, 'agent-settings', next);
  return next;
}
