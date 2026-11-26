import { prefGet, prefSet } from './prefs';
import { luminance } from './colors';

export const THEME_PRESETS = {
  light: { label: 'Porcelain', scheme: 'light', background: '#faf8fa', foreground: '#251d29', accent: '#633775' },
  dark: { label: 'Obsidian', scheme: 'dark', background: '#09070b', foreground: '#f2edf4', accent: '#c498e5' },
  moss: { label: 'Moss', scheme: 'dark', background: '#111710', foreground: '#edf3e7', accent: '#a8c879' },
  paper: { label: 'Parchment', scheme: 'light', background: '#faf3e7', foreground: '#35281f', accent: '#8d493c' },
  dusk: { label: 'Fig', scheme: 'dark', background: '#271620', foreground: '#fff0f5', accent: '#eea1b9' },
  slate: { label: 'Slate', scheme: 'dark', background: '#14191e', foreground: '#e9f0f4', accent: '#96bfd8' },
} as const;

type Preset = keyof typeof THEME_PRESETS;
/** 'custom' uses the three colors the user picked in Settings → General. */
export type Theme = 'system' | Preset | 'custom';
export type ResolvedTheme = Exclude<Theme, 'system'>;
export const THEME_OPTIONS = ['system', ...Object.keys(THEME_PRESETS) as Preset[], 'custom'] as const;
export const THEME_PREF = 'theme';
export const CUSTOM_THEME_PREF = 'customTheme';

/** Three colors make a theme; the four surfaces are optional overrides (unset = derived from them). */
export interface CustomTheme { background: string; foreground: string; accent: string; sidebar?: string; panel?: string; chat?: string; bubble?: string }
export const SURFACE_KEYS = ['sidebar', 'panel', 'chat', 'bubble'] as const;
export const DEFAULT_CUSTOM_THEME: CustomTheme = { background: '#140f1c', foreground: '#f1ebf7', accent: '#9b6cf0' };
const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

export function readCustomTheme(): CustomTheme {
  try {
    const saved = JSON.parse(prefGet(CUSTOM_THEME_PREF) ?? 'null') as Partial<CustomTheme> | null;
    if (saved && isHex(saved.background) && isHex(saved.foreground) && isHex(saved.accent)) {
      const theme: CustomTheme = { background: saved.background, foreground: saved.foreground, accent: saved.accent };
      for (const key of SURFACE_KEYS) if (isHex(saved[key])) theme[key] = saved[key];
      return theme;
    }
  } catch { /* fall through */ }
  return DEFAULT_CUSTOM_THEME;
}

export const saveCustomTheme = (theme: CustomTheme) => prefSet(CUSTOM_THEME_PREF, JSON.stringify(theme));

export function readTheme(): Theme {
  const theme = prefGet(THEME_PREF);
  if (theme === 'custom') return 'custom';
  return theme && Object.hasOwn(THEME_PRESETS, theme) ? theme as Preset : 'system';
}

/** The colors (and light/dark scheme) a theme paints with. */
export function themeColors(theme: ResolvedTheme, custom = readCustomTheme()) {
  if (theme !== 'custom') return THEME_PRESETS[theme];
  return { label: 'Custom', scheme: luminance(custom.background) < 0.3 ? 'dark' : 'light', ...custom } as const;
}

export function themeStyle(theme: ResolvedTheme, custom?: CustomTheme) {
  const { background, foreground, accent } = themeColors(theme, custom);
  const own = theme === 'custom' ? custom ?? readCustomTheme() : undefined;
  // Unset surfaces are written as an empty value so the CSS falls back to the derived color.
  return {
    '--palette-background': background, '--palette-foreground': foreground, '--palette-accent': accent,
    '--palette-sidebar': own?.sidebar ?? '', '--palette-panel': own?.panel ?? '', '--palette-chat': own?.chat ?? '', '--palette-bubble': own?.bubble ?? '',
    '--palette-bubble-ink': own?.bubble ? (luminance(own.bubble) > 0.5 ? '#16121a' : '#ffffff') : '',
  };
}
