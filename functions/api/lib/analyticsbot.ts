import type { Env } from '../../../types';
import { isAnalyticsPro } from './analyticsdata';
import { listChannels, pickChannels, queryPosts, queryTotals } from './analyticsquery';
import { isLang, LANGS, t, type Lang } from './botlang';
import { callJson } from './httpcall';

export interface BotEnv { DB: D1Database; ANALYTICS_BOT_TOKEN?: string }
export interface Bot {
  user_id: string; chat_id: string; lang: Lang; a_results: number; a_milestones: number; a_followers: number; a_hot: number;
  hot_threshold: number; digest: 'off' | 'daily' | 'weekly'; metrics_wm: number; followers_day: string | null; digest_day: string | null;
}

const NET: Record<string, string> = { bluesky: 'Bluesky', mastodon: 'Mastodon', telegram: 'Telegram', devto: 'Dev.to' };
const MILESTONES = [100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000];
const BOT_COLS = 'user_id, chat_id, lang, a_results, a_milestones, a_followers, a_hot, hot_threshold, digest, metrics_wm, followers_day, digest_day';

export const esc = (s: string): string => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
const cut = (s: string, n: number): string => { const x = s.replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
const num = (n: number, lang: Lang): string => new Intl.NumberFormat(lang).format(n);
const signed = (n: number): string => (n > 0 ? '+' : '') + n;
const asApp = (env: BotEnv): Env => env as unknown as Env;

export function localParts(now: number, timeZone: string): { date: string; hour: number; weekday: number } {
  const mk = (tz: string): Intl.DateTimeFormat => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', hourCycle: 'h23', weekday: 'short' });
  let f: Intl.DateTimeFormat;
  try { f = mk(timeZone); } catch { f = mk('UTC'); }
  const p = Object.fromEntries(f.formatToParts(new Date(now * 1000)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(String(p.weekday)) };
}

// ── Telegram
type Markup = { inline_keyboard: { text: string; callback_data: string }[][] };

async function tg(env: BotEnv, method: string, payload: Record<string, unknown>): Promise<'ok' | 'blocked' | 'fail'> {
  if (!env.ANALYTICS_BOT_TOKEN) return 'fail';
  const r = await callJson<{ ok?: boolean }>(`https://api.telegram.org/bot${env.ANALYTICS_BOT_TOKEN}/${method}`, { method: 'POST', json: payload });
  if (r.ok) return 'ok';
  const d = (r.data as { description?: string } | null)?.description ?? '';
  return r.status === 403 || /chat not found|bot was blocked|user is deactivated/i.test(d) ? 'blocked' : 'fail';
}

export const sendText = (env: BotEnv, chatId: string, text: string, markup?: Markup): Promise<'ok' | 'blocked' | 'fail'> =>
  tg(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) });

async function drop(env: BotEnv, userId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM analytics_bot WHERE user_id = ?1').bind(userId).run();
}

// ── linking
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export async function newLinkCode(env: BotEnv, userId: string, now: number): Promise<{ code: string; expiresAt: number }> {
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  const code = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  const expiresAt = now + 15 * 60;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM analytics_bot_links WHERE user_id = ?1 OR expires_at < ?2').bind(userId, now),
    env.DB.prepare('INSERT INTO analytics_bot_links (code, user_id, expires_at) VALUES (?1, ?2, ?3)').bind(code, userId, expiresAt),
  ]);
  return { code, expiresAt };
}

export async function consumeLink(env: BotEnv, code: string, chatId: string, now: number): Promise<string | null> {
  if (!/^[A-Z2-9]{14}$/.test(code)) return null;
  const row = await env.DB.prepare('SELECT user_id FROM analytics_bot_links WHERE code = ?1 AND expires_at > ?2').bind(code, now).first<{ user_id: string }>();
  if (!row) return null;
  const tz = (await env.DB.prepare('SELECT timezone FROM users WHERE id = ?1').bind(row.user_id).first<{ timezone: string }>())?.timezone ?? 'UTC';
  const today = localParts(now, tz).date;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM analytics_bot WHERE chat_id = ?1 AND user_id <> ?2').bind(chatId, row.user_id),
    env.DB
      .prepare(
        `INSERT INTO analytics_bot (user_id, chat_id, metrics_wm, followers_day, digest_day, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4, ?3, ?3)
         ON CONFLICT(user_id) DO UPDATE SET chat_id = excluded.chat_id, metrics_wm = excluded.metrics_wm, followers_day = excluded.followers_day, digest_day = excluded.digest_day, updated_at = excluded.updated_at`,
      )
      .bind(row.user_id, chatId, now, today),
    env.DB.prepare('DELETE FROM analytics_bot_links WHERE user_id = ?1').bind(row.user_id),
  ]);
  return row.user_id;
}

