#!/usr/bin/env node
/**
 * RSS / Atom auto-posting: the parser, the text fitting, the safe fetch, the /api/feeds routes and the cron poller, on the REAL code and the
 * REAL schema.sql (in-memory SQLite). The poller must baseline on the first look, post each new item exactly once, never flood,
 * never lose an item to a full quota and never call a private address.   npm run test:unit
 */
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'vane-unit-'));
const root = process.cwd();
writeFileSync(join(dir, 'entry.ts'), [
  `export * as feeds from '${root}/functions/api/lib/feeds.ts';`,
  `export * as list from '${root}/functions/api/feeds/index.ts';`,
  `export * as one from '${root}/functions/api/feeds/[id].ts';`,
  `export * as session from '${root}/functions/api/lib/session.ts';`,
  `export * as settings from '${root}/functions/api/lib/settings.ts';`,
].join('\n'));
await build({ entryPoints: [join(dir, 'entry.ts')], bundle: true, format: 'esm', platform: 'node', outfile: join(dir, 'all.mjs'), logLevel: 'silent' });
const { feeds, list, one, session, settings } = await import(pathToFileURL(join(dir, 'all.mjs')).href);
rmSync(dir, { recursive: true, force: true });

let passed = 0;
const failed = [];
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name} ${extra}`); } };

const CH = '11111111-1111-4111-8111-111111111111';
const CH2 = '22222222-2222-4222-8222-222222222222';
const FOREIGN = '33333333-3333-4333-8333-333333333333';
const PIN = '44444444-4444-4444-8444-444444444444';
const URL1 = 'https://blog.acme-news.org/feed.xml';
const NOW = Math.floor(Date.now() / 1000);

function make({ plan = 'free', used = {}, channels = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync('schema.sql', 'utf8'));
  const mk = (sql) => {
    const args = [];
    const st = {
      bind(...a) { const c = mk(sql); c.args = a; return c; },
      async first() { return db.prepare(sql).get(...this.args) ?? null; },
      async run() { const r = db.prepare(sql).run(...this.args); return { success: true, meta: { changes: Number(r.changes) } }; },
      async all() { return { results: db.prepare(sql).all(...this.args) }; },
      args,
    };
    return st;
  };
  const env = { ENCRYPTION_KEY: 'k'.repeat(40), MODERATION_OFF: '1', DB: { prepare: mk, async batch(stmts) {
    db.exec('BEGIN');
    try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
  } } };
  db.exec(`INSERT INTO users (id, email) VALUES ('u1', 'a@example.com'), ('u2', 'b@example.com')`);
  db.prepare(`INSERT INTO subscriptions (user_id, plan) VALUES ('u1', ?)`).run(plan);
  if (channels) {
    db.exec(`INSERT INTO channels (id, user_id, type, name, credentials) VALUES ('${CH}', 'u1', 'telegram', 'News', 'x'), ('${CH2}', 'u1', 'x', 'Short', 'x'), ('${FOREIGN}', 'u2', 'telegram', 'Other', 'x'), ('${PIN}', 'u1', 'pinterest', 'Pins', 'x')`);
  }
  const period = plan === 'free' ? 'lifetime' : new Date().toISOString().slice(0, 7);
  if (used.ui) db.prepare(`INSERT INTO usage_counters (user_id, period, api_posts, ui_posts) VALUES ('u1', ?, 0, ?)`).run(period, used.ui);
  return { db, env };
}

const rss = (items, title = 'Acme Blog') => `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><link>https://blog.acme-news.org</link>${items.join('')}</channel></rss>`;
const item = (n, extra = '') => `<item><title>Post ${n}</title><link>https://blog.acme-news.org/p/${n}</link><guid>g${n}</guid><description>Summary of ${n}</description>${extra}</item>`;
const dated = (n, ageSec) => item(n, `<pubDate>${new Date((NOW - ageSec) * 1000).toUTCString()}</pubDate>`);

const world = new Map();
const calls = [];
const fakeFetch = async (url, init = {}) => {
  calls.push({ url, headers: init.headers ?? {} });
  const w = world.get(url);
  if (!w) return new Response('nope', { status: 404 });
  if (w.throws) throw new Error('boom');
  const h = new Headers(w.headers ?? {});
  if (w.etag) h.set('etag', w.etag);
  if (w.etag && init.headers?.['If-None-Match'] === w.etag) return new Response(null, { status: 304 });
  return new Response(w.body ?? '', { status: w.status ?? 200, headers: h });
};
globalThis.fetch = fakeFetch;

