import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../types';
import { requireUser } from './lib/auth';
import { fail, isRecord, json, methodNotAllowed, readJson } from './lib/http';
import { deleteDraft, DRAFTS_MAX, listDrafts, saveDraft, type DraftMedia } from './lib/postdrafts';
import { CONTENT_LIMIT } from './posts/create';

const MAX_CONTENT = Math.max(...Object.values(CONTENT_LIMIT)) + 200;
const UUID = /^[0-9a-f-]{36}$/i;

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  try {
    return json({ ok: true, max: DRAFTS_MAX, items: await listDrafts(env, auth.userId) });
  } catch {
    return json({ ok: true, max: DRAFTS_MAX, items: [] });
  }
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const parsed = await readJson(request, 8192);
  if (!parsed.ok) return parsed.response;
  const b = parsed.data;
  if (!isRecord(b)) return fail(400, 'Body must be a JSON object.');

  if (b.action === 'delete') {
    if (typeof b.id !== 'string' || !UUID.test(b.id)) return fail(400, 'id is invalid.');
    return (await deleteDraft(env, auth.userId, b.id)) ? json({ ok: true }) : fail(404, 'Not found.');
  }

  const content = typeof b.content === 'string' ? b.content.slice(0, MAX_CONTENT) : '';
  const channelIds = Array.isArray(b.channelIds) ? b.channelIds.filter((x): x is string => typeof x === 'string' && UUID.test(x)).slice(0, 50) : [];
  let media: DraftMedia | null = null;
  if (isRecord(b.media) && typeof b.media.url === 'string' && b.media.url.length < 1000 && /^(https:\/\/|\/)/.test(b.media.url) && (b.media.kind === 'image' || b.media.kind === 'video')) {
    media = { url: b.media.url, kind: b.media.kind, name: typeof b.media.name === 'string' ? b.media.name.slice(0, 120) : 'file' };
  }
  if (!content.trim() && !media) return fail(400, 'Write something first.');
  const id = typeof b.id === 'string' && UUID.test(b.id) ? b.id : null;
  const saved = await saveDraft(env, auth.userId, id, content, channelIds, media);
  return json({ ok: true, id: saved }, 201);
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET, POST');
