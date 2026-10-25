import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { fail, failCode, isRecord, json, methodNotAllowed, readJson } from '../lib/http';
import { deleteHistory, HISTORY_MAX, HISTORY_MAX_PINNED, listHistory, setPinned } from '../lib/aihistory';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  try {
    return json({ ok: true, max: HISTORY_MAX, maxPinned: HISTORY_MAX_PINNED, items: await listHistory(env, auth.userId) });
  } catch {
    return json({ ok: true, max: HISTORY_MAX, maxPinned: HISTORY_MAX_PINNED, items: [] });
  }
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const parsed = await readJson(request, 2048);
  if (!parsed.ok) return parsed.response;
  const b = parsed.data;
  if (!isRecord(b) || typeof b.id !== 'string' || b.id.length > 64) return fail(400, 'id is required.');
  if (b.action === 'delete') {
    return (await deleteHistory(env, auth.userId, b.id)) ? json({ ok: true }) : fail(404, 'Not found.');
  }
  if (b.action === 'pin' || b.action === 'unpin') {
    const r = await setPinned(env, auth.userId, b.id, b.action === 'pin');
    if (r === 'limit') return failCode(409, 'pin_limit', `You can pin up to ${HISTORY_MAX_PINNED} answers. Unpin one first.`);
    return r === 'ok' ? json({ ok: true }) : fail(404, 'Not found.');
  }
  return fail(400, 'action must be pin, unpin or delete.');
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET, POST');
