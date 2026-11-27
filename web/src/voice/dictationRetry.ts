/**
 * A recording whose final transcription failed, held so the owner can retry it without speaking again.
 *
 * Privacy: the audio lives ONLY in this object (JavaScript memory). It is never written to disk, localStorage,
 * sessionStorage, IndexedDB, the Cache API or anywhere else, and it is dropped on a successful retry, on discard,
 * when a new recording starts, and when the page goes away. Keep it that way: no persistence may be added here.
 */
export interface HeldRecording {
  audio: Blob;
  /** Recorded as lossless WAV for Mac dictation. */
  native: boolean;
  /** Why the last attempt failed (shown next to Retry). */
  error: string;
  /** Server error code, when it sent one (e.g. mac_dictation_unsupported_locale). */
  code?: string;
  /** False when the server said the same audio will fail again until something changes (macOS, language, setup). */
  retryable: boolean;
  /** The chat the recording belongs to. */
  botId?: string;
}

/** A transcription failure as reported by voiceApi.transcribe: the server's message plus its status and code. */
export class TranscriptionError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly retryable = true) {
    super(message);
    this.name = 'TranscriptionError';
  }
}

/**
 * Which buttons the mic note offers for a failed recording. Retry only when the server said the same audio can succeed
 * again (`retryable`); otherwise only Discard, since retrying would fail the same way until something changes.
 */
export function retryActions(retry: { retryable: boolean } | undefined, idle: boolean) {
  const kept = !!retry && idle;
  return { kept, retry: kept && retry!.retryable === true, discard: kept };
}

export interface RetryHold {
  /** Keep `recording` (replacing any older one). */
  hold(recording: HeldRecording): void;
  current(): HeldRecording | undefined;
  /** Forget the held audio. */
  clear(): void;
  /** Whether a retry is running right now. */
  busy(): boolean;
  /**
   * Transcribe the held recording again. Success (even an empty transcript) drops it; failure keeps it, with the new
   * error, for another try. A retry while another runs, or with nothing held, does nothing and returns undefined.
   */
  retry(transcribe: (recording: HeldRecording) => Promise<string>): Promise<string | undefined>;
}

export function createRetryHold(onChange?: (held: HeldRecording | undefined) => void): RetryHold {
  let held: HeldRecording | undefined;
  let running = false;
  const set = (next: HeldRecording | undefined) => { held = next; onChange?.(next); };
  return {
    hold: recording => set(recording),
    current: () => held,
    clear: () => { if (held) set(undefined); },
    busy: () => running,
    async retry(transcribe) {
      const recording = held;
      if (!recording || running) return undefined;
      running = true;
      try {
        const text = await transcribe(recording);
        if (held === recording) set(undefined);
        return text;
      } catch (cause) {
        // Still the same recording (not discarded or replaced meanwhile): keep it, with the latest reason.
        if (held === recording) {
          const e = cause as Partial<TranscriptionError>;
          set({ ...recording, error: e?.message || recording.error, code: e?.code ?? recording.code, retryable: e?.retryable ?? recording.retryable });
        }
        throw cause;
      } finally { running = false; }
    },
  };
}
