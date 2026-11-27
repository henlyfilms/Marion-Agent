import { toMonoWav } from './wav';
import { TranscriptionError } from './dictationRetry';
import type { VoiceOption } from '@shared/types';

export interface VoiceSession {
  callId: string;
  clientSecret: string;
  expiresAt: number;
  model: string;
  websocketUrl: string;
  sampleRate: number;
  instructions: string;
  voice: string;
  speed: number;
  language: string;
  tools: unknown[];
  session: Record<string, unknown>;
}

export interface VoiceOptions { voices: VoiceOption[]; languages: { code: string; name: string }[]; speeds: number[] }

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/voice${path}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

let optionsPromise: Promise<VoiceOptions> | null = null;

export interface CallVoices { mac: { name: string; language: string }[]; custom: { id: string; name: string; url: string; model: string; voice: string; sampleName: string | null }[] }
export async function callVoices(): Promise<CallVoices> {
  const res = await fetch('/api/voice/voices', { credentials: 'include' });
  if (!res.ok) throw new Error('Could not load voices');
  return res.json();
}
export async function addCallVoice(form: FormData): Promise<{ voice: { id: string; name: string } }> {
  const res = await fetch('/api/voice/voices', { method: 'POST', credentials: 'include', body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? 'Could not add the voice');
  return body;
}
export async function removeCallVoice(id: string) {
  const res = await fetch(`/api/voice/voices/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' });
  if (!res.ok) throw new Error('Could not remove the voice');
}

export interface VoiceStatus { realtime: boolean; localSpeech: boolean; nativeSpeech?: boolean; nativePlayback?: boolean }

let pendingStatus: Promise<VoiceStatus> | undefined;

async function loadStatus(): Promise<VoiceStatus> {
    const response = await fetch('/api/voice/status');
    if (!response.ok) throw new Error('Could not check voice availability');
    return response.json();
}

export const voiceApi = {
  status: () => pendingStatus ??= loadStatus().finally(() => { pendingStatus = undefined; }),
  async speech(botId: string | undefined, text: string, speed: number, signal: AbortSignal) {
    const response = await fetch('/api/voice/speech', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId, text, speed }), signal,
    });
    if (!response.ok) throw new Error('Could not play the Mac voice.');
    return response.blob();
  },
  options: () => (optionsPromise ??= fetch('/api/voice/options', { credentials: 'include' }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<VoiceOptions>;
  }).catch((e) => { optionsPromise = null; throw e; })),
  session: (botId: string) => post<VoiceSession>('/session', { botId }),
  tool: (botId: string, callId: string, name: string, args: unknown) => post<{ output: string; taskSeq?: number }>('/tool', { botId, callId, name, args }),
  end: (botId: string, callId: string, transcript: { role: 'user' | 'assistant'; text: string }[], error?: string) => post<{ ok: true }>('/end', { botId, callId, transcript, error }),
  /** Best-effort end on tab close. */
  endBeacon: (botId: string, callId: string, transcript: { role: 'user' | 'assistant'; text: string }[]) => {
    try { navigator.sendBeacon('/api/voice/end', new Blob([JSON.stringify({ botId, callId, transcript })], { type: 'application/json' })); } catch { /* ignore */ }
  },
  async preview(p: { botId: string; voice?: string; speed?: number; language?: string; text?: string }): Promise<Int16Array> {
    const res = await fetch('/api/voice/preview', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...p, codec: 'pcm' }) });
    if (!res.ok) throw new Error('Preview unavailable');
    const buf = await res.arrayBuffer();
    return new Int16Array(buf, 0, buf.byteLength >> 1);
  },
  /**
   * `final` marks the pass after the user stopped (the server may use its slower, more accurate engine for it; live previews
   * stay on the instant one). `context` is the text around the cursor, used as vocabulary hints.
   */
  async transcribe(blob: Blob, language?: string, signal?: AbortSignal, native = false, hints: { final?: boolean; context?: string } = {}): Promise<string> {
    if (native && blob.type !== 'audio/wav') blob = await toMonoWav(blob);
    signal?.throwIfAborted();
    const fd = new FormData();
    if (language) fd.append('language', language);
    if (hints.final) fd.append('final', '1');
    if (hints.context?.trim()) fd.append('context', hints.context.trim().slice(-600));
    const ext = native ? 'wav' : blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm';
    fd.append('file', blob, `dictation.${ext}`);
    const res = await fetch('/api/voice/stt', { method: 'POST', credentials: 'include', body: fd, signal }).catch((cause: unknown) => {
      // A cancel stays a cancel; anything else means the app's own server could not be reached ("Failed to fetch" says nothing).
      if (signal?.aborted || (cause as Error)?.name === 'AbortError') throw cause;
      throw new TranscriptionError("Can't reach Marion Agent. Check that it is still running. Your recording is kept: try again.", 0, 'network_error', true);
    });
    if (!res.ok) {
      // Keep the server's status, code and message: an unsupported macOS or language is not a passing failure.
      let body: { error?: string; code?: string; retryable?: boolean } = {};
      try { body = (await res.json()) as typeof body; } catch { /* not json */ }
      throw new TranscriptionError(body.error || 'Transcription failed', res.status, body.code, body.retryable ?? res.status >= 500);
    }
    return ((await res.json()) as { text: string }).text;
  },
};
