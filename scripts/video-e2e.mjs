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
  section('Preview frame and length');
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(2000)]);
  const putThumb = (auth, vid, bytes, query = '') => http('PUT', `/api/video/videos/${vid}/thumbnail${query}`, { ...auth, raw: bytes });
  check('no preview yet → 404', (await http('GET', `/api/video/videos/${id}/thumbnail`, me)).status === 404);
  check('a preview that is not a JPEG → 415', (await putThumb(me, id, Buffer.alloc(500, 1))).status === 415);
  check('a 400 KB preview → 413 thumbnail_too_large', (await putThumb(me, id, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(400 * 1024)]))).json?.code === 'thumbnail_too_large');
  check('a bad length value → 400', (await putThumb(me, id, JPEG, '?d=abc')).status === 400);
  const pending = await start(me, 5000);
  check('a preview for an unfinished upload → 409 not_ready', (await putThumb(me, pending.json.videoId, JPEG)).json?.code === 'not_ready');
  await http('DELETE', `/api/video/uploads/${pending.json.videoId}`, me);
  check("another user cannot add a preview to my video (404)", (await putThumb({ cookie: other.cookie }, id, JPEG)).status === 404);

  const tp = await putThumb(me, id, JPEG, '?d=61500&w=1280&h=720');
  check('a JPEG with its length and size is stored → the video reports them', tp.status === 200 && tp.json?.video?.durationMs === 61500 && tp.json.video.width === 1280 && tp.json.video.height === 720 && tp.json.video.thumbnailUrl === `/api/video/videos/${id}/thumbnail`, JSON.stringify(tp.json));
  const tg = await http('GET', `/api/video/videos/${id}/thumbnail`, me);
  check('the owner gets the same image back (image/jpeg, private cache)', tg.status === 200 && tg.bytes?.equals(JPEG) && tg.headers.get('content-type') === 'image/jpeg' && /private/.test(tg.headers.get('cache-control') ?? ''));
  check('the preview needs the owner (401 without a session, 404 for another user)', (await http('GET', `/api/video/videos/${id}/thumbnail`)).status === 401 && (await http('GET', `/api/video/videos/${id}/thumbnail`, { cookie: other.cookie })).status === 404);
  check('sending a preview again without the length keeps the length', (await putThumb(me, id, JPEG)).json?.video?.durationMs === 61500);
  const lib2 = (await http('GET', '/api/video/videos', me)).json?.videos?.find((v) => v.id === id);
  check('the library list carries preview address and length', lib2?.thumbnailUrl && lib2?.durationMs === 61500);

  // ───────────────────────────────────────────────────────────────
  section('Public link');
  const lc = await http('POST', `/api/video/videos/${id}/link`, me);
  const linkUrl = lc.json?.url ?? '';
  check('POST link → 201 with an unguessable address (32 characters)', lc.status === 201 && /\/api\/video\/public\/[A-Za-z0-9_-]{32}$/.test(linkUrl), JSON.stringify(lc.json));
  check('the video shows its public address', lc.json?.video?.publicUrl === linkUrl);
  check('asking again returns the SAME address (one link per video)', (await http('POST', `/api/video/videos/${id}/link`, me)).json?.url === linkUrl);
  const pub = await fetch(linkUrl);                              // no cookie, no key: the address is the permission
  const pubBytes = Buffer.from(await pub.arrayBuffer());
  check('anyone with the address gets the video (200, exact bytes, no sign-in)', pub.status === 200 && pubBytes.equals(FILE), `${pub.status} ${pubBytes.length}`);
  check('it is marked noindex, public-cached and named after the title', pub.headers.get('x-robots-tag') === 'noindex, nofollow' && /public/.test(pub.headers.get('cache-control') ?? '') && /filename\*=UTF-8''Trip%20to%20the%20sea\.mp4/.test(pub.headers.get('content-disposition') ?? ''), `${pub.headers.get('content-disposition')}`);
  const pr = await fetch(linkUrl, { headers: { range: 'bytes=100-199' } });
  check('Range works on the public address (206)', pr.status === 206 && Buffer.from(await pr.arrayBuffer()).equals(FILE.subarray(100, 200)));
  const ph = await fetch(linkUrl, { method: 'HEAD' });
  check('HEAD returns the length (platforms ask for it first)', ph.status === 200 && Number(ph.headers.get('content-length')) === FILE.length);
  check('a wrong or made-up token → 404', (await fetch(linkUrl.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')))).status === 404 && (await fetch(`${linkUrl.slice(0, linkUrl.lastIndexOf('/'))}/${'A'.repeat(32)}`)).status === 404 && (await fetch(`${linkUrl.slice(0, linkUrl.lastIndexOf('/'))}/short`)).status === 404);
  check("another user cannot make or remove my video's link (404)", (await http('POST', `/api/video/videos/${id}/link`, { cookie: other.cookie })).status === 404 && (await http('DELETE', `/api/video/videos/${id}/link`, { cookie: other.cookie })).status === 404);
  const lr = await http('DELETE', `/api/video/videos/${id}/link`, me);
  check('DELETE link → 200, the address stops working at once', lr.status === 200 && lr.json?.video?.publicUrl === null && (await fetch(linkUrl)).status === 404);
  const lc2 = await http('POST', `/api/video/videos/${id}/link`, me);
  check('a new link is a NEW address (the old one stays dead)', lc2.status === 201 && lc2.json?.url !== linkUrl && (await fetch(linkUrl)).status === 404);
  const liveLink = lc2.json?.url;
  const pend2 = await start(me, 5000);
  check('a link for an unfinished upload → 409 not_ready', (await http('POST', `/api/video/videos/${pend2.json.videoId}/link`, me)).json?.code === 'not_ready');
  await http('DELETE', `/api/video/uploads/${pend2.json.videoId}`, me);

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

  // links and the public shape through the API (a fresh key: each key has only 10 requests a minute)
  const lk3 = await http('POST', '/api/keys', { ...me, body: { name: 'links', scope: 'video' } });
  const b = { key: lk3.json?.secret };
  const v1l = await http('GET', '/api/v1/video/videos', b);
  const mine = v1l.json?.videos?.find((v) => v.id === id);
  check('API: the list shows length and the public address, but no private preview/stream address', mine?.durationMs === 61500 && mine?.publicUrl === liveLink && mine?.thumbnailUrl === null && mine?.fileUrl === null, JSON.stringify(mine));
  check('API: DELETE link removes it', (await http('DELETE', `/api/v1/video/videos/${id}/link`, b)).json?.video?.publicUrl === null && (await fetch(liveLink)).status === 404);
  const apiLink = await http('POST', `/api/v1/video/videos/${id}/link`, b);
  check('API: POST link makes a new one that opens without a key', apiLink.status === 201 && (await fetch(apiLink.json.url)).status === 200);
  const linksBefore = sql(`SELECT COUNT(*) AS n FROM video_links`)[0].n;
  const simLink = await http('POST', `/api/v1/video/videos/${id}/link`, t);
  check('test key: POST link is simulated (looks real, creates nothing)', simLink.status === 200 || simLink.status === 201 ? simLink.json?.simulated === true && /\/api\/video\/public\/x{32}$/.test(simLink.json?.url ?? '') : false, JSON.stringify(simLink.json));
  check('test key: DELETE link is simulated and the real link survives', (await http('DELETE', `/api/v1/video/videos/${id}/link`, t)).json?.simulated === true && sql(`SELECT COUNT(*) AS n FROM video_links`)[0].n === linksBefore);
  let finalLink = apiLink.json.url;

  // 10 requests a minute per video key (SECURITY_ARCHITECTURE.md §2.2)
  const rl = await http('POST', '/api/keys', { ...me, body: { name: 'rate probe', scope: 'video', mode: 'test' } });
  let seen429 = null;
  for (let i = 0; i < 12 && rl.json?.secret; i++) {
    const r = await http('GET', '/api/v1/video/me', { key: rl.json.secret });
    if (r.status === 429) { seen429 = { at: i + 1, code: r.json?.code, retry: r.headers.get('retry-after') }; break; }
  }
  check('the 11th request in a minute → 429 rate_limited with Retry-After', seen429?.at === 11 && seen429.code === 'rate_limited' && Number(seen429.retry) > 0, JSON.stringify(seen429));

  // ───────────────────────────────────────────────────────────────
  section('Announcing a video in Vane Post (the Studio → Post hand-off)');
  const hookId = randomUUID(), xId = randomUUID(), foreignChannel = randomUUID();
  sql(`INSERT INTO channels (id, user_id, type, name, credentials) VALUES ('${hookId}', '${u.id}', 'webhook', 'E2E hook', 'x'), ('${xId}', '${u.id}', 'x', 'E2E x', 'x'), ('${foreignChannel}', '${other.id}', 'webhook', 'Not mine', 'x')`);
  const ann = (auth, vid, body) => http('POST', `/api/video/videos/${vid}/announce`, { ...auth, body });
  const postsOf = (groupId) => sql(`SELECT channel_id, content, status FROM posts WHERE group_id = '${groupId}'`);
  const linkOf = async () => (await http('GET', `/api/video/videos/${id}`, me)).json?.video?.publicUrl;
  const ch = await http('GET', '/api/video/announce', me);
  check('the channel list shows my channels and never their credentials', ch.status === 200 && ch.json?.channels?.length === 2 && !/credentials|"x"\s*}/.test(JSON.stringify(ch.json)) && ch.json.channels.every((c) => c.id && c.platform && c.name), JSON.stringify(ch.json));
  check('the channel list needs a session (401)', (await http('GET', '/api/video/announce')).status === 401);
  check('another user sees only their own channel, none of mine', (() => null)() === null && (await http('GET', '/api/video/announce', { cookie: other.cookie })).json?.channels?.every((c) => c.id === foreignChannel) === true);

  check('no text → 400', (await ann(me, id, { channelIds: [hookId] })).status === 400);
  check('no channels → 400', (await ann(me, id, { text: 'Hi {link}', channelIds: [] })).status === 400);
  check("another user's channel → 404", (await ann(me, id, { text: 'Hi', channelIds: [foreignChannel] })).status === 404);
  check("another user's video → 404", (await ann({ cookie: other.cookie }, id, { text: 'Hi', channelIds: [hookId] })).status === 404);
  const unfinished = await start(me, 5000);
  check('an unfinished upload cannot be announced → 409 not_ready', (await ann(me, unfinished.json.videoId, { text: 'Hi', channelIds: [hookId] })).json?.code === 'not_ready');
  await http('DELETE', `/api/video/uploads/${unfinished.json.videoId}`, me);

  await http('DELETE', `/api/video/videos/${id}/link`, me);
  check('(setup) the video has no public link now', (await linkOf()) === null);
  const longText = 'a'.repeat(290) + ' {link}';
  const tooLong = await ann(me, id, { text: longText, channelIds: [xId] });
  check('a text too long for X (280) is refused with the reason', tooLong.status === 400 && /too long for x/i.test(tooLong.json?.error ?? ''), JSON.stringify(tooLong.json));
  check('and no link was made by the failed attempt (all or nothing)', (await linkOf()) === null && postsOf('none').length === 0);

  const a1 = await ann(me, id, { text: 'New video!\n\n{link}', channelIds: [hookId] });
  const madeLink = await linkOf();
  check('announce → 201; the video got a public link because the text asked for it', a1.status === 201 && a1.json?.channels === 1 && /\/api\/video\/public\/[A-Za-z0-9_-]{32}$/.test(madeLink ?? '') && a1.json?.url === madeLink, JSON.stringify(a1.json));
  const rows1 = postsOf(a1.json.groupId);
  check('one post per channel is scheduled, with the real address in the text', rows1.length === 1 && rows1[0].status === 'scheduled' && rows1[0].channel_id === hookId && rows1[0].content === `New video!\n\n${madeLink}`, JSON.stringify(rows1));
  check('the address in the post opens the video without signing in', (await fetch(madeLink)).status === 200);
  const a2 = await ann(me, id, { text: '{link} and again {link}', channelIds: [hookId] });
  check('announcing again reuses the SAME link (every {link} replaced)', a2.status === 201 && a2.json?.text === `${madeLink} and again ${madeLink}` && (await linkOf()) === madeLink);
  check('the dashboard post counter went up (same counting as Vane Post)', sql(`SELECT COALESCE(SUM(ui_posts), 0) AS n FROM usage_counters WHERE user_id = '${u.id}'`)[0].n >= 2);

  await http('DELETE', `/api/video/videos/${id}/link`, me);
  const a3 = await ann(me, id, { text: 'Just words, no link', channelIds: [hookId, xId] });
  check('a text without {link} posts as written and makes NO link', a3.status === 201 && a3.json?.channels === 2 && a3.json?.url === null && (await linkOf()) === null && postsOf(a3.json.groupId).every((r) => r.content === 'Just words, no link'));
  check('the dashboard gets the 4 results it needs (groupId, channels, text, scheduledAt)', a3.json?.groupId && a3.json?.text && a3.json?.scheduledAt > Math.floor(Date.now() / 1000) - 5);

  finalLink = (await http('POST', `/api/video/videos/${id}/link`, me)).json?.url;   // leave a link for the next part of the run
  sql(`DELETE FROM channels WHERE id IN ('${hookId}', '${xId}', '${foreignChannel}')`);

  // ───────────────────────────────────────────────────────────────
  section('Video channels (stubs until YouTube, TikTok and Instagram approve Vane)');
  check('the channel list needs a session (401)', (await http('GET', '/api/video/channels')).status === 401);
  const vc = await http('GET', '/api/video/channels', me);
  check('a new account has no video channels, and the catalog lists the 3 networks as not open yet', vc.status === 200 && vc.json?.channels?.length === 0 && JSON.stringify(vc.json?.platforms?.map((p) => p.id)) === '["youtube","tiktok","instagram"]' && vc.json.platforms.every((p) => p.available === false && p.name && p.note), JSON.stringify(vc.json));
  for (const [pid, name] of [['youtube', 'YouTube'], ['tiktok', 'TikTok'], ['instagram', 'Instagram Reels']]) {
    const c = await http('POST', '/api/video/channels/connect', { ...me, body: { platform: pid } });
    check(`connecting ${name} → 409 platform_unavailable, with the reason`, c.status === 409 && c.json?.code === 'platform_unavailable' && c.json?.error?.includes(name) && /verification|review/i.test(c.json.error), JSON.stringify(c.json));
  }
  check('an unknown network → 400', (await http('POST', '/api/video/channels/connect', { ...me, body: { platform: 'myspace' } })).status === 400);
  check('connect needs a session (401)', (await http('POST', '/api/video/channels/connect', { body: { platform: 'youtube' } })).status === 401);
  check('removing a channel that does not exist → 404', (await http('DELETE', `/api/video/channels/${randomUUID()}`, me)).status === 404 && (await http('DELETE', '/api/video/channels/not-an-id', me)).status === 404);

  const vcMine = randomUUID(), vcOther = randomUUID();
  sql(`INSERT INTO video_channels (id, user_id, platform, name, account_ref, credentials) VALUES ('${vcMine}', '${u.id}', 'youtube', 'My channel', 'UC1', 'secret-token'), ('${vcOther}', '${other.id}', 'tiktok', 'Theirs', 'tt1', 'secret-token')`);
  const vc2 = await http('GET', '/api/video/channels', me);
  check('a connected channel is listed with its network and name, and never with credentials', vc2.json?.channels?.length === 1 && vc2.json.channels[0].id === vcMine && vc2.json.channels[0].platform === 'youtube' && vc2.json.channels[0].name === 'My channel' && !/secret-token|credentials/.test(JSON.stringify(vc2.json)), JSON.stringify(vc2.json));
  check("I cannot remove another user's channel (404), and it is still there", (await http('DELETE', `/api/video/channels/${vcOther}`, me)).status === 404 && sql(`SELECT COUNT(*) AS n FROM video_channels WHERE id = '${vcOther}'`)[0].n === 1);
  check('the same account cannot be stored twice (unique per user, network and account)', (() => { try { sql(`INSERT INTO video_channels (id, user_id, platform, name, account_ref, credentials) VALUES ('${randomUUID()}', '${u.id}', 'youtube', 'Dup', 'UC1', 'x')`); return false; } catch { return true; } })());
  check('removing my channel → 200 and it is gone', (await http('DELETE', `/api/video/channels/${vcMine}`, me)).status === 200 && (await http('GET', '/api/video/channels', me)).json?.channels?.length === 0);
  sql(`DELETE FROM video_channels WHERE id = '${vcOther}'`);

  // ───────────────────────────────────────────────────────────────
  section('Switching the Video Engine off');
  videoEngine(u.email, '--off');
  check('a live video key stops working (403 video_engine_required)', (await http('GET', '/api/v1/video/me', { key: (await http('POST', '/api/keys', { ...me, body: { name: 'x', scope: 'video', mode: 'test' } })).json?.secret })).status === 200
    && (await http('GET', '/api/v1/video/videos', { key: liveKey })).json?.code === 'video_engine_required');
  check('the dashboard says it lapsed, and uploads are refused', (await http('GET', '/api/video/me', me)).json?.entitlement?.lapsed === true && (await start(me, 5000)).json?.code === 'video_engine_required');
  check('without Vane Studio an announcement is refused (403 video_engine_required)', (await ann(me, id, { text: 'Hi {link}', channelIds: [randomUUID()] })).json?.code === 'video_engine_required');
  check('without Vane Studio a public link cannot be made, but it can still be removed', (await http('POST', `/api/video/videos/${id}/link`, me)).json?.code === 'video_engine_required' && (await http('DELETE', `/api/video/videos/${id}/link`, me)).status === 200 && (await fetch(finalLink)).status === 404);
  const gone = id;
  check('but the account can still see and delete its videos', (await http('GET', '/api/video/videos', me)).json?.videos?.length === 1 && (await http('DELETE', `/api/video/videos/${id}`, me)).status === 200);
  check('a deleted video is gone from storage too (404 on the stream)', (await http('GET', `/api/video/videos/${id}/file`, me)).status === 404);
  check('and its preview and links are gone with it (404)', (await http('GET', `/api/video/videos/${gone}/thumbnail`, me)).status === 404 && sql(`SELECT COUNT(*) AS n FROM video_assets WHERE video_id = '${gone}'`)[0].n === 0);
  void randomUUID;
} catch (err) {
  console.error('\nTest run aborted:', err instanceof Error ? err.message : err);
  process.exit(2);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('Failed:\n  - ' + failures.join('\n  - ')); process.exit(1); }
