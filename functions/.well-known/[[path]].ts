/** /.well-known/oauth-protected-resource and /.well-known/oauth-authorization-server: how an MCP client (Claude) finds the sign-in of the connector. */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../types';
import { CORS, issuerOf, mcpUrl, preflight } from '../api/lib/oauth';

const answer = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300', ...CORS } });

export const onRequest: PagesFunction<Env> = async ({ request }) => {
  if (request.method === 'OPTIONS') return preflight();
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD', ...CORS } });
  const path = new URL(request.url).pathname;
  const issuer = issuerOf(request);

  if (path === '/.well-known/oauth-protected-resource' || path.startsWith('/.well-known/oauth-protected-resource/')) {
    return answer({ resource: mcpUrl(request), authorization_servers: [issuer], bearer_methods_supported: ['header'], scopes_supported: ['vane'], resource_name: 'Vane' });
  }
  if (path === '/.well-known/oauth-authorization-server' || path.startsWith('/.well-known/oauth-authorization-server/')) {
    return answer({
      issuer,
      authorization_endpoint: `${issuer}/connect`,
      token_endpoint: `${issuer}/api/oauth/token`,
      registration_endpoint: `${issuer}/api/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['vane'],
    });
  }
  return new Response('Not found', { status: 404, headers: CORS });
};
