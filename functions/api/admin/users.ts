/**
 * GET  /api/admin/users?q=&page=1            → list (e-mail / name search, 25 per page)
 * GET  /api/admin/users?id=<uuid>            → everything about one user
 * POST /api/admin/users  { action, … }
 *        grant   { userId, planId, days?, addon?, overage?, note? }   give a plan by hand (same as `npm run plan:set`):
 *                                                   days empty = no end date, addon = Pro + API add-on; never counted as revenue
 *        ai_credits { userId, credits, note? }        add (or, negative, take away) AI credits for one account; they are spent after the plan's own credits
 *        revoke  { userId }                         end their plan now (they fall back to the Free Trial)
 *        disable { userId, reason? }                switch the account off and sign it out everywhere
 *        enable  { userId }
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { audit, requireAdmin } from '../lib/admin';
import { fail, isRecord, json, methodNotAllowed, readJson, UUID_RE } from '../lib/http';
import { getPlan, listPlans } from '../lib/catalog';
import { specOf } from '../lib/plans';
import { loadSubscription, usageSummary } from '../lib/usage';
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
      env.DB.prepare(`SELECT plan, api_addon, status, current_period_end, overage_enabled, provider, provider_ref, created_at, updated_at FROM subscriptions WHERE user_id = ?1`).bind(id),
      env.DB.prepare(`SELECT id, type, name, is_active, created_at FROM channels WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 50`).bind(id),
      env.DB.prepare(`SELECT status, COUNT(*) n FROM posts WHERE user_id = ?1 GROUP BY status`).bind(id),
      env.DB.prepare(`SELECT created_at, user_agent, expires_at FROM sessions WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 10`).bind(id),
      env.DB.prepare(`SELECT ref_host, utm_source, landing_path, country, created_at FROM user_attribution WHERE user_id = ?1`).bind(id),
      env.DB.prepare(`SELECT COALESCE(SUM(dur),0) total, COUNT(*) visits, COALESCE(SUM(pages),0) views
                        FROM (SELECT MAX(last_at) - MIN(started_at) dur, COUNT(*) pages FROM web_views WHERE user_id = ?1 GROUP BY sid)`).bind(id),
      env.DB.prepare(`SELECT path, COUNT(*) views, ROUND(AVG(last_at - started_at)) avg_time FROM web_views WHERE user_id = ?1 GROUP BY path ORDER BY views DESC LIMIT 8`).bind(id),
      env.DB.prepare(`SELECT ts, kind, ok, reason, ip, country, city, as_org FROM auth_attempts WHERE email = ?1 ORDER BY ts DESC LIMIT 15`).bind(email),
    ]);
    const sub = await loadSubscription(env, id);
    const spec = specOf(sub.plan);
    return json({
      ok: true,
      user,
      plan: { id: sub.plan, name: spec.label, apiAddon: sub.apiAddon, overageEnabled: sub.overageEnabled, status: sub.status, lapsed: sub.lapsed, endsAt: sub.currentPeriodEnd, provider: (d[0].results[0] as { provider?: string } | undefined)?.provider ?? null },
      subscription: d[0].results[0] ?? null, usage: await usageSummary(env, id, sub), channels: d[1].results,
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
                CASE WHEN sb.plan IS NULL OR sb.plan = 'free' OR sb.status <> 'active' OR (sb.current_period_end IS NOT NULL AND sb.current_period_end <= ?3)
                     THEN 'free' ELSE sb.plan END plan_id,
                COALESCE(sb.api_addon, 0) api_addon
           FROM users u LEFT JOIN user_flags f ON f.user_id = u.id LEFT JOIN subscriptions sb ON sb.user_id = u.id
          WHERE ${where} ORDER BY u.created_at DESC LIMIT ?4 OFFSET ?5`,
      )
      .bind(search, like, now, PAGE, (page - 1) * PAGE),
    env.DB.prepare(`SELECT COUNT(*) n FROM users u WHERE ${where}`).bind(search, like),
  ]);
  const names = new Map((await listPlans(env)).map((p) => [p.id, p.name]));
  const users = (list.results as { plan_id: string; api_addon: number }[]).map((u) => ({
    ...u,
    plan: (names.get(u.plan_id) ?? u.plan_id) + (u.plan_id === 'pro' && u.api_addon ? ' + API' : ''),
  }));
  return json({ ok: true, page, pageSize: PAGE, total: (count.results[0] as { n: number }).n, users });
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
    const addon = b.addon === true;
    const overage = b.overage === true;
    const user = await env.DB.prepare('SELECT id, email FROM users WHERE id = ?1').bind(b.userId).first<{ id: string; email: string }>();
    if (!user) return fail(404, 'User not found.');
    if (b.planId === 'free') return fail(400, 'Use "End plan" to move a user back to the Free Trial.');
    const plan = await getPlan(env, b.planId);
    if (!plan) return fail(404, 'Plan not found.');
    if (plan.kind !== 'plan' || !plan.isActive) return fail(400, 'This plan cannot be given to users (it is an add-on or switched off).');
    if (addon && plan.id !== 'pro') return fail(400, 'The API add-on only goes with the Pro plan.');

    const current = await env.DB.prepare('SELECT plan, status, provider, current_period_end FROM subscriptions WHERE user_id = ?1').bind(user.id)
      .first<{ plan: string; status: string; provider: string; current_period_end: number | null }>();
    if (current && current.provider !== 'manual' && current.plan !== 'free' && current.status === 'active' && (current.current_period_end === null || current.current_period_end > now)) {
      return fail(409, `This user pays for ${current.plan} through ${current.provider}. End that plan first if you really want to replace it.`);
    }
    try {
      await env.DB
        .prepare(
          `INSERT INTO subscriptions (user_id, plan, api_addon, status, current_period_end, overage_enabled, provider, created_at, updated_at)
           VALUES (?1, ?2, ?3, 'active', ?4, ?5, 'manual', ?6, ?6)
           ON CONFLICT(user_id) DO UPDATE SET plan = excluded.plan, api_addon = excluded.api_addon, status = 'active',
             current_period_end = excluded.current_period_end, overage_enabled = excluded.overage_enabled, provider = 'manual', provider_ref = NULL, updated_at = excluded.updated_at`,
        )
        .bind(user.id, plan.id, addon ? 1 : 0, days === null ? null : now + days * 86400, overage ? 1 : 0, now)
        .run();
    } catch (err) {
      if (/CHECK constraint/i.test(err instanceof Error ? err.message : '')) {
        return fail(409, 'This database only accepts the built-in plans (free / api / pro). Run scripts/migrations/001-subscriptions-any-plan.sql once to allow custom plans.');
      }
      throw err;
    }
    await audit(env, request, 'user.grant_plan', user.email, { plan: plan.id, addon, overage, days, note });
    return json({ ok: true }, 201);
  }

  if (b.action === 'ai_credits') {
    if (typeof b.userId !== 'string' || !UUID_RE.test(b.userId)) return fail(400, 'userId is invalid.');
    const delta = Number(b.credits);
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100_000) return fail(400, 'credits must be a whole number other than 0 (up to 100000); negative takes credits away.');
    const user = await env.DB.prepare('SELECT email FROM users WHERE id = ?1').bind(b.userId).first<{ email: string }>();
    if (!user) return fail(404, 'User not found.');
    const note = typeof b.note === 'string' ? b.note.trim().slice(0, 200) : null;
    try {
      await env.DB
        .prepare(
          `INSERT INTO user_ai_bonus (user_id, credits, updated_at) VALUES (?1, MAX(?2, 0), ?3)
           ON CONFLICT(user_id) DO UPDATE SET credits = MAX(credits + ?2, 0), updated_at = ?3`,
        )
        .bind(b.userId, delta, now)
        .run();
    } catch (err) {
      if (/no such table/i.test(err instanceof Error ? err.message : '')) return fail(409, 'The database does not have the AI credits table yet. Run the whole schema.sql in the D1 Console (it is safe to run again), then try once more.');
      throw err;
    }
    const row = await env.DB.prepare('SELECT credits FROM user_ai_bonus WHERE user_id = ?1').bind(b.userId).first<{ credits: number }>();
    await audit(env, request, 'user.ai_credits', user.email, { delta, balance: row?.credits ?? 0, note });
    return json({ ok: true, balance: row?.credits ?? 0 });
  }

  if (b.action === 'revoke') {
    if (typeof b.userId !== 'string' || !UUID_RE.test(b.userId)) return fail(400, 'userId is invalid.');
    const user = await env.DB.prepare('SELECT email FROM users WHERE id = ?1').bind(b.userId).first<{ email: string }>();
    if (!user) return fail(404, 'User not found.');
    const res = await env.DB
      .prepare(`UPDATE subscriptions SET status = 'canceled', current_period_end = ?2, updated_at = ?2 WHERE user_id = ?1 AND plan <> 'free' AND status = 'active'`)
      .bind(b.userId, now)
      .run();
    if (!res.meta.changes) return fail(404, 'This user has no active paid plan.');
    await audit(env, request, 'user.revoke_plan', user.email);
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
