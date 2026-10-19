/**
 * Downloads an image for a network that wants the bytes itself (Bluesky, Mastodon). Telegram fetches the link on its side, so it does not use this.
 *
 * The link is a Vane upload or any public https URL, so: https only, no redirects, a hard timeout, and a hard size cap
 * (the body is read in pieces and dropped as soon as it passes the cap).
 */
import { isValidMediaUrl } from '../channels/telegram';

const TIMEOUT_MS = 20_000;
const TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export type ImageResult =
  | { ok: true; bytes: ArrayBuffer; contentType: string }
  | { ok: false; error: string; retryable: boolean };

export async function downloadImage(url: string, opts: { maxBytes: number; label: string; maxLabel: string }): Promise<ImageResult> {
  if (!isValidMediaUrl(url)) return { ok: false, error: 'The attached image link is invalid.', retryable: false };
  let res: Response;
  try {
    res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });   // Workers have no redirect: 'error'; a 3xx is refused below
  } catch {
    return { ok: false, error: 'Could not download the attached image.', retryable: true };
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, error: 'The attached image link redirects to another address. Use the direct link to the image.', retryable: false };
  }
  if (!res.ok) return { ok: false, error: `The attached image could not be downloaded (HTTP ${res.status}).`, retryable: res.status >= 500 || res.status === 429 };
  const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!TYPES.includes(contentType)) return { ok: false, error: `${opts.label} takes JPEG, PNG, WebP or GIF images.`, retryable: false };
  const tooBig = { ok: false as const, error: `The image is larger than ${opts.label} allows (${opts.maxLabel}). Use a smaller image.`, retryable: false };
  if (Number(res.headers.get('content-length')) > opts.maxBytes) return tooBig;

  const reader = res.body?.getReader();
  if (!reader) return { ok: false, error: 'Could not download the attached image.', retryable: true };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > opts.maxBytes) {
        await reader.cancel();
        return tooBig;
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, error: 'Could not download the attached image.', retryable: true };
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return { ok: true, bytes: bytes.buffer, contentType };
}
