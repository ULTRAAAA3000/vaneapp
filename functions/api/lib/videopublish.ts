/**
 * The Vane Studio publishing queue: "publish this video to these channels".
 *
 *   POST   /api/video/videos/:id/publish     { channelIds, title?, description?, privacy? }  → one queued publication per channel
 *   GET    /api/video/publications[?videoId=] the history (newest first), with the state of each
 *   POST   /api/video/publications/:id/retry  a failed one goes back in the queue
 *   DELETE /api/video/publications/:id        cancel a queued one / remove a finished one from the history
 *
 * How a publication lives:  queued → publishing → published
 *                                  ↘ (a temporary failure) queued again after a growing pause, up to MAX_ATTEMPTS tries
 *                                  ↘ (a permanent failure, or the tries run out) failed, with the reason; "Retry" starts over
 * It is picked up at once (right after the request, in the background) and again every minute by the cron worker
 * (worker/src/index.ts), which also releases a claim that has been stuck for 10 minutes. Claiming is a single atomic
 * UPDATE, so the two can never publish the same row twice. What actually talks to a network is a publisher
 * (./videopublishers.ts); this file knows nothing about YouTube or TikTok.
 */
import type { Env, VideoPrivacy, VideoPublicationPublic, VideoPublicationStatus } from '../../../types';
import { fail, failCode, isRecord, json, UUID_RE } from './http';
import { bump, retryAfter } from './throttle';
import { publisherFor, type PublishEnv } from './videopublishers';
import { loadVideoSubscription, requireVideoAccess } from './videoplans';
import { getVideoRow, parseVideoMeta, TITLE_MAX } from './videos';
import type { VideoPlatform } from './videochannels';

export const MAX_ATTEMPTS = 5;
/** Pause before try 2, 3, 4, 5 (seconds): 30 s, 2 min, 10 min, 30 min. */
export const BACKOFF_SECONDS = [30, 120, 600, 1800] as const;
const STUCK_AFTER_SECONDS = 600;
const BATCH = 5;                      // publications taken per round (a publisher can run long)
const MAX_CHANNELS_PER_REQUEST = 10;
const PUBLISH_REQUESTS_PER_HOUR = 60;
const PRIVACY: readonly VideoPrivacy[] = ['private', 'unlisted', 'public'];

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

// ───────────────────────── the public shape ─────────────────────────

interface PublicationRow {
  id: string; user_id: string; video_id: string; channel_id: string | null; platform: VideoPlatform; channel_name: string;
  title: string; description: string; privacy: VideoPrivacy; status: VideoPublicationStatus; attempts: number;
  next_attempt_at: number; last_error: string | null; external_url: string | null; created_at: number; published_at: number | null;
  video_title: string | null;
}

const SELECT_PUBLICATION = `
  SELECT p.id, p.user_id, p.video_id, p.channel_id, p.platform, p.channel_name, p.title, p.description, p.privacy, p.status,
         p.attempts, p.next_attempt_at, p.last_error, p.external_url, p.created_at, p.published_at, v.title AS video_title
    FROM video_publications p JOIN videos v ON v.id = p.video_id`;

function toPublic(r: PublicationRow): VideoPublicationPublic {
  return {
    id: r.id, videoId: r.video_id, videoTitle: r.video_title, platform: r.platform, channelName: r.channel_name,
    title: r.title, description: r.description, privacy: r.privacy, status: r.status,
    attempts: r.attempts, maxAttempts: MAX_ATTEMPTS, nextAttemptAt: r.status === 'queued' ? r.next_attempt_at : null,
    error: r.status === 'published' ? null : r.last_error, url: r.external_url, createdAt: r.created_at, publishedAt: r.published_at,
  };
}

// ───────────────────────── the worker side: take due rows and run them ─────────────────────────

interface Claimed { id: string; user_id: string; video_id: string; channel_id: string | null; platform: VideoPlatform; title: string; description: string; privacy: VideoPrivacy; attempts: number }

/**
 * Runs what is due. `only` narrows it to given users or publication ids (the request that just queued them, or a dashboard
 * poll). Returns how many it ran. Never throws for a publisher's failure: that is recorded on the row.
 */
