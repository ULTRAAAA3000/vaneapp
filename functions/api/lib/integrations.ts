/**
 * Integrations: the tools people connect to Vane (Claude, Notion, ChatGPT, Make, Zapier, WordPress, Obsidian, their own scripts).
 *
 * What this file does
 *   1. CATALOG      what each integration is, how a user connects it, how far it is built (shown in /admin → Integrations)
 *   2. ATTRIBUTION  which integration an API request came from
 *   3. COUNTING     one small counter per (day, integration, key, operation), written on every authenticated API request
 *   4. KILL SWITCH  the admin can switch an integration off; its requests are then refused (403 integration_disabled)
 *
 * How a request is attributed, in this order
 *   a. it came through the MCP endpoint            → the client that connected: notion for a Notion agent, otherwise claude
 *                                                     (an unforgeable, in-process marker, see markMcpInternal / markMcpClient)
 *   b. the key was labelled when it was created    → that label ("Used with" in the dashboard)
 *   c. the client says who it is (User-Agent)      → chatgpt / zapier / make / claude / notion / wordpress / obsidian
 *   d. the key's NAME says it ("Make.com")         → the same keywords
 *   e. otherwise                                   → api (direct API: scripts, curl, anything else)
 * Only (a) and (b) are certain. (c) and (d) are best-effort, which is why the admin also shows how much traffic fell into `api`.
 *
 * Nothing here may ever break an API request: counting is best-effort (a failure is logged and ignored), and every read of
 * these tables tolerates them not existing yet (a deploy before `npm run db:remote` / `db:migrate:integrations`).
 */
import type { Env } from '../../../types';

export const INTEGRATION_IDS = ['claude', 'notion', 'chatgpt', 'make', 'zapier', 'wordpress', 'obsidian', 'api'] as const;
export type IntegrationId = (typeof INTEGRATION_IDS)[number];
export const isIntegrationId = (v: unknown): v is IntegrationId => typeof v === 'string' && (INTEGRATION_IDS as readonly string[]).includes(v);

export const INTEGRATION_NAMES: Record<IntegrationId, string> = {
  claude: 'Claude', notion: 'Notion', chatgpt: 'ChatGPT', make: 'Make', zapier: 'Zapier', wordpress: 'WordPress plugin', obsidian: 'Obsidian plugin', api: 'Direct API',
};

/** Where the store / marketplace review stands. Free choice from a short list, set by the admin. */
export const LISTING_STATES = ['', 'not-started', 'preparing', 'submitted', 'in-review', 'approved', 'rejected', 'not-needed'] as const;
export type ListingState = (typeof LISTING_STATES)[number];
export const LISTING_LABELS: Record<ListingState, string> = {
  '': 'Not set',
  'not-started': 'Not started',
  preparing: 'Preparing the submission',
  submitted: 'Submitted',
  'in-review': 'In review',
  approved: 'Approved / published',
  rejected: 'Rejected',
  'not-needed': 'No listing needed',
};

// ───────────────────────── catalog ─────────────────────────

/** live: works today · partial: works through the generic API, no dedicated app yet · planned: not built */
export type BuildState = 'live' | 'partial' | 'planned';

export interface Endpoint { label: string; value: string }
export interface IntegrationDef {
  id: IntegrationId;
  name: string;
  kind: string;
  build: BuildState;
  /** one or two sentences: what it lets people do */
  summary: string;
  /** how a user authenticates with it */
  auth: string;
  endpoints: Endpoint[];
  /** how a user connects it, step by step */
  steps: string[];
  /** where the marketplace / review process stands, from documentation/AUTOMATION_INTEGRATIONS.md */
  verification: string;
  color: string;
}

