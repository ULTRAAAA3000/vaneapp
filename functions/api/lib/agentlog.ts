/**
 * The agent log: one short line for every thing an integration did with a person's Vane account, shown live in the dashboard's
 * "Agents" tab (assets/agentlog.js). Examples of what a line says:
 *
 *   Executed tool: vane_list_channels() → 4 channels found                       (an AI assistant over MCP: Claude, a Notion agent)
 *   Executed tool: vane_create_post(2 channels) → scheduled for 2026-11-02 09:00 UTC
 *   Listed channels → 4 channels found                                           (Make, Zapier, WordPress, Obsidian, a script…)
 *   Scheduled a post for 2026-11-02 09:00 UTC on 2 channels
 *
 * METADATA ONLY, on purpose: counts, times, platform names, error codes. The text of a post, a key, a channel name never goes in.
 * Failing to write a line never fails the request it describes: the log is an extra.
 *
 * MCP calls are logged once, as the tool call (mcp.ts). Every other integration is logged by `agentLogged()` around the REST handler,
 * which skips the inner requests of MCP so nothing is written twice.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { authOf, isMissingSchema, mcpOuterOf, type IntegrationId } from './integrations';

export const KEEP_PER_USER = 300;
export const KEEP_DAYS = 30;
const MESSAGE_MAX = 200;

export interface AgentEventIn { userId: string; integration: IntegrationId; via: 'mcp' | 'api'; tool?: string | null; ok: boolean; message: string }
export interface AgentEvent { id: number; at: number; integration: string; via: 'mcp' | 'api'; tool: string | null; ok: boolean; message: string }

const clip = (s: string): string => (s.length > MESSAGE_MAX ? `${s.slice(0, MESSAGE_MAX - 1)}…` : s);

export async function recordAgentEvent(env: Env, e: AgentEventIn, now = Math.floor(Date.now() / 1000)): Promise<void> {
  try {
    await env.DB
      .prepare('INSERT INTO agent_events (user_id, integration, via, tool, ok, message, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
      .bind(e.userId, e.integration, e.via, e.tool ?? null, e.ok ? 1 : 0, clip(e.message), now)
      .run();
    // Tidy up now and then (one write in 25 on average): the newest KEEP_PER_USER lines, nothing older than KEEP_DAYS.
    if (Math.random() < 0.04) await prune(env, e.userId, now);
  } catch (err) {
    if (!isMissingSchema(err)) console.error('agent log write failed', err instanceof Error ? err.message : 'unknown');
  }
}

export async function prune(env: Env, userId: string, now = Math.floor(Date.now() / 1000)): Promise<void> {
  await env.DB
    .prepare(`DELETE FROM agent_events WHERE user_id = ?1 AND (created_at < ?2 OR id <= (SELECT id FROM agent_events WHERE user_id = ?1 ORDER BY id DESC LIMIT 1 OFFSET ?3))`)
    .bind(userId, now - KEEP_DAYS * 86400, KEEP_PER_USER)
    .run();
}

/** Lines after `after` (a cursor from an earlier call), oldest first; with no cursor, the newest `limit` lines. */
export async function listAgentEvents(env: Env, userId: string, opts: { after?: number; limit?: number; integration?: string | null } = {}): Promise<{ events: AgentEvent[]; latest: number }> {
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 60), 1), 200);
  const after = Number.isFinite(opts.after) && (opts.after as number) > 0 ? Math.floor(opts.after as number) : 0;
  const integ = opts.integration && /^[a-z]{2,20}$/.test(opts.integration) ? opts.integration : null;
  try {
    const rows = after
      ? await env.DB.prepare(`SELECT id, integration, via, tool, ok, message, created_at FROM agent_events WHERE user_id = ?1 AND id > ?2 AND (?3 IS NULL OR integration = ?3) ORDER BY id ASC LIMIT ?4`).bind(userId, after, integ, limit).all<Row>()
      : await env.DB.prepare(`SELECT id, integration, via, tool, ok, message, created_at FROM (SELECT * FROM agent_events WHERE user_id = ?1 AND (?2 IS NULL OR integration = ?2) ORDER BY id DESC LIMIT ?3) ORDER BY id ASC`).bind(userId, integ, limit).all<Row>();
    const events = rows.results.map((r) => ({ id: r.id, at: r.created_at, integration: r.integration, via: r.via, tool: r.tool, ok: r.ok === 1, message: r.message }));
    const last = await env.DB.prepare('SELECT MAX(id) AS id FROM agent_events WHERE user_id = ?1').bind(userId).first<{ id: number | null }>();
    return { events, latest: last?.id ?? 0 };
  } catch (err) {
    if (!isMissingSchema(err)) console.error('agent log read failed', err instanceof Error ? err.message : 'unknown');
    return { events: [], latest: 0 };
  }
}
interface Row { id: number; integration: string; via: 'mcp' | 'api'; tool: string | null; ok: number; message: string; created_at: number }

