/**
 * Autoposting: finds posts that are due, sends them, records what happened.
 * Runs once a minute from the `vane-cron` Worker (see ./index.ts and ../wrangler.toml).
 *
 * Guarantees
 *  - NO DOUBLE SENDS. Posts are claimed with ONE atomic UPDATE … RETURNING that flips
 *    scheduled → processing. Overlapping runs can't claim the same row, and a post the user
 *    cancels meanwhile is no longer 'scheduled', so cancel and send can't both win.
 *  - AT-MOST-ONCE ON CRASH. If a run dies after sending but before saving the result, the row
 *    stays 'processing'; after STUCK_AFTER_SECONDS it is marked failed (never silently re-sent).
 *  - TEMPORARY FAILURES RETRY (network, Telegram 429/5xx) with exponential backoff, up to
 *    MAX_ATTEMPTS. Permanent ones (bot kicked, bad image, text too long) fail at once.
 *  - NOTHING STALE. A post more than MAX_LATE_SECONDS overdue is failed, not posted hours late.
 *  - FAIL SAFE. If ENCRYPTION_KEY is missing this run touches nothing (posts stay scheduled).
 *
 * No schema change needed: backoff reuses `updated_at` (a requeued post becomes due again at
 * updated_at + backoff). `sent_at` is the "published at" timestamp, `external_id` the id of the post
 * on the network (Telegram message id, Bluesky at:// uri, Mastodon status url, LinkedIn post urn, Threads permalink).
 */
import type { ChannelRow, CronEnv } from '../../types';
import { CREDS_ERROR, loadTelegramCreds, type TelegramCreds } from '../../functions/api/channels/credentials';
import { loadBlueskyCreds, openBlueskySession, sendBlueskyPost, type BlueskySession } from '../../functions/api/channels/bluesky';
import { loadMastodonCreds, sendMastodonPost } from '../../functions/api/channels/mastodon';
import { LINKEDIN_RENEW_BEFORE_SECONDS, linkedinBlob, loadLinkedinCreds, renewLinkedin, sendLinkedinPost, type LinkedinCreds } from '../../functions/api/channels/linkedin';
import { THREADS_RENEW_BEFORE_SECONDS, loadThreadsCreds, refreshThreadsToken, sendThreadsPost, threadsBlob, type ThreadsCreds } from '../../functions/api/channels/threads';
import { encryptToken } from '../../functions/api/lib/crypto';
import { isValidMediaUrl, sendTelegramPost } from '../../functions/api/channels/telegram';
import { enqueueWebhookEvent } from '../../functions/api/lib/webhooks';
import { pausedNetworks } from '../../functions/api/lib/networks';

export const BATCH_SIZE = 20;               // per run: keeps us inside Workers' subrequest limits
export const MAX_ATTEMPTS = 5;
export const STUCK_AFTER_SECONDS = 10 * 60;
export const MAX_LATE_SECONDS = 2 * 60 * 60;

/** Seconds to wait after `attempts` failed tries: 120, 240, 480, 900, 900… (SQL below must match). */
export const backoffSeconds = (attempts: number): number => Math.min(60 * 2 ** attempts, 900);

const MEDIA_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|mp4|mov)$/;

/** `media_keys` holds https URLs or R2 object keys; Telegram needs a public URL. */
export function resolveMediaUrl(entry: unknown, appUrl: string | undefined): string | null {
  if (typeof entry !== 'string') return null;
  if (entry.startsWith('https://')) return isValidMediaUrl(entry) ? entry : null;
  if (MEDIA_KEY_RE.test(entry) && appUrl) return `${appUrl.replace(/\/+$/, '')}/api/media/${entry}`;
  return null;
}

interface Claimed {
  id: string; user_id: string; channel_id: string; content: string;
  media_keys: string; scheduled_at: number; attempts: number;
}
type ChannelInfo = Pick<ChannelRow, 'id' | 'type' | 'name' | 'credentials' | 'is_active'>;
type Outcome = 'sent' | 'retry' | 'failed';
export interface RunSummary { skipped?: string; expired: number; reaped: number; claimed: number; sent: number; retried: number; failed: number }

