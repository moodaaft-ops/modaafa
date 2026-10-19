/**
 * Reads the size and format of an image from its header bytes. No image library:
 * only PNG, JPEG, GIF and WEBP headers are parsed, nothing is decoded.
 */
export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp';
export type ImageProbe = { format: ImageFormat; width: number; height: number };

const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u24le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

export function probeImage(bytes: Uint8Array): ImageProbe | null {
  if (bytes.length < 16) return null;
  // PNG
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG' && ascii(bytes, 12, 4) === 'IHDR') {
    const width = u32be(bytes, 16);
    const height = u32be(bytes, 20);
    return width > 0 && height > 0 ? { format: 'png', width, height } : null;
  }
  // GIF
  if (ascii(bytes, 0, 3) === 'GIF') {
    const width = u16le(bytes, 6);
    const height = u16le(bytes, 8);
    return width > 0 && height > 0 ? { format: 'gif', width, height } : null;
  }
  // JPEG: walk the segments until a start-of-frame marker.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let o = 2;
    while (o + 9 < bytes.length) {
      if (bytes[o] !== 0xff) { o += 1; continue; }
      const marker = bytes[o + 1];
      if (marker === 0xff) { o += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
      const length = u16be(bytes, o + 2);
      if (length < 2) return null;
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        const height = u16be(bytes, o + 5);
        const width = u16be(bytes, o + 7);
        return width > 0 && height > 0 ? { format: 'jpeg', width, height } : null;
      }
      o += 2 + length;
    }
    return null;
  }
  // WEBP (RIFF container)
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const kind = ascii(bytes, 12, 4);
    if (kind === 'VP8X' && bytes.length >= 30) {
      return { format: 'webp', width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
    }
    if (kind === 'VP8 ' && bytes.length >= 30) {
      return { format: 'webp', width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
    }
    if (kind === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
      const b = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
      return { format: 'webp', width: (b & 0x3fff) + 1, height: ((b >>> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}
