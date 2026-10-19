/**
 * GET /api/v1/video/me → "is my video key valid, and is the Video Engine on?"  (the call to test a connection)
 *
 * Public Video Engine API: every route under /api/v1/video takes `Authorization: Bearer cvid_live_… | cvid_test_…`.
 * A cpost_ key is refused with 403 wrong_key_scope before the database is touched (and the other way round).
 * Limit: 10 requests a minute per key (SECURITY_ARCHITECTURE.md §2.2). Errors are `{ ok: false, error, code }`.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../types';
import { requireApiKey } from '../../lib/apikeys';
import { json, methodNotAllowed } from '../../lib/http';
import { loadVideoSubscription, VIDEO_ENGINE } from '../../lib/videoplans';
import { PART_SIZE } from '../../lib/videoupload';
import { videoUsage } from '../../lib/videos';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireApiKey(request, env, 'video');
  if (!auth.ok) return auth.response;

  const [sub, usage] = await Promise.all([loadVideoSubscription(env, auth.userId), videoUsage(env, auth.userId)]);
  return json({
    ok: true,
    key: { name: auth.key.name, scope: auth.key.scope, mode: auth.key.mode },
    videoEngine: { active: sub.active, status: sub.status, currentPeriodEnd: sub.currentPeriodEnd },
    limits: { maxVideos: VIDEO_ENGINE.maxVideos, maxFileBytes: VIDEO_ENGINE.maxFileBytes, partSize: PART_SIZE },
    usage: { videos: usage.videos, storageBytes: usage.storageBytes },
  });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
