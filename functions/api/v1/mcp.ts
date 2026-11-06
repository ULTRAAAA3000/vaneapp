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
import { forcedKeyOf, forceKeyId, requireApiKey } from '../lib/apikeys';
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { json, isRecord, methodNotAllowed } from '../lib/http';
import { sha256Hex } from '../lib/session';
import { onRequestGet as listChannels } from './channels/index';
import { onRequestGet as listPosts, onRequestPost as createPost } from './posts/index';
import { authOf, markMcpClient, markMcpInternal, recordMcpCall, rememberAuth } from '../lib/integrations';
import { mcpLine, plural, recordAgentEvent, refusal, utc } from '../lib/agentlog';
import { suggestSlots, voiceBlock } from '../lib/aiplus';
import { analyze, loadPerformance, MAX_SERIES, planSeriesTimes, renderAnalysis, type SeriesPost } from '../lib/mcppro';
import { isPaidAccount } from '../lib/paid';
import { ACCESS_PREFIX, CORS, grantForAccessToken, preflight, resourceMetadataUrl } from '../lib/oauth';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY = 65_536;
/** When the model gives no time: a couple of minutes ahead (the API only accepts the future). */
const DEFAULT_DELAY_SECONDS = 120;
/** "Post now": queued a few seconds ahead; the sender runs every minute, so it goes out within about a minute. */
const NOW_DELAY_SECONDS = 10;

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
        post_now: { type: 'boolean', description: 'true = send right away (it goes out within about a minute) instead of waiting for a time. Use it only when the user said to post now. Ignores scheduled_at.' },
        media_url: { type: 'string', description: 'Optional https URL of one image to attach.' },
      },
      required: ['text', 'channels'],
      additionalProperties: false,
    },
  },
];

/**
 * The advanced tools of the PAID plans (lib/mcppro.ts). The Free Trial's assistant sees only the three tools above: tools/list
 * leaves these out, and calling one by name answers "part of the paid plans". They never call an AI model, so they spend no AI credits.
 */
const PRO_TOOLS = [
  {
    name: 'vane_analyze_performance',
    description: 'Facts from the user\'s own sent posts and their measured results: by network, best and weakest posts, and patterns by day, time, length and media. Use it before advising what to post or change. It returns numbers and sample sizes; the advice is yours. Never invent numbers it does not give.',
    annotations: { title: 'Analyze my post performance', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 7, maximum: 180, description: 'How many days back. Default 30.' } }, additionalProperties: false },
  },
  {
    name: 'vane_best_times',
    description: 'The best free time slots for the coming days, from when the user\'s own posts got the most reactions (sensible defaults when there are not enough measured posts yet). Skips times that already have a post. Use it to choose times, then schedule with vane_create_post or vane_create_series.',
    annotations: { title: 'Best times to post', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'integer', minimum: 1, maximum: 14, description: 'How many slots. Default 5.' },
        timezone: { type: 'string', description: 'IANA time zone for the local times shown, e.g. "Europe/Kyiv". Default: the account\'s own.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'vane_get_voice',
    description: 'The user\'s saved tone of voice (their style notes and example posts, or posts they sent lately). Call it before writing posts for the user so they sound like the user. Style reference only: never copy facts or sentences from the examples.',
    annotations: { title: 'My tone of voice', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'vane_create_series',
    description: 'Schedules a whole series in ONE call (up to 14 posts, each its own text) on the same channels. You write the posts (use vane_get_voice for the voice); this puts them on the calendar. Times: per post (scheduled_at), or from start every every_hours, or by default on the best free slots (vane_best_times). Show the plan to the user and get a yes first; use dry_run: true to preview without scheduling. A retry never posts twice.',
    annotations: { title: 'Schedule a series of posts', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        posts: {
          type: 'array', minItems: 1, maxItems: 14,
          items: { type: 'object', properties: { text: { type: 'string', description: 'The post, exactly as it should go out.' }, scheduled_at: { type: 'string', description: 'Optional ISO-8601 time WITH timezone for this post.' } }, required: ['text'], additionalProperties: false },
          description: 'The posts of the series, in order.',
        },
        channels: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Channel ids, names or platform names from vane_list_channels. Every post goes to all of them.' },
        start: { type: 'string', description: 'Optional ISO-8601 time WITH timezone of the first post that has no scheduled_at of its own.' },
        every_hours: { type: 'number', minimum: 1, maximum: 168, description: 'Gap between posts when start is used (default 24).' },
        dry_run: { type: 'boolean', description: 'true = only show the plan, schedule nothing.' },
      },
      required: ['posts', 'channels'],
      additionalProperties: false,
    },
  },
];
const PRO_TOOL_NAMES = new Set(PRO_TOOLS.map((t) => t.name));

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

