/**
 * DELETE /api/library/assets/:id — removes a file from the Library and from storage.
 *
 * Refused (409) while a post that has not been sent yet still points at the file: the worker downloads it when the post goes out.
 * Posts that were already sent are not affected (the networks have their own copy), only their preview in the Posts list stops showing it.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../types';
import { requireUser } from '../../lib/auth';
import { fail, json, methodNotAllowed } from '../../lib/http';
import { getAsset, referencedKeys } from '../../lib/library';
import { isMissingTable } from '../../lib/socials';

export const onRequestDelete: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  if (!env.MEDIA) return fail(503, 'Media storage is not enabled on this server yet.');

  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) return fail(404, 'File not found.');
  try {
    const asset = await getAsset(env, auth.userId, id);
    if (!asset) return fail(404, 'File not found.');
    if ((await referencedKeys(env, auth.userId)).has(asset.r2_key)) {
      return fail(409, 'This file is attached to a post that has not been sent yet. Remove it from that post, or wait until the post is sent.');
    }
    await env.MEDIA.delete(asset.thumb_key ? [asset.r2_key, asset.thumb_key] : asset.r2_key);   // storage first: if it throws, the row stays and nothing is lost
    await env.DB.prepare('DELETE FROM media_assets WHERE id = ?1 AND user_id = ?2').bind(id, auth.userId).run();
    return json({ ok: true });
  } catch (err) {
    if (isMissingTable(err)) return fail(404, 'File not found.');
    throw err;
  }
};

export const onRequest: PagesFunction<Env, 'id'> = async () => methodNotAllowed('DELETE');
