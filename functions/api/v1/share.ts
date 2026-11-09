/**
 * Public API: share.   POST /api/v1/share
 *
 * Made for Apple Shortcuts ("Share → Vane" in the iOS / macOS share sheet), but any client can use it. It takes what a share
 * sheet gives (some text, a link) and turns it into a scheduled post. A few minutes of delay by default, so a wrong share can still be cancelled.
 *
 * JSON:        { "text": "…", "url": "https://…", "title": "…", "channels": ["Vane News", "x"], "delayMinutes": 5, "mediaUrl": "https://…/a.jpg" }
 * Plain text:  the body is the text; options go in the query string: ?channels=Vane%20News,x&delay=5&url=https://…
 * Form:        application/x-www-form-urlencoded with the same field names as JSON
 *
 * channels: names, platform names (telegram, x, …) or ids. Left out, it is the person's only channel; with several channels it is
 * refused (400 channel_required) and the answer lists them. scheduledAt (ISO-8601 with timezone) is accepted instead of delayMinutes.
 * Everything else (quota, test keys, Idempotency-Key, text limits) is exactly POST /posts.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { agentLogged } from '../lib/agentlog';
import { requireApiKey } from '../lib/apikeys';
import { fail, failCode, isRecord, methodNotAllowed } from '../lib/http';
import { createWithIdempotency } from './posts/index';

export const SHARE_BODY_MAX = 16_384;
export const DEFAULT_DELAY = 5;

interface Ch { id: string; type: string; name: string | null }

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

async function readFields(request: Request): Promise<{ ok: true; f: Record<string, unknown>; raw: string } | { ok: false; response: Response }> {
  const q = new URL(request.url).searchParams;
  const ct = (request.headers.get('content-type') ?? '').toLowerCase();
  if (Number(request.headers.get('content-length') ?? 0) > SHARE_BODY_MAX) return { ok: false, response: fail(413, 'Request body is too large') };
  let raw: string;
  try { raw = await request.text(); } catch { return { ok: false, response: fail(400, 'Could not read request body') }; }
  if (raw.length > SHARE_BODY_MAX) return { ok: false, response: fail(413, 'Request body is too large') };

  const fromQuery: Record<string, unknown> = {};
  for (const k of ['url', 'title', 'channels', 'delay', 'delayMinutes', 'scheduledAt', 'mediaUrl']) if (q.has(k)) fromQuery[k] = q.get(k);

  if (ct.includes('application/json')) {
    let data: unknown;
    try { data = JSON.parse(raw); } catch { return { ok: false, response: fail(400, 'Invalid JSON body') }; }
    if (!isRecord(data)) return { ok: false, response: fail(400, 'Body must be a JSON object') };
    return { ok: true, f: { ...fromQuery, ...data }, raw };
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    const f: Record<string, unknown> = { ...fromQuery };
    for (const [k, v] of new URLSearchParams(raw)) f[k] = v;
    return { ok: true, f, raw };
  }
  if (ct === '' || ct.includes('text/plain')) return { ok: true, f: { ...fromQuery, text: raw }, raw };
  return { ok: false, response: fail(415, 'Send JSON, form fields or plain text') };
}

function pickChannels(wanted: string[], mine: Ch[]): { ok: true; ids: string[] } | { ok: false; response: Response } {
  const list = mine.map((c) => ({ id: c.id, type: c.type, name: c.name }));
  if (!wanted.length) {
    if (mine.length === 1) return { ok: true, ids: [mine[0].id] };
    return { ok: false, response: failCode(400, 'channel_required', mine.length ? 'You have several channels: say which one with "channels".' : 'Connect a channel in the dashboard first.', { channels: list }) };
  }
  const ids = new Set<string>();
  for (const w of wanted) {
    const key = w.toLowerCase();
    const byId = mine.filter((c) => c.id.toLowerCase() === key);
    const byName = mine.filter((c) => (c.name ?? '').trim().toLowerCase() === key);
    const byType = mine.filter((c) => c.type.toLowerCase() === key);
    const hit = byId.length ? byId : byName.length ? byName : byType;
    if (!hit.length) return { ok: false, response: failCode(404, 'channel_not_found', `No channel called "${w.slice(0, 60)}".`, { channels: list }) };
    if (hit.length > 1 && !byId.length) return { ok: false, response: failCode(400, 'channel_ambiguous', `"${w.slice(0, 60)}" matches ${hit.length} channels: use the exact channel name.`, { channels: list }) };
    ids.add(hit[0].id);
  }
  return { ok: true, ids: [...ids] };
}

export const onRequestPost: PagesFunction<Env> = agentLogged('posts.create', async ({ request, env }) => {
  const auth = await requireApiKey(request, env, 'post');
  if (!auth.ok) return auth.response;

  const read = await readFields(request);
  if (!read.ok) return read.response;
  const f = read.f;

  const text = str(f.text);
  const title = str(f.title);
  const link = str(f.url);
  const parts = [title && !text.includes(title) ? title : '', text, link && !text.includes(link) ? link : ''].filter(Boolean);
  const content = parts.join('\n\n');
  if (!content) return failCode(400, 'empty_share', 'Nothing to post: send "text" and/or "url".');

  const wanted = (Array.isArray(f.channels) ? f.channels : typeof f.channels === 'string' ? f.channels.split(',') : [])
    .map(str).filter(Boolean).slice(0, 20);

  const { results } = await env.DB.prepare('SELECT id, type, name FROM channels WHERE user_id = ?1 AND is_active = 1 ORDER BY created_at, id').bind(auth.userId).all<Ch>();
  const picked = pickChannels(wanted, results);
  if (!picked.ok) return picked.response;

  let scheduledAt: unknown = f.scheduledAt;
  if (scheduledAt === undefined || scheduledAt === null || scheduledAt === '') {
    const raw = f.delayMinutes ?? f.delay;
    const minutes = raw === undefined || raw === null || raw === '' ? DEFAULT_DELAY : Number(raw);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return failCode(400, 'bad_delay', 'delayMinutes must be a whole number from 1 to 1440.');
    scheduledAt = Math.floor(Date.now() / 1000) + minutes * 60;
  }

  const body: Record<string, unknown> = { content, channelIds: picked.ids, scheduledAt };
  if (str(f.mediaUrl)) body.mediaUrl = str(f.mediaUrl);
  return createWithIdempotency(env, request, auth, body, { raw: read.raw, query: new URL(request.url).search });
});

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');
