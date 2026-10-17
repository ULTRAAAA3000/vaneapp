/**
 * GET    /api/admin/security/blocks            → the blocklist
 * POST   /api/admin/security/blocks            { kind: ip|cidr|asn|country, value, reason?, hours? } (hours empty = until removed)
 * DELETE /api/admin/security/blocks?id=12      → lift a block
 *
 * Refuses a block that would lock out the address / network / country you are using right now.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../types';
import { audit, requireAdmin } from '../../lib/admin';
import { clientOf, invalidateGuardCache } from '../../lib/guard';
import { fail, isRecord, json, methodNotAllowed, readJson } from '../../lib/http';
import { inCidr, parseCidr, parseIp, sameIp } from '../../lib/ipaddr';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  const now = Math.floor(Date.now() / 1000);
  const { results } = await env.DB
    .prepare(`SELECT id, kind, value, reason, source, expires_at, created_by, created_at FROM ip_blocks
               WHERE expires_at IS NULL OR expires_at > ?1 ORDER BY (source = 'preset'), created_at DESC, id DESC LIMIT 1000`)
    .bind(now)
    .all();
  return json({ ok: true, blocks: results });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  const parsed = await readJson(request, 2048);
  if (!parsed.ok) return parsed.response;
  const b = parsed.data;
  if (!isRecord(b) || typeof b.kind !== 'string' || typeof b.value !== 'string') return fail(400, 'kind and value are required.');

  let value = b.value.trim();
  const me = clientOf(request);
  const myIp = parseIp(me.ip);
  let selfHit = false;
  if (b.kind === 'ip') {
    const ip = parseIp(value);
    if (!ip) return fail(400, 'That is not a valid IP address.');
    selfHit = !!myIp && sameIp(myIp, ip);
  } else if (b.kind === 'cidr') {
    const c = parseCidr(value);
    if (!c) return fail(400, 'That is not a valid range, e.g. 203.0.113.0/24.');
    selfHit = !!myIp && inCidr(myIp, c);
  } else if (b.kind === 'asn') {
    value = value.replace(/^as/i, '');
    if (!/^\d{1,10}$/.test(value)) return fail(400, 'ASN must be a number, e.g. 9009.');
    selfHit = me.asn !== null && String(me.asn) === value;
  } else if (b.kind === 'country') {
    if (!/^[A-Za-z]{2}$/.test(value)) return fail(400, 'Country must be a 2-letter code, e.g. RU.');
    value = value.toUpperCase();
    selfHit = me.country === value;
  } else return fail(400, 'kind must be ip, cidr, asn or country.');
  if (selfHit) return fail(400, 'That would block the network you are using right now. Switch networks first if you really mean it.');

  const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 200) : '';
  let expires: number | null = null;
  if (b.hours !== undefined && b.hours !== null && b.hours !== '') {
    const h = Number(b.hours);
    if (!Number.isFinite(h) || h <= 0 || h > 24 * 3650) return fail(400, 'hours must be a positive number.');
    expires = Math.floor(Date.now() / 1000 + h * 3600);
  }
  await env.DB
    .prepare(
      `INSERT INTO ip_blocks (kind, value, reason, source, expires_at, created_by) VALUES (?1, ?2, ?3, 'manual', ?4, ?5)
       ON CONFLICT(kind, value) DO UPDATE SET reason = excluded.reason, source = 'manual', expires_at = excluded.expires_at, created_by = excluded.created_by`,
    )
    .bind(b.kind, value, reason || null, expires, env.ADMIN_EMAIL ?? 'admin')
    .run();
  invalidateGuardCache();
  await audit(env, request, 'block.add', `${b.kind}:${value}`, { reason, hours: b.hours ?? null });
  return json({ ok: true }, 201);
};

export const onRequestDelete: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  const id = Number(new URL(request.url).searchParams.get('id'));
  if (!Number.isInteger(id) || id < 1) return fail(400, 'id is invalid.');
  const row = await env.DB.prepare('SELECT kind, value FROM ip_blocks WHERE id = ?1').bind(id).first<{ kind: string; value: string }>();
  if (!row) return fail(404, 'No such block.');
  await env.DB.prepare('DELETE FROM ip_blocks WHERE id = ?1').bind(id).run();
  invalidateGuardCache();
  await audit(env, request, 'block.remove', `${row.kind}:${row.value}`);
  return json({ ok: true });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET, POST, DELETE');
