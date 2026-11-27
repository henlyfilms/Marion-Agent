/**
 * Turns a failed Mac dictation pass into something the owner can act on. The native speech helper (scripts/macos/
 * Transcribe.swift) and whisper.cpp fail for reasons that a retry will never fix — macOS too old, the language not
 * supported, no engine installed — and those must not look like a passing server hiccup (a generic 502).
 * Unknown failures stay a 502 marked retryable, so the client keeps the recording and offers to try again.
 */
export type DictationErrorCode =
  | 'mac_dictation_unsupported_os'
  | 'mac_dictation_unsupported_locale'
  | 'mac_dictation_unavailable'
  | 'mac_permission_denied'
  | 'speech_service_unreachable'
  | 'speech_service_auth'
  | 'speech_service_rejected'
  | 'speech_service_rate_limited'
  | 'speech_service_bad_response'
  | 'transcription_failed';

export interface DictationFailure {
  status: 403 | 422 | 429 | 501 | 502 | 503;
  code: DictationErrorCode;
  error: string;
  /** Whether sending the same recording again could work without the owner changing anything. */
  retryable: boolean;
}

function textOf(error: unknown) {
  if (typeof error === 'string') return error;
  const e = error as { stderr?: unknown; message?: unknown } | undefined;
  return [e?.stderr, e?.message].filter(part => typeof part === 'string' && part).join('\n');
}

const languageLabel = (locale: string) => {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(locale) ?? locale; } catch { return locale; }
};

const ELSEWHERE = 'or set up a speech provider in Settings → Audio';

/** What to tell the client about a failed Mac dictation pass. `language` is the locale that was asked for ('' = the Mac's own). */
export function classifyDictationError(error: unknown, language: string): DictationFailure {
  const text = textOf(error);
  if (/requires macOS \d+|macOS \d+ or (?:later|newer)|unsupported (?:os|operating system|macos)/i.test(text)) {
    return { status: 501, code: 'mac_dictation_unsupported_os', retryable: false,
      error: `Mac dictation needs macOS 26 or later. Update macOS, install Whisper (whisper-cli and a model), ${ELSEWHERE}.` };
  }
  if (/unavailable for this Mac or language|unsupported (?:locale|language)|locale [^\n]* not supported|language [^\n]* not supported|not supported for (?:this )?(?:locale|language)/i.test(text)) {
    return language
      ? { status: 422, code: 'mac_dictation_unsupported_locale', retryable: false,
          error: `Mac dictation doesn't support ${languageLabel(language)} (${language}) on this Mac. Pick another dictation language for this Bot (or Auto), ${ELSEWHERE}.` }
      : { status: 422, code: 'mac_dictation_unsupported_locale', retryable: false,
          error: `Mac dictation doesn't support this Mac's language. Pick a dictation language for this Bot, ${ELSEWHERE}.` };
  }
  if (/Built-in dictation is unavailable|Whisper is not installed|ENOENT/i.test(text)) {
    return { status: 503, code: 'mac_dictation_unavailable', retryable: false,
      error: `Mac dictation isn't set up on this Mac. Reinstall Marion Agent, install Whisper (whisper-cli and a model), ${ELSEWHERE}.` };
  }
  return { status: 502, code: 'transcription_failed', retryable: true,
    error: 'Mac dictation could not transcribe this recording. Your recording is kept: try again, or check the language.' };
}

/** A macOS privacy block (Microphone / Speech Recognition) is never fixed by retrying the same audio: the owner must allow it. */
export const MAC_PERMISSION_FAILURE = { status: 403, code: 'mac_permission_denied', retryable: false } as const;

/**
 * What to tell the client when the speech server (xAI, or the owner's local MARION_STT_URL) failed. `status` is the
 * upstream HTTP status, or undefined when it could not be reached at all (network down, DNS, refused, timed out).
 * Only a real speech-service fault stays a 502; everything else gets a status and a sentence saying what to do.
 */
export function classifySpeechServiceFailure(status: number | undefined, local: boolean): DictationFailure {
  const service = local ? 'your local speech server (MARION_STT_URL)' : 'the speech service';
  const kept = 'Your recording is kept: try again';
  if (status === undefined) {
    return { status: 503, code: 'speech_service_unreachable', retryable: true,
      error: local ? `Can't reach ${service}. Check that it is running. ${kept}.` : `Can't reach ${service}. Check your internet connection. ${kept}.` };
  }
  if (status === 401 || status === 403) {
    return { status: 503, code: 'speech_service_auth', retryable: false,
      error: local ? `${service[0].toUpperCase()}${service.slice(1)} refused Marion's key. Check MARION_STT_KEY.` : `The speech service refused Marion's key. Check the speech provider in Settings → Audio.` };
  }
  if (status === 429) {
    return { status: 429, code: 'speech_service_rate_limited', retryable: true,
      error: `${local ? 'Your local speech server' : 'The speech service'} is rate limiting requests. Wait a moment. ${kept}.` };
  }
  if (status === 400 || status === 413 || status === 415 || status === 422) {
    return { status: 422, code: 'speech_service_rejected', retryable: false,
      error: `${local ? 'Your local speech server' : 'The speech service'} couldn't read this recording (format or language). Pick another dictation language for this Bot (or Auto), or record again.` };
  }
  return { status: 502, code: 'transcription_failed', retryable: true,
    error: `${local ? 'Your local speech server' : 'The speech service'} failed to transcribe this recording (HTTP ${status}). ${kept}.` };
}

/** The speech server answered 2xx but without a transcript. */
export const BAD_RESPONSE_FAILURE: DictationFailure = { status: 502, code: 'speech_service_bad_response', retryable: true,
  error: 'The speech service returned no transcript. Your recording is kept: try again.' };
