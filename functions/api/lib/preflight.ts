import { loadLinkedinCreds } from '../channels/linkedin';
import { loadThreadsCreds } from '../channels/threads';
import { networkInfo, pausedNetworks } from './networks';

export const HORIZON_SECONDS = 7 * 24 * 3600;
export const FAILURE_MEMORY_SECONDS = 14 * 24 * 3600;
const MAX_CHANNELS = 200;
const AUTH_ERROR = /\b(401|403)\b|unauthori[sz]ed|forbidden|token|expired|revoked|invalid[_ ]grant|not authori[sz]ed|reconnect|credential|session|log ?in|sign[- ]?in|permission/i;

export type ProblemCode = 'inactive' | 'paused' | 'expired' | 'expiring' | 'last_failed';

export interface Problem {
  userId: string;
  channelId: string;
  platform: string;
  name: string;
  code: ProblemCode;
  message: string;
  reconnect: boolean;
  postCount: number;
  firstAt: number;
}

interface Env { DB: D1Database; ENCRYPTION_KEY?: string }

interface Row { channel_id: string; user_id: string; type: string; name: string; is_active: number; credentials: string | null; n: number; first_at: number }

const label = (type: string): string => networkInfo(type)?.name ?? type;
const day = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10);
const clean = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 160);

export async function findProblems(env: Env, now: number, opts: { userId?: string; horizon?: number; startsWithin?: number } = {}): Promise<Problem[]> {
  const horizon = opts.horizon ?? HORIZON_SECONDS;
  const until = now + (opts.startsWithin ?? horizon);
  const { results } = await env.DB
    .prepare(
      `SELECT p.channel_id, c.user_id, c.type, c.name, c.is_active,
              CASE WHEN c.type IN ('linkedin', 'threads') THEN c.credentials END AS credentials,
              COUNT(*) AS n, MIN(p.scheduled_at) AS first_at
         FROM posts p JOIN channels c ON c.id = p.channel_id
        WHERE p.status = 'scheduled' AND p.scheduled_at <= ?1 ${opts.userId ? 'AND c.user_id = ?3' : ''}
        GROUP BY p.channel_id ORDER BY first_at LIMIT ?2`,
    )
    .bind(...(opts.userId ? [now + horizon, MAX_CHANNELS, opts.userId] : [now + horizon, MAX_CHANNELS]))
    .all<Row>();

  const paused = new Set(await pausedNetworks(env));
  const out: Problem[] = [];

  for (const r of results) {
    if (r.first_at > until) continue;
    const base = { userId: r.user_id, channelId: r.channel_id, platform: r.type, name: r.name, postCount: r.n, firstAt: r.first_at };
    const net = label(r.type);
    const at = Math.max(r.first_at, now);
    let found: Pick<Problem, 'code' | 'message' | 'reconnect'> | null = null;

    if (!r.is_active) {
      found = { code: 'inactive', message: `${net} ${r.name} is switched off, so these posts will not go out.`, reconnect: false };
    } else if (paused.has(r.type)) {
      found = { code: 'paused', message: `Posting to ${net} is paused on Vane's side for now. The posts wait until it is back.`, reconnect: false };
    } else if (r.credentials) {
      let expiresAt = 0;
      if (r.type === 'linkedin') {
        const c = await loadLinkedinCreds(r.credentials, env.ENCRYPTION_KEY);
        if (c) expiresAt = c.expiresAt;
      } else {
        const c = await loadThreadsCreds(r.credentials, env.ENCRYPTION_KEY);
        if (c) expiresAt = c.expiresAt;
      }
      if (expiresAt && expiresAt <= now) {
        found = { code: 'expired', message: `The ${net} sign-in expired on ${day(expiresAt)}. Reconnect it or these posts will fail.`, reconnect: true };
      } else if (expiresAt && expiresAt <= at) {
        found = { code: 'expiring', message: `The ${net} sign-in runs out on ${day(expiresAt)}, before the post is due. Reconnect it to keep posting.`, reconnect: true };
      }
    }

    if (!found) {
      const last = await env.DB
        .prepare(`SELECT status, error, COALESCE(sent_at, updated_at) AS at FROM posts WHERE channel_id = ?1 AND status IN ('sent', 'failed') ORDER BY COALESCE(sent_at, updated_at) DESC LIMIT 1`)
        .bind(r.channel_id).first<{ status: string; error: string | null; at: number }>();
      if (last && last.status === 'failed' && last.at >= now - FAILURE_MEMORY_SECONDS && AUTH_ERROR.test(last.error ?? '')) {
        found = { code: 'last_failed', message: `The last post to ${net} ${r.name} failed: ${clean(last.error ?? '')}. The next ones will probably fail too: reconnect the channel.`, reconnect: true };
      }
    }

    if (found) out.push({ ...base, ...found });
  }
  return out;
}
