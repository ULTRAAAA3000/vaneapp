import type { CronEnv, Env } from '../../../types';
import { followerSummary, listPostResults } from './analyticsdata';
import { emailConfigured, sendMail } from './mail';

const LABEL: Record<string, string> = { bluesky: 'Bluesky', mastodon: 'Mastodon', telegram: 'Telegram', devto: 'Dev.to' };
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const dayOf = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10);

export function weekKey(now: number): string | null {
  const d = new Date(now * 1000);
  return d.getUTCDay() === 1 && d.getUTCHours() >= 7 ? dayOf(now) : null;
}

export async function sendWeeklyReports(cron: CronEnv, now: number, limit = 10): Promise<number> {
  const week = weekKey(now);
  const env = cron as unknown as Env;
  if (!week || !emailConfigured(env)) return 0;
  const { results } = await env.DB
    .prepare(
      `SELECT u.id, u.email FROM users u
        WHERE (EXISTS (SELECT 1 FROM analytics_subscriptions a WHERE a.user_id = u.id AND a.status = 'active' AND (a.current_period_end IS NULL OR a.current_period_end > ?1))
            OR EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id AND s.plan IN ('suite', 'agency') AND s.status = 'active' AND (s.current_period_end IS NULL OR s.current_period_end > ?1)))
          AND NOT EXISTS (SELECT 1 FROM analytics_reports r WHERE r.user_id = u.id AND r.week = ?2)
        LIMIT ?3`,
    )
    .bind(now, week, limit)
    .all<{ id: string; email: string }>();
  let sent = 0;
  for (const u of results) {
    const since = now - 7 * 86400;
    const posts = await listPostResults(env, u.id, since, 200);
    let ok = true;
    if (posts.length) {
      const score = (p: { likes: number | null; replies: number | null; reposts: number | null }): number => (p.likes ?? 0) + (p.replies ?? 0) + (p.reposts ?? 0);
      const total = posts.reduce((t, p) => ({ likes: t.likes + (p.likes ?? 0), replies: t.replies + (p.replies ?? 0), reposts: t.reposts + (p.reposts ?? 0) }), { likes: 0, replies: 0, reposts: 0 });
      const top = posts.reduce((a, b) => (score(b) > score(a) ? b : a));
      const nets = (await followerSummary(env, u.id, dayOf(since))).filter((n) => n.now !== null);
      const growth = nets.map((n) => `${LABEL[n.type] ?? n.type} ${n.name}: ${n.now} (${(n.now ?? 0) - (n.first ?? n.now ?? 0) >= 0 ? '+' : ''}${(n.now ?? 0) - (n.first ?? n.now ?? 0)})`);
      const lines = [`Posts published: ${posts.length}`, `Likes: ${total.likes}`, `Replies: ${total.replies}`, `Reposts: ${total.reposts}`];
      const topLine = `${top.content.replace(/\s+/g, ' ').slice(0, 100)} (${LABEL[top.type] ?? top.type}, ${score(top)} reactions)`;
      ok = await sendMail(env, {
        to: u.email,
        optional: true,
        subject: 'Your week on Vane Analytics',
        text: `Your last 7 days\n\n${lines.join('\n')}\n\nBest post: ${topLine}\n${growth.length ? `\nFollowers\n${growth.join('\n')}\n` : ''}\nOpen the full picture: https://analytics.vaneapp.dev\n`,
        html: `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111"><h2 style="margin:0 0 12px">Your last 7 days</h2><table style="width:100%;border-collapse:collapse;font-size:14px">${lines.map((l) => { const i = l.indexOf(':'); return `<tr><td style="padding:6px 0;color:#666">${esc(l.slice(0, i))}</td><td style="padding:6px 0;text-align:right">${esc(l.slice(i + 1).trim())}</td></tr>`; }).join('')}</table><p style="margin:16px 0 4px;color:#666;font-size:13px">Best post</p><p style="margin:0">${esc(topLine)}</p>${growth.length ? `<p style="margin:16px 0 4px;color:#666;font-size:13px">Followers</p>${growth.map((g) => `<p style="margin:0">${esc(g)}</p>`).join('')}` : ''}<p style="margin:24px 0 0"><a href="https://analytics.vaneapp.dev" style="color:#111">Open the full picture</a></p></div>`,
      });
    }
    if (!ok) continue;
    await env.DB.prepare('INSERT INTO analytics_reports (user_id, week) VALUES (?1, ?2) ON CONFLICT(user_id) DO UPDATE SET week = excluded.week').bind(u.id, week).run();
    if (posts.length) sent++;
  }
  return sent;
}