/** Slash commands that need the paid tools: listed only for paid accounts. */
const PRO_PROMPTS = [
  { name: 'analyze', title: 'How are my posts doing?', description: 'Reads your results and tells you what works and what to try.', arguments: [{ name: 'days', description: 'How many days back (default 30).' }] },
  {
    name: 'series', title: 'Plan a series', description: 'Writes a run of posts in your voice on the best times, shows it, and schedules it once you approve.',
    arguments: [
      { name: 'topic', description: 'What the series is about.', required: true },
      { name: 'count', description: 'How many posts (default 5, at most 14).' },
      { name: 'channels', description: 'Where, e.g. "bluesky, mastodon".' },
    ],
  },
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
      + (when ? `\nWhen: ${when} (if that means right now, call the tool with post_now true; otherwise convert it to an ISO-8601 time with a timezone and ask if the timezone is unclear).` : '\nWhen: not specified, so use the default (in a couple of minutes).')
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
  if (name === 'analyze') {
    const days = Math.min(180, Math.max(7, Number(argText(args, 'days', 4)) || 30));
    return `Call vane_analyze_performance with days ${days}. Then tell me, plainly and with the numbers it gave: what is working, what is not, and three concrete things to try next. Say how many posts the patterns rest on; if few results are measured, say so and do not invent numbers. Do not schedule anything.`;
  }
  if (name === 'series') {
    const topic = argText(args, 'topic', 1000);
    if (!topic) return null;
    const count = Math.min(14, Math.max(2, Number(argText(args, 'count', 3)) || 5));
    return `Plan a series of ${count} posts with Vane.\n\nTopic: ${topic}\n`
      + (channels ? `Channels: ${channels}\n` : 'Channels: call vane_list_channels and suggest the best fit.\n')
      + '\nSteps: (1) call vane_get_voice and write in that voice; (2) write the posts yourself, each able to stand alone and each from a different angle, inside the character limit of the smallest chosen network; (3) call vane_create_series with dry_run true (it picks the best free times) and show me a table of time and text; (4) only after I say yes, call vane_create_series again without dry_run. Never schedule before I approve.';
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

  const postNow = args.post_now === true;
  const named = !postNow && typeof args.scheduled_at === 'string' && args.scheduled_at.trim() !== '';
  const scheduledAt = postNow
    ? new Date(Date.now() + NOW_DELAY_SECONDS * 1000).toISOString()
    : named
      ? (args.scheduled_at as string).trim()
      : new Date(Date.now() + DEFAULT_DELAY_SECONDS * 1000).toISOString();
  const body: Record<string, unknown> = { content, channelIds: ids, scheduledAt };
  if (typeof args.media_url === 'string' && args.media_url.trim()) body.mediaUrl = args.media_url.trim();

  // A model that retries the same call must not post twice: the key comes from what was asked
  // (only when it named the time itself, otherwise "now + 2 min" would make every retry different).
  const extra: HeadersInit = named || postNow
    ? { 'idempotency-key': 'mcp-' + (await sha256Hex(JSON.stringify([content, [...ids].sort(), postNow ? 'now:' + Math.floor(Date.now() / 60000) : scheduledAt, body.mediaUrl ?? null]))).slice(0, 40) }
    : {};
  const r = await callApi(env, request, createPost, 'POST', '/api/v1/posts', body, extra);
  if (r.status !== 201) { note(request, plural(ids.length, 'channel'), false, refusal(r.status, r.data)); return apiProblem(r.status, r.data); }
  note(request, plural(ids.length, 'channel'), true, r.data.test ? 'TEST MODE, nothing posted' : postNow ? 'sent now (goes out within about a minute)' : `scheduled for ${utc(r.data.scheduledAt)}`);

  const names = chans.filter((c) => ids.includes(c.id)).map((c) => `${c.name} (${c.platform})`).join(', ');
  const when = new Date(r.data.scheduledAt * 1000).toISOString();
  return text(`${r.data.test ? 'TEST MODE (nothing was saved or posted): ' : ''}${postNow ? 'Sending now (it goes out within about a minute)' : `Scheduled for ${when}`} on ${names}. Group id: ${r.data.groupId}.`);
}

const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : dflt);
const PAID_ONLY = 'This tool is part of the paid plans of Vane (Pro, the Suite…). Tell the user it needs a paid plan; the basic tools (list channels, list posts, schedule a post) keep working.';

