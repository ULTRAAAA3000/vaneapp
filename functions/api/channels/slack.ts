/**
 * Slack integration (an Incoming Webhook of one channel: no app review, no OAuth).
 *
 *   normalizeSlackWebhook(input)            the pasted address → { id, url }, or null when it is not a Slack webhook
 *   validateSlackWebhook(input)             proves the webhook exists WITHOUT posting: an empty message is answered 400 by a live
 *                                           webhook and 404 by one that was deleted
 *   slackPayload(text, imageUrl)            the JSON body of a message
 *   sendSlackPost(creds, text, imageUrl)
 *   loadSlackCreds(encrypted, key)
 *
 * Security: only https://hooks.slack.com/services/T…/B…/… is ever called. The token inside is a secret (anyone holding it can post to
 * that channel): it is stored encrypted and never logged or returned. & < > are escaped in every message, so a post can never ping
 * <!channel> / <!here> or build a link that hides its address.
 */
import { decryptToken } from '../lib/crypto';
import { callJson, shortMessage } from '../lib/httpcall';

export const SLACK_TEXT_LIMIT = 3000;
const HOOK_RE = /^https:\/\/hooks\.slack\.com\/services\/(T[A-Z0-9]{6,20})\/(B[A-Z0-9]{6,20})\/([A-Za-z0-9]{20,40})$/;

export interface SlackCreds { webhookUrl: string; webhookId: string }

export function normalizeSlackWebhook(input: unknown): { id: string; url: string } | null {
  if (typeof input !== 'string') return null;
  const s = input.trim().split(/[?#]/)[0].replace(/\/+$/, '');
  if (!s || s.length > 200) return null;
  const m = HOOK_RE.exec(s);
  return m ? { id: `${m[1]}/${m[2]}`, url: s } : null;
}

type Check =
  | { ok: true; url: string; webhookId: string }
  | { ok: false; code: 'bad_url' | 'bad_hook' | 'network' | 'rate_limited'; error: string };

export async function validateSlackWebhook(input: unknown): Promise<Check> {
  const hook = normalizeSlackWebhook(input);
  if (!hook) return { ok: false, code: 'bad_url', error: 'That does not look like a Slack webhook address. It starts with https://hooks.slack.com/services/.' };
  const r = await callJson(hook.url, { method: 'POST', json: {}, timeoutMs: 10_000 });
  if (r.ok || r.status === 400) return { ok: true, url: hook.url, webhookId: hook.id };
  if (r.network) return { ok: false, code: 'network', error: 'Could not reach Slack. Try again in a moment.' };
  if (r.status === 429) return { ok: false, code: 'rate_limited', error: 'Slack asked us to slow down. Try again in a minute.' };
  if (r.status === 403 || r.status === 404 || r.status === 410) return { ok: false, code: 'bad_hook', error: 'Slack does not accept this webhook. It may have been deleted or its channel archived: create a new one and paste it here.' };
  return { ok: false, code: 'network', error: 'Slack did not answer as expected. Try again in a moment.' };
}

export async function loadSlackCreds(encrypted: string, encryptionKey: string | undefined): Promise<SlackCreds | null> {
  if (!encryptionKey) return null;
  try {
    const p = JSON.parse(await decryptToken(encrypted, encryptionKey));
    const hook = typeof p?.webhookUrl === 'string' ? normalizeSlackWebhook(p.webhookUrl) : null;
    return hook ? { webhookUrl: hook.url, webhookId: hook.id } : null;
  } catch {
    return null;
  }
}

export const slackEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function slackPayload(text: string, imageUrl?: string): Record<string, unknown> {
  const safe = slackEscape(text);
  if (!imageUrl) return { text: safe, unfurl_links: true };
  return {
    text: safe || 'Image',
    blocks: [
      ...(safe.trim() ? [{ type: 'section', text: { type: 'mrkdwn', text: safe } }] : []),
      { type: 'image', image_url: imageUrl, alt_text: 'Image' },
    ],
  };
}

export type SlackSendResult = { ok: true } | { ok: false; error: string; retryable: boolean; retryAfter?: number };

export async function sendSlackPost(creds: SlackCreds, text: string, imageUrl?: string): Promise<SlackSendResult> {
  const hook = normalizeSlackWebhook(creds.webhookUrl);
  if (!hook) return { ok: false, error: 'The saved Slack address is not valid. Reconnect the channel.', retryable: false };
  if (text.length > SLACK_TEXT_LIMIT) return { ok: false, error: `Text is too long for Slack: ${text.length}/${SLACK_TEXT_LIMIT} characters.`, retryable: false };
  if (!text.trim() && !imageUrl) return { ok: false, error: 'There is nothing to send.', retryable: false };

  const r = await callJson(hook.url, { method: 'POST', json: slackPayload(text, imageUrl), timeoutMs: 15_000 });
  if (r.ok) return { ok: true };
  if (r.network) return { ok: false, error: 'Could not reach Slack.', retryable: true };
  if (r.status === 429) return { ok: false, error: 'Slack is rate limiting this webhook.', retryable: true, retryAfter: r.retryAfter ?? 5 };
  if (r.status >= 500) return { ok: false, error: `Slack had a problem (${r.status}).`, retryable: true };
  if (r.status === 403 || r.status === 404 || r.status === 410) return { ok: false, error: 'The Slack webhook was deleted or its channel archived. Create a new one and reconnect the channel.', retryable: false };
  return { ok: false, error: `Slack refused the message: ${shortMessage(r.data, `error ${r.status}`)}`, retryable: false };
}
