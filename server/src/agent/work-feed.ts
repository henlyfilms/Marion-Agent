import { now } from '../db.js';
import { agentSettings } from '../features/agent-settings.js';
import { appendRow, getBotRow, getRow, updateRow } from '../store.js';
import type { WorkAgent, WorkCardBody, WorkPhase, WorkStep } from '../types.js';

const MAX_STEPS = 60;
const FLUSH_MS = 350;

/**
 * A live "work" card in the chat. It copies what the CLIs already print while they work (commands,
 * edits, reviews), so watching costs no model usage. Updates are batched to one write per ~350ms.
 */
export class WorkCard {
  private seq: number;
  private body: WorkCardBody;
  private timer: NodeJS.Timeout | null = null;
  private readonly live: boolean;

  constructor(private readonly botId: string, userId: string, init: { title: string; agents: WorkAgent[]; phases?: string[]; reporter?: string }) {
    this.live = agentSettings(userId).liveFeed;
    this.body = {
      type: 'card', card: 'work', title: init.title.slice(0, 160), reporter: init.reporter, agents: init.agents,
      phases: (init.phases ?? []).map(title => ({ title: title.slice(0, 80), status: 'pending' })), steps: [], live: this.live, status: 'running', startedAt: now(),
    };
    this.seq = appendRow(botId, 'card', this.body).seq;
  }

  get agents() { return this.body.agents; }

  step(agent: string, kind: WorkStep['kind'], text: string) {
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, 220);
    if (!clean) return;
    // Review/approve/error/question lines always show (they're the story); tool chatter only with the live feed on.
    if (!this.live && !['approve', 'review', 'error', 'question'].includes(kind)) return;
    const last = this.body.steps.at(-1);
    if (last && last.agent === agent && last.text === clean) return;
    this.body.steps.push({ at: now(), agent, kind, text: clean });
    if (this.body.steps.length > MAX_STEPS) this.body.steps.splice(0, this.body.steps.length - MAX_STEPS);
    this.schedule();
  }

  /** A callback for subscriptionReply's onStep, tagged with one agent. */
  feed(agent: string) {
    return (kind: WorkStep['kind'], text: string) => this.step(agent, kind, text);
  }

  setPhases(titles: string[]) {
    this.body.phases = titles.slice(0, 8).map(title => ({ title: title.slice(0, 80), status: 'pending' }));
    this.schedule();
  }

  phase(index: number, status: WorkPhase['status']) {
    const phase = this.body.phases[index];
    if (!phase) return;
    phase.status = status;
    this.schedule();
  }

  addAgent(agent: WorkAgent) {
    if (this.body.agents.some(a => a.id === agent.id)) return;
    this.body.agents.push(agent);
    this.schedule();
  }

  finish(status: WorkCardBody['status'], question?: string) {
    this.body.status = status;
    this.body.endedAt = now();
    if (question) this.body.question = question.slice(0, 1200);
    for (const phase of this.body.phases) if (phase.status === 'running') phase.status = status === 'done' ? 'done' : 'failed';
    this.flush();
  }

  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  private flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    // The chat was cleared meanwhile: nothing to update.
    const row = getRow(this.botId, this.seq);
    if (!row || row.generation !== getBotRow(this.botId)?.generation) return;
    updateRow(this.botId, this.seq, { ...this.body, steps: [...this.body.steps], phases: this.body.phases.map(p => ({ ...p })) });
  }
}

/** A CLI's final reply that ends by asking the owner something: relay it as a question. */
export function trailingQuestion(text: string) {
  const tail = text.trim().split(/\n\s*\n/).at(-1)?.trim() ?? '';
  if (!tail.endsWith('?') || tail.length > 600) return '';
  return /\b(would you like|do you want|should i|could you|can you|which|what|please (confirm|choose|let me know))\b/i.test(tail) ? tail : '';
}
