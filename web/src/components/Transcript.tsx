import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { copyText } from '../lib/clipboard';
import type { Bot, LiveState, MessageBody, Row, ToolCallBody } from '@shared/types';
import { Film, Paperclip } from 'lucide-react';
import { api } from '../lib/api';
import { DEFAULT_BERRY } from '@shared/avatarShapes';
import { BotAvatar, BotAvatarFor } from '../avatar/BotAvatar';
import { clock, dividerLabel } from '../lib/time';
import { useStore } from '../store';
import { useConfigUI } from '../configStore';
import { ActivityLine } from './ActivityLine';
import { CardRow } from './cards/Cards';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { usageLabel } from '../lib/modelUsage';
import { useContextMenu } from './ContextMenu';
import { quoteText, useMessageActions } from '../lib/messageActions';
import { isBlankQuery } from '../lib/chatSearch';
import { useChatSearch } from '../lib/chatSearchStore';
import { useChatSearchHighlights } from '../lib/chatSearchDom';

/** A screen recording in a message. If the browser can't decode it (e.g. HEVC .mov), it becomes a download chip instead of a blank player. */
function ChatVideo({ url, name }: { url: string; name: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <a href={url} download={name} className="bubble__file"><Film size={15} /> {name}</a>;
  return <video src={url} controls preload="metadata" muted playsInline title={name} className="bubble__video" onError={() => setFailed(true)} />;
}

type Item =
  | { kind: 'divider'; key: string; ts: number }
  | { kind: 'group'; key: string; side: 'left' | 'right'; from?: MessageBody['from']; rows: Row[] }
  | { kind: 'steps'; key: string; rows: Row[] }
  | { kind: 'row'; key: string; row: Row };

const DIVIDER_GAP = 60 * 60 * 1000;
const GROUP_GAP = 5 * 60 * 1000;

/** Turns rows into render items: date dividers, grouped bubbles, collapsed tool-call steps, cards, events. */
function buildItems(rows: Row[]): Item[] {
  const items: Item[] = [];
  let prevTs = 0;
  for (const row of rows) {
    if (!prevTs || row.createdAt - prevTs > DIVIDER_GAP) items.push({ kind: 'divider', key: `d${row.seq}`, ts: row.createdAt });
    prevTs = row.createdAt;
    const last = items[items.length - 1];
    const b = row.body;
    if (b.type === 'tool-call') {
      if (last?.kind === 'steps') last.rows.push(row);
      else items.push({ kind: 'steps', key: `s${row.seq}`, rows: [row] });
      continue;
    }
    if (b.type === 'message') {
      if (!b.text && !b.streaming && !b.attachments?.length) continue;
      const side = b.role === 'user' && (!b.from || b.from.kind === 'voice') ? 'right' : 'left';
      const sender = b.from ? `${b.from.kind}:${b.from.id}` : b.role;
      const lastRow = last?.kind === 'group' ? last.rows[last.rows.length - 1] : null;
      const lastBody = lastRow?.body as MessageBody | undefined;
      const lastSender = lastBody ? (lastBody.from ? `${lastBody.from.kind}:${lastBody.from.id}` : lastBody.role) : null;
      if (last?.kind === 'group' && lastSender === sender && row.createdAt - lastRow!.createdAt < GROUP_GAP) last.rows.push(row);
      else items.push({ kind: 'group', key: `g${row.seq}`, side, from: b.from, rows: [row] });
      continue;
    }
    items.push({ kind: 'row', key: `r${row.seq}`, row });
  }
  return items;
}

function cornerClass(i: number, n: number) {
  if (n < 2) return '';
  if (i === 0) return ' is-first';
  if (i === n - 1) return ' is-last';
  return ' is-mid';
}

const Bubble = memo(function Bubble({ row, side, pos }: { row: Row; side: 'left' | 'right'; pos: string }) {
  const b = row.body as MessageBody;
  const contextMenu = useContextMenu();
  const showTokens = useConfigUI(s => s.showTokenStats);
  const botName = useStore(s => s.bots.find(bot => bot.id === row.botId)?.name ?? 'Bot');
  const quoted = b.replyTo;
  return (
    <div className={`bubble-wrap is-${side}`} data-seq={row.seq}>
      <div className={`bubble is-${side === 'right' ? 'user' : 'agent'}${pos}${b.streaming ? ' is-streaming' : ''}`}
        {...contextMenu('Message actions', () => {
          const selection = window.getSelection()?.toString();
          const who = b.role === 'user' && !b.from ? 'You' : b.from?.name ?? botName;
          return [
            ...(selection ? [{ label: 'Copy selection', onSelect: () => copyText(selection) }] : []),
            ...(b.text ? [{ label: 'Copy message', onSelect: () => copyText(b.text) }] : []),
            ...(b.text || b.attachments?.length ? [{ label: 'Reply', onSelect: () => useMessageActions.getState().setReply(row.botId, { seq: row.seq, name: who, text: quoteText(b.text) || 'Attachment' }) }] : []),
            ...(b.text ? [{ label: 'Forward…', onSelect: () => useMessageActions.getState().setForward({ fromBotId: row.botId, fromName: botName, text: b.text }) }] : []),
          ];
        }, { longPress: true })}>
        {b.forwarded && <div className="bubble__forwarded">Forwarded from {b.forwarded.name}</div>}
        {quoted && (
          <button type="button" className="bubble__reply" title="Show the message" onClick={() => {
            const target = document.querySelector<HTMLElement>(`.bubble-wrap[data-seq="${quoted.seq}"]`);
            target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }}>
            <span className="bubble__reply-name">{quoted.name}</span>
            <span className="bubble__reply-text">{quoteText(quoted.text, 160)}</span>
          </button>
        )}
        {!!b.attachments?.length && <div className="bubble__attachments">
          {b.attachments.map(file => {
            const url = api.attachmentUrl(row.botId, file.id);
            if (file.mime.startsWith('video/')) return <ChatVideo key={file.id} url={url} name={file.name} />;
            return file.mime.startsWith('image/')
              ? <a key={file.id} href={url} download={file.name} title={`Download ${file.name}`}><img src={url} alt={file.name} loading="lazy" /></a>
              :<a key={file.id} href={url} download={file.name} className="bubble__file"><Paperclip size={15} /> {file.name}</a>;
          })}
        </div>}
        {side === 'right' ? (b.text && <div className="bubble__plain">{b.text}</div>) : <Markdown text={b.text || ' '} />}
        {b.citations && b.citations.length > 0 && (
          <div className="bubble__cites">
            {b.citations.filter((c) => /^https?:\/\//i.test(c.url)).slice(0, 6).map((c, i) => {
              let host = c.url;
              try { host = new URL(c.url).hostname.replace(/^www\./, ''); } catch { /* keep */ }
              return <a key={i} className="cite-chip" href={c.url} target="_blank" rel="noreferrer noopener" title={c.title ?? c.url}>{host}</a>;
            })}
          </div>
        )}
      </div>
      {side === 'left' && showTokens && !b.streaming && !!b.usage?.length && (
        <div className="bubble__usage" aria-label="Response usage" tabIndex={-1}
          {...contextMenu('Token counts', () => [
            { label: 'Copy token counts', onSelect: () => copyText(b.usage!.map(u => `${u.label || u.model || u.provider} · ${usageLabel(u)}`).join('\n')) },
            { label: 'Hide token counts', onSelect: () => useConfigUI.getState().setShowTokenStats(false) },
          ])}>
          {b.usage.map(usage => <span key={`${usage.provider}:${usage.model}`} title={usage.model}>
            {usage.label || usage.model || usage.provider} · {usageLabel(usage)}
          </span>)}
        </div>
      )}
      <span className="bubble__time">{clock(row.createdAt)}</span>
    </div>
  );
});

