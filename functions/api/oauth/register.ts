/** POST /api/oauth/register: dynamic client registration (RFC 7591). Claude registers itself the first time a person adds the connector. */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { isRecord, json, readJson } from '../lib/http';
import { bump, clientIp, retryAfter } from '../lib/throttle';
import { CORS, MAX_REDIRECTS, cleanName, preflight, validRedirectUri } from '../lib/oauth';

const err = (status: number, error: string, description: string): Response => json({ error, error_description: description }, status, CORS);

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const rl = `oauthreg:${clientIp(request)}`;
  if (await retryAfter(env, rl, 30)) return err(429, 'temporarily_unavailable', 'Too many registrations. Try again later.');
  const body = await readJson(request, 8192);
  if (!body.ok) return err(400, 'invalid_client_metadata', 'The body must be JSON.');
  const b = body.data;
  if (!isRecord(b)) return err(400, 'invalid_client_metadata', 'The body must be a JSON object.');
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
  if (!uris.length || uris.length > MAX_REDIRECTS || !uris.every(validRedirectUri)) return err(400, 'invalid_redirect_uri', 'redirect_uris must be 1 to 5 https addresses (or http on localhost).');
  if (b.token_endpoint_auth_method !== undefined && b.token_endpoint_auth_method !== 'none') return err(400, 'invalid_client_metadata', 'Only public clients (token_endpoint_auth_method "none") are supported.');

  await bump(env, rl, 3600);
  const clientId = 'vc_' + crypto.randomUUID().replace(/-/g, '');
  const name = cleanName(b.client_name, 'MCP client');
  const redirectUris = [...new Set(uris as string[])];
  await env.DB.prepare('INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES (?1, ?2, ?3)').bind(clientId, name, JSON.stringify(redirectUris)).run();
  return json({
    client_id: clientId, client_name: name, redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
  }, 201, CORS);
};

export const onRequestOptions: PagesFunction<Env> = async () => preflight();
export const onRequest: PagesFunction<Env> = async () => json({ error: 'invalid_request' }, 405, { ...CORS, Allow: 'POST, OPTIONS' });