const clip = (s: string, n = 300) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export async function runDuePosts(env: CronEnv, nowSec: number = Math.floor(Date.now() / 1000)): Promise<RunSummary> {
  const summary: RunSummary = { expired: 0, reaped: 0, claimed: 0, sent: 0, retried: 0, failed: 0 };

  if (!env.ENCRYPTION_KEY || env.ENCRYPTION_KEY.length < 32) {
    console.error('vane-cron: ENCRYPTION_KEY is missing or too short. Skipping this run so no post is touched.');
    return { ...summary, skipped: 'ENCRYPTION_KEY not configured' };
  }

  const log = (post: { id: string; user_id: string; channel_id: string }, level: 'info' | 'warn' | 'error', event: string, message: string, meta?: unknown) =>
    env.DB
      .prepare('INSERT INTO logs (user_id, post_id, channel_id, level, event, message, meta, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
      .bind(post.user_id, post.id, post.channel_id, level, event, clip(message), meta ? JSON.stringify(meta) : null, nowSec);

  // Networks the admin switched off (/admin → Networks): their posts are left alone and WAIT (empty list when none, or the table is missing).
  const paused = await pausedNetworks(env);
  const inPaused = (from: number) => `SELECT id FROM channels WHERE type IN (${paused.map((_, i) => `?${from + i}`).join(',')})`;
  const notPaused = (from: number) => (paused.length ? ` AND channel_id NOT IN (${inPaused(from)})` : '');

  // ── 1) Too late: don't publish content hours after the moment the user chose.
  const late = await env.DB
    .prepare(
      `UPDATE posts SET status = 'failed', updated_at = ?1,
              error = 'Missed its scheduled time by more than 2 hours (the scheduler was not running), so it was not published.'
        WHERE status = 'scheduled' AND scheduled_at <= ?2${notPaused(3)}
        RETURNING id, user_id, channel_id`,
    )
    .bind(nowSec, nowSec - MAX_LATE_SECONDS, ...paused)
    .all<{ id: string; user_id: string; channel_id: string }>();
  summary.expired = late.results.length;
  if (late.results.length) await env.DB.batch(late.results.map((p) => log(p, 'error', 'post.expired', 'Not published: more than 2 hours overdue')));
  for (const p of late.results) await enqueueWebhookEvent(env, p.user_id, p.id, 'post.failed', nowSec);

  // ── 1b) A paused network that stayed off for more than 2 hours past the scheduled time: say so, honestly.
  if (paused.length) {
    const held = await env.DB
      .prepare(
        `UPDATE posts SET status = 'failed', updated_at = ?1,
                error = 'This network was switched off for more than 2 hours after the scheduled time, so the post was not published. Schedule it again.'
          WHERE status = 'scheduled' AND scheduled_at <= ?2 AND channel_id IN (${inPaused(3)})
          RETURNING id, user_id, channel_id`,
      )
      .bind(nowSec, nowSec - MAX_LATE_SECONDS, ...paused)
      .all<{ id: string; user_id: string; channel_id: string }>();
    summary.expired += held.results.length;
    if (held.results.length) await env.DB.batch(held.results.map((p) => log(p, 'error', 'post.paused_expired', 'Not published: its network was switched off for more than 2 hours')));
    for (const p of held.results) await enqueueWebhookEvent(env, p.user_id, p.id, 'post.failed', nowSec);
  }

  // ── 2) Orphans: 'processing' for too long means a previous run died mid-flight.
  const stuck = await env.DB
    .prepare(
      `UPDATE posts SET status = 'failed', updated_at = ?1,
              error = 'Delivery was interrupted and could not be confirmed. Check the channel; reschedule if the post is missing.'
        WHERE status = 'processing' AND updated_at <= ?2
        RETURNING id, user_id, channel_id`,
    )
    .bind(nowSec, nowSec - STUCK_AFTER_SECONDS)
    .all<{ id: string; user_id: string; channel_id: string }>();
  summary.reaped = stuck.results.length;
  if (stuck.results.length) await env.DB.batch(stuck.results.map((p) => log(p, 'error', 'post.interrupted', 'Marked failed: stuck in processing')));
  for (const p of stuck.results) await enqueueWebhookEvent(env, p.user_id, p.id, 'post.failed', nowSec);

  // ── 3) Claim due posts atomically (scheduled → processing) and read them back in one statement.
  const claimed = await env.DB
    .prepare(
      `UPDATE posts SET status = 'processing', attempts = attempts + 1, updated_at = ?1
        WHERE id IN (
          SELECT id FROM posts
           WHERE status = 'scheduled' AND scheduled_at <= ?1
             AND (attempts = 0 OR updated_at + MIN(60 * (1 << attempts), 900) <= ?1)${notPaused(3)}
           ORDER BY scheduled_at ASC LIMIT ?2)
        RETURNING id, user_id, channel_id, content, media_keys, scheduled_at, attempts`,
    )
    .bind(nowSec, BATCH_SIZE, ...paused)
    .all<Claimed>();
  // RETURNING does not promise any row order, so restore it: oldest scheduled time first.
  const posts = [...claimed.results].sort((a, b) => a.scheduled_at - b.scheduled_at || a.id.localeCompare(b.id));
  summary.claimed = posts.length;
  if (!posts.length) return summary;

  // ── 4) Load each distinct channel once and decrypt its credentials once.
  const channelIds = [...new Set(posts.map((p) => p.channel_id))];
  const { results: chRows } = await env.DB
    .prepare(`SELECT id, type, name, credentials, is_active FROM channels WHERE id IN (${channelIds.map((_, i) => `?${i + 1}`).join(',')})`)
    .bind(...channelIds)
    .all<ChannelInfo>();
  const channels = new Map(chRows.map((c) => [c.id, c]));
  type CredsOutcome = { creds: TelegramCreds } | { error: string };
  const credCache = new Map<string, CredsOutcome>();

  async function credsFor(ch: ChannelInfo): Promise<CredsOutcome> {
    const cached = credCache.get(ch.id);
    if (cached) return cached;
    const loaded = await loadTelegramCreds(ch.credentials, env);
    let outcome: CredsOutcome;
    if (loaded.ok) outcome = { creds: loaded.creds };
    else {
      outcome = { error: CREDS_ERROR[loaded.reason] };
      console.error(
        loaded.reason === 'system_bot_missing'
          ? `vane-cron: SYSTEM_BOT_TOKEN is not set on this worker, so Quick Connect channels (e.g. ${ch.id}) cannot be published to`
          : `vane-cron: could not decrypt credentials of channel ${ch.id} (wrong ENCRYPTION_KEY or corrupt data)`,
      );
    }
    credCache.set(ch.id, outcome);
    return outcome;
  }

  // ── 5) Deliver, one post at a time (Telegram allows ~20 messages/min per channel).
  async function finish(post: Claimed, outcome: Outcome, error: string | null, extra: { externalId?: string; network?: string; retryAfter?: number } = {}): Promise<void> {
    const base = { id: post.id, user_id: post.user_id, channel_id: post.channel_id };
    if (outcome === 'sent') {
      await env.DB.batch([
        env.DB.prepare(`UPDATE posts SET status = 'sent', sent_at = ?1, external_id = ?2, error = NULL, updated_at = ?1 WHERE id = ?3 AND status = 'processing'`)
          .bind(nowSec, extra.externalId ?? '', post.id),
        log(base, 'info', 'post.sent', `Published to ${extra.network ?? 'Telegram'}`, { attempt: post.attempts, externalId: extra.externalId }),
      ]);
      await enqueueWebhookEvent(env, post.user_id, post.id, 'post.published', nowSec);
    } else if (outcome === 'retry') {
      // Due again at updated_at + backoff(attempts). For the network's retry_after (Telegram, Bluesky), push updated_at
      // into the future by the difference so the next try is never earlier than the network asked.
      const wait = backoffSeconds(post.attempts);
      const bump = Math.max(0, (extra.retryAfter ?? 0) - wait);
      await env.DB.batch([
        env.DB.prepare(`UPDATE posts SET status = 'scheduled', error = ?1, updated_at = ?2 WHERE id = ?3 AND status = 'processing'`)
          .bind(clip(error ?? 'Temporary error'), nowSec + bump, post.id),
        log(base, 'warn', 'post.retry', error ?? 'Temporary error', { attempt: post.attempts, retryInSeconds: wait + bump }),
      ]);
    } else {
      await env.DB.batch([
        env.DB.prepare(`UPDATE posts SET status = 'failed', error = ?1, updated_at = ?2 WHERE id = ?3 AND status = 'processing'`)
          .bind(clip(error ?? 'Delivery failed'), nowSec, post.id),
        log(base, 'error', 'post.failed', error ?? 'Delivery failed', { attempt: post.attempts }),
      ]);
      await enqueueWebhookEvent(env, post.user_id, post.id, 'post.failed', nowSec);
    }
  }

  async function deliver(post: Claimed): Promise<void> {
    const ch = channels.get(post.channel_id);
    if (!ch) return finish(post, 'failed', 'The channel no longer exists.');
    if (!ch.is_active) return finish(post, 'failed', 'The channel is disabled.');
    if (ch.type === 'bluesky') return deliverBluesky(post, ch);
    if (ch.type === 'mastodon') return deliverMastodon(post, ch);
    if (ch.type === 'linkedin') return deliverLinkedin(post, ch);
    if (ch.type === 'threads') return deliverThreads(post, ch);
    if (ch.type !== 'telegram') return finish(post, 'failed', `Publishing to ${ch.type} is not supported yet.`);

    const resolved = await credsFor(ch);
    if ('error' in resolved) {
      // Often a missing/wrong secret rather than bad data: retry a few times before giving up.
      return finish(post, post.attempts < MAX_ATTEMPTS ? 'retry' : 'failed', resolved.error);
    }
    const creds = resolved.creds;

    let mediaUrl: string | undefined;
    try {
      const first = (JSON.parse(post.media_keys) as unknown[])[0];
      if (first !== undefined) {
        const resolved = resolveMediaUrl(first, env.APP_URL);
        if (!resolved) return finish(post, 'failed', 'The attached image reference is invalid.');
        mediaUrl = resolved;
      }
    } catch {
      return finish(post, 'failed', 'The attached image reference is invalid.');
    }

    const res = await sendTelegramPost(creds.botToken, creds.chatId, post.content, mediaUrl);
    if (res.ok) return finish(post, 'sent', null, { externalId: String(res.messageId), network: 'Telegram' });
    if (res.retryable && post.attempts < MAX_ATTEMPTS) return finish(post, 'retry', res.error, { retryAfter: res.retryAfter });
    return finish(post, 'failed', res.retryable ? `${res.error} (gave up after ${post.attempts} attempts)` : res.error);
  }

  // One Bluesky session per channel per run (Bluesky limits how often an account may sign in).
  const bskySessions = new Map<string, { session: BlueskySession } | { error: string; retryable: boolean; retryAfter?: number }>();

  async function bskySessionFor(ch: ChannelInfo) {
    const cached = bskySessions.get(ch.id);
    if (cached) return cached;
    let outcome: { session: BlueskySession } | { error: string; retryable: boolean; retryAfter?: number };
    const creds = await loadBlueskyCreds(ch.credentials, env.ENCRYPTION_KEY);
    if (!creds) {
      console.error(`vane-cron: could not decrypt credentials of channel ${ch.id} (wrong ENCRYPTION_KEY or corrupt data)`);
      outcome = { error: CREDS_ERROR.unreadable, retryable: true };
    } else {
      const opened = await openBlueskySession(creds.identifier, creds.appPassword);
      if (opened.ok) outcome = { session: opened.session };
      else if (opened.code === 'bad_login') outcome = { error: 'Bluesky no longer accepts the saved app password. Reconnect the account.', retryable: false };
      else outcome = { error: opened.error, retryable: true, retryAfter: opened.retryAfter };
    }
    bskySessions.set(ch.id, outcome);
    return outcome;
  }

  async function deliverBluesky(post: Claimed, ch: ChannelInfo): Promise<void> {
    const opened = await bskySessionFor(ch);
    if ('error' in opened) {
      if (opened.retryable && post.attempts < MAX_ATTEMPTS) return finish(post, 'retry', opened.error, { retryAfter: opened.retryAfter });
      return finish(post, 'failed', opened.error);
    }

    let mediaUrl: string | undefined;
    try {
      const first = (JSON.parse(post.media_keys) as unknown[])[0];
      if (first !== undefined) {
        const url = resolveMediaUrl(first, env.APP_URL);
        if (!url) return finish(post, 'failed', 'The attached image reference is invalid.');
        mediaUrl = url;
      }
    } catch {
      return finish(post, 'failed', 'The attached image reference is invalid.');
    }

    const res = await sendBlueskyPost(opened.session, post.content, mediaUrl);
    if (res.ok) return finish(post, 'sent', null, { externalId: res.uri, network: 'Bluesky' });
    if (res.retryable && post.attempts < MAX_ATTEMPTS) return finish(post, 'retry', res.error, { retryAfter: res.retryAfter });
    return finish(post, 'failed', res.retryable ? `${res.error} (gave up after ${post.attempts} attempts)` : res.error);
  }

  async function deliverMastodon(post: Claimed, ch: ChannelInfo): Promise<void> {
    const creds = await loadMastodonCreds(ch.credentials, env.ENCRYPTION_KEY);
    if (!creds) {
      console.error(`vane-cron: could not read credentials of channel ${ch.id} (wrong ENCRYPTION_KEY or corrupt data)`);
      return finish(post, post.attempts < MAX_ATTEMPTS ? 'retry' : 'failed', CREDS_ERROR.unreadable);
    }

    let mediaUrl: string | undefined;
    try {
      const first = (JSON.parse(post.media_keys) as unknown[])[0];
      if (first !== undefined) {
        const url = resolveMediaUrl(first, env.APP_URL);
        if (!url) return finish(post, 'failed', 'The attached image reference is invalid.');
        mediaUrl = url;
      }
    } catch {
      return finish(post, 'failed', 'The attached image reference is invalid.');
    }

    // The post id is the Idempotency-Key: if a try times out after Mastodon already posted, the next try gets the same status back instead of a duplicate.
    const res = await sendMastodonPost(creds, post.content, mediaUrl, post.id);
    if (res.ok) return finish(post, 'sent', null, { externalId: res.url, network: 'Mastodon' });
    if (res.retryable && post.attempts < MAX_ATTEMPTS) return finish(post, 'retry', res.error, { retryAfter: res.retryAfter });
    return finish(post, 'failed', res.retryable ? `${res.error} (gave up after ${post.attempts} attempts)` : res.error);
  }

  /** The attached picture / video as a public address; `{ error }` when the stored reference is bad. */
  function mediaOf(post: Claimed): { url?: string } | { error: string } {
    try {
      const first = (JSON.parse(post.media_keys) as unknown[])[0];
      if (first === undefined) return {};
      const url = resolveMediaUrl(first, env.APP_URL);
      return url ? { url } : { error: 'The attached image reference is invalid.' };
    } catch {
      return { error: 'The attached image reference is invalid.' };
    }
  }

  // A LinkedIn / Threads sign-in lasts 60 days. One that is running out is renewed here when the network allows it
  // (Threads always; LinkedIn only with a refresh token) and the new token is saved, encrypted, in the same step.
  async function saveCreds(ch: ChannelInfo, blob: Record<string, unknown>): Promise<void> {
    await env.DB
      .prepare('UPDATE channels SET credentials = ?1, updated_at = ?2 WHERE id = ?3')
      .bind(await encryptToken(JSON.stringify(blob), env.ENCRYPTION_KEY!), nowSec, ch.id)
      .run();
  }

  async function deliverLinkedin(post: Claimed, ch: ChannelInfo): Promise<void> {
    let creds: LinkedinCreds | null = await loadLinkedinCreds(ch.credentials, env.ENCRYPTION_KEY);
    if (!creds) {
      console.error(`vane-cron: could not read credentials of channel ${ch.id} (wrong ENCRYPTION_KEY or corrupt data)`);
      return finish(post, post.attempts < MAX_ATTEMPTS ? 'retry' : 'failed', CREDS_ERROR.unreadable);
    }
    if (creds.expiresAt && creds.expiresAt - nowSec < LINKEDIN_RENEW_BEFORE_SECONDS) {
      const renewed = await renewLinkedin(env, creds, nowSec);
      if (renewed) {
        creds = renewed;
        await saveCreds(ch, linkedinBlob(renewed.urn, renewed.name, renewed));
      }
    }
    const media = mediaOf(post);
    if ('error' in media) return finish(post, 'failed', media.error);

    const res = await sendLinkedinPost(env, creds, post.content, media.url, nowSec);
    // LinkedIn answers with the post's urn; the dashboard turns it into a link (functions/api/lib/postlink.ts)
    if (res.ok) return finish(post, 'sent', null, { externalId: res.id, network: 'LinkedIn' });
    if (res.retryable && post.attempts < MAX_ATTEMPTS) return finish(post, 'retry', res.error, { retryAfter: res.retryAfter });
    return finish(post, 'failed', res.retryable ? `${res.error} (gave up after ${post.attempts} attempts)` : res.error);
  }

  async function deliverThreads(post: Claimed, ch: ChannelInfo): Promise<void> {
    let creds: ThreadsCreds | null = await loadThreadsCreds(ch.credentials, env.ENCRYPTION_KEY);
    if (!creds) {
      console.error(`vane-cron: could not read credentials of channel ${ch.id} (wrong ENCRYPTION_KEY or corrupt data)`);
      return finish(post, post.attempts < MAX_ATTEMPTS ? 'retry' : 'failed', CREDS_ERROR.unreadable);
    }
    if (creds.expiresAt && creds.expiresAt - nowSec < THREADS_RENEW_BEFORE_SECONDS) {
      const renewed = await refreshThreadsToken(creds, nowSec);
      if (renewed) {
        creds = renewed;
        await saveCreds(ch, threadsBlob(renewed));
      }
    }
    const media = mediaOf(post);
    if ('error' in media) return finish(post, 'failed', media.error);

    const res = await sendThreadsPost(creds, post.content, media.url, nowSec);
    // the permalink, or (when Threads would not give one) the post id
    if (res.ok) return finish(post, 'sent', null, { externalId: res.url || res.id, network: 'Threads' });
    if (res.retryable && post.attempts < MAX_ATTEMPTS) return finish(post, 'retry', res.error, { retryAfter: res.retryAfter });
    return finish(post, 'failed', res.retryable ? `${res.error} (gave up after ${post.attempts} attempts)` : res.error);
  }

  for (const post of posts) {
    try {
      await deliver(post);
    } catch (err) {
      // A bug or a D1 hiccup on ONE post must never block the others.
      console.error(`vane-cron: unexpected error on post ${post.id}:`, err instanceof Error ? err.message : 'unknown');
      try {
        await finish(post, post.attempts < MAX_ATTEMPTS ? 'retry' : 'failed', 'Unexpected internal error.');
      } catch { /* leave it 'processing'; the orphan sweep will resolve it */ }
    }
  }

  // Tally from the database, so the numbers reflect what was actually saved.
  const { results } = await env.DB
    .prepare(`SELECT status, COUNT(*) AS n FROM posts WHERE id IN (${posts.map((_, i) => `?${i + 1}`).join(',')}) GROUP BY status`)
    .bind(...posts.map((p) => p.id))
    .all<{ status: string; n: number }>();
  for (const r of results) {
    if (r.status === 'sent') summary.sent = r.n;
    else if (r.status === 'scheduled') summary.retried = r.n;
    else if (r.status === 'failed') summary.failed = r.n;
  }
  console.log(`vane-cron: ${JSON.stringify(summary)}`);
  return summary;
}