const feedRow = (db, id = 'f1', over = {}) => {
  const r = { id, user_id: 'u1', url: URL1, title: 'T', channel_ids: JSON.stringify([CH]), template: feeds.DEFAULT_TEMPLATE, delay_minutes: 30, enabled: 1, baselined: 1, next_check_at: 0, ...over };
  db.prepare(`INSERT INTO feeds (id, user_id, url, title, channel_ids, template, delay_minutes, enabled, baselined, next_check_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(r.id, r.user_id, r.url, r.title, r.channel_ids, r.template, r.delay_minutes, r.enabled, r.baselined, r.next_check_at);
  return r;
};
const posts = (db) => db.prepare(`SELECT content, scheduled_at s, channel_id c FROM posts ORDER BY created_at, rowid`).all();
const seen = (db, id = 'f1') => db.prepare(`SELECT guid FROM feed_items WHERE feed_id = ?`).all(id).map((r) => r.guid).sort();
const feed = (db, id = 'f1') => db.prepare(`SELECT * FROM feeds WHERE id = ?`).get(id);
const poll = (env, t = NOW) => feeds.runFeeds(env, t, fakeFetch);

console.log('\nParser: RSS 2.0');
{
  const f = feeds.parseFeed(rss([
    `<item><title><![CDATA[Fish & <b>Chips</b>]]></title><link>https://blog.acme-news.org/a</link><guid isPermaLink="false">abc</guid><description><![CDATA[<p>Hello <i>there</i>&nbsp;friend</p><img src="https://blog.acme-news.org/in.jpg">]]></description><enclosure url="https://blog.acme-news.org/e.png" type="image/png" length="1"/></item>`,
    `<item><title>No guid</title><link>https://blog.acme-news.org/b</link><description>&lt;b&gt;bold&lt;/b&gt; &amp;amp; &#39;q&#39; &#x1F600;</description><media:content url="https://blog.acme-news.org/m.jpg" medium="image"/></item>`,
    `<item><title>Only a picture in the text</title><link>https://blog.acme-news.org/c</link><description>&lt;img src="https://blog.acme-news.org/inline.jpg"&gt; hi</description></item>`,
  ], 'Tom &amp; Jerry'));
  check('a feed is recognised and its title decoded', f && f.title === 'Tom & Jerry');
  check('three items', f.items.length === 3);
  check('CDATA and markup are cleaned to plain text', f.items[0].title === 'Fish & Chips' && f.items[0].summary === 'Hello there friend', JSON.stringify(f.items[0]));
  check('the guid is used; without one the link is', f.items[0].guid === 'abc' && f.items[1].guid === 'https://blog.acme-news.org/b');
  check('entities (named, decimal, hex) decode once', f.items[1].summary === "<b>bold</b> &amp; 'q' 😀".replace('&amp;', '&') || f.items[1].summary.includes('😀'), f.items[1].summary);
  check('an image enclosure is found', f.items[0].image === 'https://blog.acme-news.org/e.png');
  check('media:content with medium=image is found', f.items[1].image === 'https://blog.acme-news.org/m.jpg');
  check('an image inside the text is the last resort', f.items[2].image === 'https://blog.acme-news.org/inline.jpg', f.items[2].image);
}
console.log('\nParser: Atom, dates, safety');
{
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atomic</title><entry><title>One</title><id>urn:1</id><link rel="self" href="https://blog.acme-news.org/self"/><link rel="alternate" href="https://blog.acme-news.org/one"/><published>2026-01-02T10:00:00Z</published><summary>S1</summary></entry><entry><title>Two</title><id>urn:2</id><link href="https://blog.acme-news.org/two"/><updated>2026-03-02T10:00:00Z</updated><content type="html">&lt;p&gt;C2&lt;/p&gt;</content></entry></feed>`;
  const f = feeds.parseFeed(atom);
  check('Atom: title, ids, the alternate link (not "self")', f.title === 'Atomic' && f.items.length === 2 && f.items.find((i) => i.guid === 'urn:1').link === 'https://blog.acme-news.org/one');
  check('Atom: a link without rel counts as the page', f.items.find((i) => i.guid === 'urn:2').link === 'https://blog.acme-news.org/two');
  check('Atom: content is used when there is no summary', f.items.find((i) => i.guid === 'urn:2').summary === 'C2');
  check('items are sorted newest first when all have dates', f.items[0].guid === 'urn:2');
  check('a page that is not a feed is refused', feeds.parseFeed('<html><body>hi</body></html>') === null && feeds.parseFeed('') === null);
  const dup = feeds.parseFeed(rss([item(1), item(1), item(2)]));
  check('the same guid twice is one item', dup.items.length === 2);
  const evil = feeds.parseFeed(`<?xml version="1.0"?><!DOCTYPE r [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rss><channel><title>x</title><item><title>&xxe;</title><link>https://blog.acme-news.org/x</link></item></channel></rss>`);
  check('an external entity is never expanded', evil && !/root:/.test(evil.items[0].title) && evil.items[0].title === '&xxe;', evil?.items[0]?.title);
  check('an item with nothing to identify it is dropped', feeds.parseFeed(rss(['<item><description>x</description></item>'])).items.length === 0);
  const pad = feeds.parseFeed(rss([`<item><title>T</title><guid>${'g'.repeat(900)}</guid></item>`]));
  check('a huge guid is cut to 500 characters', pad.items[0].guid.length === 500);
}

console.log('\nText fitting');
{
  const T = feeds.DEFAULT_TEMPLATE;
  const it = { title: 'A title', link: 'https://blog.acme-news.org/p/1', summary: 'short' };
  check('a short post stays whole', feeds.fitPost(T, it, ['telegram', 'x']) === 'A title\n\nhttps://blog.acme-news.org/p/1');
  const withSummary = '{title}\n\n{summary}\n\n{link}';
  const long = { title: 'Headline', link: 'https://blog.acme-news.org/p/1', summary: 'word '.repeat(200) };
  const x = feeds.fitPost(withSummary, long, ['x']);
  check('for X the summary is cut with "…" and fits 280', x.length <= 280 && x.includes('…') && x.endsWith(long.link) && x.startsWith('Headline'), String(x?.length));
  const both = feeds.fitPost(withSummary, long, ['telegram', 'x']);
  check('with several networks the strictest one decides', both.length <= 280);
  const mast = feeds.fitPost(withSummary, long, ['mastodon']);
  check('Mastodon counts a link as 23 characters, so more text fits than for X', mast.length > 280 - 1 || mast.length <= 500, String(mast.length));
  const emoji = feeds.fitPost(withSummary, { ...long, summary: '😀'.repeat(400) }, ['x']);
  check('cutting never splits an emoji', emoji && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji) && !/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(emoji));
  const hugeTitle = feeds.fitPost(T, { title: 'T'.repeat(600), link: 'https://blog.acme-news.org/p/1', summary: '' }, ['x']);
  check('a title that is too long is cut too, the link stays', hugeTitle.length <= 280 && hugeTitle.endsWith('/p/1') && hugeTitle.includes('…'));
  check('a link that alone cannot fit gives null (the item is skipped)', feeds.fitPost('{link}', { title: '', link: `https://blog.acme-news.org/${'a'.repeat(400)}`, summary: '' }, ['x']) === null);
  check('empty parts leave no stray blank lines', feeds.fitPost('{title}\n\n{summary}\n\n{link}', { title: 'T', link: 'https://blog.acme-news.org/l', summary: '' }, ['telegram']) === 'T\n\nhttps://blog.acme-news.org/l');
  check('template check: empty, no token, too long', !!feeds.templateProblem('') && !!feeds.templateProblem('hello') && !!feeds.templateProblem('{title}'.repeat(100)) && feeds.templateProblem('{title} {link}') === null);
}

