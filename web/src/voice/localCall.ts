// Hands-free voice calls that talk to the chat's own model (local or subscription).
// The call rings, the bot says hi first, then Marion listens continuously: when you stop talking it
// transcribes what you said, sends it to the bot, and speaks the reply back. No push-to-talk.
import { create } from 'zustand';
import type { Bot, ChatModelSelection, Row } from '@shared/types';
import { api } from '../lib/api';
import { prefGet, prefSet } from '../lib/prefs';
import { sortedRows, useStore } from '../store';
import { voiceApi, type VoiceStatus } from './api';
import { createAudioContext, micErrorMessage, openMic } from './audio';
import { playConnected, playHangUp, playHeard, playRinging } from './sounds';

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
}

export const useLocalCall = create<LocalCallState>(() => ({
  status: 'idle', botId: null, startedAt: null, muted: false, caption: null, error: null, modelLabel: null,
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

const REPLY_TIMEOUT = 6 * 60_000;
/** Silence that ends a sentence, and the shortest speech worth sending. */
const END_SILENCE = 1100;
const MIN_SPEECH = 350;
const MAX_UTTERANCE = 60_000;

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
  private chunks: Blob[] = [];
  private recordStart = 0;
  private speechMs = 0;
  private speechStartedAt = 0;
  private silenceSince = 0;
  private floor = 0.01;
  private availability: VoiceStatus | null = null;
  private audio: HTMLAudioElement | null = null;
  private audioUrl: string | null = null;
  private utterance: SpeechSynthesisUtterance | null = null;
  private speakDone: (() => void) | null = null;
  private stopRing: (() => void) | null = null;
  private model: ChatModelSelection | null;
  private callId = `call_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  private bargeMs = 0;

  constructor(private readonly bot: Bot) {
    this.botId = bot.id;
    this.ctx = createAudioContext();
    this.model = callModelFor(bot.id);
  }

  private get status() { return useLocalCall.getState().status; }

  async start() {
    setC({ status: 'ringing', botId: this.botId, startedAt: null, muted: false, caption: null, error: null, modelLabel: this.model?.label ?? this.model?.model ?? null });
    this.stopRing = playRinging(this.ctx);
    const ringUntil = Date.now() + 1800;
    window.speechSynthesis?.getVoices();
    try {
      const [stream, availability] = await Promise.all([openMic(), voiceApi.status()]);
      if (this.ended) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      this.availability = availability;
      if (!availability.localSpeech) throw new Error('Set up speech in Settings → Audio to make calls.');
      const source = this.ctx.createMediaStreamSource(stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      source.connect(this.analyser);
      this.meter = setInterval(() => this.tick(), 40);
    } catch (error) {
      this.end((error as { name?: string })?.name ? micErrorMessage(error) : (error as Error).message);
      return;
    }
    // Let it ring briefly so it feels like a call, then pick up.
    await new Promise(resolve => setTimeout(resolve, Math.max(0, ringUntil - Date.now())));
    if (this.ended) return;
    this.stopRing?.();
    this.stopRing = null;
    playConnected(this.ctx);
    setC({ startedAt: Date.now() });
    await new Promise(resolve => setTimeout(resolve, 350));
    if (this.ended) return;
    // The Mac app's account is called "Local workspace": greet by name only when there is a real one.
    const name = useStore.getState().user?.name ?? '';
    const first = /^local workspace$/i.test(name.trim()) ? '' : name.split(/\s+/)[0];
    await this.say(`Hi${first ? ` ${first}` : ''}! It's ${this.bot.name}. What can I do for you?`);
    this.listen();
  }

  // ---------- listening ----------

  private listen() {
    if (this.ended) return;
    setC({ status: 'listening' });
    this.startRecorder();
  }

  private startRecorder() {
    if (!this.stream || this.ended) return;
    try { if (this.recorder?.state === 'recording') this.recorder.stop(); } catch { /* already stopped */ }
    const mime = pickMime();
    const recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.speechMs = 0;
    this.speechStartedAt = 0;
    this.silenceSince = 0;
    this.recordStart = Date.now();
    recorder.ondataavailable = (event) => { if (event.data.size && this.recorder === recorder) this.chunks.push(event.data); };
    recorder.start(250);
    this.recorder = recorder;
  }

  /** Read the mic level and decide when a sentence starts and ends. */
  private tick() {
    if (!this.analyser || this.ended) return;
    const data = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const sample of data) sum += sample * sample;
    const rms = Math.sqrt(sum / data.length);
    const muted = useLocalCall.getState().muted;
    this.level = muted ? 0 : Math.min(1, rms * 8);
    const status = this.status;

    // Learn the room's background noise while nobody is talking.
    if (status === 'listening' && rms < this.floor * 2) this.floor = this.floor * 0.97 + rms * 0.03;
    const threshold = Math.max(0.012, this.floor * 3);

    if (status === 'speaking' && !muted) {
      // Talking over the bot interrupts it (echo cancellation keeps its own voice out).
      this.bargeMs = rms > threshold * 2.4 ? this.bargeMs + 40 : 0;
      if (this.bargeMs > 280) { this.bargeMs = 0; this.interrupt(); }
      return;
    }
    if (status !== 'listening' && status !== 'hearing') return;
    if (muted) { if (status === 'hearing') setC({ status: 'listening' }); this.speechMs = 0; return; }

    const now = Date.now();
    if (rms > threshold) {
      if (!this.speechStartedAt) this.speechStartedAt = now;
      this.speechMs += 40;
      this.silenceSince = 0;
      if (this.speechMs >= 120 && status !== 'hearing') setC({ status: 'hearing' });
    } else if (this.speechMs > 0) {
      this.silenceSince ||= now;
      if (now - this.silenceSince > END_SILENCE) {
        if (this.speechMs >= MIN_SPEECH) void this.finishUtterance();
        else { this.speechMs = 0; this.speechStartedAt = 0; this.silenceSince = 0; setC({ status: 'listening' }); }
        return;
      }
    }
    // Keep recordings short while nobody talks, and cap very long ones.
    if (!this.speechMs && now - this.recordStart > 15_000) this.startRecorder();
    else if (now - this.recordStart > MAX_UTTERANCE) void this.finishUtterance();
  }

  private async finishUtterance() {
    const recorder = this.recorder;
    if (!recorder || this.ended) return;
    this.recorder = null;
    setC({ status: 'transcribing' });
    const blob = await new Promise<Blob>(resolve => {
      recorder.onstop = () => resolve(new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' }));
      try { recorder.stop(); } catch { resolve(new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' })); }
    });
    if (this.ended) return;
    let text = '';
    try {
      text = (await voiceApi.transcribe(blob, this.bot.voiceLanguage, this.abort.signal, this.availability?.nativeSpeech)).trim();
    } catch (error) {
      if (this.ended) return;
      // A failed pass (noise, a cough) shouldn't end the call: just keep listening.
      console.warn('[call] transcription failed', error);
    }
    if (this.ended) return;
    if (!text || text.replace(/[^\p{L}\p{N}]/gu, '').length < 2) { this.listen(); return; }
    if (/^(bye|goodbye|hang up|end (the )?call)[.!]?$/i.test(text)) {
      setC({ caption: { role: 'user', text } });
      await this.say('Talk soon. Bye!');
      this.end();
      return;
    }
    await this.ask(text);
  }

  // ---------- one turn ----------

  private async ask(text: string) {
    setC({ status: 'thinking', caption: { role: 'user', text } });
    playHeard(this.ctx);
    let row: Row;
    try {
      ({ row } = await api.sendCall(this.botId, text, this.callId, this.model));
    } catch (error) {
      await this.say(`Sorry, I couldn't send that. ${(error as Error).message}`);
      this.listen();
      return;
    }
    const reply = await this.waitForReply(row.seq);
    if (this.ended) return;
    await this.say(reply);
    this.listen();
  }

  /** Wait until the bot finishes its turn, then return what to say. */
  private waitForReply(afterSeq: number): Promise<string> {
    return new Promise(resolve => {
      let settled = false;
      let quietSince = 0;
      const done = (text: string) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        clearTimeout(timeout);
        clearInterval(poll);
        this.abort.signal.removeEventListener('abort', onAbort);
        resolve(text);
      };
      const check = () => {
        const state = useStore.getState();
        const live = state.live[this.botId];
        const rows = sortedRows(state.transcripts[this.botId]).filter(r => r.seq > afterSeq);
        if (live?.awaiting) { done(`I need your OK on screen first: ${live.awaiting.reason}.`); return; }
        const error = rows.find(r => r.body.type === 'notice' && (r.body.tone === 'error' || r.body.text === 'Stopped.'));
        if (error && error.body.type === 'notice') { done(error.body.tone === 'error' ? 'Sorry, something went wrong. The details are in the chat.' : 'Okay, I stopped.'); return; }
        const streaming = rows.some(r => r.body.type === 'message' && r.body.streaming);
        const replies = rows.filter(r => r.body.type === 'message' && r.body.role === 'assistant' && !r.body.from && !r.body.streaming);
        if (live?.isRunning || streaming || !replies.length) { quietSince = 0; return; }
        // Turns can briefly look idle between steps; wait a beat before speaking.
        quietSince ||= Date.now();
        if (Date.now() - quietSince < 600) return;
        const last = replies.at(-1)!.body;
        done(last.type === 'message' ? speakable(last.text) || 'Done. It\'s in the chat.' : 'Done.');
      };
      const unsubscribe = useStore.subscribe(check);
      const poll = setInterval(check, 400);
      const timeout = setTimeout(() => done('This is taking a while. I\'ll keep working, and the answer will be in the chat.'), REPLY_TIMEOUT);
      const onAbort = () => done('');
      this.abort.signal.addEventListener('abort', onAbort);
      check();
    });
  }

  // ---------- speaking ----------

  private async say(text: string) {
    if (this.ended || !text) return;
    try { if (this.recorder?.state === 'recording') this.recorder.stop(); } catch { /* ignore */ }
    this.recorder = null;
    setC({ status: 'speaking', caption: { role: 'assistant', text } });
    await new Promise<void>(resolve => {
      this.speakDone = resolve;
      void this.play(text).finally(() => this.finishSpeaking());
    });
  }

  private finishSpeaking() {
    const done = this.speakDone;
    this.speakDone = null;
    this.stopAudio();
    done?.();
  }

  private async play(text: string) {
    if (this.availability?.nativePlayback) {
      try {
        const blob = await voiceApi.speech(this.botId, text.slice(0, 4000), this.bot.voiceSpeed || 1, this.abort.signal);
        if (this.ended || !this.speakDone) return;
        this.audioUrl = URL.createObjectURL(blob);
        const audio = new Audio(this.audioUrl);
        this.audio = audio;
        await new Promise<void>(resolve => {
          audio.onended = () => resolve();
          audio.onerror = () => resolve();
          audio.onpause = () => resolve();
          audio.play().catch(() => resolve());
        });
        return;
      } catch {
        if (this.ended) return;
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
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();
      this.utterance = utterance;
      engine.cancel();
      engine.speak(utterance);
      // Some engines never fire onend; never hang the call.
      setTimeout(resolve, Math.min(90_000, 4000 + text.length * 90));
    });
  }

  private stopAudio() {
    if (this.audio) { this.audio.pause(); this.audio = null; }
    if (this.audioUrl) { URL.revokeObjectURL(this.audioUrl); this.audioUrl = null; }
    if (this.utterance) { this.utterance = null; window.speechSynthesis?.cancel(); }
  }

  interrupt() {
    if (this.status !== 'speaking') return;
    this.finishSpeaking();
  }

  setMuted(muted: boolean) {
    setC({ muted });
    if (muted && (this.status === 'hearing')) { this.startRecorder(); setC({ status: 'listening' }); }
  }

  // ---------- hang up ----------

  end(error?: string) {
    if (this.ended) return;
    this.ended = true;
    this.abort.abort();
    this.stopRing?.();
    if (this.meter) clearInterval(this.meter);
    this.finishSpeaking();
    try { if (this.recorder?.state === 'recording') this.recorder.stop(); } catch { /* ignore */ }
    this.stream?.getTracks().forEach(track => track.stop());
    if (!error) playHangUp(this.ctx);
    setTimeout(() => void this.ctx.close().catch(() => {}), 700);
    if (current === this) current = null;
    if (error) {
      setC({ status: 'error', error, startedAt: null });
      setTimeout(() => { if (useLocalCall.getState().status === 'error' && !current) setC({ status: 'idle', botId: null, error: null, caption: null }); }, 6000);
    } else {
      setC({ status: 'idle', botId: null, startedAt: null, caption: null, muted: false });
    }
  }
}
