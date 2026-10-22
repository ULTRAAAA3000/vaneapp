/**
 * POST /api/waitlist  — { "email": "you@example.com" }
 *
 * 200 { ok: true, status: 'joined' }          new signup
 * 200 { ok: true, status: 'already_joined' }  duplicate (idempotent, doesn't reveal anything sensitive)
 * 400 / 405 / 415 / 500 { ok: false, error }
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env, WaitlistRequest, WaitlistResponse } from '../../types';
import { bump, clientIp, retryAfter } from './lib/throttle';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_EMAIL_LEN = 254;
const WAITLIST_PER_HOUR = 8;

const json = (body: WaitlistResponse, status = 200, extra: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  // Basic content-type guard
  const ct = request.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    return json({ ok: false, error: 'Content-Type must be application/json' }, 415);
  }

  // Every signup is a stored row, so this door is a spam target: a few per hour per address (honeypot hits count too).
  const ip = clientIp(request);
  if (ip !== 'unknown') {
    try {
      const wait = await retryAfter(env, `waitlist:${ip}`, WAITLIST_PER_HOUR);
      if (wait) return json({ ok: false, error: 'Too many sign-ups from your network. Please try again later.' }, 429, { 'Retry-After': String(wait) });
      await bump(env, `waitlist:${ip}`, 3600);
    } catch (err) {
      console.error('waitlist throttle failed', err instanceof Error ? err.message : 'unknown'); // a throttle problem must not close the door
    }
  }

  let body: Partial<WaitlistRequest>;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  // Honeypot: bots fill hidden fields. Pretend success, store nothing.
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    return json({ ok: true, status: 'joined' });
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || email.length > MAX_EMAIL_LEN || !EMAIL_RE.test(email)) {
    return json({ ok: false, error: 'Please enter a valid email address.' }, 400);
  }

  try {
    const res = await env.DB
      .prepare('INSERT OR IGNORE INTO waitlist (email) VALUES (?1)')
      .bind(email)
      .run();

    // meta.changes === 0 → the UNIQUE constraint ignored the row → duplicate
    const inserted = (res.meta?.changes ?? 0) > 0;
    return json({ ok: true, status: inserted ? 'joined' : 'already_joined' });
  } catch (err) {
    console.error('waitlist insert failed', err);
    return json({ ok: false, error: 'Something went wrong. Please try again.' }, 500);
  }
};

// Any other method
export const onRequest: PagesFunction<Env> = async () =>
  json({ ok: false, error: 'Method not allowed' }, 405, { Allow: 'POST' });