async function userTimeZone(env: Env, userId: string, asked: unknown): Promise<string> {
  const valid = (z: string): boolean => { try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch { return false; } };
  if (typeof asked === 'string' && asked.trim() && valid(asked.trim())) return asked.trim();
  const row = await env.DB.prepare('SELECT timezone FROM users WHERE id = ?1').bind(userId).first<{ timezone: string | null }>().catch(() => null);
  return row?.timezone && valid(row.timezone) ? row.timezone : 'UTC';
}
const localTime = (sec: number, tz: string): string => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(sec * 1000));

async function toolAnalyze(env: Env, request: Request, args: Record<string, unknown>): Promise<ToolResult> {
  const who = authOf(request);
  if (!who) return text('Not signed in.', true);
  const days = clampInt(args.days, 7, 180, 30);
  const rows = await loadPerformance(env, who.userId, Math.floor(Date.now() / 1000) - days * 86400);
  const a = analyze(rows);
  note(request, `${days} days`, true, `${plural(a.total, 'post')} analysed, ${a.measured} with results`);
  return text(renderAnalysis(a, days));
}

async function toolBestTimes(env: Env, request: Request, args: Record<string, unknown>): Promise<ToolResult> {
  const who = authOf(request);
  if (!who) return text('Not signed in.', true);
  const count = clampInt(args.count, 1, 14, 5);
  const tz = await userTimeZone(env, who.userId, args.timezone);
  const r = await suggestSlots(env, who.userId, count, Math.floor(Date.now() / 1000), tz);
  note(request, String(count), true, `${plural(r.slots.length, 'slot')} found${r.personal ? '' : ' (defaults)'}`);
  if (!r.slots.length) return text('No free slot was found in the coming days. Ask the user for a time.');
  const head = r.personal
    ? 'Based on when the user\'s own posts got the most reactions (last 180 days). Times already taken by a scheduled post are skipped.'
    : 'Not enough measured results yet, so these are sensible defaults (morning, midday, evening), skipping times that already have a post. Say so; do not present them as personal.';
  return text([head, `Local time zone: ${r.timeZone}`, ...r.slots.map((at, i) => `${i + 1}. ${new Date(at * 1000).toISOString()} (${localTime(at, r.timeZone)})`)].join('\n'));
}

async function toolGetVoice(env: Env, request: Request): Promise<ToolResult> {
  const who = authOf(request);
  if (!who) return text('Not signed in.', true);
  const v = await voiceBlock(env, who.userId);
  note(request, '', true, v.text ? (v.source === 'manual' ? 'saved voice returned' : 'voice learned from recent posts') : 'no voice saved yet');
  if (!v.text) return text('No tone of voice is saved yet, and there are too few sent posts to learn it from. Ask the user how they want to sound, or write neutrally. (They can save a voice in the Vane dashboard, AI tab.)');
  return text(`${v.text}\n\nUse it as a style reference only: never copy facts or sentences from the examples.`);
}

