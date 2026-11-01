/**
 * Feedback & Roadmap board, admin side (/admin → Feedback).
 *
 * GET    /api/admin/feedback                     every idea (also hidden and declined) with votes, who added it and when, plus overall
 *                                                 figures: { votes, voters, votes7d } (all votes, how many people voted, votes in the last 7 days)
 * POST   /api/admin/feedback { kind, title, body?, status? }   add an idea yourself (for example a network poll)
 * PUT    /api/admin/feedback { id, status?, hidden?, title? }  answer an idea: open / planned / building / done / declined, hide it, retitle it
 * DELETE /api/admin/feedback?id=...              remove an idea and its votes
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { audit, requireAdmin } from '../lib/admin';
import { FEEDBACK_STATUSES, TITLE_MAX, TITLE_MIN, cleanText, validateSuggestion } from '../lib/feedback';
import { fail, isRecord, json, methodNotAllowed, readJson, UUID_RE } from '../lib/http';

const SEED_ID = /^seed-[a-z0-9-]{1,40}$/;
const validId = (v: unknown): v is string => typeof v === 'string' && (UUID_RE.test(v) || SEED_ID.test(v));
const validStatus = (v: unknown): v is (typeof FEEDBACK_STATUSES)[number] => typeof v === 'string' && (FEEDBACK_STATUSES as readonly string[]).includes(v);

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  try {
    const { results } = await env.DB
      .prepare(
        `SELECT i.id, i.kind, i.title, i.body, i.status, i.hidden, i.created_at, u.email,
                (SELECT COUNT(*) FROM feedback_votes v WHERE v.item_id = i.id) AS votes
           FROM feedback_items i LEFT JOIN users u ON u.id = i.user_id
          ORDER BY i.hidden, (i.status IN ('done', 'declined')), votes DESC, i.created_at DESC
          LIMIT 500`,
      )
      .all<{ id: string; kind: string; title: string; body: string; status: string; hidden: number; created_at: number; email: string | null; votes: number }>();
    const totals = await env.DB
      .prepare(`SELECT COUNT(*) AS votes, COUNT(DISTINCT user_id) AS voters, COALESCE(SUM(created_at > unixepoch() - 604800), 0) AS votes7d FROM feedback_votes`)
      .first<{ votes: number; voters: number; votes7d: number }>();
    return json({
      ok: true,
      stats: { votes: totals?.votes ?? 0, voters: totals?.voters ?? 0, votes7d: totals?.votes7d ?? 0 },
      items: results.map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, status: r.status, hidden: !!r.hidden, createdAt: r.created_at, author: r.email, votes: r.votes })),
    });
  } catch (err) {
    console.error('admin feedback list failed', err instanceof Error ? err.message : 'unknown');
    return fail(503, 'The feedback tables are missing. Run: npm run db:migrate:feedback');
  }
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  const parsed = await readJson(request, 4096);
  if (!parsed.ok) return parsed.response;
  const b = parsed.data;
  if (!isRecord(b)) return fail(400, 'Body must be a JSON object.');
  const v = validateSuggestion(b);
  if (!v.ok) return fail(400, v.error);
  const status = b.status === undefined ? 'open' : b.status;
  if (!validStatus(status)) return fail(400, 'status is invalid.');
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO feedback_items (id, user_id, kind, title, body, status) VALUES (?1, NULL, ?2, ?3, ?4, ?5)').bind(id, v.kind, v.title, v.body, status).run();
  await audit(env, request, 'feedback.add', id, { title: v.title });
  return json({ ok: true, id }, 201);
};

export const onRequestPut: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  const parsed = await readJson(request, 2048);
  if (!parsed.ok) return parsed.response;
  const b = parsed.data;
  if (!isRecord(b) || !validId(b.id)) return fail(400, 'id is required.');
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (b.status !== undefined) {
    if (!validStatus(b.status)) return fail(400, 'status is invalid.');
    sets.push(`status = ?${vals.length + 2}`); vals.push(b.status);
  }
  if (b.hidden !== undefined) {
    if (typeof b.hidden !== 'boolean') return fail(400, 'hidden must be true or false.');
    sets.push(`hidden = ?${vals.length + 2}`); vals.push(b.hidden ? 1 : 0);
  }
  if (b.title !== undefined) {
    const title = cleanText(b.title, TITLE_MAX);
    if (title.length < TITLE_MIN) return fail(400, `The title needs at least ${TITLE_MIN} characters.`);
    sets.push(`title = ?${vals.length + 2}`); vals.push(title);
  }
  if (!sets.length) return fail(400, 'Send status, hidden and / or title.');
  const res = await env.DB.prepare(`UPDATE feedback_items SET ${sets.join(', ')}, updated_at = unixepoch() WHERE id = ?1`).bind(b.id, ...vals).run();
  if (!(res.meta?.changes ?? 0)) return fail(404, 'Not found.');
  await audit(env, request, 'feedback.update', b.id, { status: b.status, hidden: b.hidden, title: b.title });
  return json({ ok: true });
};

export const onRequestDelete: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  const id = new URL(request.url).searchParams.get('id');
  if (!validId(id)) return fail(400, 'id is required.');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM feedback_votes WHERE item_id = ?1').bind(id),
    env.DB.prepare('DELETE FROM feedback_items WHERE id = ?1').bind(id),
  ]);
  await audit(env, request, 'feedback.delete', id);
  return json({ ok: true });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET, POST, PUT, DELETE');
