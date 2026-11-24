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