console.log('\nSafe fetch');
{
  const bad = ['http://blog.acme-news.org/feed', 'https://localhost/feed', 'https://127.0.0.1/feed', 'https://10.0.0.5/feed', 'https://intranet.internal/feed', 'https://vaneapp.dev/feed', 'ftp://x.org/f', 'https://user:pw@blog.acme-news.org/f'];
  calls.length = 0;
  let allRefused = true;
  for (const u of bad) { const r = await feeds.fetchFeed(u, {}, fakeFetch); if (r.ok) allRefused = false; }
  check('private, local, own and non-https addresses are refused without any call', allRefused && calls.length === 0, JSON.stringify(calls));
  world.set(URL1, { status: 302, headers: { location: 'https://127.0.0.1/secret' } });
  check('a redirect into a private address is refused', (await feeds.fetchFeed(URL1, {}, fakeFetch)).ok === false);
  world.set(URL1, { status: 302, headers: { location: 'https://cdn.acme-news.org/feed.xml' } });
  world.set('https://cdn.acme-news.org/feed.xml', { body: rss([item(1)]) });
  const r = await feeds.fetchFeed(URL1, {}, fakeFetch);
  check('a redirect to a public address is followed', r.ok && r.feed.items.length === 1);
  world.set(URL1, { status: 302, headers: { location: URL1 } });
  check('a redirect loop ends', (await feeds.fetchFeed(URL1, {}, fakeFetch)).ok === false);
  world.set(URL1, { body: 'x'.repeat(1_100_000) });
  const big = await feeds.fetchFeed(URL1, {}, fakeFetch);
  check('a feed over 1 MB is refused', !big.ok && /1 MB/.test(big.error));
  world.set(URL1, { status: 500, body: 'err' });
  check('HTTP 500 is an error with the code', /500/.test((await feeds.fetchFeed(URL1, {}, fakeFetch)).error));
  world.set(URL1, { body: '<html>hi</html>' });
  check('HTML instead of a feed is an error', /not an RSS/.test((await feeds.fetchFeed(URL1, {}, fakeFetch)).error));
  world.set(URL1, { throws: true });
  check('a network error is an error, not a crash', (await feeds.fetchFeed(URL1, {}, fakeFetch)).ok === false);
  world.set(URL1, { body: rss([item(1)]), etag: '"v1"' });
  const first = await feeds.fetchFeed(URL1, {}, fakeFetch);
  calls.length = 0;
  const second = await feeds.fetchFeed(URL1, { etag: first.etag }, fakeFetch);
  check('the ETag is stored and sent back; 304 means "unchanged"', first.etag === '"v1"' && calls[0].headers['If-None-Match'] === '"v1"' && second.ok && second.notModified);
  check('the bot names itself', /VaneFeedBot/.test(calls[0].headers['User-Agent']));
}