async function toolCreateSeries(env: Env, request: Request, args: Record<string, unknown>): Promise<ToolResult> {
  const who = authOf(request);
  if (!who) return text('Not signed in.', true);
  const refuse = (why: string, msg: string): ToolResult => { note(request, '', false, `refused: ${why}`); return text(msg, true); };

  const raw = Array.isArray(args.posts) ? args.posts : [];
  if (!raw.length) return refuse('no posts', 'posts is required: 1 to ' + MAX_SERIES + ' posts, each { text, scheduled_at? }.');
  if (raw.length > MAX_SERIES) return refuse('too many posts', `A series has at most ${MAX_SERIES} posts per call (you sent ${raw.length}). Send the rest in a second call.`);
  const posts: SeriesPost[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    const t = isRecord(r) && typeof r.text === 'string' ? r.text.replace(/\u0000/g, '').trim() : '';
    if (!t) return refuse('empty text', `Post ${i + 1} has no text.`);
    let at: number | undefined;
    if (isRecord(r) && typeof r.scheduled_at === 'string' && r.scheduled_at.trim()) {
      const ms = Date.parse(r.scheduled_at.trim());
      if (Number.isNaN(ms)) return refuse('bad time', `Post ${i + 1}: scheduled_at is not an ISO-8601 time with a timezone.`);
      at = Math.floor(ms / 1000);
    }
    posts.push({ text: t, at });
  }
  const wanted = Array.isArray(args.channels) ? args.channels.filter((c): c is string => typeof c === 'string' && c.trim() !== '') : [];
  if (!wanted.length) return refuse('no channels', 'channels is required: at least one channel (see vane_list_channels).');

  const list = await callApi(env, request, listChannels, 'GET', '/api/v1/channels');
  if (list.status !== 200) { note(request, plural(raw.length, 'post'), false, refusal(list.status, list.data)); return apiProblem(list.status, list.data); }
  const chans: Channel[] = list.data.channels ?? [];
  const { ids, missing } = resolveChannels(wanted, chans);
  if (missing.length) return refuse(`${plural(missing.length, 'unknown channel')}`, `No such channel: ${missing.join(', ')}. Connected: ${chans.map((c) => `${c.name} (${c.platform})`).join(', ') || 'none'}.`);

  const now = Math.floor(Date.now() / 1000);
  let start: number | undefined;
  if (typeof args.start === 'string' && args.start.trim()) {
    const ms = Date.parse(args.start.trim());
    if (Number.isNaN(ms)) return refuse('bad start', 'start is not an ISO-8601 time with a timezone.');
    start = Math.floor(ms / 1000);
  }
  const everySeconds = Math.round(Math.min(168, Math.max(1, typeof args.every_hours === 'number' && Number.isFinite(args.every_hours) ? args.every_hours : 24)) * 3600);
  const loose = posts.filter((p) => p.at === undefined).length;
  const slots = start === undefined && loose ? (await suggestSlots(env, who.userId, loose, now, await userTimeZone(env, who.userId, undefined))).slots : [];
  const plan = planSeriesTimes(posts, { now, start, everySeconds, slots });
  if ('error' in plan) return refuse('bad times', plan.error);

  const names = chans.filter((c) => ids.includes(c.id)).map((c) => `${c.name} (${c.platform})`).join(', ');
  const rows = posts.map((p, i) => `${i + 1}. ${new Date(plan.times[i] * 1000).toISOString()} · "${SHORT(p.text.replace(/\s+/g, ' '), 90)}"`);
  const args0 = `${plural(posts.length, 'post')}, ${plural(ids.length, 'channel')}`;
  if (args.dry_run === true) {
    note(request, args0, true, 'dry run, nothing scheduled');
    return text(`DRY RUN, nothing was scheduled. The plan, on ${names}:\n${rows.join('\n')}\nShow it to the user; schedule it with the same call without dry_run once they agree.`);
  }

  const done: string[] = [];
  let testMode = false;
  for (let i = 0; i < posts.length; i++) {
    const iso = new Date(plan.times[i] * 1000).toISOString();
    const key = 'mcp-series-' + (await sha256Hex(JSON.stringify([posts[i].text, [...ids].sort(), iso]))).slice(0, 36);   // a retried call never posts twice
    const r = await callApi(env, request, createPost, 'POST', '/api/v1/posts', { content: posts[i].text, channelIds: ids, scheduledAt: iso }, { 'idempotency-key': key });
    if (r.status !== 201) {
      note(request, args0, false, `${done.length} of ${posts.length} scheduled, then ${refusal(r.status, r.data)}`);
      return text(`Stopped at post ${i + 1} of ${posts.length}: ${r.data?.error ?? 'unexpected answer'}${r.data?.code ? ` (${r.data.code})` : ''}.\n${done.length ? `Already scheduled (${done.length}):\n${done.join('\n')}\n` : 'Nothing was scheduled before the stop.\n'}Posts ${i + 1} to ${posts.length} are NOT scheduled. Fix the cause and call again with the remaining posts (repeating a post that is already scheduled is safe: it is not posted twice).`, true);
    }
    if (r.data.test) testMode = true;
    done.push(`${i + 1}. ${iso} · group ${r.data.groupId}`);
  }
  note(request, args0, true, testMode ? `TEST MODE, ${plural(done.length, 'post')} checked, nothing posted` : `${plural(done.length, 'post')} scheduled, first ${utc(plan.times[0])}`);
  return text(`${testMode ? 'TEST MODE (nothing was saved or posted): ' : ''}${done.length} of ${posts.length} posts scheduled on ${names}:\n${done.join('\n')}`);
}

