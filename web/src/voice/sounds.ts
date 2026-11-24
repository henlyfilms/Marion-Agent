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