export async function clearAgentEvents(env: Env, userId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM agent_events WHERE user_id = ?1').bind(userId).run();
}

// ───────────────────────── what a line says

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
export const utc = (seconds: number): string => `${new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** "refused: quota_exceeded" / "refused (422)" from an error answer. Only the error CODE is used, never the message (it may quote the user's text). */
export function refusal(status: number, data: unknown): string {
  const code = isRec(data) && typeof data.code === 'string' && /^[a-z0-9_]{2,40}$/.test(data.code) ? data.code : null;
  return code ? `refused: ${code}` : `refused (${status})`;
}

/** One line for a REST call of an integration that is not MCP. `op` is the name given to agentLogged(). */
export function describeRest(op: string, method: string, status: number, data: unknown): { ok: boolean; message: string } {
  if (status >= 400) return { ok: false, message: `${LABEL[op] ?? op} → ${refusal(status, data)}` };
  const d = isRec(data) ? data : {};
  switch (op) {
    case 'channels.list': return { ok: true, message: `Listed channels → ${plural(Array.isArray(d.channels) ? d.channels.length : 0, 'channel')} found` };
    case 'posts.list': return { ok: true, message: `Looked up posts → ${plural(Array.isArray(d.posts) ? d.posts.length : 0, 'post')} found` };
    case 'posts.create': {
      const n = Array.isArray(d.posts) ? d.posts.length : 0;
      const at = typeof d.scheduledAt === 'number' ? ` for ${utc(d.scheduledAt)}` : '';
      return { ok: true, message: d.test === true ? `Test run: would schedule a post${at} on ${plural(n, 'channel')} (nothing posted)` : `Scheduled a post${at} on ${plural(n, 'channel')}` };
    }
    case 'posts.get': return { ok: true, message: `Checked a post → ${isRec(d.post) && typeof d.post.status === 'string' ? d.post.status : 'found'}` };
    case 'posts.cancel': return { ok: true, message: 'Cancelled a scheduled post' };
    case 'usage': return { ok: true, message: 'Checked API usage' };
    case 'me': return { ok: true, message: 'Checked the account' };
    default: return { ok: true, message: `${method} ${op} → ok` };
  }
}
const LABEL: Record<string, string> = { 'channels.list': 'Listed channels', 'posts.list': 'Looked up posts', 'posts.create': 'Schedule a post', 'posts.get': 'Checked a post', 'posts.cancel': 'Cancel a post', usage: 'Checked API usage', me: 'Checked the account' };

/** The line of an MCP tool call: `Executed tool: vane_create_post(2 channels) → scheduled for … UTC`. */
export const mcpLine = (tool: string, args: string, outcome: string): string => `Executed tool: ${tool}(${args}) → ${outcome}`;

/**
 * Wraps a REST handler of the public API so every call of a real integration leaves a line. Calls made by the MCP endpoint are skipped
 * (mcp.ts logs those as tool calls); calls that fail before a key was accepted (401…) have no person to write for and are skipped too.
 */
export function agentLogged<P extends string = never>(op: string, handler: PagesFunction<Env, P>): PagesFunction<Env, P> {
  return async (ctx) => {
    const res = await handler(ctx);
    try {
      const who = authOf(ctx.request);
      if (!who || mcpOuterOf(ctx.request) || res.headers.has('Idempotent-Replayed')) return res;
      let data: unknown = null;
      if ((res.headers.get('content-type') ?? '').includes('json')) data = await res.clone().json().catch(() => null);
      const line = describeRest(op, ctx.request.method, res.status, data);
      await recordAgentEvent(ctx.env, { userId: who.userId, integration: who.integration, via: 'api', ok: line.ok, message: line.message });
    } catch { /* the log never breaks a request */ }
    return res;
  };
}
