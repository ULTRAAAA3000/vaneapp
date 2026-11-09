/**
 * Hashnode integration (a personal access token from hashnode.com/settings/developer: no app, no review).
 *
 *   validateHashnodeKey(key, blog?)         asks who the token belongs to and picks the blog (publication) to publish to
 *   articleFromPost(text, imageUrl)         a post → { title, body }: the first line is the title, the rest is the article
 *   sendHashnodePost(creds, text, image)    publishPost (published at once)
 *   loadHashnodeCreds(encrypted, key)
 *
 * The token is stored encrypted and only ever sent to gql.hashnode.com. One channel = one blog: someone with several blogs names the
 * one they want (its address, like myblog.hashnode.dev) and connects the others as further channels.
 */
import { decryptToken } from '../lib/crypto';
import { callJson, shortMessage } from '../lib/httpcall';

export const HASHNODE_API = 'https://gql.hashnode.com';
export const HASHNODE_TEXT_LIMIT = 10_000;
const TITLE_MAX = 150;
const KEY_RE = /^[A-Za-z0-9_-]{16,100}$/;
const ID_RE = /^[a-f0-9]{24}$/;

export interface HashnodeCreds { apiKey: string; publicationId: string; host: string; username: string }

export const cleanKey = (v: unknown): string => (typeof v === 'string' ? v.trim().replace(/^["']|["']$/g, '') : '');

export function hostOf(v: unknown): string {
  if (typeof v !== 'string') return '';
  const s = v.trim().toLowerCase().replace(/^https?:\/\//, '').split(/[/?#]/)[0];
  return /^[a-z0-9]([a-z0-9.-]{0,120}[a-z0-9])?$/.test(s) ? s : '';
}

type Pub = { id: string; title: string; host: string };
type Check =
  | { ok: true; apiKey: string; username: string; publication: Pub }
  | { ok: false; code: 'bad_key' | 'bad_blog' | 'network' | 'rate_limited'; error: string };

const ME = 'query { me { username publications(first: 20) { edges { node { id title url } } } } }';

export async function validateHashnodeKey(input: unknown, blog?: unknown): Promise<Check> {
  const apiKey = cleanKey(input);
  if (!KEY_RE.test(apiKey)) return { ok: false, code: 'bad_key', error: 'That does not look like a Hashnode token. Create one at hashnode.com/settings/developer → "Generate new token" and paste it whole.' };
  const r = await callJson<{ data?: { me?: { username?: string; publications?: { edges?: { node?: { id?: string; title?: string; url?: string } }[] } } }; errors?: unknown[] }>(
    HASHNODE_API, { method: 'POST', headers: { Authorization: apiKey }, json: { query: ME }, timeoutMs: 10_000 });
  if (!r.ok) {
    if (r.network) return { ok: false, code: 'network', error: 'Could not reach Hashnode. Try again in a moment.' };
    if (r.status === 429) return { ok: false, code: 'rate_limited', error: 'Hashnode asked us to slow down. Try again in a minute.' };
    if (r.status === 401 || r.status === 403) return { ok: false, code: 'bad_key', error: 'Hashnode does not accept this token. Check that you copied all of it, or generate a new one.' };
    return { ok: false, code: 'network', error: 'Hashnode did not answer as expected. Try again in a moment.' };
  }
  const me = r.data?.data?.me;
  if (!me || typeof me.username !== 'string') return { ok: false, code: 'bad_key', error: 'Hashnode does not accept this token. Check that you copied all of it, or generate a new one.' };
  const pubs: Pub[] = [];
  for (const e of me.publications?.edges ?? []) {
    const n = e.node;
    const host = hostOf(n?.url);
    if (n && typeof n.id === 'string' && ID_RE.test(n.id) && host) pubs.push({ id: n.id, title: typeof n.title === 'string' ? n.title.slice(0, 80) : host, host });
  }
  if (!pubs.length) return { ok: false, code: 'bad_blog', error: 'This Hashnode account has no blog yet. Create one on Hashnode first.' };
  const wanted = hostOf(blog);
  if (typeof blog === 'string' && blog.trim() && !wanted) return { ok: false, code: 'bad_blog', error: 'That is not a blog address. Use something like myblog.hashnode.dev.' };
  if (wanted) {
    const hit = pubs.find((p) => p.host === wanted);
    return hit ? { ok: true, apiKey, username: me.username, publication: hit } : { ok: false, code: 'bad_blog', error: `This token has no blog at ${wanted}. Your blogs: ${pubs.map((p) => p.host).join(', ')}.` };
  }
  if (pubs.length > 1) return { ok: false, code: 'bad_blog', error: `This account has several blogs. Enter the address of the one to post to: ${pubs.map((p) => p.host).join(', ')}.` };
  return { ok: true, apiKey, username: me.username, publication: pubs[0] };
}

export async function loadHashnodeCreds(encrypted: string, encryptionKey: string | undefined): Promise<HashnodeCreds | null> {
  if (!encryptionKey) return null;
  try {
    const p = JSON.parse(await decryptToken(encrypted, encryptionKey));
    if (typeof p?.apiKey !== 'string' || !KEY_RE.test(p.apiKey) || typeof p?.publicationId !== 'string' || !ID_RE.test(p.publicationId)) return null;
    return { apiKey: p.apiKey, publicationId: p.publicationId, host: String(p.host ?? ''), username: String(p.username ?? '') };
  } catch {
    return null;
  }
}

/** The first line is the title (Markdown "#" and surrounding quotes dropped, cut at a word); the rest is the article. A title alone is also the article. */
export function articleFromPost(text: string): { title: string; body: string } {
  const lines = text.replace(/\r\n/g, '\n').trim().split('\n');
  const at = lines.findIndex((l) => l.trim());
  if (at < 0) return { title: '', body: '' };
  let title = lines[at].replace(/^#{1,6}\s+/, '').replace(/^["“«]|["”»]$/g, '').trim();
  if (title.length > TITLE_MAX) {
    const cut = title.slice(0, TITLE_MAX - 1);
    title = cut.slice(0, Math.max(cut.lastIndexOf(' '), 40)).trimEnd() + '…';
  }
  const rest = lines.slice(at + 1).join('\n').trim();
  return { title, body: rest || title };
}

export type HashnodeSendResult =
  | { ok: true; id: string; url: string }
  | { ok: false; error: string; retryable: boolean; retryAfter?: number };

const PUBLISH = 'mutation Publish($input: PublishPostInput!) { publishPost(input: $input) { post { id url } } }';

export async function sendHashnodePost(creds: HashnodeCreds, text: string, imageUrl?: string): Promise<HashnodeSendResult> {
  const { title, body } = articleFromPost(text);
  if (!title) return { ok: false, error: 'A Hashnode post needs text: its first line becomes the title.', retryable: false };
  const input: Record<string, unknown> = { title, contentMarkdown: body, publicationId: creds.publicationId };
  if (imageUrl) input.coverImageOptions = { coverImageURL: imageUrl };
  const r = await callJson<{ data?: { publishPost?: { post?: { id?: string; url?: string } } }; errors?: { message?: string; extensions?: { code?: string } }[] }>(
    HASHNODE_API, { method: 'POST', headers: { Authorization: creds.apiKey }, json: { query: PUBLISH, variables: { input } }, timeoutMs: 20_000 });
  if (r.ok) {
    const errs = r.data?.errors;
    if (errs?.length) {
      const code = errs[0].extensions?.code ?? '';
      if (code === 'UNAUTHENTICATED' || code === 'FORBIDDEN') return { ok: false, error: 'Hashnode no longer accepts the saved token. Reconnect the blog with a new token.', retryable: false };
      if (code === 'TOO_MANY_REQUESTS') return { ok: false, error: 'Hashnode is rate limiting this account.', retryable: true, retryAfter: 30 };
      return { ok: false, error: `Hashnode refused the article: ${shortMessage(errs[0], 'request rejected')}`, retryable: false };
    }
    const post = r.data?.data?.publishPost?.post;
    if (!post || typeof post.id !== 'string' || typeof post.url !== 'string') return { ok: false, error: 'Hashnode accepted the article but did not return its address.', retryable: false };
    return { ok: true, id: post.id, url: post.url };
  }
  if (r.network) return { ok: false, error: 'Could not reach Hashnode.', retryable: true };
  if (r.status === 429) return { ok: false, error: 'Hashnode is rate limiting this account.', retryable: true, retryAfter: r.retryAfter ?? 30 };
  if (r.status >= 500) return { ok: false, error: `Hashnode had a problem (${r.status}).`, retryable: true };
  if (r.status === 401 || r.status === 403) return { ok: false, error: 'Hashnode no longer accepts the saved token. Reconnect the blog with a new token.', retryable: false };
  return { ok: false, error: `Hashnode refused the article: ${shortMessage(r.data, 'request rejected')}`, retryable: false };
}
