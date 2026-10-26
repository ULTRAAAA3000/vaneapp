import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../types';
import { requireUser } from './lib/auth';
import { fail, failCode, isRecord, json, methodNotAllowed, readJson } from './lib/http';
import { BODY_MAX, deleteSnippet, listSnippets, saveSnippet, snippetLimit, TITLE_MAX } from './lib/snippets';
import { loadSubscription } from './lib/usage';

const UUID = /^[0-9a-f-]{36}$/i;

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const limit = snippetLimit((await loadSubscription(env, auth.userId)).plan);
  try {
    return json({ ok: true, limit, titleMax: TITLE_MAX, bodyMax: BODY_MAX, items: await listSnippets(env, auth.userId) });
  } catch {
    return json({ ok: true, limit, titleMax: TITLE_MAX, bodyMax: BODY_MAX, items: [] });
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
    return (await deleteSnippet(env, auth.userId, b.id)) ? json({ ok: true }) : fail(404, 'Not found.');
  }

  const title = typeof b.title === 'string' ? b.title.trim() : '';
  const body = typeof b.body === 'string' ? b.body.trim() : '';
  if (!title) return failCode(400, 'title_required', 'Give the snippet a short name.');
  if (!body) return failCode(400, 'body_required', 'The snippet text is empty.');
  if (title.length > TITLE_MAX) return failCode(400, 'title_too_long', `The name can be at most ${TITLE_MAX} characters.`);
  if (body.length > BODY_MAX) return failCode(400, 'body_too_long', `The text can be at most ${BODY_MAX} characters.`);
  const id = typeof b.id === 'string' && UUID.test(b.id) ? b.id : null;

  const limit = snippetLimit((await loadSubscription(env, auth.userId)).plan);
  const r = await saveSnippet(env, auth.userId, id, title, body, limit);
  if (!r.ok) {
    return r.code === 'limit'
      ? failCode(402, 'snippet_limit', limit <= 5 ? `The Free Trial keeps ${limit} snippets. Delete one, or upgrade for up to 100.` : `You can keep up to ${limit} snippets. Delete one first.`)
      : fail(404, 'Not found.');
  }
  return json({ ok: true, id: r.id }, 201);
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET, POST');
