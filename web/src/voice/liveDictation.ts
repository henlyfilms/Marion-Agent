import { useCallback, useEffect, useRef, useState } from 'react';
import { micErrorMessage, openMic } from './audio';

interface SpeechResult {
  isFinal: boolean;
  0: { transcript: string };
}

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<SpeechResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(track?: MediaStreamTrack): void;
  stop(): void;
  abort(): void;
}

type RecognitionClass = { new(): Recognition; available?: unknown };
const speechWindow = window as Window & { SpeechRecognition?: RecognitionClass; webkitSpeechRecognition?: RecognitionClass };
const speechRecognition = () => speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
const QUIET_LIMIT = 10 * 60_000;

interface Session {
  recognition?: Recognition;
  track?: MediaStreamTrack;
  restart?: ReturnType<typeof setTimeout>;
  stopTimer?: ReturnType<typeof setTimeout>;
  watchdog?: ReturnType<typeof setInterval>;
  pending: string;
  lastWords: number;
  retries: number;
  stopping: boolean;
}

export function supportsLiveDictation(deviceId: string) {
  const recognition = speechRecognition();
  // Current Chromium exposes the track overload alongside its newer speech API.
  return !!recognition && (!deviceId || typeof recognition.available === 'function');
}

export function appendDictation(before: string, words: string) {
  const trimmed = words.trim();
  if (!trimmed) return before;
  const head = before.trimEnd();
  return head ? head + ' ' + trimmed : trimmed[0].toUpperCase() + trimmed.slice(1);
}

export function useLiveDictation(onWords: (words: string) => void, onError: (error: string) => void, language?: string) {
  const [state, setState] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [interim, setInterim] = useState('');
  const active = useRef<Session>();
  const callbacks = useRef({ onWords, onError, language });
  callbacks.current = { onWords, onError, language };

  const release = useCallback((discard: boolean) => {
    const session = active.current;
    if (!session) return;
    active.current = undefined;
    clearTimeout(session.restart);
    clearTimeout(session.stopTimer);
    clearInterval(session.watchdog);
    if (session.recognition) {
      session.recognition.onresult = session.recognition.onerror = session.recognition.onend = null;
      try { session.recognition.abort(); } catch { /* Already stopped. */ }
    }
    session.track?.stop();
    if (!discard && session.pending) callbacks.current.onWords(session.pending);
    setInterim('');
    setState('idle');
  }, []);

  const stop = useCallback((discard = false) => {
    const session = active.current;
    if (!session) return;
    if (discard || !session.recognition) { release(discard); return; }
    if (session.stopping) return;
    session.stopping = true;
    setState('transcribing');
    session.stopTimer = setTimeout(() => release(false), 2200);
    try { session.recognition.stop(); } catch { release(false); }
  }, [release]);

  const start = useCallback(async (deviceId: string) => {
    const Recognition = speechRecognition();
    if (!Recognition || active.current) return;
    const session: Session = { pending: '', lastWords: Date.now(), stopping: false, retries: 0 };
    active.current = session;
    setState('recording');
    const fail = (message: string) => {
      if (active.current !== session) return;
      release(false);
      callbacks.current.onError(message);
    };
    const begin = () => {
      if (active.current !== session || session.stopping) return;
      if (document.hidden) { session.restart = setTimeout(begin, 750); return; }
      const recognition = new Recognition();
      session.recognition = recognition;
      const lang = callbacks.current.language;
      recognition.lang = lang && lang !== 'auto' ? lang : navigator.language || 'en-US';
      recognition.continuous = true;
      recognition.interimResults = true;
      let committed = 0;
      const started = Date.now();
      recognition.onresult = ({ results }) => {
        if (active.current !== session) return;
        const unfinished: string[] = [];
        for (let index = committed; index < results.length; index++) {
          const result = results[index];
          const words = result[0].transcript.trim();
          if (result.isFinal && index === committed) {
            committed++;
            if (words) callbacks.current.onWords(words);
          } else if (words) unfinished.push(words);
        }
        session.pending = unfinished.join(' ');
        session.lastWords = Date.now();
        session.retries = 0;
        setInterim(session.pending);
      };
      recognition.onerror = ({ error }) => {
        if (active.current !== session || error === 'no-speech' || error === 'aborted') return;
        if (error === 'network' && session.retries++ < 2) return;
        if (error === 'not-allowed' || error === 'service-not-allowed') fail('Browser dictation is blocked. Check microphone and speech permissions or configure a speech server in Settings → Audio.');
        else fail('Browser dictation stopped. Try again or use the configured speech server.');
      };
      recognition.onend = () => {
        if (active.current !== session) return;
        session.recognition = undefined;
        if (session.stopping) { release(false); return; }
        if (session.pending) callbacks.current.onWords(session.pending);
        session.pending = '';
        setInterim('');
        const instantEnd = Date.now() - started < 800;
        session.restart = setTimeout(begin, instantEnd ? 1200 : 280);
      };
      try {
        if (session.track) recognition.start(session.track);
        else recognition.start();
      } catch {
        session.recognition = undefined;
        if (++session.retries > 4) fail('Could not restart browser dictation.');
        else session.restart = setTimeout(begin, 600);
      }
    };
    try {
      if (deviceId) {
        const stream = await openMic(deviceId);
        if (active.current !== session) { stream.getTracks().forEach(track => track.stop()); return; }
        session.track = stream.getAudioTracks()[0];
        if (!session.track) { fail('The selected microphone supplied no audio track.'); return; }
        session.track.addEventListener('ended', () => fail('The selected microphone disconnected.'), { once: true });
      }
      session.watchdog = setInterval(() => { if (Date.now() - session.lastWords >= QUIET_LIMIT) stop(); }, 5000);
      begin();
    } catch (error) { fail(micErrorMessage(error)); }
  }, [release, stop]);

  useEffect(() => () => release(true), [release]);
  return { state, interim, start, stop };
}
