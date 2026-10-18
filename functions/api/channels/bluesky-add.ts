/**
 * Connecting a Bluesky account (called from ./index.ts handleAddChannel once the platform is "bluesky").
 *
 *   credentials { identifier, appPassword }   handle like alice.bsky.social + an App Password
 *
 * The app password is checked against Bluesky first, then stored encrypted. Only the account's DID
 * (its permanent id) is kept beside it, so a renamed handle keeps working.
 */
import type { ChannelPublic, Env } from '../../../types';
import { encryptToken } from '../lib/crypto';
import { fail, isRecord, json } from '../lib/http';
import { bump, retryAfter } from '../lib/throttle';
import { findDuplicateBlueskyChannel, BLUESKY_SERVICE, validateBlueskyAccount } from './bluesky';

const ADD_ATTEMPTS_PER_HOUR = 10;

export async function handleAddBluesky(env: Env, userId: string, name: string, credentials: unknown): Promise<Response> {
  if (!isRecord(credentials)) return fail(400, 'credentials must be an object: { identifier, appPassword }');

  // Every attempt is a real sign-in at Bluesky: don't let this become a password-guessing tool.
  const key = `bsky:add:${userId}`;
  const wait = await retryAfter(env, key, ADD_ATTEMPTS_PER_HOUR);
  if (wait) return fail(429, 'Too many attempts. Try again later.', { 'Retry-After': String(wait) });
  await bump(env, key, 3600);

  const check = await validateBlueskyAccount(credentials.identifier, credentials.appPassword);
  if (!check.ok) return fail(check.code === 'network' || check.code === 'rate_limited' ? 502 : 400, check.error);

  const dup = await findDuplicateBlueskyChannel(env.DB, env.ENCRYPTION_KEY, userId, check.did);
  if (dup) return fail(409, `This account is already connected as "${dup}".`);

  const appPassword = (credentials.appPassword as string).trim();
  const blob = { type: 'bluesky', service: BLUESKY_SERVICE, identifier: check.handle, did: check.did, appPassword };
  const encrypted = await encryptToken(JSON.stringify(blob), env.ENCRYPTION_KEY!);
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB
      .prepare(`INSERT INTO channels (id, user_id, type, name, credentials, is_active, created_at, updated_at) VALUES (?1, ?2, 'bluesky', ?3, ?4, 1, ?5, ?5)`)
      .bind(id, userId, name, encrypted, now)
      .run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    console.error('bluesky channel insert failed', msg);
    // An older database still has the CHECK that only allows the first networks (see migrations/).
    if (/CHECK constraint/i.test(msg)) return fail(503, 'Bluesky is not enabled on this server yet. The database needs one update: npm run db:migrate:networks.');
    return fail(500, 'Could not save the channel. Please try again.');
  }

  const channel: ChannelPublic = { id, platform: 'bluesky', name, isActive: true, createdAt: now };
  return json({ ok: true, channel, bluesky: { handle: check.handle } }, 201);
}