/** The catalog for this deployment (`origin` is the site's own address, so the URLs are copy-paste ready). */
export function catalog(origin: string): IntegrationDef[] {
  const api = `${origin}/api/v1`;
  return [
    {
      id: 'claude', name: 'Claude', kind: 'MCP connector', build: 'live', color: '#f59e0b',
      summary: 'Claude (and other MCP clients) can list your channels and schedule posts from a chat, using Vane as a remote MCP server.',
      auth: 'The user\'s Vane API key, sent as "Authorization: Bearer cpost_live_…".',
      endpoints: [{ label: 'MCP server URL', value: `${api}/mcp` }],
      steps: [
        'The user creates a key in the dashboard (API access) and picks "Claude" under "Used with".',
        'In Claude, add a custom connector / remote MCP server with the URL above.',
        'Send the key as a Bearer token. Two tools appear: vane_list_channels and vane_create_post.',
      ],
      verification: 'Works as a custom connector today. Listing in the Claude connector directory needs OAuth (not built yet): see AUTOMATION_INTEGRATIONS.md, phase 3.',
    },
    {
      id: 'notion', name: 'Notion', kind: 'MCP connector (Custom Agents)', build: 'live', color: '#e5e7eb',
      summary: 'A Notion Custom Agent can list your channels and schedule posts, so a content calendar kept in Notion can publish through Vane. It uses the same remote MCP server as Claude.',
      auth: 'OAuth 2.1 with PKCE and dynamic client registration: the person presses Connect in Notion and Allow on Vane\'s /connect page. No key to copy.',
      endpoints: [{ label: 'MCP server URL', value: `${api}/mcp` }],
      steps: [
        'A Notion workspace admin turns on Settings → Connections → Enable custom MCP servers (and approves the URL if approvals are required).',
        'In the Custom Agent: Settings → Add connection → Custom MCP server, paste the URL above and press Connect.',
        'Vane opens: sign in and press Allow. Vane makes a key named "Notion connector" (live when the plan has API access, otherwise a test key).',
        'Ask the agent to show your Vane channels, then to schedule a post. Two tools appear: vane_list_channels and vane_create_post.',
      ],
      verification: 'Works as a custom MCP server (Notion shows its "has not reviewed this server" notice for every custom server). Custom Agents are a Notion Business/Enterprise feature. Nothing to submit to Notion.',
    },
    {
      id: 'chatgpt', name: 'ChatGPT', kind: 'Custom GPT Actions', build: 'live', color: '#34d399',
      summary: 'A Custom GPT can schedule and read posts by importing Vane\'s OpenAPI description as an Action.',
      auth: 'API Key, auth type Bearer: the user\'s Vane API key.',
      endpoints: [{ label: 'OpenAPI spec', value: `${api}/openapi.json` }, { label: 'Server URL', value: api }],
      steps: [
        'The user creates a key (picking "ChatGPT" under "Used with").',
        'In ChatGPT: Create a GPT → Configure → Actions → Import from URL → paste the spec URL.',
        'Authentication: API Key → Bearer, paste the key.',
      ],
      verification: 'The spec is Custom GPT-ready (short operation descriptions, bearer auth). A public GPT in the store needs a privacy policy URL and review.',
    },
    {
      id: 'make', name: 'Make', kind: 'No-code automation', build: 'partial', color: '#a78bfa',
      summary: 'Scenarios post to Vane (and react to post events) through Make\'s HTTP module and webhooks. A dedicated Make app is not built yet.',
      auth: 'The user\'s Vane API key in an "Authorization: Bearer" header.',
      endpoints: [{ label: 'Base URL', value: api }, { label: 'Subscribe to post events', value: `${api}/webhooks` }],
      steps: [
        'The user creates a key (picking "Make" under "Used with").',
        'In Make: HTTP → Make a request → URL …/posts, header Authorization: Bearer <key>, body type JSON.',
        'Add an Idempotency-Key header so a retried run never posts twice.',
      ],
      verification: 'A custom Make app can be built and shared by invite link without review; public listing is a later phase.',
    },
    {
      id: 'zapier', name: 'Zapier', kind: 'No-code automation', build: 'partial', color: '#fb923c',
      summary: 'Zaps post to Vane through Webhooks by Zapier or the REST API, and instant triggers use Vane\'s webhook subscriptions.',
      auth: 'The user\'s Vane API key in an "Authorization: Bearer" header.',
      endpoints: [{ label: 'Base URL', value: api }, { label: 'Subscribe / unsubscribe (REST hooks)', value: `${api}/webhooks` }],
      steps: [
        'The user creates a key (picking "Zapier" under "Used with").',
        'In Zapier: Webhooks by Zapier → Custom Request → POST …/posts with the Authorization header.',
        'For triggers, a Zapier app subscribes through POST /webhooks and unsubscribes with DELETE /webhooks/:id.',
      ],
      verification: 'A Zapier app can be shared by invite link; the public directory needs a review by Zapier.',
    },
    {
      id: 'wordpress', name: 'WordPress plugin', kind: 'CMS plugin', build: 'planned', color: '#60a5fa',
      summary: 'Publish a WordPress post and have Vane schedule it to the connected channels. Planned, not built.',
      auth: 'The user\'s Vane API key, stored in the plugin settings.',
      endpoints: [{ label: 'Base URL', value: api }],
      steps: ['Planned for phase 2 of AUTOMATION_INTEGRATIONS.md.'],
      verification: 'A plugin in the WordPress.org directory goes through a manual review (often weeks). Nothing submitted yet.',
    },
    {
      id: 'obsidian', name: 'Obsidian plugin', kind: 'Desktop and mobile plugin', build: 'live', color: '#a78bfa',
      summary: 'Post the open note (or the selected text) to your channels from inside Obsidian, now or at a chosen time. The plugin turns Markdown into plain post text and talks to the REST API.',
      auth: 'The user\'s Vane API key, stored in the plugin settings (Obsidian keeps it in the vault\'s plugin data).',
      endpoints: [{ label: 'Base URL', value: api }, { label: 'Plugin download', value: `${origin}/downloads/vane-for-obsidian.zip` }],
      steps: [
        'The user creates a key (picking "Obsidian" under "Used with").',
        'Unzip vane-for-obsidian.zip into <vault>/.obsidian/plugins/ and enable "Vane" under Community plugins.',
        'Settings → Vane: paste the key and press Load channels. Then run "Post note to Vane" from the command palette.',
      ],
      verification: 'Installed by hand from the zip. A listing in Obsidian\'s community plugin directory goes through a review by the Obsidian team: not submitted yet.',
    },
    {
      id: 'api', name: 'Direct API', kind: 'Scripts and everything else', build: 'live', color: '#94a3b8',
      summary: 'Anything that calls the REST API without being one of the above: scripts, curl, n8n, other automation tools. Also where traffic lands when its source cannot be told.',
      auth: 'The user\'s Vane API key in an "Authorization: Bearer" header.',
      endpoints: [{ label: 'Base URL', value: api }, { label: 'OpenAPI spec', value: `${api}/openapi.json` }],
      steps: ['The user creates a key and calls the REST API (see the Quick start in the dashboard).'],
      verification: 'Nothing to list.',
    },
  ];
}

