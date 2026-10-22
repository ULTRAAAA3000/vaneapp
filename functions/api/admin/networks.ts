/**
 * GET /api/admin/networks → every network: is its code written, is it on, what is connected and waiting
 * PUT /api/admin/networks { network, enabled?, note? }
 *      enabled: true is refused unless the code for that network exists (the platform's own review does not matter:
 *      keep its status in `note`, e.g. "waiting for TikTok approval"). Switching a network off pauses it, see lib/networks.ts.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { audit, requireAdmin } from '../lib/admin';
import { fail, isRecord, json, methodNotAllowed, readJson } from '../lib/http';
import { invalidateNetworkFlags, isOn, networkFlags, networkInfo, NETWORKS } from '../lib/networks';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  invalidateNetworkFlags();
  const now = Math.floor(Date.now() / 1000);
  const flags = await networkFlags(env);

  const [channels, waiting, upcoming, failed] = await env.DB.batch([
    env.DB.prepare(`SELECT type, COUNT(*) n, COALESCE(SUM(is_active),0) active FROM channels GROUP BY type`),
    env.DB.prepare(`SELECT c.type, COUNT(*) n FROM posts p JOIN channels c ON c.id = p.channel_id WHERE p.status = 'scheduled' AND p.scheduled_at <= ?1 GROUP BY c.type`).bind(now),
    env.DB.prepare(`SELECT c.type, COUNT(*) n FROM posts p JOIN channels c ON c.id = p.channel_id WHERE p.status = 'scheduled' AND p.scheduled_at > ?1 GROUP BY c.type`).bind(now),
    env.DB.prepare(`SELECT c.type, COUNT(*) n FROM posts p JOIN channels c ON c.id = p.channel_id WHERE p.status = 'failed' AND p.updated_at >= ?1 GROUP BY c.type`).bind(now - 86400),
  ]);
  const by = (r: { results: unknown[] }) => new Map((r.results as { type: string; n: number; active?: number }[]).map((x) => [x.type, x]));
  const ch = by(channels), wt = by(waiting), up = by(upcoming), fl = by(failed);

  return json({
    ok: true,
    networks: NETWORKS.map((n) => {
      const f = flags.get(n.id);
      const post = n.product === 'post';
      return {
        id: n.id, name: n.name, product: n.product, implemented: n.implemented, code: n.code,
        enabled: isOn(n.id, flags), switchedOff: n.implemented && f?.enabled === false,
        note: f?.note ?? '', updatedAt: f?.updatedAt ?? null, updatedBy: f?.updatedBy ?? null,
        stats: post ? { channels: ch.get(n.id)?.n ?? 0, activeChannels: ch.get(n.id)?.active ?? 0, waiting: wt.get(n.id)?.n ?? 0, scheduled: up.get(n.id)?.n ?? 0, failed24h: fl.get(n.id)?.n ?? 0 } : null,
      };
    }),
  });
};

export const onRequestPut: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  const parsed = await readJson(request, 2048);
  if (!parsed.ok) return parsed.response;
  const b = parsed.data;
  if (!isRecord(b) || typeof b.network !== 'string') return fail(400, 'network is required.');
  const info = networkInfo(b.network);
  if (!info) return fail(404, 'Unknown network.');
  if (b.enabled !== undefined && typeof b.enabled !== 'boolean') return fail(400, 'enabled must be true or false.');
  if (b.note !== undefined && (typeof b.note !== 'string' || b.note.length > 200)) return fail(400, 'note must be text of at most 200 characters.');
  if (b.enabled === undefined && b.note === undefined) return fail(400, 'Send enabled and / or note.');
  if (b.enabled === true && !info.implemented) {
    return fail(409, `${info.name} cannot be switched on yet: its code is not written. (Once the code exists it can be switched on even before ${info.name} approves Vane.)`);
  }

  invalidateNetworkFlags();
  const current = (await networkFlags(env)).get(info.id);
  const enabled = b.enabled ?? current?.enabled ?? true;
  const note = typeof b.note === 'string' ? b.note.trim() : current?.note ?? '';
  await env.DB
    .prepare(
      `INSERT INTO network_flags (network, enabled, note, updated_at, updated_by) VALUES (?1, ?2, ?3, unixepoch(), ?4)
       ON CONFLICT(network) DO UPDATE SET enabled = excluded.enabled, note = excluded.note, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .bind(info.id, enabled ? 1 : 0, note, env.ADMIN_EMAIL ?? 'admin')
    .run();
  invalidateNetworkFlags();
  if (b.enabled !== undefined && b.enabled !== (current?.enabled ?? true)) await audit(env, request, enabled ? 'network.enable' : 'network.disable', info.id, { note });
  else if (b.note !== undefined) await audit(env, request, 'network.note', info.id, { note });
  return json({ ok: true, network: info.id, enabled: isOn(info.id, await networkFlags(env)), note });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET, PUT');
