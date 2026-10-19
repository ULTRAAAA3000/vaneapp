/**
 * The two addresses Meta asks every app to provide (App settings → Threads API / Basic settings):
 *
 *   POST /api/channels/threads/deauthorize   the person removed Vane in their Threads settings
 *   POST /api/channels/threads/delete        the person asked Meta to delete the data an app holds about them
 *
 * Both arrive as a form field `signed_request`, signed with the app secret; anything not signed correctly is refused.
 *   deauthorize → the Threads channel is switched off, its saved sign-in is wiped and its scheduled posts are cancelled
 *   delete      → the Threads channel is removed (its posts and log lines go with it), and Meta gets the confirmation it expects:
 *                 { url, confirmation_code }, where the url is a page the person can open to see that their data was deleted
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { encryptToken } from '../lib/crypto';
import { fail, json } from '../lib/http';
import { enqueueCancelledForChannel, webhooksTablesExist } from '../lib/webhooks';
import { parseSignedRequest, threadsIdentity } from './threads';

const MAX_BODY = 8 * 1024;

async function threadsUserOf(request: Request, env: Env): Promise<{ ok: true; userId: string } | { ok: false; response: Response }> {
  if (!env.THREADS_APP_SECRET) return { ok: false, response: fail(503, 'Threads is not set up on this server yet.') };
  if (Number(request.headers.get('content-length')) > MAX_BODY) return { ok: false, response: fail(413, 'Request too large') };
  let signed: unknown;
  try {
    signed = (await request.formData()).get('signed_request');
  } catch {
    return { ok: false, response: fail(400, 'Expected a form body with signed_request') };
  }
  const userId = await parseSignedRequest(signed, env.THREADS_APP_SECRET);
  return userId ? { ok: true, userId } : { ok: false, response: fail(400, 'Invalid signed_request') };
}

/** Every Threads channel (whoever owns it) that belongs to this Threads account. Credentials are encrypted, so each is opened. */
async function channelsOf(env: Env, threadsUserId: string): Promise<{ id: string }[]> {
  const { results } = await env.DB
    .prepare(`SELECT id, credentials FROM channels WHERE type = 'threads' LIMIT 5000`)
    .all<{ id: string; credentials: string }>();
  const out = [];
  for (const row of results) {
    // by account id, not by token: after a "deauthorize" the token is gone but the channel must still be found for a deletion request
    if ((await threadsIdentity(row.credentials, env.ENCRYPTION_KEY)) === threadsUserId) out.push({ id: row.id });
  }
  return out;
}

export const handleThreadsDeauthorize: PagesFunction<Env> = async ({ request, env }) => {
  const who = await threadsUserOf(request, env);
  if (!who.ok) return who.response;
  if (!env.ENCRYPTION_KEY || env.ENCRYPTION_KEY.length < 32) return fail(500, 'Server is not configured correctly');

  const now = Math.floor(Date.now() / 1000);
  const REASON = 'Access to Threads was removed.';
  // The owner's webhooks hear about every post this cancels (skipped until the webhook tables exist: Meta's call must never fail).
  const hooks = await webhooksTablesExist(env.DB);
  for (const ch of await channelsOf(env, who.userId)) {
    const wiped = await encryptToken(JSON.stringify({ type: 'threads', userId: who.userId, username: '', accessToken: '', expiresAt: 0 }), env.ENCRYPTION_KEY);
    await env.DB.batch([
      env.DB.prepare('UPDATE channels SET is_active = 0, credentials = ?1, updated_at = ?2 WHERE id = ?3').bind(wiped, now, ch.id),
      env.DB.prepare(`UPDATE posts SET status = 'cancelled', error = ?3, updated_at = ?1 WHERE channel_id = ?2 AND status = 'scheduled'`).bind(now, ch.id, REASON),
      ...(hooks ? [enqueueCancelledForChannel(env.DB, ch.id, REASON, now)] : []),
    ]);
  }
  return json({ ok: true });
};

export const handleThreadsDelete: PagesFunction<Env> = async ({ request, env }) => {
  const who = await threadsUserOf(request, env);
  if (!who.ok) return who.response;

  for (const ch of await channelsOf(env, who.userId)) {
    await env.DB.prepare('DELETE FROM channels WHERE id = ?1').bind(ch.id).run(); // posts cascade; log rows keep no channel
  }
  const code = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
  const origin = env.APP_URL ? env.APP_URL.replace(/\/+$/, '') : new URL(request.url).origin;
  // The shape Meta documents: where the person can check the request, and a code that identifies it.
  return json({ url: `${origin}/data-deletion?code=${code}`, confirmation_code: code });
};
