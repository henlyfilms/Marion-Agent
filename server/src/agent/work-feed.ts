import { now } from '../db.js';
import { agentSettings } from '../features/agent-settings.js';
import { appendRow, getBotRow, getRow, updateRow } from '../store.js';
import type { WorkAgent, WorkCardBody, WorkPhase, WorkStep, WorkUsage } from '../types.js';
import { modelLabel as shortModelLabel } from './subscriptions.js';
import { notify } from '../features/notify.js';

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

  constructor(private readonly botId: string, userId: string, init: { title: string; detail?: string; agents: WorkAgent[]; phases?: string[]; reporter?: string }) {
    this.live = agentSettings(userId).liveFeed;
    this.body = {
      type: 'card', card: 'work', title: init.title.slice(0, 160), ...(init.detail ? { detail: init.detail.replace(/\s+/g, ' ').trim().slice(0, 240) } : {}), reporter: init.reporter, agents: init.agents,
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

  /** The model the CLI actually runs (it can differ from the pick: account fallback, fast mode), kept on the card. */
  setModel(agentId: string, model: { provider: WorkAgent['provider']; model: string; label?: string; effort?: string | null }) {
    const agent = this.body.agents.find(a => a.id === agentId);
    if (!agent) return;
    const modelLabel = shortModelLabel(model.provider, model.model, model.label);
    const effort = model.effort ?? null;
    if (agent.model === model.model && agent.modelLabel === modelLabel && agent.effort === effort) return;
    Object.assign(agent, { model: model.model, modelLabel, effort });
    this.schedule();
  }

  /** One agent's task usage and session context, live while it runs (batched like every other update). */
  setUsage(agentId: string, usage: WorkUsage) {
    const agent = this.body.agents.find(a => a.id === agentId);
    if (!agent) return;
    agent.usage = usage;
    this.schedule();
  }

  /** A callback for subscriptionReply's onTaskUsage, tagged with one agent. */
  usage(agentId: string) {
    return (usage: WorkUsage) => this.setUsage(agentId, usage);
  }

  /** A link for this run (e.g. "Open in Claude" for a Cloud session); one per label. */
  setLink(label: string, url: string) {
    if (!/^https:\/\//.test(url)) return;
    this.body.links = [...(this.body.links ?? []).filter(link => link.label !== label), { label: label.slice(0, 40), url }];
    this.schedule();
  }

  /** What the card's Stop button ends while the run is going. */
  setStop(stop: WorkCardBody['stop']) {
    this.body.stop = stop;
    this.schedule();
  }

  finish(status: WorkCardBody['status'], question?: string, options?: string[]) {
    this.body.status = status;
    // The finished card keeps the final numbers, no longer marked live.
    for (const agent of this.body.agents) if (agent.usage) agent.usage = { ...agent.usage, live: false };
    this.body.endedAt = now();
    if (question) this.body.question = question.slice(0, 1200);
    if (question && options?.length) this.body.options = options.slice(0, 6);
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
    updateRow(this.botId, this.seq, { ...this.body, agents: this.body.agents.map(a => ({ ...a })), steps: [...this.body.steps], phases: this.body.phases.map(p => ({ ...p })),
      ...(this.body.links ? { links: this.body.links.map(link => ({ ...link })) } : {}) });
  }
}

const MINI_TITLE_MAX = 56;
const POLITE = /^(?:please|pls|kindly|hey|hi|ok(?:ay)?|so|now|then|and|go ahead and|can you|could you|would you|will you|can we|could we|i need you to|i want you to|i'd like you to|i would like you to|you should|you need to|let's|lets|help me)\s+/i;

/**
 * A short label for what a relayed agent is working on, for the work card. A given title wins; otherwise it is
 * the request's first sentence with the polite lead-in, markdown and links removed, cut at a word boundary.
 */
export function miniTitle(prompt: unknown, given?: unknown): string {
  const tidy = (value: string) => value.replace(/https?:\/\/\S+/g, ' ').replace(/[`*_#>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  const fit = (value: string) => {
    const text = value.replace(/[\s.,;:!?-]+$/, '');
    if (text.length <= MINI_TITLE_MAX) return text;
    const head = text.slice(0, MINI_TITLE_MAX + 1);
    const space = head.lastIndexOf(' ');
    return `${head.slice(0, space > 24 ? space : MINI_TITLE_MAX).replace(/[\s.,;:!?-]+$/, '')}…`;
  };
  const upper = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
  const explicit = tidy(String(given ?? ''));
  if (explicit) return upper(fit(explicit));
  const lines = String(prompt ?? '').split('\n').map(line => tidy(line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''))).filter(line => line.length > 2);
  let first = lines[0] ?? '';
  // First sentence only (a colon ends it too: "Fix the login: it fails when…").
  first = first.split(/(?<=[.!?])\s|:\s|,\s+(?:and\s+)?then\s|\s+and then\s/i)[0];
  for (let guard = 0; guard < 4 && POLITE.test(first); guard++) first = first.replace(POLITE, '');
  return upper(fit(first)) || 'Working on a request';
}

/** A CLI's final reply that ends by asking the owner something: relay it as a question. */
export function trailingQuestion(text: string) {
  const tail = text.trim().split(/\n\s*\n/).at(-1)?.trim() ?? '';
  if (!tail.endsWith('?') || tail.length > 600) return '';
  return /\b(would you like|do you want|should i|shall i|may i|could you|can you|can i|which|what|ok(ay)? to|approve|please (confirm|choose|let me know))\b/i.test(tail) ? tail : '';
}

/** Told to every relayed Claude/Codex/Gemini run, so a question comes back in a shape Marion turns into an action card. */
export const ASK_OWNER_LINE = 'If you need the owner\'s approval, a decision or a missing detail before going on, stop and end your reply with one short question as its own last paragraph, then a final line "Options: first | second | third" (2-4 short choices). Otherwise finish the work without asking.';

const APPROVAL = /\b(approve|ok(ay)? to|go ahead|proceed|permission|allow me|may i|shall i|should i|can i|do you want me to|want me to|confirm)\b/i;

/**
 * A relayed CLI's reply that needs the owner: its closing question plus choices for an action card. Choices come
 * from an "Options: a | b" line or a short list under the question; a yes/no approval gets Approve/Don't approve.
 */
export function ownerRequest(text: string): { question: string; options: string[] } | null {
  const lines = text.trim().split('\n');
  let options: string[] = [];
  const last = lines.at(-1)?.trim() ?? '';
  const marker = /^\**options?\**\s*[:\-]\s*(.+)$/i.exec(last);
  if (marker) {
    options = marker[1].split(/\s*\|\s*|\s*\/\s*/).map(o => o.replace(/^[`*_"']+|[`*_"'.]+$/g, '').trim()).filter(Boolean);
    lines.pop();
  } else {
    // A short bulleted/numbered list after the question ("1. Keep it", "- Replace it").
    const list: string[] = [];
    while (lines.length && /^\s*(?:[-*•]|\d+[.)]|[A-D][.)])\s+\S/.test(lines.at(-1)!)) list.unshift(lines.pop()!.replace(/^\s*(?:[-*•]|\d+[.)]|[A-D][.)])\s+/, '').replace(/\*\*/g, '').trim());
    if (list.length >= 2 && list.length <= 6 && list.every(item => item.length <= 80)) options = list;
    else lines.push(...list.map(item => `- ${item}`));
  }
  const body = lines.join('\n').trim();
  const question = options.length ? (body.split(/\n\s*\n/).at(-1)?.trim().split('\n').at(-1)?.trim() ?? '') : trailingQuestion(body);
  if (!question || !question.endsWith('?') || question.length > 600) return null;
  if (!options.length && !trailingQuestion(question)) return null;
  if (!options.length && APPROVAL.test(question)) options = ['Approve', "Don't approve"];
  return { question, options: [...new Set(options)].slice(0, 6).map(o => o.slice(0, 80)) };
}

/** An interactive question card (tap an option or answer in your own words), plus the usual notification. */
export function showQuestionCard(botId: string, userId: string, question: string, options: string[] = []) {
  appendRow(botId, 'card', { type: 'card', card: 'question', question, options: options.slice(0, 6), status: 'pending' });
  const asking = getBotRow(botId);
  if (asking && !asking.hidden) notify(userId, { kind: 'question', botId, title: `${asking.name} has a question`, body: question });
}
