#!/usr/bin/env node
/**
 * Switch the Video Engine on or off for an account by hand (until the payment webhooks do it automatically).
 * The Video Engine is a separate product from the posting plans, so this does not touch `subscriptions`.
 *
 *   node scripts/set-video.mjs <email> [--days N | --forever] [--off] [--remote]
 *
 *   --days N    the Video Engine lasts N days (default 30)      --forever  no expiry
 *   --off       take it away again (the account keeps its videos, but cannot upload or use a video key)
 *   --remote    the production database (default: the local one used by `npm run dev`)
 *
 * Examples:
 *   npm run video:set -- me@example.com
 *   npm run video:set -- me@example.com --days 365 --remote
 *   npm run video:set -- me@example.com --off --remote
 */
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--days');
const [email] = positional;

const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

if (!email) die('usage: node scripts/set-video.mjs <email> [--days N | --forever] [--off] [--remote]');
// The SQL below is built from these values (wrangler --command has no bind parameters), so they are strictly whitelisted.
if (!/^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,}$/.test(email)) die('that does not look like an email address');

let days = 30;
const di = args.indexOf('--days');
if (di !== -1) {
  days = Number(args[di + 1]);
  if (!Number.isInteger(days) || days < 1 || days > 3650) die('--days must be a whole number between 1 and 3650');
}
const periodEnd = flags.has('--forever') ? 'NULL' : `unixepoch() + ${days} * 86400`;

const sql = (command, json = false) => {
  const r = spawnSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'vane-db', flags.has('--remote') ? '--remote' : '--local', ...(json ? ['--json'] : []), '--command', command],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) die(`wrangler failed:\n${r.stderr || r.stdout}`);
  return r.stdout;
};

const found = JSON.parse(sql(`SELECT id FROM users WHERE email = '${email}' COLLATE NOCASE`, true))[0]?.results ?? [];
if (found.length === 0) die(`no user with the email ${email}`);

if (flags.has('--off')) {
  sql(`UPDATE video_subscriptions SET status = 'canceled', updated_at = unixepoch() WHERE user_id = '${found[0].id}'`);
  console.log(`✓ ${email}: Video Engine switched off`);
  process.exit(0);
}

sql(
  `INSERT INTO video_subscriptions (user_id, status, current_period_end, provider, created_at, updated_at)
   VALUES ('${found[0].id}', 'active', ${periodEnd}, 'manual', unixepoch(), unixepoch())
   ON CONFLICT(user_id) DO UPDATE SET
     status = 'active', current_period_end = excluded.current_period_end, provider = 'manual', updated_at = unixepoch()`,
);

const row = JSON.parse(
  sql(`SELECT datetime(current_period_end, 'unixepoch') AS ends FROM video_subscriptions WHERE user_id = '${found[0].id}'`, true),
)[0].results[0];
console.log(`✓ ${email}: Video Engine on, ${row.ends && row.ends !== 'null' ? `until ${row.ends} UTC` : 'no expiry'}`);
