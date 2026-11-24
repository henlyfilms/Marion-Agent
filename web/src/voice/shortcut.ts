import { prefGet, prefSet } from '../lib/prefs';

export const DEFAULT_DICTATION_SHORTCUT = 'Shift+Meta+D';
const PREFIX = 'dictationShortcut.v2';

export function dictationShortcut() {
  const saved = prefGet(PREFIX);
  if (saved !== null) return saved || DEFAULT_DICTATION_SHORTCUT;
  const previous = prefGet('dictationShortcut');
  return !previous || previous === 'Control+Shift+D' ? DEFAULT_DICTATION_SHORTCUT : previous;
}
export const setDictationShortcut = (shortcut: string) => prefSet(PREFIX, shortcut === DEFAULT_DICTATION_SHORTCUT ? '' : shortcut);

export const shortcutLabel = (shortcut: string) =>
  shortcut === DEFAULT_DICTATION_SHORTCUT ? 'Command+Shift+D' : shortcut.replace('Meta', 'Command');

export function shortcutFor(event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'code'>) {
  if (!/^Key[A-Z]$/.test(event.code) || !(event.ctrlKey || event.metaKey || event.altKey)) return '';
  return [
    event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta', event.code.slice(3),
  ].filter(Boolean).join('+');
}
