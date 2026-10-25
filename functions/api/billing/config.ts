/** GET /api/billing/config → which ways to pay are switched on (the checkout page shows only those). */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { json, methodNotAllowed } from '../lib/http';
import { billingMethods, previewActive } from '../lib/billing';
import { SOLANA_ASSETS } from '../lib/solana';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const real = billingMethods(env);
  const preview = !real.monobank && !real.crypto && (await previewActive(env, request));
  const methods = preview ? { monobank: true, crypto: true } : real;
  const cryptoAssets = methods.crypto ? Object.entries(SOLANA_ASSETS).map(([id, a]) => ({ id, label: a.label })) : [];
  return json({ ok: true, methods, cryptoAssets, preview }, 200, { 'Cache-Control': preview ? 'no-store' : 'public, max-age=30' });
};
export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
