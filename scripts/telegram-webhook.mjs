#!/usr/bin/env node
/**
 * Registers (or inspects / removes) the webhook of the shared Vane bot, so Quick Connect can see the
 * one-time code a user posts in their channel.
 *
 *   SYSTEM_BOT_TOKEN=123:ABC TELEGRAM_WEBHOOK_SECRET=<same secret as on Pages> \
 *   APP_URL=https://vaneapp.dev  node scripts/telegram-webhook.mjs set
 *
 *   … info     show what Telegram currently has (and the last delivery error, if any)
 *   … delete   remove the webhook
 *
 * The token and secret come from the environment, never from command-line arguments (those end up
 * in shell history and process lists).
 */
const [command = 'info'] = process.argv.slice(2);
const token = process.env.SYSTEM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const appUrl = (process.env.APP_URL || 'https://vaneapp.dev').replace(/\/+$/, '');

if (!token || !/^\d{6,12}:[A-Za-z0-9_-]{30,60}$/.test(token)) {
  console.error('Set SYSTEM_BOT_TOKEN to the shared bot token from @BotFather.');
  process.exit(1);
}

async function call(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`${method} failed: ${data.description ?? res.status}`);
  return data.result;
}

try {
  if (command === 'set') {
    // Telegram's rule for secret_token: 1-256 chars of A-Z a-z 0-9 _ -
    if (!secret || !/^[A-Za-z0-9_-]{16,256}$/.test(secret)) {
      console.error('Set TELEGRAM_WEBHOOK_SECRET to 16+ characters from A-Z a-z 0-9 _ - (e.g. `openssl rand -hex 32`).');
      process.exit(1);
    }
    await call('setWebhook', {
      url: `${appUrl}/api/telegram/webhook`,
      secret_token: secret,
      allowed_updates: ['channel_post', 'message'],
      drop_pending_updates: true,
    });
    console.log(`Webhook set: ${appUrl}/api/telegram/webhook`);
  } else if (command === 'delete') {
    await call('deleteWebhook', { drop_pending_updates: true });
    console.log('Webhook removed.');
  } else if (command === 'info') {
    const info = await call('getWebhookInfo');
    console.log(JSON.stringify({ url: info.url, pending: info.pending_update_count, allowed_updates: info.allowed_updates, last_error: info.last_error_message ?? null }, null, 2));
  } else {
    console.error('Usage: node scripts/telegram-webhook.mjs set | info | delete');
    process.exit(1);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message.replace(token, '<token>') : 'Unknown error');
  process.exit(1);
}
