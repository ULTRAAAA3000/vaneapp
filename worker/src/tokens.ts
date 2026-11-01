/**
 * Keeps LinkedIn / Threads sign-ins alive. A Threads token lasts 60 days and can be renewed once it is a day old; a LinkedIn
 * token lasts 60 days and can only be renewed when LinkedIn gave a refresh token (most apps do not get one: the person then
 * connects again, and the dashboard shows "Reconnect" before that).
 *
 * Posts renew a token that is running out when they use it (dispatch.ts). This sweep, once a day, covers accounts that have not
 * posted for weeks. It looks at the channels not touched for 40 days (`updated_at` moves whenever a token is renewed), opens each
 * and renews the ones with less than 20 days left. A failed renewal is simply tried again tomorrow.
 */
import type { CronEnv } from '../../types';
import { LINKEDIN_RENEW_BEFORE_SECONDS, linkedinBlob, loadLinkedinCreds, renewLinkedin } from '../../functions/api/channels/linkedin';
import { THREADS_RENEW_BEFORE_SECONDS, loadThreadsCreds, refreshThreadsToken, threadsBlob } from '../../functions/api/channels/threads';
import { PINTEREST_RENEW_BEFORE_SECONDS, loadPinterestCreds, pinterestBlob, refreshPinterestToken } from '../../functions/api/channels/pinterest';
import { encryptToken } from '../../functions/api/lib/crypto';

const UNTOUCHED_FOR_SECONDS = 40 * 24 * 3600;
const PER_RUN = 50;

/** 03:00 UTC, once a day (the cron fires every minute) */
export const isRenewalMinute = (nowSec: number): boolean => {
  const d = new Date(nowSec * 1000);
  return d.getUTCHours() === 3 && d.getUTCMinutes() === 0;
};

export async function renewExpiringTokens(env: CronEnv, nowSec: number): Promise<{ checked: number; renewed: number }> {
  const out = { checked: 0, renewed: 0 };
  if (!env.ENCRYPTION_KEY || env.ENCRYPTION_KEY.length < 32) return out;

  const { results } = await env.DB
    .prepare(`SELECT id, type, credentials FROM channels WHERE type IN ('threads', 'linkedin', 'pinterest') AND is_active = 1 AND updated_at <= ?1 ORDER BY updated_at ASC LIMIT ?2`)
    .bind(nowSec - UNTOUCHED_FOR_SECONDS, PER_RUN)
    .all<{ id: string; type: 'threads' | 'linkedin' | 'pinterest'; credentials: string }>();

  for (const row of results) {
    out.checked++;
    let blob: Record<string, unknown> | null = null;
    if (row.type === 'threads') {
      const c = await loadThreadsCreds(row.credentials, env.ENCRYPTION_KEY);
      if (c && c.expiresAt > nowSec && c.expiresAt - nowSec < THREADS_RENEW_BEFORE_SECONDS) {
        const n = await refreshThreadsToken(c, nowSec);
        if (n) blob = threadsBlob(n);
      }
    } else if (row.type === 'pinterest') {
      const c = await loadPinterestCreds(row.credentials, env.ENCRYPTION_KEY);
      if (c && c.expiresAt - nowSec < PINTEREST_RENEW_BEFORE_SECONDS) {
        const n = await refreshPinterestToken(env, c, nowSec);
        if (n.ok) blob = pinterestBlob(n.creds);
      }
    } else {
      const c = await loadLinkedinCreds(row.credentials, env.ENCRYPTION_KEY);
      if (c && c.refreshToken && c.expiresAt > nowSec && c.expiresAt - nowSec < LINKEDIN_RENEW_BEFORE_SECONDS) {
        const n = await renewLinkedin(env, c, nowSec);
        if (n) blob = linkedinBlob(n.urn, n.name, n);
      }
    }
    if (!blob) continue;
    await env.DB
      .prepare('UPDATE channels SET credentials = ?1, updated_at = ?2 WHERE id = ?3')
      .bind(await encryptToken(JSON.stringify(blob), env.ENCRYPTION_KEY), nowSec, row.id)
      .run();
    out.renewed++;
  }
  if (out.checked) console.log(`vane-cron: sign-in renewal ${JSON.stringify(out)}`);
  return out;
}
