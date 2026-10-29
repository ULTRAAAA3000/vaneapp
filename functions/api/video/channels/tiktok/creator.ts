import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../../types';
import { requireUser } from '../../../lib/auth';
import { fail, json, methodNotAllowed } from '../../../lib/http';
import { requireVideoAccess } from '../../../lib/videoplans';
import { bump, retryAfter } from '../../../lib/throttle';
import { tiktokCreatorInfo } from '../../../lib/tiktok';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const denied = await requireVideoAccess(env, auth.userId);
  if (denied) return denied;
  const id = new URL(request.url).searchParams.get('channel') ?? '';
  if (!/^[0-9a-f-]{36}$/.test(id)) return fail(400, 'channel must be a channel id');
  const key = `ttcreator:${auth.userId}`;
  if (await retryAfter(env, key, 60)) return fail(429, 'Too many requests. Try again in a minute.');
  await bump(env, key, 600);
  const ch = await env.DB.prepare(`SELECT id, credentials FROM video_channels WHERE id = ?1 AND user_id = ?2 AND platform = 'tiktok'`).bind(id, auth.userId).first<{ id: string; credentials: string }>();
  if (!ch) return fail(404, 'Channel not found');
  const r = await tiktokCreatorInfo(env, ch);
  if (!r.ok) return json({ ok: false, error: r.error }, 502);
  return json({ ok: true, creator: r.info });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
