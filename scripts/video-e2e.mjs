#!/usr/bin/env node
/**
 * End-to-end test of the Video Engine (chunked R2 uploads, library, video keys) against a LOCAL dev server.
 *
 *   npm run db:local && npm run dev        (in one terminal; `npm run dev` binds R2 too, see package.json)
 *   npm run test:video                     (in another;  BASE=http://localhost:8788 by default)
 *
 * It signs up throw-away users, uploads small generated MP4 files in 8 MiB chunks and walks the whole flow.
 * Nothing leaves your machine: R2 and D1 are the simulated local ones.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';

const BASE = process.env.BASE ?? 'http://localhost:8788';
const PART = 8 * 1024 * 1024;
let passed = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name} ${extra}`); }
}
const section = (t) => console.log(`\n${t}`);

/** JSON or raw-bytes request. `wrangler pages dev` reloads itself now and then: a refused connection is retried for a few seconds. */
async function http(method, path, { cookie, key, body, raw, headers = {} } = {}) {
  const init = {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(raw !== undefined ? { 'content-type': 'application/octet-stream' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...headers,
    },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  };
  let res;
  for (let attempt = 0; ; attempt++) {
    try { res = await fetch(BASE + path, init); break; }
    catch (err) { if (attempt >= 8) throw err; await new Promise((r) => setTimeout(r, 750)); }
  }
  const type = res.headers.get('content-type') ?? '';
  let json = null;
  let bytes = null;
  if (type.includes('json')) { try { json = await res.json(); } catch { /* empty */ } }
  else bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, json, bytes, headers: res.headers };
}

function sql(command) {
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'vane-db', '--local', '--json', '--command', command], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`wrangler failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout)[0].results;
}
function videoEngine(email, ...flags) {
  const r = spawnSync('node', ['scripts/set-video.mjs', email, ...flags], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`set-video failed: ${r.stderr}`);
}

async function signUp(email) {
  const pw = 'Correct-Horse-9';
  const reg = await http('POST', '/api/auth/register', { body: { email, password: pw, name: 'E2E', timezone: 'UTC' } });
  if (reg.status !== 201 && reg.status !== 200) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.json)}`);
  const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: pw }) });
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('login gave no session cookie');
  return { email, cookie, id: sql(`SELECT id FROM users WHERE email = '${email}'`)[0].id };
}

// ── a small but structurally real MP4: ftyp + mdat (random bytes) + moov at the END, like a camera file
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const box = (type, payload) => Buffer.concat([u32(8 + payload.length), Buffer.from(type, 'ascii'), payload]);
function makeMp4(total, { moov = true, brand = 'isom' } = {}) {
  const ftyp = box('ftyp', Buffer.concat([Buffer.from(brand), u32(512), Buffer.from('isomiso2mp41')]));
  const tail = moov ? box('moov', Buffer.alloc(8)) : Buffer.alloc(0);
  const mdatLen = total - ftyp.length - tail.length;
  return Buffer.concat([ftyp, u32(mdatLen), Buffer.from('mdat'), randomBytes(mdatLen - 8), tail]);
}
const slice = (file, n) => file.subarray((n - 1) * PART, Math.min(n * PART, file.length));
const parts = (file) => Math.ceil(file.length / PART);

const start = (auth, size, extra = {}) => http('POST', auth.key ? '/api/v1/video/uploads' : '/api/video/uploads', { ...auth, body: { size, contentType: 'video/mp4', fileName: 'My trip.mp4', ...extra } });
const putPart = (auth, id, n, bytes) => http('PUT', `${auth.key ? '/api/v1/video' : '/api/video'}/uploads/${id}/parts/${n}`, { ...auth, raw: bytes });
const complete = (auth, id) => http('POST', `${auth.key ? '/api/v1/video' : '/api/video'}/uploads/${id}/complete`, { ...auth });

