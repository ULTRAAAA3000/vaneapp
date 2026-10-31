/**
 * Talking to the Vane API: GET /api/v1/channels and POST /api/v1/posts. No Obsidian API in here, the request function is handed in,
 * so everything is tested in scripts/obsidian-unit.mjs.
 */
export interface Channel { id: string; platform: string; name: string; isActive: boolean }

export interface HttpRequest { url: string; method: 'GET' | 'POST'; headers: Record<string, string>; body?: string }
export interface HttpResponse { status: number; json: unknown }
export type Http = (req: HttpRequest) => Promise<HttpResponse>;

export class VaneError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null = null) { super(message); this.name = 'VaneError'; }
}

export const DEFAULT_BASE = 'https://vaneapp.dev';

/** The address of the site without a trailing slash; only https (or http on the person's own machine). Returns null when it is not usable. */
export function cleanBase(raw: string): string | null {
  const t = raw.trim().replace(/\/+$/, '');
  let u: URL;
  try { u = new URL(t); } catch { return null; }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  if (u.username || u.password || u.search || u.hash) return null;
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

/** What is wrong with the key as typed, or null. A test key (cpost_test_…) is fine: it checks everything and posts nothing. */
export function keyProblem(key: string): string | null {
  const k = key.trim();
  if (!k) return 'Paste your Vane API key in the plugin settings first.';
  if (!/^cpost_(live|test)_[A-Za-z0-9_-]{8,}$/.test(k)) return 'That does not look like a Vane Post API key (it starts with cpost_live_ or cpost_test_).';
  return null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function fail(res: HttpResponse): VaneError {
  const body = isRecord(res.json) ? res.json : {};
  const text = typeof body.error === 'string' ? body.error : '';
  const code = typeof body.code === 'string' ? body.code : null;
  if (res.status === 401) return new VaneError('Vane did not accept the API key. Check it in the plugin settings (it may have been revoked).', 401, code);
  if (res.status === 402 || code === 'quota_exceeded') return new VaneError(text || 'Your plan has no API posts left this month.', 402, code ?? 'quota_exceeded');
  if (res.status === 429) return new VaneError('Too many requests. Wait a minute and try again.', 429, code);
  return new VaneError(text || `Vane answered with an error (${res.status}).`, res.status, code);
}

const headers = (key: string): Record<string, string> => ({ Authorization: `Bearer ${key.trim()}`, 'Content-Type': 'application/json' });

export async function listChannels(http: Http, base: string, key: string): Promise<Channel[]> {
  const res = await http({ url: `${base}/api/v1/channels`, method: 'GET', headers: headers(key) });
  if (res.status !== 200 || !isRecord(res.json) || !Array.isArray(res.json.channels)) throw fail(res);
  return res.json.channels
    .filter(isRecord)
    .filter((c) => typeof c.id === 'string' && typeof c.platform === 'string')
    .map((c) => ({ id: c.id as string, platform: c.platform as string, name: typeof c.name === 'string' ? c.name : (c.platform as string), isActive: c.isActive !== false }));
}

export interface Scheduled { groupId: string; scheduledAt: number; channels: number; test: boolean }

export async function createPost(http: Http, base: string, key: string, post: { content: string; channelIds: string[]; scheduledAt: string }, idempotencyKey: string): Promise<Scheduled> {
  const res = await http({
    url: `${base}/api/v1/posts`, method: 'POST',
    headers: { ...headers(key), 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ content: post.content, channelIds: post.channelIds, scheduledAt: post.scheduledAt }),
  });
  if ((res.status !== 201 && res.status !== 200) || !isRecord(res.json) || res.json.ok !== true) throw fail(res);
  const j = res.json;
  return {
    groupId: typeof j.groupId === 'string' ? j.groupId : '',
    scheduledAt: typeof j.scheduledAt === 'number' ? j.scheduledAt : 0,
    channels: Array.isArray(j.posts) ? j.posts.length : post.channelIds.length,
    test: j.test === true,
  };
}

/** The API only takes a time in the future, so "as soon as possible" means about a minute and a half from now. */
export const SOON_SECONDS = 90;

/** Turns what the person picked into the ISO time the API wants. `local` is the value of a datetime-local input ("2026-11-02T09:30"). */
export function whenToIso(mode: 'soon' | 'at', local: string, nowMs: number): { iso: string } | { error: string } {
  if (mode === 'soon') return { iso: new Date(nowMs + SOON_SECONDS * 1000).toISOString() };
  const at = new Date(local);                         // read as the person's own local time
  if (!local || Number.isNaN(at.getTime())) return { error: 'Pick the date and time to post at.' };
  if (at.getTime() <= nowMs + 60_000) return { error: 'Pick a time at least a minute from now.' };
  if (at.getTime() > nowMs + 365 * 86_400_000) return { error: 'Vane schedules at most one year ahead.' };
  return { iso: at.toISOString() };
}
