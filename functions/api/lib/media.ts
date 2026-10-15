/** Shared knowledge about the kinds of media a post can carry. */
export type MediaKind = 'image' | 'video';

const VIDEO_EXT = /\.(mp4|mov|m4v)$/i;

/**
 * Decides photo vs video from the file extension in the URL path (query/fragment ignored).
 * Our own uploads always carry the right extension; for external links this is the best signal
 * we have without downloading the file.
 */
export function mediaKindFromUrl(url: string): MediaKind {
  try {
    return VIDEO_EXT.test(new URL(url).pathname) ? 'video' : 'image';
  } catch {
    return 'image';
  }
}
