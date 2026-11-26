import { useId } from 'react';
import { BERRY_SHAPES, isBerryShape, type ClassicShape } from '@shared/avatarShapes';
import type { WorkFxChoice } from '@shared/avatarShapes';
import type { AvatarColor, AvatarShape, Bot } from '@shared/types';
import { palette } from '../lib/colors';
import { Icon } from '../components/Icon';
import { SHAPES, type ShapeDef } from './shapes';
import { useWorkFx, WorkFxLayer } from './WorkFx';

interface Props {
  shape: AvatarShape | string;
  color: AvatarColor | string;
  stemColor?: string | null;
  size: number;
  star?: boolean;
  /** Soft bloom in the bot's own color. */
  glow?: boolean;
  /** Uploaded photo shown in a circle instead of the berry. */
  image?: string | null;
  /** Bot is working: eyes come alive and a per-bot aura plays (seeded by `fxSeed`, usually the bot id). */
  working?: boolean;
  fxSeed?: string;
  /** Chosen working animation (Bot settings → Theme); 'auto' = from the bot's place in the list. */
  workFx?: WorkFxChoice;
  className?: string;
  title?: string;
}

const LEGACY_VIEW = '8 8 84 84';
const BERRY_VIEW = '0 0 100 100';
const BERRY_EYES = { y: 53, dx: 12.5, s: 0.9 };
const FUNKY_EYES = { y: 52, dx: 8.5, s: 0.76 };
const CLASSIC_STEMS: Record<ClassicShape, readonly [x: number, y: number]> = {
  blob: [50, 10], pebble: [50, 19], egg: [50, 11], bean: [47, 26], squircle: [50, 10],
  square: [50, 12], tablet: [50, 11], capsule: [50, 26], cylinder: [50, 10], hex: [50, 10],
  gem: [50, 17], crystal: [50, 12], wedge: [50, 17], shield: [50, 13], dome: [50, 16],
  arch: [50, 17], cloud: [50, 20], teardrop: [50, 10], leaf: [65, 25], sparkle: [50, 6],
  clover: [50, 12], flower: [50, 18], heart: [50, 32], house: [50, 15], star: [50, 14],
};

function Eyes({ eyes }: { eyes: ShapeDef['eyes'] }) {
  const { y, dx, s } = eyes;
  return (
    <g data-avatar-eyes="" fill="#fff9fc">
      {[-1, 1].map((side) => {
        const x = 50 + side * dx;
        return (
          <ellipse key={side} cx={x} cy={y} rx={4.6 * s} ry={7.5 * s} transform={`rotate(-15 ${x} ${y})`} />
        );
      })}
    </g>
  );
}

type Lobe = readonly [x: number, y: number, radius: number];

function berryStem(lobes: readonly Lobe[]): readonly [number, number] {
  const x = 49;
  // Meet the first point on the silhouette directly above the berry's center.
  const y = Math.min(...lobes.filter(([cx, , r]) => Math.abs(x - cx) < r)
    .map(([cx, cy, r]) => cy - Math.sqrt(r * r - (x - cx) ** 2)));
  return [x, y];
}

function Stem({ color, point: [x, y] }: { color: string; point: readonly [number, number] }) {
  return (
    <g transform={`translate(${x} ${y + 3}) rotate(-18)`} data-stem-color={color}>
      <path d="M0 4C0-2 2-7 6-10" fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" />
      <path d="M3-6Q6-14 16-11Q13-4 3-6Z" fill={color} />
    </g>
  );
}

export function BotAvatar({ shape, color, stemColor, size, star, glow, image, working, fxSeed, workFx, className, title }: Props) {
  const gradientId = useId();
  const berry = isBerryShape(shape) ? BERRY_SHAPES[shape][1] : null;
  const lobes = typeof berry === 'string' ? null : berry;
  const classicShape = Object.hasOwn(SHAPES, shape) ? shape as ClassicShape : 'blob';
  const classic = SHAPES[classicShape];
  const stem = lobes ? berryStem(lobes) : berry ? [50, 14] as const : CLASSIC_STEMS[classicShape];
  const fill = palette(color).fill;
  // `fx` outlives `working` by a moment so the aura can fade out; it is null for idle avatars.
  const fx = useWorkFx(!!working, fxSeed ?? String(shape) + color, fill, size, workFx);
  return (
    <span className={`bot-avatar${glow ? ' is-glowing' : ''}${fx ? ' is-working' : ''}${className ? ` ${className}` : ''}`}
      style={glow ? { width: size, height: size, '--avatar-glow': fill, '--avatar-glow-r': `${Math.max(2, size * 0.09)}px` } as React.CSSProperties : { width: size, height: size }}
      title={title} role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}
      data-avatar-shape={image ? 'photo' : berry || Object.hasOwn(SHAPES, shape) ? shape : 'blob'}>
      {fx && <WorkFxLayer fx={fx} layer="back" />}
      {image ? <img className="bot-avatar__photo" src={image} alt="" draggable={false} width={size} height={size} /> : <svg width={size} height={size} viewBox={berry ? BERRY_VIEW : LEGACY_VIEW} aria-hidden>
        <defs>
          <radialGradient id={gradientId} gradientUnits="userSpaceOnUse" cx="38" cy="30" r="71" fx="33" fy="24">
            <stop offset="0" stopColor={`color-mix(in srgb, ${fill}, white 32%)`} />
            <stop offset="0.72" stopColor={fill} />
            <stop offset="1" stopColor={`color-mix(in srgb, ${fill}, #271034 28%)`} />
          </radialGradient>
        </defs>
        {stemColor && <Stem color={stemColor} point={stem} />}
        <g fill={`url(#${gradientId})`}>
          {lobes ? lobes.map(([x, y, r]) => <circle key={`${x},${y}`} cx={x} cy={y} r={r} />)
            : <path d={typeof berry === 'string' ? berry : classic.d} />}
        </g>
        <Eyes eyes={shape === 'funkyberry' ? FUNKY_EYES : berry ? BERRY_EYES : classic.eyes} />
      </svg>}
      {fx && <WorkFxLayer fx={fx} layer="front" />}
      {star && (
        <span className="bot-avatar__star" style={{ width: size * 0.2667, height: size * 0.2667 }}>
          <Icon name="star" size={size * 0.1333} color="#FFFFFF" />
        </span>
      )}
    </span>
  );
}

export function BotAvatarFor({ bot, size, star, working, className }: { bot: Pick<Bot, 'avatarShape' | 'avatarColor' | 'avatarStemColor' | 'name'> & { avatarGlow?: boolean; workFx?: WorkFxChoice; avatarImage?: string | null; id?: string }; size: number; star?: boolean; working?: boolean; className?: string }) {
  return <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} stemColor={bot.avatarStemColor} glow={bot.avatarGlow} image={bot.avatarImage} size={size} star={star} working={working} fxSeed={bot.id} workFx={bot.workFx} className={className} title={bot.name} />;
}
