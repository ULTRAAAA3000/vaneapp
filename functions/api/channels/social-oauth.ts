/**
 * Connecting a LinkedIn profile or a Threads account (the browser flow; routes in ./linkedin/ and ./threads/).
 *
 *   POST /api/channels/<network>/start     { name? }                → { ok, authorizeUrl }   the dashboard then sends the browser there
 *   GET  /api/channels/<network>/callback  ?code=…&state=…          → 302 back to /app?connect=<network>&status=…
 *
 * 1. start: checks the app is configured, remembers a one-time `state` (table oauth_states, 10 minutes, single use).
 * 2. The person presses "Allow" on LinkedIn / Threads.
 * 3. callback: the network returns here with a `code`. We check the `state` (single use, same signed-in user), swap the code for an
 *    access token, ask who the account is, and save the channel with the token encrypted. Connecting an account that is already
 *    there renews its sign-in instead ("Reconnect" in the dashboard), so a 60-day token never needs a second channel.
 *
 * The callback talks to the browser, so it never shows JSON: it always redirects, with a short reason code (never text from the other network).
 */
import { networkEnabled, networkOff } from '../lib/networks';
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { checkChannelQuota } from '../lib/catalog';
import { encryptToken } from '../lib/crypto';
import { toB64Url } from '../lib/encoding';
import { fail, isRecord, json, readJson } from '../lib/http';
import { sha256Hex } from '../lib/session';
import { bump, clientIp, retryAfter } from '../lib/throttle';
import * as li from './linkedin';
import * as th from './threads';

export type Network = 'linkedin' | 'threads';
type Reason = 'ok' | 'reconnected' | 'denied' | 'noperm' | 'expired' | 'failed' | 'migrate' | 'limit' | 'off';

const STATE_TTL_SECONDS = 600;
const STARTS_PER_USER_PER_HOUR = 10;
const STARTS_PER_IP_PER_HOUR = 30;
const MAX_NAME_LEN = 80;
const LABEL: Record<Network, string> = { linkedin: 'LinkedIn', threads: 'Threads' };

const originOf = (request: Request, env: Env): string => (env.APP_URL ? env.APP_URL.replace(/\/+$/, '') : new URL(request.url).origin);
/** The address to register in the LinkedIn / Meta developer portal as the redirect (callback) URL. */
export const redirectUriFor = (net: Network, request: Request, env: Env): string => `${originOf(request, env)}/api/channels/${net}/callback`;

const configured = (net: Network, env: Env): boolean => (net === 'linkedin' ? li.linkedinConfigured(env) : th.threadsConfigured(env));
const authorizeUrl = (net: Network, env: Env, redirectUri: string, state: string): string =>
  net === 'linkedin' ? li.authorizeUrl(env, redirectUri, state) : th.authorizeUrl(env, redirectUri, state);

// ───────────────────────── start ─────────────────────────
export const startHandler = (net: Network): PagesFunction<Env> => async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  if (!env.ENCRYPTION_KEY || env.ENCRYPTION_KEY.length < 32) {
    console.error('ENCRYPTION_KEY is missing or shorter than 32 characters');
    return fail(500, 'Server is not configured correctly');
  }
  if (!configured(net, env)) return fail(503, `${LABEL[net]} is not set up on this server yet.`);
  const paused = await networkOff(env, net);   // switched off in /admin → Networks
  if (paused) return paused;

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  if (!isRecord(parsed.data)) return fail(400, 'Body must be a JSON object');
  const name = typeof parsed.data.name === 'string' ? parsed.data.name.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  if (name.length > MAX_NAME_LEN) return fail(400, `name can be at most ${MAX_NAME_LEN} characters`);

  const userKey = `${net}:start:${auth.userId}`;
  const ipKey = `${net}:start:ip:${clientIp(request)}`;
  const wait = Math.max(await retryAfter(env, userKey, STARTS_PER_USER_PER_HOUR), await retryAfter(env, ipKey, STARTS_PER_IP_PER_HOUR));
  if (wait) return fail(429, 'Too many attempts. Try again later.', { 'Retry-After': String(wait) });
  await bump(env, userKey, 3600);
  await bump(env, ipKey, 3600);

  const state = toB64Url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM oauth_states WHERE expires_at <= ?1').bind(now),
      env.DB
        .prepare('INSERT INTO oauth_states (state_hash, user_id, provider, instance, name, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
        .bind(await sha256Hex(state), auth.userId, net, '', name, now, now + STATE_TTL_SECONDS),
    ]);
  } catch (err) {
    console.error(`${net} start failed`, err instanceof Error ? err.message : 'unknown');
    return fail(503, `${LABEL[net]} is not enabled on this server yet. The database needs one update: npm run db:remote.`);
  }
  return json({ ok: true, authorizeUrl: authorizeUrl(net, env, redirectUriFor(net, request, env), state) });
};