export const botByChat = (env: BotEnv, chatId: string): Promise<Bot | null> => env.DB.prepare(`SELECT ${BOT_COLS} FROM analytics_bot WHERE chat_id = ?1`).bind(chatId).first<Bot>();
export const botByUser = (env: BotEnv, userId: string): Promise<Bot | null> => env.DB.prepare(`SELECT ${BOT_COLS} FROM analytics_bot WHERE user_id = ?1`).bind(userId).first<Bot>();

// ── settings view (the same in the bot; the full form is on analytics.vaneapp.dev)
const TOGGLES = [['results', 'a_results', 'sResults', false], ['milestones', 'a_milestones', 'sMilestones', false], ['followers', 'a_followers', 'sFollowers', true], ['hot', 'a_hot', 'sHot', true]] as const;

function settingsView(b: Bot, pro: boolean): { text: string; markup: Markup } {
  const l = b.lang, lines = [t(l, 'settingsTitle'), ''];
  const rows: Markup['inline_keyboard'] = [];
  for (const [key, col, label, needsPro] of TOGGLES) {
    const on = (b[col] as number) === 1 && (!needsPro || pro);
    const name = t(l, label, { n: b.hot_threshold }) + (needsPro && !pro ? ` · ${t(l, 'proMark')}` : '');
    lines.push(`${on ? '✅' : '⬜'} ${name}`);
    rows.push([{ text: `${on ? '✅' : '⬜'} ${name}`, callback_data: `t:${key}` }]);
  }
  const dig = t(l, b.digest === 'daily' ? 'dDaily' : b.digest === 'weekly' ? 'dWeekly' : 'dOff');
  const digLabel = `${t(l, 'sDigest')}: ${pro ? dig : t(l, 'dOff')}${pro ? '' : ` · ${t(l, 'proMark')}`}`;
  lines.push(`🗞 ${digLabel}`);
  rows.push([{ text: `🗞 ${digLabel}`, callback_data: 'd' }]);
  return { text: lines.join('\n'), markup: { inline_keyboard: rows } };
}

async function saveCol(env: BotEnv, userId: string, col: string, value: string | number, now: number): Promise<void> {
  if (!['a_results', 'a_milestones', 'a_followers', 'a_hot', 'digest', 'lang', 'hot_threshold'].includes(col)) return;
  await env.DB.prepare(`UPDATE analytics_bot SET ${col} = ?2, updated_at = ?3 WHERE user_id = ?1`).bind(userId, value, now).run();
}

// ── data for commands and digests
async function selection(env: BotEnv, userId: string, days: number, sinceDay: string) {
  const channels = await listChannels(asApp(env), userId, sinceDay);
  return { channels, ids: pickChannels('all', channels), f: (since: number, ids: string[]) => ({ userId, since, channels: ids, q: '' }), days };
}

async function statsText(env: BotEnv, b: Bot, pro: boolean, days: number, now: number): Promise<string> {
  const l = b.lang, d = pro ? days : Math.min(days, 30);
  const s = await selection(env, b.user_id, d, '0000');
  const tot = await queryTotals(asApp(env), s.f(now - d * 86400, s.ids));
  const head = t(l, 'statsTitle', { days: d }) + (days > d ? `\n${t(l, 'statsPro')}` : '');
  if (!tot.posts) return `${head}\n\n${t(l, 'noData')}`;
  return `${head}\n\n${t(l, 'statsBody', { posts: num(tot.posts, l), views: num(tot.views, l), likes: num(tot.likes, l), replies: num(tot.replies, l), reposts: num(tot.reposts, l) })}`;
}

async function topText(env: BotEnv, b: Bot, now: number): Promise<string> {
  const l = b.lang, s = await selection(env, b.user_id, 30, '0000');
  const lines: string[] = [];
  for (const type of [...new Set(s.channels.filter((c) => c.results && s.ids.includes(c.id)).map((c) => c.type))]) {
    const ids = s.channels.filter((c) => c.type === type && s.ids.includes(c.id)).map((c) => c.id);
    const best = (await queryPosts(asApp(env), s.f(now - 30 * 86400, ids), 'reactions', 1, 0)).items[0];
    const score = best ? (best.likes ?? 0) + (best.replies ?? 0) + (best.reposts ?? 0) : 0;
    if (best && score > 0) lines.push(t(l, 'topLine', { net: NET[type] ?? type, text: esc(cut(best.content, 70)), n: num(score, l) }));
  }
  return lines.length ? `${t(l, 'topTitle')}\n\n${lines.join('\n')}` : `${t(l, 'topTitle')}\n\n${t(l, 'noData')}`;
}

