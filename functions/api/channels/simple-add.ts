/**
 * Connecting the networks that need nothing but a pasted address or key: Discord (a channel webhook) and Dev.to (an API key).
 * Called from ./index.ts handleAddChannel. The secret is checked with the network first, then stored encrypted.
 *
 *   discord   credentials { webhookUrl }
 *   devto     credentials { apiKey }
 */
import type { ChannelPublic, ChannelType, Env } from '../../../types';
import { encryptToken } from '../lib/crypto';
import { fail, isRecord, json } from '../lib/http';
import { bump, retryAfter } from '../lib/throttle';
import { checkChannelQuota } from '../lib/catalog';
import { loadDiscordCreds, validateDiscordWebhook } from './discord';
import { loadDevtoCreds, validateDevtoKey } from './devto';

const ADD_ATTEMPTS_PER_HOUR = 10;

async function save(env: Env, userId: string, type: ChannelType, label: string, name: string, blob: Record<string, unknown>): Promise<{ id: string; now: number } | Response> {
  const encrypted = await encryptToken(JSON.stringify(blob), env.ENCRYPTION_KEY!);
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB
      .prepare(`INSERT INTO channels (id, user_id, type, name, credentials, is_active, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)`)
      .bind(id, userId, type, name, encrypted, now)
      .run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    console.error(`${type} channel insert failed`, msg);
    // An older database still has the CHECK that only allows the first networks (see migrations/0002-channel-types-discord-devto.sql).
    if (/CHECK constraint/i.test(msg)) return fail(503, `${label} is not enabled on this server yet. The database needs one update: run migrations/0002-channel-types-discord-devto.sql in the D1 Console.`);
    return fail(500, 'Could not save the channel. Please try again.');
  }
  return { id, now };
}

/** Common start: object check, plan quota, and a limit on how often the secret can be tried. */
async function gate(env: Env, userId: string, kind: string, credentials: unknown, shape: string): Promise<Response | Record<string, unknown>> {
  if (!isRecord(credentials)) return fail(400, `credentials must be an object: ${shape}`);
  const overQuota = await checkChannelQuota(env, userId);
  if (overQuota) return overQuota;
  const key = `${kind}:add:${userId}`;
  const wait = await retryAfter(env, key, ADD_ATTEMPTS_PER_HOUR);
  if (wait) return fail(429, 'Too many attempts. Try again later.', { 'Retry-After': String(wait) });
  await bump(env, key, 3600);
  return credentials;
}

export async function handleAddDiscord(env: Env, userId: string, name: string, credentials: unknown): Promise<Response> {
  const creds = await gate(env, userId, 'discord', credentials, '{ webhookUrl }');
  if (creds instanceof Response) return creds;
  const check = await validateDiscordWebhook(creds.webhookUrl);
  if (!check.ok) return fail(check.code === 'network' || check.code === 'rate_limited' ? 502 : 400, check.error);

  const { results } = await env.DB.prepare(`SELECT name, credentials FROM channels WHERE user_id = ?1 AND type = 'discord' LIMIT 200`).bind(userId).all<{ name: string; credentials: string }>();
  for (const row of results) {
    const c = await loadDiscordCreds(row.credentials, env.ENCRYPTION_KEY);
    if (c && c.webhookId === check.webhookId) return fail(409, `This webhook is already connected as "${row.name}".`);
  }

  const saved = await save(env, userId, 'discord', 'Discord', name, { type: 'discord', webhookUrl: check.url, webhookId: check.webhookId, guildId: check.guildId, channelId: check.channelId });
  if (saved instanceof Response) return saved;
  const channel: ChannelPublic = { id: saved.id, platform: 'discord', name, isActive: true, createdAt: saved.now };
  return json({ ok: true, channel, discord: { webhookName: check.name } }, 201);
}

export async function handleAddDevto(env: Env, userId: string, name: string, credentials: unknown): Promise<Response> {
  const creds = await gate(env, userId, 'devto', credentials, '{ apiKey }');
  if (creds instanceof Response) return creds;
  const check = await validateDevtoKey(creds.apiKey);
  if (!check.ok) return fail(check.code === 'network' || check.code === 'rate_limited' ? 502 : 400, check.error);

  const { results } = await env.DB.prepare(`SELECT name, credentials FROM channels WHERE user_id = ?1 AND type = 'devto' LIMIT 200`).bind(userId).all<{ name: string; credentials: string }>();
  for (const row of results) {
    const c = await loadDevtoCreds(row.credentials, env.ENCRYPTION_KEY);
    if (c && c.userId === check.userId) return fail(409, `This Dev.to account is already connected as "${row.name}".`);
  }

  const saved = await save(env, userId, 'devto', 'Dev.to', name, { type: 'devto', apiKey: check.apiKey, userId: check.userId, username: check.username });
  if (saved instanceof Response) return saved;
  const channel: ChannelPublic = { id: saved.id, platform: 'devto', name, isActive: true, createdAt: saved.now };
  return json({ ok: true, channel, devto: { username: check.username } }, 201);
}
