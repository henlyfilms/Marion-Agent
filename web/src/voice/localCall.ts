// Hands-free voice calls that talk to the chat's own model (local or subscription).
// Capture stays active during transcription, reasoning, and playback.
import { create } from 'zustand';
import type { Bot, ChatModelSelection, LiveState } from '@shared/types';
import { api } from '../lib/api';
import { prefGet, prefSet } from '../lib/prefs';
import { useStore } from '../store';
import { voiceApi, type VoiceStatus } from './api';
import { createAudioContext, micErrorMessage, openMic } from './audio';
import { playConnected, playHangUp, playRinging } from './sounds';

export type LocalCallStatus = 'idle' | 'ringing' | 'speaking' | 'listening' | 'hearing' | 'transcribing' | 'thinking' | 'error';

interface LocalCallState {
  status: LocalCallStatus;
  botId: string | null;
  startedAt: number | null;
  muted: boolean;
  /** Last thing said, shown as a live caption. */
  caption: { role: 'user' | 'assistant'; text: string } | null;
  error: string | null;
  modelLabel: string | null;
  draft: boolean;
}

export const useLocalCall = create<LocalCallState>(() => ({
  status: 'idle', botId: null, startedAt: null, muted: false, caption: null, error: null, modelLabel: null, draft: false,
}));
const setC = (patch: Partial<LocalCallState>) => useLocalCall.setState(patch);
export const isLocalCallActive = (s: LocalCallState = useLocalCall.getState()) => s.status !== 'idle' && s.status !== 'error';

// ---------- which model a call uses ----------
// Each chat remembers its own call model; a default can apply to chats that haven't picked one.
// No choice at all means the call uses the chat's own model.

const modelKey = (botId: string) => `callModel:${botId}`;
const read = (key: string): ChatModelSelection | null => {
  try { const value = prefGet(key); return value ? JSON.parse(value) as ChatModelSelection : null; } catch { return null; }
};
export const chatCallModel = (botId: string) => read(modelKey(botId));
export const defaultCallModel = () => read('callModel:default');
export function setChatCallModel(botId: string, model: ChatModelSelection | null) {
  prefSet(modelKey(botId), model ? JSON.stringify(model) : '');
  useLocalCall.setState({}); // re-render pickers
}
export function setDefaultCallModel(model: ChatModelSelection | null) {
  prefSet('callModel:default', model ? JSON.stringify(model) : '');
  useLocalCall.setState({});
}
/** The model a call with this bot will use (null = the chat's own model). */
export const callModelFor = (botId: string) => chatCallModel(botId) ?? defaultCallModel();

// ---------- speech helpers ----------

/** Make a written reply speakable: drop markdown, links, code and emoji. */
export function speakable(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, ' (I put the code in the chat.) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'the link in the chat')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_~|]+/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1500);
}

function pickMime(): string | undefined {
  for (const mime of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported?.(mime)) return mime;
  }
}

const END_SILENCE = 2300;
const MIN_SPEECH = 320;
const MAX_UTTERANCE = 54_000;
const METER_INTERVAL = 40;

function unfinished(text: string, language: string) {
  if (language !== 'auto' && !/^en(?:-|$)/i.test(language)) return false;
  const words = text.toLowerCase().replace(/[.!,…?]+$/g, '').trim();
  return /^(?:(?:um+|uh+|well|so|basically|let me think)[,\s]*)+$/.test(words)
    || /\b(?:want to|need to|going to|trying to|would like to|can you|could you|because|and then|the reason is|what if|such as)$/.test(words);
}

function joinSpeech(first: string, second: string) {
  if (!first) return second;
  return first.replace(/[.!?…]+$/, '') + ' ' + second;
}

let current: LocalCall | null = null;

/** Start a call. Call from a click so the browser lets audio play. */
export function startLocalCall(bot: Bot) {
  if (current && !current.ended) {
    if (current.botId === bot.id) return;
    current.end();
  }
  current = new LocalCall(bot);
  void current.start();
}
export function endLocalCall() { current?.end(); }
export function sendLocalCallDraft() { current?.sendDraft(); }
export function toggleLocalMute() { current?.setMuted(!useLocalCall.getState().muted); }
/** Stop the bot mid-sentence and listen. */
export function interruptLocalCall() { current?.interrupt(); }
export function localCallLevel() { return current && !current.ended ? current.level : 0; }

