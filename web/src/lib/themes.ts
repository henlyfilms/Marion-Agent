import { prefGet } from './prefs';

export const THEME_PRESETS = {
  light: { label: 'Porcelain', scheme: 'light', background: '#faf8fa', foreground: '#251d29', accent: '#633775' },
  dark: { label: 'Obsidian', scheme: 'dark', background: '#09070b', foreground: '#f2edf4', accent: '#c498e5' },
  moss: { label: 'Moss', scheme: 'dark', background: '#111710', foreground: '#edf3e7', accent: '#a8c879' },
  paper: { label: 'Parchment', scheme: 'light', background: '#faf3e7', foreground: '#35281f', accent: '#8d493c' },
  dusk: { label: 'Fig', scheme: 'dark', background: '#271620', foreground: '#fff0f5', accent: '#eea1b9' },
  slate: { label: 'Slate', scheme: 'dark', background: '#14191e', foreground: '#e9f0f4', accent: '#96bfd8' },
} as const;

type Preset = keyof typeof THEME_PRESETS;
export type Theme = 'system' | Preset;
export const THEME_OPTIONS = ['system', ...Object.keys(THEME_PRESETS) as Preset[]] as const;
export const THEME_PREF = 'theme';

export function readTheme(): Theme {
  const theme = prefGet(THEME_PREF);
  return theme && Object.hasOwn(THEME_PRESETS, theme) ? theme as Preset : 'system';
}

export function themeStyle(preset: Preset) {
  const { background, foreground, accent } = THEME_PRESETS[preset];
  return { '--palette-background': background, '--palette-foreground': foreground, '--palette-accent': accent };
}
