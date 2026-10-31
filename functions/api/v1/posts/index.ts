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
 *
 * Safe retries: send `Idempotency-Key: <unique value>` on POST. A retry with the same key and the same body gets the first
 * answer again (header `Idempotent-Replayed: true`) and takes no second unit of quota; see ../../lib/idempotency.ts.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env, UsageSummary } from '../../../../types';
import { agentLogged } from '../../lib/agentlog';
import { requireApiKey, type ApiKeyContext } from '../../lib/apikeys';
import { fail, failCode, json, methodNotAllowed, readJson } from '../../lib/http';
import { idemBegin, idemCompleteStatement, idemRelease, type IdemClaim } from '../../lib/idempotency';
import { postUnits } from '../../lib/plans';
import { insertPostGroup, validateCreatePost } from '../../posts/create';
import { listPostsForUser } from '../../posts/list';
import { quotaHeaders, releaseApiPost, reserveApiPost, usageLogStatement, usageSummary } from '../../lib/usage';

export const onRequestGet: PagesFunction<Env> = agentLogged('posts.list', async ({ request, env }) => {
  const auth = await requireApiKey(request, env, 'post');
  if (!auth.ok) return auth.response;
  return listPostsForUser(env, auth.userId, new URL(request.url).searchParams.get('view') ?? 'upcoming');
});

/** The 201 answer. For a live key the quota snapshot is taken after the units were reserved, so it is already final. */
const created = (groupId: string, scheduledAt: number, posts: { id: string; channelId: string; status: 'scheduled' }[], overage: boolean, usage: UsageSummary) => ({
  ok: true as const,
  groupId,
  scheduledAt,
  posts,
  overage,
  usage: { api: usage.api, resetsAt: usage.period.resetsAt },
});

async function createPost(env: Env, auth: ApiKeyContext, data: unknown, claim: IdemClaim | null): Promise<Response> {
  // Real validation for every key, test keys included: a bad request fails the same way in test and in live.
  const checked = await validateCreatePost(env, auth.userId, data);
  if (!checked.ok) return checked.response;
  const v = checked.v;
  const units = postUnits(v.channels.length);

  // ── test key: answer like a live key would, change nothing
  if (auth.key.mode === 'test') {
    const usage = await usageSummary(env, auth.userId, auth.sub, v.now);
    const body = {
      ...created(
        crypto.randomUUID(), v.scheduledAt,
        v.channels.map((ch) => ({ id: crypto.randomUUID(), channelId: ch.id, status: 'scheduled' as const })),
        false, usage,
      ),
      test: true,
    };
    if (claim) await idemCompleteStatement(env, claim, 201, JSON.stringify(body)).run();
    return json(body, 201, { 'X-Vane-Mode': 'test', ...quotaHeaders(usage) });
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

  const usage = await usageSummary(env, auth.userId, auth.sub, v.now);
  const saved = await insertPostGroup(env, auth.userId, v, (groupId, posts) => [
    usageLogStatement(env, {
      userId: auth.userId, keyId: auth.key.id, units, overage: reservation.overage, costMicro: reservation.costMicro, ref: groupId, now: v.now,
    }),
    // The stored answer is written in the SAME batch as the posts: no moment where the post exists and the key does not know.
    ...(claim ? [idemCompleteStatement(env, claim, 201, JSON.stringify(created(groupId, v.scheduledAt, posts, reservation.overage, usage)))] : []),
  ]);
  if (!saved.ok) {
    await releaseApiPost(env, auth.userId, reservation, units);
    return fail(500, 'Could not schedule the post. Please try again.');
  }
  return json(created(saved.groupId, v.scheduledAt, saved.posts, reservation.overage, usage), 201, quotaHeaders(usage));
}

export const onRequestPost: PagesFunction<Env> = agentLogged('posts.create', async ({ request, env }) => {
  const auth = await requireApiKey(request, env, 'post');
  if (!auth.ok) return auth.response;

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  const now = Math.floor(Date.now() / 1000);
  const idem = await idemBegin(env, request, auth.userId, auth.key.mode, parsed.data, now);
  if (idem.kind === 'refuse') return idem.response;

  if (idem.kind === 'replay') {
    // Same answer as the first time (nothing is created, no quota is taken); only the quota headers are current.
    const usage = await usageSummary(env, auth.userId, auth.sub, now);
    return new Response(idem.body, {
      status: idem.status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Idempotent-Replayed': 'true',
        ...(auth.key.mode === 'test' ? { 'X-Vane-Mode': 'test' } : {}),
        ...quotaHeaders(usage),
      },
    });
  }

  const claim = idem.kind === 'claimed' ? idem.claim : null;
  const res = await createPost(env, auth, parsed.data, claim);
  // Only a success is remembered (it was stored together with the post). Anything else frees the key for the retry.
  if (claim && res.status !== 201) await idemRelease(env, claim);
  return res;
});

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET, POST');
