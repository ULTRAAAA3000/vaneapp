/**
 * GET  /api/analytics/bot            → is the bot available, is this account linked, current settings
 * POST /api/analytics/bot { action: 'link' }                       → one-time Telegram link (15 minutes)
 *                         { action: 'save', results?, milestones?, followers?, hot?, hotThreshold?, digest? }
 *                         { action: 'test' } | { action: 'unlink' }
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { isAnalyticsPro } from '../lib/analyticsdata';
import { botByUser, newLinkCode, sendTest } from '../lib/analyticsbot';
import { fail, failCode, isRecord, json, methodNotAllowed, readJson } from '../lib/http';
import { bump, retryAfter } from '../lib/throttle';
import { nowSeconds } from '../lib/usage';

const username = (env: Env): string => (env.ANALYTICS_BOT_USERNAME || 'VaneAnalyticsBot').replace(/^@/, '');

async function view(env: Env, userId: string, now: number): Promise<Record<string, unknown>> {
  const configured = Boolean(env.ANALYTICS_BOT_TOKEN && env.ANALYTICS_BOT_SECRET);
  const pro = await isAnalyticsPro(env, userId, now);
  let bot = null;
  try { bot = await botByUser(env, userId); } catch { /* table not created yet */ }
  return {
    ok: true, configured, username: username(env), pro, linked: !!bot,
    settings: bot ? { lang: bot.lang, results: bot.a_results === 1, milestones: bot.a_milestones === 1, followers: bot.a_followers === 1, hot: bot.a_hot === 1, hotThreshold: bot.hot_threshold, digest: bot.digest } : null,
  };
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  return json(await view(env, auth.userId, nowSeconds()));
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const parsed = await readJson(request, 2048);
  if (!parsed.ok) return parsed.response;
  const b = parsed.data;
  if (!isRecord(b) || typeof b.action !== 'string') return fail(400, 'action is required.');
  const now = nowSeconds();
  if (!env.ANALYTICS_BOT_TOKEN || !env.ANALYTICS_BOT_SECRET) return failCode(503, 'bot_off', 'The Telegram bot is not switched on yet.');

  if (b.action === 'link') {
    const key = `abot-link:${auth.userId}`;
    const wait = await retryAfter(env, key, 10);
    if (wait) return fail(429, 'Too many tries. Wait a little.', { 'Retry-After': String(wait) });
    await bump(env, key, 3600);
    const { code, expiresAt } = await newLinkCode(env, auth.userId, now);
    return json({ ok: true, url: `https://t.me/${username(env)}?start=${code}`, expiresAt });
  }

  const bot = await botByUser(env, auth.userId);
  if (!bot) return failCode(409, 'not_linked', 'Connect Telegram first.');

  if (b.action === 'unlink') {
    await env.DB.prepare('DELETE FROM analytics_bot WHERE user_id = ?1').bind(auth.userId).run();
    return json({ ok: true });
  }
  if (b.action === 'test') {
    const key = `abot-test:${auth.userId}`;
    const wait = await retryAfter(env, key, 5);
    if (wait) return fail(429, 'Too many tries. Wait a little.', { 'Retry-After': String(wait) });
    await bump(env, key, 600);
    return (await sendTest(env, bot)) ? json({ ok: true }) : failCode(502, 'send_failed', 'Telegram did not accept the message. Press /start in the bot chat and try again.');
  }
  if (b.action === 'save') {
    const pro = await isAnalyticsPro(env, auth.userId, now);
    const sets: [string, number | string][] = [];
    const flag = (k: string, col: string, needsPro: boolean): void => { if (typeof b[k] === 'boolean' && (!needsPro || pro)) sets.push([col, b[k] ? 1 : 0]); };
    flag('results', 'a_results', false); flag('milestones', 'a_milestones', false); flag('followers', 'a_followers', true); flag('hot', 'a_hot', true);
    if (b.hotThreshold !== undefined) {
      const n = Number(b.hotThreshold);
      if (!Number.isInteger(n) || n < 1 || n > 100000) return fail(400, 'Threshold must be a whole number from 1 to 100000.');
      if (pro) sets.push(['hot_threshold', n]);
    }
    if (b.digest !== undefined) {
      if (b.digest !== 'off' && b.digest !== 'daily' && b.digest !== 'weekly') return fail(400, 'digest must be off, daily or weekly.');
      if (pro || b.digest === 'off') sets.push(['digest', b.digest]);
    }
    for (const [col, v] of sets) await env.DB.prepare(`UPDATE analytics_bot SET ${col} = ?2, updated_at = ?3 WHERE user_id = ?1`).bind(auth.userId, v, now).run();
    return json(await view(env, auth.userId, now));
  }
  return fail(400, 'Unknown action.');
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET, POST');
