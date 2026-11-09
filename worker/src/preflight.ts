import type { CronEnv } from '../../types';
import { emailConfigured, sendMail, type Mail } from '../../functions/api/lib/mail';
import { findProblems, type Problem } from '../../functions/api/lib/preflight';

export const WARN_WITHIN_SECONDS = 12 * 3600;
export const REPEAT_AFTER_SECONDS = 24 * 3600;
const MAX_USERS = 100;

export const isPreflightMinute = (nowSec: number): boolean => new Date(nowSec * 1000).getUTCMinutes() % 10 === 0;

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
const when = (t: number): string => `${new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

export function warningMail(to: string, problems: Problem[], origin: string): Mail {
  const posts = problems.reduce((n, p) => n + p.postCount, 0);
  const lines = problems.map((p) => `${p.name} (${p.platform}): ${p.postCount} post${p.postCount === 1 ? '' : 's'}, the first at ${when(p.firstAt)}\n  ${p.message}`);
  const link = `${origin}/app`;
  return {
    to,
    optional: true,
    subject: `${posts} scheduled post${posts === 1 ? '' : 's'} may not go out`,
    text: `Heads up: Vane found a problem that will stop ${posts === 1 ? 'a scheduled post' : 'scheduled posts'} from going out.\n\n${lines.join('\n\n')}\n\nFix it before the time above: ${link}\n`,
    html: `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111"><h2 style="margin:0 0 12px">${posts} scheduled post${posts === 1 ? '' : 's'} may not go out</h2><p style="margin:0 0 16px">Vane found a problem that will stop ${posts === 1 ? 'it' : 'them'} from being published. You still have time to fix it.</p>${problems.map((p) => `<div style="margin:0 0 14px;padding:12px 14px;border:1px solid #eee;border-radius:12px"><b>${esc(p.name)}</b> <span style="color:#777">(${esc(p.platform)})</span><br><span style="font-size:13px;color:#555">${p.postCount} post${p.postCount === 1 ? '' : 's'}, the first at ${esc(when(p.firstAt))}</span><br><span style="font-size:14px">${esc(p.message)}</span></div>`).join('')}<p style="margin:20px 0 0"><a href="${esc(link)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 18px;border-radius:999px;font-size:14px">Open Vane</a></p></div>`,
  };
}

export async function runPreflight(env: CronEnv, nowSec: number): Promise<number> {
  if (!emailConfigured(env as never)) return 0;
  const problems = await findProblems(env, nowSec, { startsWithin: WARN_WITHIN_SECONDS });
  if (!problems.length) return 0;

  const byUser = new Map<string, Problem[]>();
  for (const p of problems) {
    const recent = await env.DB
      .prepare(`SELECT 1 AS x FROM logs WHERE event = 'preflight.warn' AND channel_id = ?1 AND message = ?2 AND created_at > ?3 LIMIT 1`)
      .bind(p.channelId, p.code, nowSec - REPEAT_AFTER_SECONDS).first();
    if (recent) continue;
    byUser.set(p.userId, [...(byUser.get(p.userId) ?? []), p]);
  }

  let sent = 0;
  for (const [userId, list] of [...byUser].slice(0, MAX_USERS)) {
    const user = await env.DB.prepare('SELECT email FROM users WHERE id = ?1').bind(userId).first<{ email: string }>();
    if (!user?.email) continue;
    const ok = await sendMail(env as never, warningMail(user.email, list, (env.APP_URL ?? 'https://vaneapp.dev').replace(/\/+$/, '')));
    if (!ok) continue;
    sent++;
    await env.DB.batch(list.map((p) => env.DB
      .prepare(`INSERT INTO logs (user_id, channel_id, level, event, message, meta, created_at) VALUES (?1, ?2, 'warn', 'preflight.warn', ?3, ?4, ?5)`)
      .bind(userId, p.channelId, p.code, JSON.stringify({ posts: p.postCount, firstAt: p.firstAt }), nowSec)));
  }
  return sent;
}
