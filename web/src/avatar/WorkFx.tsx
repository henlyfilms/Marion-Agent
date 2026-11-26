import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useStore } from '../store';

/**
 * "Working" animation around a bot avatar: a coloured aura (one of six styles) in a colour family built from the
 * bot's own colour. Each bot gets its own style, colours and eye motion from its place in the bot list, so bots
 * working side by side never look the same. The eyes/bob live in workfx.css on `.bot-avatar.is-working`.
 *
 * The aura is drawn in two layers with real depth: the BACK layer renders before the avatar (so the avatar hides
 * it) and the FRONT layer renders after it. Every ring is a tilted, flattened plane; its far half (upper in the
 * plane's own frame) lives in the back layer and its near half in the front layer, so the orbit visibly slips
 * behind the bot and wraps back round in front of it. Everything animates `transform`/`opacity` on plain
 * elements, so the browser runs it on the GPU compositor with no per-frame painting.
 */

export const FX_STYLES = ['halo', 'orbit', 'comet', 'ripple', 'sparkle', 'swirl'] as const;
export type FxStyle = typeof FX_STYLES[number];
const FAMILIES = ['rainbow', 'aurora', 'neon', 'candy'] as const;
type Family = typeof FAMILIES[number];
const EYES = ['scan', 'peek', 'blink'] as const;
export type FxLayer = 'back' | 'front';

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** A bot's place among all bots, oldest first (-1 for previews of bots that don't exist yet). */
function rankOf(bots: { id: string; createdAt: number }[], id: string) {
  if (!bots.some(b => b.id === id)) return -1;
  return [...bots].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).findIndex(b => b.id === id);
}

/**
 * Real bots take their style from their place in the list, so the first six all differ and the next six
 * repeat the styles with another colour family and eyes. Unknown seeds (previews) fall back to a hash.
 */
export function fxFor(seed: string, rank = -1) {
  const h = hash(seed || 'bot');
  const n = rank >= 0 ? rank : h % 997;
  return {
    style: FX_STYLES[n % 6], family: FAMILIES[(n + Math.floor(n / 6)) % 4], eyes: EYES[(n + Math.floor(n / 6)) % 3],
    spin: (h >>> 9) % 2 ? 1 : -1, hueSeed: (h >>> 11) % 360,
  };
}

function hueOf(hex: string): { h: number; s: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return { h: 280, s: 0 };
  const [r, g, b] = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return { h: 0, s: 0 };
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const l = (max + min) / 2;
  return { h: (h * 60 + 360) % 360, s: d / (1 - Math.abs(2 * l - 1)) };
}

/** Colour stops for the aura: always vivid, even for gray/black bots (they borrow a hue from their seed). */
export function fxColors(fill: string, family: Family, hueSeed: number): string[] {
  const { h: base, s } = hueOf(fill);
  const h = s < 0.18 ? hueSeed : base;
  const c = (dh: number, sat = 92, light = 64) => `hsl(${Math.round((h + dh + 360) % 360)} ${sat}% ${light}%)`;
  switch (family) {
    case 'rainbow': return [c(0), c(55), c(130), c(200), c(275)];
    case 'aurora': return [c(-35, 88, 66), c(0), c(40, 95, 62), c(80, 90, 68)];
    case 'neon': return [c(0, 100, 62), c(180, 100, 60), c(0, 100, 74)];
    case 'candy': return [c(0, 95, 76), c(-60, 90, 72), c(60, 95, 74), c(0, 100, 86)];
  }
}

/** One tilted ring. Sizes are percentages of the avatar, so the same rings fit every avatar size. */
interface Ring {
  /** Tilt of the ring's plane, degrees. */
  tilt: number;
  /** Flattening of the plane: 1 is a flat disc facing us, small values are seen nearly edge-on. */
  squash: number;
  /** Centre height and radius, % of the avatar. */
  cy: number;
  r: number;
  /** Seconds per lap and the length of the comet's tail as a fraction of the ring. */
  period: number;
  arc: number;
  /** Negative = starts part-way round, so two comets on one ring chase each other. */
  delay?: number;
}

const RINGS: Record<'halo' | 'orbit' | 'comet' | 'swirl', Ring[]> = {
  halo: [{ tilt: -9, squash: 0.3, cy: 17, r: 44, period: 2.6, arc: 0.66 }, { tilt: -9, squash: 0.3, cy: 17, r: 44, period: 2.6, arc: 0.2, delay: -1.3 }],
  orbit: [{ tilt: -22, squash: 0.34, cy: 52, r: 62, period: 2.3, arc: 0.5 }, { tilt: -22, squash: 0.34, cy: 52, r: 62, period: 2.3, arc: 0.16, delay: -1.15 }],
  comet: [{ tilt: 26, squash: 0.52, cy: 52, r: 59, period: 1.7, arc: 0.55 }, { tilt: 26, squash: 0.52, cy: 52, r: 59, period: 1.7, arc: 0.3, delay: -0.85 }],
  swirl: [{ tilt: 40, squash: 0.36, cy: 52, r: 60, period: 3.1, arc: 0.58 }, { tilt: -40, squash: 0.36, cy: 52, r: 60, period: 3.7, arc: 0.52, delay: -1.5 }],
};
const SPARKS: [x: number, y: number, s: number][] = [[-6, 14, 1], [104, 22, 0.8], [96, 88, 0.7], [2, 80, 0.62], [50, -10, 0.9]];
const STAR = 'M0-9C1 -2 2 -1 9 0C2 1 1 2 0 9C-1 2 -2 1 -9 0C-2 -1 -1 -2 0 -9Z';

