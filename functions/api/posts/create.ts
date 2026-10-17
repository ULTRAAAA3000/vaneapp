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
import type { PagesFunction } from '@cloudflare/workers-types';
import type { ChannelRow, ChannelType, Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { checkPostQuota } from '../lib/plans';
import { fail, isRecord, json, readJson, UUID_RE } from '../lib/http';
import { isValidMediaUrl, TELEGRAM_CAPTION_LIMIT } from '../channels/telegram';

const MAX_CHANNELS = 20;
const MAX_HORIZON_SECONDS = 366 * 24 * 3600;

/** Per-platform text limits (same numbers the landing-page demo shows). */
const CONTENT_LIMIT: Record<ChannelType, number> = {
  telegram: 4096,
  x: 280,
  linkedin: 3000,
  webhook: 10_000,
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

export const handleCreatePost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  if (!isRecord(body)) return fail(400, 'Body must be a JSON object');

  // ── content
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) return fail(400, 'content is required');
  if (content.length > ABSOLUTE_MAX_CONTENT) return fail(400, `content is too long (max ${ABSOLUTE_MAX_CONTENT})`);

  // ── mediaUrl (optional)
  let mediaUrl: string | null = null;
  if (body.mediaUrl !== undefined && body.mediaUrl !== null && body.mediaUrl !== '') {
    if (!isValidMediaUrl(body.mediaUrl)) return fail(400, 'mediaUrl must be a public https URL');
    mediaUrl = body.mediaUrl;
  }

  // ── channelIds
  if (!Array.isArray(body.channelIds) || body.channelIds.length === 0) {
    return fail(400, 'channelIds must be a non-empty array');
  }
  const channelIds = [...new Set(body.channelIds)];
  if (channelIds.length > MAX_CHANNELS) return fail(400, `You can target at most ${MAX_CHANNELS} channels at once`);
  if (!channelIds.every((x): x is string => typeof x === 'string' && UUID_RE.test(x))) {
    return fail(400, 'channelIds must contain channel ids (uuid)');
  }

  // ── scheduledAt: must be in the future
  const scheduledAt = parseScheduledAt(body.scheduledAt);
  if (scheduledAt === null) {
    return fail(400, 'scheduledAt must be an ISO-8601 time with a timezone (e.g. 2026-10-20T09:00:00Z) or unix seconds');
  }
  const now = Math.floor(Date.now() / 1000);
  if (scheduledAt <= now) return fail(400, 'scheduledAt must be in the future');
  if (scheduledAt > now + MAX_HORIZON_SECONDS) return fail(400, 'scheduledAt can be at most one year ahead');

  // ── ownership: every channel must be MINE and active (one query, no per-id round trips)
  const placeholders = channelIds.map((_, i) => `?${i + 2}`).join(',');
  const { results: owned } = await env.DB
    .prepare(`SELECT id, type FROM channels WHERE user_id = ?1 AND is_active = 1 AND id IN (${placeholders})`)
    .bind(auth.userId, ...channelIds)
    .all<Pick<ChannelRow, 'id' | 'type'>>();

  // Foreign, inactive and non-existent ids all produce the same answer: no id probing.
  if (owned.length !== channelIds.length) return fail(404, 'One or more channels were not found');

  // ── per-platform limits
  for (const ch of owned) {
    const limit = ch.type === 'telegram' && mediaUrl ? TELEGRAM_CAPTION_LIMIT : CONTENT_LIMIT[ch.type];
    if (content.length > limit) {
      const why = ch.type === 'telegram' && mediaUrl ? ' when the post has an image' : '';
      return fail(400, `Text is too long for ${ch.type}${why}: ${content.length}/${limit} characters`);
    }
  }

  // ── write
  const overQuota = await checkPostQuota(env, auth.userId);       // plan limit (only while "enforce_limits" is on)
  if (overQuota) return overQuota;

  const groupId = crypto.randomUUID();
  const mediaKeys = JSON.stringify(mediaUrl ? [mediaUrl] : []);
  const insert = env.DB.prepare(
    `INSERT INTO posts (id, group_id, user_id, channel_id, content, media_keys, scheduled_at, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'scheduled', ?8, ?8)`,
  );
  const posts = owned.map((ch) => ({ id: crypto.randomUUID(), channelId: ch.id }));

  try {
    await env.DB.batch(
      posts.map((p) => insert.bind(p.id, groupId, auth.userId, p.channelId, content, mediaKeys, scheduledAt, now)),
    );
  } catch (err) {
    console.error('post insert failed', err instanceof Error ? err.message : 'unknown');
    return fail(500, 'Could not schedule the post. Please try again.');
  }

  return json(
    {
      ok: true,
      groupId,
      scheduledAt,
      posts: posts.map((p) => ({ id: p.id, channelId: p.channelId, status: 'scheduled' as const })),
    },
    201,
  );
};
