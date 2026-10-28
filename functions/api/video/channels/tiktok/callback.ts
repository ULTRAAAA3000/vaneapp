/** GET /api/video/channels/tiktok/callback — TikTok sends the person back here with ?code&state; the channel is saved with an encrypted access and refresh tokens. */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../../types';
import { requireUser } from '../../../lib/auth';
import { encryptToken } from '../../../lib/crypto';
import { tiktokBlob, tiktokConfigured, tiktokExchange } from '../../../lib/tiktok';
import { methodNotAllowed } from '../../../lib/http';
import { requireVideoAccess } from '../../../lib/videoplans';
import { backToStudio, netCallback, readYtState, ytClearedCookie } from '../../../lib/youtubeconnect';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const done = (query: string): Response => { const r = backToStudio(request, query); r.headers.append('Set-Cookie', ytClearedCookie(request, 'tiktok')); return r; };
  if (!tiktokConfigured(env) || !env.ENCRYPTION_KEY) return done('connect_error=unavailable');
  if (url.searchParams.get('error')) return done('connect_error=cancelled');

  const auth = await requireUser(request, env);
  if (!auth.ok) return done('connect_error=signin');
  const saved = readYtState(request, 'tiktok');
  const code = url.searchParams.get('code') ?? '';
  const state = url.searchParams.get('state') ?? '';
  // The sign-in must be finished by the same person, in the same browser, who started it.
  if (!saved || saved.uid !== auth.userId || !code || code.length > 2048 || state.length < 20 || state !== saved.state) return done('connect_error=expired');
  if (await requireVideoAccess(env, auth.userId)) return done('connect_error=plan');

  const x = await tiktokExchange(env, netCallback(request, 'tiktok'), code, Math.floor(Date.now() / 1000));
  if (!x.ok) return done(`connect_error=${x.code}`);

  const credentials = await encryptToken(tiktokBlob(x.creds), env.ENCRYPTION_KEY);
  const existing = await env.DB.prepare(`SELECT id FROM video_channels WHERE user_id = ?1 AND platform = 'tiktok' AND account_ref = ?2`).bind(auth.userId, x.creds.openId).first<{ id: string }>();
  if (existing) {
    await env.DB.prepare('UPDATE video_channels SET name = ?2, credentials = ?3, is_active = 1, updated_at = unixepoch() WHERE id = ?1').bind(existing.id, x.creds.name, credentials).run();
  } else {
    await env.DB.prepare(`INSERT INTO video_channels (id, user_id, platform, name, account_ref, credentials) VALUES (?1, ?2, 'tiktok', ?3, ?4, ?5)`).bind(crypto.randomUUID(), auth.userId, x.creds.name, x.creds.openId, credentials).run();
  }
  return done('connected=tiktok');
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
