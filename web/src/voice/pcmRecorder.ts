// Lossless dictation capture. MediaRecorder squeezes speech through Opus and the Mac recogniser then has to decode that
// (and the browser's own noise suppression / auto-gain eat soft word starts); here the microphone's raw samples are kept
// as 16 kHz PCM and handed over as a WAV, so every pass is a cheap copy instead of a decode of the whole recording.

const WORKLET = `
class PcmTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1600); this.n = 0; this.port.onmessage = (e) => { if (e.data === 'flush') { this.send(); this.port.postMessage('flushed'); } }; }
  send() { if (this.n) { this.port.postMessage(this.buf.slice(0, this.n)); this.n = 0; } }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) { this.buf[this.n++] = ch[i]; if (this.n === this.buf.length) this.send(); }
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);
`;

let workletUrl: string | undefined;
const TARGET_RATE = 16_000;
/** Silence appended to every WAV: recognisers cut the last word when the audio ends right on it. */
const TAIL_MS = 450;

/** Float samples → 16-bit mono WAV. Quiet recordings are brought up to a healthy level (never past 0.9 peak / 24 dB gain). */
export function samplesToWav(parts: Float32Array[], rate: number, tailMs = TAIL_MS): Blob {
  let frames = 0;
  for (const part of parts) frames += part.length;
  let peak = 0;
  for (const part of parts) for (let i = 0; i < part.length; i++) { const a = Math.abs(part[i]); if (a > peak) peak = a; }
  const gain = peak > 0.002 ? Math.min(16, 0.9 / peak) : 1;
  const tail = Math.round(rate * tailMs / 1000);
  const output = new ArrayBuffer(44 + 2 * (frames + tail));
  const view = new DataView(output);
  const bytes = new Uint8Array(output);
  for (const [offset, label] of [[0, 'RIFF'], [8, 'WAVEfmt '], [36, 'data']] as const) bytes.set(new TextEncoder().encode(label), offset);
  view.setUint32(4, output.byteLength - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, (frames + tail) * 2, true);
  let at = 44;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++, at += 2) view.setInt16(at, Math.max(-1, Math.min(1, part[i] * gain)) * 32767, true);
  }
  return new Blob([output], { type: 'audio/wav' });
}

export class PcmRecorder {
  state: 'recording' | 'inactive' = 'recording';
  readonly mimeType = 'audio/wav';
  onstop: (() => void) | null = null;
  private parts: Float32Array[] = [];
  private flushed?: () => void;

  private ctx: AudioContext;
  private source: MediaStreamAudioSourceNode;
  private node: AudioWorkletNode;

  private constructor(ctx: AudioContext, source: MediaStreamAudioSourceNode, node: AudioWorkletNode) {
    this.ctx = ctx;
    this.source = source;
    this.node = node;
    node.port.onmessage = (event: MessageEvent<Float32Array | string>) => {
      if (event.data === 'flushed') this.flushed?.();
      else if (typeof event.data !== 'string') this.parts.push(event.data);
    };
  }

  /** Number of audio blocks captured so far (grows while recording). */
  get chunkCount() { return this.parts.length; }

  static async open(stream: MediaStream): Promise<PcmRecorder> {
    let ctx: AudioContext;
    try { ctx = new AudioContext({ sampleRate: TARGET_RATE, latencyHint: 'interactive' }); }
    catch { ctx = new AudioContext({ latencyHint: 'interactive' }); } // the WAV header records whatever rate the context ended up with
    try {
      await ctx.resume();
      workletUrl ??= URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(workletUrl);
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
      const sink = ctx.createGain(); // a worklet only runs while connected onward; keep it silent
      sink.gain.value = 0;
      source.connect(node);
      node.connect(sink).connect(ctx.destination);
      return new PcmRecorder(ctx, source, node);
    } catch (error) {
      void ctx.close().catch(() => {});
      throw error;
    }
  }

  /** The audio so far as a WAV (what the live preview and the final pass send). */
  wav() { return samplesToWav(this.parts, this.ctx.sampleRate); }

  /** Stops capturing, keeps every sample the microphone delivered, then calls onstop. */
  stop() {
    if (this.state !== 'recording') return;
    this.state = 'inactive';
    const done = () => {
      this.flushed = undefined;
      try { this.source.disconnect(); this.node.disconnect(); } catch { /* already disconnected */ }
      void this.ctx.close().catch(() => {});
      this.onstop?.();
    };
    this.flushed = done;
    this.node.port.postMessage('flush');
    setTimeout(() => { if (this.flushed === done) done(); }, 300); // never hang on a worklet that already died
  }
}
