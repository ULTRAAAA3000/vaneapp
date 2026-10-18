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

/**
 * Mastodon counts every link as 23 characters, whatever its length, so a post with a long link has more room than `.length` says.
 * (Mastodon's own rule; the real limit of a server is usually 500.)
 */
export const MASTODON_URL_COST = 23;
export function mastodonLength(text: string): number {
  return Array.from(text.replace(/https?:\/\/[^\s]+/g, 'x'.repeat(MASTODON_URL_COST))).length;
}
