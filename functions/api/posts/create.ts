/**
 * Create + schedule a post.   POST /api/posts   (route file: ./index.ts)
 *
 * Body:
 *   {
 *     "content":     "Hello world",                       // required
 *     "mediaUrl":    "https://example.com/photo.jpg",     // optional, https only
 *     "channelIds":  ["<uuid>", "<uuid>"],                // 1..20, must be MY active channels
 *     "scheduledAt": "2026-10-20T09:00:00Z"               // ISO-8601 WITH timezone, or unix seconds
 *   }
 *
 * One row per channel is written to `posts` (status 'scheduled'), all sharing one group_id.
 * Rows are inserted in a single D1 batch, so it's all-or-nothing.
 * The cron worker (next stage) picks them up via idx_posts_due (status, scheduled_at).
 *
 * `media_keys` holds either R2 object keys or external https URLs; the sender tells them
 * apart by the "https://" prefix.
 */
import { networkInfo, pausedNetworks } from '../lib/networks';
import type { D1PreparedStatement, PagesFunction } from '@cloudflare/workers-types';
import type { ChannelRow, ChannelType, Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { fail, failCode, isRecord, json, readJson, UUID_RE } from '../lib/http';
import { ownMediaMissing } from '../lib/library';
import { mediaKindFromUrl } from '../lib/media';
import { postUnits } from '../lib/plans';
import { graphemeLength, mastodonLength, threadsLength, utf8Length } from '../lib/text';
import { countUiPosts } from '../lib/usage';
import { BLUESKY_TEXT_LIMIT, BLUESKY_TEXT_MAX_BYTES } from '../channels/bluesky';
import { MASTODON_TEXT_LIMIT } from '../channels/mastodon';
import { isValidMediaUrl, TELEGRAM_CAPTION_LIMIT } from '../channels/telegram';

const MAX_CHANNELS = 20;
const MAX_HORIZON_SECONDS = 366 * 24 * 3600;

/** Per-platform text limits (same numbers the landing-page demo shows). */
export const CONTENT_LIMIT: Record<ChannelType, number> = {
  telegram: 4096,
  x: 280,
  linkedin: 3000,
  webhook: 10_000,
  bluesky: BLUESKY_TEXT_LIMIT,   // counted in graphemes, see below
  mastodon: MASTODON_TEXT_LIMIT,   // links count as 23 characters, see below
  threads: 500,
  discord: 2000,   // a webhook message
  devto: 10_000,   // an article: its title is the first line
  reddit: 10_000,  // a text post: its title (up to 300 characters) is the first line
  facebook: 5000,
};
const ABSOLUTE_MAX_CONTENT = 10_000;

const ISO_WITH_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Returns unix seconds, or null if the value isn't a usable timestamp. */
export function parseScheduledAt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return Math.floor(v > 1e11 ? v / 1000 : v); // tolerate milliseconds
  }
  if (typeof v === 'string' && ISO_WITH_TZ.test(v)) {
    // The timezone is mandatory: "2026-10-20T09:00" is ambiguous and would silently mean server time.
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
  }
  return null;
}

/** A request that passed every check. */
export interface ValidatedPost {
  content: string;
  mediaUrl: string | null;
  /** the channels it will be delivered to: all of them are mine and active */
  channels: Pick<ChannelRow, 'id' | 'type'>[];
  /** unix seconds, in the future */
  scheduledAt: number;
  now: number;
}

export type ValidationResult = { ok: true; v: ValidatedPost } | { ok: false; response: Response };

/**
 * Everything that can be wrong with a "create post" body, shared by the dashboard route and the public API
 * (`POST /api/v1/posts`), so both always accept and reject exactly the same things.
 */
