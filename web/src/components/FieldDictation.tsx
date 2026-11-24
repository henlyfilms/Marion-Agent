import { useEffect, useRef, useState } from 'react';
import { voiceApi, type VoiceStatus } from '../voice/api';
import { microphoneId } from '../voice/audio';
import { useDictation } from '../voice/dictation';
import { supportsLiveDictation, useLiveDictation } from '../voice/liveDictation';
import { dictationShortcut, shortcutFor } from '../voice/shortcut';
import { playDictationSound } from '../voice/sounds';

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLElement;
type Destination = { field: Field; range?: Range };

function focusedField(target: EventTarget | null): Destination | undefined {
  if (!(target instanceof HTMLElement) || target.closest('[data-dictation-composer], [aria-disabled="true"]')) return;
  if (target instanceof HTMLInputElement) {
    if (!['text', 'search', 'email', 'url', 'tel'].includes(target.type) || target.disabled || target.readOnly) return;
    return { field: target };
  }
  if (target instanceof HTMLTextAreaElement) {
    if (!target.disabled && !target.readOnly) return { field: target };
    return;
  }
  const field = target.closest<HTMLElement>('[contenteditable="true"], [contenteditable="plaintext-only"]');
  const selection = window.getSelection();
  if (field && selection?.rangeCount && field.contains(selection.anchorNode) && field.contains(selection.focusNode)) {
    return { field, range: selection.getRangeAt(0).cloneRange() };
  }
}

export function FieldDictation() {
  const [availability, setAvailability] = useState<VoiceStatus>();
  const [error, setError] = useState('');
  const destination = useRef<Destination>();
  useEffect(() => { void voiceApi.status().then(setAvailability).catch(() => {}); }, []);
  const insert = (words: string) => {
    const target = destination.current;
    if (!target?.field.isConnected) return;
    const { field, range } = target;
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
      const start = field.selectionStart ?? field.value.length;
      const end = field.selectionEnd ?? start;
      const before = field.value.slice(0, start);
      const after = field.value.slice(end);
      const text = (before && !/\s$/.test(before) ? ' ' : '') + words + (after && !/^\s/.test(after) ? ' ' : '');
      const prototype = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, before + text + after);
      if (field.selectionStart !== null) field.setSelectionRange(start + text.length, start + text.length);
    } else if (range) {
      if (!field.contains(range.commonAncestorContainer)) return;
      range.deleteContents();
      const text = document.createTextNode(words + ' ');
      range.insertNode(text);
      range.setStartAfter(text);
      range.collapse(true);
    }
    field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: words }));
  };
  const recorded = useDictation(insert, setError, undefined, undefined, availability?.nativeSpeech);
  const live = useLiveDictation(insert, setError);
  const state = live.state === 'idle' ? recorded.state : live.state;

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && state !== 'idle') {
        event.preventDefault();
        event.stopImmediatePropagation();
        recorded.finish(true);
        live.stop(true);
        return;
      }
      if (event.defaultPrevented || event.isComposing || event.repeat || shortcutFor(event) !== dictationShortcut()) return;
      const target = focusedField(event.target);
      if (state === 'idle' && !target) return;
      event.preventDefault();
      if (state === 'recording') {
        if (live.state === 'recording') playDictationSound(false);
        recorded.finish();
        live.stop();
        return;
      }
      if (state !== 'idle') return;
      destination.current = target;
      setError('');
      if (availability?.localSpeech || availability?.realtime) { void recorded.begin(); return; }
      const device = microphoneId();
      if (!/Electron\//.test(navigator.userAgent) && supportsLiveDictation(device)) {
        playDictationSound(true);
        void live.start(device);
      } else setError('Choose a speech provider in Settings → Audio.');
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(''), 4000);
    return () => clearTimeout(timer);
  }, [error]);

  const message = error || (state === 'recording' ? live.interim || 'Listening…' : state === 'transcribing' ? 'Transcribing…' : '');
  return <div className="field-dictation" data-visible={Boolean(message)} role="status">{message}</div>;
}