export async function runDueVideoPublications(env: PublishEnv, now: number, only: { ids?: string[]; userId?: string } = {}): Promise<number> {
  // 1. a claim that was never finished (the worker died mid-upload) goes back in the queue
  await env.DB
    .prepare(`UPDATE video_publications SET status = 'queued', next_attempt_at = ?1, updated_at = ?1 WHERE status = 'publishing' AND claimed_at < ?2`)
    .bind(now, now - STUCK_AFTER_SECONDS)
    .run();

  // 2. take due rows: ONE statement, so two workers can never take the same row
  const where: string[] = [`status = 'queued'`, 'next_attempt_at <= ?1'];
  const binds: (string | number)[] = [now];
  if (only.userId) { binds.push(only.userId); where.push(`user_id = ?${binds.length}`); }
  if (only.ids?.length) {
    const marks = only.ids.map((id) => { binds.push(id); return `?${binds.length}`; });
    where.push(`id IN (${marks.join(', ')})`);
  }
  binds.push(BATCH);
  const { results } = await env.DB
    .prepare(
      `UPDATE video_publications SET status = 'publishing', claimed_at = ?1, attempts = attempts + 1, updated_at = ?1
        WHERE id IN (SELECT id FROM video_publications WHERE ${where.join(' AND ')} ORDER BY next_attempt_at LIMIT ?${binds.length})
        RETURNING id, user_id, video_id, channel_id, platform, title, description, privacy, attempts`,
    )
    .bind(...binds)
    .all<Claimed>();

  const active = new Map<string, boolean>();                 // user → has an active Vane Studio (looked up once per user)
  for (const row of results) await runOne(env, row, active);
  return results.length;
}

async function runOne(env: PublishEnv, row: Claimed, active: Map<string, boolean>): Promise<void> {
  const done = (outcome: { ok: true; externalId: string; url: string | null } | { ok: false; retryable: boolean; error: string }) => settle(env, row, outcome);

  if (!active.has(row.user_id)) active.set(row.user_id, (await loadVideoSubscription(env, row.user_id)).active);
  if (!active.get(row.user_id)) return done({ ok: false, retryable: false, error: 'Vane Studio is not active on your account.' });

  const ctx = await env.DB
    .prepare(
      `SELECT v.tags, v.r2_key, v.size_bytes, v.content_type, v.status AS video_status, c.name AS channel_name, c.credentials, c.is_active
         FROM videos v LEFT JOIN video_channels c ON c.id = ?2 WHERE v.id = ?1`,
    )
    .bind(row.video_id, row.channel_id)
    .first<{ tags: string; r2_key: string; size_bytes: number; content_type: string; video_status: string; channel_name: string | null; credentials: string | null; is_active: number | null }>();

  if (!ctx || ctx.video_status !== 'ready') return done({ ok: false, retryable: false, error: 'The video is not available any more.' });
  if (!row.channel_id || !ctx.channel_name || ctx.credentials === null) return done({ ok: false, retryable: false, error: 'The channel was disconnected. Connect it again and retry.' });
  if (ctx.is_active !== 1) return done({ ok: false, retryable: false, error: 'The channel is switched off.' });

  const publisher = publisherFor(env, row.platform, ctx.credentials);
  if (!publisher) return done({ ok: false, retryable: false, error: 'Publishing to this network is not available yet.' });

  let tags: string[] = [];
  try { const t: unknown = JSON.parse(ctx.tags); if (Array.isArray(t)) tags = t.filter((x): x is string => typeof x === 'string'); } catch { /* none */ }

  // The owner's cover goes along with the video (best effort: a database without the covers table just has none).
  const cover = await env.DB
    .prepare('SELECT r2_key, content_type FROM video_covers WHERE video_id = ?1')
    .bind(row.video_id)
    .first<{ r2_key: string; content_type: string }>()
    .catch(() => null);

  try {
    const outcome = await publisher.publish(env, {
      publicationId: row.id, attempt: row.attempts, title: row.title, description: row.description, privacy: row.privacy,
      video: { id: row.video_id, tags, r2Key: ctx.r2_key, sizeBytes: ctx.size_bytes, contentType: ctx.content_type, cover: cover ? { r2Key: cover.r2_key, contentType: cover.content_type } : null },
      channel: { id: row.channel_id, platform: row.platform, name: ctx.channel_name, credentials: ctx.credentials },
    });
    await done(outcome);
  } catch (err) {
    // A publisher that throws is a bug or an outage: record it and let the retry rules decide (it is treated as temporary).
    console.error('video publish crashed', row.platform, err instanceof Error ? err.message : 'unknown');
    await done({ ok: false, retryable: true, error: 'The network did not answer. It will be tried again.' });
  }
}

