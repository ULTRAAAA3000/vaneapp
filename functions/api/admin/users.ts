/**
 * GET  /api/admin/users?q=&page=1            → list (e-mail / name search, 25 per page)
 * GET  /api/admin/users?id=<uuid>            → everything about one user
 * POST /api/admin/users  { action, … }
 *        grant   { userId, planId, days?, note? }   give a plan (days empty = no end date); never counted as revenue
 *        revoke  { subscriptionId }                 end a subscription / grant now
 *        disable { userId, reason? }                switch the account off and sign it out everywhere
 *        enable  { userId }
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { audit, requireAdmin } from '../lib/admin';
import { fail, isRecord, json, methodNotAllowed, readJson, UUID_RE } from '../lib/http';
import { effectivePlan, getPlan } from '../lib/plans';
import { likeEscape } from '../lib/range';

const PAGE = 25;

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  const url = new URL(request.url);
  const now = Math.floor(Date.now() / 1000);

  const id = url.searchParams.get('id');
  if (id) {
    if (!UUID_RE.test(id)) return fail(400, 'Invalid user id.');
    const user = await env.DB
      .prepare(`SELECT u.id, u.email, u.name, u.timezone, u.created_at, COALESCE(f.disabled,0) disabled, f.reason disabled_reason
                  FROM users u LEFT JOIN user_flags f ON f.user_id = u.id WHERE u.id = ?1`)
      .bind(id)
      .first<Record<string, unknown>>();
    if (!user) return fail(404, 'User not found.');
    const email = String(user.email);
    const d = await env.DB.batch([
      env.DB.prepare(`SELECT s.id, s.plan_id, p.name plan_name, s.status, s.source, s.price_cents, s.currency, s.interval, s.started_at, s.ends_at, s.canceled_at, s.note, s.granted_by
                        FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.user_id = ?1 ORDER BY s.started_at DESC LIMIT 50`).bind(id),
      env.DB.prepare(`SELECT id, type, name, is_active, created_at FROM channels WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 50`).bind(id),
      env.DB.prepare(`SELECT status, COUNT(*) n FROM posts WHERE user_id = ?1 GROUP BY status`).bind(id),
      env.DB.prepare(`SELECT created_at, user_agent, expires_at FROM sessions WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 10`).bind(id),
      env.DB.prepare(`SELECT ref_host, utm_source, landing_path, country, created_at FROM user_attribution WHERE user_id = ?1`).bind(id),
      env.DB.prepare(`SELECT COALESCE(SUM(dur),0) total, COUNT(*) visits, COALESCE(SUM(pages),0) views
                        FROM (SELECT MAX(last_at) - MIN(started_at) dur, COUNT(*) pages FROM web_views WHERE user_id = ?1 GROUP BY sid)`).bind(id),
      env.DB.prepare(`SELECT path, COUNT(*) views, ROUND(AVG(last_at - started_at)) avg_time FROM web_views WHERE user_id = ?1 GROUP BY path ORDER BY views DESC LIMIT 8`).bind(id),
      env.DB.prepare(`SELECT ts, kind, ok, reason, ip, country, city, as_org FROM auth_attempts WHERE email = ?1 ORDER BY ts DESC LIMIT 15`).bind(email),
    ]);
    const ep = await effectivePlan(env, id);
    return json({
      ok: true,
      user,
      plan: { id: ep.plan.id, name: ep.plan.name, subscription: ep.subscription },
      subscriptions: d[0].results, channels: d[1].results,
      posts: Object.fromEntries((d[2].results as { status: string; n: number }[]).map((x) => [x.status, x.n])),
      sessions: d[3].results, attribution: d[4].results[0] ?? null, timeOnSite: d[5].results[0], pages: d[6].results, attempts: d[7].results,
    });
  }

  const search = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
  const page = Math.max(1, Math.min(10_000, Number(url.searchParams.get('page')) || 1));
  const like = `%${likeEscape(search)}%`;
  const where = `(?1 = '' OR u.email LIKE ?2 ESCAPE '\\' OR u.name LIKE ?2 ESCAPE '\\')`;
  const [list, count] = await env.DB.batch([
    env.DB
      .prepare(
        `SELECT u.id, u.email, u.name, u.created_at, COALESCE(f.disabled,0) disabled,
                (SELECT COUNT(*) FROM channels c WHERE c.user_id = u.id) channels,
                (SELECT COUNT(DISTINCT group_id) FROM posts p WHERE p.user_id = u.id AND p.status NOT IN ('draft','cancelled')) posts,
                (SELECT MAX(created_at) FROM sessions s WHERE s.user_id = u.id) last_login,
                COALESCE((SELECT SUM(dur) FROM (SELECT MAX(last_at) - MIN(started_at) dur FROM web_views w WHERE w.user_id = u.id GROUP BY sid)), 0) time_on_site,
                COALESCE((SELECT p.name FROM subscriptions s JOIN plans p ON p.id = s.plan_id
                           WHERE s.user_id = u.id AND s.status = 'active' AND (s.ends_at IS NULL OR s.ends_at > ?3) AND p.kind = 'plan'
                           ORDER BY p.price_cents DESC, s.started_at DESC LIMIT 1), 'Free') plan
           FROM users u LEFT JOIN user_flags f ON f.user_id = u.id
          WHERE ${where} ORDER BY u.created_at DESC LIMIT ?4 OFFSET ?5`,
      )
      .bind(search, like, now, PAGE, (page - 1) * PAGE),
    env.DB.prepare(`SELECT COUNT(*) n FROM users u WHERE ${where}`).bind(search, like),
  ]);
  return json({ ok: true, page, pageSize: PAGE, total: (count.results[0] as { n: number }).n, users: list.results });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  const parsed = await readJson(request, 4096);
  if (!parsed.ok) return parsed.response;
  const b = parsed.data;
  if (!isRecord(b) || typeof b.action !== 'string') return fail(400, 'action is required.');
  const now = Math.floor(Date.now() / 1000);

  if (b.action === 'grant') {
    if (typeof b.userId !== 'string' || !UUID_RE.test(b.userId)) return fail(400, 'userId is invalid.');
    if (typeof b.planId !== 'string') return fail(400, 'planId is required.');
    const days = b.days === undefined || b.days === null || b.days === '' ? null : Number(b.days);
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) return fail(400, 'days must be 1-3650, or empty for no end date.');
    const note = typeof b.note === 'string' ? b.note.trim().slice(0, 200) : null;
    const user = await env.DB.prepare('SELECT id, email FROM users WHERE id = ?1').bind(b.userId).first<{ id: string; email: string }>();
    if (!user) return fail(404, 'User not found.');
    const plan = await getPlan(env, b.planId);
    if (!plan) return fail(404, 'Plan not found.');
    if (plan.kind !== 'plan' || !plan.isActive) return fail(400, 'This plan cannot be given to users (it is an add-on or switched off).');

    const subId = crypto.randomUUID();
    await env.DB
      .prepare(
        `INSERT INTO subscriptions (id, user_id, plan_id, status, source, price_cents, currency, interval, started_at, ends_at, note, granted_by)
         VALUES (?1, ?2, ?3, 'active', 'admin', 0, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .bind(subId, user.id, plan.id, plan.currency, plan.interval, now, days === null ? null : now + days * 86400, note || null, env.ADMIN_EMAIL ?? 'admin')
      .run();
    await audit(env, request, 'user.grant_plan', user.email, { plan: plan.id, days, note });
    return json({ ok: true, subscriptionId: subId }, 201);
  }

  if (b.action === 'revoke') {
    if (typeof b.subscriptionId !== 'string' || !UUID_RE.test(b.subscriptionId)) return fail(400, 'subscriptionId is invalid.');
    const res = await env.DB
      .prepare(`UPDATE subscriptions SET status = 'canceled', canceled_at = ?2 WHERE id = ?1 AND status = 'active'`)
      .bind(b.subscriptionId, now)
      .run();
    if (!res.meta.changes) return fail(404, 'No active subscription with this id.');
    await audit(env, request, 'user.revoke_plan', b.subscriptionId);
    return json({ ok: true });
  }

  if (b.action === 'disable' || b.action === 'enable') {
    if (typeof b.userId !== 'string' || !UUID_RE.test(b.userId)) return fail(400, 'userId is invalid.');
    const user = await env.DB.prepare('SELECT email FROM users WHERE id = ?1').bind(b.userId).first<{ email: string }>();
    if (!user) return fail(404, 'User not found.');
    const off = b.action === 'disable';
    const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 200) : null;
    const stmts = [
      env.DB
        .prepare(`INSERT INTO user_flags (user_id, disabled, reason, updated_at) VALUES (?1, ?2, ?3, ?4)
                  ON CONFLICT(user_id) DO UPDATE SET disabled = excluded.disabled, reason = excluded.reason, updated_at = excluded.updated_at`)
        .bind(b.userId, off ? 1 : 0, off ? reason || null : null, now),
    ];
    if (off) stmts.push(env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(b.userId));
    await env.DB.batch(stmts);
    await audit(env, request, off ? 'user.disable' : 'user.enable', user.email, { reason });
    return json({ ok: true });
  }
  return fail(400, 'Unknown action.');
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET, POST');
