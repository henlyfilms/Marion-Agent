// Record on the selected microphone and send a complete audio file to the configured STT service.
import { useCallback, useEffect, useRef, useState } from 'react';
import { playDictationSound } from './sounds';
import { voiceApi } from './api';
import { micErrorMessage, microphoneId, openMic } from './audio';
import { PcmRecorder } from './pcmRecorder';

export type DictationState = 'idle' | 'recording' | 'transcribing';

const MAX_MS = 120_000;

function pickMime(): string | undefined {
  for (const mime of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported?.(mime)) return mime;
  }
}

/** What the recording is made with: a MediaRecorder (servers that take compressed audio) or the lossless PCM recorder (Mac dictation). */
type Recorder = Pick<MediaRecorder, 'state' | 'stop' | 'mimeType'> & { onstop: unknown };

interface Recording {
  controller: AbortController;
  media?: Recorder;
  timer?: ReturnType<typeof setTimeout>;
  /** Live preview: re-transcribes the audio so far while the user is still talking. */
  preview?: ReturnType<typeof setInterval>;
  previewing?: AbortController;
}

/**
 * Minimum pause between live-preview passes. A pass starts as soon as the previous one has returned and new audio
 * has arrived, so the preview runs at the speech server's own speed. The pause only throttles long recordings,
 * where every pass re-sends (and re-transcribes) all the audio so far.
 */
const previewGap = (ms: number) => (ms < 25_000 ? 0 : ms < 75_000 ? 1200 : 3500);
/** Audio needed before the first preview is worth asking for. */
const FIRST_PREVIEW_MS = 700;
/** MediaRecorder hands over audio this often; smaller slices keep the preview close behind the speaker. */
const SLICE_MS = 200;

/**
 * Reveal a transcript word by word instead of in the lump a whole server pass delivers. The backlog always
 * drains in about a quarter of a second, so this smooths the jump without making the words later.
 */
function useRevealedWords(target: string) {
  const [count, setCount] = useState(0);
  const words = target ? target.split(/\s+/) : [];
  const total = words.length;
  useEffect(() => {
    if (count > total) { setCount(total); return; }
    if (count === total) return;
    const timer = setTimeout(() => setCount(current => Math.min(total, current + Math.max(1, Math.ceil((total - current) / 5)))), 40);
    return () => clearTimeout(timer);
  }, [count, total]);
  useEffect(() => { if (!target) setCount(0); }, [target]);
  return count >= total ? target : words.slice(0, count).join(' ');
}

export function useDictation(onText: (text: string) => void, onError: (msg: string) => void, language?: string, maxMs = MAX_MS, native = false, getContext?: () => string) {
  const [state, setState] = useState<DictationState>('idle');
  const [heard, setInterim] = useState('');
  const interim = useRevealedWords(heard);
  const active = useRef<Recording>();
  const cb = useRef({ onText, onError, language, native, getContext });
  cb.current = { onText, onError, language, native, getContext };

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
      const lossless = cb.current.native; // Mac dictation: raw samples, no Opus, no browser noise gate / auto-gain
      stream = await openMic(microphoneId(), lossless);
      if (signal.aborted) { stream.getTracks().forEach(track => track.stop()); return; }
      const capture = stream;
      const start = Date.now();
      const mime = lossless ? 'audio/wav' : pickMime();
      const pcm = lossless ? await PcmRecorder.open(stream) : undefined;
      if (signal.aborted) { pcm?.stop(); stream.getTracks().forEach(track => track.stop()); return; }
      const media: Recorder & { start?(slice?: number): void; onerror?: unknown } = pcm ?? new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 128_000 } : { audioBitsPerSecond: 128_000 });
      const chunks: Blob[] = [];
      const chunkCount = () => pcm ? pcm.chunkCount : chunks.length;
      const audio = () => pcm ? pcm.wav() : new Blob(chunks, { type: media.mimeType || mime || 'audio/webm' });
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
      if (!pcm) {
        const recorder = media as MediaRecorder;
        recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
        recorder.onerror = () => {
          cleanUp();
          if (!signal.aborted) cb.current.onError('Could not record audio from this microphone.');
          recording.controller.abort();
          idle();
        };
      }
      media.onstop = async () => {
        cleanUp();
        clearInterval(recording.preview);
        recording.previewing?.abort();
        if (signal.aborted || !chunkCount() || Date.now() - start < 250) { idle(); return; }
        setState('transcribing');
        try {
          const text = await voiceApi.transcribe(audio(), cb.current.language, signal, cb.current.native, { final: true, context: cb.current.getContext?.() });
          if (!signal.aborted) {
            if (text) cb.current.onText(text);
            else cb.current.onError('No speech heard'); // short, so it never wraps the model row (owner, Nov 25)
          }
        } catch (cause) {
          if (!signal.aborted) cb.current.onError((cause as Error).message || 'Transcription failed');
        } finally { idle(); }
      };
      if (!pcm) (media as MediaRecorder).start(SLICE_MS);
      recording.timer = setTimeout(() => finish(), maxMs);
      // Live preview: transcribe what has been said so far and show it in the box. Passes run back to back (one at
      // a time) whenever new audio has arrived, so words show up as fast as the speech server answers.
      let lastPreview = 0;
      let previewedChunks = 0;
      const refreshPreview = () => {
        const elapsed = Date.now() - start;
        if (recording.previewing || media.state !== 'recording' || chunkCount() === previewedChunks
          || elapsed < FIRST_PREVIEW_MS || Date.now() - lastPreview < previewGap(elapsed)) return;
        previewedChunks = chunkCount();
        const previewing = new AbortController();
        recording.previewing = previewing;
        voiceApi.transcribe(audio(), cb.current.language, AbortSignal.any([signal, previewing.signal]), cb.current.native, { context: cb.current.getContext?.() })
          .then(text => { if (!previewing.signal.aborted && active.current === recording && media.state === 'recording') setInterim(text.trim()); })
          .catch(() => { /* A preview can fail (e.g. too little audio); the final transcription still runs. */ })
          .finally(() => {
            if (recording.previewing !== previewing) return;
            recording.previewing = undefined;
            lastPreview = Date.now();
            refreshPreview();
          });
      };
      if (!pcm) (media as MediaRecorder).addEventListener('dataavailable', refreshPreview);
      // The timer only covers the throttled gaps on long recordings; short ones are driven by the events above.
      recording.preview = setInterval(refreshPreview, 250);
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
  // Closing the chat mid-recording still transcribes it, so the words are kept (the owner never loses them).
  useEffect(() => () => finish(), [finish]);

  return { state, interim, begin, finish };
}
