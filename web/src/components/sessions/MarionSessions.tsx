import type { MarionSession } from '@shared/types';
import { useEffect, useState } from 'react';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { useVersion } from '../../configStore';
import { featuresApi, type MarionSessionFilter, type SessionMessage } from '../../lib/featuresApi';
import { dividerLabel, elapsed, relativeShort } from '../../lib/time';
import { useStore } from '../../store';
import { Icon } from '../Icon';
import { Markdown } from '../Markdown';
import { ProviderLogo } from '../ProviderLogo';

/**
 * Bot chat sessions and relayed agent sessions (Claude, Codex, Gemini) as Marion Agent itself keeps them.
 * Used by the Sessions view (Marion Agent tab, and the Claude Cloud section on This Mac).
 */

/** Relayed agents put to work (asked directly, orchestrated, team, Cloud, handoff): every relayed run except a bot's own chat model replying. */
export const isBuilder = (s: Pick<MarionSession, 'type' | 'kind'>) => s.type === 'relay' && s.kind !== 'subscription_bot';
/** Claude Cloud runs: started from Marion Agent, running on GitHub. */
export const isCloud = (s: Pick<MarionSession, 'kind'>) => s.kind === 'cloud';
/** Row subtitle of a Cloud run: where it runs and on which repository ("Claude Cloud · GitHub owner/repo"). */
export const cloudLabel = (s: Pick<MarionSession, 'folder'>) => ['Claude Cloud', s.folder?.name ? `GitHub ${s.folder.name}` : ''].filter(Boolean).join(' · ');

export const PROVIDER_NAMES = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' } as const;
const KIND_NAMES: Record<string, string> = {
  chat: 'Chat', ask_subscription: 'Asked directly', subscription_bot: 'Chat model', orchestration: 'Orchestrated', team: 'Team', cloud: 'Claude Cloud', handoff: 'Handoff',
};
const STATUS_NAMES: Record<string, string> = {
  running: 'Running', waiting: 'Waiting', completed: 'Done', failed: 'Failed', stopped: 'Stopped', active: 'Current', archived: 'Earlier',
};

const ago = (ts: number) => { const r = relativeShort(ts); return r === 'now' ? 'Just now' : /^\d/.test(r) ? `${r} ago` : r; };
const count = (n: number) => n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

// The last list per filter, so reopening a view shows rows at once instead of a loading state.
const remembered = new Map<string, MarionSession[]>();

/** Live list of sessions: reloads on server events (a relayed agent starts, ends or rotates; a new chat session) and every few seconds. */
export function useMarionSessions(filter: MarionSessionFilter = {}, refreshMs = 10_000) {
  const key = JSON.stringify(filter);
  const version = useVersion('sessions');
  const [sessions, setSessions] = useState<MarionSession[] | null>(remembered.get(key) ?? null);
  useEffect(() => {
    let alive = true;
    setSessions(remembered.get(key) ?? null);
    const { botId, ...rest } = filter;
    const load = () => (botId ? featuresApi.botSessions(botId, rest) : featuresApi.marionSessions(filter))
      .then(r => { remembered.set(key, r.sessions); if (alive) setSessions(r.sessions); })
      .catch(() => { if (alive) setSessions(current => current ?? []); });
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, refreshMs);
    return () => { alive = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version, refreshMs]);
  return sessions;
}

/** Re-render once a second while something is running, so its duration counts up. */
function useTick(active: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);
}

export function StatusBadge({ status }: { status: MarionSession['status'] }) {
  return <span className={`msession-badge is-${status}`}>{status === 'running' && <i aria-hidden />}{STATUS_NAMES[status]}</span>;
}

const live = (s: MarionSession) => s.status === 'running' || s.status === 'waiting';
const durationOf = (s: MarionSession) => live(s) ? Date.now() - s.startedAt : s.durationMs;

function Logo({ s }: { s: MarionSession }) {
  const bot = useStore(state => state.bots.find(b => b.id === s.botId));
  if (s.type === 'relay' && s.provider) {
    return <span className="session-row__logo"><ProviderLogo provider={s.provider} size={18} />{s.status === 'running' && <span className="session-row__live" aria-label="Running" />}</span>;
  }
  return <span className="session-row__logo msession-chatlogo">{bot ? <BotAvatarFor bot={bot} size={26} /> : <Icon name="chat_filled" size={16} />}</span>;
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="msession-fact"><dt>{label}</dt><dd>{children}</dd></div>;
}

function ChatPreview({ s }: { s: MarionSession }) {
  const [messages, setMessages] = useState<SessionMessage[] | null>(null);
  useEffect(() => {
    let alive = true;
    featuresApi.chatSessionMessages(s.botId, s.generation ?? 0).then(r => { if (alive) setMessages(r.messages); }).catch(() => { if (alive) setMessages([]); });
    return () => { alive = false; };
  }, [s.botId, s.generation, s.updatedAt]);
  if (messages === null) return <div className="msession-note">Loading…</div>;
  if (!messages.length) return <div className="msession-note">No messages in this conversation.</div>;
  return (
    <div className="msession-thread">
      {messages.map((m, i) => (
        <div key={i} className={`session-msg is-${m.role}`}>
          <div className="session-msg__bubble">{m.role === 'assistant' ? <Markdown text={m.text} /> : m.text}</div>
        </div>
      ))}
    </div>
  );
}

