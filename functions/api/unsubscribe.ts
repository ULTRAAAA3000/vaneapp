import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../types';
import { fail, json, methodNotAllowed } from './lib/http';
import { isOptedOut, setOptOut, validUnsubscribe } from './lib/unsubscribe';

async function params(request: Request): Promise<{ e: string; t: string; again: boolean }> {
  const url = new URL(request.url);
  let e = url.searchParams.get('e') ?? '';
  let t = url.searchParams.get('t') ?? '';
  let again = false;
  if (request.method === 'POST' && (request.headers.get('content-type') ?? '').includes('json')) {
    const b = (await request.json().catch(() => null)) as { e?: unknown; t?: unknown; resubscribe?: unknown } | null;
    if (b && typeof b.e === 'string') e = b.e;
    if (b && typeof b.t === 'string') t = b.t;
    again = b?.resubscribe === true;
  }
  return { e: e.trim().toLowerCase().slice(0, 254), t: t.slice(0, 100), again };
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const { e, t } = await params(request);
  if (!(await validUnsubscribe(env, e, t))) return fail(400, 'This link is not valid.');
  return json({ ok: true, email: e, optedOut: await isOptedOut(env, e) });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const { e, t, again } = await params(request);
  if (!(await validUnsubscribe(env, e, t))) return fail(400, 'This link is not valid.');
  await setOptOut(env, e, !again);
  return json({ ok: true, email: e, optedOut: !again });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET, POST');
