/**
 * Connecting a Mastodon account (the browser flow; routes in ./mastodon/).
 *
 *   POST /api/channels/mastodon/start     { instance, name? }  → { ok, authorizeUrl }   the dashboard then sends the browser there
 *   GET  /api/channels/mastodon/callback  ?code=…&state=…      → 302 back to /app?connect=mastodon&status=…
 *
 * 1. start: checks the server name, gets (or registers) Vane's OAuth app on that server, remembers a one-time `state`.
 * 2. The person presses "Authorize" on THEIR server.
 * 3. callback: the server returns here with a `code`. We check the `state` (single use, same signed-in user), swap the code for an
 *    access token, ask the server which account it is, and save the channel with the token encrypted.
 *
 * The callback talks to the browser, so it never shows JSON: it always redirects, with a short reason code (never text from the other server).
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { toB64Url } from '../lib/encoding';
import { encryptToken } from '../lib/crypto';
import { fail, isRecord, json, readJson } from '../lib/http';
import { sha256Hex } from '../lib/session';
import { bump, clientIp, retryAfter } from '../lib/throttle';
import { checkChannelQuota } from '../lib/catalog';
import { networkEnabled, networkOff } from '../lib/networks';
import { appFor, authorizeUrl, exchangeCode, findDuplicateMastodonChannel, normalizeInstance, readAccount } from './mastodon';

const STATE_TTL_SECONDS = 600;
const STARTS_PER_USER_PER_HOUR = 10;
const STARTS_PER_IP_PER_HOUR = 30;
const MAX_NAME_LEN = 80;

const originOf = (request: Request, env: Env): string => (env.APP_URL ? env.APP_URL.replace(/\/+$/, '') : new URL(request.url).origin);
const redirectUriFor = (request: Request, env: Env): string => `${originOf(request, env)}/api/channels/mastodon/callback`;

// ───────────────────────── start ─────────────────────────
export const handleMastodonStart: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const paused = await networkOff(env, 'mastodon');   // switched off in /admin → Networks
  if (paused) return paused;
  if (!env.ENCRYPTION_KEY || env.ENCRYPTION_KEY.length < 32) {
    console.error('ENCRYPTION_KEY is missing or shorter than 32 characters');
    return fail(500, 'Server is not configured correctly');
  }

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  if (!isRecord(parsed.data)) return fail(400, 'Body must be a JSON object');

  const instance = normalizeInstance(parsed.data.instance, new URL(redirectUriFor(request, env)).hostname);
  if (!instance) return fail(400, 'Enter the address of your Mastodon server, like mastodon.social.');
  const name = typeof parsed.data.name === 'string' ? parsed.data.name.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  if (name.length > MAX_NAME_LEN) return fail(400, `name can be at most ${MAX_NAME_LEN} characters`);

  // Every start makes Vane call a server the user named: limit it so it can't be used to poke at other people's servers.
  const userKey = `masto:start:${auth.userId}`;
  const ipKey = `masto:start:ip:${clientIp(request)}`;
  const wait = Math.max(await retryAfter(env, userKey, STARTS_PER_USER_PER_HOUR), await retryAfter(env, ipKey, STARTS_PER_IP_PER_HOUR));
  if (wait) return fail(429, 'Too many attempts. Try again later.', { 'Retry-After': String(wait) });
  await bump(env, userKey, 3600);
  await bump(env, ipKey, 3600);

  const redirectUri = redirectUriFor(request, env);
  const app = await appFor(env, instance, redirectUri);
  // 424, not 502: the edge replaces a 502/504 body with its own error page, and the person would never see this sentence.
  if (!app.ok) return fail(app.setup ? 503 : app.network ? 424 : 400, app.error);

  const state = toB64Url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM oauth_states WHERE expires_at <= ?1').bind(now),
      env.DB
        .prepare('INSERT INTO oauth_states (state_hash, user_id, provider, instance, name, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
        .bind(await sha256Hex(state), auth.userId, 'mastodon', instance, name, now, now + STATE_TTL_SECONDS),
    ]);
  } catch (err) {
    console.error('mastodon start failed', err instanceof Error ? err.message : 'unknown');
    return fail(503, 'Mastodon is not enabled on this server yet. The database needs one update: npm run db:remote.');
  }
  return json({ ok: true, instance, authorizeUrl: authorizeUrl(instance, app.app.clientId, redirectUri, state) });
};

// ───────────────────────── callback ─────────────────────────
type Reason = 'ok' | 'denied' | 'expired' | 'failed' | 'duplicate' | 'migrate' | 'limit' | 'off';

const back = (status: Reason): Response =>
  new Response(null, {
    status: 302,
    headers: { Location: `/app?connect=mastodon&status=${status}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });

export const handleMastodonCallback: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return new Response(null, { status: 302, headers: { Location: '/login', 'Cache-Control': 'no-store' } });

  if (!(await networkEnabled(env, 'mastodon'))) return back('off');   // switched off in /admin → Networks (checked first: the one-time state is not spent)

  const q = new URL(request.url).searchParams;
  const state = q.get('state') ?? '';
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(state)) return back('expired');

  // Single use: whoever deletes the row owns the attempt, so a replayed or doubled callback finds nothing.
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB
    .prepare('DELETE FROM oauth_states WHERE state_hash = ?1 AND provider = ?2 RETURNING user_id, instance, name, expires_at')
    .bind(await sha256Hex(state), 'mastodon')
    .first<{ user_id: string; instance: string; name: string; expires_at: number }>();
  if (!row || row.expires_at <= now || row.user_id !== auth.userId) return back('expired');

  if (q.get('error')) return back('denied');
  if (await checkChannelQuota(env, auth.userId)) return back('limit');   // plan limit (only while "enforce_limits" is on)
  const code = q.get('code') ?? '';
  if (!code || code.length > 2048) return back('failed');
  if (!env.ENCRYPTION_KEY || env.ENCRYPTION_KEY.length < 32) {
    console.error('ENCRYPTION_KEY is missing or shorter than 32 characters');
    return back('failed');
  }

  const redirectUri = redirectUriFor(request, env);
  const app = await appFor(env, row.instance, redirectUri);
  if (!app.ok) return back(app.setup ? 'migrate' : 'failed');
  const token = await exchangeCode(row.instance, app.app, redirectUri, code);
  if (!token.ok) return back('failed');
  const account = await readAccount(row.instance, token.accessToken);
  if (!account.ok) return back('failed');

  const dup = await findDuplicateMastodonChannel(env.DB, env.ENCRYPTION_KEY, auth.userId, row.instance, account.id);
  if (dup) return back('duplicate');

  const acct = `${account.username}@${row.instance}`;
  const blob = { type: 'mastodon', instance: row.instance, accountId: account.id, acct, accessToken: token.accessToken };
  const encrypted = await encryptToken(JSON.stringify(blob), env.ENCRYPTION_KEY);
  try {
    await env.DB
      .prepare(`INSERT INTO channels (id, user_id, type, name, credentials, is_active, created_at, updated_at) VALUES (?1, ?2, 'mastodon', ?3, ?4, 1, ?5, ?5)`)
      .bind(crypto.randomUUID(), auth.userId, row.name || `@${acct}`, encrypted, now)
      .run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    console.error('mastodon channel insert failed', msg);
    return back(/CHECK constraint/i.test(msg) ? 'migrate' : 'failed');
  }
  return back('ok');
};