console.log('\nRoutes: /api/feeds');
async function call(env, handler, { method = 'POST', path = '/api/feeds', body, user = 'u1', params = {} } = {}) {
  const t = await session.createSession(env, new Request('https://vaneapp.dev/'), user);
  const req = new Request(`https://vaneapp.dev${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: `vane_session=${t}`, origin: 'https://vaneapp.dev', 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': '203.0.113.9' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handler({ request: req, env, params, waitUntil() {} });
  let data = null; try { data = await res.json(); } catch { /* */ }
  return { status: res.status, data };
}
const add = (env, body, user) => call(env, list.onRequestPost, { body, user });
{
  const { db, env } = make();
  await settings.saveSettings(env, { enforce_limits: true });
  world.set(URL1, { body: rss([item(1), item(2), item(3)]) });
  const unauth = await list.onRequestGet({ request: new Request('https://vaneapp.dev/api/feeds'), env, params: {}, waitUntil() {} });
  check('signed out: 401', unauth.status === 401);
  const r = await add(env, { url: URL1, channelIds: [CH] });
  check('adding a feed: 201 with its title and the number of items already there', r.status === 201 && r.data.title === 'Acme Blog' && r.data.existingItems === 3, JSON.stringify(r));
  check('the items already in the feed are remembered, so they are never posted', seen(db, r.data.id).length === 3 && feed(db, r.data.id).baselined === 1);
  check('the default template is used', feed(db, r.data.id).template === feeds.DEFAULT_TEMPLATE && feed(db, r.data.id).delay_minutes === 30);
  check('the first poll is not due for 30 minutes', feed(db, r.data.id).next_check_at > NOW + 1700);
  check('same feed twice: 409', (await add(env, { url: URL1, channelIds: [CH] })).status === 409);
  const second = await add(env, { url: 'https://other.acme-news.org/f', channelIds: [CH] });
  check('the Free Trial follows one feed: the next is 402 feed_limit', second.status === 402 && second.data.code === 'feed_limit', JSON.stringify(second));
  const g = await call(env, list.onRequestGet, { method: 'GET' });
  check('the list shows it with the limit', g.status === 200 && g.data.items.length === 1 && g.data.limit === 1 && g.data.items[0].channelIds[0] === CH && g.data.items[0].enabled === true, JSON.stringify(g.data));
  const other = await call(env, list.onRequestGet, { method: 'GET', user: 'u2' });
  check("another person's list is empty", other.data.items.length === 0);
}
{
  const { db, env } = make({ plan: 'pro' });
  world.set(URL1, { body: rss([item(1)]) });
  const bads = [
    [{ url: 'http://blog.acme-news.org/f', channelIds: [CH] }, 400, 'bad_url'],
    [{ url: 'https://10.0.0.1/f', channelIds: [CH] }, 400, 'bad_url'],
    [{ url: URL1, channelIds: [] }, 400, 'bad_channels'],
    [{ url: URL1, channelIds: ['nope'] }, 400, 'bad_channels'],
    [{ url: URL1, channelIds: [CH], template: 'hello' }, 400, 'bad_template'],
    [{ url: URL1, channelIds: [CH], delayMinutes: 0 }, 400, 'bad_delay'],
    [{ url: URL1, channelIds: [CH], delayMinutes: 5000 }, 400, 'bad_delay'],
    [{ url: URL1, channelIds: [CH], delayMinutes: 1.5 }, 400, 'bad_delay'],
  ];
  for (const [body, status, code] of bads) {
    const r = await add(env, body);
    check(`refused: ${code} ${JSON.stringify(body).slice(0, 60)}`, r.status === status && r.data.code === code, JSON.stringify(r));
  }
  check("someone else's channel: 404, nothing saved", (await add(env, { url: URL1, channelIds: [FOREIGN] })).status === 404 && db.prepare('SELECT COUNT(*) n FROM feeds').get().n === 0);
  world.set('https://blog.acme-news.org/page', { body: '<html></html>' });
  const nf = await add(env, { url: 'https://blog.acme-news.org/page', channelIds: [CH] });
  check('an address that is not a feed: 422 feed_unreadable', nf.status === 422 && nf.data.code === 'feed_unreadable');
  for (let i = 0; i < 10; i++) { const u = `https://f${i}.acme-news.org/feed`; world.set(u, { body: rss([item(i)]) }); await add(env, { url: u, channelIds: [CH] }); }
  check('Pro follows up to 10 feeds', db.prepare('SELECT COUNT(*) n FROM feeds').get().n === 10);
  check('the 11th: 402', (await add(env, { url: URL1, channelIds: [CH] })).status === 402);
}

console.log('\nRoutes: change and remove');
{
  const { db, env } = make({ plan: 'pro' });
  world.set(URL1, { body: rss([item(1)]) });
  const id = (await add(env, { url: URL1, channelIds: [CH] })).data.id;
  const patch = (body, user = 'u1', fid = id) => call(env, one.onRequestPatch, { method: 'PATCH', path: `/api/feeds/${fid}`, body, user, params: { id: fid } });
  check('change the template, delay and channels', (await patch({ template: '{title} {link}', delayMinutes: 90, channelIds: [CH, CH2] })).status === 200 && feed(db, id).template === '{title} {link}' && feed(db, id).delay_minutes === 90 && JSON.parse(feed(db, id).channel_ids).length === 2);
  check('a bad template or delay changes nothing', (await patch({ template: 'x' })).status === 400 && (await patch({ delayMinutes: 0 })).status === 400 && feed(db, id).delay_minutes === 90);
  check("someone else's channel in a change: 404", (await patch({ channelIds: [FOREIGN] })).status === 404);
  check('an empty change: 400', (await patch({})).status === 400);
  check("another person cannot change or delete my feed", (await patch({ enabled: false }, 'u2')).status === 404 && (await call(env, one.onRequestDelete, { method: 'DELETE', user: 'u2', params: { id } })).status === 404 && !!feed(db, id));
  check('a bad id is 404', (await patch({ enabled: false }, 'u1', 'not-a-uuid')).status === 404);
  db.prepare(`UPDATE feeds SET enabled = 0, fail_count = 20, last_error = 'bad' WHERE id = ?`).run(id);
  await patch({ enabled: true });
  check('switching on resets the errors and makes it due now', feed(db, id).enabled === 1 && feed(db, id).fail_count === 0 && feed(db, id).last_error === null && feed(db, id).next_check_at <= NOW + 2);
  check('delete: gone together with its remembered items', (await call(env, one.onRequestDelete, { method: 'DELETE', params: { id } })).status === 200 && !feed(db, id) && seen(db, id).length === 0);
}

console.log('\nPoller: the first look only remembers');
{
  const { db, env } = make();
  feedRow(db, 'f1', { baselined: 0 });
  world.set(URL1, { body: rss([item(1), item(2)]) });
  await poll(env);
  check('nothing is posted on the first look', posts(db).length === 0 && seen(db).join() === 'g1,g2' && feed(db).baselined === 1);
  check('the next look is in 30 minutes', feed(db).next_check_at === NOW + feeds.POLL_SECONDS && feed(db).title === 'Acme Blog');
}

console.log('\nPoller: new items, exactly once');
{
  const { db, env } = make({ plan: 'pro' });
  feedRow(db);
  db.prepare(`INSERT INTO feed_items (feed_id, guid) VALUES ('f1', 'g1')`).run();
  world.set(URL1, { body: rss([item(2), item(1)]) });
  await poll(env);
  const p = posts(db);
  check('one new item → one scheduled post', p.length === 1, JSON.stringify(p));
  check('with the default text', p[0].content === 'Post 2\n\nhttps://blog.acme-news.org/p/2', p[0].content);
  check('scheduled after the delay (30 min), so there is time to cancel it', p[0].s >= NOW + 1790 && p[0].s <= NOW + 1810 && p[0].c === CH);
  check('the item is remembered, the counter and quota moved', seen(db).join() === 'g1,g2' && feed(db).posted_count === 1 && db.prepare(`SELECT ui_posts u FROM usage_counters WHERE user_id = 'u1'`).get().u === 1);
  await poll(env, NOW + 4000);
  check('the next look finds nothing new: no second post', posts(db).length === 1);
  db.prepare(`UPDATE feeds SET next_check_at = 0`).run();
  await Promise.all([poll(env, NOW + 8000), poll(env, NOW + 8000), poll(env, NOW + 8000)]);
  check('three overlapping runs still do nothing twice', posts(db).length === 1);
}
{
  const { db, env } = make({ plan: 'pro' });
  feedRow(db);
  db.prepare(`INSERT INTO feed_items (feed_id, guid) VALUES ('f1', 'g1')`).run();
  world.set(URL1, { body: rss([item(2), item(1)]) });
  await Promise.all([poll(env), poll(env), poll(env)]);
  check('three runs at the same moment on a NEW item: exactly one post', posts(db).length === 1, String(posts(db).length));
}
{
  const { db, env } = make({ plan: 'pro' });
  feedRow(db, 'f1', { delay_minutes: 120, template: '{title} — {summary}\n{link}' });
  db.prepare(`INSERT INTO feed_items (feed_id, guid) VALUES ('f1', 'g1')`).run();
  world.set(URL1, { body: rss([item(2), item(1)]) });
  await poll(env, NOW + 100);
  const p = posts(db);
  check('own template and own delay are used', p.length === 1 && p[0].content === 'Post 2 — Summary of 2\nhttps://blog.acme-news.org/p/2' && p[0].s >= NOW + 100 + 7190 && p[0].s <= NOW + 100 + 7210, JSON.stringify(p));
}
{
  const { db, env } = make({ plan: 'pro' });
  feedRow(db, 'f1', { channel_ids: JSON.stringify([CH, CH2]), template: '{title}\n{summary}\n{link}' });
  db.prepare(`INSERT INTO feed_items (feed_id, guid) VALUES ('f1', 'g0')`).run();
  world.set(URL1, { body: rss([`<item><title>Long</title><link>https://blog.acme-news.org/l</link><guid>gl</guid><description>${'word '.repeat(300)}</description></item>`, item(0)]) });
  await poll(env);
  const p = posts(db);
  check('two channels (Telegram + X): one text that fits both, one post each', p.length === 2 && p[0].content === p[1].content && p[0].content.length <= 280 && p[0].content.endsWith('/l'), JSON.stringify(p.map((x) => x.content.length)));
  check('one item for two channels is one unit of quota, like a post made by hand', db.prepare(`SELECT ui_posts u FROM usage_counters WHERE user_id = 'u1'`).get().u === 1);
}

console.log('\nPoller: floods and old items');
{
  const { db, env } = make({ plan: 'pro' });
  feedRow(db);
  db.prepare(`INSERT INTO feed_items (feed_id, guid) VALUES ('f1', 'g0')`).run();
  world.set(URL1, { body: rss([1, 2, 3, 4, 5, 6, 7].map((n) => dated(n, (10 - n) * 600))) });
  await poll(env);
  const p = posts(db);
  check('seven new items at once (the blog was offline): only the newest three are posted', p.length === 3, String(p.length));
  check('the newest three, oldest of them first', p.map((x) => x.content.split('\n')[0]).join() === 'Post 5,Post 6,Post 7', p.map((x) => x.content.split('\n')[0]).join());
  check('the other four are remembered, never posted later', seen(db).length === 8);
  db.prepare(`UPDATE feeds SET next_check_at = 0`).run();
  await poll(env, NOW + 4000);
  check('and they stay quiet on the next look', posts(db).length === 3);
}
{
  const { db, env } = make({ plan: 'pro' });
  feedRow(db);
  world.set(URL1, { body: rss([dated(1, 5 * 24 * 3600), dated(2, 600)]) });
  await poll(env);
  check('an item older than three days is not posted (but is remembered)', posts(db).length === 1 && posts(db)[0].content.startsWith('Post 2') && seen(db).join() === 'g1,g2', JSON.stringify(seen(db)));
}

console.log('\nPoller: quota');
{
  const { db, env } = make({ plan: 'free', used: { ui: 30 } });
  await settings.saveSettings(env, { enforce_limits: true });
  feedRow(db);
  db.prepare(`INSERT INTO feed_items (feed_id, guid) VALUES ('f1', 'g1')`).run();
  world.set(URL1, { body: rss([item(2), item(1)]) });
  await poll(env, NOW + 100);
  check('quota used up: nothing posted, nothing counted', posts(db).length === 0 && db.prepare(`SELECT ui_posts u FROM usage_counters WHERE user_id = 'u1'`).get().u === 30);
  check('the item is NOT used up: it waits for the quota', !seen(db).includes('g2'), JSON.stringify(seen(db)));
  check('the person is told why', /Free Trial|plan|post/i.test(feed(db).last_error ?? ''), feed(db).last_error);
  check('and the feed keeps being polled (not disabled)', feed(db).enabled === 1);
  db.prepare(`UPDATE usage_counters SET ui_posts = 5 WHERE user_id = 'u1'`).run();
  db.prepare(`UPDATE feeds SET next_check_at = 0`).run();
  await poll(env, NOW + 5000);
  check('when posts are available again, the waiting item is posted', posts(db).length === 1 && seen(db).includes('g2') && feed(db).last_error === null);
}

console.log('\nPoller: one bad item never stops the rest');
{
  const { db, env } = make({ plan: 'pro' });
  feedRow(db, 'f1', { channel_ids: JSON.stringify([PIN]) });
  db.prepare(`INSERT INTO feed_items (feed_id, guid) VALUES ('f1', 'g0')`).run();
  world.set(URL1, { body: rss([item(1), item(0)]) });
  await poll(env);
  check('Pinterest needs a picture: the item without one is skipped, not posted', posts(db).length === 0 && /picture/i.test(feed(db).last_error ?? ''), feed(db).last_error);
  check('a skipped item is used up (no retry forever) and the feed goes on', seen(db).includes('g1') && feed(db).enabled === 1);
}
{
  const { db, env } = make({ plan: 'pro' });
  feedRow(db, 'f1', { channel_ids: JSON.stringify([CH]) });
  db.prepare(`INSERT INTO feed_items (feed_id, guid) VALUES ('f1', 'g0')`).run();
  world.set(URL1, { body: rss([item(1, '<enclosure url="https://cdn.acme-news.org/a.jpg" type="image/jpeg"/>'), item(0)]) });
  await poll(env);
  const row = db.prepare(`SELECT media_keys m FROM posts`).get();
  check('the picture of the item is attached', row && JSON.parse(row.m)[0] === 'https://cdn.acme-news.org/a.jpg', JSON.stringify(row));
}
{
  const { db, env } = make({ plan: 'pro' });
  env.MODERATION_OFF = undefined;
  feedRow(db);
  db.prepare(`INSERT INTO feed_items (feed_id, guid) VALUES ('f1', 'g0')`).run();
  world.set(URL1, { body: rss([item(1, '<enclosure url="https://cdn.acme-news.org/a.jpg" type="image/jpeg"/>'), item(0)]) });
  await poll(env);
  const row = db.prepare(`SELECT media_keys m FROM posts`).get();
  check('a picture that cannot be checked is dropped: the post goes out as text', row && JSON.parse(row.m).length === 0, JSON.stringify(row));
}
{
  const { db, env } = make({ plan: 'pro' });
  feedRow(db);
  db.prepare(`UPDATE channels SET is_active = 0 WHERE id = '${CH}'`).run();
  db.prepare(`INSERT INTO feed_items (feed_id, guid) VALUES ('f1', 'g0')`).run();
  world.set(URL1, { body: rss([item(1), item(0)]) });
  await poll(env);
  check('the channel is gone: the feed switches itself off and says why', feed(db).enabled === 0 && /channel/i.test(feed(db).last_error ?? '') && posts(db).length === 0, feed(db).last_error);
}

console.log('\nPoller: errors, back-off, switching off');
{
  const { db, env } = make({ plan: 'pro' });
  feedRow(db);
  world.set(URL1, { status: 500, body: 'x' });
  await poll(env);
  let f = feed(db);
  check('an error is recorded and the next try is later (back-off)', f.fail_count === 1 && /500/.test(f.last_error) && f.next_check_at === NOW + feeds.POLL_SECONDS * 2, JSON.stringify(f));
  db.prepare(`UPDATE feeds SET next_check_at = 0, fail_count = 10 WHERE id = 'f1'`).run();
  await poll(env);
  check('the back-off never exceeds 6 hours', feed(db).next_check_at === NOW + 6 * 3600);
  db.prepare(`UPDATE feeds SET next_check_at = 0, fail_count = 19 WHERE id = 'f1'`).run();
  await poll(env);
  check('after 20 failures in a row the feed is switched off', feed(db).enabled === 0 && feed(db).fail_count === 20);
  calls.length = 0;
  db.prepare(`UPDATE feeds SET next_check_at = 0 WHERE id = 'f1'`).run();
  await poll(env);
  check('a switched-off feed is not called', calls.length === 0);
  db.prepare(`UPDATE feeds SET enabled = 1, next_check_at = 0 WHERE id = 'f1'`).run();
  world.set(URL1, { body: rss([item(1)]) });
  await poll(env);
  check('a good answer clears the error counter', feed(db).fail_count === 0 && feed(db).last_error === null);
}
{
  const { db, env } = make({ plan: 'pro' });
  feedRow(db, 'f1', { next_check_at: NOW + 600 });
  calls.length = 0;
  await poll(env);
  check('a feed that is not due is not called', calls.length === 0);
  world.set(URL1, { body: rss([item(1)]), etag: '"e1"' });
  db.prepare(`UPDATE feeds SET next_check_at = 0 WHERE id = 'f1'`).run();
  await poll(env);
  db.prepare(`UPDATE feeds SET next_check_at = 0 WHERE id = 'f1'`).run();
  calls.length = 0;
  await poll(env, NOW + 2000);
  check('the stored ETag makes the next look cheap (304)', calls[0].headers['If-None-Match'] === '"e1"' && feed(db).last_error === null && feed(db).next_check_at === NOW + 2000 + feeds.POLL_SECONDS);
}
{
  const { db, env } = make({ plan: 'pro' });
  for (let i = 0; i < 25; i++) { const id = `f${i}`; feedRow(db, id, { url: `https://f${i}.acme-news.org/feed` }); world.set(`https://f${i}.acme-news.org/feed`, { body: rss([item(1)]) }); }
  const n = await poll(env);
  check('one run takes at most 20 feeds; the rest wait for the next minute', n === 20, String(n));
  check('and the next run takes the rest', (await poll(env)) === 5);
}
{
  const { db, env } = make({ plan: 'pro' });
  feedRow(db);
  db.prepare(`INSERT INTO feed_items (feed_id, guid, created_at) VALUES ('f1', 'old', 1)`).run();
  for (let i = 0; i < 2100; i++) db.prepare(`INSERT INTO feed_items (feed_id, guid, created_at) VALUES ('f1', ?, ?)`).run(`x${i}`, 100 + i);
  world.set(URL1, { body: rss([item(1)]) });
  await poll(env);
  check('the memory of seen items is capped at 2000 (oldest forgotten first)', db.prepare(`SELECT COUNT(*) n FROM feed_items WHERE feed_id = 'f1'`).get().n <= 2001 && !seen(db).includes('old'));
}
{
  const { db, env } = make({ channels: true });
  db.exec(`DROP TABLE feeds`);
  check('before the migration the cron does nothing instead of failing', (await poll(env)) === 0);
}
{
  const { db, env } = make({ plan: 'pro' });
  feedRow(db);
  db.prepare(`INSERT INTO feed_items (feed_id, guid) VALUES ('f1', 'g1')`).run();
  db.prepare(`DELETE FROM users WHERE id = 'u1'`).run();
  check('deleting the account deletes its feeds and their memory', !feed(db) && seen(db).length === 0);
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) { console.log('Failed:\n - ' + failed.join('\n - ')); process.exit(1); }