/** Is the account behind this MCP call on a paid plan? (Decides the tool list, and guards the paid tools when one is called by name.) */
const paidFor = async (env: Env, request: Request): Promise<boolean> => { const who = authOf(request); return who ? isPaidAccount(env, who.userId) : false; };

async function handle(env: Env, request: Request, msg: Rpc): Promise<unknown | null> {
  const id = msg.id;
  // Notifications (no id) get no answer.
  if (id === undefined || id === null) return null;
  switch (msg.method) {
    case 'initialize': {
      const paid = await paidFor(env, request);
      const asked = isRecord(msg.params) && typeof msg.params.protocolVersion === 'string' ? msg.params.protocolVersion : '';
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: 'vane', version: '1.0.0' },
        instructions: 'Vane schedules social posts. Use vane_list_channels to see connected channels, then vane_create_post (post_now: true sends it right away, within about a minute). vane_list_posts shows what is scheduled or was sent. Never post unless the user asked for it.' + (paid ? ' This account is on a paid plan, so you also have vane_analyze_performance (what works), vane_best_times (when to post), vane_get_voice (how the user sounds) and vane_create_series (schedule up to 14 posts in one call, dry_run first).' : ''),
      });
    }
    case 'ping': return rpcResult(id, {});
    case 'tools/list': return rpcResult(id, { tools: (await paidFor(env, request)) ? [...TOOLS, ...PRO_TOOLS] : TOOLS });
    case 'prompts/list': return rpcResult(id, { prompts: (await paidFor(env, request)) ? [...PROMPTS, ...PRO_PROMPTS] : PROMPTS });
    case 'prompts/get': {
      const p = isRecord(msg.params) ? msg.params : {};
      const name = typeof p.name === 'string' ? p.name : '';
      const known = [...PROMPTS, ...((await paidFor(env, request)) ? PRO_PROMPTS : [])].find((x) => x.name === name);
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
      if (typeof p.name === 'string' && PRO_TOOL_NAMES.has(p.name)) {
        if (!(await paidFor(env, request))) { note(request, '', false, 'refused: paid_plan_required'); return finish(p.name, text(PAID_ONLY, true)); }
        if (p.name === 'vane_analyze_performance') return finish(p.name, await toolAnalyze(env, request, args));
        if (p.name === 'vane_best_times') return finish(p.name, await toolBestTimes(env, request, args));
        if (p.name === 'vane_get_voice') return finish(p.name, await toolGetVoice(env, request));
        return finish(p.name, await toolCreateSeries(env, request, args));
      }
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
  if (!bearer[1].startsWith(ACCESS_PREFIX)) {
    // A plain API key. Find out whose it is, so the tool list (paid tools) and the agent log know the account. It is checked like any
    // inner call (valid, not revoked, allowed by the plan) and, like them, not counted: the call is counted once, as the tool call.
    const probe = new Request(request.url, { method: 'GET', headers: request.headers });
    markMcpInternal(probe, request);
    if ((await requireApiKey(probe, env, 'post')).ok) { const who = authOf(probe); if (who) rememberAuth(request, who); }
    return request;
  }
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
