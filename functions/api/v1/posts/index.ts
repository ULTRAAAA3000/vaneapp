/**
 * Public API: posts.
 *
 *   GET  /api/v1/posts?view=upcoming|history   list (read-only, not metered)
 *   POST /api/v1/posts                         schedule a post (metered)
 *
 * POST body is the same as the dashboard's:
 *   { "content": "Hello", "mediaUrl": "https://…/a.jpg", "channelIds": ["<uuid>"], "scheduledAt": "2026-10-20T09:00:00Z" }
 *
 * What a key does:
 *   cpost_live_…  the post is saved and counted against the plan's API quota (1 request = 1 post, whatever the number of channels)
 *   cpost_test_…  the request is VALIDATED exactly like a live one and answered like one ("test": true),
 *                 but nothing is saved, nothing is posted and nothing is counted
 *
 * Out of quota:  402 { code: "quota_exceeded" }  (or, when the account enabled overage billing, the post goes through and is priced)
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../types';
import { requireApiKey } from '../../lib/apikeys';
import { fail, failCode, json, methodNotAllowed, readJson } from '../../lib/http';
import { postUnits } from '../../lib/plans';
import { insertPostGroup, validateCreatePost } from '../../posts/create';
import { listPostsForUser } from '../../posts/list';
import { quotaHeaders, releaseApiPost, reserveApiPost, usageLogStatement, usageSummary } from '../../lib/usage';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireApiKey(request, env, 'post');
  if (!auth.ok) return auth.response;
  return listPostsForUser(env, auth.userId, new URL(request.url).searchParams.get('view') ?? 'upcoming');
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireApiKey(request, env, 'post');
  if (!auth.ok) return auth.response;

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  // Real validation for every key, test keys included: a bad request fails the same way in test and in live.
  const checked = await validateCreatePost(env, auth.userId, parsed.data);
  if (!checked.ok) return checked.response;
  const v = checked.v;
  const units = postUnits(v.channels.length);

  // ── test key: answer like a live key would, change nothing
  if (auth.key.mode === 'test') {
    const usage = await usageSummary(env, auth.userId, auth.sub, v.now);
    return json(
      {
        ok: true,
        test: true,
        groupId: crypto.randomUUID(),
        scheduledAt: v.scheduledAt,
        posts: v.channels.map((ch) => ({ id: crypto.randomUUID(), channelId: ch.id, status: 'scheduled' as const })),
        usage: { api: usage.api, resetsAt: usage.period.resetsAt },
      },
      201,
      { 'X-Vane-Mode': 'test', ...quotaHeaders(usage) },
    );
  }

  // ── live key: take the quota first, so two parallel requests can't both use the last unit
  const reservation = await reserveApiPost(env, auth.userId, auth.sub, v.now, units);
  if (!reservation.ok) {
    if (reservation.code === 'api_not_in_plan') {
      return failCode(403, 'api_not_in_plan', 'Your plan does not include API access. Add the API Add-on, or use a test key.');
    }
    const usage = await usageSummary(env, auth.userId, auth.sub, v.now);
    const message = auth.sub.plan === 'free'
      ? `You have used all ${usage.api.limit} posts of the Free Trial. Choose a plan to keep posting.`
      : `You have used all ${usage.api.limit} API posts of this period.` + (usage.period.resetsAt ? ' The quota resets on the 1st (UTC).' : '');
    return failCode(402, 'quota_exceeded', message, { usage: { api: usage.api, resetsAt: usage.period.resetsAt, overage: usage.overage } }, quotaHeaders(usage));
  }

  const saved = await insertPostGroup(env, auth.userId, v, (groupId) => [
    usageLogStatement(env, {
      userId: auth.userId, keyId: auth.key.id, units, overage: reservation.overage, costMicro: reservation.costMicro, ref: groupId, now: v.now,
    }),
  ]);
  if (!saved.ok) {
    await releaseApiPost(env, auth.userId, reservation, units);
    return fail(500, 'Could not schedule the post. Please try again.');
  }

  const usage = await usageSummary(env, auth.userId, auth.sub, v.now);
  return json(
    {
      ok: true,
      groupId: saved.groupId,
      scheduledAt: v.scheduledAt,
      posts: saved.posts,
      overage: reservation.overage,
      usage: { api: usage.api, resetsAt: usage.period.resetsAt },
    },
    201,
    quotaHeaders(usage),
  );
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET, POST');
