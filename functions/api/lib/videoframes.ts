/**
 * How many frames of a video the server wants to look at. A video is judged by pictures the browser takes from it (the server
 * cannot decode video), so the longer the video, the more of them: one frame every ~6 seconds, at least 3, at most 8.
 * The browser (Vane.videoFrames in public/assets/vane.js) uses the same rule, so a normal upload always sends enough.
 */
export const MIN_FRAMES = 3;
export const MAX_FRAMES = 8;
export const SECONDS_PER_FRAME = 6;

/** Frames needed for a video of this length; an unknown length asks for the minimum. */
export const framesNeeded = (seconds: number | null): number =>
  seconds === null || !Number.isFinite(seconds) || seconds <= 0 ? MIN_FRAMES : Math.min(MAX_FRAMES, Math.max(MIN_FRAMES, Math.ceil(seconds / SECONDS_PER_FRAME)));

const u32 = (b: Uint8Array, i: number): number => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const tag = (b: Uint8Array, i: number): string => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);

/** Length in seconds from the `mvhd` box of an MP4/MOV file, or null when it cannot be read (the caller then asks for the minimum). */
export function videoSeconds(b: Uint8Array): number | null {
  const find = (from: number, to: number, want: string): [number, number] | null => {   // → [start of the box's content, end of the box]
    let i = from, guard = 0;
    while (i + 8 <= to && ++guard < 2000) {
      let size = u32(b, i), head = 8;
      if (size === 1) { if (i + 16 > to) return null; size = u32(b, i + 12); head = 16; }
      else if (size === 0) size = to - i;
      if (size < head || i + size > to) return null;
      if (tag(b, i + 4) === want) return [i + head, i + size];
      i += size;
    }
    return null;
  };
  const moov = find(0, b.length, 'moov');
  const mvhd = moov && find(moov[0], moov[1], 'mvhd');
  if (!mvhd) return null;
  const at = mvhd[0], version = b[at];
  if (version === 0 && at + 20 <= mvhd[1]) {
    const scale = u32(b, at + 12), dur = u32(b, at + 16);
    return scale > 0 ? dur / scale : null;
  }
  if (version === 1 && at + 32 <= mvhd[1]) {
    const scale = u32(b, at + 20), dur = u32(b, at + 24) * 2 ** 32 + u32(b, at + 28);
    return scale > 0 ? dur / scale : null;
  }
  return null;
}
