/**
 * GET /api/library/assets?kind=image|video&q=<name>&cursor=<from nextCursor>
 *   → { ok, assets: [{ id, key, url, kind, name, size, width, height, contentType, createdAt, inUse }], nextCursor, usage }
 *
 * The files a person uploaded for their posts, newest first, 60 per page. `usage` is { usedBytes, count, limitBytes }; `limitBytes` is null
 * when the plan has no storage limit or limits are not being enforced. Until schema.sql has been applied the answer is 503.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../types';
import { requireUser } from '../../lib/auth';
import { fail, json, methodNotAllowed } from '../../lib/http';
import { listAssets, storageLimit, storageUsage } from '../../lib/library';
import { isMissingTable } from '../../lib/socials';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const url = new URL(request.url);
  const kindParam = url.searchParams.get('kind');
  try {
    const [page, usage, limit] = await Promise.all([
      listAssets(env, auth.userId, {
        kind: kindParam === 'image' || kindParam === 'video' ? kindParam : undefined,
        q: url.searchParams.get('q') ?? '',
        cursor: url.searchParams.get('cursor'),
        origin: url.origin,
      }),
      storageUsage(env, auth.userId),
      storageLimit(env, auth.userId),
    ]);
    return json({ ok: true, assets: page.assets, nextCursor: page.nextCursor, usage: { usedBytes: usage.usedBytes, count: usage.count, limitBytes: limit.bytes } });
  } catch (err) {
    if (isMissingTable(err)) return fail(503, 'The library is not set up yet.');
    throw err;
  }
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
