import { useEffect, useRef } from 'react';
import { microphoneId } from '../voice/audio';

/** Bars in the listening graphic. */
export const WAVE_BARS = 9;
/** How often a new loudness sample rolls into the bars. */
const STEP_MS = 55;
/** Microphone loudness (RMS) below this is room noise: the bars stay flat dots. */
const GATE = 0.012;

/** Turn a block of samples into a 0..1 bar height. Silent input is exactly 0; ordinary speech reaches about 0.6-1. */
export function waveLevel(samples: ArrayLike<number>) {
  let sum = 0;
  for (let index = 0; index < samples.length; index++) sum += samples[index] * samples[index];
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  return Math.pow(Math.max(0, Math.min(1, (rms - GATE) * 9)), 0.65);
}

/**
 * A second, listen-only handle on the microphone just to measure loudness. It never records or sends anything and
 * it is never played back. Dictation itself (Web Speech, or MediaRecorder for a speech server) keeps its own
 * capture, so a failure here (no permission, device busy, no Web Audio) only leaves the bars flat.
 */
async function openMeterStream() {
  const devices = navigator.mediaDevices;
  if (!devices?.getUserMedia) throw new Error('no mediaDevices');
  const id = microphoneId();
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1 };
  if (!id) return devices.getUserMedia({ audio });
  try { return await devices.getUserMedia({ audio: { ...audio, deviceId: { exact: id } } }); }
  catch { return devices.getUserMedia({ audio }); }
}

/**
 * The dictation "listening" graphic: a row of rounded bars driven by the live microphone level. While nobody is
 * talking the bars are flat evenly spaced dots; as you speak they rise into pills and the loudness rolls leftwards
 * across the row like an audio meter.
 */
export function VoiceWave({ active }: { active: boolean }) {
  const bars = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => {
    const paint = (levels: number[]) => bars.current.forEach((bar, index) => bar?.style.setProperty('--level', (levels[index] ?? 0).toFixed(3)));
    paint([]);
    if (!active) return;
    let stopped = false;
    let frame = 0;
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    void (async () => {
      try {
        stream = await openMeterStream();
        if (stopped) { stream.getTracks().forEach(track => track.stop()); return; }
        const Context: typeof AudioContext | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Context) throw new Error('no Web Audio');
        context = new Context();
        void context.resume().catch(() => {});
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        // Not connected to the speakers, so the microphone is never played back.
        context.createMediaStreamSource(stream).connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        const history: number[] = new Array(WAVE_BARS).fill(0);
        let last = 0;
        const tick = (now: number) => {
          frame = requestAnimationFrame(tick);
          if (now - last < STEP_MS) return;
          last = now;
          analyser.getFloatTimeDomainData(samples);
          const heard = waveLevel(samples);
          // Rise quickly, fall back gently, so words read as pulses and pauses settle into dots.
          const previous = history[WAVE_BARS - 1];
          history.shift();
          history.push(heard > previous ? previous * 0.25 + heard * 0.75 : previous * 0.55 + heard * 0.45);
          paint(history.map(level => (level < 0.04 ? 0 : level)));
        };
        frame = requestAnimationFrame(tick);
      } catch {
        // No analysis available: the bars simply stay as dots. Dictation is unaffected.
      }
    })();
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach(track => track.stop());
      void context?.close().catch(() => {});
      paint([]);
    };
  }, [active]);

  return (
    <span className="mic-note__wave" aria-hidden="true">
      {Array.from({ length: WAVE_BARS }, (_, index) => <i key={index} ref={element => { bars.current[index] = element; }} />)}
    </span>
  );
}
