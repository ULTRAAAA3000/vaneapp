/** Small HTTP helpers shared by all API routes. */

export const json = (body: unknown, status = 200, extra: HeadersInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });

export const fail = (status: number, error: string, extra: HeadersInit = {}): Response =>
  json({ ok: false, error }, status, extra);

export const methodNotAllowed = (allow: string): Response =>
  fail(405, 'Method not allowed', { Allow: allow });

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BodyResult = { ok: true; data: unknown } | { ok: false; response: Response };

/** Reads a JSON body with content-type and size guards. */
export async function readJson(request: Request, maxBytes = 32_768): Promise<BodyResult> {
  const ct = request.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    return { ok: false, response: fail(415, 'Content-Type must be application/json') };
  }
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > maxBytes) return { ok: false, response: fail(413, 'Request body is too large') };

  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: fail(400, 'Could not read request body') };
  }
  if (text.length > maxBytes) return { ok: false, response: fail(413, 'Request body is too large') };

  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, response: fail(400, 'Invalid JSON body') };
  }
}

/**
 * CSRF guard for cookie-authenticated requests. Browsers always attach Origin /
 * Sec-Fetch-Site to cross-site requests and scripts cannot forge them, so a mismatch
 * means "another website is driving the user's browser".
 * (SameSite=Lax on the cookie is the first line of defence; this is the second.)
 */
export function crossOriginViolation(request: Request): Response | null {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return fail(403, 'Cross-origin request blocked');
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return fail(403, 'Cross-origin request blocked');
  return null;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
