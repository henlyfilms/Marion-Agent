import { useId } from 'react';
import { resolveAvatarShape, type WorkFxChoice } from '@shared/avatarShapes';
import { AVATAR_GEOMETRY, type ShapeGeometry } from '@shared/avatarGeometry';
import type { AvatarColor, AvatarShape, Bot } from '@shared/types';
import { palette } from '../lib/colors';
import { Icon } from '../components/Icon';
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

const VIEW = '0 0 100 100';

function Eyes({ eyes }: { eyes: ShapeGeometry['eyes'] }) {
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
  // Saved ids from older versions resolve to their replacement icon; unknown ids show the default.
  const id = resolveAvatarShape(shape);
  const geometry = AVATAR_GEOMETRY[id];
  const fill = palette(color).fill;
  // `fx` outlives `working` by a moment so the aura can fade out; it is null for idle avatars.
  const fx = useWorkFx(!!working, fxSeed ?? String(shape) + color, fill, size, workFx);
  return (
    <span className={`bot-avatar${glow ? ' is-glowing' : ''}${fx ? ' is-working' : ''}${className ? ` ${className}` : ''}`}
      style={glow ? { width: size, height: size, '--avatar-glow': fill, '--avatar-glow-r': `${Math.max(2, size * 0.09)}px` } as React.CSSProperties : { width: size, height: size }}
      title={title} role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}
      data-avatar-shape={image ? 'photo' : id}>
      {fx && <WorkFxLayer fx={fx} layer="back" />}
      {image ? <img className="bot-avatar__photo" src={image} alt="" draggable={false} width={size} height={size} /> : <svg width={size} height={size} viewBox={VIEW} aria-hidden>
        <defs>
          <radialGradient id={gradientId} gradientUnits="userSpaceOnUse" cx="38" cy="30" r="71" fx="33" fy="24">
            <stop offset="0" stopColor={`color-mix(in srgb, ${fill}, white 32%)`} />
            <stop offset="0.72" stopColor={fill} />
            <stop offset="1" stopColor={`color-mix(in srgb, ${fill}, #271034 28%)`} />
          </radialGradient>
        </defs>
        {stemColor && <Stem color={stemColor} point={geometry.stem} />}
        <path fill={`url(#${gradientId})`} d={geometry.d} />
        <Eyes eyes={geometry.eyes} />
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