async function followersLines(env: BotEnv, b: Bot, sinceDay: string): Promise<string[]> {
  const ch = await listChannels(asApp(env), b.user_id, sinceDay);
  return ch.filter((c) => c.followers && c.now !== null).map((c) => t(b.lang, 'followersLine', { net: NET[c.type] ?? c.type, name: esc(c.name), now: num(c.now ?? 0, b.lang), delta: signed((c.now ?? 0) - (c.first ?? c.now ?? 0)) }));
}

const dayOf = (ts: number): string => new Date(ts * 1000).toISOString().slice(0, 10);

async function followersText(env: BotEnv, b: Bot, now: number): Promise<string> {
  const lines = await followersLines(env, b, dayOf(now - 7 * 86400));
  return lines.length ? `${t(b.lang, 'followersTitle')}\n\n${lines.join('\n')}` : `${t(b.lang, 'followersTitle')}\n\n${t(b.lang, 'followersNone')}`;
}

async function digestText(env: BotEnv, b: Bot, kind: 'daily' | 'weekly', now: number): Promise<string> {
  const parts = [t(b.lang, kind === 'daily' ? 'digestDaily' : 'digestWeekly'), '', await statsText(env, b, true, 7, now)];
  const f = await followersLines(env, b, dayOf(now - (kind === 'daily' ? 1 : 7) * 86400));
  if (f.length) parts.push('', `${t(b.lang, 'followersTitle')}`, ...f);
  const top = await topText(env, b, now);
  if (!top.endsWith(t(b.lang, 'noData'))) parts.push('', top);
  return parts.join('\n');
}

// ── incoming messages
export interface Update {
  message?: { chat?: { id?: number; type?: string }; text?: string };
  callback_query?: { id?: string; data?: string; message?: { chat?: { id?: number }; message_id?: number } };
}

export async function handleUpdate(env: BotEnv, u: Update, now: number): Promise<void> {
  if (u.callback_query) return handleCallback(env, u.callback_query, now);
  const m = u.message;
  if (!m?.chat || m.chat.type !== 'private' || typeof m.chat.id !== 'number' || typeof m.text !== 'string') return;
  const chatId = String(m.chat.id);
  const [head, ...rest] = m.text.trim().split(/\s+/);
  const cmd = head.toLowerCase().replace(/@\w+$/, '');
  const arg = rest[0] ?? '';
  let bot = await botByChat(env, chatId);

  if (cmd === '/start') {
    if (arg) {
      const userId = await consumeLink(env, arg.toUpperCase(), chatId, now);
      if (userId) { bot = await botByChat(env, chatId); await sendText(env, chatId, t(bot?.lang ?? 'en', 'welcome')); return; }
      await sendText(env, chatId, t(bot?.lang ?? 'en', 'badCode')); return;
    }
    await sendText(env, chatId, bot ? t(bot.lang, 'help') : t('en', 'noCode')); return;
  }
  if (!bot) { await sendText(env, chatId, t('en', 'notLinked')); return; }
  const pro = await isAnalyticsPro(asApp(env), bot.user_id, now);

  if (cmd === '/help') return void (await sendText(env, chatId, t(bot.lang, 'help')));
  if (cmd === '/stats') { const days = Number(arg); return void (await sendText(env, chatId, await statsText(env, bot, pro, [7, 30, 90, 365].includes(days) ? days : 7, now))); }
  if (cmd === '/top') return void (await sendText(env, chatId, await topText(env, bot, now)));
  if (cmd === '/followers') return void (await sendText(env, chatId, await followersText(env, bot, now)));
  if (cmd === '/digest') return void (await sendText(env, chatId, await digestText(env, bot, 'weekly', now)));
  if (cmd === '/settings') { const v = settingsView(bot, pro); return void (await sendText(env, chatId, v.text, v.markup)); }
  if (cmd === '/language') return void (await sendText(env, chatId, t(bot.lang, 'langPrompt'), { inline_keyboard: LANGS.reduce<Markup['inline_keyboard']>((rows, x, i) => { if (i % 2 === 0) rows.push([]); rows[rows.length - 1].push({ text: x.label, callback_data: `lang:${x.code}` }); return rows; }, []) }));
  if (cmd === '/unlink') { await drop(env, bot.user_id); await sendText(env, chatId, t(bot.lang, 'unlinked')); return; }
}

