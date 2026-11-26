import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { AppNotification } from '@shared/types';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { clock } from '../lib/time';
import { plainNotification } from '../lib/notifications';
import { useStore } from '../store';
import { openBotChat } from './botMenuItems';

interface Banner extends AppNotification { leaving?: boolean }

const LIFETIME = 6500;
const MAX = 3;

/** One banner: bot icon, bot name, time, and what the bot needs or reported. Swipe up or sideways to dismiss. */
function BannerCard({ n, onDismiss, index }: { n: Banner; onDismiss: (id: string) => void; index: number }) {
  const bot = useStore(s => s.bots.find(b => b.id === n.botId));
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null);
  const moved = useRef(false);
  const name = n.botName ?? bot?.name ?? 'Marion Agent';
  const body = n.botName || bot ? n.body || n.title : n.body;

  const open = () => {
    if (moved.current) return;
    if (n.botId) openBotChat(n.botId);
    onDismiss(n.id);
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    moved.current = false;
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.id !== e.pointerId) return;
    const dx = e.clientX - drag.current.x;
    const dy = Math.min(0, e.clientY - drag.current.y);
    if (!moved.current && Math.hypot(dx, dy) < 6) return;
    if (!moved.current) e.currentTarget.setPointerCapture(e.pointerId);
    moved.current = true;
    setOffset({ x: dx, y: dy });
  };
  const up = () => {
    drag.current = null;
    if (offset && (Math.abs(offset.x) > 90 || offset.y < -36)) onDismiss(n.id);
    else setOffset(null);
    window.setTimeout(() => { moved.current = false; }, 0);
  };

  return (
    <div className={`notify-banner is-${n.kind}${n.leaving ? ' is-leaving' : ''}${offset ? ' is-dragging' : ''}`} role="status"
      style={{
        '--stack': index,
        transform: offset ? `translate(${offset.x}px, ${offset.y}px)` : undefined,
        opacity: offset ? Math.max(0.2, 1 - Math.abs(offset.x) / 260 + offset.y / 140) : undefined,
      } as React.CSSProperties}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <button type="button" className="notify-banner__body" onClick={open} aria-label={`${name}: ${n.status ?? ''} ${body}`}>
        <span className="notify-banner__icon">
          {bot ? <BotAvatarFor bot={bot} size={44} /> : <img src="/favicon.svg" width="40" height="40" alt="" />}
        </span>
        <span className="notify-banner__text">
          <span className="notify-banner__top">
            <strong>{name}</strong>
            <time dateTime={new Date(n.at).toISOString()}>{clock(n.at)}</time>
          </span>
          {n.status && <span className="notify-banner__status">{n.status}</span>}
          {body && <span className="notify-banner__message">{body}</span>}
        </span>
      </button>
    </div>
  );
}

/** In-app notification banners, stacked at the top like iOS. Replaces the old toast and "finished" pill. */
export function NotificationBanners() {
  const [banners, setBanners] = useState<Banner[]>([]);
  const timers = useRef(new Map<string, number>());

  const dismiss = (id: string) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setBanners(list => list.map(b => (b.id === id ? { ...b, leaving: true } : b)));
    window.setTimeout(() => setBanners(list => list.filter(b => b.id !== id)), 320);
  };
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;

  useEffect(() => {
    const show = (event: Event) => {
      const n = plainNotification((event as CustomEvent<AppNotification>).detail);
      setBanners(list => {
        // A newer banner from the same bot replaces the older one instead of stacking.
        const rest = list.filter(b => !(b.botId && b.botId === n.botId) && b.id !== n.id);
        return [n, ...rest].slice(0, MAX);
      });
      timers.current.set(n.id, window.setTimeout(() => dismissRef.current(n.id), n.kind === 'approval' || n.kind === 'question' ? LIFETIME * 2 : LIFETIME));
    };
    window.addEventListener('marion-agent:toast', show);
    const all = timers.current;
    return () => { window.removeEventListener('marion-agent:toast', show); all.forEach(clearTimeout); };
  }, []);

  if (!banners.length) return null;
  return (
    <div className="notify-stack" aria-live="polite">
      {banners.map((n, index) => <BannerCard key={n.id} n={n} index={index} onDismiss={dismiss} />)}
    </div>
  );
}