// ───────────────────────── attribution ─────────────────────────

/** Best-effort guess from a User-Agent and a key name. Returns null when neither says anything. */
export function inferIntegration(userAgent: string | null, keyName: string): IntegrationId | null {
  const ua = (userAgent ?? '').slice(0, 300).toLowerCase();
  if (ua) {
    if (ua.includes('chatgpt') || ua.includes('openai')) return 'chatgpt';
    if (ua.includes('zapier')) return 'zapier';
    if (ua.includes('integromat') || ua.includes('make.com') || /\bmake\//.test(ua)) return 'make';
    if (ua.includes('anthropic') || ua.includes('claude')) return 'claude';
    if (ua.includes('wordpress')) return 'wordpress';
    if (ua.includes('obsidian')) return 'obsidian';
    if (ua.includes('notion')) return 'notion';
  }
  const name = keyName.slice(0, 120).toLowerCase();
  if (name.includes('claude') || name.includes('anthropic') || name.includes('mcp')) return 'claude';
  if (name.includes('chatgpt') || name.includes('gpt') || name.includes('openai')) return 'chatgpt';
  if (name.includes('make') || name.includes('integromat')) return 'make';
  if (name.includes('zapier')) return 'zapier';
  if (name.includes('wordpress')) return 'wordpress';
  if (name.includes('obsidian')) return 'obsidian';
  if (name.includes('notion')) return 'notion';
  return null;
}

/** A short, bounded name for what was called: 'POST /posts', 'GET /posts/:id'. Ids never leave a trace in it. */
export function opOf(method: string, pathname: string): string {
  const path = pathname
    .replace(/^\/api\/v1/, '')
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, '/:id')
    .toLowerCase()
    .replace(/[^a-z0-9/:_.-]/g, '')
    .slice(0, 60);
  return `${method.toUpperCase().slice(0, 7)} ${path || '/'}`;
}

// ── requests that arrive through the MCP endpoint ──────────────────────────────────────────────
// mcp.ts answers a tool call by running the REST handlers in-process on a request it builds itself. Those inner requests are
// marked here, so they are (1) attributed to Claude and (2) NOT counted one by one: the MCP call itself is counted once.
// A WeakMap keyed by the request object cannot be forged by a client, unlike a header.
const mcpInner = new WeakMap<Request, Request>();
const mcpKey = new WeakMap<Request, string>();
const mcpClient = new WeakMap<Request, IntegrationId>();

