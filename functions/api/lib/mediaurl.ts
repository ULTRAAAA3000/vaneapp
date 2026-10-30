/**
 * The picture or video a post links to. Files uploaded to Vane were checked when they came in; a link to another website is
 * downloaded and checked here (images), and a video from another website cannot be checked, so it is refused.
 */
import type { Env } from '../../../types';
import { mediaKindFromUrl } from './media';
import { mediaCode, mediaMessage, moderateImages, modOff } from './moderation';
import { isOwnHost } from './netsafe';
import { downloadImage } from './remoteimage';

export async function mediaUrlProblem(env: Env, url: string): Promise<{ code: string; message: string } | null> {
  if (modOff(env)) return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (isOwnHost(u.hostname.toLowerCase())) return null;
  if (mediaKindFromUrl(url) === 'video') return { code: 'media_unchecked', message: 'A video from another website cannot be checked for 18+ or violent content. Upload the video to Vane and attach it from there.' };
  const img = await downloadImage(url, { maxBytes: 5 * 1024 * 1024, label: 'Vane', maxLabel: '5 MB' });
  if (!img.ok) return { code: 'media_unchecked', message: 'The image link could not be downloaded to check it. Upload the file to Vane and attach it from there.' };
  const v = await moderateImages(env, [{ bytes: new Uint8Array(img.bytes), mime: img.contentType }]);
  return v.ok ? null : { code: mediaCode(v.reason), message: mediaMessage(v.reason) };
}
