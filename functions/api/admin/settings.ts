/** GET /api/admin/settings → switches + which optional integrations are configured;  PUT → change any subset */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { audit, requireAdmin } from '../lib/admin';
import { readServiceAccount } from '../lib/google';
import { fail, isRecord, json, methodNotAllowed, readJson } from '../lib/http';
import { getSettings, invalidateSettings, saveSettings } from '../lib/settings';
import { turnstileEnabled } from '../lib/turnstile';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  invalidateSettings();
  return json({
    ok: true,
    settings: await getSettings(env),
    integrations: { turnstile: turnstileEnabled(env), searchConsole: Boolean(readServiceAccount(env)), vpnLookup: Boolean(env.PROXYCHECK_KEY), adminIpAllowList: Boolean(env.ADMIN_ALLOW_IPS), analyticsBot: Boolean(env.ANALYTICS_BOT_TOKEN && env.ANALYTICS_BOT_SECRET) },
  });
};

export const onRequestPut: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  const parsed = await readJson(request, 2048);
  if (!parsed.ok) return parsed.response;
  if (!isRecord(parsed.data) || !Object.keys(parsed.data).length) return fail(400, 'Send the settings to change.');
  const err = await saveSettings(env, parsed.data);
  if (err) return fail(400, err);
  await audit(env, request, 'settings.update', null, parsed.data);
  return json({ ok: true, settings: await getSettings(env) });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET, PUT');
