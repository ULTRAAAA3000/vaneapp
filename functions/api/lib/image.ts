/**
 * Image inspection from raw bytes (no decoding, no dependencies).
 * We trust the FILE, never the Content-Type header the client sent.
 */
export type ImageKind = { ext: 'jpg' | 'png' | 'webp'; mime: 'image/jpeg' | 'image/png' | 'image/webp' };

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

/** JPEG / PNG / WebP by magic bytes, or null. */
export function sniffImage(b: Uint8Array): ImageKind | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (b.length > 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return { ext: 'png', mime: 'image/png' };
  if (b.length > 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}

/** Pixel size read from the file header, or null if the header is unreadable/corrupt. */
export function imageSize(b: Uint8Array, kind: ImageKind): { width: number; height: number } | null {
  let w = 0, h = 0;

  if (kind.ext === 'png') {
    if (b.length < 24 || ascii(b, 12, 16) !== 'IHDR') return null;
    w = u32be(b, 16); h = u32be(b, 20);
  } else if (kind.ext === 'jpg') {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }          // resync
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }             // fill byte
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd9)) { i += 2; continue; } // standalone markers
      const len = u16be(b, i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { // SOFn
        h = u16be(b, i + 5); w = u16be(b, i + 7);
        break;
      }
      if (len < 2) return null;
      i += 2 + len;
    }
  } else {
    const fourcc = ascii(b, 12, 16);
    if (fourcc === 'VP8X' && b.length >= 30) {
      w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
      h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
    } else if (fourcc === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
      w = 1 + (b[21] | ((b[22] & 0x3f) << 8));
      h = 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10));
    } else if (fourcc === 'VP8 ' && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      w = (b[26] | (b[27] << 8)) & 0x3fff;
      h = (b[28] | (b[29] << 8)) & 0x3fff;
    } else return null;
  }
  return w > 0 && h > 0 ? { width: w, height: h } : null;
}

/** Telegram's rules for sendPhoto: width + height ≤ 10000, aspect ratio ≤ 20. Returns a message if violated. */
export function telegramPhotoProblem(width: number, height: number): string | null {
  if (width + height > 10_000) return 'Image is too large in pixels (width + height must be at most 10000).';
  if (Math.max(width, height) / Math.min(width, height) > 20) return 'Image proportions are too extreme (the long side can be at most 20× the short side).';
  return null;
}
