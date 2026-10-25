/**
 * Strict structure checks for files going into the library. The first bytes only say what a file claims to be;
 * these walk the whole container so that a real picture or video cannot carry a hidden payload (a script, an archive,
 * an executable glued after the end) and a file that merely starts with a valid header is refused.
 * Returns a message for the person when the file is refused, or null when it is clean.
 */
import type { ImageKind } from './image';
import type { VideoKind } from './video';

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u32le = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

const BAD = 'This file is not a clean image or video: it has extra data that does not belong to the picture. Export it again and upload the new file.';

const SIGNS = ['<?php', '<?=', '<script', '<html', '<!doctype', '<svg', '<iframe', '<object', '<embed', 'javascript:', '#!/bin', '#!/usr', 'powershell', '<%@', '<jsp:'];

/** Script or markup signatures anywhere in the bytes. A real photo never contains them (checked for pictures only: they are small). */
export function hasActiveContent(b: Uint8Array): boolean {
  const lower = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) { const c = b[i]; lower[i] = c >= 65 && c <= 90 ? c + 32 : c; }
  const text = new TextDecoder('latin1').decode(lower);
  return SIGNS.some((s) => text.includes(s));
}

let table: Uint32Array | null = null;
function crc32(b: Uint8Array, from: number, to: number): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = from; i < to; i++) c = table[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngOk(b: Uint8Array): boolean {
  let i = 8, first = true, data = false;
  while (i + 12 <= b.length) {
    const len = u32be(b, i);
    if (len > 0x7fffffff || i + 12 + len > b.length) return false;
    const type = ascii(b, i + 4, i + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return false;
    if (first && (type !== 'IHDR' || len !== 13)) return false;
    first = false;
    if (crc32(b, i + 4, i + 8 + len) !== u32be(b, i + 8 + len)) return false;
    if (type === 'IDAT') data = true;
    i += 12 + len;
    if (type === 'IEND') return data && len === 0 && i === b.length;   // nothing may follow IEND
  }
  return false;
}

function trailerOk(b: Uint8Array, from: number): boolean {
  let end = b.length;
  while (end > from && b[end - 1] === 0) end--;                         // zero padding is harmless
  if (end === from) return true;
  return b[from] === 0xff && b[from + 1] === 0xd8 && b[from + 2] === 0xff && b[end - 2] === 0xff && b[end - 1] === 0xd9;   // a second picture: thumbnail or multi-picture photo
}

function jpegOk(b: Uint8Array): boolean {
  let i = 2, scans = 0;
  while (i + 2 <= b.length) {
    if (b[i] !== 0xff) return false;
    while (b[i + 1] === 0xff && i + 2 < b.length) i++;                  // fill bytes
    const m = b[i + 1];
    if (m === 0xd9) return scans > 0 && trailerOk(b, i + 2);
    if (m === 0x00 || m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { i += 2; continue; }
    if (i + 4 > b.length) return false;
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) return false;
    i += 2 + len;
    if (m !== 0xda) continue;
    scans++;
    while (i + 1 < b.length) {                                          // entropy-coded data up to the next real marker
      if (b[i] === 0xff && b[i + 1] !== 0x00 && !(b[i + 1] >= 0xd0 && b[i + 1] <= 0xd7) && b[i + 1] !== 0xff) break;
      i++;
    }
  }
  return false;
}

function webpOk(b: Uint8Array): boolean {
  const riff = u32le(b, 4);
  if (riff + 8 !== b.length || riff % 2 !== 0) return false;
  let i = 12;
  while (i + 8 <= b.length) {
    const size = u32le(b, i + 4);
    i += 8 + size + (size & 1);
  }
  return i === b.length;
}

/** null when the picture is clean, otherwise what to tell the person. */
export function imageProblem(b: Uint8Array, kind: ImageKind): string | null {
  const ok = kind.ext === 'png' ? pngOk(b) : kind.ext === 'jpg' ? jpegOk(b) : webpOk(b);
  if (!ok || hasActiveContent(b)) return BAD;
  return null;
}

/** null when the clip is clean: every top-level box is well-formed, they end exactly at the end of the file, `moov` and `mdat` are there. */
export function videoProblem(b: Uint8Array, _kind: VideoKind): string | null {
  let i = 0, moov = false, mdat = false, guard = 0;
  while (i < b.length) {
    if (++guard > 2000 || i + 8 > b.length) return BAD;
    let size = u32be(b, i);
    const type = ascii(b, i + 4, i + 8);
    if (!/^[\x20-\x7e\xa9]{4}$/.test(type)) return BAD;
    if (size === 1) {
      if (i + 16 > b.length || u32be(b, i + 8) !== 0) return BAD;
      size = u32be(b, i + 12);
    } else if (size === 0) size = b.length - i;
    if (size < 8 || i + size > b.length) return BAD;
    if (type === 'moov') moov = true;
    if (type === 'mdat') mdat = true;
    i += size;
  }
  if (!moov || !mdat) return BAD;
  return null;
}
