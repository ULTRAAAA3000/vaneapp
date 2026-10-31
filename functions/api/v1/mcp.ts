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
import { forcedKeyOf, forceKeyId } from '../lib/apikeys';
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { json, isRecord, methodNotAllowed } from '../lib/http';
import { sha256Hex } from '../lib/session';
import { onRequestGet as listChannels } from './channels/index';
import { onRequestGet as listPosts, onRequestPost as createPost } from './posts/index';
import { authOf, markMcpClient, markMcpInternal, recordMcpCall, rememberAuth } from '../lib/integrations';
import { mcpLine, plural, recordAgentEvent, refusal, utc } from '../lib/agentlog';
import { ACCESS_PREFIX, CORS, grantForAccessToken, preflight, resourceMetadataUrl } from '../lib/oauth';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY = 65_536;
/** When the model gives no time: a couple of minutes ahead (the API only accepts the future). */
const DEFAULT_DELAY_SECONDS = 120;

const TOOLS = [
  {
    name: 'vane_list_channels',
    title: 'List my channels',
    description: 'List the social channels connected to the user\'s Vane account (id, platform, name). Call this first to know where a post can go.',
    annotations: { title: 'List my channels', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'vane_list_posts',
    title: 'List my posts',
    description: 'List the user\'s Vane posts: view "upcoming" (scheduled, soonest first) or "history" (sent, failed or cancelled, newest first). Use it to answer "what is scheduled?" or "did it go out?".',
    annotations: { title: 'List my posts', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { view: { type: 'string', enum: ['upcoming', 'history'], description: 'upcoming (default) or history.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'vane_create_post',
    title: 'Schedule a post',
    annotations: { title: 'Schedule a post', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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

/** Slash commands: Claude lists MCP prompts as /commands, so a person types "/vane:post …" and Claude knows what to do. */
const PROMPTS = [
  {
    name: 'post', title: 'Post', description: 'Schedule a post you wrote, as it is.',
    arguments: [
      { name: 'text', description: 'The text to post.', required: true },
      { name: 'channels', description: 'Where, e.g. "telegram, bluesky". Empty: Claude asks.' },
      { name: 'when', description: 'When, e.g. "tomorrow 9:00". Empty: in a couple of minutes.' },
    ],
  },
  {
    name: 'draft', title: 'Write and post', description: 'Claude writes the post for you, shows it, and schedules it once you approve.',
    arguments: [
      { name: 'topic', description: 'What the post is about.', required: true },
      { name: 'channels', description: 'Where, e.g. "bluesky, mastodon".' },
      { name: 'tone', description: 'Tone or style, e.g. "friendly", "short and punchy".' },
    ],
  },
  { name: 'channels', title: 'My channels', description: 'Show the channels connected to Vane.', arguments: [] },
  { name: 'upcoming', title: 'Scheduled posts', description: 'Show what is scheduled.', arguments: [] },
  { name: 'recent', title: 'Recent posts', description: 'Show what went out lately and what failed.', arguments: [] },
];

const argText = (args: Record<string, unknown>, key: string, max: number): string => (typeof args[key] === 'string' ? (args[key] as string).replace(/\u0000/g, '').trim().slice(0, max) : '');

/** What Claude receives when a command is used. The person's own words are quoted as content, never as instructions about tools. */
function promptText(name: string, args: Record<string, unknown>): string | null {
  const channels = argText(args, 'channels', 300);
  if (name === 'post') {
    const text = argText(args, 'text', 10000);
    if (!text) return null;
    const when = argText(args, 'when', 100);
    return `Use Vane to schedule this post exactly as written, without changing a word:\n\n"""\n${text}\n"""\n\n`
      + (channels ? `Channels: ${channels}.` : 'Channels: not specified. Call vane_list_channels and ask which ones to use before posting.')
      + (when ? `\nWhen: ${when} (convert it to an ISO-8601 time with a timezone; ask if the timezone is unclear).` : '\nWhen: not specified, so use the default (in a couple of minutes).')
      + '\nThen confirm in one line what was scheduled and where.';
  }
  if (name === 'draft') {
    const topic = argText(args, 'topic', 1000);
    if (!topic) return null;
    const tone = argText(args, 'tone', 100);
    return `Write a social post with Vane in mind.\n\nTopic: ${topic}\n`
      + (tone ? `Tone: ${tone}\n` : '')
      + (channels ? `Channels: ${channels}\n` : 'Channels: call vane_list_channels and suggest the best fit.\n')
      + '\nWrite the post yourself (no other tool is needed for the writing), keep it inside the character limit of the smallest chosen network (Bluesky 300, Mastodon 500, Threads 500, X 280, Telegram 4096), and show it to me. Do NOT schedule it yet: wait until I approve or ask for changes, then use vane_create_post.';
  }
  if (name === 'channels') return 'Call vane_list_channels and show my Vane channels as a short list.';
  if (name === 'upcoming') return 'Call vane_list_posts with view "upcoming" and summarise what is scheduled: when, where, and the start of each text.';
  if (name === 'recent') return 'Call vane_list_posts with view "history" and tell me what went out lately and what failed (with the reason).';
  return null;
}

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown };
type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const rpcResult = (id: Rpc['id'], result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });
const rpcError = (id: Rpc['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

type Ctx = Parameters<PagesFunction<Env>>[0];

/** What a tool call came to, for the agent log (the line the person sees in the "Agents" tab): never the post text, only counts, times, codes. */
const outcomes = new WeakMap<Request, { args: string; ok: boolean; summary: string }>();
const note = (request: Request, args: string, ok: boolean, summary: string): void => { outcomes.set(request, { args, ok, summary }); };

async function logTool(env: Env, request: Request, tool: string, r: ToolResult): Promise<void> {
  const who = authOf(request);
  if (!who) return;
  const o = outcomes.get(request) ?? { args: '', ok: !r.isError, summary: r.isError ? 'failed' : 'done' };
  outcomes.delete(request);
  await recordAgentEvent(env, { userId: who.userId, integration: who.integration, via: 'mcp', tool, ok: o.ok, message: mcpLine(tool, o.args, o.summary) });
}

/** Runs a REST handler in-process, with the caller's own Authorization header. */
async function callApi(env: Env, request: Request, handler: PagesFunction<Env>, method: 'GET' | 'POST', path: string, body?: unknown, extra: HeadersInit = {}): Promise<{ status: number; data: any }> {
  const headers = new Headers(extra);
  const auth = request.headers.get('authorization');
  if (auth) headers.set('authorization', auth);
  const forced = forcedKeyOf(request);
  if (body !== undefined) headers.set('content-type', 'application/json');
  const inner = new Request(new URL(path, request.url).toString(), { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  // Tells the key check this is Claude's MCP call (attributed to it, and counted once as the tool call, not once per inner request).
  markMcpInternal(inner, request);
  if (forced) forceKeyId(inner, forced);
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
  if (r.status !== 200) { note(request, '', false, refusal(r.status, r.data)); return apiProblem(r.status, r.data); }
  const chans: Channel[] = r.data.channels ?? [];
  note(request, '', true, `${plural(chans.length, 'channel')} found`);
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

const SHORT = (t: string, n: number): string => (t.length > n ? t.slice(0, n - 1) + '…' : t);

async function toolListPosts(env: Env, request: Request, args: Record<string, unknown>): Promise<ToolResult> {
  const view = args.view === 'history' ? 'history' : 'upcoming';
  const r = await callApi(env, request, listPosts, 'GET', `/api/v1/posts?view=${view}`);
  if (r.status !== 200) { note(request, view, false, refusal(r.status, r.data)); return apiProblem(r.status, r.data); }
  type Item = { groupId: string; channelName: string; platform: string; content: string; scheduledAt: number; status: string; error: string | null; url: string | null };
  const posts: Item[] = r.data.posts ?? [];
  note(request, view, true, `${plural(new Set(posts.map((p) => p.groupId)).size, view === 'upcoming' ? 'scheduled post' : 'post')} found`);
  if (!posts.length) return text(view === 'upcoming' ? 'Nothing is scheduled.' : 'No posts have been sent yet.');
  const groups = new Map<string, Item[]>();
  for (const p of posts) groups.set(p.groupId, [...(groups.get(p.groupId) ?? []), p]);
  const lines = [...groups.values()].slice(0, 20).map((g) => {
    const where = g.map((p) => `${p.channelName} (${p.platform}${view === 'history' ? ', ' + p.status + (p.error ? ': ' + SHORT(p.error, 120) : '') + (p.url ? ', ' + p.url : '') : ''})`).join('; ');
    return `- ${new Date(g[0].scheduledAt * 1000).toISOString()} · ${where} · "${SHORT(g[0].content.replace(/\s+/g, ' '), 140)}"`;
  });
  return text(lines.join('\n') + (groups.size > 20 ? `\n… and ${groups.size - 20} more.` : ''));
}

async function toolCreatePost(env: Env, request: Request, args: Record<string, unknown>): Promise<ToolResult> {
  const content = typeof args.text === 'string' ? args.text : '';
  const wanted = Array.isArray(args.channels) ? args.channels.filter((c): c is string => typeof c === 'string') : [];
  if (!content.trim()) { note(request, '', false, 'refused: text is required'); return text('text is required.', true); }
  if (!wanted.length) { note(request, '', false, 'refused: channels is required'); return text('channels is required: at least one channel (see vane_list_channels).', true); }

  const list = await callApi(env, request, listChannels, 'GET', '/api/v1/channels');
  if (list.status !== 200) { note(request, plural(wanted.length, 'channel'), false, refusal(list.status, list.data)); return apiProblem(list.status, list.data); }
  const chans: Channel[] = list.data.channels ?? [];
  const { ids, missing } = resolveChannels(wanted, chans);
  if (missing.length) {
    note(request, plural(wanted.length, 'channel'), false, `refused: ${plural(missing.length, 'unknown channel')}`);
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
  if (r.status !== 201) { note(request, plural(ids.length, 'channel'), false, refusal(r.status, r.data)); return apiProblem(r.status, r.data); }
  note(request, plural(ids.length, 'channel'), true, r.data.test ? 'TEST MODE, nothing posted' : `scheduled for ${utc(r.data.scheduledAt)}`);

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
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: 'vane', version: '1.0.0' },
        instructions: 'Vane schedules social posts. Use vane_list_channels to see connected channels, then vane_create_post. vane_list_posts shows what is scheduled or was sent. Never post unless the user asked for it.',
      });
    }
    case 'ping': return rpcResult(id, {});
    case 'tools/list': return rpcResult(id, { tools: TOOLS });
    case 'prompts/list': return rpcResult(id, { prompts: PROMPTS });
    case 'prompts/get': {
      const p = isRecord(msg.params) ? msg.params : {};
      const name = typeof p.name === 'string' ? p.name : '';
      const known = PROMPTS.find((x) => x.name === name);
      if (!known) return rpcError(id, -32602, `Unknown prompt: ${name.slice(0, 40)}`);
      const body = promptText(name, isRecord(p.arguments) ? p.arguments : {});
      if (!body) return rpcError(id, -32602, `Missing a required argument for "${name}".`);
      return rpcResult(id, { description: known.description, messages: [{ role: 'user', content: { type: 'text', text: body } }] });
    }
    case 'tools/call': {
      const p = isRecord(msg.params) ? msg.params : {};
      const args = isRecord(p.arguments) ? p.arguments : {};
      const finish = async (tool: string, r: ToolResult) => { await recordMcpCall(env, request, tool); await logTool(env, request, tool, r); return rpcResult(id, r); };
      if (p.name === 'vane_list_channels') return finish('vane_list_channels', await toolListChannels(env, request));
      if (p.name === 'vane_list_posts') return finish('vane_list_posts', await toolListPosts(env, request, args));
      if (p.name === 'vane_create_post') return finish('vane_create_post', await toolCreatePost(env, request, args));
      return rpcError(id, -32602, `Unknown tool: ${String(p.name)}`);
    }
    default: return rpcError(id, -32601, `Method not found: ${String(msg.method)}`);
  }
}

const unauthorized = (request: Request, invalid: boolean): Response =>
  new Response(JSON.stringify(rpcError(null, -32001, invalid ? 'The access token is invalid or expired.' : 'Sign in to Vane to use this connector.')), {
    status: 401,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl(request)}"${invalid ? ', error="invalid_token"' : ''}`, ...CORS },
  });

/**
 * Who is calling. A Vane API key (Claude Desktop config, Claude Code, scripts) goes straight through. The connector's OAuth access token
 * is swapped for the API key of its grant, so the tools below run exactly as for that key. No credentials at all → 401 pointing at the
 * OAuth discovery document: that is what makes Claude show its "Connect" button.
 */
async function authenticate(env: Env, request: Request): Promise<Request | Response> {
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '');
  if (!bearer) return unauthorized(request, false);
  if (!bearer[1].startsWith(ACCESS_PREFIX)) return request;
  const g = await grantForAccessToken(env, bearer[1], Math.floor(Date.now() / 1000));
  if (!g) return unauthorized(request, true);
  const headers = new Headers(request.headers);
  headers.delete('authorization');
  const forced = new Request(request, { headers });
  forceKeyId(forced, g.keyId);
  markMcpClient(forced, g.integration);   // a Notion agent is counted as Notion, anything else as Claude
  rememberAuth(forced, { userId: g.userId, keyId: g.keyId, integration: g.integration });   // for the agent log
  return forced;
}

export const onRequestPost: PagesFunction<Env> = async ({ request: incoming, env }) => {
  const who = await authenticate(env, incoming);
  if (who instanceof Response) return who;
  const request = who;
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
  return json(batch ? out : out[0], 200, CORS);
};

// The server never pushes anything, so there is no SSE stream to open.
export const onRequestOptions: PagesFunction<Env> = async () => preflight();
export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');
