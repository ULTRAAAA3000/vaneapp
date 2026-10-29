/**
 * The two calls behind the /connect page (the sign-in screen of the Claude connector). Cookie sign-in, same origin.
 *
 *   GET  /api/oauth/authorize?client_id&redirect_uri&response_type=code&code_challenge&code_challenge_method=S256&state
 *        → who is asking and what the connection will use, so the page can show "Claude wants to use your Vane"
 *   POST /api/oauth/authorize   same fields in a JSON body (+ optional apiKey)
 *        → { redirect }: where to send the browser (back to Claude with ?code=&state=)
 *
 * What the connection uses: by default a new API key named "Claude connector" (live when the plan has the API, otherwise a test key that
 * posts nothing; one key per person and client, reused when they reconnect), or a key of the person's own that they click in the list
 * (`keyId`) or paste (`apiKey`). The grant remembers which key it uses, never its secret: the MCP endpoint authenticates by that key's id.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { generateApiKey, hashApiKey, MAX_KEYS_PER_USER, parseApiKey } from '../lib/apikeys';
import { fail, failCode, isRecord, json, methodNotAllowed, readJson, UUID_RE } from '../lib/http';
import { isMissingSchema } from '../lib/integrations';
import { CODE_TTL, CONNECTOR_KEY_NAME, hashSecret, loadClient, newCode, validChallenge, type OauthClient } from '../lib/oauth';
import { apiAllowed } from '../lib/plans';
import { bump, retryAfter } from '../lib/throttle';
import { loadSubscription } from '../lib/usage';

interface Asked { client: OauthClient; redirectUri: string; challenge: string; state: string }

async function check(env: Env, p: Record<string, unknown>): Promise<Asked | Response> {
  const str = (k: string, max: number): string => (typeof p[k] === 'string' && (p[k] as string).length <= max ? (p[k] as string) : '');
  if (str('response_type', 20) !== 'code') return failCode(400, 'invalid_request', 'This sign-in link is not valid (response_type).');
  const client = await loadClient(env, str('client_id', 80));
  if (!client) return failCode(400, 'invalid_client', 'This connection request is not valid. Start again from Claude.');
  const redirectUri = str('redirect_uri', 512);
  if (!client.redirectUris.includes(redirectUri)) return failCode(400, 'invalid_redirect', 'This connection request is not valid (redirect address). Start again from Claude.');
  if (str('code_challenge_method', 10) !== 'S256' || !validChallenge(p.code_challenge)) return failCode(400, 'invalid_request', 'This connection request is not valid (PKCE). Start again from Claude.');
  return { client, redirectUri, challenge: p.code_challenge as string, state: str('state', 512) };
}

interface OwnKey { id: string; name: string; mode: string; hint: string; lastUsedAt: number | null; claude: boolean }

/** The person's active text-post keys for the picker, the ones used with Claude first. */
async function ownKeys(env: Env, userId: string): Promise<OwnKey[]> {
  type Row = { id: string; name: string; mode: string; hint: string; last_used_at: number | null; integration?: string | null };
  let rows: Row[];
  try {
    rows = (await env.DB.prepare(`SELECT id, name, mode, hint, last_used_at, integration FROM api_keys WHERE user_id = ?1 AND scope = 'post' AND revoked_at IS NULL ORDER BY created_at DESC`).bind(userId).all<Row>()).results;
  } catch (err) {
    if (!isMissingSchema(err)) throw err;
    rows = (await env.DB.prepare(`SELECT id, name, mode, hint, last_used_at FROM api_keys WHERE user_id = ?1 AND scope = 'post' AND revoked_at IS NULL ORDER BY created_at DESC`).bind(userId).all<Row>()).results;
  }
  const keys = rows.map((r) => ({ id: r.id, name: r.name, mode: r.mode, hint: r.hint, lastUsedAt: r.last_used_at, claude: r.integration === 'claude' || /claude/i.test(r.name) }));
  return [...keys.filter((k) => k.claude), ...keys.filter((k) => !k.claude)];
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const q: Record<string, unknown> = Object.fromEntries(new URL(request.url).searchParams);
  const asked = await check(env, q);
  if (asked instanceof Response) return asked;
  const user = await env.DB.prepare('SELECT email FROM users WHERE id = ?1').bind(auth.userId).first<{ email: string }>();
  const live = apiAllowed(await loadSubscription(env, auth.userId));
  let host = '';
  try { host = new URL(asked.redirectUri).host; } catch { /* checked above */ }
  return json({ ok: true, client: { name: asked.client.name, host }, user: { email: user?.email ?? '' }, live, keyName: CONNECTOR_KEY_NAME, keys: await ownKeys(env, auth.userId) });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const body = await readJson(request, 4096);
  if (!body.ok) return body.response;
  if (!isRecord(body.data)) return fail(400, 'Body must be a JSON object');
  const asked = await check(env, body.data);
  if (asked instanceof Response) return asked;

  const rl = `oauthauth:${auth.userId}`;
  const wait = await retryAfter(env, rl, 20);
  if (wait) return fail(429, 'Too many attempts. Try again later.', { 'Retry-After': String(wait) });
  await bump(env, rl, 3600);

  const now = Math.floor(Date.now() / 1000);
  let keyId: string;
  const pasted = typeof body.data.apiKey === 'string' ? body.data.apiKey.trim() : '';
  const picked = typeof body.data.keyId === 'string' ? body.data.keyId : '';

  if (picked) {
    if (!UUID_RE.test(picked)) return failCode(400, 'invalid_api_key', 'That key was not found on your account, or it was revoked.');
    const row = await env.DB.prepare(`SELECT id FROM api_keys WHERE id = ?1 AND user_id = ?2 AND scope = 'post' AND revoked_at IS NULL`).bind(picked, auth.userId).first<{ id: string }>();
    if (!row) return failCode(400, 'invalid_api_key', 'That key was not found on your account, or it was revoked.');
    keyId = row.id;
  } else if (pasted) {
    const parsed = parseApiKey(pasted);
    if (!parsed || parsed.scope !== 'post') return failCode(400, 'invalid_api_key', 'That is not a Vane Post API key (it looks like cpost_live_… or cpost_test_…).');
    const row = await env.DB.prepare('SELECT id FROM api_keys WHERE key_hash = ?1 AND user_id = ?2 AND revoked_at IS NULL').bind(await hashApiKey(pasted), auth.userId).first<{ id: string }>();
    if (!row) return failCode(400, 'invalid_api_key', 'That key was not found on your account, or it was revoked.');
    keyId = row.id;
  } else {
    const prev = await env.DB
      .prepare(`SELECT g.key_id FROM oauth_grants g JOIN api_keys k ON k.id = g.key_id
                 WHERE g.user_id = ?1 AND g.client_id = ?2 AND k.revoked_at IS NULL AND k.name = ?3 ORDER BY g.created_at DESC LIMIT 1`)
      .bind(auth.userId, asked.client.clientId, CONNECTOR_KEY_NAME).first<{ key_id: string }>();
    if (prev) {
      keyId = prev.key_id;
    } else {
      const active = await env.DB.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?1 AND revoked_at IS NULL').bind(auth.userId).first<{ n: number }>();
      if ((active?.n ?? 0) >= MAX_KEYS_PER_USER) return failCode(409, 'too_many_keys', `You already have ${MAX_KEYS_PER_USER} API keys. Pick one of them in the list, or revoke one you no longer use.`);
      const mode = apiAllowed(await loadSubscription(env, auth.userId)) ? 'live' : 'test';
      const key = await generateApiKey('post', mode);
      keyId = crypto.randomUUID();
      try {
        await env.DB.prepare('INSERT INTO api_keys (id, user_id, name, scope, mode, key_hash, hint, created_at, integration) VALUES (?1, ?2, ?3, \'post\', ?4, ?5, ?6, ?7, \'claude\')').bind(keyId, auth.userId, CONNECTOR_KEY_NAME, mode, key.hash, key.hint, now).run();
      } catch (err) {
        if (!isMissingSchema(err)) throw err;
        await env.DB.prepare('INSERT INTO api_keys (id, user_id, name, scope, mode, key_hash, hint, created_at) VALUES (?1, ?2, ?3, \'post\', ?4, ?5, ?6, ?7)').bind(keyId, auth.userId, CONNECTOR_KEY_NAME, mode, key.hash, key.hint, now).run();
      }
    }
  }

  const grantId = crypto.randomUUID();
  const code = newCode();
  await env.DB.batch([
    env.DB.prepare('UPDATE oauth_grants SET revoked_at = ?3 WHERE user_id = ?1 AND client_id = ?2 AND revoked_at IS NULL').bind(auth.userId, asked.client.clientId, now),
    env.DB.prepare('INSERT INTO oauth_grants (id, client_id, user_id, key_id, key_enc, created_at) VALUES (?1, ?2, ?3, ?4, \'\', ?5)').bind(grantId, asked.client.clientId, auth.userId, keyId, now),
    env.DB.prepare('INSERT INTO oauth_codes (code_hash, client_id, grant_id, redirect_uri, code_challenge, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(await hashSecret(code), asked.client.clientId, grantId, asked.redirectUri, asked.challenge, now + CODE_TTL),
  ]);

  const target = new URL(asked.redirectUri);
  target.searchParams.set('code', code);
  if (asked.state) target.searchParams.set('state', asked.state);
  return json({ ok: true, redirect: target.toString() });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET, POST');
