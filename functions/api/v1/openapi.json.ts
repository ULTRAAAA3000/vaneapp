/**
 * GET /api/v1/openapi.json → the OpenAPI 3.1 description of this API (public: it contains no secrets).
 * Paste the URL into a Custom GPT (Actions → Import from URL), Postman or Make.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { fail } from '../lib/http';
import { openApiDocument } from '../lib/openapi';

export const onRequestGet: PagesFunction<Env> = async ({ request }) =>
  new Response(JSON.stringify(openApiDocument(new URL(request.url).origin), null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      // A browser-based tool (Swagger UI, Postman web) may fetch it; there is nothing private in it.
      'Access-Control-Allow-Origin': '*',
    },
  });

export const onRequest: PagesFunction<Env> = async () => fail(405, 'Method not allowed', { Allow: 'GET' });
