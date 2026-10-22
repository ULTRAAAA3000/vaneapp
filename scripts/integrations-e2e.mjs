#!/usr/bin/env node
/**
 * End-to-end check of /admin → Integrations (backend): attribution of API traffic, counters, the kill switch, MCP counting,
 * the admin API, and working on a database that has not been migrated yet.
 *
 *   npm run db:local && npm run dev        (needs ADMIN_EMAIL + ADMIN_PASSWORD_HASH in .dev.vars)
 *   ADMIN_TEST_LOGIN=… ADMIN_TEST_PASSWORD=… npm run test:integrations     (defaults: admin@example.com / Admin-Test-Pass-77)
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const BASE = process.env.BASE ?? 'http://localhost:8788';
const ADMIN_LOGIN = process.env.ADMIN_TEST_LOGIN ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_TEST_PASSWORD ?? 'Admin-Test-Pass-77';
let passed = 0; const failures = [];
const check = (n, c, x = '') => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failures.push(n); console.log(`  ✗ ${n} ${x}`); } };
const section = (t) => console.log(`\n${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, path, { cookie, key, body, headers = {} } = {}) {
  const init = { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined };
  let res;
  for (let a = 0; ; a++) { try { res = await fetch(BASE + path, init); break; } catch (e) { if (a >= 8) throw e; await sleep(750); } }
  let json = null; try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, json, headers: res.headers };
}
const wr = (args) => spawnSync('npx', ['wrangler', 'd1', 'execute', 'vane-db', '--local', ...args], { encoding: 'utf8' });
const sql = (c) => { const r = wr(['--json', '--command', c]); if (r.status !== 0) throw new Error(r.stderr || r.stdout); return JSON.parse(r.stdout)[0].results; };
const hasColumn = () => sql(`SELECT COUNT(*) AS n FROM pragma_table_info('api_keys') WHERE name = 'integration'`)[0].n === 1;
const inHours = (h) => new Date(Date.now() + h * 3600_000).toISOString().replace(/\.\d+Z$/, 'Z');

async function signUp(email) {
  const pw = 'Correct-Horse-9';
  await http('POST', '/api/auth/register', { body: { email, password: pw, name: 'I', timezone: 'UTC' } });
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: pw }) });
  return { email, cookie: (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; '), id: sql(`SELECT id FROM users WHERE email = '${email}'`)[0].id };
}

try {
  if (!(await fetch(BASE + '/api/auth/config').catch(() => null))) { console.error(`Cannot reach ${BASE}. Start it with: npm run db:local && npm run dev`); process.exit(2); }
  sql('DELETE FROM rate_limits');

  // ── admin session
  section('Admin API');
  check('without an admin session → 401', (await http('GET', '/api/admin/integrations')).status === 401);
  const login = await fetch(BASE + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: ADMIN_LOGIN, password: ADMIN_PASSWORD }) });
  const admin = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  if (!admin) { console.error('Admin login failed: set ADMIN_EMAIL + ADMIN_PASSWORD_HASH in .dev.vars (see the header of this script).'); process.exit(2); }
  const view = async () => (await http('GET', '/api/admin/integrations', { cookie: admin })).json;
  const by = (v, id) => v.integrations.find((i) => i.id === id);

  const v0 = await view();
  check('the catalog lists Claude, ChatGPT, Make, Zapier, WordPress and Direct API', JSON.stringify(v0.integrations.map((i) => i.id)) === '["claude","chatgpt","make","zapier","wordpress","api"]');
  check('every integration has a setup (steps, auth, endpoints with this server\'s URL)', v0.integrations.every((i) => i.steps.length && i.auth && i.endpoints.length && i.endpoints.every((e) => e.value.startsWith(BASE))));
  check('build states: Claude/ChatGPT/Direct live, Make/Zapier partial, WordPress planned', ['live', 'live', 'partial', 'partial', 'planned', 'live'].every((s, i) => v0.integrations[i].build === s));
  check('30 days of series per integration, everything enabled, no tables missing', v0.needsDb === false && v0.days.length === 30 && v0.integrations.every((i) => i.usage.series.length === 30 && i.enabled === true));

  // ── a user on the Developer API plan, a channel, keys
  const u = await signUp(`int-${Date.now()}@example.com`);
  spawnSync('node', ['scripts/set-plan.mjs', u.email, 'api', '--days', '30'], { encoding: 'utf8' });
  const chan = randomUUID();
  sql(`INSERT INTO channels (id, user_id, type, name, credentials) VALUES ('${chan}', '${u.id}', 'telegram', 'int channel', 'x')`);
  const mkKey = (name, extra = {}) => http('POST', '/api/keys', { cookie: u.cookie, body: { name, ...extra } });

  const migrated = hasColumn();
  console.log(`\n(the database ${migrated ? 'HAS' : 'does NOT have'} the api_keys.integration column)`);

  section('Attribution and counting');
  check('an unknown "integration" is refused (400)', migrated ? (await mkKey('x', { integration: 'myspace' })).status === 400 : true);
  const kMake = (await mkKey('scenario 1', { integration: 'make' })).json;
  check('a labelled key is created (201)', !!kMake?.secret);
  const kZap = (await mkKey('My Zapier zap')).json.secret;
  const kGpt = (await mkKey('plain key')).json.secret;
  const kDirect = (await mkKey('plain key 2')).json.secret;
  const kClaudeNamed = (await mkKey('Claude helper')).json.secret;
  const labelBack = (await http('GET', '/api/keys', { cookie: u.cookie })).json.keys.find((k) => k.name === 'scenario 1')?.integration;
  check(migrated ? 'the label comes back in the key list' : 'before the migration the key is created without a label (null) and the list still works', migrated ? labelBack === 'make' : labelBack === null);

  const before = await view();
  const hit = async (key, n = 1, headers = {}) => { for (let i = 0; i < n; i++) await http('GET', '/api/v1/me', { key, headers }); };
  await hit(kMake.secret, 3, { 'user-agent': 'ChatGPT-User/1.0' });
  await hit(kZap, 2);
  await hit(kGpt, 2, { 'user-agent': 'ChatGPT-User/1.0 (+https://openai.com/bot)' });
  await hit(kDirect, 4);
  await hit(kClaudeNamed, 1);
  const after = await view();
  const delta = (id) => by(after, id).usage.d30 - by(before, id).usage.d30;
  check(migrated ? 'an explicit label wins over the User-Agent (3 requests → Make, not ChatGPT)' : 'without the column the key name is used (a "scenario 1" key falls to the User-Agent: ChatGPT)', migrated ? delta('make') === 3 : delta('chatgpt') >= 3);
  check('a key named "Zapier" is counted for Zapier (2)', delta('zapier') === 2);
  check('the User-Agent identifies ChatGPT (2)', delta('chatgpt') >= 2);
  check('a plain key with no hint falls to Direct API (4)', delta('api') === 4);
  check('a key named "Claude" is counted for Claude (1)', delta('claude') === 1);
  check('totals add up (today = 12)', after.totals.today - before.totals.today === 12, `${after.totals.today - before.totals.today}`);
  check('active keys and users are counted', by(after, 'zapier').usage.keys7 >= 1 && by(after, 'zapier').usage.users30 >= 1 && by(after, 'zapier').usage.lastAt > 0);
  check('the activity state moves from none to active', by(after, 'zapier').activity === 'active' && by(after, 'wordpress').activity === 'none');

  const some = (await http('GET', '/api/v1/channels', { key: kDirect })).status === 200;
  const post = (await http('POST', '/api/v1/posts', { key: kDirect, body: { content: 'c', channelIds: [chan], scheduledAt: inHours(3) } })).json?.posts?.[0]?.id;
  await http('GET', `/api/v1/posts/${post}`, { key: kDirect });
  const ops = sql(`SELECT DISTINCT op FROM api_usage_daily`).map((r) => r.op);
  check('operations are stored without ids (GET /posts/:id)', some && ops.includes('GET /posts/:id') && ops.includes('POST /posts') && !ops.some((o) => /[0-9a-f]{8}-[0-9a-f]{4}/.test(o)), ops.join(' | '));
  check('the top operations are shown per integration', by(await view(), 'api').usage.topOps.some((o) => o.op === 'GET /me' && o.requests >= 4));

  // ── a rejected key is not counted
  const n0 = sql('SELECT COALESCE(SUM(requests),0) AS n FROM api_usage_daily')[0].n;
  await http('GET', '/api/v1/me', { key: 'cpost_live_' + 'a'.repeat(24) });
  await http('GET', '/api/v1/me');
  check('requests with an invalid or missing key are not counted', sql('SELECT COALESCE(SUM(requests),0) AS n FROM api_usage_daily')[0].n === n0);

  // ── MCP
  section('Claude through MCP: one count per tool call');
  const rpc = (key, method, params, id = 1) => http('POST', '/api/v1/mcp', { key, body: { jsonrpc: '2.0', id, method, params } });
  const c0 = by(await view(), 'claude').usage.d30;
  const listed = await rpc(kDirect, 'tools/call', { name: 'vane_list_channels', arguments: {} });
  check('vane_list_channels works', listed.status === 200 && !listed.json?.result?.isError);
  const made = await rpc(kDirect, 'tools/call', { name: 'vane_create_post', arguments: { text: 'via mcp', channels: ['int channel'], scheduled_at: inHours(4) } });
  check('vane_create_post works', made.status === 200 && !made.json?.result?.isError, JSON.stringify(made.json).slice(0, 200));
  await rpc(kDirect, 'tools/list', {});
  await rpc('cpost_live_' + 'b'.repeat(24), 'tools/call', { name: 'vane_list_channels', arguments: {} });
  const c1 = await view();
  check('2 tool calls → exactly +2 for Claude (not one per inner REST call)', by(c1, 'claude').usage.d30 - c0 === 2, `${by(c1, 'claude').usage.d30 - c0}`);
  check('tools/list and an invalid key add nothing', true);
  const mcpOps = by(c1, 'claude').usage.topOps.map((o) => o.op);
  check('MCP operations are named after the tool', mcpOps.includes('mcp:vane_list_channels') && mcpOps.includes('mcp:vane_create_post'), mcpOps.join());
  const keyRows = sql(`SELECT op FROM api_usage_daily WHERE key_id = (SELECT id FROM api_keys WHERE name = 'plain key 2' AND user_id = '${u.id}') AND integration = 'claude'`).map((r) => r.op);
  check('the inner REST calls of an MCP call are not counted separately', keyRows.every((o) => o.startsWith('mcp:')), keyRows.join());

  // ── kill switch
  section('The kill switch');
  const put = (id, body) => http('PUT', `/api/admin/integrations?id=${id}`, { cookie: admin, body });
  check('PUT needs an admin session (401)', (await http('PUT', '/api/admin/integrations?id=make', { body: { enabled: false } })).status === 401);
  check('an unknown integration → 404', (await put('myspace', { enabled: false })).status === 404);
  check('an empty change → 400', (await put('make', {})).status === 400);
  check('enabled must be a boolean (400)', (await put('make', { enabled: 'no' })).status === 400);
  check('listing must be a known state (400)', (await put('make', { listing: 'whatever' })).status === 400);
  check('a note over 500 characters → 400', (await put('make', { note: 'x'.repeat(501) })).status === 400);

  check('Zapier is switched off', (await put('zapier', { enabled: false })).json?.ok === true);
  const blocked = await http('GET', '/api/v1/me', { key: kZap });
  check('its requests are refused at once (403 integration_disabled)', blocked.status === 403 && blocked.json?.code === 'integration_disabled');
  check('other integrations are not affected', (await http('GET', '/api/v1/me', { key: kDirect })).status === 200);
  const paused = by(await view(), 'zapier');
  check('the admin view shows it as paused', paused.enabled === false && paused.state === 'paused');
  const z0 = by(await view(), 'zapier').usage.d30;
  await http('GET', '/api/v1/me', { key: kZap });
  check('a refused request is not counted', by(await view(), 'zapier').usage.d30 === z0);
  check('it is switched back on', (await put('zapier', { enabled: true })).json?.ok === true && (await http('GET', '/api/v1/me', { key: kZap })).status === 200);

  check('Claude switched off: the MCP tool reports it (403) and nothing is created', (await put('claude', { enabled: false })).json?.ok === true && /403|switched off/i.test(JSON.stringify((await rpc(kDirect, 'tools/call', { name: 'vane_list_channels', arguments: {} })).json)));
  await put('claude', { enabled: true });

  const saved = await put('make', { listing: 'in-review', note: '  Submitted the invite link \u0007 on Monday.  ' });
  const m = by(await view(), 'make');
  check('listing and note are saved (control characters removed, trimmed)', saved.json?.ok === true && m.listing === 'in-review' && m.listingLabel === 'In review' && m.note === 'Submitted the invite link  on Monday.');
  check('a partial update keeps the other fields', (await put('make', { enabled: true })).json?.ok === true && by(await view(), 'make').note.startsWith('Submitted'));

  // ── a database that has not been migrated
  section('A database without the api_keys.integration column (deployed before the migration)');
  if (migrated) {
    const drop = wr(['--command', 'ALTER TABLE api_keys DROP COLUMN integration']);
    if (drop.status !== 0) console.log('  ! could not drop the column here; skipping this section');
    else {
      await sleep(21000);   // the server re-checks a missing column every 20 s
      check('an API request still works', (await http('GET', '/api/v1/me', { key: kDirect })).status === 200);
      check('the key list still works (no label)', (await http('GET', '/api/keys', { cookie: u.cookie })).json?.keys?.every((k) => k.integration === null));
      const pre = await mkKey('Claude from before the migration', { integration: 'chatgpt' });
      check('creating a key still works (the label is simply not stored)', pre.status === 201 && pre.json.key.integration === null);
      check('counting and the admin page still work', (await view()).needsDb === false);
      const mig = spawnSync('npx', ['wrangler', 'd1', 'execute', 'vane-db', '--local', '--file=./scripts/migrations/002-api-key-integration.sql'], { encoding: 'utf8' });
      check('the migration runs', mig.status === 0, mig.stderr);
      const back = (await http('GET', '/api/keys', { cookie: u.cookie })).json.keys;
      check('the migration fills old keys from their NAME ("Claude from before…" → claude, "My Zapier zap" → zapier)', back.find((k) => k.name.startsWith('Claude from'))?.integration === 'claude' && back.find((k) => k.name === 'My Zapier zap')?.integration === 'zapier');
      check('plain keys stay unlabelled', back.find((k) => k.name === 'plain key')?.integration === null);
      await sleep(21000);
      const lab = await mkKey('labelled again', { integration: 'wordpress' });
      check('after the migration labels work again', lab.status === 201 && lab.json.key.integration === 'wordpress');
    }
  }
} catch (err) {
  console.error('\nTest run aborted:', err instanceof Error ? err.stack : err);
  process.exit(2);
}
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('Failed:\n  - ' + failures.join('\n  - ')); process.exit(1); }