async function handleCallback(env: BotEnv, q: NonNullable<Update['callback_query']>, now: number): Promise<void> {
  const chatId = q.message?.chat?.id, mid = q.message?.message_id, data = q.data ?? '';
  if (typeof chatId !== 'number' || typeof mid !== 'number' || !q.id) return;
  const bot = await botByChat(env, String(chatId));
  if (!bot) { await tg(env, 'answerCallbackQuery', { callback_query_id: q.id }); return; }
  const pro = await isAnalyticsPro(asApp(env), bot.user_id, now);
  const done = (text?: string, alert = false): Promise<unknown> => tg(env, 'answerCallbackQuery', { callback_query_id: q.id, ...(text ? { text, show_alert: alert } : {}) });

  if (data.startsWith('lang:')) {
    const code = data.slice(5);
    if (!isLang(code)) return void (await done());
    await saveCol(env, bot.user_id, 'lang', code, now);
    await tg(env, 'editMessageText', { chat_id: chatId, message_id: mid, text: t(code, 'langSet') });
    await done(); return;
  }
  let next = bot;
  if (data.startsWith('t:')) {
    const hit = TOGGLES.find((x) => x[0] === data.slice(2));
    if (!hit) return void (await done());
    if (hit[3] && !pro) return void (await done(t(bot.lang, 'proOnly'), true));
    const value = (bot[hit[1]] as number) === 1 ? 0 : 1;
    await saveCol(env, bot.user_id, hit[1], value, now);
    next = { ...bot, [hit[1]]: value };
  } else if (data === 'd') {
    if (!pro) return void (await done(t(bot.lang, 'proOnly'), true));
    const digest = bot.digest === 'off' ? 'daily' : bot.digest === 'daily' ? 'weekly' : 'off';
    await saveCol(env, bot.user_id, 'digest', digest, now);
    next = { ...bot, digest };
  } else return void (await done());
  const v = settingsView(next, pro);
  await tg(env, 'editMessageText', { chat_id: chatId, message_id: mid, text: v.text, parse_mode: 'HTML', reply_markup: v.markup });
  await done();
}

// ── alerts (called by the cron)
interface MetricRow { post_id: string; stage: number; taken_at: number; likes: number; replies: number; reposts: number; views: number | null; content: string; type: string; name: string }

async function resultAlerts(env: BotEnv, b: Bot, pro: boolean): Promise<void> {
  const { results } = await env.DB
    .prepare(
      `SELECT m.post_id, m.stage, m.taken_at, m.likes, m.replies, m.reposts, m.views, p.content, c.type, c.name
         FROM post_metrics m JOIN posts p ON p.id = m.post_id JOIN channels c ON c.id = p.channel_id
        WHERE p.user_id = ?1 AND m.taken_at > ?2 AND m.likes IS NOT NULL ORDER BY m.taken_at ASC LIMIT 100`,
    )
    .bind(b.user_id, b.metrics_wm)
    .all<MetricRow>();
  if (!results.length) return;
  const l = b.lang, msgs: string[] = [], hotMsgs: string[] = [];
  let extra = 0;
  for (const r of results) {
    const score = r.likes + r.replies + r.reposts;
    if (b.a_results === 1 && r.stage === 2) {
      if (msgs.length < 5) msgs.push(t(l, 'result', { net: NET[r.type] ?? r.type, name: esc(r.name), text: esc(cut(r.content, 80)), likes: num(r.likes, l), replies: num(r.replies, l), reposts: num(r.reposts, l), views: r.views ? t(l, 'viewsPart', { n: num(r.views, l) }) : '' }));
      else extra++;
    }
    if (pro && b.a_hot === 1 && score >= b.hot_threshold && hotMsgs.length < 3) {
      const fresh = await env.DB.prepare('INSERT OR IGNORE INTO analytics_bot_hot (post_id) VALUES (?1)').bind(r.post_id).run();
      if (fresh.meta.changes) hotMsgs.push(t(l, 'hot', { net: NET[r.type] ?? r.type, n: num(score, l), text: esc(cut(r.content, 80)) }));
    }
  }
  if (extra) msgs.push(t(l, 'more', { n: extra }));
  for (const text of [...msgs, ...hotMsgs]) {
    const sent = await sendText(env, b.chat_id, text);
    if (sent === 'blocked') return drop(env, b.user_id);
    if (sent === 'fail') return;
  }
  await env.DB.prepare('UPDATE analytics_bot SET metrics_wm = ?2 WHERE user_id = ?1').bind(b.user_id, results[results.length - 1].taken_at).run();
}