class LocalCall {
  ended = false;
  level = 0;
  readonly botId: string;
  private readonly ctx: AudioContext;
  private readonly abort = new AbortController();
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private meter: ReturnType<typeof setInterval> | null = null;
  private recorder: MediaRecorder | null = null;
  private micSamples: Float32Array<ArrayBuffer> | null = null;
  private recordStart = 0;
  private speechMs = 0;
  private silenceSince = 0;
  private floor = 0.01;
  private availability: VoiceStatus | null = null;
  private playback: AbortController | null = null;
  private stopRing: (() => void) | null = null;
  private unwatch: (() => void) | null = null;
  private readonly model: ChatModelSelection | null;
  private readonly callId = `call_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  private transcription = Promise.resolve();
  private transcribing = 0;
  private draft = '';
  private recordingChunks: Blob[] = [];
  private turn = 0;
  private pending = false;
  private sendQueue = Promise.resolve();
  private replyTimeout?: ReturnType<typeof setTimeout>;
  private pendingSeq: number | null = null;
  private pendingGeneration: number | null = null;
  private reply = '';

  constructor(private readonly bot: Bot) {
    this.botId = bot.id;
    this.ctx = createAudioContext();
    this.model = callModelFor(bot.id);
  }

  async start() {
    setC({ status: 'ringing', botId: this.botId, startedAt: null, muted: false, caption: null, error: null, draft: false,
      modelLabel: this.model?.label ?? this.model?.model ?? this.bot.chatModel?.label ?? this.bot.chatModel?.model ?? null });
    this.stopRing = playRinging(this.ctx);
    window.speechSynthesis?.getVoices();
    try {
      const availability = voiceApi.status();
      const mic = openMic().then(stream => {
        if (this.ended) stream.getTracks().forEach(track => track.stop());
        else this.stream = stream;
        return stream;
      }).catch(error => { throw new Error(micErrorMessage(error)); });
      const [stream, status] = await Promise.all([mic, availability]);
      if (this.ended) return;
      if (!status.localSpeech) throw new Error('Set up speech in Settings → Audio to make calls.');
      this.availability = status;
      for (const track of stream.getAudioTracks()) track.enabled = !useLocalCall.getState().muted;
      const source = this.ctx.createMediaStreamSource(stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.micSamples = new Float32Array(this.analyser.fftSize);
      source.connect(this.analyser);
      this.startRecorder();
      this.meter = setInterval(() => this.tick(), METER_INTERVAL);
      this.unwatch = useStore.subscribe((state, previous) => {
        if (state.live[this.botId] !== previous.live[this.botId]) this.checkReply(state.live[this.botId]);
      });
      this.stopRing?.();
      this.stopRing = null;
      playConnected(this.ctx);
      setC({ status: 'listening', startedAt: Date.now() });
    } catch (error) {
      this.end((error as Error).message);
    }
  }

  private startRecorder() {
    if (!this.stream || this.ended) return;
    const mime = pickMime();
    const recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.start(250);
    this.recorder = recorder;
    this.recordingChunks = chunks;
    this.recordStart = Date.now();
    this.speechMs = 0;
    this.silenceSince = 0;
  }

  private resetRecorder() {
    this.recorder?.stop();
    this.startRecorder();
  }

  private tick() {
    if (!this.analyser || !this.micSamples || this.ended || !this.recorder) return;
    this.analyser.getFloatTimeDomainData(this.micSamples);
    let sum = 0;
    for (const sample of this.micSamples) sum += sample * sample;
    const rms = Math.sqrt(sum / this.micSamples.length);
    const muted = useLocalCall.getState().muted;
    this.level = muted ? 0 : Math.min(1, rms * 8);
    if (muted) return;

    if (!this.playback && !this.speechMs && rms < this.floor * 2) this.floor = this.floor * 0.97 + rms * 0.03;
    const threshold = Math.max(0.012, this.floor * 3) * (this.playback ? 2.4 : 1);
    const now = Date.now();
    if (rms > threshold) {
      this.speechMs += METER_INTERVAL;
      this.silenceSince = 0;
      if (this.playback && this.speechMs >= MIN_SPEECH) this.interrupt();
      this.updateStatus();
    } else if (this.speechMs) {
      this.silenceSince ||= now;
      // Reject a short noise quickly. Hold real speech through a thinking pause.
      const enoughSpeech = this.speechMs >= MIN_SPEECH;
      if (now - this.silenceSince >= (enoughSpeech ? END_SILENCE : 450)) {
        if (enoughSpeech) this.finishUtterance();
        else this.resetRecorder();
        this.updateStatus();
        return;
      }
    }
    if (!this.speechMs && now - this.recordStart > 3000) this.resetRecorder();
    else if (now - this.recordStart > MAX_UTTERANCE) this.finishUtterance();
  }

  private finishUtterance() {
    const recorder = this.recorder;
    if (!recorder) return;
    const chunks = this.recordingChunks;
    const blob = new Promise<Blob>(resolve => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
    });
    recorder.stop();
    this.startRecorder();
    this.transcribing++;
    this.transcription = this.transcription.then(async () => {
      const audio = await blob;
      if (this.ended) return;
      const text = (await voiceApi.transcribe(audio, this.bot.voiceLanguage,
        AbortSignal.any([this.abort.signal, AbortSignal.timeout(20_000)]), this.availability?.nativeSpeech)).trim();
      if (this.ended || !/[\p{L}\p{N}]/u.test(text)) return;
      if (/^(bye|goodbye|hang up|end (the )?call)[.!]?$/i.test(text)) { this.end(); return; }
      const joined = joinSpeech(this.draft, text);
      if (unfinished(joined, this.bot.voiceLanguage)) {
        this.draft = joined;
        setC({ caption: { role: 'user', text: joined }, draft: true });
      } else {
        this.draft = '';
        setC({ draft: false });
        void this.ask(joined);
      }
    }).catch(error => {
      if (!this.ended) console.warn('[call] transcription failed', error);
    }).finally(() => {
      this.transcribing--;
      this.updateStatus();
    });
  }

  sendDraft() {
    if (!this.draft || this.ended || this.speechMs || this.transcribing) return;
    const text = this.draft;
    this.draft = '';
    setC({ draft: false });
    void this.ask(text);
  }

  private async ask(text: string) {
    const turn = ++this.turn;
    this.pending = true;
    clearTimeout(this.replyTimeout);
    this.pendingSeq = null;
    this.pendingGeneration = null;
    this.reply = '';
    setC({ caption: { role: 'user', text } });
    this.updateStatus();
    try {
      const send = this.sendQueue.then(() => api.sendCall(this.botId, text, this.callId, this.model,
        AbortSignal.any([this.abort.signal, AbortSignal.timeout(20_000)])));
      this.sendQueue = send.then(() => {}, () => {});
      const { row } = await send;
      if (turn !== this.turn || this.ended) return;
      this.pendingSeq = row.seq;
      this.pendingGeneration = row.generation;
      this.replyTimeout = setTimeout(() => {
        this.reply = 'I’m still working on that.';
        this.updateStatus();
      }, 45_000);
      this.checkReply(useStore.getState().live[this.botId]);
    } catch (error) {
      if (turn !== this.turn || this.ended) return;
      this.pending = false;
      this.reply = `I couldn't send that. ${(error as Error).message}`;
      this.updateStatus();
    }
  }

  private checkReply(live?: LiveState) {
    const reply = live?.voiceReply;
    if (!this.pending || !reply || reply.call !== this.callId
       || reply.seq !== this.pendingSeq || reply.generation !== this.pendingGeneration) return;
    this.pending = false;
    clearTimeout(this.replyTimeout);
    this.reply = speakable(reply.text);
    this.updateStatus();
  }

  private updateStatus() {
    if (this.ended || !useLocalCall.getState().startedAt) return;
    const muted = useLocalCall.getState().muted;
    if (this.playback) this.setStatus('speaking');
    else if (!muted && this.speechMs >= 120) this.setStatus('hearing');
    else if (this.transcribing) this.setStatus('transcribing');
    else if (this.draft) this.setStatus('listening');
    else if (this.reply && !this.speechMs) {
      const text = this.reply;
      this.reply = '';
      void this.say(text);
    } else this.setStatus(this.pending ? 'thinking' : 'listening');
  }

  private setStatus(status: LocalCallStatus) {
    if (useLocalCall.getState().status !== status) setC({ status });
  }

  private async say(text: string) {
    const playback = new AbortController();
    this.playback = playback;
    setC({ status: 'speaking', caption: { role: 'assistant', text } });
    try { await this.play(text, playback.signal); }
    catch (error) { if (!playback.signal.aborted) console.warn('[call] playback failed', error); }
    finally {
      if (this.playback === playback) {
        this.playback = null;
        this.updateStatus();
      }
    }
  }

  private async play(text: string, signal: AbortSignal) {
    if (this.availability?.nativePlayback) {
      try {
        const blob = await voiceApi.speech(this.botId, text, this.bot.voiceSpeed || 1,
          AbortSignal.any([signal, AbortSignal.timeout(8000)]));
        if (signal.aborted) return;
        const url = URL.createObjectURL(blob);
        try {
          const audio = new Audio(url);
          await new Promise<void>(resolve => {
            const done = () => {
              signal.removeEventListener('abort', done);
              audio.pause();
              resolve();
            };
            signal.addEventListener('abort', done, { once: true });
            audio.onended = done;
            audio.onerror = done;
            audio.play().catch(done);
          });
        } finally { URL.revokeObjectURL(url); }
        return;
      } catch {
        if (signal.aborted) return;
      }
    }
    const engine = window.speechSynthesis;
    if (!engine) return;
    const voices = engine.getVoices();
    const lang = this.bot.voiceLanguage === 'auto' ? navigator.language : this.bot.voiceLanguage;
    const voice = voices.find(v => v.lang === lang && v.localService) ?? voices.find(v => v.lang.split('-')[0] === lang.split('-')[0]) ?? voices[0];
    await new Promise<void>(resolve => {
      const utterance = new SpeechSynthesisUtterance(text);
      if (voice) { utterance.voice = voice; utterance.lang = voice.lang; }
      utterance.rate = this.bot.voiceSpeed || 1;
      const done = () => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', stop);
        resolve();
      };
      const stop = () => { engine.cancel(); done(); };
      const timeout = setTimeout(stop, Math.min(90_000, 4000 + text.length * 90));
      utterance.onend = done;
      utterance.onerror = done;
      signal.addEventListener('abort', stop, { once: true });
      engine.speak(utterance);
    });
  }

  interrupt() {
    const playback = this.playback;
    this.playback = null;
    playback?.abort();
    this.updateStatus();
  }

  setMuted(muted: boolean) {
    this.stream?.getAudioTracks().forEach(track => { track.enabled = !muted; });
    setC({ muted });
    if (this.recorder) this.resetRecorder();
    this.updateStatus();
  }

  end(error?: string) {
    if (this.ended) return;
    this.ended = true;
    this.abort.abort();
    clearTimeout(this.replyTimeout);
    this.stopRing?.();
    this.unwatch?.();
    if (this.meter) clearInterval(this.meter);
    this.playback?.abort();
    if (this.recorder?.state === 'recording') this.recorder.stop();
    this.stream?.getTracks().forEach(track => track.stop());
    if (!error) playHangUp(this.ctx);
    setTimeout(() => void this.ctx.close().catch(() => {}), 250);
    if (current === this) current = null;
    if (error) {
      setC({ status: 'error', error, startedAt: null });
      setTimeout(() => { if (useLocalCall.getState().status === 'error' && !current) setC({ status: 'idle', botId: null, error: null, caption: null }); }, 6000);
    } else {
      setC({ status: 'idle', botId: null, startedAt: null, caption: null, muted: false, draft: false });
    }
  }
}
