/**
 * Dev.to integration (an API key from dev.to/settings/extensions: no app, no review).
 *
 *   validateDevtoKey(key)                   GET /api/users/me: proves the key works and tells whose it is
 *   articleFromPost(text, imageUrl)         a post → { title, body, tags }: the first line is the title, #tags become tags
 *   sendDevtoPost(creds, text, imageUrl)    POST /api/articles (published at once)
 *   loadDevtoCreds(encrypted, key)
 *
 * The key is stored encrypted and only ever sent to dev.to. A key can do everything the account can (publish, edit, delete
 * articles), so the connect dialog tells the person to create one named "Vane" and delete it to disconnect.
 */
import { decryptToken } from '../lib/crypto';
import { callJson, shortMessage } from '../lib/httpcall';

export const DEVTO_API = 'https://dev.to/api';
export const DEVTO_TEXT_LIMIT = 10_000;
const TITLE_MAX = 120;
const KEY_RE = /^[A-Za-z0-9_-]{16,80}$/;

export interface DevtoCreds { apiKey: string; userId: number; username: string }

export const cleanKey = (v: unknown): string => (typeof v === 'string' ? v.trim().replace(/^["']|["']$/g, '') : '');

type Check =
  | { ok: true; apiKey: string; userId: number; username: string; name: string }
  | { ok: false; code: 'bad_key' | 'network' | 'rate_limited'; error: string };

export async function validateDevtoKey(input: unknown): Promise<Check> {
  const apiKey = cleanKey(input);
  if (!KEY_RE.test(apiKey)) return { ok: false, code: 'bad_key', error: 'That does not look like a Dev.to API key. Create one at dev.to/settings/extensions → "Generate API Key" and paste it whole.' };
  const r = await callJson<{ id?: number; username?: string; name?: string }>(`${DEVTO_API}/users/me`, { headers: { 'api-key': apiKey, Accept: 'application/vnd.forem.api-v1+json' }, timeoutMs: 10_000 });
  if (!r.ok) {
    if (r.network) return { ok: false, code: 'network', error: 'Could not reach Dev.to. Try again in a moment.' };
    if (r.status === 429) return { ok: false, code: 'rate_limited', error: 'Dev.to asked us to slow down. Try again in a minute.' };
    if (r.status === 401 || r.status === 403) return { ok: false, code: 'bad_key', error: 'Dev.to does not accept this key. Check that you copied all of it, or generate a new one.' };
    return { ok: false, code: 'network', error: 'Dev.to did not answer as expected. Try again in a moment.' };
  }
  const d = r.data;
  if (!d || typeof d.id !== 'number' || typeof d.username !== 'string') return { ok: false, code: 'bad_key', error: 'Dev.to did not say whose key this is.' };
  return { ok: true, apiKey, userId: d.id, username: d.username, name: typeof d.name === 'string' && d.name ? d.name.slice(0, 80) : d.username };
}

export async function loadDevtoCreds(encrypted: string, encryptionKey: string | undefined): Promise<DevtoCreds | null> {
  if (!encryptionKey) return null;
  try {
    const p = JSON.parse(await decryptToken(encrypted, encryptionKey));
    if (typeof p?.apiKey !== 'string' || !KEY_RE.test(p.apiKey) || typeof p?.userId !== 'number') return null;
    return { apiKey: p.apiKey, userId: p.userId, username: String(p.username ?? '') };
  } catch {
    return null;
  }
}

/** The first line is the title (Markdown "#" and surrounding quotes dropped, cut at a word); everything is the body, #tags become tags (at most 4: Dev.to's limit). */
export function articleFromPost(text: string, imageUrl?: string): { title: string; body: string; tags: string[] } {
  const lines = text.replace(/\r\n/g, '\n').trim().split('\n');
  const first = (lines.find((l) => l.trim()) ?? '').replace(/^#{1,6}\s+/, '').replace(/^["“«]|["”»]$/g, '').trim();
  let title = first;
  if (title.length > TITLE_MAX) {
    const cut = title.slice(0, TITLE_MAX - 1);
    title = cut.slice(0, Math.max(cut.lastIndexOf(' '), 40)).trimEnd() + '…';
  }
  const tags: string[] = [];
  for (const m of text.matchAll(/(?:^|\s)#([A-Za-z][A-Za-z0-9]{1,29})\b/g)) {
    const t = m[1].toLowerCase();
    if (!tags.includes(t)) tags.push(t);
    if (tags.length === 4) break;
  }
  const body = (imageUrl ? `![](${imageUrl})\n\n` : '') + text.trim();
  return { title, body, tags };
}

export type DevtoSendResult =
  | { ok: true; id: string; url: string }
  | { ok: false; error: string; retryable: boolean; retryAfter?: number };

export async function sendDevtoPost(creds: DevtoCreds, text: string, imageUrl?: string): Promise<DevtoSendResult> {
  const { title, body, tags } = articleFromPost(text, imageUrl);
  if (!title) return { ok: false, error: 'A Dev.to post needs text: its first line becomes the title.', retryable: false };
  const r = await callJson<{ id?: number; url?: string; error?: string }>(`${DEVTO_API}/articles`, {
    method: 'POST',
    headers: { 'api-key': creds.apiKey, Accept: 'application/vnd.forem.api-v1+json' },
    json: { article: { title, body_markdown: body, published: true, tags } },
    timeoutMs: 20_000,
  });
  if (r.ok) {
    const id = r.data?.id, url = r.data?.url;
    if (typeof id !== 'number' || typeof url !== 'string') return { ok: false, error: 'Dev.to accepted the article but did not return its address.', retryable: false };
    return { ok: true, id: String(id), url };
  }
  if (r.network) return { ok: false, error: 'Could not reach Dev.to.', retryable: true };
  if (r.status === 429) return { ok: false, error: 'Dev.to is rate limiting this account.', retryable: true, retryAfter: r.retryAfter ?? 30 };
  if (r.status >= 500) return { ok: false, error: `Dev.to had a problem (${r.status}).`, retryable: true };
  if (r.status === 401 || r.status === 403) return { ok: false, error: 'Dev.to no longer accepts the saved key. Reconnect the account with a new key.', retryable: false };
  return { ok: false, error: `Dev.to refused the article: ${shortMessage(r.data, 'request rejected')}`, retryable: false };
}