try {
  const ping = await fetch(BASE + '/api/auth/config').catch(() => null);
  if (!ping) { console.error(`Cannot reach ${BASE}. Start it with: npm run db:local && npm run dev`); process.exit(2); }

  const stamp = Date.now();
  const u = await signUp(`vid-e2e-${stamp}@example.com`);
  const other = await signUp(`vid-e2e-other-${stamp}@example.com`);
  const me = { cookie: u.cookie };
  const FILE = makeMp4(2 * PART + 1234);                       // 3 chunks: 8 MiB, 8 MiB, 1234 bytes

  // ───────────────────────────────────────────────────────────────
  section('Access: the Video Engine is its own product');
  check('/api/video/me needs a session (401 without)', (await http('GET', '/api/video/me')).status === 401);
  const m0 = await http('GET', '/api/video/me', me);
  check('a new account has no Video Engine', m0.status === 200 && m0.json?.entitlement?.active === false && m0.json?.entitlement?.status === 'none');
  const denied = await start(me, FILE.length);
  check('starting an upload without it → 403 video_engine_required', denied.status === 403 && denied.json?.code === 'video_engine_required', `${denied.status}`);
  check('a live video key without it → 403 video_engine_required', (await http('POST', '/api/keys', { ...me, body: { name: 'v', scope: 'video' } })).json?.code === 'video_engine_required');
  const tk = await http('POST', '/api/keys', { ...me, body: { name: 'sandbox', scope: 'video', mode: 'test' } });
  check('a TEST video key is always allowed (201, cvid_test_…)', tk.status === 201 && /^cvid_test_[A-Za-z0-9]{24}$/.test(tk.json?.secret ?? ''));
  const testKey = tk.json?.secret;

  videoEngine(u.email, '--days', '30');
  videoEngine(other.email, '--days', '30');                    // so the ownership check, not the missing product, is what refuses them below
  const m1 = await http('GET', '/api/video/me', me);
  check('after switching it on: active, with limits and an empty library', m1.json?.entitlement?.active === true && m1.json?.limits?.maxVideos === 90 && m1.json?.limits?.partSize === PART && m1.json?.usage?.videos?.used === 0 && m1.json?.features?.uploads === true, JSON.stringify(m1.json));

  // ───────────────────────────────────────────────────────────────
  section('Starting an upload');
  check('size is required', (await http('POST', '/api/video/uploads', { ...me, body: { contentType: 'video/mp4' } })).status === 400);
  check('size 0 → 400', (await start(me, 0)).status === 400);
  check('a 3 GB file → 413 file_too_large', (await start(me, 3 * 1024 ** 3)).json?.code === 'file_too_large');
  check('a non-MP4/MOV type → 415', (await http('POST', '/api/video/uploads', { ...me, body: { size: 1000, contentType: 'video/webm' } })).status === 415);
  check('an empty title → 400', (await start(me, FILE.length, { title: '   ' })).status === 400);
  check('too many tags → 400', (await start(me, FILE.length, { tags: Array.from({ length: 31 }, (_, i) => `t${i}`) })).status === 400);

  const s1 = await start(me, FILE.length, { tags: ['#Travel', 'travel', ' Vlog '] });
  check('a valid start → 201 with 3 chunks of 8 MiB', s1.status === 201 && s1.json?.partSize === PART && s1.json?.partCount === 3 && s1.json?.uploadedParts?.length === 0, JSON.stringify(s1.json));
  check('the title comes from the file name', s1.json?.video?.title === 'My trip');
  check('tags are cleaned and de-duplicated', JSON.stringify(s1.json?.video?.tags) === JSON.stringify(['Travel', 'Vlog']), JSON.stringify(s1.json?.video?.tags));
  check('the answer never contains the R2 key or the upload id', !/r2_key|upload_id|uploadId|videos\//.test(JSON.stringify(s1.json)));
  const id = s1.json?.videoId;

  // ───────────────────────────────────────────────────────────────
  section('Sending chunks (out of order, with retries)');
  check('a chunk of the wrong size → 400 bad_part_size', (await putPart(me, id, 2, Buffer.alloc(1000))).json?.code === 'bad_part_size');
  check('chunk 0 and chunk 4 do not exist → 404 no_such_part', (await putPart(me, id, 0, slice(FILE, 1))).status === 404 && (await putPart(me, id, 4, slice(FILE, 1))).status === 404);
  const junk = Buffer.alloc(PART, 7);
  check('a first chunk that is not an MP4 → 415', (await putPart(me, id, 1, junk)).status === 415);
  check("another user cannot touch my upload (404)", (await putPart({ cookie: other.cookie }, id, 3, slice(FILE, 3))).status === 404);

  check('the LAST chunk first is fine', (await putPart(me, id, 3, slice(FILE, 3))).status === 200);
  const st = await http('GET', `/api/video/uploads/${id}`, me);
  check('status lists the stored chunks (how a broken upload resumes)', JSON.stringify(st.json?.uploadedParts) === '[3]', JSON.stringify(st.json));
  const early = await complete(me, id);
  check('finishing early → 409 missing_parts naming 1 and 2', early.status === 409 && early.json?.code === 'missing_parts' && JSON.stringify(early.json?.missing) === '[1,2]', JSON.stringify(early.json));
  check('chunk 2', (await putPart(me, id, 2, slice(FILE, 2))).status === 200);
  check('chunk 2 again (a retry replaces it)', (await putPart(me, id, 2, slice(FILE, 2))).status === 200);
  check('chunk 1', (await putPart(me, id, 1, slice(FILE, 1))).status === 200);
  check('status now lists 1, 2, 3', JSON.stringify((await http('GET', `/api/video/uploads/${id}`, me)).json?.uploadedParts) === '[1,2,3]');

  // ───────────────────────────────────────────────────────────────
  section('Finishing, the library and streaming');
  const done = await complete(me, id);
  check('complete → 200, status ready', done.status === 200 && done.json?.video?.status === 'ready' && done.json?.video?.sizeBytes === FILE.length, JSON.stringify(done.json));
  check('complete again → 200 (idempotent)', (await complete(me, id)).status === 200);
  check('a chunk after the end → 409 not_uploading', (await putPart(me, id, 1, slice(FILE, 1))).json?.code === 'not_uploading');

  const lib = await http('GET', '/api/video/videos', me);
  check('the library lists it, with a stream link', lib.json?.videos?.length === 1 && lib.json.videos[0].fileUrl === `/api/video/videos/${id}/file`, JSON.stringify(lib.json));
  check("the other user's library is empty", (await http('GET', '/api/video/videos', { cookie: other.cookie })).json?.videos?.length === 0);
  check("the other user cannot read my video (404)", (await http('GET', `/api/video/videos/${id}`, { cookie: other.cookie })).status === 404);

  const full = await http('GET', `/api/video/videos/${id}/file`, me);
  check('streaming returns exactly the uploaded bytes', full.status === 200 && full.bytes?.equals(FILE), `${full.status} ${full.bytes?.length}`);
  check('streaming sets video/mp4, Accept-Ranges and nosniff', full.headers.get('content-type') === 'video/mp4' && full.headers.get('accept-ranges') === 'bytes' && full.headers.get('x-content-type-options') === 'nosniff');
  const rng = await http('GET', `/api/video/videos/${id}/file`, { ...me, headers: { range: 'bytes=8388600-8388699' } });
  check('a Range across a chunk boundary → 206 with the right bytes', rng.status === 206 && rng.bytes?.equals(FILE.subarray(8388600, 8388700)) && rng.headers.get('content-range') === `bytes 8388600-8388699/${FILE.length}`);
  check('an impossible Range → 416', (await http('GET', `/api/video/videos/${id}/file`, { ...me, headers: { range: `bytes=${FILE.length + 5}-` } })).status === 416);
  check('streaming needs the owner (401 without a session, 404 for another user)', (await http('GET', `/api/video/videos/${id}/file`)).status === 401 && (await http('GET', `/api/video/videos/${id}/file`, { cookie: other.cookie })).status === 404);

  const pa = await http('PATCH', `/api/video/videos/${id}`, { ...me, body: { title: 'Trip to the sea', description: 'Day one', tags: ['sea'] } });
  check('PATCH changes title, description and tags', pa.status === 200 && pa.json?.video?.title === 'Trip to the sea' && pa.json?.video?.description === 'Day one' && pa.json?.video?.tags?.[0] === 'sea');
  check('PATCH with nothing to change → 400', (await http('PATCH', `/api/video/videos/${id}`, { ...me, body: {} })).status === 400);
  check('PATCH with a 101-character title → 400', (await http('PATCH', `/api/video/videos/${id}`, { ...me, body: { title: 'x'.repeat(101) } })).status === 400);
  check('the usage counter follows the library', (await http('GET', '/api/video/me', me)).json?.usage?.videos?.used === 1);

  // ───────────────────────────────────────────────────────────────
  section('Files that are not what they claim');
  const noMoov = makeMp4(PART + 500, { moov: false });
  const s2 = await start(me, noMoov.length);
  await putPart(me, s2.json.videoId, 1, slice(noMoov, 1));
  await putPart(me, s2.json.videoId, 2, slice(noMoov, 2));
  const bad = await complete(me, s2.json.videoId);
  check('a cut-off MP4 (no moov) → 422 invalid_video', bad.status === 422 && bad.json?.code === 'invalid_video', JSON.stringify(bad.json));
  const failed = (await http('GET', '/api/video/videos', me)).json?.videos?.find((v) => v.id === s2.json.videoId);
  check('it stays in the list as failed, with the reason', failed?.status === 'failed' && /moov/.test(failed?.error ?? ''), JSON.stringify(failed));
  check('a failed upload does not use a library slot', (await http('GET', '/api/video/me', me)).json?.usage?.videos?.used === 1);
  check('and can be deleted', (await http('DELETE', `/api/video/videos/${s2.json.videoId}`, me)).status === 200);

  const mov = await start(me, 5000, { fileName: 'clip.mov' });
  const wrongType = await http('POST', '/api/video/uploads', { ...me, body: { size: 5000, contentType: 'video/quicktime' } });
  check('a MOV declaration is accepted', wrongType.status === 201);
  check('but an MP4 file under it → 415 type_mismatch', (await putPart(me, wrongType.json.videoId, 1, makeMp4(5000))).json?.code === 'type_mismatch');
  void mov;

  const s3 = await start(me, 5000);
  check('cancelling an unfinished upload → 200', (await http('DELETE', `/api/video/uploads/${s3.json.videoId}`, me)).status === 200);
  check('and it is gone (404)', (await http('GET', `/api/video/uploads/${s3.json.videoId}`, me)).status === 404);
  await http('DELETE', `/api/video/uploads/${wrongType.json.videoId}`, me);
  await http('DELETE', `/api/video/uploads/${mov.json.videoId}`, me);

  // ───────────────────────────────────────────────────────────────
  section('Expired uploads and the library limit (90 videos)');
  const s4 = await start(me, 5000);
  sql(`UPDATE videos SET upload_expires_at = unixepoch() - 5 WHERE id = '${s4.json.videoId}'`);
  check('an upload past its deadline → 410 upload_expired', (await putPart(me, s4.json.videoId, 1, makeMp4(5000))).status === 410);
  const s5 = await start(me, 5000);
  check('starting the next one clears the expired upload', s5.status === 201 && (await http('GET', `/api/video/uploads/${s4.json.videoId}`, me)).status === 404);
  await http('DELETE', `/api/video/uploads/${s5.json.videoId}`, me);

  sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 89)
       INSERT INTO videos (id, user_id, title, status, r2_key, content_type, size_bytes, part_size, source)
       SELECT 'filler-' || i, '${u.id}', 'filler ' || i, 'ready', 'videos/filler/' || i, 'video/mp4', 1, ${PART}, 'ui' FROM n`);
  check('89 fillers + my 1 video = 90: the library is full', (await http('GET', '/api/video/me', me)).json?.usage?.videos?.remaining === 0);
  const full90 = await start(me, 5000);
  check('the 91st → 409 video_limit', full90.status === 409 && full90.json?.code === 'video_limit', JSON.stringify(full90.json));
  sql(`DELETE FROM videos WHERE id LIKE 'filler-%'`);

  // ───────────────────────────────────────────────────────────────
  section('Video keys: /api/v1/video (cvid_), apart from the posting keys (cpost_)');
  const lk = await http('POST', '/api/keys', { ...me, body: { name: 'Make video', scope: 'video' } });
  check('a live video key is created now (cvid_live_ + 24 chars)', lk.status === 201 && /^cvid_live_[A-Za-z0-9]{24}$/.test(lk.json?.secret ?? ''), JSON.stringify(lk.json));
  const liveKey = lk.json?.secret;
  const pk = await http('POST', '/api/keys', { ...me, body: { name: 'posts' } });
  const postKey = pk.json?.secret;

  const kPost = (await http('GET', '/api/keys?scope=post', me)).json?.keys ?? [];
  const kVideo = (await http('GET', '/api/keys?scope=video', me)).json?.keys ?? [];
  check('each dashboard lists only its own keys (?scope=post / ?scope=video)', kPost.length > 0 && kPost.every((k) => k.scope === 'post') && kVideo.length > 0 && kVideo.every((k) => k.scope === 'video'), `${kPost.length}/${kVideo.length}`);
  check('a bad ?scope → 400', (await http('GET', '/api/keys?scope=admin', me)).status === 400);
  check('GET /api/v1/video/me with a cvid_ key → 200', (await http('GET', '/api/v1/video/me', { key: liveKey })).json?.videoEngine?.active === true);
  const wrong = await http('GET', '/api/v1/video/me', { key: postKey });
  check('a cpost_ key on a video route → 403 wrong_key_scope', wrong.status === 403 && wrong.json?.code === 'wrong_key_scope');
  check('a cvid_ key on a posting route → 403 wrong_key_scope', (await http('GET', '/api/v1/me', { key: liveKey })).json?.code === 'wrong_key_scope');
  check('no key → 401', (await http('GET', '/api/v1/video/me')).status === 401);
  check('a session cookie is not a key (401)', (await http('GET', '/api/v1/video/me', me)).status === 401);

  // the whole upload through the public API with ONE key: 1 + 3 chunks + status + complete + list + delete = 8 of its 10 requests a minute
  const a = { key: liveKey };
  const v1 = await start(a, FILE.length, { title: 'From the API' });
  check('API: start → 201', v1.status === 201 && v1.json?.partCount === 3, JSON.stringify(v1.json));
  for (const n of [1, 2, 3]) await putPart(a, v1.json.videoId, n, slice(FILE, n));
  check('API: status lists 3 chunks', JSON.stringify((await http('GET', `/api/v1/video/uploads/${v1.json.videoId}`, a)).json?.uploadedParts) === '[1,2,3]');
  const v1done = await complete(a, v1.json.videoId);
  check('API: complete → ready, and no stream link in the public API', v1done.json?.video?.status === 'ready' && v1done.json?.video?.fileUrl === null, JSON.stringify(v1done.json));
  const v1list = await http('GET', '/api/v1/video/videos', a);
  check('API: the library shows both videos (the dashboard one and this one)', v1list.json?.videos?.length === 2);
  check('API: DELETE removes it', (await http('DELETE', `/api/v1/video/videos/${v1.json.videoId}`, a)).status === 200);

  // test keys: real shape, nothing stored
  const before = sql(`SELECT COUNT(*) AS n FROM videos WHERE user_id = '${u.id}'`)[0].n;
  const t = { key: testKey };
  const ts = await start(t, FILE.length);
  check('test key: start → 201 simulated, with a made-up id', ts.status === 201 && ts.json?.simulated === true && ts.json?.partCount === 3 && typeof ts.json?.videoId === 'string');
  check('test key: chunk and complete are accepted and ignored', (await putPart(t, ts.json.videoId, 1, Buffer.alloc(10))).json?.simulated === true && (await complete(t, ts.json.videoId)).json?.simulated === true);
  check('test key: it still validates the body (bad type → 415)', (await http('POST', '/api/v1/video/uploads', { ...t, body: { size: 10, contentType: 'x/y' } })).status === 415);
  const after = sql(`SELECT COUNT(*) AS n FROM videos WHERE user_id = '${u.id}'`)[0].n;
  check('test key: nothing was stored', before === after, `${before} → ${after}`);

  // 10 requests a minute per video key (SECURITY_ARCHITECTURE.md §2.2)
  const rl = await http('POST', '/api/keys', { ...me, body: { name: 'rate probe', scope: 'video', mode: 'test' } });
  let seen429 = null;
  for (let i = 0; i < 12 && rl.json?.secret; i++) {
    const r = await http('GET', '/api/v1/video/me', { key: rl.json.secret });
    if (r.status === 429) { seen429 = { at: i + 1, code: r.json?.code, retry: r.headers.get('retry-after') }; break; }
  }
  check('the 11th request in a minute → 429 rate_limited with Retry-After', seen429?.at === 11 && seen429.code === 'rate_limited' && Number(seen429.retry) > 0, JSON.stringify(seen429));

  // ───────────────────────────────────────────────────────────────
  section('Switching the Video Engine off');
  videoEngine(u.email, '--off');
  check('a live video key stops working (403 video_engine_required)', (await http('GET', '/api/v1/video/me', { key: (await http('POST', '/api/keys', { ...me, body: { name: 'x', scope: 'video', mode: 'test' } })).json?.secret })).status === 200
    && (await http('GET', '/api/v1/video/videos', { key: liveKey })).json?.code === 'video_engine_required');
  check('the dashboard says it lapsed, and uploads are refused', (await http('GET', '/api/video/me', me)).json?.entitlement?.lapsed === true && (await start(me, 5000)).json?.code === 'video_engine_required');
  check('but the account can still see and delete its videos', (await http('GET', '/api/video/videos', me)).json?.videos?.length === 1 && (await http('DELETE', `/api/video/videos/${id}`, me)).status === 200);
  check('a deleted video is gone from storage too (404 on the stream)', (await http('GET', `/api/video/videos/${id}/file`, me)).status === 404);
  void randomUUID;
} catch (err) {
  console.error('\nTest run aborted:', err instanceof Error ? err.message : err);
  process.exit(2);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('Failed:\n  - ' + failures.join('\n  - ')); process.exit(1); }
