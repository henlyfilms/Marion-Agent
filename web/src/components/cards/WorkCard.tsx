import { Fragment, useEffect, useState } from 'react';
import { Check, ChevronDown, CircleAlert, CircleHelp, ExternalLink, Eye, FilePen, FileText, Search, Square, Terminal, X } from 'lucide-react';
import { featuresApi } from '../../lib/featuresApi';
import type { WorkAgent, WorkCardBody, WorkStep } from '@shared/types';
import { modelLabel } from '@shared/model-label';
import { ProviderLogo } from '../ProviderLogo';
import { UsageRings } from './UsageRings';

const elapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

const STEP_ICON: Record<WorkStep['kind'], typeof Terminal> = {
  command: Terminal, edit: FilePen, read: FileText, search: Search, note: FileText, review: Eye, approve: Check, error: CircleAlert, question: CircleHelp,
};

const STATUS: Record<WorkCardBody['status'], string> = { running: 'Working', done: 'Done', failed: 'Stopped on an error', stopped: 'Stopped', 'needs-input': 'Needs your input' };

/** Lower-case state for the subtitle: "Claude · Opus 5.5 · working". */
const STATE: Record<WorkCardBody['status'], string> = { running: 'working', done: 'done', failed: 'failed', stopped: 'stopped', 'needs-input': 'needs input' };

/** The exact model on the card ("Opus 5.5", "6.2 Sol"); older cards only stored the ID. */
const modelOf = (agent: WorkAgent) => agent.modelLabel || (agent.model ? modelLabel(agent.provider, agent.model) : '');
const effortName = (effort?: string | null) => effort ? (effort === 'xhigh' ? 'Extra high' : effort[0].toUpperCase() + effort.slice(1)) : '';

const names = (agents: WorkAgent[]) => {
  const counts = new Map<string, number>();
  for (const agent of agents) counts.set(agent.label.replace(/ \d+$/, ''), (counts.get(agent.label.replace(/ \d+$/, '')) ?? 0) + 1);
  return [...counts].map(([name, count]) => count > 1 ? `${name} ×${count}` : name);
};

function AgentChip({ agent, active }: { agent: WorkAgent; active: boolean }) {
  return (
    <span className={`work-node${active ? ' is-active' : ''}`} title={`${agent.label} (${[modelOf(agent) || agent.model, effortName(agent.effort) && `${effortName(agent.effort)} effort`].filter(Boolean).join(', ')})`}>
      <ProviderLogo provider={agent.provider} size={14} />
      <span>{agent.label}</span>
      {modelOf(agent) && modelOf(agent) !== agent.label && <small className="work-node__model">{modelOf(agent)}</small>}
    </span>
  );
}

/** Reporter → orchestrator → subagents, drawn as a small flow. Only for orchestrated work. */
function Flow({ body, activeLabel }: { body: WorkCardBody; activeLabel: string | null }) {
  const lead = body.agents.find(agent => agent.role === 'orchestrator');
  const workers = body.agents.filter(agent => agent.role === 'worker');
  if (!lead) return null;
  return (
    <div className="work-flow" aria-label="How the team is set up">
      {body.reporter && <>
        <span className="work-node is-reporter"><span className="work-node__dot" />{body.reporter}<small>reports</small></span>
        <span className="work-flow__link" aria-hidden="true" />
      </>}
      <span className="work-flow__lead">
        <AgentChip agent={lead} active={body.status === 'running' && activeLabel === lead.label} />
        <small>orchestrates</small>
      </span>
      <span className="work-flow__link" aria-hidden="true" />
      <span className="work-flow__workers">
        {workers.map(worker => <AgentChip key={worker.id} agent={worker} active={body.status === 'running' && activeLabel === worker.label} />)}
        <small>{workers.length === 1 ? 'subagent' : 'subagents'}</small>
      </span>
    </div>
  );
}