async function followerAlerts(env: BotEnv, b: Bot, pro: boolean, now: number, local: { date: string }): Promise<void> {
  const { results } = await env.DB
    .prepare(
      `SELECT c.type, c.name,
              (SELECT day FROM channel_followers WHERE channel_id = c.id ORDER BY day DESC LIMIT 1) AS day,
              (SELECT followers FROM channel_followers WHERE channel_id = c.id ORDER BY day DESC LIMIT 1) AS now,
              (SELECT followers FROM channel_followers WHERE channel_id = c.id ORDER BY day DESC LIMIT 1 OFFSET 1) AS prev
         FROM channels c WHERE c.user_id = ?1 AND c.is_active = 1 AND c.type IN ('bluesky', 'mastodon', 'telegram')`,
    )
    .bind(b.user_id)
    .all<{ type: string; name: string; day: string | null; now: number | null; prev: number | null }>();
  const fresh = results.filter((r) => r.day === dayOf(now) && r.now !== null);
  if (!fresh.length) return;
  const l = b.lang, mile: string[] = [], change: string[] = [];
  for (const r of fresh) {
    if (r.prev === null) continue;
    const crossed = MILESTONES.filter((m) => (r.prev as number) < m && (r.now as number) >= m).pop();
    if (crossed && b.a_milestones === 1) mile.push(t(l, 'milestone', { net: NET[r.type] ?? r.type, name: esc(r.name), n: num(crossed, l) }));
    const d = (r.now as number) - r.prev;
    if (d !== 0 && pro && b.a_followers === 1) change.push(t(l, 'followChange', { net: NET[r.type] ?? r.type, name: esc(r.name), now: num(r.now as number, l), delta: signed(d) }));
  }
  const out = [...(mile.length ? [mile.join('\n')] : []), ...(change.length ? [`${t(l, 'followHead')}\n${change.join('\n')}`] : [])];
  for (const text of out) {
    const sent = await sendText(env, b.chat_id, text);
    if (sent === 'blocked') return drop(env, b.user_id);
    if (sent === 'fail') return;
  }
  await env.DB.prepare('UPDATE analytics_bot SET followers_day = ?2 WHERE user_id = ?1').bind(b.user_id, local.date).run();
}

export async function runBotAlerts(env: BotEnv, now: number, limit = 300): Promise<number> {
  if (!env.ANALYTICS_BOT_TOKEN) return 0;
  const { results } = await env.DB
    .prepare(`SELECT ${BOT_COLS.split(', ').map((c) => 'b.' + c).join(', ')}, u.timezone FROM analytics_bot b JOIN users u ON u.id = b.user_id ORDER BY b.updated_at ASC LIMIT ?1`)
    .bind(limit)
    .all<Bot & { timezone: string }>();
  let handled = 0;
  for (const b of results) {
    try {
      const pro = await isAnalyticsPro(asApp(env), b.user_id, now);
      if (b.a_results === 1 || (pro && b.a_hot === 1)) await resultAlerts(env, b, pro);
      const local = localParts(now, b.timezone);
      if (local.hour >= 9) {
        if (b.followers_day !== local.date && (b.a_milestones === 1 || (pro && b.a_followers === 1))) await followerAlerts(env, b, pro, now, local);
        if (pro && b.digest !== 'off' && b.digest_day !== local.date && (b.digest === 'daily' || local.weekday === 0)) {
          const sent = await sendText(env, b.chat_id, await digestText(env, b, b.digest, now));
          if (sent === 'blocked') await drop(env, b.user_id);
          else if (sent === 'ok') await env.DB.prepare('UPDATE analytics_bot SET digest_day = ?2 WHERE user_id = ?1').bind(b.user_id, local.date).run();
        }
      }
      handled++;
    } catch (err) {
      console.error('vane-cron: analytics bot failed for one user:', err instanceof Error ? err.message : 'unknown');
    }
  }
  return handled;
}

export async function sendTest(env: BotEnv, b: Bot): Promise<boolean> {
  return (await sendText(env, b.chat_id, t(b.lang, 'test'))) === 'ok';
}
