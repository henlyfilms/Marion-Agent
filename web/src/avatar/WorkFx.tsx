import { useId } from 'react';
import { useStore } from '../store';

/**
 * "Working" animation drawn over a bot avatar: a painted aura (one of six styles) in a colour family built
 * from the bot's own colour. Each bot gets its own style, colours and eye motion from a hash of its id, so
 * bots working side by side never look the same. The eyes/bob live in workfx.css on `.bot-avatar.is-working`.
 */

export const FX_STYLES = ['halo', 'orbit', 'comet', 'ripple', 'sparkle', 'swirl'] as const;
export type FxStyle = typeof FX_STYLES[number];
const FAMILIES = ['rainbow', 'aurora', 'neon', 'candy'] as const;
type Family = typeof FAMILIES[number];
const EYES = ['scan', 'peek', 'blink'] as const;

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

const SPARKS: [x: number, y: number, s: number][] = [[-6, 14, 1], [104, 22, 0.8], [96, 88, 0.7], [2, 80, 0.62], [50, -10, 0.9]];
const STAR = 'M0-9C1 -2 2 -1 9 0C2 1 1 2 0 9C-1 2 -2 1 -9 0C-2 -1 -1 -2 0 -9Z';

export function WorkFx({ seed, fill }: { seed: string; fill: string }) {
  const id = useId().replace(/:/g, '');
  const rank = useStore(s => rankOf(s.bots, seed));
  const fx = fxFor(seed, rank);
  const colors = fxColors(fill, fx.family, fx.hueSeed);
  const grad = `wfx-g${id}`, soft = `wfx-b${id}`;
  const stops = colors.map((col, i) => <stop key={i} offset={i / (colors.length - 1)} stopColor={col} />);
  const paint = `url(#${grad})`;
  return (
    <span className={`work-fx work-fx--${fx.style}`} data-spin={fx.spin} data-eyes={fx.eyes} aria-hidden>
      <svg viewBox="-25 -25 150 150" overflow="visible">
        <defs>
          <linearGradient id={grad} x1="0" y1="0" x2="1" y2="0.35">{stops}</linearGradient>
          <filter id={soft} x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.2" /></filter>
        </defs>
        {fx.style === 'halo' && (
          // The Grok-style painted halo: a brushstroke that sweeps round the top of the head, then fades.
          <g className="wfx-tilt" transform="rotate(-9 50 16)">
            <ellipse className="wfx-stroke wfx-glow" cx="50" cy="16" rx="44" ry="13" pathLength={100} stroke={paint} strokeWidth="12" filter={`url(#${soft})`} />
            <ellipse className="wfx-stroke" cx="50" cy="16" rx="44" ry="13" pathLength={100} stroke={paint} strokeWidth="8" />
            <ellipse className="wfx-stroke wfx-core" cx="50" cy="15" rx="44" ry="12" pathLength={100} stroke="#fff" strokeWidth="1.8" />
          </g>
        )}
        {fx.style === 'orbit' && (
          <g transform="rotate(-22 50 52)">
            <ellipse cx="50" cy="52" rx="60" ry="19" fill="none" stroke={paint} strokeWidth="1.2" opacity="0.28" />
            <ellipse className="wfx-run wfx-glow" cx="50" cy="52" rx="60" ry="19" pathLength={100} stroke={paint} strokeWidth="8" filter={`url(#${soft})`} />
            <ellipse className="wfx-run" cx="50" cy="52" rx="60" ry="19" pathLength={100} stroke={paint} strokeWidth="4.5" />
            <ellipse className="wfx-run wfx-run--b" cx="50" cy="52" rx="60" ry="19" pathLength={100} stroke={colors[colors.length - 1]} strokeWidth="3" />
          </g>
        )}
        {fx.style === 'comet' && (
          <g className="wfx-spin">
            <circle cx="50" cy="50" r="60" fill="none" stroke={paint} strokeWidth="1" opacity="0.2" />
            <circle className="wfx-arc wfx-glow" cx="50" cy="50" r="60" pathLength={100} stroke={paint} strokeWidth="8" filter={`url(#${soft})`} />
            <circle className="wfx-arc" cx="50" cy="50" r="60" pathLength={100} stroke={paint} strokeWidth="4.5" />
            <circle className="wfx-arc wfx-arc--b" cx="50" cy="50" r="60" pathLength={100} stroke={paint} strokeWidth="3" />
          </g>
        )}
        {fx.style === 'ripple' && colors.slice(0, 3).map((col, i) => (
          <circle key={i} className="wfx-ripple" style={{ animationDelay: `${i * 0.6}s` }} cx="50" cy="52" r="46" fill="none" stroke={col} strokeWidth="4" />
        ))}
        {fx.style === 'sparkle' && SPARKS.map(([x, y, s], i) => (
          <g key={i} transform={`translate(${x} ${y}) scale(${s * 1.75})`}>
            <path className="wfx-star wfx-glow" style={{ animationDelay: `${i * 0.34}s` }} d={STAR} fill={colors[i % colors.length]} filter={`url(#${soft})`} />
            <path className="wfx-star" style={{ animationDelay: `${i * 0.34}s` }} d={STAR} fill={colors[i % colors.length]} />
          </g>
        ))}
        {fx.style === 'swirl' && (
          // A loose lasso scribbled around the head, drawn on and wiped off like a brush.
          <g>
            <path className="wfx-lasso wfx-glow" pathLength={100} stroke={paint} strokeWidth="8" filter={`url(#${soft})`}
              d="M-4 40C-6 8 30-8 58-4C92 0 108 26 100 46C92 66 60 66 34 58C8 50 4 26 26 14C48 2 84 8 94 30" />
            <path className="wfx-lasso" pathLength={100} stroke={paint} strokeWidth="5"
              d="M-4 40C-6 8 30-8 58-4C92 0 108 26 100 46C92 66 60 66 34 58C8 50 4 26 26 14C48 2 84 8 94 30" />
          </g>
        )}
      </svg>
    </span>
  );
}
