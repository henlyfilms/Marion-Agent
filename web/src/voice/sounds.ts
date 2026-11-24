import { prefGet, prefSet } from '../lib/prefs';

const preference = 'interfaceSounds';
let audio: AudioContext | undefined;

export const soundsEnabled = () => prefGet(preference) !== 'off';
export const setSoundsEnabled = (enabled: boolean) => prefSet(preference, enabled ? 'on' : 'off');

export function playDictationSound(start: boolean) {
  if (!soundsEnabled()) return;
  try {
    audio ??= new AudioContext();
    void audio.resume().catch(() => {});
    const now = audio.currentTime;
    const tone = audio.createOscillator();
    const volume = audio.createGain();
    tone.frequency.setValueAtTime(start ? 520 : 690, now);
    tone.frequency.exponentialRampToValueAtTime(start ? 690 : 520, now + 0.09);
    volume.gain.setValueAtTime(0.001, now);
    volume.gain.exponentialRampToValueAtTime(0.10, now + 0.02);
    volume.gain.exponentialRampToValueAtTime(0.001, now + 0.13);
    tone.connect(volume).connect(audio.destination);
    tone.start(now);
    tone.stop(now + 0.13);
  } catch { /* Sound feedback is optional. */ }
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

/** A soft two-tone ring, repeated until stopped. Returns a stop function. */
export function playRinging(ctx: AudioContext): () => void {
  if (!soundsEnabled()) return () => {};
  const oscillators: OscillatorNode[] = [];
  let stopped = false;
  const ring = () => {
    if (stopped) return;
    const t = ctx.currentTime + 0.02;
    oscillators.push(tone(ctx, t, 440, 0.42, 0.05), tone(ctx, t, 480, 0.42, 0.05));
    oscillators.push(tone(ctx, t + 0.55, 440, 0.42, 0.05), tone(ctx, t + 0.55, 480, 0.42, 0.05));
  };
  ring();
  const timer = setInterval(ring, 2200);
  return () => {
    stopped = true;
    clearInterval(timer);
    for (const osc of oscillators) { try { osc.stop(); } catch { /* already stopped */ } }
  };
}

/** Rising chime when the call connects. */
export function playConnected(ctx: AudioContext) {
  if (!soundsEnabled()) return;
  const t = ctx.currentTime + 0.02;
  tone(ctx, t, 660, 0.12, 0.07, 'triangle');
  tone(ctx, t + 0.1, 880, 0.18, 0.07, 'triangle');
}

/** Falling chime when the call ends. */
export function playHangUp(ctx: AudioContext) {
  if (!soundsEnabled()) return;
  const t = ctx.currentTime + 0.02;
  tone(ctx, t, 620, 0.13, 0.07, 'triangle');
  tone(ctx, t + 0.12, 420, 0.22, 0.07, 'triangle');
}

/** Tiny blip when the bot has heard you and starts thinking. */
export function playHeard(ctx: AudioContext) {
  if (!soundsEnabled()) return;
  tone(ctx, ctx.currentTime + 0.01, 760, 0.08, 0.035, 'sine');
}