/** Writes what happened. `WHERE status = 'publishing'` keeps a late finisher from overwriting a row someone else already moved on. */
async function settle(env: PublishEnv, row: Claimed, outcome: { ok: true; externalId: string; url: string | null } | { ok: false; retryable: boolean; error: string }): Promise<void> {
  const now = nowSeconds();
  if (outcome.ok) {
    await env.DB
      .prepare(`UPDATE video_publications SET status = 'published', external_id = ?2, external_url = ?3, last_error = NULL, published_at = ?4, updated_at = ?4 WHERE id = ?1 AND status = 'publishing'`)
      .bind(row.id, outcome.externalId, outcome.url, now)
      .run();
    return;
  }
  const error = outcome.error.slice(0, 500);
  if (outcome.retryable && row.attempts < MAX_ATTEMPTS) {
    const pause = BACKOFF_SECONDS[Math.min(row.attempts - 1, BACKOFF_SECONDS.length - 1)];
    await env.DB
      .prepare(`UPDATE video_publications SET status = 'queued', next_attempt_at = ?2, last_error = ?3, updated_at = ?4 WHERE id = ?1 AND status = 'publishing'`)
      .bind(row.id, now + pause, error, now)
      .run();
    return;
  }
  await env.DB
    .prepare(`UPDATE video_publications SET status = 'failed', last_error = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'publishing'`)
    .bind(row.id, error, now)
    .run();
}

// ───────────────────────── the dashboard side ─────────────────────────

/** `after` runs work in the background after the response (Pages: context.waitUntil). */
export type After = (work: Promise<unknown>) => void;

export async function publishVideo(env: Env, userId: string, videoId: string, body: unknown, after: After): Promise<Response> {
  if (!isRecord(body)) return fail(400, 'Body must be a JSON object');

  const channelIds = Array.isArray(body.channelIds) ? [...new Set(body.channelIds)] : null;
  if (!channelIds || channelIds.length === 0 || channelIds.length > MAX_CHANNELS_PER_REQUEST || !channelIds.every((c): c is string => typeof c === 'string' && UUID_RE.test(c))) {
    return fail(400, `channelIds must be a list of 1 to ${MAX_CHANNELS_PER_REQUEST} channel ids`);
  }
  const privacy = body.privacy === undefined ? 'private' : body.privacy;
  if (!PRIVACY.includes(privacy as VideoPrivacy)) return fail(400, 'privacy must be "private", "unlisted" or "public"');
  const meta = parseVideoMeta(body);
  if (!meta.ok) return meta.response;

  const video = await getVideoRow(env, userId, videoId);
  if (!video) return fail(404, 'Video not found');
  if (video.status !== 'ready') return failCode(409, 'not_ready', 'A video can be published once it has finished uploading.');
  const denied = await requireVideoAccess(env, userId);
  if (denied) return denied;

  const rl = `vidpub:${userId}`;
  const wait = await retryAfter(env, rl, PUBLISH_REQUESTS_PER_HOUR);
  if (wait) return fail(429, 'Too many publish requests. Try again later.', { 'Retry-After': String(wait) });

  const marks = channelIds.map((_, i) => `?${i + 2}`).join(', ');
  const { results: channels } = await env.DB
    .prepare(`SELECT id, platform, name, is_active FROM video_channels WHERE user_id = ?1 AND id IN (${marks})`)
    .bind(userId, ...channelIds)
    .all<{ id: string; platform: VideoPlatform; name: string; is_active: number }>();
  if (channels.length !== channelIds.length) return fail(404, 'Channel not found');
  const off = channels.find((c) => c.is_active !== 1);
  if (off) return failCode(409, 'channel_inactive', `${off.name} is switched off.`);

  // The same video twice to the same channel while the first is still going: almost always a double click.
  const { results: busy } = await env.DB
    .prepare(`SELECT channel_id FROM video_publications WHERE video_id = ?1 AND status IN ('queued', 'publishing') AND channel_id IN (${channelIds.map((_, i) => `?${i + 2}`).join(', ')})`)
    .bind(videoId, ...channelIds)
    .all<{ channel_id: string }>();
  if (busy.length) {
    const name = channels.find((c) => c.id === busy[0].channel_id)?.name ?? 'that channel';
    return failCode(409, 'already_queued', `This video is already being published to ${name}.`);
  }

  const title = (meta.meta.title ?? video.title).slice(0, TITLE_MAX);
  const description = meta.meta.description ?? video.description;
  const now = nowSeconds();
  const ids = channels.map(() => crypto.randomUUID());
  const insert = env.DB.prepare(
    `INSERT INTO video_publications (id, user_id, video_id, channel_id, platform, channel_name, title, description, privacy, status, next_attempt_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'queued', ?10, ?10, ?10)`,
  );
  await env.DB.batch(channels.map((c, i) => insert.bind(ids[i], userId, videoId, c.id, c.platform, c.name, title, description, privacy, now)));
  await bump(env, rl, 3600);

  after(runDueVideoPublications(env, now, { ids }).catch((err) => console.error('video publish run failed', err instanceof Error ? err.message : 'unknown')));
  const { results } = await env.DB.prepare(`${SELECT_PUBLICATION} WHERE p.user_id = ?1 AND p.id IN (${ids.map((_, i) => `?${i + 2}`).join(', ')}) ORDER BY p.channel_name`).bind(userId, ...ids).all<PublicationRow>();
  return json({ ok: true, publications: results.map(toPublic) }, 201);
}

