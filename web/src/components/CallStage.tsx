import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, PhoneOff } from 'lucide-react';
import type { Bot } from '@shared/types';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { botVars } from '../lib/colors';
import { endLocalCall, interruptLocalCall, localCallLevel, sendLocalCallDraft, toggleLocalMute, useLocalCall, type LocalCallStatus } from '../voice/localCall';

const labels: Record<LocalCallStatus, string> = {
  idle: '', ringing: 'Calling…', speaking: 'Speaking', listening: 'Listening', hearing: 'Listening…',
  transcribing: 'Got it…', thinking: 'Thinking…', error: 'Call ended',
};

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** The call screen at the top of the chat while a voice call with this bot is on. */
export function CallStage({ bot }: { bot: Bot }) {
  const call = useLocalCall();
  const [now, setNow] = useState(Date.now());
  const avatar = useRef<HTMLDivElement>(null);
  const mine = call.botId === bot.id && call.status !== 'idle';
  const [leaving, setLeaving] = useState(false);
  const [shown, setShown] = useState(mine);

  // Keep the stage mounted for its exit animation.
  useEffect(() => {
    if (mine) { setShown(true); setLeaving(false); return; }
    if (!shown) return;
    setLeaving(true);
    const timer = setTimeout(() => { setShown(false); setLeaving(false); }, 260);
    return () => clearTimeout(timer);
  }, [mine]);

  useEffect(() => {
    if (!call.startedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [call.startedAt]);

  // Voice level drives the rings without re-rendering every frame.
  useEffect(() => {
    if (!mine) return;
    let frame = 0;
    let level = 0;
    const tick = () => {
      level = level * 0.75 + localCallLevel() * 0.25;
      avatar.current?.style.setProperty('--level', level.toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [mine]);

  if (!shown) return null;
  const status = call.draft && call.status === 'listening' && !call.muted ? 'Listening for you to continue' : call.status === 'error' ? call.error ?? 'Call ended' : call.muted && call.status === 'listening' ? 'Muted' : labels[call.status];
  const live = call.status !== 'error' && call.status !== 'ringing';
  return (
    <section className={`call-stage is-${call.status}${leaving ? ' is-leaving' : ''}${call.muted ? ' is-muted' : ''}`} style={botVars(bot.avatarColor)} aria-label={`Call with ${bot.name}`}>
      <div className="call-stage__avatar" ref={avatar} onClick={call.status === 'speaking' ? interruptLocalCall : undefined}
        title={call.status === 'speaking' ? 'Tap to interrupt' : undefined}>
        <span className="call-stage__ring call-stage__ring--1" aria-hidden />
        <span className="call-stage__ring call-stage__ring--2" aria-hidden />
        <span className="call-stage__ring call-stage__ring--3" aria-hidden />
        <BotAvatarFor bot={bot} size={56} />
      </div>
      <div className="call-stage__info">
        <div className="call-stage__name">
          {bot.name}
          {call.startedAt && live && <span className="call-stage__time">{fmt(now - call.startedAt)}</span>}
        </div>
        <div className="call-stage__status" aria-live="polite">
          {(call.status === 'thinking' || call.status === 'transcribing') && <span className="call-stage__dots" aria-hidden><i /><i /><i /></span>}
          <span>{status}</span>{call.modelLabel && live ? <span className="call-stage__model"> · {call.modelLabel}</span> : null}
        </div>
        {call.caption && <p className={`call-stage__caption is-${call.caption.role}`} key={call.caption.text}>{call.caption.text}</p>}
        {call.draft && call.status === 'listening' && <button type="button" className="link-btn link-btn--small" onClick={sendLocalCallDraft}>Send now</button>}
      </div>
      <div className="call-stage__actions">
        {call.status !== 'error' && (
          <button type="button" className={`call-stage__btn${call.muted ? ' is-on' : ''}`} onClick={toggleLocalMute} aria-pressed={call.muted}
            aria-label={call.muted ? 'Unmute' : 'Mute'} title={call.muted ? 'Unmute' : 'Mute'}>
            {call.muted ? <MicOff size={18} /> : <Mic size={18} />}
          </button>
        )}
        <button type="button" className="call-stage__btn call-stage__btn--end" onClick={() => call.status === 'error' ? useLocalCall.setState({ status: 'idle', botId: null, error: null }) : endLocalCall()}
          aria-label={call.status === 'error' ? 'Dismiss' : 'End call'} title={call.status === 'error' ? 'Dismiss' : 'End call'}>
          <PhoneOff className="call-handset" size={18} />
        </button>
      </div>
    </section>
  );
}
