/**
 * POST /api/admin/login  { login, password, turnstileToken? } → 200 + HttpOnly admin cookie
 *
 * `login` is ADMIN_EMAIL (or ADMIN_USERNAME). Order of checks: same-origin → allowed network →
 * blocklist → Turnstile → failed-attempt throttle → password. Every outcome lands in the attempts feed,
 * and 8 failures from one address in 15 minutes ban it automatically.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { adminConfigured, adminCookie, adminIpAllowed, ADMIN_TTL_SECONDS, audit, checkAdminCredentials, createAdminSession } from '../lib/admin';
import { logAttempt, maybeAutoBan } from '../lib/attempts';
import { guard } from '../lib/guard';
import { crossOriginViolation, fail, isRecord, json, methodNotAllowed, readJson } from '../lib/http';
import { bump, clear, clientIp, retryAfter } from '../lib/throttle';
import { requireHuman } from '../lib/turnstile';

const WINDOW = 15 * 60;
const MAX_FAILS_PER_IP = 5;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const xo = crossOriginViolation(request);
  if (xo) return xo;
  if (!adminConfigured(env)) return fail(503, 'The admin panel is not configured on this server.');

  if (!adminIpAllowed(env, request)) {
    await logAttempt(env, request, { kind: 'admin_login', ok: false, reason: 'not_allowed_ip' });
    return fail(403, 'Not allowed from this network.');
  }
  const blocked = await guard(env, request, 'admin', 'admin_login');
  if (blocked) return blocked;

  const parsed = await readJson(request, 4096);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  if (!isRecord(body)) return fail(400, 'Body must be a JSON object');
  const login = typeof body.login === 'string' ? body.login.slice(0, 254) : '';
  const password = typeof body.password === 'string' ? body.password.slice(0, 256) : '';

  const human = await requireHuman(env, request, body.turnstileToken);
  if (human) {
    await logAttempt(env, request, { kind: 'admin_login', ok: false, reason: 'human_check', email: login });
    return human;
  }

  const ipKey = `admin:ip:${clientIp(request)}`;
  const wait = await retryAfter(env, ipKey, MAX_FAILS_PER_IP);
  if (wait) {
    await logAttempt(env, request, { kind: 'admin_login', ok: false, reason: 'throttled', email: login });
    await maybeAutoBan(env, request, 'admin_login'); // keep hammering through the throttle and the address gets banned
    return fail(429, `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} min.`, { 'Retry-After': String(wait) });
  }

  if (!(await checkAdminCredentials(env, login, password))) {
    await bump(env, ipKey, WINDOW);
    await logAttempt(env, request, { kind: 'admin_login', ok: false, reason: 'bad_password', email: login });
    await maybeAutoBan(env, request, 'admin_login');
    return fail(401, 'Invalid login or password.');
  }

  await clear(env, ipKey);
  const token = await createAdminSession(env, request);
  await logAttempt(env, request, { kind: 'admin_login', ok: true, email: login });
  await audit(env, request, 'admin.login');
  return json({ ok: true }, 200, { 'Set-Cookie': adminCookie(request, token, ADMIN_TTL_SECONDS) });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');
