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
  const reg = await http('POST', '/api/auth/register', { body: { email, password: pw, name: 'E2E', timezone: 'UTC', birthDate: '1990-01-15' } });
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
  section('Publishing queue (network-agnostic: tested on a fake network, VIDEO_PUBLISH_MOCK=1)');
  const mockCh = (platform, name, creds, owner = u.id) => { const cid = randomUUID(); sql(`INSERT INTO video_channels (id, user_id, platform, name, account_ref, credentials) VALUES ('${cid}', '${owner}', '${platform}', '${name}', '${cid}', '${creds.replace(/'/g, "''")}')`); return cid; };
  const chOk = mockCh('youtube', 'Mock YouTube', '{"mock":"ok"}');
  const chFlaky = mockCh('tiktok', 'Mock TikTok', '{"mock":"flaky","failures":2}');
  const chFail = mockCh('instagram', 'Mock Instagram', '{"mock":"fail","retryable":false,"error":"Quota exceeded"}');
  const chTemp = mockCh('youtube', 'Mock Temp', '{"mock":"fail","retryable":true,"error":"Temporary"}');
  const chReal = mockCh('tiktok', 'Real network', 'encrypted-blob-of-a-real-account');
  const chOther = mockCh('youtube', 'Not mine', '{"mock":"ok"}', other.id);
  const pubReq = (auth, vid, body) => http('POST', `/api/video/videos/${vid}/publish`, { ...auth, body });
  const pubList = async (q = '') => (await http('GET', `/api/video/publications${q}`, me)).json?.publications ?? [];
  const nowSec = () => Math.floor(Date.now() / 1000);
  async function waitFor(pid, pred, ms = 12000) { const t0 = Date.now(); let last = null; while (Date.now() - t0 < ms) { last = (await pubList()).find((p) => p.id === pid); if (last && pred(last)) return last; await new Promise((r) => setTimeout(r, 250)); } return last; }
  const makeDue = (pid) => sql(`UPDATE video_publications SET next_attempt_at = 0 WHERE id = '${pid}'`);

  check('publishing needs a session (401)', (await http('POST', `/api/video/videos/${id}/publish`, { body: { channelIds: [chOk] } })).status === 401 && (await http('GET', '/api/video/publications')).status === 401);
  check('no channels → 400', (await pubReq(me, id, { channelIds: [] })).status === 400 && (await pubReq(me, id, {})).status === 400);
  check('a bad privacy value → 400', (await pubReq(me, id, { channelIds: [chOk], privacy: 'everyone' })).status === 400);
  check('a 101-character title → 400', (await pubReq(me, id, { channelIds: [chOk], title: 'x'.repeat(101) })).status === 400);
  check('an unknown channel → 404, and so is another user\'s channel', (await pubReq(me, id, { channelIds: [randomUUID()] })).status === 404 && (await pubReq(me, id, { channelIds: [chOther] })).status === 404);
  check("another user's video → 404", (await pubReq({ cookie: other.cookie }, id, { channelIds: [chOther] })).status === 404);
  const unfinished2 = await start(me, 5000);
  check('an unfinished upload cannot be published → 409 not_ready', (await pubReq(me, unfinished2.json.videoId, { channelIds: [chOk] })).json?.code === 'not_ready');
  await http('DELETE', `/api/video/uploads/${unfinished2.json.videoId}`, me);

  // ── success: what the user chose reaches the publisher, and the result is recorded
  const pkOk = await pubReq(me, id, { channelIds: [chOk], title: 'Custom title', description: 'About it', privacy: 'unlisted' });
  check('publish → 201 with one publication for the channel', pkOk.status === 201 && pkOk.json?.publications?.length === 1 && pkOk.json.publications[0].platform === 'youtube' && pkOk.json.publications[0].channelName === 'Mock YouTube' && pkOk.json.publications[0].privacy === 'unlisted', JSON.stringify(pkOk.json));
  const okId = pkOk.json?.publications?.[0]?.id;
  const done1 = await waitFor(okId, (p) => p.status === 'published' || p.status === 'failed');
  check('it is published at once, in the background (the file was read from storage)', done1?.status === 'published' && done1.attempts === 1 && done1.error === null && typeof done1.publishedAt === 'number', JSON.stringify(done1));
  check('the network received the title, privacy and size the user chose', new URL(done1?.url ?? 'http://x').searchParams.get('title') === 'Custom title' && new URL(done1.url).searchParams.get('privacy') === 'unlisted' && Number(new URL(done1.url).searchParams.get('size')) === FILE.length && done1.title === 'Custom title' && done1.description === 'About it', done1?.url);
  const second = await pubReq(me, id, { channelIds: [chOk] });
  check('publishing the same video to the same channel AGAIN after it finished is allowed', second.status === 201);
  const secondDone = await waitFor(second.json?.publications?.[0]?.id, (p) => p.status === 'published');
  check('and the defaults apply: the video title, and private', secondDone?.title === 'Trip to the sea' && secondDone?.privacy === 'private', JSON.stringify(secondDone));

  // ── temporary failures: retried with a growing pause, then it works
  const flakyPub = await pubReq(me, id, { channelIds: [chFlaky] });
  const flakyId = flakyPub.json?.publications?.[0]?.id;
  const f1 = await waitFor(flakyId, (p) => p.status === 'queued' && p.attempts === 1);
  check('a temporary failure is queued again after ~30 s, with the reason', f1?.status === 'queued' && /temporary failure \(attempt 1\)/i.test(f1.error ?? '') && f1.nextAttemptAt >= nowSec() + 20 && f1.nextAttemptAt <= nowSec() + 40, JSON.stringify(f1));
  check('the same video to the same channel while it is queued → 409 already_queued', (await pubReq(me, id, { channelIds: [chFlaky] })).json?.code === 'already_queued');
  makeDue(flakyId); await pubList();
  const f2 = await waitFor(flakyId, (p) => p.attempts === 2 && p.status === 'queued');
  check('the second try fails too, and the pause grows to ~2 min', f2?.attempts === 2 && f2.nextAttemptAt >= nowSec() + 100 && f2.nextAttemptAt <= nowSec() + 130, JSON.stringify(f2));
  makeDue(flakyId); await pubList();
  const f3 = await waitFor(flakyId, (p) => p.status === 'published');
  check('the third try succeeds: published after 3 attempts, the error is cleared', f3?.status === 'published' && f3.attempts === 3 && f3.error === null && f3.nextAttemptAt === null, JSON.stringify(f3));

  // ── a permanent failure is not retried; "Retry" starts over
  const failPub = await pubReq(me, id, { channelIds: [chFail] });
  const failId = failPub.json?.publications?.[0]?.id;
  const fail1 = await waitFor(failId, (p) => p.status === 'failed');
  check('a permanent failure → failed at once, with the network\'s reason, no retry scheduled', fail1?.status === 'failed' && fail1.attempts === 1 && fail1.error === 'Quota exceeded' && fail1.nextAttemptAt === null, JSON.stringify(fail1));
  check('Retry on a published one → 409 not_failed', (await http('POST', `/api/video/publications/${okId}/retry`, me)).json?.code === 'not_failed');
  check("another user cannot retry or remove mine (404)", (await http('POST', `/api/video/publications/${failId}/retry`, { cookie: other.cookie })).status === 404 && (await http('DELETE', `/api/video/publications/${failId}`, { cookie: other.cookie })).status === 404);
  const retryRes = await http('POST', `/api/video/publications/${failId}/retry`, me);
  check('Retry on a failed one → 200, back in the queue with the tries reset', retryRes.status === 200 && ['queued', 'publishing', 'failed'].includes(retryRes.json?.publication?.status), JSON.stringify(retryRes.json));
  const fail2 = await waitFor(failId, (p) => p.status === 'failed' && p.attempts === 1, 8000);
  check('it ran again (and failed again, as this fake network always does)', fail2?.status === 'failed' && fail2.attempts === 1 && fail2.error === 'Quota exceeded');

  // ── the tries run out
  const tempPub = await pubReq(me, id, { channelIds: [chTemp] });
  const tempId = tempPub.json?.publications?.[0]?.id;
  let temp = await waitFor(tempId, (p) => p.attempts === 1 && p.status === 'queued');
  for (let n = 2; n <= 5; n++) { makeDue(tempId); await pubList(); temp = await waitFor(tempId, (p) => p.attempts === n && (p.status === 'queued' || p.status === 'failed')); }
  check('a temporary failure that never goes away is given up after 5 tries → failed', temp?.status === 'failed' && temp.attempts === 5 && temp.error === 'Temporary', JSON.stringify(temp));

  // ── a network that has no publisher yet
  const realPub = await pubReq(me, id, { channelIds: [chReal] });
  const realDone = await waitFor(realPub.json?.publications?.[0]?.id, (p) => p.status === 'failed');
  check('a real network without a publisher fails at once: "not available yet" (and is not retried)', realDone?.status === 'failed' && realDone.attempts === 1 && /not available yet/.test(realDone.error ?? ''), JSON.stringify(realDone));

  // ── several channels in one go are independent
  const multi = await pubReq(me, id, { channelIds: [chOk, chFail] });
  check('two channels → two publications', multi.status === 201 && multi.json?.publications?.length === 2);
  const mIds = multi.json.publications.map((p) => p.id);
  const mDone = await Promise.all(mIds.map((m) => waitFor(m, (p) => p.status === 'published' || p.status === 'failed')));
  check('each ends on its own: one published, one failed', mDone.map((p) => p?.status).sort().join() === 'failed,published', JSON.stringify(mDone.map((p) => p?.status)));

  // ── history
  const hist = await pubList();
  check('the history lists everything, newest first, with the video title', hist.length >= 8 && hist.every((p, i) => i === 0 || hist[i - 1].createdAt >= p.createdAt) && hist.every((p) => p.videoTitle === 'Trip to the sea'), `${hist.length}`);
  check('filtering by video works, and a bad id → 400', (await pubList(`?videoId=${id}`)).length === hist.length && (await http('GET', '/api/video/publications?videoId=nope', me)).status === 400);
  check("another user's history is empty", ((await http('GET', '/api/video/publications', { cookie: other.cookie })).json?.publications ?? []).length === 0);

  // ── cancel and remove
  const cancelMe = await pubReq(me, id, { channelIds: [chFlaky] });
  const cancelId = cancelMe.json?.publications?.[0]?.id;
  await waitFor(cancelId, (p) => p.status === 'queued');
  check('a queued publication can be cancelled', (await http('DELETE', `/api/video/publications/${cancelId}`, me)).status === 200 && !(await pubList()).some((p) => p.id === cancelId));
  check('a finished one can be removed from the history', (await http('DELETE', `/api/video/publications/${failId}`, me)).status === 200 && !(await pubList()).some((p) => p.id === failId));
  const busyId = randomUUID();
  sql(`INSERT INTO video_publications (id, user_id, video_id, channel_id, platform, channel_name, title, status, attempts, next_attempt_at, claimed_at) VALUES ('${busyId}', '${u.id}', '${id}', '${chOk}', 'youtube', 'Mock YouTube', 'In flight', 'publishing', 1, 0, ${nowSec()})`);
  check('one that is being published right now cannot be removed → 409 in_progress', (await http('DELETE', `/api/video/publications/${busyId}`, me)).json?.code === 'in_progress');

  // ── a worker that died mid-publication: its claim is released after 10 minutes and the row runs again
  const stuckId = randomUUID();
  sql(`INSERT INTO video_publications (id, user_id, video_id, channel_id, platform, channel_name, title, status, attempts, next_attempt_at, claimed_at) VALUES ('${stuckId}', '${u.id}', '${id}', '${chOk}', 'youtube', 'Mock YouTube', 'Stuck', 'publishing', 1, 0, ${nowSec() - 700})`);
  sql(`DELETE FROM video_publications WHERE id = '${busyId}'`);
  const chOk2 = mockCh('youtube', 'Mock YouTube 2', '{"mock":"ok"}');
  const kick = await pubReq(me, id, { channelIds: [chOk2] });        // any run releases stale claims first (another channel: chOk has the stuck row in flight)
  await waitFor(kick.json?.publications?.[0]?.id, (p) => p.status === 'published');
  const stuckBack = await waitFor(stuckId, (p) => p.status === 'published', 12000);
  check('a claim stuck for 10+ minutes is released and the publication completes (attempt 2)', stuckBack?.status === 'published' && stuckBack.attempts === 2, JSON.stringify(stuckBack));

  // ── the channel is disconnected while a publication waits
  const waitCh = mockCh('tiktok', 'Soon gone', '{"mock":"flaky","failures":1}');
  const waitPub = await pubReq(me, id, { channelIds: [waitCh] });
  const waitId = waitPub.json?.publications?.[0]?.id;
  await waitFor(waitId, (p) => p.status === 'queued');
  const disc = await http('DELETE', `/api/video/channels/${waitCh}`, me);
  check('disconnecting the channel works (200)', disc.status === 200, JSON.stringify(disc.json));
  const afterDisc = (await pubList()).find((p) => p.id === waitId);
  check('and the history stays readable (the channel name is kept)', afterDisc?.channelName === 'Soon gone', JSON.stringify(afterDisc));
  makeDue(waitId); await pubList();
  const goneDone = await waitFor(waitId, (p) => p.status === 'failed');
  check('and the waiting publication fails with a clear reason instead of retrying forever', goneDone?.status === 'failed' && /disconnected/.test(goneDone.error ?? ''), JSON.stringify(goneDone));

  // ── deleting the video removes its history
  const small = makeMp4(5000);
  const smallUp = await start(me, small.length, { title: 'Small one' });
  await putPart(me, smallUp.json.videoId, 1, small);
  await complete(me, smallUp.json.videoId);
  const smPub = await pubReq(me, smallUp.json.videoId, { channelIds: [chOk] });
  await waitFor(smPub.json?.publications?.[0]?.id, (p) => p.status === 'published');
  await http('DELETE', `/api/video/videos/${smallUp.json.videoId}`, me);
  check('deleting a video removes its publications from the history', sql(`SELECT COUNT(*) AS n FROM video_publications WHERE video_id = '${smallUp.json.videoId}'`)[0].n === 0);

  // ───────────────────────────────────────────────────────────────
  section('Studio AI: 50 generations per plan period, then stop or $0.02 each (needs VIDEO_AI_MOCK=1 locally)');
  const ai = (body) => http('POST', '/api/video/ai', { ...me, body });
  const aiGet = async () => (await http('GET', '/api/video/ai', me)).json;
  const periodEnd = () => sql(`SELECT current_period_end AS e FROM video_subscriptions WHERE user_id = '${u.id}'`)[0].e;
  const setUsed = (key, used) => sql(`INSERT INTO video_ai_usage (user_id, period, used) VALUES ('${u.id}', '${key}', ${used}) ON CONFLICT(user_id, period) DO UPDATE SET used = ${used}`);
  const wipeAi = () => { sql(`DELETE FROM video_ai_usage WHERE user_id = '${u.id}'`); sql(`DELETE FROM video_ai_overage WHERE user_id = '${u.id}'`); sql(`DELETE FROM user_ai_bonus WHERE user_id = '${u.id}'`); sql(`DELETE FROM video_ai_settings WHERE user_id = '${u.id}'`); };
  wipeAi();
  const g0 = await aiGet();
  if (!g0?.available) {
    check('the fake model is on (set VIDEO_AI_MOCK=1 in .dev.vars and restart the dev server)', false, JSON.stringify(g0));
  } else {
    check('the allowance is 50 per plan period, starts unused, and says when it renews (the plan\'s end date)', g0.ai.limit === 50 && g0.ai.used === 0 && g0.ai.remaining === 50 && g0.ai.resetsAt === periodEnd(), JSON.stringify(g0.ai));
    check('by default the AI stops at the limit: extra generations are off, $0.02 each', g0.ai.overage.enabled === false && g0.ai.overage.priceUsd === 0.02 && g0.ai.overage.uses === 0 && g0.ai.overage.costUsd === 0);
    const a1 = await ai({ tool: 'script', platform: 'shorts', text: 'three guitar mistakes' });
    check('a generation uses one included credit and is free', a1.status === 200 && /main part of the script/.test(a1.json?.script ?? '') && a1.json?.charged?.kind === 'included' && a1.json?.charged?.costUsd === 0 && a1.json?.ai?.used === 1 && a1.json?.ai?.remaining === 49, JSON.stringify(a1.json));

    const key = `p${periodEnd()}`;
    setUsed(key, 10);
    check('a failed generation is given back (included): used stays 10', (await ai({ tool: 'script', platform: 'shorts', text: 'FAIL_NOW' })).status === 502 && (await aiGet()).ai.used === 10);
    setUsed(key, 49);
    const race = await Promise.all(Array.from({ length: 5 }, () => ai({ tool: 'script', platform: 'shorts', text: 'idea' })));
    check('the last included credit goes to exactly ONE of 5 parallel requests; the others stop (402)', race.filter((r) => r.status === 200).length === 1 && race.filter((r) => r.status === 402).length === 4 && (await aiGet()).ai.used === 50, race.map((r) => r.status).join());

    const full = await ai({ tool: 'script', platform: 'shorts', text: 'idea' });
    check('after 50: 402 ai_quota_exceeded, the message names the limit, the renewal date and the $0.02 option', full.status === 402 && full.json?.code === 'ai_quota_exceeded' && /50 AI generations/.test(full.json.error) && /renew on \d{4}-\d{2}-\d{2}/.test(full.json.error) && /\$0\.02/.test(full.json.error) && full.json.ai?.remaining === 0, JSON.stringify(full.json));
    check('nothing was charged for the refused request', (await aiGet()).ai.overage.uses === 0);

    check('the switch needs a boolean (400)', (await http('PATCH', '/api/video/ai', { ...me, body: { overage: 'yes' } })).status === 400 && (await http('PATCH', '/api/video/ai', { ...me, body: {} })).status === 400);
    check('the switch needs a session (401)', (await http('PATCH', '/api/video/ai', { body: { overage: true } })).status === 401);
    const on = await http('PATCH', '/api/video/ai', { ...me, body: { overage: true } });
    check('"keep going" is switched on', on.status === 200 && on.json?.ai?.overage?.enabled === true);
    const o1 = await ai({ tool: 'script', platform: 'shorts', text: 'idea' });
    check('then the next generation works and costs $0.02 (recorded, included credits stay at 50)', o1.status === 200 && o1.json?.charged?.kind === 'overage' && o1.json?.charged?.costUsd === 0.02 && o1.json.ai.overage.uses === 1 && o1.json.ai.overage.costUsd === 0.02 && o1.json.ai.used === 50, JSON.stringify(o1.json?.ai));
    const o2 = await ai({ tool: 'metadata', platform: 'youtube', text: 'a script' });
    check('every further one adds $0.02 (titles + tags + description counts as ONE generation)', o2.status === 200 && Array.isArray(o2.json?.titles) && o2.json.ai.overage.uses === 2 && o2.json.ai.overage.costUsd === 0.04, JSON.stringify(o2.json?.ai));
    check('a failed extra generation is given back and not billed', (await ai({ tool: 'script', platform: 'shorts', text: 'FAIL_NOW' })).status === 502 && (await aiGet()).ai.overage.uses === 2 && (await aiGet()).ai.overage.costUsd === 0.04);
    const burst = await Promise.all(Array.from({ length: 5 }, () => ai({ tool: 'script', platform: 'shorts', text: 'idea' })));
    check('five parallel extras are all counted and billed exactly once ($0.14 in total)', burst.every((r) => r.status === 200) && (await aiGet()).ai.overage.uses === 7 && (await aiGet()).ai.overage.costUsd === 0.14, burst.map((r) => r.status).join());

    const off = await http('PATCH', '/api/video/ai', { ...me, body: { overage: false } });
    check('switching "keep going" off stops it again at once (402), and the bill does not grow', off.json?.ai?.overage?.enabled === false && (await ai({ tool: 'script', platform: 'shorts', text: 'idea' })).status === 402 && (await aiGet()).ai.overage.costUsd === 0.14);

    sql(`INSERT INTO user_ai_bonus (user_id, credits) VALUES ('${u.id}', 2) ON CONFLICT(user_id) DO UPDATE SET credits = 2`);
    const b1 = await ai({ tool: 'script', platform: 'shorts', text: 'idea' });
    check('admin bonus credits are spent after the included ones and before any billing', b1.status === 200 && b1.json?.charged?.kind === 'bonus' && b1.json.ai.bonus === 1 && b1.json.ai.overage.uses === 7);
    check('a failed generation gives the bonus credit back', (await ai({ tool: 'script', platform: 'shorts', text: 'FAIL_NOW' })).status === 502 && (await aiGet()).ai.bonus === 1);
    await ai({ tool: 'script', platform: 'shorts', text: 'idea' });
    check('when the bonus is gone it stops again (402)', (await ai({ tool: 'script', platform: 'shorts', text: 'idea' })).status === 402);

    // reset together with the plan: renewing moves the plan's end date, which starts a new count
    const newEnd = periodEnd() + 30 * 86400;
    sql(`UPDATE video_subscriptions SET current_period_end = ${newEnd} WHERE user_id = '${u.id}'`);
    const renewed = await aiGet();
    check('when the plan renews the count starts over (0 / 50) and the next renewal date is the new plan end', renewed.ai.used === 0 && renewed.ai.remaining === 50 && renewed.ai.resetsAt === newEnd && renewed.ai.overage.uses === 0 && renewed.ai.overage.costUsd === 0, JSON.stringify(renewed.ai));
    check('and generating works again', (await ai({ tool: 'script', platform: 'shorts', text: 'idea' })).json?.ai?.used === 1);
    check('the choice "keep going" survives the renewal (it is the user\'s setting, not the period\'s)', (await aiGet()).ai.overage.enabled === false);

    // a plan without an end date renews on the 1st of every month (UTC)
    sql(`UPDATE video_subscriptions SET current_period_end = NULL WHERE user_id = '${u.id}'`);
    const d0 = new Date();
    const firstNext = Math.floor(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 1) / 1000);
    const noEnd = await aiGet();
    check('with no plan end date it renews on the 1st of next month, UTC', noEnd.ai.resetsAt === firstNext && noEnd.ai.used === 0, `${noEnd.ai.resetsAt} vs ${firstNext}`);
    sql(`UPDATE video_subscriptions SET current_period_end = ${Math.floor(Date.now() / 1000) + 30 * 86400} WHERE user_id = '${u.id}'`);

    // the numbers belong to the admin: catalog row 'video' → limits { aiCredits, overageAiPostUsd } (no deploy needed to change them)
    const setTerms = (limits) => sql(`UPDATE plans SET limits = '${limits}' WHERE id = 'video'`);
    wipeAi();
    setTerms('{"aiCredits":3,"overageAiPostUsd":0.05}');
    const t3 = await aiGet();
    check('the limit and the price come from the catalog (admin → Plans): 3 included, $0.05 each after', t3.ai.limit === 3 && t3.ai.remaining === 3 && t3.ai.overage.priceUsd === 0.05, JSON.stringify(t3.ai));
    for (let i = 0; i < 3; i++) await ai({ tool: 'script', platform: 'shorts', text: 'idea' });
    const stop3 = await ai({ tool: 'script', platform: 'shorts', text: 'idea' });
    check('after the 3 included it stops, and the message names the live numbers (3 generations, $0.05)', stop3.status === 402 && /3 AI generations/.test(stop3.json?.error ?? '') && /\$0\.05/.test(stop3.json?.error ?? ''), stop3.json?.error);
    await http('PATCH', '/api/video/ai', { ...me, body: { overage: true } });
    const x5 = await ai({ tool: 'script', platform: 'shorts', text: 'idea' });
    check('keeping going bills the catalog price ($0.05), not a fixed one', x5.status === 200 && x5.json?.charged?.costUsd === 0.05 && x5.json.ai.overage.costUsd === 0.05, JSON.stringify(x5.json?.charged));
    wipeAi();
    setTerms('{"aiCredits":0,"overageAiPostUsd":0.02}');
    const none = await ai({ tool: 'script', platform: 'shorts', text: 'idea' });
    check('a plan with 0 included generations stops at once (no free one slips through)', none.status === 402 && sql(`SELECT COUNT(*) AS n FROM video_ai_usage WHERE user_id = '${u.id}'`)[0].n === 0, JSON.stringify(none.json?.code));
    setTerms('{"aiCredits":-5,"overageAiPostUsd":"free"}');
    const bad = await aiGet();
    check('nonsense in the catalog falls back to the defaults (50 and $0.02)', bad.ai.limit === 50 && bad.ai.overage.priceUsd === 0.02, JSON.stringify(bad.ai));
    setTerms('{"aiCredits":50,"overageAiPostUsd":0.02}');
  }
  wipeAi();

  // ───────────────────────────────────────────────────────────────
  section('Switching the Video Engine off');
  videoEngine(u.email, '--off');
  check('a live video key stops working (403 video_engine_required)', (await http('GET', '/api/v1/video/me', { key: (await http('POST', '/api/keys', { ...me, body: { name: 'x', scope: 'video', mode: 'test' } })).json?.secret })).status === 200
    && (await http('GET', '/api/v1/video/videos', { key: liveKey })).json?.code === 'video_engine_required');
  check('the dashboard says it lapsed, and uploads are refused', (await http('GET', '/api/video/me', me)).json?.entitlement?.lapsed === true && (await start(me, 5000)).json?.code === 'video_engine_required');
  check('without Vane Studio a new publication is refused (403 video_engine_required)', (await pubReq(me, id, { channelIds: [chOk] })).json?.code === 'video_engine_required');
  const lapsedId = randomUUID();
  sql(`INSERT INTO video_publications (id, user_id, video_id, channel_id, platform, channel_name, title, status, attempts, next_attempt_at) VALUES ('${lapsedId}', '${u.id}', '${id}', '${chOk}', 'youtube', 'Mock YouTube', 'Late one', 'queued', 0, 0)`);
  await http('GET', '/api/video/publications', me);
  const lapsed = await waitFor(lapsedId, (p) => p.status === 'failed');
  check('a publication that was queued before the subscription ended fails with that reason', lapsed?.status === 'failed' && /not active/.test(lapsed.error ?? ''), JSON.stringify(lapsed));
  check('without Vane Studio the AI and its switch are refused (403)', (await http('GET', '/api/video/ai', me)).status === 403 && (await http('PATCH', '/api/video/ai', { ...me, body: { overage: true } })).status === 403 && (await ai({ tool: 'script', platform: 'shorts', text: 'x' })).status === 403);
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
