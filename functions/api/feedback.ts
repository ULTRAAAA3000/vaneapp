/**
 * Feedback & Roadmap board (the "Feedback" button in the dashboard).
 *
 * GET  /api/feedback                           the ideas on the board with their votes: { ok, items: [...] }
 * POST /api/feedback { action: 'vote', id }    vote for an idea, or take the vote back (a toggle): { ok, voted, votes }
 * POST /api/feedback { action: 'create', kind, title, body? }   suggest an idea (it gets your vote): 201 { ok, id }
 *
 * Signed-in users only. An idea you add is public to every user (without your name), so text is checked like posts are,
 * links are refused, and the number of ideas per person is limited. You hide or answer ideas in /admin → Feedback.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../types';
import { requireUser } from './lib/auth';
import { fail, isRecord, json, methodNotAllowed, readJson, UUID_RE } from './lib/http';
import { BODY_MAX, IDEAS_ON_BOARD, IDEAS_PER_DAY, TITLE_MAX, titleKey, validateSuggestion } from './lib/feedback';
import { textProblem } from './lib/moderation';
import { bump, retryAfter } from './lib/throttle';

const VOTES_PER_10_MIN = 60;
const SEED_ID = /^seed-[a-z0-9-]{1,40}$/;

interface Row { id: string; kind: string; title: string; body: string; status: string; created_at: number; votes: number; mine: number; own: number }

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  try {
    const { results } = await env.DB
      .prepare(
        `SELECT i.id, i.kind, i.title, i.body, i.status, i.created_at,
                (SELECT COUNT(*) FROM feedback_votes v WHERE v.item_id = i.id) AS votes,
                EXISTS (SELECT 1 FROM feedback_votes v WHERE v.item_id = i.id AND v.user_id = ?1) AS mine,
                (i.user_id = ?1) AS own
           FROM feedback_items i
          WHERE i.hidden = 0 AND i.status != 'declined'
          ORDER BY (i.status = 'done'), votes DESC, i.created_at DESC
          LIMIT 200`,
      )
      .bind(auth.userId)
      .all<Row>();
    return json({
      ok: true,
      limits: { title: TITLE_MAX, body: BODY_MAX },
      items: results.map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, status: r.status, createdAt: r.created_at, votes: r.votes, mine: !!r.mine, own: !!r.own })),
    });
  } catch (err) {
    // the tables are missing until `npm run db:migrate:feedback` has been run
    console.error('feedback list failed', err instanceof Error ? err.message : 'unknown');
    return json({ ok: true, unavailable: true, limits: { title: TITLE_MAX, body: BODY_MAX }, items: [] });
  }
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const parsed = await readJson(request, 4096);
  if (!parsed.ok) return parsed.response;
  const b = parsed.data;
  if (!isRecord(b)) return fail(400, 'Body must be a JSON object.');

  try {
    if (b.action === 'vote') {
      if (typeof b.id !== 'string' || !(UUID_RE.test(b.id) || SEED_ID.test(b.id))) return fail(400, 'id is invalid.');
      const key = `fbvote:${auth.userId}`;
      const wait = await retryAfter(env, key, VOTES_PER_10_MIN);
      if (wait) return fail(429, 'Too many votes in a short time. Try again in a few minutes.', { 'Retry-After': String(wait) });
      await bump(env, key, 600);

      const item = await env.DB.prepare('SELECT status, hidden FROM feedback_items WHERE id = ?1').bind(b.id).first<{ status: string; hidden: number }>();
      if (!item || item.hidden || item.status === 'declined') return fail(404, 'This idea is no longer on the board.');
      if (item.status === 'done') return fail(409, 'This one is already built, so it is closed for votes.');

      const had = await env.DB.prepare('SELECT 1 AS x FROM feedback_votes WHERE item_id = ?1 AND user_id = ?2').bind(b.id, auth.userId).first();
      await env.DB
        .prepare(had ? 'DELETE FROM feedback_votes WHERE item_id = ?1 AND user_id = ?2' : 'INSERT OR IGNORE INTO feedback_votes (item_id, user_id) VALUES (?1, ?2)')
        .bind(b.id, auth.userId)
        .run();
      const votes = await env.DB.prepare('SELECT COUNT(*) AS n FROM feedback_votes WHERE item_id = ?1').bind(b.id).first<{ n: number }>();
      return json({ ok: true, voted: !had, votes: votes?.n ?? 0 });
    }

    if (b.action === 'create') {
      const v = validateSuggestion(b);
      if (!v.ok) return fail(400, v.error);
      const bad = textProblem(env, v.title, v.body);
      if (bad) return fail(422, bad);

      const since = Math.floor(Date.now() / 1000) - 86400;
      const mine = await env.DB
        .prepare(`SELECT COUNT(*) AS onBoard, COALESCE(SUM(created_at >= ?2), 0) AS today FROM feedback_items WHERE user_id = ?1 AND hidden = 0`)
        .bind(auth.userId, since)
        .first<{ onBoard: number; today: number }>();
      if ((mine?.today ?? 0) >= IDEAS_PER_DAY) return fail(429, `You can add ${IDEAS_PER_DAY} ideas a day. Vote for the ones already there, and add more tomorrow.`);
      if ((mine?.onBoard ?? 0) >= IDEAS_ON_BOARD) return fail(429, 'You already have many ideas on the board. Vote for the ones others added.');

      // The same idea twice splits its votes: point to the existing one instead.
      const key = titleKey(v.title);
      const { results: titles } = await env.DB.prepare(`SELECT id, title FROM feedback_items WHERE hidden = 0 AND status != 'declined'`).all<{ id: string; title: string }>();
      const dup = titles.find((t) => titleKey(t.title) === key);
      if (dup) return json({ ok: false, error: 'This idea is already on the board. Give it your vote instead.', itemId: dup.id }, 409);

      const id = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare('INSERT INTO feedback_items (id, user_id, kind, title, body) VALUES (?1, ?2, ?3, ?4, ?5)').bind(id, auth.userId, v.kind, v.title, v.body),
        env.DB.prepare('INSERT OR IGNORE INTO feedback_votes (item_id, user_id) VALUES (?1, ?2)').bind(id, auth.userId),
      ]);
      return json({ ok: true, id }, 201);
    }
  } catch (err) {
    console.error('feedback failed', err instanceof Error ? err.message : 'unknown');
    return fail(500, 'The feedback board is not available right now. Please try again later.');
  }
  return fail(400, 'action must be vote or create.');
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET, POST');
