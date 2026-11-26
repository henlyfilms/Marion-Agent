// Record on the selected microphone and send a complete audio file to the configured STT service.
import { useCallback, useEffect, useRef, useState } from 'react';
import { playDictationSound } from './sounds';
import { voiceApi } from './api';
import { micErrorMessage, openMic } from './audio';

export type DictationState = 'idle' | 'recording' | 'transcribing';

const MAX_MS = 120_000;

function pickMime(): string | undefined {
  for (const mime of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported?.(mime)) return mime;
  }
}

interface Recording {
  controller: AbortController;
  media?: MediaRecorder;
  timer?: ReturnType<typeof setTimeout>;
  /** Live preview: re-transcribes the audio so far while the user is still talking. */
  preview?: ReturnType<typeof setInterval>;
  previewing?: AbortController;
}

/** How often to refresh the live preview: quick at first, slower as the recording (and each pass) grows. */
const previewEvery = (ms: number) => (ms < 30_000 ? 1200 : ms < 90_000 ? 2500 : 5000);

export function useDictation(onText: (text: string) => void, onError: (msg: string) => void, language?: string, maxMs = MAX_MS, native = false) {
  const [state, setState] = useState<DictationState>('idle');
  const [interim, setInterim] = useState('');
  const active = useRef<Recording>();
  const cb = useRef({ onText, onError, language, native });
  cb.current = { onText, onError, language, native };

  const finish = useCallback((cancel = false) => {
    const recording = active.current;
    if (!recording) return;
    clearTimeout(recording.timer);
    clearInterval(recording.preview);
    recording.previewing?.abort();
    if (cancel || !recording.media) {
      active.current = undefined;
      recording.controller.abort();
      setInterim('');
      setState('idle');
    }
    if (recording.media?.state === 'recording') {
      if (!cancel) playDictationSound(false);
      recording.media.stop();
    }
  }, []);

  const begin = useCallback(async () => {
    if (active.current) return;
    if (typeof MediaRecorder === 'undefined') { cb.current.onError('Audio recording is unavailable in this browser.'); return; }
    const recording: Recording = { controller: new AbortController() };
    const { signal } = recording.controller;
    active.current = recording;
    setState('recording');
    playDictationSound(true);
    let stream: MediaStream | undefined;
    try {
      stream = await openMic();
      if (signal.aborted) { stream.getTracks().forEach(track => track.stop()); return; }
      const capture = stream;
      const start = Date.now();
      const mime = pickMime();
      const media = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      recording.media = media;
      const cleanUp = () => {
        clearTimeout(recording.timer);
        capture.getTracks().forEach(track => track.stop());
      };
      const idle = () => {
        clearInterval(recording.preview);
        recording.previewing?.abort();
        if (active.current === recording) { active.current = undefined; setInterim(''); setState('idle'); }
      };
      media.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      media.onerror = () => {
        cleanUp();
        if (!signal.aborted) cb.current.onError('Could not record audio from this microphone.');
        recording.controller.abort();
        idle();
      };
      media.onstop = async () => {
        cleanUp();
        clearInterval(recording.preview);
        recording.previewing?.abort();
        if (signal.aborted || !chunks.length || Date.now() - start < 250) { idle(); return; }
        setState('transcribing');
        try {
          const text = await voiceApi.transcribe(new Blob(chunks, { type: media.mimeType || mime || 'audio/webm' }), cb.current.language, signal, cb.current.native);
          if (!signal.aborted) {
            if (text) cb.current.onText(text);
            else cb.current.onError('No speech heard'); // short, so it never wraps the model row (owner, Nov 25)
          }
        } catch (cause) {
          if (!signal.aborted) cb.current.onError((cause as Error).message || 'Transcription failed');
        } finally { idle(); }
      };
      media.start(500);
      recording.timer = setTimeout(() => finish(), maxMs);
      // Live preview: every second or so, transcribe what has been said so far and show it in the box.
      let lastPreview = 0;
      recording.preview = setInterval(() => {
        const elapsed = Date.now() - start;
        if (recording.previewing || !chunks.length || media.state !== 'recording' || Date.now() - lastPreview < previewEvery(elapsed)) return;
        lastPreview = Date.now();
        const previewing = new AbortController();
        recording.previewing = previewing;
        const audio = new Blob(chunks, { type: media.mimeType || mime || 'audio/webm' });
        voiceApi.transcribe(audio, cb.current.language, AbortSignal.any([signal, previewing.signal]), cb.current.native)
          .then(text => { if (!previewing.signal.aborted && active.current === recording && media.state === 'recording') setInterim(text.trim()); })
          .catch(() => { /* A preview can fail (e.g. too little audio); the final transcription still runs. */ })
          .finally(() => { if (recording.previewing === previewing) recording.previewing = undefined; });
      }, 400);
    } catch (cause) {
      stream?.getTracks().forEach(track => track.stop());
      if (!signal.aborted) cb.current.onError(micErrorMessage(cause));
      if (active.current === recording) { active.current = undefined; setState('idle'); }
    }
  }, [finish, maxMs]);

  useEffect(() => {
    if (state !== 'recording') return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(true); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [state, finish]);
  useEffect(() => () => finish(true), [finish]);

  return { state, interim, begin, finish };
}
