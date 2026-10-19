/**
 * The channels a video can be announced in.   GET /api/video/announce   → { ok, channels: [{ id, platform, name, isActive, createdAt }] }
 *
 * These are the user's Vane Post channels (one account, one set of channels). Credentials are never part of the answer.
 * Connecting or removing a channel happens in Vane Post. See ../lib/videoannounce.ts.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { methodNotAllowed } from '../lib/http';
import { listAnnounceChannels } from '../lib/videoannounce';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  return listAnnounceChannels(env, auth.userId);
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
