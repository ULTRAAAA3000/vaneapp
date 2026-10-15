/**
 * MP4 / QuickTime detection from the file's own bytes (ISO base media file format).
 * Telegram plays MPEG-4 (H.264) as a real video; anything else is delivered as a document,
 * so we only accept containers that are genuinely MP4/MOV.
 */
export type VideoKind = { ext: 'mp4' | 'mov'; mime: 'video/mp4' | 'video/quicktime' };

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

const MP4_BRANDS = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'M4V ', 'mmp4', 'f4v ']);
const AUDIO_ONLY_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ', 'F4A ', 'F4B ']);

/** Walks the top-level boxes and reports whether a box of this type is present. */
function hasTopLevelBox(b: Uint8Array, type: string): boolean {
  let i = 0;
  for (let guard = 0; guard < 64 && i + 8 <= b.length; guard++) {
    let size = u32be(b, i);
    const t = ascii(b, i + 4, i + 8);
    if (t === type) return true;
    if (size === 1) {                                  // 64-bit size follows the type
      if (i + 16 > b.length) return false;
      if (u32be(b, i + 8) !== 0) return false;         // > 4 GB: far beyond our limit
      size = u32be(b, i + 12);
    } else if (size === 0) {
      return false;                                    // "extends to end of file": no more boxes after it
    }
    if (size < 8) return false;
    i += size;
  }
  return false;
}

/** MP4 or MOV, or null. A file without a `moov` box (truncated upload) is rejected. */
export function sniffVideo(b: Uint8Array): VideoKind | null {
  if (b.length < 24 || ascii(b, 4, 8) !== 'ftyp') return null;
  const boxSize = u32be(b, 0);
  if (boxSize < 16 || boxSize > Math.min(4096, b.length)) return null;

  const major = ascii(b, 8, 12);
  if (AUDIO_ONLY_BRANDS.has(major)) return null;

  let kind: VideoKind | null = null;
  if (major === 'qt  ') kind = { ext: 'mov', mime: 'video/quicktime' };
  else if (MP4_BRANDS.has(major)) kind = { ext: 'mp4', mime: 'video/mp4' };
  else {
    for (let i = 16; i + 4 <= boxSize; i += 4) {      // compatible brands
      if (MP4_BRANDS.has(ascii(b, i, i + 4))) { kind = { ext: 'mp4', mime: 'video/mp4' }; break; }
    }
  }
  return kind && hasTopLevelBox(b, 'moov') ? kind : null;
}