function Phases({ phases }: { phases: WorkCardBody['phases'] }) {
  if (!phases.length) return null;
  const done = phases.filter(phase => phase.status === 'done').length;
  return (
    <div className="work-phases">
      <div className="work-phases__head"><span>Phases</span><span>{done} of {phases.length} done</span></div>
      <ol className="work-phases__list">
        {phases.map((phase, index) => (
          <li key={index} className={`work-phase is-${phase.status}`}>
            <span className="work-phase__mark" aria-hidden="true">
              {phase.status === 'done' ? <Check size={11} strokeWidth={3} /> : phase.status === 'failed' ? <X size={11} strokeWidth={3} /> : phase.status === 'running' ? <span className="work-phase__spin" /> : index + 1}
            </span>
            <span className="work-phase__title">{phase.title}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function WorkCard({ body, botId }: { body: WorkCardBody; botId?: string }) {
  const running = body.status === 'running';
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState('');
  const stop = () => {
    if (!botId || !body.stop) return;
    setStopping(true); setStopError('');
    featuresApi.stopCloudSession(botId, body.stop.sessionId).catch((e: Error) => { setStopping(false); setStopError(e.message); });
  };
  const [now, setNow] = useState(Date.now());
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const time = elapsed((body.endedAt ?? Math.max(now, body.startedAt)) - body.startedAt);
  const byLabel = new Map(body.agents.map(agent => [agent.label, agent]));
  const last = body.steps.at(-1);
  const activeLabel = running && last && now - last.at < 20_000 ? last.agent : null;
  const lead = body.agents.find(agent => agent.role === 'orchestrator');
  const workers = body.agents.filter(agent => agent.role === 'worker');
  const who = lead ? `${lead.label} orchestrating ${names(workers).join(', ')}` : names(body.agents).join(' and ');
  const shown = open ? body.steps : body.steps.slice(-4);
  // One relayed assistant: "Claude · Opus 5.5 · working". Teams keep their summary (each chip shows its model).
  const solo = !lead && body.agents.length === 1 ? body.agents[0] : null;
  const soloModel = solo ? modelOf(solo) : '';
  const soloEffort = solo ? effortName(solo.effort) : '';

  return (
    <div className={`work-card is-${body.status}`} role="group" aria-label={`${who}: ${STATUS[body.status]}`}>
      <div className="work-card__head">
        <span className="work-card__logos" aria-hidden="true">
          {[...new Map(body.agents.map(agent => [agent.provider, agent])).values()].slice(0, 3).map(agent => <span key={agent.provider}><ProviderLogo provider={agent.provider} size={14} /></span>)}
        </span>
        <span className="work-card__who" title={body.detail || body.title}>
          <strong className="work-card__title">{body.title}</strong>
          {solo ? (
            <span className="work-card__sub" title={[solo.label, soloModel, soloEffort && `${soloEffort} effort`].filter(Boolean).join(' · ')}>
              {solo.label}
              {soloModel && <> · <span className="work-card__model">{soloModel}</span></>}
              {soloEffort && <span className="work-card__effort"> · {soloEffort.toLowerCase()} effort</span>}
              {` · ${STATE[body.status]}`}
            </span>
          ) : (
            <span>{running ? `${names(body.agents).join(' and ')} ${body.agents.length > 1 ? 'are' : 'is'} working` : `${who}${body.status === 'done' ? ' · done' : ''}`}</span>
          )}
        </span>
        <UsageRings agents={body.agents} />
        <span className={`work-card__status is-${body.status}`}>
          {running && <span className="work-card__pulse" aria-hidden="true" />}
          {running ? time : `${STATUS[body.status]} · ${time}`}
        </span>
      </div>
      <Flow body={body} activeLabel={activeLabel} />
      <Phases phases={body.phases} />
      {body.steps.length > 0 && (
        <div className="work-feed">
          {body.steps.length > 4 && (
            <button type="button" className="work-feed__more" onClick={() => setOpen(!open)} aria-expanded={open}>
              {open ? 'Show less' : `Show all ${body.steps.length} steps`}<ChevronDown size={12} style={{ transform: open ? 'rotate(180deg)' : undefined }} />
            </button>
          )}
          <ul>
            {shown.map((step, index) => {
              const agent = byLabel.get(step.agent);
              const Glyph = STEP_ICON[step.kind] ?? FileText;
              return (
                <Fragment key={`${step.at}:${index}`}>
                  <li className={`work-step is-${step.kind}`}>
                    <span className="work-step__who">{agent ? <ProviderLogo provider={agent.provider} size={13} /> : null}<b>{step.agent}</b></span>
                    <Glyph size={12} className="work-step__icon" aria-hidden="true" />
                    <span className="work-step__text">{step.text}</span>
                  </li>
                </Fragment>
              );
            })}
          </ul>
        </div>
      )}
      {running && (body.live === false || !body.steps.length) && <p className="work-card__quiet">{body.live === false ? 'Working on it. Live steps are off (Settings → General → Bots).' : 'Starting up…'}</p>}
      {body.question && <p className="work-card__question"><CircleHelp size={14} aria-hidden="true" />{body.question}</p>}
      {(!!body.links?.length || (running && body.stop && botId)) && (
        <div className="work-card__actions">
          {body.links?.map(link => (
            <a key={link.url} className="btn btn--secondary btn--sm" href={link.url} target="_blank" rel="noreferrer"><ExternalLink size={12} aria-hidden="true" />{link.label}</a>
          ))}
          {running && body.stop && botId && (
            <button type="button" className="btn btn--secondary btn--sm" disabled={stopping} onClick={stop}><Square size={11} aria-hidden="true" />{stopping ? 'Stopping…' : 'Stop'}</button>
          )}
          {stopError && <span className="work-card__error" role="alert">{stopError}</span>}
        </div>
      )}
    </div>
  );
}
