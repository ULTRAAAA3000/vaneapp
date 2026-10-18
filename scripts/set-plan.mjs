#!/usr/bin/env node
/**
 * Grant a subscription by hand (until the payment webhooks do it automatically).
 *
 *   node scripts/set-plan.mjs <email> <free|api|pro> [--addon] [--overage] [--days N | --forever] [--remote]
 *
 *   --addon     Pro + API Add-on (+180 API posts a month)
 *   --overage   bill posts beyond the quota instead of answering 402
 *   --days N    paid plans last N days (default 30)        --forever  no expiry
 *   --remote    the production database (default: the local one used by `npm run dev`)
 *
 * Examples:
 *   npm run plan:set -- me@example.com api
 *   npm run plan:set -- me@example.com pro --addon --days 365 --remote
 */
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] === '--days'));
const [email, plan] = positional;

const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

if (!email || !plan) die('usage: node scripts/set-plan.mjs <email> <free|api|pro> [--addon] [--overage] [--days N | --forever] [--remote]');
// The SQL below is built from these values (wrangler --command has no bind parameters), so they are strictly whitelisted.
if (!/^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,}$/.test(email)) die('that does not look like an email address');
if (!['free', 'api', 'pro'].includes(plan)) die('plan must be free, api or pro');
if (flags.has('--addon') && plan !== 'pro') die('--addon only makes sense with the pro plan');

let days = 30;
const di = args.indexOf('--days');
if (di !== -1) {
  days = Number(args[di + 1]);
  if (!Number.isInteger(days) || days < 1 || days > 3650) die('--days must be a whole number between 1 and 3650');
}
const forever = flags.has('--forever') || plan === 'free';
const periodEnd = forever ? 'NULL' : `unixepoch() + ${days} * 86400`;

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

sql(
  `INSERT INTO subscriptions (user_id, plan, api_addon, status, current_period_end, overage_enabled, provider, created_at, updated_at)
   SELECT id, '${plan}', ${flags.has('--addon') ? 1 : 0}, 'active', ${periodEnd}, ${flags.has('--overage') ? 1 : 0}, 'manual', unixepoch(), unixepoch()
     FROM users WHERE email = '${email}' COLLATE NOCASE
   ON CONFLICT(user_id) DO UPDATE SET
     plan = excluded.plan, api_addon = excluded.api_addon, status = 'active', current_period_end = excluded.current_period_end,
     overage_enabled = excluded.overage_enabled, provider = 'manual', updated_at = unixepoch()`,
);

const row = JSON.parse(
  sql(`SELECT plan, api_addon, overage_enabled, datetime(current_period_end, 'unixepoch') AS ends FROM subscriptions WHERE user_id = '${found[0].id}'`, true),
)[0].results[0];
console.log(`✓ ${email}: plan=${row.plan}${row.api_addon ? ' + API add-on' : ''}${row.overage_enabled ? ', overage billing on' : ''}, ${row.ends && row.ends !== 'null' ? `until ${row.ends} UTC` : 'no expiry'}`);
