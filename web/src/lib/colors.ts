import type { AvatarColor, NamedAvatarColor } from '@shared/types';

/**
 * Bot colors. `fill` is the avatar/swatch color, `bubble` the user message bubble, `action` the
 * accent for toggles and the send button, and `hover` its hover state.
 */
export interface BotPalette { fill: string; bubble: string; action: string; hover: string }

export const BOT_COLORS: Record<NamedAvatarColor, BotPalette> = {
  // Black follows the theme (ink on light, light ink on dark), so it uses tokens instead of hex.
  black: { fill: '#302735', bubble: 'var(--color-bubble-user)', action: 'var(--color-primary)', hover: 'var(--color-bg-primary-hover)' },
  brown: { fill: '#A06B39', bubble: '#86592E', action: '#9D6937', hover: '#86592E' },
  red: { fill: '#FB2B3E', bubble: '#C82532', action: '#E72E3B', hover: '#C82532' },
  orange: { fill: '#FD690F', bubble: '#D2550A', action: '#EE620D', hover: '#D2550A' },
  yellow: { fill: '#F59312', bubble: '#C2730B', action: '#DA830E', hover: '#C2730B' },
  green: { fill: '#14C16F', bubble: '#0D9655', action: '#10AB61', hover: '#0D9655' },
  cyan: { fill: '#13B7A2', bubble: '#0D9381', action: '#10A693', hover: '#0D9381' },
  blue: { fill: '#1E86FC', bubble: '#126FD4', action: '#1680F3', hover: '#126FD4' },
  violet: { fill: '#8F59F9', bubble: '#7442D1', action: '#8351E4', hover: '#7442D1' },
  magenta: { fill: '#F93498', bubble: '#C82779', action: '#E52F8B', hover: '#C82779' },
  gray: { fill: '#959595', bubble: '#6E6E6E', action: '#7A7A7A', hover: '#6E6E6E' },
};

/** Swatch order in the Create New Bot picker. */
export const COLOR_ORDER: NamedAvatarColor[] = ['black', 'brown', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta', 'gray'];

export const isHexColor = (c: unknown): c is `#${string}` => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);

/** Mix a hex color toward black (amount < 0) or white (amount > 0). */
export function shade(hex: string, amount: number) {
  const target = amount < 0 ? 0 : 255;
  return '#' + [1, 3, 5].map(i => {
    const v = parseInt(hex.slice(i, i + 2), 16);
    return Math.round(v + (target - v) * Math.abs(amount)).toString(16).padStart(2, '0');
  }).join('');
}

/** Relative luminance (0 dark … 1 light) of a hex color. */
export function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map(i => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const custom = new Map<string, BotPalette>();
/** A palette for a custom color, built the same way as the named ones (darker bubble and hover). */
function customPalette(hex: string): BotPalette {
  const key = hex.toLowerCase();
  let p = custom.get(key);
  if (!p) {
    p = { fill: key, bubble: shade(key, -0.2), action: shade(key, -0.07), hover: shade(key, -0.2) };
    custom.set(key, p);
  }
  return p;
}

export const palette = (c: AvatarColor | string | undefined): BotPalette =>
  isHexColor(c) ? customPalette(c) : BOT_COLORS[(c as NamedAvatarColor) ?? 'black'] ?? BOT_COLORS.black;

/** CSS custom properties that theme a subtree with a bot's color. */
export function botVars(c: AvatarColor | string | undefined): React.CSSProperties {
  const p = palette(c);
  return {
    ['--bot-fill' as string]: p.fill, ['--bot-bubble' as string]: p.bubble, ['--bot-action' as string]: p.action, ['--bot-action-hover' as string]: p.hover,
    ['--bot-on-action' as string]: p === BOT_COLORS.black ? 'var(--color-on-primary)' : isHexColor(p.action) && luminance(p.action) > 0.55 ? '#1c1520' : '#FFFFFF',
    ['--bot-action-soft' as string]: `color-mix(in srgb, ${p.action} 13%, transparent)`,
    ['--bot-action-text' as string]: p === BOT_COLORS.black ? 'var(--color-text-secondary)' : p.action,
  };
}
