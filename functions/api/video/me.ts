/**
 * GET /api/video/me → what the Video Engine dashboard needs when it opens: is the Video Engine active on this account,
 * what does it include, how full is the library.
 *
 * The Video Engine is its own product with its own dashboard (/video) and its own API (/api/video/*), apart from the
 * posting dashboard (/app, /api/posts, /api/channels). They share the account (the session cookie), nothing else.
 *
 *   → { ok, entitlement: { active, status, lapsed, currentPeriodEnd }, plan: { label, priceUsd },
 *       limits: { maxVideos, maxFileBytes, partSize }, usage: { videos: {limit, used, remaining}, storageBytes },
 *       features: { uploads } }
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { json, methodNotAllowed } from '../lib/http';
import { PART_SIZE } from '../lib/videoupload';
import { loadVideoSubscription, VIDEO_ENGINE } from '../lib/videoplans';
import { videoUsage } from '../lib/videos';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;

  const [sub, usage] = await Promise.all([loadVideoSubscription(env, auth.userId), videoUsage(env, auth.userId)]);
  return json({
    ok: true,
    entitlement: { active: sub.active, status: sub.status, lapsed: sub.lapsed, currentPeriodEnd: sub.currentPeriodEnd },
    plan: { label: VIDEO_ENGINE.label, priceUsd: VIDEO_ENGINE.priceUsd },
    limits: { maxVideos: VIDEO_ENGINE.maxVideos, maxFileBytes: VIDEO_ENGINE.maxFileBytes, partSize: PART_SIZE },
    usage: {
      videos: { limit: VIDEO_ENGINE.maxVideos, used: usage.videos, remaining: Math.max(VIDEO_ENGINE.maxVideos - usage.videos, 0) },
      storageBytes: usage.storageBytes,
    },
    features: { uploads: Boolean(env.MEDIA) },
  });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
