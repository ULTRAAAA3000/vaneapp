/**
 * GET /api/library/usage → { ok, usage: { usedBytes, count, limitBytes, upgrade } }
 *
 * The same numbers GET /api/library/assets carries, without the list: what the editor's upload box and the library dialog show as
 * "12.4 MB of 100 MB used · 9 files". `limitBytes` is null when the plan has no storage limit or limits are not being enforced (there is
 * no maximum to show then); `upgrade` is true on the Free Trial. Until schema.sql has been applied the answer is 503.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { fail, json, methodNotAllowed } from '../lib/http';
import { libraryUsage } from '../lib/library';
import { isMissingTable } from '../lib/socials';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  try {
    return json({ ok: true, usage: await libraryUsage(env, auth.userId) });
  } catch (err) {
    if (isMissingTable(err)) return fail(503, 'The library is not set up yet.');
    throw err;
  }
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
