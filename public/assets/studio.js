/* Vane Studio — the video dashboard (studio.vaneapp.dev) */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = Vane.esc;

  // ───────────────────────── state ─────────────────────────
  var S = {
    user: null,
    active: false,        // is Vane Studio switched on for this account?
    limits: { maxVideos: 90, maxFileBytes: 2 * 1024 * 1024 * 1024, partSize: 8 * 1024 * 1024 },
    usage: { videos: 0, storageBytes: 0 },
    uploadsOn: true,      // the server has video storage bound
    videos: [],
    keys: [],
    file: null,           // the file chosen in the uploader
    up: null              // the upload in progress (see "uploading")
  };

  var PARALLEL = 3;       // chunks sent at once
  var RETRIES = 3;        // a failed chunk is tried again this many times
  var RESUME_KEY = 'vane.studio.uploads';

  // ───────────────────────── small helpers ─────────────────────────
  function fmtBytes(n) {
    if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  function fmtDate(sec) { return new Date(sec * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function parseTags(text) { return text.split(',').map(function (t) { return t.trim(); }).filter(Boolean); }

  function loadResume() { try { return JSON.parse(localStorage.getItem(RESUME_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function saveResume(map) { try { localStorage.setItem(RESUME_KEY, JSON.stringify(map)); } catch (e) { /* storage blocked: uploads still work, they just cannot be resumed */ } }
  function fingerprint(f) { return f.name + ':' + f.size + ':' + f.lastModified; }
  function forget(fp) { var m = loadResume(); delete m[fp]; saveResume(m); }

  // ───────────────────────── overview ─────────────────────────
  function renderStats() {
    $('statVideos').textContent = S.usage.videos + ' / ' + S.limits.maxVideos;
    $('statStorage').textContent = fmtBytes(S.usage.storageBytes);
    $('statStatus').textContent = S.active ? 'Active' : 'Off';
    $('statStatusSub').textContent = S.active ? 'Vane Studio is on' : 'Vane Studio is not active';
    $('inactive').classList.toggle('hidden', S.active);
    $('uploader').classList.toggle('hidden', !S.active);
    if (S.active && !S.uploadsOn) { $('uploader').classList.add('hidden'); $('inactive').classList.remove('hidden'); $('inactiveText').textContent = 'Video storage is not enabled on this server yet.'; }
  }

  async function refreshOverview() {
    var r = await Vane.api('GET', '/api/video/me');
    if (!r.ok) return;
    S.active = r.data.entitlement.active;
    S.limits = r.data.limits;
    S.usage = { videos: r.data.usage.videos.used, storageBytes: r.data.usage.storageBytes };
    S.uploadsOn = r.data.features.uploads;
    renderStats();
  }

  // ───────────────────────── library ─────────────────────────
  var BADGE = {
    uploading: '<span class="rounded-full bg-amber-400/15 px-2 py-0.5 text-[11px] text-amber-200">Unfinished</span>',
    failed: '<span class="rounded-full bg-red-400/15 px-2 py-0.5 text-[11px] text-red-200">Failed</span>',
    ready: ''
  };

  function card(v) {
    var tags = v.tags.map(function (t) { return '<span class="rounded-full bg-white/8 px-2 py-0.5 text-[11px] text-white/60">#' + esc(t) + '</span>'; }).join(' ');
    var note = '';
    var actions = '';
    if (v.status === 'ready') {
      actions = '<button class="btn btn-white btn-sm" data-act="play" data-id="' + v.id + '">Play</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="edit" data-id="' + v.id + '">Edit</button>' +
        '<button class="btn btn-danger btn-sm" data-act="delete" data-id="' + v.id + '">Delete</button>';
    } else if (v.status === 'uploading') {
      note = '<p class="mt-2 text-xs text-white/50">Choose the same file again to continue this upload, or cancel it.</p>';
      actions = '<button class="btn btn-danger btn-sm" data-act="delete" data-id="' + v.id + '">Cancel upload</button>';
    } else {
      note = '<p class="mt-2 text-xs text-red-200/80">' + esc(v.error || 'This upload was rejected.') + '</p>';
      actions = '<button class="btn btn-danger btn-sm" data-act="delete" data-id="' + v.id + '">Delete</button>';
    }
    return '<article class="glass-d flex flex-col rounded-2xl p-4">' +
      '<div class="flex items-start justify-between gap-2"><h3 class="min-w-0 break-words text-sm font-semibold">' + esc(v.title) + '</h3>' + BADGE[v.status] + '</div>' +
      '<p class="mt-1 text-xs text-white/45">' + fmtBytes(v.sizeBytes) + ' · ' + fmtDate(v.createdAt) + '</p>' +
      (tags ? '<div class="mt-2 flex flex-wrap gap-1">' + tags + '</div>' : '') + note +
      '<div class="mt-4 flex flex-wrap gap-2">' + actions + '</div></article>';
  }

  function renderLibrary() {
    $('library').innerHTML = S.videos.map(card).join('');
    $('libEmpty').classList.toggle('hidden', S.videos.length > 0);
  }

  async function loadLibrary() {
    var r = await Vane.api('GET', '/api/video/videos');
    if (r.ok) { S.videos = r.data.videos; renderLibrary(); }
  }

  function find(id) { return S.videos.filter(function (v) { return v.id === id; })[0]; }

  $('library').addEventListener('click', async function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var v = find(btn.getAttribute('data-id'));
    if (!v) return;
    var act = btn.getAttribute('data-act');
    if (act === 'play') openPlayer(v);
    else if (act === 'edit') openEditor(v);
    else if (act === 'delete') await removeVideo(v, btn);
  });

  async function removeVideo(v, btn) {
    var unfinished = v.status === 'uploading';
    if (!window.confirm(unfinished ? 'Cancel this unfinished upload?' : 'Delete "' + v.title + '"? The file is removed for good.')) return;
    btn.disabled = true;
    var r = await Vane.api('DELETE', '/api/video/videos/' + v.id);
    if (!r.ok) { btn.disabled = false; Vane.toast('err', r.error); return; }
    // an unfinished upload may be remembered for resuming: forget it
    var map = loadResume();
    Object.keys(map).forEach(function (fp) { if (map[fp] === v.id) delete map[fp]; });
    saveResume(map);
    Vane.toast('ok', unfinished ? 'Upload cancelled' : 'Video deleted');
    await Promise.all([loadLibrary(), refreshOverview()]);
  }

  // ───────────────────────── player and editor ─────────────────────────
  var modal = $('modal');
  function openModal(html) { $('modalBody').innerHTML = html; modal.classList.remove('hidden'); modal.classList.add('flex'); }
  function closeModal() { modal.classList.add('hidden'); modal.classList.remove('flex'); $('modalBody').innerHTML = ''; } // emptying it also stops a playing video
  modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

  function openPlayer(v) {
    openModal('<h3 class="mb-3 break-words text-base font-semibold">' + esc(v.title) + '</h3>' +
      '<video class="w-full rounded-2xl bg-black" controls autoplay playsinline preload="metadata" src="' + esc(v.fileUrl) + '"></video>' +
      (v.description ? '<p class="mt-3 whitespace-pre-line break-words text-sm text-white/60">' + esc(v.description) + '</p>' : '') +
      '<div class="mt-4 flex justify-end"><button class="btn btn-ghost btn-sm" id="mClose">Close</button></div>');
    $('mClose').addEventListener('click', closeModal);
  }

  function openEditor(v) {
    openModal('<h3 class="mb-4 text-base font-semibold">Edit video</h3>' +
      '<div class="space-y-3">' +
      '<div><label for="eTitle" class="mb-1 block text-xs text-white/55">Title</label><input id="eTitle" class="field" maxlength="100" value="' + esc(v.title) + '" /></div>' +
      '<div><label for="eDesc" class="mb-1 block text-xs text-white/55">Description</label><textarea id="eDesc" class="field" rows="4" maxlength="5000">' + esc(v.description) + '</textarea></div>' +
      '<div><label for="eTags" class="mb-1 block text-xs text-white/55">Tags, separated by commas</label><input id="eTags" class="field" value="' + esc(v.tags.join(', ')) + '" /></div>' +
      '</div><div class="mt-5 flex justify-end gap-2"><button class="btn btn-ghost btn-sm" id="mCancel">Cancel</button><button class="btn btn-white btn-sm" id="mSave">Save</button></div>');
    $('mCancel').addEventListener('click', closeModal);
    $('mSave').addEventListener('click', async function () {
      this.disabled = true;
      var r = await Vane.api('PATCH', '/api/video/videos/' + v.id, { title: $('eTitle').value, description: $('eDesc').value, tags: parseTags($('eTags').value) });
      if (!r.ok) { this.disabled = false; Vane.toast('err', r.error); return; }
      closeModal();
      Vane.toast('ok', 'Saved');
      await loadLibrary();
    });
  }

  // ───────────────────────── choosing a file ─────────────────────────
  function setFile(f) {
    if (!f) return;
    if (!/\.(mp4|mov)$/i.test(f.name)) { Vane.toast('err', 'Only MP4 and MOV videos are supported.'); return; }
    if (f.size <= 0) { Vane.toast('err', 'That file is empty.'); return; }
    if (f.size > S.limits.maxFileBytes) { Vane.toast('err', 'Videos can be up to ' + fmtBytes(S.limits.maxFileBytes) + '.'); return; }
    S.file = f;
    $('dropTitle').textContent = f.name;
    $('dropSub').textContent = fmtBytes(f.size);
    $('uploadBtn').disabled = false;
  }
  $('fileInput').addEventListener('change', function () { setFile(this.files[0]); });
  var drop = $('drop');
  ['dragenter', 'dragover'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('border-white/50'); }); });
  ['dragleave', 'drop'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('border-white/50'); }); });
  drop.addEventListener('drop', function (e) { if (!S.up) setFile(e.dataTransfer.files[0]); });

  // ───────────────────────── uploading ─────────────────────────
  // The server fixes the chunk size (partSize): every chunk but the last is exactly that long. Chunks go up three at a time,
  // each one retried with a growing pause; what the server already has is never sent twice, so a reload or a dropped
  // connection costs only the chunks that were in flight.

  function partLen(U, n) { return n < U.partCount ? U.partSize : U.file.size - U.partSize * (U.partCount - 1); }

  function showProgress() {
    var U = S.up;
    var sent = 0;
    for (var n = 1; n <= U.partCount; n++) {
      if (U.done[n]) sent += partLen(U, n);
      else if (U.loaded[n]) sent += U.loaded[n];
    }
    var pct = Math.min(100, Math.floor((sent / U.file.size) * 100));
    $('progressPct').textContent = pct + '%';
    $('progressFill').style.width = pct + '%';
    $('progressBar').setAttribute('aria-valuenow', String(pct));
  }

  function putPart(U, n, blob) {
    return new Promise(function (resolve) {
      var xhr = new XMLHttpRequest();
      U.xhrs.push(xhr);
      xhr.open('PUT', '/api/video/uploads/' + U.videoId + '/parts/' + n);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.responseType = 'text';
      xhr.upload.onprogress = function (e) { if (e.lengthComputable) { U.loaded[n] = e.loaded; showProgress(); } };
      var finish = function (r) { U.xhrs.splice(U.xhrs.indexOf(xhr), 1); U.loaded[n] = 0; resolve(r); };
      xhr.onload = function () {
        var data = null;
        try { data = JSON.parse(xhr.responseText); } catch (e) { /* not JSON */ }
        if (xhr.status >= 200 && xhr.status < 300 && data && data.ok) { U.done[n] = true; finish({ ok: true }); }
        else finish({ ok: false, status: xhr.status, code: data && data.code, error: (data && data.error) || 'Upload failed (' + xhr.status + ').' });
      };
      xhr.onerror = function () { finish({ ok: false, status: 0, error: 'Network error. Check your connection.' }); };
      xhr.ontimeout = xhr.onerror;
      xhr.onabort = function () { finish({ ok: false, aborted: true }); };
      xhr.send(blob);
    });
  }

  async function sendPart(U, n) {
    var from = (n - 1) * U.partSize;
    var blob = U.file.slice(from, from + partLen(U, n));
    var r = { ok: false, error: 'Upload failed.' };
    for (var attempt = 0; attempt <= RETRIES; attempt++) {
      if (U.cancelled) return { ok: false, aborted: true };
      r = await putPart(U, n, blob);
      if (r.ok || r.aborted) return r;
      if (r.status === 401) { Vane.go(Vane.loginUrl()); return r; }
      var permanent = r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429;
      if (permanent) return r;                 // the server said no: sending it again will not change that
      await sleep(1000 * Math.pow(2, attempt));
    }
    return r;
  }

  function setBusy(busy) {
    $('uploadBtn').disabled = busy || !S.file;
    $('fileInput').disabled = busy;
    ['upTitle', 'upDesc', 'upTags'].forEach(function (id) { $(id).disabled = busy; });
    $('cancelBtn').classList.toggle('hidden', !busy);
    $('progressBox').classList.toggle('hidden', !busy);
    if (!busy) { $('progressFill').style.width = '0%'; $('progressPct').textContent = '0%'; }
  }

  function resetForm() {
    S.file = null;
    $('fileInput').value = '';
    $('dropTitle').textContent = 'Choose a video, or drop it here';
    $('dropSub').textContent = 'MP4 or MOV';
    ['upTitle', 'upDesc', 'upTags'].forEach(function (id) { $(id).value = ''; });
    $('uploadBtn').disabled = true;
  }

  /** Starts a new upload, or picks up the unfinished one that belongs to this same file. Resolves to the upload state or null. */
  async function openUpload(file, meta) {
    var fp = fingerprint(file);
    var saved = loadResume()[fp];
    if (saved) {
      var st = await Vane.api('GET', '/api/video/uploads/' + saved);
      if (st.ok && st.data.video.status === 'uploading') {
        var done = {};
        st.data.uploadedParts.forEach(function (n) { done[n] = true; });
        return { file: file, fp: fp, videoId: saved, partSize: st.data.partSize, partCount: st.data.partCount, done: done, loaded: {}, xhrs: [], cancelled: false, resumed: true };
      }
      forget(fp);                                // it finished, expired or was cancelled elsewhere
    }
    var body = { size: file.size, contentType: /\.mov$/i.test(file.name) ? 'video/quicktime' : 'video/mp4', fileName: file.name };
    if (meta.title) body.title = meta.title;
    if (meta.description) body.description = meta.description;
    if (meta.tags.length) body.tags = meta.tags;
    var r = await Vane.api('POST', '/api/video/uploads', body);
    if (!r.ok) { Vane.toast('err', r.error); return null; }
    var map = loadResume(); map[fp] = r.data.videoId; saveResume(map);
    return { file: file, fp: fp, videoId: r.data.videoId, partSize: r.data.partSize, partCount: r.data.partCount, done: {}, loaded: {}, xhrs: [], cancelled: false, resumed: false };
  }

  async function startUpload() {
    if (!S.file || S.up) return;
    var meta = { title: $('upTitle').value.trim(), description: $('upDesc').value.trim(), tags: parseTags($('upTags').value) };
    setBusy(true);
    $('progressLabel').textContent = 'Preparing…';
    var U = await openUpload(S.file, meta);
    if (!U) { setBusy(false); return; }
    S.up = U;
    $('progressLabel').textContent = U.resumed ? 'Resuming…' : 'Uploading…';
    showProgress();

    var queue = [];
    for (var n = 1; n <= U.partCount; n++) if (!U.done[n]) queue.push(n);
    var failure = null;
    var worker = async function () {
      while (queue.length && !failure && !U.cancelled) {
        var r = await sendPart(U, queue.shift());
        if (!r.ok && !r.aborted) failure = r;
      }
    };
    var workers = [];
    for (var i = 0; i < PARALLEL; i++) workers.push(worker());
    await Promise.all(workers);

    if (U.cancelled) return;                     // cancelUpload() has already cleaned up
    if (failure) return endUpload(U, failure);

    $('progressLabel').textContent = 'Finishing…';
    var c = await Vane.api('POST', '/api/video/uploads/' + U.videoId + '/complete', {});
    if (!c.ok) return endUpload(U, { status: c.status, code: c.data && c.data.code, error: c.error });

    if (U.resumed && (meta.title || meta.description || meta.tags.length)) {
      var patch = {};
      if (meta.title) patch.title = meta.title;
      if (meta.description) patch.description = meta.description;
      if (meta.tags.length) patch.tags = meta.tags;
      await Vane.api('PATCH', '/api/video/videos/' + U.videoId, patch);
    }
    forget(U.fp);
    S.up = null;
    setBusy(false);
    resetForm();
    Vane.toast('ok', 'Video uploaded');
    await Promise.all([loadLibrary(), refreshOverview()]);
  }

  /** The upload stopped. A broken connection keeps the unfinished upload (choose the file again to continue); a server "no" ends it. */
  async function endUpload(U, failure) {
    var recoverable = !failure.status || failure.status >= 500 || failure.status === 408 || failure.status === 429;
    S.up = null;
    setBusy(false);
    if (recoverable) {
      Vane.toast('err', (failure.error || 'The upload was interrupted.') + ' Choose the same file again to continue.');
    } else {
      forget(U.fp);
      if (failure.code !== 'upload_expired' && failure.code !== 'invalid_video') await Vane.api('DELETE', '/api/video/uploads/' + U.videoId, undefined, { noRedirect: true });
      Vane.toast('err', failure.error);
    }
    await Promise.all([loadLibrary(), refreshOverview()]);
  }

  async function cancelUpload() {
    var U = S.up;
    if (!U) return;
    U.cancelled = true;
    U.xhrs.slice().forEach(function (x) { try { x.abort(); } catch (e) { /* already done */ } });
    S.up = null;
    forget(U.fp);
    await Vane.api('DELETE', '/api/video/uploads/' + U.videoId, undefined, { noRedirect: true });
    setBusy(false);
    Vane.toast('info', 'Upload cancelled');
    await Promise.all([loadLibrary(), refreshOverview()]);
  }

  $('uploadBtn').addEventListener('click', startUpload);
  $('cancelBtn').addEventListener('click', cancelUpload);
  window.addEventListener('beforeunload', function (e) { if (S.up) { e.preventDefault(); e.returnValue = ''; } });

  // ───────────────────────── API keys ─────────────────────────
  function renderKeys() {
    $('keyList').innerHTML = S.keys.length ? S.keys.map(function (k) {
      return '<li class="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-black/25 px-3 py-2.5 text-sm">' +
        '<div class="min-w-0"><span class="pixel text-xs">' + esc(k.display) + '</span> <span class="text-white/55">' + esc(k.name) + '</span>' +
        '<div class="text-[11px] text-white/35">' + (k.lastUsedAt ? 'Last used ' + fmtDate(k.lastUsedAt) : 'Never used') + '</div></div>' +
        '<button class="btn btn-danger btn-sm" data-key="' + k.id + '">Revoke</button></li>';
    }).join('') : '<li class="text-sm text-white/45">No video keys yet.</li>';
  }

  async function loadKeys() {
    var r = await Vane.api('GET', '/api/keys?scope=video');
    if (r.ok) { S.keys = r.data.keys; renderKeys(); }
  }

  $('keyCreate').addEventListener('click', async function () {
    var name = $('keyName').value.trim();
    if (!name) { Vane.toast('err', 'Give the key a name, e.g. "Make.com".'); return; }
    this.disabled = true;
    var r = await Vane.api('POST', '/api/keys', { name: name, scope: 'video', mode: $('keyMode').value });
    this.disabled = false;
    if (!r.ok) { Vane.toast('err', r.error); return; }
    $('keyName').value = '';
    $('newKeySecret').textContent = r.data.secret;
    $('newKey').classList.remove('hidden');
    await loadKeys();
  });

  $('newKeyCopy').addEventListener('click', async function () {
    var text = $('newKeySecret').textContent;
    try { await navigator.clipboard.writeText(text); Vane.toast('ok', 'Key copied'); }
    catch (e) { Vane.toast('err', 'Could not copy. Select the key and copy it by hand.'); }
  });

  $('keyList').addEventListener('click', async function (e) {
    var btn = e.target.closest('button[data-key]');
    if (!btn || !window.confirm('Revoke this key? Anything using it stops working.')) return;
    btn.disabled = true;
    var r = await Vane.api('DELETE', '/api/keys/' + encodeURIComponent(btn.getAttribute('data-key')));
    if (!r.ok) { btn.disabled = false; Vane.toast('err', r.error); return; }
    Vane.toast('ok', 'Key revoked');
    await loadKeys();
  });

  // ───────────────────────── sign out ─────────────────────────
  $('logoutBtn').addEventListener('click', async function () {
    this.disabled = true;
    await Vane.api('POST', '/api/auth/logout', {}, { noRedirect: true });
    Vane.go('/login');
  });

  // ───────────────────────── boot ─────────────────────────
  (async function boot() {
    var me = await Vane.api('GET', '/api/auth/me');
    if (!me.ok) return;                          // a 401 has already sent the visitor to the sign-in page
    S.user = me.data.user;
    $('userEmail').textContent = S.user.email;
    $('avatar').textContent = (S.user.name || S.user.email).charAt(0).toUpperCase();
    await Promise.all([refreshOverview(), loadLibrary(), loadKeys()]);
    $('app').classList.remove('opacity-0');
  })();
})();