export interface WorkFxState { style: FxStyle; eyes: string; spin: number; colors: string[]; size: number; leaving: boolean }

/**
 * Drives the aura for one avatar. It stays mounted briefly after work ends (`leaving`) so it can fade out
 * instead of vanishing. Returns null while idle, and does no store work for avatars that aren't working.
 */
export function useWorkFx(working: boolean, seed: string, fill: string, size: number): WorkFxState | null {
  const rank = useStore(s => working ? rankOf(s.bots, seed) : -1);
  const [lingering, setLingering] = useState(false);
  useEffect(() => {
    if (working) { setLingering(true); return; }
    const timer = setTimeout(() => setLingering(false), 320);
    return () => clearTimeout(timer);
  }, [working]);
  const last = useRef<{ fx: ReturnType<typeof fxFor>; colors: string[] }>();
  if (working) { const fx = fxFor(seed, rank); last.current = { fx, colors: fxColors(fill, fx.family, fx.hueSeed) }; }
  const shown = working || lingering ? last.current : undefined;
  if (!shown) return null;
  return { style: shown.fx.style, eyes: shown.fx.eyes, spin: shown.fx.spin, colors: shown.colors, size, leaving: !working };
}

/** A comet's colour sweep: transparent tail, through the family's colours, to a bright head at the top. */
function sweep(colors: string[], arc: number) {
  const start = (1 - arc) * 360;
  const stops = colors.map((color, i) => `${color} ${(start + (arc * 360 * (i + 1)) / colors.length).toFixed(1)}deg`);
  return `conic-gradient(from 0deg, transparent ${start.toFixed(1)}deg, ${stops.join(', ')})`;
}

type Vars = CSSProperties & Record<`--${string}`, string | number>;

function RingPlane({ ring, fx }: { ring: Ring; fx: WorkFxState }) {
  const style: Vars = {
    left: '50%', top: `${ring.cy}%`, width: `${ring.r * 2}%`, height: `${ring.r * 2}%`,
    transform: `translate(-50%, -50%) rotate(${ring.tilt}deg) scale(${fx.spin}, ${ring.squash})`,
  };
  const turn: Vars = {
    backgroundImage: sweep(fx.colors, ring.arc), '--head': fx.colors[fx.colors.length - 1],
    animationDuration: `${ring.period}s`, animationDelay: `${ring.delay ?? 0}s`,
  };
  return (
    <span className="wfx-plane" style={style}>
      <span className="wfx-turn wfx-turn--glow" style={turn} />
      <span className="wfx-turn" style={turn} />
    </span>
  );
}

function Ripples({ fx }: { fx: WorkFxState }) {
  return (
    <span className="wfx-plane" style={{ left: '50%', top: '88%', width: '96%', height: '96%', transform: 'translate(-50%, -50%) scale(1, 0.3)' }}>
      {fx.colors.slice(0, 3).map((color, i) => (
        <span key={i} className="wfx-ripple" style={{ '--head': color, animationDelay: `${i * 0.7}s` } as Vars} />
      ))}
    </span>
  );
}

function Sparks({ fx, layer }: { fx: WorkFxState; layer: FxLayer }) {
  return (
    <>
      {SPARKS.map(([x, y, scale], i) => (i % 2 === 0) === (layer === 'back') && (
        <span key={i} className="wfx-star" style={{ left: `${x}%`, top: `${y}%`, '--k': scale, animationDelay: `${i * 0.34}s`, color: fx.colors[i % fx.colors.length] } as Vars}>
          <svg viewBox="-10 -10 20 20" aria-hidden><path d={STAR} fill="currentColor" /></svg>
        </span>
      ))}
    </>
  );
}

/** One depth layer of the aura. `back` is rendered before the avatar's body, `front` after it. */
export function WorkFxLayer({ fx, layer }: { fx: WorkFxState; layer: FxLayer }) {
  const rings = fx.style === 'halo' || fx.style === 'orbit' || fx.style === 'comet' || fx.style === 'swirl' ? RINGS[fx.style] : null;
  const style: Vars = { '--s': `${fx.size}px`, '--head': fx.colors[fx.colors.length - 1] };
  return (
    <span className={`work-fx work-fx--${layer} work-fx--${fx.style}${fx.leaving ? ' is-leaving' : ''}`} data-eyes={fx.eyes} data-spin={fx.spin} style={style} aria-hidden>
      {rings?.map((ring, i) => <RingPlane key={i} ring={ring} fx={fx} />)}
      {fx.style === 'ripple' && <Ripples fx={fx} />}
      {fx.style === 'sparkle' && <Sparks fx={fx} layer={layer} />}
    </span>
  );
}
