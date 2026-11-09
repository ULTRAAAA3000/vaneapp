import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { templateProblem } from '../lib/feeds';
import { fail, failCode, isRecord, json, methodNotAllowed, readJson, UUID_RE } from '../lib/http';
import { myActiveChannels, readChannelIds, readDelay } from '../lib/feedsapi';

const idOf = (p: string | string[] | undefined): string | null => {
  const id = Array.isArray(p) ? p[0] : p;
  return id && UUID_RE.test(id) ? id : null;
};

export const onRequestPatch: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const id = idOf(params.id);
  if (!id) return fail(404, 'Feed not found.');
  const parsed = await readJson(request, 8192);
  if (!parsed.ok) return parsed.response;
  const b = parsed.data;
  if (!isRecord(b)) return fail(400, 'Body must be a JSON object.');

  const own = await env.DB.prepare('SELECT 1 AS x FROM feeds WHERE id = ?1 AND user_id = ?2').bind(id, auth.userId).first();
  if (!own) return fail(404, 'Feed not found.');

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (b.channelIds !== undefined) {
    const ids = readChannelIds(b.channelIds);
    if (!ids) return failCode(400, 'bad_channels', 'Choose at least one channel.');
    if (!(await myActiveChannels(env, auth.userId, ids))) return fail(404, 'One or more channels were not found.');
    sets.push('channel_ids'); vals.push(JSON.stringify(ids));
  }
  if (b.template !== undefined) {
    const tp = templateProblem(b.template);
    if (tp) return failCode(400, 'bad_template', tp);
    sets.push('template'); vals.push(b.template);
  }
  if (b.delayMinutes !== undefined) {
    const d = readDelay(b.delayMinutes);
    if (d === null) return failCode(400, 'bad_delay', 'The delay must be a whole number of minutes from 1 to 1440.');
    sets.push('delay_minutes'); vals.push(d);
  }
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') return failCode(400, 'bad_enabled', 'enabled must be true or false.');
    sets.push('enabled'); vals.push(b.enabled ? 1 : 0);
    if (b.enabled) { sets.push('fail_count'); vals.push(0); sets.push('last_error'); vals.push(null); sets.push('next_check_at'); vals.push(Math.floor(Date.now() / 1000)); }
  }
  if (!sets.length) return failCode(400, 'nothing_to_change', 'Nothing to change.');

  await env.DB.prepare(`UPDATE feeds SET ${sets.map((c, i) => `${c} = ?${i + 3}`).join(', ')} WHERE id = ?1 AND user_id = ?2`).bind(id, auth.userId, ...vals).run();
  return json({ ok: true });
};

export const onRequestDelete: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const id = idOf(params.id);
  if (!id) return fail(404, 'Feed not found.');
  const res = await env.DB.prepare('DELETE FROM feeds WHERE id = ?1 AND user_id = ?2').bind(id, auth.userId).run();
  return res.meta.changes ? json({ ok: true }) : fail(404, 'Feed not found.');
};

export const onRequest: PagesFunction<Env, 'id'> = async () => methodNotAllowed('PATCH, DELETE');