export async function listPublications(env: Env, userId: string, videoId: string | null, after: After): Promise<Response> {
  if (videoId !== null && !UUID_RE.test(videoId)) return fail(400, 'videoId must be a video id');
  const now = nowSeconds();
  const { results } = await env.DB
    .prepare(`${SELECT_PUBLICATION} WHERE p.user_id = ?1 AND (?2 IS NULL OR p.video_id = ?2) ORDER BY p.created_at DESC, p.id LIMIT 100`)
    .bind(userId, videoId)
    .all<PublicationRow>();

  // The dashboard polls this while something is going on: it doubles as a nudge for rows that are due (the cron worker does
  // the same every minute; the atomic claim makes it safe for both to try).
  if (results.some((r) => r.status === 'queued' && r.next_attempt_at <= now)) {
    after(runDueVideoPublications(env, now, { userId }).catch(() => undefined));
  }
  return json({ ok: true, publications: results.map(toPublic) });
}

export async function retryPublication(env: Env, userId: string, id: string, after: After): Promise<Response> {
  if (!UUID_RE.test(id)) return fail(404, 'Publication not found');
  const now = nowSeconds();
  const res = await env.DB
    .prepare(`UPDATE video_publications SET status = 'queued', attempts = 0, next_attempt_at = ?3, last_error = NULL, updated_at = ?3 WHERE id = ?1 AND user_id = ?2 AND status = 'failed'`)
    .bind(id, userId, now)
    .run();
  if (res.meta.changes !== 1) {
    const exists = await env.DB.prepare('SELECT status FROM video_publications WHERE id = ?1 AND user_id = ?2').bind(id, userId).first<{ status: string }>();
    return exists ? failCode(409, 'not_failed', 'Only a failed publication can be retried.') : fail(404, 'Publication not found');
  }
  // No Vane Studio check here on purpose: the dispatcher checks it for every attempt and records the reason on the row.
  after(runDueVideoPublications(env, now, { ids: [id] }).catch(() => undefined));
  const row = await env.DB.prepare(`${SELECT_PUBLICATION} WHERE p.id = ?1 AND p.user_id = ?2`).bind(id, userId).first<PublicationRow>();
  return row ? json({ ok: true, publication: toPublic(row) }) : fail(404, 'Publication not found');
}

export async function removePublication(env: Env, userId: string, id: string): Promise<Response> {
  if (!UUID_RE.test(id)) return fail(404, 'Publication not found');
  const row = await env.DB.prepare('SELECT status FROM video_publications WHERE id = ?1 AND user_id = ?2').bind(id, userId).first<{ status: string }>();
  if (!row) return fail(404, 'Publication not found');
  if (row.status === 'publishing') return failCode(409, 'in_progress', 'It is being published right now. Try again in a moment.');
  // `AND status != 'publishing'`: if a worker took it between the check and here, nothing is deleted.
  const res = await env.DB.prepare(`DELETE FROM video_publications WHERE id = ?1 AND user_id = ?2 AND status != 'publishing'`).bind(id, userId).run();
  return res.meta.changes === 1 ? json({ ok: true }) : failCode(409, 'in_progress', 'It is being published right now. Try again in a moment.');
}

