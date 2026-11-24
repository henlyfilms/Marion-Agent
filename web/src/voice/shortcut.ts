import { prefGet, prefSet } from '../lib/prefs';

export const DEFAULT_DICTATION_SHORTCUT = 'Control+Shift+D';
const PREFIX = 'dictationShortcut';

export const dictationShortcut = () => prefGet(PREFIX) || DEFAULT_DICTATION_SHORTCUT;
export const setDictationShortcut = (shortcut: string) => prefSet(PREFIX, shortcut);

export function shortcutFor(event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'code'>) {
  if (!/^Key[A-Z]$/.test(event.code) || !(event.ctrlKey || event.metaKey || event.altKey)) return '';
  return [
    event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta', event.code.slice(3),
  ].filter(Boolean).join('+');
}
