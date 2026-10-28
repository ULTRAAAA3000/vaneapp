/**
 * POST /api/admin/analytics-bot { action: 'setup' } → points the Vane Analytics bot's webhook at this site and sets its command menu
 *                               { action: 'info' }  → what Telegram currently has (url, pending updates, last error)
 * Needs ANALYTICS_BOT_TOKEN and ANALYTICS_BOT_SECRET on the Pages project.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { audit, requireAdmin } from '../lib/admin';
import { fail, isRecord, json, methodNotAllowed, readJson } from '../lib/http';
import { callJson } from '../lib/httpcall';

const MENU: Record<string, [string, string][]> = {
  en: [['stats', 'Totals for the period'], ['top', 'Most popular post per network'], ['followers', 'Followers now'], ['digest', 'Summary now'], ['settings', 'What I send you'], ['language', 'Language'], ['help', 'All commands'], ['unlink', 'Disconnect']],
  ru: [['stats', 'Итоги за период'], ['top', 'Лучший пост по каждой сети'], ['followers', 'Подписчики сейчас'], ['digest', 'Сводка сейчас'], ['settings', 'Что присылать'], ['language', 'Язык'], ['help', 'Все команды'], ['unlink', 'Отключить']],
  uk: [['stats', 'Підсумки за період'], ['top', 'Найкращий пост у кожній мережі'], ['followers', 'Підписники зараз'], ['digest', 'Зведення зараз'], ['settings', 'Що надсилати'], ['language', 'Мова'], ['help', 'Усі команди'], ['unlink', 'Відключити']],
  de: [['stats', 'Summen für den Zeitraum'], ['top', 'Bester Beitrag je Netzwerk'], ['followers', 'Follower jetzt'], ['digest', 'Zusammenfassung jetzt'], ['settings', 'Was ich sende'], ['language', 'Sprache'], ['help', 'Alle Befehle'], ['unlink', 'Trennen']],
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  if (!env.ANALYTICS_BOT_TOKEN || !env.ANALYTICS_BOT_SECRET) return fail(409, 'Add ANALYTICS_BOT_TOKEN and ANALYTICS_BOT_SECRET to the Pages project first (Settings → Variables and secrets), then deploy again.');
  const parsed = await readJson(request, 512);
  if (!parsed.ok) return parsed.response;
  const b = parsed.data;
  if (!isRecord(b)) return fail(400, 'Body must be a JSON object.');
  const api = (method: string): string => `https://api.telegram.org/bot${env.ANALYTICS_BOT_TOKEN}/${method}`;

  if (b.action === 'info') {
    const r = await callJson<{ result?: { url?: string; pending_update_count?: number; last_error_message?: string } }>(api('getWebhookInfo'));
    if (!r.ok) return fail(502, 'Telegram did not answer. Check ANALYTICS_BOT_TOKEN.');
    const w = r.data.result ?? {};
    return json({ ok: true, url: w.url || '', pending: w.pending_update_count ?? 0, lastError: w.last_error_message || '' });
  }
  if (b.action === 'setup') {
    const url = `${new URL(request.url).origin}/api/telegram/analytics`;
    const hook = await callJson<{ ok?: boolean }>(api('setWebhook'), { method: 'POST', json: { url, secret_token: env.ANALYTICS_BOT_SECRET, allowed_updates: ['message', 'callback_query'], drop_pending_updates: false } });
    if (!hook.ok) return fail(502, 'Telegram refused the webhook. Check ANALYTICS_BOT_TOKEN.');
    for (const [lang, commands] of Object.entries(MENU)) {
      await callJson(api('setMyCommands'), { method: 'POST', json: { commands: commands.map(([command, description]) => ({ command, description })), ...(lang === 'en' ? {} : { language_code: lang }) } });
    }
    await callJson(api('setMyCommands'), { method: 'POST', json: { commands: MENU.en.map(([command, description]) => ({ command, description })), language_code: 'en' } });
    await audit(env, request, 'analytics_bot.setup', url);
    return json({ ok: true, url });
  }
  return fail(400, 'Unknown action.');
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');
