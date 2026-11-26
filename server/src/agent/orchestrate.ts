import { availableLocalModels } from './models.js';
import { modelReply } from './orchestration.js';
import { subscriptionModels, subscriptionReply, type SubscriptionSelection } from './subscriptions.js';
import { miniTitle, trailingQuestion, WorkCard } from './work-feed.js';
import { leanLine, relayMedia } from './relay.js';
import type { SessionTrack } from '../features/life-outbox.js';
import type { UploadedAttachment } from '../attachments.js';
import { env } from '../env.js';
import { getBotRow } from '../store.js';
import type { ChatModel, ChatModelSelection, ChatProvider, WorkAgent } from '../types.js';

/**
 * orchestrate: the owner names an orchestrator model and one or more subagent models ("use 6.2 Astra
 * as the orchestrator and run Gemini 4 Neon subagents"). The chat's own model only relays the request
 * and reports back; the orchestrator plans the work in phases, the subagents do it (inside a shared
 * folder when one is given), the orchestrator reviews each phase and sends fixes, then writes the
 * report. Everything shows live in one work card.
 */

const MAX_PHASES = 5;
const MAX_TASKS = 4;
const RESULT_CHARS = 6000;
const providerNames: Record<ChatProvider, string> = { local: 'Local', codex: 'Codex', gemini: 'Gemini', claude: 'Claude' };

type Folder = { path: string; label: string; write: boolean };
type Agent = WorkAgent & { selection: ChatModelSelection };

const words = (value: string) => value.toLowerCase().replace(/[^a-z0-9.]+/g, ' ').split(' ').filter(Boolean);

