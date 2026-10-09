/**
 * Audio format for voice turns: 16-bit mono PCM in a WAV container.
 *
 * Why not MediaRecorder output: a compressed clip's duration cannot be read
 * reliably from bytes (Opus can run at a tenth of the usual bitrate), so a
 * size cap does not bound what the speech provider bills. With PCM the
 * duration is exact arithmetic on a header the server can verify, before any
 * provider request.
 */

export const PCM_RATE = 16_000;
const HEADER_BYTES = 44;

/** Mono, 16-bit samples at `outRate`, from float chunks captured at `inRate`. */
export function encodeWav16(chunks: Float32Array[], inRate: number, outRate: number = PCM_RATE): ArrayBuffer {
  let total = 0;
  for (const c of chunks) total += c.length;
  const outLength = Math.max(0, Math.floor((total * outRate) / inRate));
  const pcm = new Int16Array(outLength);

  // Average the source samples that fall in each output interval: a cheap
  // low-pass that avoids the worst aliasing when 48 kHz is cut to 16 kHz.
  const ratio = inRate / outRate;
  let chunkIndex = 0;
  let chunkStart = 0; // global index of chunks[chunkIndex][0]
  const sampleAt = (global: number) => {
    while (chunkIndex < chunks.length && global >= chunkStart + chunks[chunkIndex].length) {
      chunkStart += chunks[chunkIndex].length;
      chunkIndex++;
    }
    return chunkIndex < chunks.length ? chunks[chunkIndex][global - chunkStart] : 0;
  };
  for (let i = 0; i < outLength; i++) {
    const from = Math.floor(i * ratio);
    const to = Math.max(from + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let g = from; g < to; g++) sum += sampleAt(g);
    const v = Math.max(-1, Math.min(1, sum / (to - from)));
    pcm[i] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
  }

  const dataBytes = outLength * 2;
  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);
  const str = (offset: number, s: string) => {
    for (let k = 0; k < s.length; k++) view.setUint8(offset + k, s.charCodeAt(k));
  };
  str(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, outRate, true);
  view.setUint32(28, outRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < outLength; i++) view.setInt16(HEADER_BYTES + i * 2, pcm[i], true);
  return buffer;
}

export type WavInfo = { ok: true; seconds: number; sampleRate: number } | { ok: false; reason: string };

/**
 * Strict reader for the one format we accept. The duration comes from the
 * bytes that are actually present, and the declared sizes must agree with the
 * file length, so a header cannot claim a short clip over a long payload.
 */
export function inspectWav(audio: ArrayBuffer): WavInfo {
  if (audio.byteLength < HEADER_BYTES) return { ok: false, reason: 'too_short' };
  const view = new DataView(audio);
  const tag = (o: number) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return { ok: false, reason: 'not_wav' };
  if (view.getUint32(4, true) + 8 !== audio.byteLength) return { ok: false, reason: 'riff_size' };
  if (tag(12) !== 'fmt ' || view.getUint32(16, true) !== 16) return { ok: false, reason: 'fmt' };
  const format = view.getUint16(20, true);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const byteRate = view.getUint32(28, true);
  const blockAlign = view.getUint16(32, true);
  const bits = view.getUint16(34, true);
  if (format !== 1 || channels !== 1 || bits !== 16 || blockAlign !== 2) return { ok: false, reason: 'not_pcm16_mono' };
  if (sampleRate < 8000 || sampleRate > 48_000 || byteRate !== sampleRate * 2) return { ok: false, reason: 'rate' };
  if (tag(36) !== 'data') return { ok: false, reason: 'data' };
  const dataBytes = view.getUint32(40, true);
  if (HEADER_BYTES + dataBytes !== audio.byteLength) return { ok: false, reason: 'data_size' };
  return { ok: true, seconds: dataBytes / 2 / sampleRate, sampleRate };
}

/** Collects mic samples for one turn and stops collecting at a hard ceiling. */
export class PcmCapture {
  private chunks: Float32Array[] = [];
  private samples = 0;
  private readonly maxSamples: number;

  constructor(
    private readonly inRate: number,
    maxSeconds: number
  ) {
    this.maxSamples = Math.floor(inRate * maxSeconds);
  }

  push(frame: Float32Array) {
    if (this.samples >= this.maxSamples) return;
    const room = this.maxSamples - this.samples;
    const part = frame.length <= room ? frame.slice() : frame.slice(0, room);
    this.chunks.push(part);
    this.samples += part.length;
  }

  get seconds() {
    return this.samples / this.inRate;
  }

  toWav(): ArrayBuffer {
    return encodeWav16(this.chunks, this.inRate);
  }
}