function Details({ s, onOpenBot }: { s: MarionSession; onOpenBot?: (botId: string) => void }) {
  const relay = s.type === 'relay';
  const tokens = s.tokens ? s.tokens.input + s.tokens.output : 0;
  return (
    <div className="msession-details">
      {relay ? (
        <>
          {s.summary && <div className="msession-block"><h4>{s.status === 'failed' ? 'What happened' : 'Summary'}</h4><p>{s.summary}</p></div>}
          {s.request && s.request !== s.title && <div className="msession-block"><h4>Request</h4><p>{s.request}</p></div>}
          {s.error && s.error !== s.summary && <div className="msession-block is-error"><h4>Error</h4><p>{s.error}</p></div>}
        </>
      ) : <ChatPreview s={s} />}
      <dl className="msession-facts">
        <Detail label="Chat">{s.botName}{s.generation ? ` · conversation ${s.generation}` : ''}</Detail>
        {relay && s.provider && <Detail label="Agent">{PROVIDER_NAMES[s.provider]}{s.agent && s.agent !== PROVIDER_NAMES[s.provider] ? ` · ${s.agent}` : ''}</Detail>}
        {relay && <Detail label="Started by">{KIND_NAMES[s.kind] ?? s.kind}{s.role ? ` · ${s.role}` : ''}</Detail>}
        {relay && (s.modelLabel || s.model) && <Detail label="Model">{s.modelLabel || s.model}{s.effort ? ` · ${s.effort}` : ''}</Detail>}
        {s.kind === 'cloud' && <Detail label="Runs on">Claude Cloud (GitHub)</Detail>}
        {s.cloudUrl && <Detail label="Cloud session"><a href={s.cloudUrl} target="_blank" rel="noreferrer">Open in Claude ↗</a></Detail>}
        {s.folder && <Detail label={s.kind === 'cloud' || /^https:\/\/github\.com\//.test(s.folder.path) ? 'Repository' : 'Folder'}>{/^https:\/\/github\.com\//.test(s.folder.path)
          ? <a href={s.folder.path} target="_blank" rel="noreferrer">{s.folder.name} ↗</a> : <span title={s.folder.path}>{s.folder.name}</span>}</Detail>}
        <Detail label="Started">{dividerLabel(s.startedAt)}</Detail>
        {s.status !== 'running' && s.endedAt && <Detail label="Ended">{dividerLabel(s.endedAt)}</Detail>}
        <Detail label="Duration">{elapsed(durationOf(s))}</Detail>
        {relay && s.calls > 1 && <Detail label="Calls">{s.calls}</Detail>}
        {relay && tokens > 0 && <Detail label="Tokens">{count(tokens)}</Detail>}
        {!relay && s.messageCount != null && <Detail label="Messages">{s.messageCount}</Detail>}
        {relay && s.rotated && <Detail label="Fresh session">Started new because {s.rotated}</Detail>}
      </dl>
      {onOpenBot && <button type="button" className="msession-open" onClick={() => onOpenBot(s.botId)}>Open {s.botName}’s chat</button>}
    </div>
  );
}

export function MarionSessionRow({ s, index, open, onToggle, showBot, onOpenBot }: {
  s: MarionSession; index: number; open: boolean; onToggle: () => void; showBot: boolean; onOpenBot?: (botId: string) => void;
}) {
  useTick(live(s));
  const who = s.type === 'chat'
    ? `${showBot ? `${s.botName} · ` : ''}${s.messageCount ?? 0} message${s.messageCount === 1 ? '' : 's'}`
    : isCloud(s) ? [showBot ? s.botName : '', cloudLabel(s)].filter(Boolean).join(' · ')
    : [showBot ? s.botName : '', s.provider ? PROVIDER_NAMES[s.provider] : '', KIND_NAMES[s.kind] ?? '', s.folder?.name ?? ''].filter(Boolean).join(' · ');
  return (
    <div className={`msession${open ? ' is-open' : ''}`} style={{ animationDelay: `${Math.min(index, 12) * 22}ms` }}>
      <button type="button" className={`session-row${open ? ' is-selected' : ''}`} aria-expanded={open} onClick={onToggle}>
        <Logo s={s} />
        <span className="session-row__text">
          <span className="session-row__title">{isCloud(s) && <span className="msession-cloudtag" title="Claude Cloud: runs on GitHub">Cloud</span>}{s.title}</span>
          <span className="session-row__meta">{who}</span>
        </span>
        <span className="msession-side">
          <StatusBadge status={s.status} />
          <span className="session-row__time">
            {live(s) ? elapsed(durationOf(s)) : s.type === 'relay' && s.durationMs >= 1000 ? `${elapsed(s.durationMs)} · ${ago(s.updatedAt)}` : ago(s.updatedAt)}
          </span>
        </span>
      </button>
      {open && <Details s={s} onOpenBot={onOpenBot} />}
    </div>
  );
}

/** A list of sessions where one row at a time expands to show its details. */
export function MarionSessionList({ sessions, showBot, onOpenBot, onPick }: {
  sessions: MarionSession[]; showBot: boolean; onOpenBot?: (botId: string) => void;
  /** Return true to handle the click yourself (e.g. jump to the chat) instead of expanding the row. */
  onPick?: (s: MarionSession) => boolean;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="session-list">
      {sessions.map((s, i) => (
        <MarionSessionRow key={s.id} s={s} index={i} showBot={showBot} onOpenBot={onOpenBot} open={s.id === openId}
          onToggle={() => { if (onPick?.(s)) return; setOpenId(s.id === openId ? null : s.id); }} />
      ))}
    </div>
  );
}
