export async function toMonoWav(recording: Blob): Promise<Blob> {
  const rate = 16_000;
  const decoder = new OfflineAudioContext(1, 1, rate);
  const decoded = await decoder.decodeAudioData(await recording.arrayBuffer());
  const samples = decoded.getChannelData(0);
  const output = new ArrayBuffer(44 + 2 * samples.length);
  const header = new DataView(output);
  const bytes = new Uint8Array(output);
  for (const [offset, label] of [[0, 'RIFF'], [8, 'WAVEfmt '], [36, 'data']] as const) {
    bytes.set(new TextEncoder().encode(label), offset);
  }
  header.setUint32(4, output.byteLength - 8, true);
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, rate, true);
  header.setUint32(28, rate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  header.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    header.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  }
  return new Blob([output], { type: 'audio/wav' });
}
