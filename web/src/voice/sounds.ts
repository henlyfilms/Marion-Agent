import { prefGet, prefSet } from '../lib/prefs';

const preference = 'interfaceSounds';
let audio: AudioContext | undefined;

export const soundsEnabled = () => prefGet(preference) !== 'off';
export const setSoundsEnabled = (enabled: boolean) => prefSet(preference, enabled ? 'on' : 'off');

type AudioClass = typeof AudioContext;

/**
 * The one Web Audio context shared by the dictation cues and the listening bars. Call it from a click or key handler
 * (`primeAudio`) so the browser's autoplay rules let it run; a closed context is replaced.
 */
export function sharedAudio(): AudioContext | undefined {
  try {
    if (!audio || audio.state === 'closed') {
      const Context: AudioClass | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioClass }).webkitAudioContext;
      if (!Context) return undefined;
      audio = new Context({ latencyHint: 'interactive' });
    }
    if (audio.state !== 'running') void audio.resume().catch(() => {});
    return audio;
  } catch { return undefined; }
}

/** Unlock audio inside the user's gesture, before any microphone or speech work starts. */
export const primeAudio = () => { sharedAudio(); };

export function playDictationSound(start: boolean) {
  if (!soundsEnabled()) return;
  const ctx = sharedAudio();
  if (!ctx) return;
  const play = () => {
    try {
      const now = ctx.currentTime;
      const tone = ctx.createOscillator();
      const volume = ctx.createGain();
      tone.frequency.setValueAtTime(start ? 520 : 690, now);
      tone.frequency.exponentialRampToValueAtTime(start ? 690 : 520, now + 0.09);
      volume.gain.setValueAtTime(0.001, now);
      volume.gain.exponentialRampToValueAtTime(0.10, now + 0.02);
      volume.gain.exponentialRampToValueAtTime(0.001, now + 0.13);
      tone.connect(volume).connect(ctx.destination);
      tone.start(now);
      tone.stop(now + 0.13);
    } catch { /* Sound feedback is optional. */ }
  };
  // A context that is still waking up plays the cue the moment it runs, never against a frozen clock.
  if (ctx.state === 'running') play();
  else void ctx.resume().then(play).catch(() => {});
}

// ---------- call sounds (synthesised, so there are no audio files to ship) ----------

function tone(ctx: AudioContext, at: number, freq: number, length: number, gain: number, type: OscillatorType = 'sine') {
  const osc = ctx.createOscillator();
  const volume = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  volume.gain.setValueAtTime(0.0001, at);
  volume.gain.exponentialRampToValueAtTime(gain, at + 0.02);
  volume.gain.setValueAtTime(gain, at + Math.max(0.03, length - 0.06));
  volume.gain.exponentialRampToValueAtTime(0.0001, at + length);
  osc.connect(volume).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + length + 0.02);
  return osc;
}

/** A short, low ring while the connection opens. */
export function playRinging(ctx: AudioContext): () => void {
  if (!soundsEnabled()) return () => {};
  let oscillator: OscillatorNode;
  const ring = () => { oscillator = tone(ctx, ctx.currentTime, 420, 0.25, 0.03); };
  ring();
  const timer = setInterval(ring, 2300);
  return () => {
    clearInterval(timer);
    oscillator.stop();
  };
}

export function playConnected(ctx: AudioContext) {
  if (soundsEnabled()) tone(ctx, ctx.currentTime, 480, 0.10, 0.025);
}

export function playHangUp(ctx: AudioContext) {
  if (soundsEnabled()) tone(ctx, ctx.currentTime, 320, 0.14, 0.025);
}
