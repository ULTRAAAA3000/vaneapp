/**
 * Webhook channel: every post scheduled to this channel is sent as JSON to an address the person gave (their own server, Make,
 * Zapier, n8n …). Not to be confused with the post webhooks of the API (lib/webhooks.ts: events about posts); this one IS a place
 * where a post is published, so it shows in the calendar, counts as a post and is retried like one.
 *
 *   validateWebhookEndpoint(input)         the pasted address → checked with netsafe.ts, a signing secret made, one test call sent
 *   sendWebhookPost(creds, post)           POST <url>; any 2xx is "published"; an `url` (https) in a JSON answer becomes the post's link
 *   loadWebhookCreds(encrypted, key)
 *
 *   POST  <url>   Content-Type: application/json
 *   Vane-Event: post.publish                            (channel.test for the check made when the channel is connected)
 *   Vane-Delivery: <post id>                            same id on every retry: de-duplicate on it
 *   Vane-Signature: t=<unix seconds>,v1=<hex>           HMAC-SHA256 of "<t>.<raw body>" with the channel secret (same scheme as lib/webhooks.ts)
 *   {"id":"<post id>","type":"post.publish","createdAt":"…Z","data":{"post":{"id","content","media":[{"url","kind"}],"scheduledAt"},"channel":{"id","name"}}}
 *
 * Security: the address comes from the person, so lib/netsafe.ts decides what may be called (https, port 443, a public host name,
 * never Vane's own hosts), redirects are never followed and an answer is read with a size cap (lib/httpcall.ts). The secret is made by
 * Vane, shown once when the channel is connected, stored encrypted and never logged or returned again.
 */
import { decryptToken } from '../lib/crypto';
import { callJson, shortMessage } from '../lib/httpcall';
import { mediaKindFromUrl } from '../lib/media';
import { newWebhookSecret, signWebhook, validateWebhookUrl } from '../lib/webhooks';

export const WEBHOOK_TEXT_LIMIT = 10_000;
const TIMEOUT_MS = 10_000;

export interface WebhookCreds { url: string; secret: string }
export interface WebhookPost { id: string; content: string; mediaUrl?: string; scheduledAt: number; channelId: string; channelName: string }

type Check =
  | { ok: true; url: string; secret: string }
  | { ok: false; code: 'bad_url' | 'refused' | 'network'; error: string };

/** One signed call. `body` is signed exactly as it is sent, so the receiver can verify the raw text it gets. */
async function call(creds: WebhookCreds, event: string, deliveryId: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);
  return callJson<{ url?: unknown }>(creds.url, {
    method: 'POST',
    body,
    timeoutMs: TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Vane-Webhooks/1',
      'Vane-Event': event,
      'Vane-Delivery': deliveryId,
      'Vane-Signature': await signWebhook(creds.secret, ts, body),
    },
  });
}

/** Proves the address is allowed and answers (a 2xx to a test call), and makes the secret the person puts into their receiver. */
export async function validateWebhookEndpoint(input: unknown, name: string): Promise<Check> {
  const url = validateWebhookUrl(typeof input === 'string' ? input.trim() : input);
  if (!url) return { ok: false, code: 'bad_url', error: 'That address cannot be used. It must start with https://, point to a public website (no IP address or localhost) and use the standard port.' };
  const secret = newWebhookSecret();
  const id = crypto.randomUUID();
  const r = await call({ url, secret }, 'channel.test', id, { id, type: 'channel.test', createdAt: new Date().toISOString(), data: { channel: { name } } });
  if (r.ok) return { ok: true, url, secret };
  if (r.network) return { ok: false, code: 'network', error: 'Could not reach that address. Check it and that your server is online, then try again.' };
  if (r.status >= 300 && r.status < 400) return { ok: false, code: 'refused', error: 'That address redirects somewhere else. Vane does not follow redirects: paste the final address.' };
  return { ok: false, code: 'refused', error: `Your server answered ${r.status} to the test call. It must answer 2xx.` };
}

export async function loadWebhookCreds(encrypted: string, encryptionKey: string | undefined): Promise<WebhookCreds | null> {
  if (!encryptionKey) return null;
  try {
    const p = JSON.parse(await decryptToken(encrypted, encryptionKey));
    const url = validateWebhookUrl(p?.url);   // never call an address that would not pass today's checks
    if (!url || typeof p?.secret !== 'string' || !p.secret) return null;
    return { url, secret: p.secret };
  } catch {
    return null;
  }
}

export type WebhookSendResult =
  | { ok: true; url: string }
  | { ok: false; error: string; retryable: boolean; retryAfter?: number };

/** The link the receiver may answer with ({ "url": "https://…" }); anything else is ignored, so a link in the dashboard is always https. */
function linkFrom(data: { url?: unknown } | null): string {
  if (!data || typeof data.url !== 'string' || data.url.length > 2048) return '';
  try {
    const u = new URL(data.url);
    return u.protocol === 'https:' && !u.username && !u.password ? u.toString() : '';
  } catch {
    return '';
  }
}

/** One post to the person's address: the text, and the picture or video when there is one. */
export async function sendWebhookPost(creds: WebhookCreds, post: WebhookPost): Promise<WebhookSendResult> {
  const url = validateWebhookUrl(creds.url);
  if (!url) return { ok: false, error: 'The saved address is not valid. Reconnect the channel.', retryable: false };
  if (post.content.length > WEBHOOK_TEXT_LIMIT) return { ok: false, error: `Text is too long for a webhook: ${post.content.length}/${WEBHOOK_TEXT_LIMIT} characters.`, retryable: false };
  if (!post.content.trim() && !post.mediaUrl) return { ok: false, error: 'There is nothing to send.', retryable: false };

  const r = await call({ url, secret: creds.secret }, 'post.publish', post.id, {
    id: post.id,
    type: 'post.publish',
    createdAt: new Date().toISOString(),
    data: {
      post: {
        id: post.id,
        content: post.content,
        media: post.mediaUrl ? [{ url: post.mediaUrl, kind: mediaKindFromUrl(post.mediaUrl) }] : [],
        scheduledAt: new Date(post.scheduledAt * 1000).toISOString(),
      },
      channel: { id: post.channelId, name: post.channelName },
    },
  });
  if (r.ok) return { ok: true, url: linkFrom(r.data) };
  if (r.network) return { ok: false, error: 'Could not reach your webhook address.', retryable: true };
  if (r.status === 429 || r.status === 408 || r.status >= 500) {
    return { ok: false, error: `Your server answered ${r.status}.`, retryable: true, retryAfter: r.retryAfter };
  }
  if (r.status >= 300 && r.status < 400) return { ok: false, error: 'Your webhook address redirects somewhere else. Vane does not follow redirects: reconnect the channel with the final address.', retryable: false };
  if (r.status === 410) return { ok: false, error: 'Your server answered 410 Gone. Reconnect the channel with a new address.', retryable: false };
  return { ok: false, error: `Your server refused the post (${r.status}): ${shortMessage(r.data, 'request rejected')}`, retryable: false };
}