export const markMcpInternal = (inner: Request, outer: Request): void => { mcpInner.set(inner, outer); };
export const mcpOuterOf = (inner: Request): Request | undefined => mcpInner.get(inner);
export const rememberMcpKey = (outer: Request, keyId: string): void => { mcpKey.set(outer, keyId); };

/** Which client is on the other end of the MCP connection (Claude or a Notion agent): decided by the OAuth client that was connected, never by a header. */
export const markMcpClient = (outer: Request, id: IntegrationId): void => { mcpClient.set(outer, id); };
export const mcpClientOf = (outer: Request): IntegrationId => mcpClient.get(outer) ?? 'claude';

/** Counts one MCP tool call for the key the inner requests authenticated with (nothing if none did). */
export async function recordMcpCall(env: Env, outer: Request, tool: string): Promise<void> {
  const keyId = mcpKey.get(outer);
  if (!keyId) return;
  await recordApiUse(env, { keyId, integration: mcpClientOf(outer), op: `mcp:${tool.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40)}` });
}

// ───────────────────────── schema tolerance ─────────────────────────

/**
 * The database does not have the newest schema yet. SQLite words it three ways: "no such table", "no such column" (SELECT, UPDATE)
 * and "table x has no column named y" (INSERT). Missing the third one made key creation answer 500 before the migration.
 */
export const isMissingSchema = (err: unknown): boolean =>
  err instanceof Error && /no such (table|column)|has no column named/i.test(err.message);

// ───────────────────────── counting ─────────────────────────

const dayOf = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);
export { dayOf };

let countingBrokenUntil = 0;

/**
 * Adds one to today's counter for (integration, key, operation). Best effort: never throws, and after a failure it stays quiet
 * for a minute instead of failing on every request.
 */
export async function recordApiUse(env: Env, e: { keyId: string; integration: IntegrationId; op: string; now?: number }): Promise<void> {
  const now = e.now ?? Math.floor(Date.now() / 1000);
  if (now < countingBrokenUntil) return;
  try {
    await env.DB
      .prepare(
        `INSERT INTO api_usage_daily (day, integration, key_id, op, requests, last_at) VALUES (?1, ?2, ?3, ?4, 1, ?5)
         ON CONFLICT(day, integration, key_id, op) DO UPDATE SET requests = requests + 1, last_at = ?5`,
      )
      .bind(dayOf(now), e.integration, e.keyId, e.op, now)
      .run();
  } catch (err) {
    countingBrokenUntil = now + 60;
    if (!isMissingSchema(err)) console.error('api usage count failed', err instanceof Error ? err.message : 'unknown');
  }
}

// ───────────────────────── the kill switch ─────────────────────────

const CACHE_SECONDS = 10;
let disabled: { at: number; ids: Set<IntegrationId> } | null = null;

/** Drops the cached switches: the admin's change takes effect at once on this server, within 10 seconds on the others. */
export const forgetIntegrationSwitches = (): void => { disabled = null; };

/** Is this integration switched off? One small read at most every 10 seconds; a missing table means "nothing is switched off". */
export async function integrationDisabled(env: Env, id: IntegrationId, now = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!disabled || now - disabled.at >= CACHE_SECONDS) {
    const ids = new Set<IntegrationId>();
    try {
      const { results } = await env.DB.prepare('SELECT id FROM integration_settings WHERE enabled = 0').all<{ id: string }>();
      for (const r of results) if (isIntegrationId(r.id)) ids.add(r.id);
    } catch (err) {
      if (!isMissingSchema(err)) console.error('integration switches read failed', err instanceof Error ? err.message : 'unknown');
    }
    disabled = { at: now, ids };
  }
  return disabled.ids.has(id);
}

// ───────────────────────── retention ─────────────────────────

/** The admin looks at 30 days. Counters older than 120 days are removed by the cron worker, so the table stays small. */
export const API_USAGE_KEEP_DAYS = 120;
export async function purgeOldApiUsage(env: Pick<Env, 'DB'>, now = Math.floor(Date.now() / 1000)): Promise<void> {
  try {
    await env.DB.prepare('DELETE FROM api_usage_daily WHERE day < ?1').bind(dayOf(now - API_USAGE_KEEP_DAYS * 86400)).run();
  } catch (err) {
    // Housekeeping must never look like an error of something else in the worker's logs: a missing table is simply "not yet".
    if (!isMissingSchema(err)) console.error('api usage purge failed', err instanceof Error ? err.message : 'unknown');
  }
}
