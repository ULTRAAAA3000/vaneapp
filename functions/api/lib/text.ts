/** Text measuring shared by the API and the checks that run before a post is saved. */

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/** Characters as a person counts them: an emoji (even a family one) is 1. Bluesky limits posts this way. */
export function graphemeLength(text: string): number {
  if (!segmenter) return Array.from(text).length;
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

export const utf8Length = (text: string): number => new TextEncoder().encode(text).length;