async function catalog(allowSubscriptions: boolean): Promise<ChatModel[]> {
  const local = availableLocalModels().catch((): string[] => []).then(models =>
    [...new Set([env.localModelName, ...models])].map((id): ChatModel => ({ provider: 'local', id, label: id, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' })));
  const subs = allowSubscriptions ? (['codex', 'gemini', 'claude'] as const).map(p => subscriptionModels(p).then(c => c.models).catch((): ChatModel[] => [])) : [];
  return (await Promise.all([local, ...subs])).flat();
}

/** "6.2 Astra", "gemini 4 neon", "claude", "codex" → the best matching model. */
export function matchModel(models: ChatModel[], query: string): ChatModel | undefined {
  const wanted = words(query);
  if (!wanted.length) return undefined;
  const provider = (['codex', 'gemini', 'claude', 'local'] as const).find(p => wanted.length === 1 && (wanted[0] === p || (p === 'codex' && ['chatgpt', 'openai', 'gpt'].includes(wanted[0]))));
  if (provider) return models.find(m => m.provider === provider && m.defaultEffort) ?? models.find(m => m.provider === provider);
  let best: { model: ChatModel; score: number } | undefined;
  for (const model of models) {
    const hay = words(`${providerNames[model.provider]} ${model.label} ${model.id}`).join(' ');
    const hits = wanted.filter(word => hay.includes(word)).length;
    const score = hits / wanted.length + (hay.includes(wanted.join(' ')) ? 0.5 : 0);
    if (hits && (!best || score > best.score)) best = { model, score };
  }
  return best && best.score >= 0.6 ? best.model : undefined;
}

function toAgent(model: ChatModel, role: WorkAgent['role'], index: number, taken: Set<string>): Agent {
  let label = model.label.trim();
  for (let n = 2; taken.has(label); n++) label = `${model.label} ${n}`;
  taken.add(label);
  const effort = model.defaultEffort ?? null;
  return { id: `${role}-${index}`, label, provider: model.provider, model: model.id, role, selection: { provider: model.provider, model: model.id, effort, label: model.label } };
}

function jsonFrom(text: string): any {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return undefined; }
}

async function callAgent(agent: Agent, prompt: string, signal: AbortSignal, card: WorkCard, folder?: Folder, images: UploadedAttachment[] = [], session?: SessionTrack) {
  // No wall-clock limit on a subagent: relayed runs are never timed out; only the owner stopping the run ends one early.
  if (agent.provider === 'local') return modelReply(agent.selection, prompt, signal);
  return (await subscriptionReply(agent.selection as SubscriptionSelection, prompt, signal, images, { folder, onStep: card.feed(agent.label), session })).trim();
}

export async function orchestrate(ctx: { userId: string; botId: string; signal?: AbortSignal; allowSubscriptionTeam?: boolean }, args: any, folder?: Folder) {
  const goal = String(args?.goal ?? '').trim().slice(0, 20_000);
  if (!goal) throw new Error('Describe the work for the team.');
  const models = await catalog(ctx.allowSubscriptionTeam !== false);
  const leadModel = matchModel(models, String(args?.orchestrator ?? ''));
  if (!leadModel) throw new Error(`No model matches "${args?.orchestrator}". Available: ${models.map(m => m.label).slice(0, 20).join(', ')}.`);
  const workerNames: string[] = (Array.isArray(args?.workers) ? args.workers : [args?.workers]).map(String).filter(Boolean).slice(0, MAX_TASKS);
  if (!workerNames.length) throw new Error('Name at least one subagent model.');
  const count = Math.max(1, Math.min(MAX_TASKS, Number(args?.worker_count) || workerNames.length));
  const taken = new Set<string>();
  const lead = toAgent(leadModel, 'orchestrator', 0, taken);
  const workers: Agent[] = [];
  for (let i = 0; i < Math.max(count, workerNames.length); i++) {
    const name = workerNames[i % workerNames.length];
    const model = matchModel(models, name);
    if (!model) throw new Error(`No model matches "${name}". Available: ${models.map(m => m.label).slice(0, 20).join(', ')}.`);
    workers.push(toAgent(model, 'worker', i, taken));
  }
  const signal = ctx.signal ?? new AbortController().signal;
  const bot = getBotRow(ctx.botId);
  // Every call here is its own fresh session (the plan, each task and each review are self-contained), so the
  // owner's screenshots / screen-recording frames travel with the planning and the work, and the Token optimizer
  // line is added once per call. Reviews and the report get neither the images nor the long goal.
  const media = await relayMedia(ctx.botId);
  const lean = leanLine(ctx.botId, Boolean(folder));
  // Each Claude agent in the run is one session in Marion Life (its plan, tasks and reviews are merged into it).
  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const trackFor = (agent: Agent): SessionTrack => ({
    id: `orchestrate:${ctx.botId}:${runId}:${agent.id}`, kind: 'orchestration', userId: ctx.userId, botId: ctx.botId,
    request: goal, title: miniTitle(goal, args?.title), folder: folder && { path: folder.path, label: folder.label },
    role: agent.role, agent: agent.label, groupId: `orchestrate:${ctx.botId}:${runId}`,
  });
  const call = (agent: Agent, prompt: string, stopSignal: AbortSignal, workCard: WorkCard, where?: Folder, withMedia = false) =>
    callAgent(agent, [prompt, withMedia ? media.note : '', lean].filter(Boolean).join('\n\n'), stopSignal, workCard, where, withMedia ? media.images : [], trackFor(agent));
  const brief = goal.length > 2000 ? `${goal.slice(0, 2000)}…` : goal;
  const card = new WorkCard(ctx.botId, ctx.userId, {
    title: miniTitle(goal, args?.title), detail: goal.split('\n')[0], reporter: bot?.name,
    agents: [lead, ...workers].map(({ selection: _selection, ...agent }) => agent),
  });
  const roster = workers.map(w => `- ${w.label} (${providerNames[w.provider]} ${w.model})`).join('\n');
  const where = folder ? `\nThe work happens in the owner's folder "${folder.label}" (${folder.path}). Subagents can ${folder.write ? 'read and change files' : 'only read files'} there; you can read it to check their work.` : '\nThere is no shared folder: subagents reply with text (code, plans, writing) only.';
  const results: string[] = [];
  try {
    // 1. Plan.
    card.step(lead.label, 'note', 'Planning the work');
    const planText = await call(lead, [
      `You are ${lead.label}, the ORCHESTRATOR of a team of AI models inside Marion Agent. You plan, assign and review; the subagents do the work.`,
      `Subagents:\n${roster}`, where, `The owner's goal:\n${goal}`,
      `Split the goal into 1–${MAX_PHASES} phases, in order. Each phase has 1–${MAX_TASKS} tasks that can run at the same time; assign each to a subagent by its exact name, spreading the work. Each task must be self-contained: the subagent sees only its task.`,
      'If you truly cannot start without the owner answering something, set "question" instead of phases.',
      'Reply with JSON only: {"phases":[{"title":"short phase name","tasks":[{"worker":"subagent name","task":"full instructions"}]}],"question":null}',
    ].join('\n\n'), signal, card, folder && { ...folder, write: false }, true);
    const plan = jsonFrom(planText);
    if (plan?.question && !plan?.phases?.length) {
      card.step(lead.label, 'question', String(plan.question));
      card.finish('needs-input', String(plan.question));
      return { output: `${lead.label} needs the owner's answer before starting: ${plan.question}\nAsk the owner this with ask_user, then call orchestrate again with their answer added to the goal.`, summary: 'The orchestrator has a question' };
    }
    const phases: { title: string; tasks: { worker: Agent; task: string }[] }[] = (Array.isArray(plan?.phases) ? plan.phases : []).slice(0, MAX_PHASES).map((phase: any, index: number) => ({
      title: String(phase?.title ?? `Phase ${index + 1}`).slice(0, 80),
      tasks: (Array.isArray(phase?.tasks) ? phase.tasks : []).slice(0, MAX_TASKS).map((task: any, t: number) => ({
        worker: workers.find(w => w.label.toLowerCase() === String(task?.worker ?? '').toLowerCase()) ?? workers[t % workers.length],
        task: String(task?.task ?? '').slice(0, 12_000),
      })).filter((task: { task: string }) => task.task.trim()),
    })).filter((phase: { tasks: unknown[] }) => phase.tasks.length);
    if (!phases.length) phases.push({ title: 'Do the work', tasks: [{ worker: workers[0], task: goal }] });
    card.setPhases(phases.map(p => p.title));
    card.step(lead.label, 'note', `Planned ${phases.length} phase${phases.length === 1 ? '' : 's'}`);

    // 2. Each phase: subagents work in parallel, the orchestrator reviews and may send one round of fixes.
    for (const [index, phase] of phases.entries()) {
      card.phase(index, 'running');
      const run = (tasks: { worker: Agent; task: string }[], extra = '') => Promise.all(tasks.map(async ({ worker, task }) => {
        card.step(worker.label, 'note', `Started: ${task.split('\n')[0]}`);
        try {
          const text = await call(worker, [
            `You are ${worker.label}, a subagent on a team led by ${lead.label} (the orchestrator) inside Marion Agent.`, where,
            `The overall goal:\n${goal}`, results.length ? `Earlier phases produced:\n${results.join('\n\n').slice(-RESULT_CHARS)}` : '', extra,
            `Your task (phase "${phase.title}"):\n${task}`,
            'Do the task completely. Finish with a short summary of exactly what you did or produced (full code when you wrote code and there is no folder).',
          ].filter(Boolean).join('\n\n'), signal, card, folder, true);
          card.step(worker.label, 'note', 'Finished its task');
          return { worker, text };
        } catch (error) {
          if (signal.aborted) throw error;
          card.step(worker.label, 'error', String((error as Error).message ?? error));
          return { worker, text: `FAILED: ${(error as Error).message ?? error}` };
        }
      }));
      let outputs = await run(phase.tasks);
      for (let round = 0; round < 2; round++) {
        card.step(lead.label, 'review', `Reviewing ${phase.title}`);
        const review = jsonFrom(await call(lead, [
          `You are ${lead.label}, the orchestrator. Review the subagents' work for phase "${phase.title}".`, where, `The owner's goal:\n${brief}`,
          `Results:\n${outputs.map(o => `## ${o.worker.label}\n${o.text.slice(0, RESULT_CHARS)}`).join('\n\n')}`,
          round === 0 ? 'Approve if it is correct and complete. Otherwise list precise fixes, each for one subagent.' : 'This is the final check for this phase: approve unless something is badly wrong.',
          'Reply with JSON only: {"approved":true,"note":"one short sentence","fixes":[{"worker":"subagent name","task":"what to fix"}]}',
        ].join('\n\n'), signal, card, folder && { ...folder, write: false })) ?? { approved: true, note: 'Looks good' };
        const fixes = (Array.isArray(review.fixes) ? review.fixes : []).slice(0, MAX_TASKS)
          .map((fix: any, t: number) => ({ worker: workers.find(w => w.label.toLowerCase() === String(fix?.worker ?? '').toLowerCase()) ?? workers[t % workers.length], task: String(fix?.task ?? '') }))
          .filter((fix: { task: string }) => fix.task.trim());
        if (review.approved !== false || !fixes.length || round === 1) {
          card.step(lead.label, 'approve', `Approved ${phase.title}${review.note ? `: ${review.note}` : ''}`);
          break;
        }
        card.step(lead.label, 'review', `Asked for ${fixes.length} fix${fixes.length === 1 ? '' : 'es'}: ${review.note ?? ''}`);
        const fixed = await run(fixes, `The orchestrator reviewed earlier work and asked for this fix. Earlier result:\n${outputs.map(o => `## ${o.worker.label}\n${o.text.slice(0, 2000)}`).join('\n\n')}`);
        outputs = [...outputs, ...fixed];
      }
      results.push(`### ${phase.title}\n${outputs.map(o => `${o.worker.label}: ${o.text.slice(0, RESULT_CHARS / outputs.length)}`).join('\n')}`);
      card.phase(index, outputs.every(o => o.text.startsWith('FAILED')) ? 'failed' : 'done');
      const asked = outputs.map(o => trailingQuestion(o.text)).find(Boolean);
      if (asked) {
        card.step(lead.label, 'question', asked);
        card.finish('needs-input', asked);
        return { output: `The team paused after "${phase.title}" because it needs the owner: ${asked}\nAsk the owner with ask_user, then call orchestrate again with the answer. Work so far:\n${results.join('\n\n').slice(-RESULT_CHARS)}`, summary: 'The team has a question' };
      }
    }

    // 3. Report.
    card.step(lead.label, 'note', 'Writing the report');
    const report = await call(lead, [
      `You are ${lead.label}, the orchestrator. The team finished. Write the final report for the owner: what was done, by whom, what to check, anything left. Short and concrete.`,
      `Goal:\n${brief}`, `Results:\n${results.join('\n\n').slice(-RESULT_CHARS * 2)}`,
    ].join('\n\n'), signal, card, folder && { ...folder, write: false });
    card.finish('done');
    return {
      output: `Team report from ${lead.label} (orchestrator) with ${[...new Set(workers.map(w => w.label))].join(', ')} as subagents:\n\n${report}\n\nYou are only the reporter: pass this on to the owner faithfully and briefly. Don't redo or extend the work yourself.`,
      summary: `${lead.label} and ${[...new Set(workers.map(w => w.label))].join(', ')} finished`,
    };
  } catch (error) {
    card.finish(signal.aborted ? 'stopped' : 'failed');
    throw error;
  }
}