function SenderLabel({ from }: { from: NonNullable<MessageBody['from']> }) {
  const bot = useStore((s) => (from.kind === 'bot' ? s.bots.find((b) => b.id === from.id) : undefined));
  return (
    <div className="sender-label">
      {from.kind === 'model' ? <img className="sender-label__provider" src={`/providers/${({ local: 'qwen-color', codex: 'codex', gemini: 'gemini-color', claude: 'claude-color' } as const)[from.provider ?? 'local']}.svg`} alt="" width="14" height="14" />
        : bot ? <BotAvatarFor bot={bot} size={16} /> : from.kind === 'routine' ? <Icon name="clock" size={12} opacity={0.56} /> : from.kind === 'voice' ? <Icon name="voice_a" size={12} opacity={0.56} /> : <BotAvatar shape={DEFAULT_BERRY} color="gray" size={16} />}
      <span>{from.kind === 'model' ? `${from.name} · team member` : from.kind === 'routine' ? `Routine · ${from.name}` : from.kind === 'voice' ? 'Asked on a voice call' : `From ${bot?.name ?? from.name}`}</span>
    </div>
  );
}

function Steps({ rows, hideRunning }: { rows: Row[]; hideRunning: boolean }) {
  const [open, setOpen] = useState(false);
  const calls = rows.map((r) => r.body as ToolCallBody);
  const visible = hideRunning ? calls.filter((c) => c.status !== 'running') : calls;
  if (!visible.length) return null;
  const n = visible.length;
  return (
    <div className={`steps${open ? ' is-open' : ''}`}>
      <button type="button" className="steps__toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        {n} {n === 1 ? 'step' : 'steps'}
        <Icon name="chev_down" size={10} opacity={0.66} className="steps__chev" />
      </button>
      {open && (
        <ul className="steps__list">
          {visible.map((c) => (
            <li key={c.callId} className={`step is-${c.status}`}>
              <span className="step__dot" />
              <span className="step__label">{c.label}</span>
              {c.summary && <span className="step__summary">{c.summary}</span>}
              {c.status === 'error' && <span className="step__summary">Failed</span>}
              {c.status === 'denied' && <span className="step__summary">Not allowed</span>}
              {c.screenshot && <img className="step__shot" src={c.screenshot} alt="" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SystemRow({ row }: { row: Row }) {
  const b = row.body;
  if (b.type === 'event') return <div className="system-event">{b.text}</div>;
  if (b.type === 'notice') return <div className={`notice is-${b.tone ?? 'info'}`}>{b.text}</div>;
  if (b.type === 'card') return <CardRow row={row} />;
  return null;
}

const PAGE = 60;

interface Props { bot: Bot; rows: Row[]; live: LiveState | undefined; loaded: boolean }

export function Transcript({ bot, rows, live, loaded }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const allItems = useMemo(() => buildItems(rows), [rows]);
  // Only draw the newest part of a long chat (switching bots used to lay out the whole history at once).
  // Older messages are added as you scroll up, keeping your place.
  const [win, setWin] = useState({ bot: bot.id, limit: PAGE });
  const baseLimit = win.bot === bot.id ? win.limit : PAGE;
  // While searching, every message is drawn so each match can be found and scrolled to; the wider window is kept after.
  const searching = useChatSearch(s => s.open && !isBlankQuery(s.query));
  const limit = searching ? Math.max(baseLimit, allItems.length) : baseLimit;
  useEffect(() => { if (searching && baseLimit < allItems.length) setWin({ bot: bot.id, limit: allItems.length }); }, [searching, baseLimit, allItems.length, bot.id]);
  const items = allItems.length > limit ? allItems.slice(allItems.length - limit) : allItems;
  const hidden = allItems.length - items.length;
  const keepPlace = useRef<number | null>(null);

  const running = !!live?.isRunning;
  const waiting = !running && (!!live?.awaiting || live?.activity?.kind === 'waiting_for_you');
  const last = rows[rows.length - 1];
  const streamingNow = last?.body.type === 'message' && last.body.role === 'assistant' && !!last.body.streaming;
  const showActivity = (running && !streamingNow) || waiting;

  // Keep pinned to the bottom while new content arrives, unless the user scrolled up.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (keepPlace.current !== null) { el.scrollTop = el.scrollHeight - keepPlace.current; keepPlace.current = null; }
    else if (stick.current) el.scrollTop = el.scrollHeight;
  });
  // Jump to bottom when switching bots.
  useLayoutEffect(() => {
    stick.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [bot.id]);

  // Search highlights, and the glide to the current match (which must not be undone by "stay at the bottom").
  useChatSearchHighlights(scrollRef, bot.id, () => { stick.current = false; });

  const onScroll = () => {
    const el = scrollRef.current!;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    stick.current = dist < 40;
    setShowJump(dist > 200);
    if (hidden > 0 && el.scrollTop < 400 && keepPlace.current === null) {
      keepPlace.current = el.scrollHeight - el.scrollTop;
      setWin({ bot: bot.id, limit: limit + PAGE });
    }
  };

  const jump = () => {
    const el = scrollRef.current!;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  return (
    <div className="transcript-wrap">
    <div className="transcript" ref={scrollRef} onScroll={onScroll}>
      <div className="transcript__col">
        {loaded && rows.length === 0 && <EmptyChat bot={bot} />}
        {items.map((it) => {
          switch (it.kind) {
            case 'divider':
              return <div key={it.key} className="divider">{dividerLabel(it.ts)}</div>;
            case 'steps':
              return <Steps key={it.key} rows={it.rows} hideRunning={running} />;
            case 'row':
              return <SystemRow key={it.key} row={it.row} />;
            case 'group':
              return (
                <div key={it.key} className={`group is-${it.side}`}>
                  {it.from && <SenderLabel from={it.from} />}
                  {it.rows.map((r, i) => (
                    <Fragment key={r.seq}><Bubble row={r} side={it.side} pos={cornerClass(i, it.rows.length)} /></Fragment>
                  ))}
                </div>
              );
          }
        })}
        {showActivity && live && <ActivityLine bot={bot} live={live} rows={rows} />}
      </div>
    </div>
      {showJump && (
        <button type="button" className="jump-btn" onClick={jump} aria-label="Scroll to bottom">
          <Icon name="arrow_down" size={16} />
        </button>
      )}
    </div>
  );
}

function EmptyChat({ bot }: { bot: Bot }) {
  return (
    <div className="empty-chat">
      <BotAvatarFor bot={bot} size={72} />
      <div className="empty-chat__title">{bot.name}</div>
      <div className="empty-chat__sub">{bot.description || (bot.mode === 'teammate' ? 'A Bot for the whole team. Hand it a task and it will see it through.' : 'Your personal assistant. Hand it a task and it will see it through.')}</div>
    </div>
  );
}