// ───────────────────────── callback ─────────────────────────
const back = (net: Network, status: Reason): Response =>
  new Response(null, {
    status: 302,
    headers: { Location: `/app?connect=${net}&status=${status}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });

interface Connected {
  /** what makes the account the same one next time: the LinkedIn urn / the Threads user id */
  identity: string;
  defaultName: string;
  blob: Record<string, unknown>;
}
type ConnectOutcome = { ok: true; connected: Connected } | { ok: false; reason: 'failed' | 'noperm' };

async function connect(net: Network, env: Env, redirectUri: string, code: string, now: number): Promise<ConnectOutcome> {
  if (net === 'linkedin') {
    const t = await li.exchangeCode(env, redirectUri, code, now);
    if (!t.ok) return t;
    const me = await li.readProfile(t.tokens.accessToken);
    if (!me.ok) return { ok: false, reason: 'failed' };
    const urn = `urn:li:person:${me.id}`;
    return { ok: true, connected: { identity: urn, defaultName: me.name || 'LinkedIn', blob: li.linkedinBlob(urn, me.name, t.tokens) } };
  }
  const t = await th.exchangeCode(env, redirectUri, code, now);
  if (!t.ok) return t;
  const me = await th.readProfile(t.connected.accessToken);
  if (!me.ok) return { ok: false, reason: 'failed' };
  return {
    ok: true,
    connected: { identity: t.connected.userId, defaultName: `@${me.username}`, blob: th.threadsBlob({ ...t.connected, username: me.username }) },
  };
}

/** The user's channel of this network that is the same account, if there is one (credentials are encrypted, so each is opened). */
async function findSameAccount(net: Network, env: Env, userId: string, identity: string): Promise<{ id: string } | null> {
  const { results } = await env.DB
    .prepare('SELECT id, credentials FROM channels WHERE user_id = ?1 AND type = ?2 LIMIT 200')
    .bind(userId, net)
    .all<{ id: string; credentials: string }>();
  for (const row of results) {
    const same = net === 'linkedin'
      ? (await li.loadLinkedinCreds(row.credentials, env.ENCRYPTION_KEY))?.urn === identity
      : (await th.threadsIdentity(row.credentials, env.ENCRYPTION_KEY)) === identity; // by account, so a channel whose access was removed is revived
    if (same) return { id: row.id };
  }
  return null;
}

export const callbackHandler = (net: Network): PagesFunction<Env> => async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return new Response(null, { status: 302, headers: { Location: '/login', 'Cache-Control': 'no-store' } });

  const q = new URL(request.url).searchParams;
  if (!(await networkEnabled(env, net))) return back(net, 'off');   // switched off in /admin → Networks
  const state = q.get('state') ?? '';
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(state)) return back(net, 'expired');

  // Single use: whoever deletes the row owns the attempt, so a replayed or doubled callback finds nothing.
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB
    .prepare('DELETE FROM oauth_states WHERE state_hash = ?1 AND provider = ?2 RETURNING user_id, name, expires_at')
    .bind(await sha256Hex(state), net)
    .first<{ user_id: string; name: string; expires_at: number }>();
  if (!row || row.expires_at <= now || row.user_id !== auth.userId) return back(net, 'expired');

  if (q.get('error')) return back(net, 'denied');
  const code = q.get('code') ?? '';
  if (!code || code.length > 2048) return back(net, 'failed');
  if (!env.ENCRYPTION_KEY || env.ENCRYPTION_KEY.length < 32) {
    console.error('ENCRYPTION_KEY is missing or shorter than 32 characters');
    return back(net, 'failed');
  }
  if (!configured(net, env)) return back(net, 'failed');

  const outcome = await connect(net, env, redirectUriFor(net, request, env), code, now);
  if (!outcome.ok) return back(net, outcome.reason);
  const { identity, defaultName, blob } = outcome.connected;
  const encrypted = await encryptToken(JSON.stringify(blob), env.ENCRYPTION_KEY);

  try {
    const same = await findSameAccount(net, env, auth.userId, identity);
    if (same) {
      // "Reconnect": keep the channel (and its scheduled posts), give it the new sign-in.
      await env.DB.prepare('UPDATE channels SET credentials = ?1, is_active = 1, updated_at = ?2 WHERE id = ?3 AND user_id = ?4').bind(encrypted, now, same.id, auth.userId).run();
      return back(net, 'reconnected');
    }
    // A new channel counts against the plan (only while "enforce_limits" is on); renewing a sign-in above does not.
    if (await checkChannelQuota(env, auth.userId)) return back(net, 'limit');
    await env.DB
      .prepare(`INSERT INTO channels (id, user_id, type, name, credentials, is_active, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)`)
      .bind(crypto.randomUUID(), auth.userId, net, row.name || defaultName, encrypted, now)
      .run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    console.error(`${net} channel save failed`, msg);
    return back(net, /CHECK constraint/i.test(msg) ? 'migrate' : 'failed');
  }
  return back(net, 'ok');
};