export async function validateCreatePost(env: Env, userId: string, body: unknown): Promise<ValidationResult> {
  const bad = (response: Response): ValidationResult => ({ ok: false, response });
  if (!isRecord(body)) return bad(fail(400, 'Body must be a JSON object'));

  // ── content
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) return bad(fail(400, 'content is required'));
  if (content.length > ABSOLUTE_MAX_CONTENT) return bad(fail(400, `content is too long (max ${ABSOLUTE_MAX_CONTENT})`));

  // ── mediaUrl (optional)
  let mediaUrl: string | null = null;
  if (body.mediaUrl !== undefined && body.mediaUrl !== null && body.mediaUrl !== '') {
    if (!isValidMediaUrl(body.mediaUrl)) return bad(fail(400, 'mediaUrl must be a public https URL'));
    mediaUrl = body.mediaUrl;
    if (await ownMediaMissing(env, mediaUrl)) return bad(fail(400, 'The attached file was deleted from the Library. Attach it again, or choose another file.'));
  }

  // ── channelIds
  if (!Array.isArray(body.channelIds) || body.channelIds.length === 0) {
    return bad(fail(400, 'channelIds must be a non-empty array'));
  }
  const channelIds = [...new Set(body.channelIds)];
  if (channelIds.length > MAX_CHANNELS) return bad(fail(400, `You can target at most ${MAX_CHANNELS} channels at once`));
  if (!channelIds.every((x): x is string => typeof x === 'string' && UUID_RE.test(x))) {
    return bad(fail(400, 'channelIds must contain channel ids (uuid)'));
  }

  // ── scheduledAt: must be in the future
  const scheduledAt = parseScheduledAt(body.scheduledAt);
  if (scheduledAt === null) {
    return bad(fail(400, 'scheduledAt must be an ISO-8601 time with a timezone (e.g. 2026-10-20T09:00:00Z) or unix seconds'));
  }
  const now = Math.floor(Date.now() / 1000);
  if (scheduledAt <= now) return bad(fail(400, 'scheduledAt must be in the future'));
  if (scheduledAt > now + MAX_HORIZON_SECONDS) return bad(fail(400, 'scheduledAt can be at most one year ahead'));

  // ── ownership: every channel must be MINE and active (one query, no per-id round trips)
  const placeholders = channelIds.map((_, i) => `?${i + 2}`).join(',');
  const { results: owned } = await env.DB
    .prepare(`SELECT id, type FROM channels WHERE user_id = ?1 AND is_active = 1 AND id IN (${placeholders})`)
    .bind(userId, ...channelIds)
    .all<Pick<ChannelRow, 'id' | 'type'>>();

  // Foreign, inactive and non-existent ids all produce the same answer: no id probing.
  if (owned.length !== channelIds.length) return bad(fail(404, 'One or more channels were not found'));

  // ── a switched-off network takes no new posts (those already scheduled just wait; see lib/networks.ts)
  const paused = new Set(await pausedNetworks(env));   // only what the admin switched off; networks without code keep behaving as before
  for (const ch of owned) {
    if (paused.has(ch.type)) return bad(failCode(409, 'network_disabled', `${networkInfo(ch.type)?.name ?? ch.type} is switched off right now, so nothing can be scheduled to it. Try again later.`));
  }

  // ── per-platform limits
  for (const ch of owned) {
    const limit = ch.type === 'telegram' && mediaUrl ? TELEGRAM_CAPTION_LIMIT : CONTENT_LIMIT[ch.type];
    // Bluesky counts what a person sees (an emoji is 1); Mastodon counts every link as 23 characters
    // Threads counts an emoji as the bytes it takes; LinkedIn counts UTF-16 units, which is what `.length` is
    const length = ch.type === 'bluesky' ? graphemeLength(content) : ch.type === 'mastodon' ? mastodonLength(content) : ch.type === 'threads' ? threadsLength(content) : content.length;
    if (length > limit) {
      const why = ch.type === 'telegram' && mediaUrl ? ' when the post has an image' : '';
      return bad(fail(400, `Text is too long for ${ch.type}${why}: ${length}/${limit} characters`));
    }
    if (ch.type === 'bluesky') {
      if (utf8Length(content) > BLUESKY_TEXT_MAX_BYTES) return bad(fail(400, 'Text is too long for bluesky: too many emoji or symbols'));
      if (mediaUrl && mediaKindFromUrl(mediaUrl) === 'video') return bad(fail(400, 'Bluesky posts with video are not supported yet. Attach an image or remove the media.'));
    }
    if (ch.type === 'linkedin' && mediaUrl && mediaKindFromUrl(mediaUrl) === 'video') {
      return bad(fail(400, 'LinkedIn posts with video are not supported yet. Attach an image or remove the media.'));
    }
    if ((ch.type === 'discord' || ch.type === 'devto') && mediaUrl && mediaKindFromUrl(mediaUrl) === 'video') {
      return bad(fail(400, `${ch.type === 'discord' ? 'Discord' : 'Dev.to'} posts with video are not supported yet. Attach an image or remove the media.`));
    }
    if (ch.type === 'reddit' && (content.replace(/\r\n/g, '\n').trim().split('\n')[0] ?? '').replace(/^#+\s*/, '').trim().length > 300) {
      return bad(fail(400, 'For Reddit the first line is the post title and can be at most 300 characters.'));
    }
    if (ch.type === 'mastodon' && mediaUrl && mediaKindFromUrl(mediaUrl) === 'video') {
      return bad(fail(400, 'Mastodon posts with video are not supported yet. Attach an image or remove the media.'));
    }
  }

  return { ok: true, v: { content, mediaUrl, channels: owned, scheduledAt, now } };
}

export type InsertResult =
  | { ok: true; groupId: string; posts: { id: string; channelId: string; status: 'scheduled' }[] }
  | { ok: false };

/**
 * Writes one row per channel (all sharing a group_id) in a single D1 batch: all-or-nothing.
 * `extra` builds statements that must succeed or fail together with the posts (the usage log row, the stored
 * Idempotency-Key answer); it is given the group id and the posts it will be written next to.
 */
export async function insertPostGroup(
  env: Env,
  userId: string,
  v: ValidatedPost,
  extra: (groupId: string, posts: { id: string; channelId: string; status: 'scheduled' }[]) => D1PreparedStatement[] = () => [],
): Promise<InsertResult> {
  const groupId = crypto.randomUUID();
  const mediaKeys = JSON.stringify(v.mediaUrl ? [v.mediaUrl] : []);
  const insert = env.DB.prepare(
    `INSERT INTO posts (id, group_id, user_id, channel_id, content, media_keys, scheduled_at, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'scheduled', ?8, ?8)`,
  );
  const posts = v.channels.map((ch) => ({ id: crypto.randomUUID(), channelId: ch.id, status: 'scheduled' as const }));

  try {
    await env.DB.batch([
      ...posts.map((p) => insert.bind(p.id, groupId, userId, p.channelId, v.content, mediaKeys, v.scheduledAt, v.now)),
      ...extra(groupId, posts),
    ]);
  } catch (err) {
    console.error('post insert failed', err instanceof Error ? err.message : 'unknown');
    return { ok: false };
  }
  return { ok: true, groupId, posts };
}

export const handleCreatePost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  const checked = await validateCreatePost(env, auth.userId, parsed.data);
  if (!checked.ok) return checked.response;
  const v = checked.v;

  const saved = await insertPostGroup(env, auth.userId, v);
  if (!saved.ok) return fail(500, 'Could not schedule the post. Please try again.');

  // Dashboard posts are counted (the Free Trial total is shared with the API); blocking them is a later part.
  await countUiPosts(env, auth.userId, postUnits(v.channels.length));

  return json({ ok: true, groupId: saved.groupId, scheduledAt: v.scheduledAt, posts: saved.posts }, 201);
};
