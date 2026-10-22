/** GET /api/billing/config → which ways to pay are switched on (the checkout page shows only those). */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { json, methodNotAllowed } from '../lib/http';
import { billingMethods } from '../lib/billing';
import { SOLANA_ASSETS } from '../lib/solana';

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const methods = billingMethods(env);
  return json({ ok: true, methods, cryptoAssets: methods.crypto ? Object.entries(SOLANA_ASSETS).map(([id, a]) => ({ id, label: a.label })) : [] }, 200, { 'Cache-Control': 'public, max-age=30' });
};
export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
