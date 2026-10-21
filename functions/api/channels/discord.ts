/**
 * Discord integration (a channel's Webhook: no app, no review, no OAuth).
 *
 *   normalizeWebhookUrl(input)             the pasted address → { id, token, url }, or null when it is not a Discord webhook
 *   validateDiscordWebhook(input)          asks Discord who the webhook belongs to (also proves it still exists)
 *   sendDiscordPost(creds, text, image)    POST <webhook>?wait=true; returns the message link
 *   loadDiscordCreds(encrypted, key)
 *
 * Security: the address comes from the user, so only https://discord.com/api/webhooks/<id>/<token> (or discordapp.com) is accepted:
 * nothing else is ever fetched. The token inside it is a secret (anyone holding it can post to the channel): it is stored
 * encrypted and never logged or returned. @everyone / @here / role pings are switched off for every message (allowed_mentions),
 * so a post can never ping a whole server by accident.
 */
import { decryptToken } from '../lib/crypto';
import { callJson, shortMessage } from '../lib/httpcall';

export const DISCORD_TEXT_LIMIT = 2000;
const HOOK_RE = /^https:\/\/(?:discord|discordapp)\.com\/api(?:\/v\d{1,2})?\/webhooks\/(\d{15,25})\/([A-Za-z0-9_-]{20,120})\/?$/;

export interface DiscordCreds { webhookUrl: string; webhookId: string; guildId: string | null; channelId: string | null }

export function normalizeWebhookUrl(input: unknown): { id: string; token: string; url: string } | null {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s || s.length > 300) return null;
  s = s.split(/[?#]/)[0];
  const m = HOOK_RE.exec(s);
  return m ? { id: m[1], token: m[2], url: `https://discord.com/api/webhooks/${m[1]}/${m[2]}` } : null;
}

type Check =
  | { ok: true; url: string; webhookId: string; name: string; guildId: string | null; channelId: string | null }
  | { ok: false; code: 'bad_url' | 'bad_hook' | 'network' | 'rate_limited'; error: string };

export async function validateDiscordWebhook(input: unknown): Promise<Check> {
  const hook = normalizeWebhookUrl(input);
  if (!hook) return { ok: false, code: 'bad_url', error: 'That does not look like a Discord webhook address. It starts with https://discord.com/api/webhooks/.' };
  const r = await callJson<{ id?: string; name?: string; guild_id?: string; channel_id?: string }>(hook.url, { timeoutMs: 10_000 });
  if (!r.ok) {
    if (r.network) return { ok: false, code: 'network', error: 'Could not reach Discord. Try again in a moment.' };
    if (r.status === 429) return { ok: false, code: 'rate_limited', error: 'Discord asked us to slow down. Try again in a minute.' };
    if (r.status === 401 || r.status === 404) return { ok: false, code: 'bad_hook', error: 'Discord does not know this webhook. It may have been deleted: create a new one and paste it here.' };
    return { ok: false, code: 'network', error: 'Discord did not answer as expected. Try again in a moment.' };
  }
  const d = r.data;
  if (!d || d.id !== hook.id) return { ok: false, code: 'bad_hook', error: 'Discord does not know this webhook.' };
  return { ok: true, url: hook.url, webhookId: hook.id, name: typeof d.name === 'string' ? d.name.slice(0, 80) : 'Discord', guildId: d.guild_id ?? null, channelId: d.channel_id ?? null };
}

export async function loadDiscordCreds(encrypted: string, encryptionKey: string | undefined): Promise<DiscordCreds | null> {
  if (!encryptionKey) return null;
  try {
    const p = JSON.parse(await decryptToken(encrypted, encryptionKey));
    if (typeof p?.webhookUrl !== 'string' || !normalizeWebhookUrl(p.webhookUrl)) return null;   // never call an address that would not pass today's checks
    return { webhookUrl: p.webhookUrl, webhookId: String(p.webhookId ?? ''), guildId: typeof p.guildId === 'string' ? p.guildId : null, channelId: typeof p.channelId === 'string' ? p.channelId : null };
  } catch {
    return null;
  }
}

export type DiscordSendResult =
  | { ok: true; messageId: string; url: string }
  | { ok: false; error: string; retryable: boolean; retryAfter?: number };

/** One message: the text, and a picture (shown under it) when there is one. Discord counts 2000 characters of text. */
export async function sendDiscordPost(creds: DiscordCreds, text: string, imageUrl?: string): Promise<DiscordSendResult> {
  const hook = normalizeWebhookUrl(creds.webhookUrl);
  if (!hook) return { ok: false, error: 'The saved Discord address is not valid. Reconnect the channel.', retryable: false };
  if (text.length > DISCORD_TEXT_LIMIT) return { ok: false, error: `Text is too long for Discord: ${text.length}/${DISCORD_TEXT_LIMIT} characters.`, retryable: false };
  const body: Record<string, unknown> = { content: text, allowed_mentions: { parse: [] } };
  if (imageUrl) body.embeds = [{ image: { url: imageUrl } }];
  if (!text.trim() && !imageUrl) return { ok: false, error: 'There is nothing to send.', retryable: false };

  const r = await callJson<{ id?: string; channel_id?: string; guild_id?: string; retry_after?: number }>(`${hook.url}?wait=true`, { method: 'POST', json: body, timeoutMs: 15_000 });
  if (r.ok) {
    const id = r.data?.id;
    if (typeof id !== 'string' || !/^\d{5,25}$/.test(id)) return { ok: false, error: 'Discord accepted the message but did not return its id.', retryable: false };
    const guild = creds.guildId ?? r.data?.guild_id ?? null;
    const channel = creds.channelId ?? r.data?.channel_id ?? null;
    const url = guild && channel && /^\d+$/.test(guild) && /^\d+$/.test(channel) ? `https://discord.com/channels/${guild}/${channel}/${id}` : '';
    return { ok: true, messageId: id, url: url || id };
  }
  if (r.network) return { ok: false, error: 'Could not reach Discord.', retryable: true };
  if (r.status === 429) {
    const ra = (r.data as { retry_after?: number } | null)?.retry_after;
    return { ok: false, error: 'Discord is rate limiting this channel.', retryable: true, retryAfter: r.retryAfter ?? (typeof ra === 'number' ? Math.ceil(ra) : 5) };
  }
  if (r.status >= 500) return { ok: false, error: `Discord had a problem (${r.status}).`, retryable: true };
  if (r.status === 401 || r.status === 404) return { ok: false, error: 'The Discord webhook was deleted. Create a new one and reconnect the channel.', retryable: false };
  return { ok: false, error: `Discord refused the message: ${shortMessage(r.data, 'request rejected')}`, retryable: false };
}
