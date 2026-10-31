/**
 * The "Agents" tab of the dashboard: what an AI assistant or an integration did with your Vane account (see lib/agentlog.ts).
 *   GET    /api/agent-log?after=<id>&limit=60&integration=claude → { ok, events: [{ id, at, integration, via, tool, ok, message }], latest }
 *            without `after`: the newest `limit` lines, oldest first; with it: only lines newer than that cursor (the tab polls with it).
 *   DELETE /api/agent-log                                         → wipes your lines
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../types';
import { requireUser } from './lib/auth';
import { clearAgentEvents, listAgentEvents } from './lib/agentlog';
import { json, methodNotAllowed } from './lib/http';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const q = new URL(request.url).searchParams;
  const out = await listAgentEvents(env, auth.userId, { after: Number(q.get('after')) || 0, limit: Number(q.get('limit')) || 60, integration: q.get('integration') });
  return json({ ok: true, ...out });
};

export const onRequestDelete: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  await clearAgentEvents(env, auth.userId).catch(() => undefined);
  return json({ ok: true });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET, DELETE');
