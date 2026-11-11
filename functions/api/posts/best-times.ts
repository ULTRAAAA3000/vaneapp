/**
 * The "Best time" button of the composer (dashboard).
 *
 *   GET /api/posts/best-times?count=3&tz=Europe/Kyiv
 *        → { ok, slots: [unix seconds, soonest first], personal, timeZone }
 *
 * It is the calculation the MCP tool vane_best_times already runs (lib/aiplus.ts suggestSlots): the hours when the person's own posts got
 * the most reactions over the last 180 days, on the coming days, skipping times that already have a post. With too little data
 * (`personal: false`) the slots are sensible defaults (morning, midday, evening), and the button says so instead of pretending.
 *
 * Paid plans only, like the same tool in MCP: 402 paid_plan_required on the Free Trial. `tz` is the browser's time zone (optional,
 * checked: a wrong one is ignored and the saved time zone of the account is used, then UTC). Slots are absolute times; the page turns
 * them into the local value of its date field.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { suggestSlots } from '../lib/aiplus';
import { failCode, fail, json, methodNotAllowed } from '../lib/http';
import { isPaidAccount } from '../lib/paid';
import { bump, retryAfter } from '../lib/throttle';

const MAX_PER_HOUR = 120;

const validZone = (z: string): boolean => { try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch { return false; } };

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  if (!(await isPaidAccount(env, auth.userId))) return failCode(402, 'paid_plan_required', 'Best time is part of the paid plans.');

  const key = `besttimes:${auth.userId}`;
  const wait = await retryAfter(env, key, MAX_PER_HOUR);
  if (wait) return fail(429, 'Too many requests. Try again in a bit.', { 'Retry-After': String(wait) });
  await bump(env, key, 3600);

  const q = new URL(request.url).searchParams;
  const raw = q.get('count');
  const asked = raw === null || raw.trim() === '' ? NaN : Number(raw);   // no count asked: three
  const count = Number.isInteger(asked) ? Math.min(Math.max(asked, 1), 5) : 3;
  const sent = (q.get('tz') ?? '').trim().slice(0, 64);
  let tz = sent && validZone(sent) ? sent : '';
  if (!tz) {
    const row = await env.DB.prepare('SELECT timezone FROM users WHERE id = ?1').bind(auth.userId).first<{ timezone: string | null }>().catch(() => null);
    tz = row?.timezone && validZone(row.timezone) ? row.timezone : 'UTC';
  }
  try {
    const r = await suggestSlots(env, auth.userId, count, Math.floor(Date.now() / 1000), tz);
    return json({ ok: true, slots: [...r.slots].sort((a, b) => a - b), personal: r.personal, timeZone: r.timeZone });
  } catch (err) {
    console.error('best-times failed', err instanceof Error ? err.message : 'unknown');
    return fail(500, 'Could not work out the best time. Try again.');
  }
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
