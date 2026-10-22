/**
 * POST /api/track  → always 204 (the beacon never learns anything)
 *   { t: 'view', id, sid, vid, path, ref?, utm? }   a page was opened
 *   { t: 'ping', id, vid }                          still here (every ~20 s while the tab is visible, and on leave)
 *
 * Time on page = last ping − first view. Bots, blocked addresses and floods are dropped silently.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../types';
import { clientOf, guard, ipHash } from './lib/guard';
import { crossOriginViolation, isRecord, readJson } from './lib/http';
import { getSettings } from './lib/settings';
import { readSessionToken, userIdFromSession } from './lib/session';

const done = (): Response => new Response(null, { status: 204 });
const ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const PATH_RE = /^\/[A-Za-z0-9._~/-]{0,120}$/;
const BOT_RE = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|monitor|curl|wget|python|node-fetch/i;

// Per-isolate flood cap: 120 beacons a minute per address.
const flood = new Map<string, { n: number; reset: number }>();
function tooMany(ip: string): boolean {
  const now = Date.now();
  const e = flood.get(ip);
  if (!e || e.reset < now) {
    if (flood.size > 5000) flood.clear();
    flood.set(ip, { n: 1, reset: now + 60_000 });
    return false;
  }
  return ++e.n > 120;
}

function cleanPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || !PATH_RE.test(raw)) return null;
  let p = raw.replace(/\.html$/, '').replace(/\/+$/, '');
  if (p === '' || p === '/index') p = '/';
  return p.startsWith('/admin') ? null : p;
}

function refHost(raw: unknown, ownHost: string): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const h = new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
    return h && h.length <= 100 && /^[a-z0-9.-]+$/.test(h) && h !== ownHost.replace(/^www\./, '') ? h : null;
  } catch {
    return null;
  }
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (crossOriginViolation(request)) return done();
  const client = clientOf(request);
  if (BOT_RE.test(client.ua) || !client.ua || tooMany(client.ip)) return done();
  if (!(await getSettings(env)).track_visits) return done();
  if (await guard(env, request, 'track')) return done();

  const parsed = await readJson(request, 2048);
  if (!parsed.ok || !isRecord(parsed.data)) return done();
  const b = parsed.data;
  if (typeof b.id !== 'string' || !ID_RE.test(b.id) || typeof b.vid !== 'string' || !ID_RE.test(b.vid)) return done();
  const now = Math.floor(Date.now() / 1000);

  try {
    if (b.t === 'ping') {
      await env.DB
        .prepare('UPDATE web_views SET last_at = ?1 WHERE id = ?2 AND visitor_id = ?3 AND last_at <= ?1 AND ?1 - started_at < 21600')
        .bind(now, b.id, b.vid)
        .run();
      return done();
    }
    if (b.t !== 'view' || typeof b.sid !== 'string' || !ID_RE.test(b.sid)) return done();
    const path = cleanPath(b.path);
    if (!path) return done();

    const utm = typeof b.utm === 'string' && /^[A-Za-z0-9_.-]{1,50}$/.test(b.utm) ? b.utm : null;
    const token = readSessionToken(request);
    const userId = token ? await userIdFromSession(env, token) : null;
    const device = /iPad|Tablet/i.test(client.ua) ? 'tablet' : /Mobi|Android|iPhone/i.test(client.ua) ? 'mobile' : 'desktop';

    await env.DB
      .prepare(
        `INSERT INTO web_views (id, sid, visitor_id, user_id, path, ref_host, utm_source, country, city, asn, device, ip_hash, started_at, last_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13) ON CONFLICT(id) DO NOTHING`,
      )
      .bind(b.id, b.sid, b.vid, userId, path, refHost(b.ref, new URL(request.url).hostname), utm, client.country || null, client.city || null, client.asn, device, await ipHash(env, client.ip), now)
      .run();

    // Housekeeping on ~1% of views: keep the tables small.
    if (Math.random() < 0.01) {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM web_views WHERE started_at < ?1').bind(now - 180 * 86400),
        env.DB.prepare('DELETE FROM auth_attempts WHERE ts < ?1').bind(now - 90 * 86400),
        env.DB.prepare('DELETE FROM ip_intel WHERE checked_at < ?1').bind(now - 7 * 86400),
        env.DB.prepare('DELETE FROM ai_usage WHERE ts < ?1').bind(now - 400 * 86400),
        env.DB.prepare(`DELETE FROM ip_blocks WHERE source = 'auto' AND expires_at IS NOT NULL AND expires_at < ?1`).bind(now - 86400),
      ]);
    }
  } catch (err) {
    console.error('track failed', err instanceof Error ? err.message : 'unknown');
  }
  return done();
};

export const onRequest: PagesFunction<Env> = async () => done();
