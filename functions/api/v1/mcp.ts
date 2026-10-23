/**
 * Claude connector: a remote MCP server (Model Context Protocol, "Streamable HTTP", stateless JSON).
 *
 *   POST /api/v1/mcp        Authorization: Bearer cpost_live_…
 *
 * Tools (AUTOMATION_INTEGRATIONS.md §5):
 *   vane_list_channels   my connected channels
 *   vane_create_post     text, channels, scheduled_at (+ optional media_url)
 *
 * It adds no logic of its own: every tool call is run through the very same handlers as the public REST API
 * (/api/v1/channels and /api/v1/posts), so the key check, the rate limit, the plan quota, the 402 and
 * the cpost_test_ "simulated" mode behave exactly as for any other API client.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { json, isRecord, methodNotAllowed } from '../lib/http';
import { sha256Hex } from '../lib/session';
import { onRequestGet as listChannels } from './channels/index';
import { onRequestPost as createPost } from './posts/index';
import { markMcpInternal, recordMcpCall } from '../lib/integrations';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY = 65_536;
/** When the model gives no time: a couple of minutes ahead (the API only accepts the future). */
const DEFAULT_DELAY_SECONDS = 120;

const TOOLS = [
  {
    name: 'vane_list_channels',
    description: 'List the social channels connected to the user\'s Vane account (id, platform, name). Call this first to know where a post can go.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'vane_create_post',
    description: 'Schedule a post with Vane to one or more connected channels. It is published at scheduled_at (or in about two minutes when omitted). Always tell the user what was scheduled and where.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text of the post.' },
        channels: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Where to post: channel ids, channel names or platform names from vane_list_channels (e.g. "telegram", "bluesky", "mastodon").',
        },
        scheduled_at: { type: 'string', description: 'When to publish: ISO-8601 time WITH timezone, e.g. 2026-10-20T09:00:00Z. Optional.' },
        media_url: { type: 'string', description: 'Optional https URL of one image to attach.' },
      },
      required: ['text', 'channels'],
      additionalProperties: false,
    },
  },
];

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown };
type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const rpcResult = (id: Rpc['id'], result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });
const rpcError = (id: Rpc['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

type Ctx = Parameters<PagesFunction<Env>>[0];

/** Runs a REST handler in-process, with the caller's own Authorization header. */
async function callApi(env: Env, request: Request, handler: PagesFunction<Env>, method: 'GET' | 'POST', path: string, body?: unknown, extra: HeadersInit = {}): Promise<{ status: number; data: any }> {
  const headers = new Headers(extra);
  const auth = request.headers.get('authorization');
  if (auth) headers.set('authorization', auth);
  if (body !== undefined) headers.set('content-type', 'application/json');
  const inner = new Request(new URL(path, request.url).toString(), { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  // Tells the key check this is Claude's MCP call (attributed to it, and counted once as the tool call, not once per inner request).
  markMcpInternal(inner, request);
  const res = await handler({ request: inner, env, params: {}, data: {}, waitUntil: () => {}, next: async () => new Response(null, { status: 404 }), functionPath: path } as unknown as Ctx);
  let data: any = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, data };
}

const apiProblem = (status: number, data: any): ToolResult =>
  text(
    status === 401 ? 'Vane rejected the API key. Check VANE_API_KEY (a key looks like cpost_live_…; create one in the Vane dashboard).'
      : `Vane could not do that (${status}${data?.code ? ', ' + data.code : ''}): ${data?.error ?? 'unexpected answer'}`,
    true,
  );

type Channel = { id: string; platform: string; name: string; isActive: boolean };

async function toolListChannels(env: Env, request: Request): Promise<ToolResult> {
  const r = await callApi(env, request, listChannels, 'GET', '/api/v1/channels');
  if (r.status !== 200) return apiProblem(r.status, r.data);
  const chans: Channel[] = r.data.channels ?? [];
  if (!chans.length) return text('No channels are connected yet. The user can connect one in the Vane dashboard.');
  return text(chans.map((c) => `- ${c.name} (${c.platform})${c.isActive ? '' : ' [inactive]'} id=${c.id}`).join('\n'));
}

/** A name from the model → channel ids. Matches id, then exact name, then platform (all channels of it). */
function resolveChannels(wanted: string[], chans: Channel[]): { ids: string[]; missing: string[] } {
  const ids = new Set<string>();
  const missing: string[] = [];
  for (const w of wanted) {
    const q = w.trim().toLowerCase();
    const byId = chans.filter((c) => c.id.toLowerCase() === q);
    const byName = chans.filter((c) => c.name.toLowerCase() === q);
    const byPlatform = chans.filter((c) => c.platform.toLowerCase() === q && c.isActive);
    const hit = byId.length ? byId : byName.length ? byName : byPlatform;
    if (!hit.length) missing.push(w);
    for (const c of hit) ids.add(c.id);
  }
  return { ids: [...ids], missing };
}

async function toolCreatePost(env: Env, request: Request, args: Record<string, unknown>): Promise<ToolResult> {
  const content = typeof args.text === 'string' ? args.text : '';
  const wanted = Array.isArray(args.channels) ? args.channels.filter((c): c is string => typeof c === 'string') : [];
  if (!content.trim()) return text('text is required.', true);
  if (!wanted.length) return text('channels is required: at least one channel (see vane_list_channels).', true);

  const list = await callApi(env, request, listChannels, 'GET', '/api/v1/channels');
  if (list.status !== 200) return apiProblem(list.status, list.data);
  const chans: Channel[] = list.data.channels ?? [];
  const { ids, missing } = resolveChannels(wanted, chans);
  if (missing.length) {
    return text(`No such channel: ${missing.join(', ')}. Connected: ${chans.map((c) => `${c.name} (${c.platform})`).join(', ') || 'none'}.`, true);
  }

  const scheduledAt = typeof args.scheduled_at === 'string' && args.scheduled_at.trim()
    ? args.scheduled_at.trim()
    : new Date(Date.now() + DEFAULT_DELAY_SECONDS * 1000).toISOString();
  const body: Record<string, unknown> = { content, channelIds: ids, scheduledAt };
  if (typeof args.media_url === 'string' && args.media_url.trim()) body.mediaUrl = args.media_url.trim();

  // A model that retries the same call must not post twice: the key comes from what was asked
  // (only when it named the time itself, otherwise "now + 2 min" would make every retry different).
  const extra: HeadersInit = typeof args.scheduled_at === 'string' && args.scheduled_at.trim()
    ? { 'idempotency-key': 'mcp-' + (await sha256Hex(JSON.stringify([content, [...ids].sort(), scheduledAt, body.mediaUrl ?? null]))).slice(0, 40) }
    : {};
  const r = await callApi(env, request, createPost, 'POST', '/api/v1/posts', body, extra);
  if (r.status !== 201) return apiProblem(r.status, r.data);

  const names = chans.filter((c) => ids.includes(c.id)).map((c) => `${c.name} (${c.platform})`).join(', ');
  const when = new Date(r.data.scheduledAt * 1000).toISOString();
  return text(`${r.data.test ? 'TEST MODE (nothing was saved or posted): ' : ''}Scheduled for ${when} on ${names}. Group id: ${r.data.groupId}.`);
}

async function handle(env: Env, request: Request, msg: Rpc): Promise<unknown | null> {
  const id = msg.id;
  // Notifications (no id) get no answer.
  if (id === undefined || id === null) return null;
  switch (msg.method) {
    case 'initialize': {
      const asked = isRecord(msg.params) && typeof msg.params.protocolVersion === 'string' ? msg.params.protocolVersion : '';
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'vane', version: '1.0.0' },
        instructions: 'Vane schedules social posts. Use vane_list_channels to see connected channels, then vane_create_post.',
      });
    }
    case 'ping': return rpcResult(id, {});
    case 'tools/list': return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const p = isRecord(msg.params) ? msg.params : {};
      const args = isRecord(p.arguments) ? p.arguments : {};
      if (p.name === 'vane_list_channels') { const r = await toolListChannels(env, request); await recordMcpCall(env, request, 'vane_list_channels'); return rpcResult(id, r); }
      if (p.name === 'vane_create_post') { const r = await toolCreatePost(env, request, args); await recordMcpCall(env, request, 'vane_create_post'); return rpcResult(id, r); }
      return rpcError(id, -32602, `Unknown tool: ${String(p.name)}`);
    }
    default: return rpcError(id, -32601, `Method not found: ${String(msg.method)}`);
  }
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return json(rpcError(null, -32600, 'Request too large'), 413);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json(rpcError(null, -32600, 'Request too large'), 413);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return json(rpcError(null, -32700, 'Parse error'), 400); }

  const batch = Array.isArray(body);
  const msgs = (batch ? (body as unknown[]) : [body]).slice(0, 20);
  const out: unknown[] = [];
  for (const m of msgs) {
    if (!isRecord(m) || m.jsonrpc !== '2.0') { out.push(rpcError(null, -32600, 'Invalid Request')); continue; }
    const a = await handle(env, request, m as Rpc);
    if (a) out.push(a);
  }
  if (!out.length) return new Response(null, { status: 202 });
  return json(batch ? out : out[0]);
};

// The server never pushes anything, so there is no SSE stream to open.
export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');
