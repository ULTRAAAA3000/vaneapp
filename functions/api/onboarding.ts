/**
 * The onboarding checklist of the dashboard (see lib/onboarding.ts).
 *   GET  /api/onboarding                        → { ok, steps: [{ id, done }], done, total, hidden, celebrate }
 *   POST /api/onboarding  { action: "dismiss" } → close the card for good
 *   POST /api/onboarding  { action: "celebrated" } → the confetti was shown (accepted only when every step is done)
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../types';
import { requireUser } from './lib/auth';
import { fail, isRecord, json, methodNotAllowed, readJson } from './lib/http';
import { loadOnboarding, markOnboarding } from './lib/onboarding';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  return json({ ok: true, ...(await loadOnboarding(env, auth.userId)) });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const parsed = await readJson(request, 1024);
  if (!parsed.ok) return parsed.response;
  const b = parsed.data;
  if (!isRecord(b) || (b.action !== 'dismiss' && b.action !== 'celebrated')) return fail(400, 'action must be "dismiss" or "celebrated".');
  try {
    const ok = await markOnboarding(env, auth.userId, b.action);
    return ok ? json({ ok: true }) : fail(409, 'Not every step is done yet.');
  } catch {
    return json({ ok: true });                                        // the card is an extra: a missing table is not the person's problem
  }
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET, POST');
