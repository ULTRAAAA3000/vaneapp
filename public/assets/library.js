/**
 * Dashboard tabs + the Library tab: the files a person uploaded for their posts.
 *
 *   #create (default)  the editor, channels, insights, posts, API   — elements marked data-view="create"
 *   #library           this file's view                             — #viewLibrary, data-view="library"
 *
 * Data: GET /api/library/assets (list, filter, search, paging), DELETE /api/library/assets/:id,
 * uploads go through Vane.uploadFile, the same endpoint the editor uses, so everything uploaded anywhere ends up here.
 * Names and sizes from the server are put into the page escaped; delete is a two-step red button, like removing a channel.
 */
(function () {
  'use strict';
  var esc = Vane.esc;
  var $ = function (id) { return document.getElementById(id); };

  var IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  var VIDEO_TYPES = ['video/mp4', 'video/quicktime'];
  var BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime' };
  var MAX_IMAGE = 5 * 1024 * 1024, MAX_VIDEO = 20 * 1024 * 1024;

  var BTN = 'icon-btn shrink-0 bg-black/60 text-white/80 backdrop-blur';   // round buttons on top of a thumbnail
  var SVG = '<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  var ICON = {
    copy: SVG + '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
    trash: SVG + '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/></svg>',
    play: '<svg class="h-3 w-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>'
  };

  var S = { view: '', items: [], cursor: null, kind: '', q: '', usage: null, loading: false, error: '', uploading: false, armed: null, armTimer: 0 };
  var seq = 0;

  function fmtSize(n) {
    if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB';
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    return Math.max(1, Math.round(n / 1024)) + ' KB';
  }
  function fmtDate(ts) {
    var d = new Date(ts * 1000), o = { day: 'numeric', month: 'short' };
    if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric';
    return d.toLocaleDateString(undefined, o);
  }
  function mimeOf(file) {
    if (file.type) return file.type;
    var m = /\.([a-z0-9]+)$/i.exec(file.name || '');
    return m ? (BY_EXT[m[1].toLowerCase()] || '') : '';
  }
  /** Same limits as the editor's picker; the server checks the real file again. */
  function problemWith(file) {
    var type = mimeOf(file), img = IMAGE_TYPES.indexOf(type) > -1, vid = VIDEO_TYPES.indexOf(type) > -1;
    if (!img && !vid) return 'Use JPEG, PNG or WebP images, or MP4 / MOV videos.';
    if (!file.size) return 'The file is empty.';
    if (img && file.size > MAX_IMAGE) return 'Images can be up to 5 MB.';
    if (vid && file.size > MAX_VIDEO) return 'Videos can be up to 20 MB.';
    return '';
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var t = document.createElement('textarea');
      t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t); t.select();
      try { document.execCommand('copy') ? resolve() : reject(new Error('copy failed')); } catch (e) { reject(e); }
      t.remove();
    });
  }

  // ───────────────────────── tabs ─────────────────────────
  function setView(view) {
    S.view = view;
    [].forEach.call(document.querySelectorAll('[data-view]'), function (el) { el.hidden = el.getAttribute('data-view') !== view; });
    [].forEach.call(document.querySelectorAll('#dashTabs [data-tab]'), function (a) {
      if (a.getAttribute('data-tab') === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    if (view === 'library') load(false);                 // always fresh: a file may have been uploaded from the editor meanwhile
  }
  function route() {
    setView(location.hash === '#library' ? 'library' : 'create');
    if (S.view === 'create' && location.hash.length > 1) {   // the header's API link is #api: show the create view first, then scroll to it
      var target = document.getElementById(location.hash.slice(1));
      if (target) requestAnimationFrame(function () { target.scrollIntoView(); });   // after the swap has been laid out
    }
  }

  // ───────────────────────── loading ─────────────────────────
  function query(cursor) {
    var p = [];
    if (S.kind) p.push('kind=' + S.kind);
    if (S.q) p.push('q=' + encodeURIComponent(S.q));
    if (cursor) p.push('cursor=' + encodeURIComponent(cursor));
    return '/api/library/assets' + (p.length ? '?' + p.join('&') : '');
  }
  function load(append) {
    var mine = ++seq;
    S.loading = true; S.error = '';
    render();
    return Vane.api('GET', query(append ? S.cursor : null)).then(function (r) {
      if (mine !== seq) return;                           // a newer request (filter, search, upload) replaced this one
      S.loading = false;
      if (!r.ok) {
        S.error = r.status === 503 ? 'The library is not available yet. Please try again a little later.' : r.error;
        if (!append) S.items = [];
      } else {
        S.items = append ? S.items.concat(r.data.assets) : r.data.assets;
        S.cursor = r.data.nextCursor; S.usage = r.data.usage;
      }
      render();
    });
  }

  // ───────────────────────── rendering ─────────────────────────
  function tile(a) {
    var src = '/api/media/' + a.key;
    var media = a.kind === 'video'
      ? '<video src="' + esc(src) + '#t=0.1" muted playsinline preload="metadata" class="h-full w-full object-cover"></video>' +
        '<span class="absolute bottom-2 left-2 flex h-6 w-6 items-center justify-center rounded-full bg-black/65 text-white">' + ICON.play + '</span>'
      : '<img src="' + esc(src) + '" alt="" loading="lazy" decoding="async" class="h-full w-full object-cover" />';
    var dims = a.width ? ' · ' + a.width + '×' + a.height : '';
    var del = a.inUse
      ? '<button type="button" class="' + BTN + ' opacity-40" disabled title="Attached to a post that has not been sent yet" aria-label="Delete ' + esc(a.name) + ' (attached to a post that has not been sent yet)">' + ICON.trash + '</button>'
      : '<button type="button" class="' + BTN + '" data-act="del" data-id="' + esc(a.id) + '" aria-label="Delete ' + esc(a.name) + '">' + ICON.trash + '</button>';
    return '<article class="min-w-0" data-id="' + esc(a.id) + '">' +
      '<div class="relative aspect-square overflow-hidden rounded-2xl bg-white/[0.05] ring-1 ring-white/5">' + media +
        (a.inUse ? '<span class="absolute left-2 top-2 rounded-full bg-black/65 px-2 py-0.5 text-[10px] font-medium text-white/85">In a post</span>' : '') +
        '<div class="absolute right-2 top-2 flex gap-1.5"><button type="button" class="' + BTN + '" data-act="copy" data-id="' + esc(a.id) + '" aria-label="Copy link to ' + esc(a.name) + '">' + ICON.copy + '</button>' + del + '</div>' +
      '</div>' +
      '<p class="mt-2 truncate text-sm font-medium" title="' + esc(a.name) + '">' + esc(a.name) + '</p>' +
      '<p class="mt-0.5 truncate text-xs text-white/45">' + fmtSize(a.size) + dims + ' · ' + fmtDate(a.createdAt) + '</p>' +
      '</article>';
  }

  function renderUsage() {
    var u = S.usage, box = $('libUsage');
    if (!u) { box.classList.add('hidden'); return; }
    var files = u.count + (u.count === 1 ? ' file' : ' files');
    if (u.limitBytes) {
      var pct = Math.min(100, Math.round(u.usedBytes / u.limitBytes * 100));
      box.innerHTML = '<div class="flex items-baseline justify-between gap-3 text-xs"><span class="text-white/70">' + fmtSize(u.usedBytes) + ' of ' + fmtSize(u.limitBytes) + ' used</span><span class="text-white/45">' + files + '</span></div>' +
        '<div class="meter mt-2"><i style="width:' + pct + '%;background:' + (pct >= 90 ? '#f87171' : '#fff') + '"></i></div>';
    } else {
      box.innerHTML = '<div class="text-xs text-white/55">' + fmtSize(u.usedBytes) + ' used · ' + files + '</div>';
    }
    box.classList.remove('hidden');
  }

  function render() {
    renderUsage();
    var grid = $('libGrid'), filtered = !!(S.kind || S.q);
    if (S.loading && !S.items.length) grid.innerHTML = new Array(8 + 1).join('<div class="skeleton aspect-square rounded-2xl"></div>');
    else grid.innerHTML = S.items.map(tile).join('');
    S.armed = null;

    var err = $('libError');
    err.classList.toggle('hidden', !S.error); err.classList.toggle('flex', !!S.error);
    $('libErrorText').textContent = S.error;

    var empty = !S.loading && !S.error && !S.items.length;
    var msg = $('libEmpty');
    msg.classList.toggle('hidden', !empty);
    msg.textContent = filtered ? 'Nothing matches. Try another name or filter.' : 'No files yet. Upload an image or a video here, or attach one while writing a post: it will show up in this list.';
    $('libMore').classList.toggle('hidden', !S.cursor || S.loading);
  }

  // ───────────────────────── actions ─────────────────────────
  function disarm() {
    clearTimeout(S.armTimer);
    if (!S.armed) return;
    var b = $('libGrid').querySelector('[data-act="del"][data-id="' + S.armed + '"]');
    if (b) { b.className = BTN; b.innerHTML = ICON.trash; }
    S.armed = null;
  }
  function onGridClick(e) {
    var btn = e.target.closest ? e.target.closest('button[data-act]') : null;
    if (!btn) return;
    var id = btn.getAttribute('data-id'), act = btn.getAttribute('data-act');
    var item = S.items.filter(function (a) { return a.id === id; })[0];
    if (!item) return;
    if (act === 'copy') {
      copyText(item.url).then(function () { Vane.toast('ok', 'Link copied.'); }, function () { Vane.toast('err', 'Could not copy. Select the link in the post form instead.'); });
    } else if (act === 'del') {
      if (S.armed !== id) {                                 // first click: ask
        disarm();
        S.armed = id;
        btn.className = 'btn btn-danger btn-sm shrink-0 backdrop-blur'; btn.textContent = 'Delete?';
        S.armTimer = setTimeout(disarm, 4000);
        return;
      }
      clearTimeout(S.armTimer); btn.disabled = true;        // second click: do it
      Vane.api('DELETE', '/api/library/assets/' + encodeURIComponent(id)).then(function (r) {
        if (!r.ok) { btn.disabled = false; S.armed = id; disarm(); Vane.toast('err', r.error); return; }
        S.items = S.items.filter(function (a) { return a.id !== id; });
        if (S.usage) { S.usage.usedBytes = Math.max(0, S.usage.usedBytes - item.size); S.usage.count = Math.max(0, S.usage.count - 1); }
        Vane.toast('ok', 'File deleted.');
        if (!S.items.length && S.cursor) load(true); else render();
      });
    }
  }

  function setProgress(text, frac) {
    var box = $('libProgress');
    box.classList.toggle('hidden', text === null);
    if (text !== null) { $('libProgressText').textContent = text; $('libProgressBar').style.width = Math.round((frac || 0) * 100) + '%'; }
  }
  async function uploadAll(fileList) {
    var files = [].slice.call(fileList || []);
    if (!files.length) return;
    if (S.uploading) { Vane.toast('info', 'Wait for the current upload to finish.'); return; }
    S.uploading = true; $('libUpload').disabled = true;
    var done = 0, failed = 0;
    for (var i = 0; i < files.length; i++) {
      var f = files[i], label = 'Uploading ' + (i + 1) + ' of ' + files.length + ' · ' + f.name;
      var problem = problemWith(f);
      if (problem) { failed++; Vane.toast('err', f.name + ': ' + problem); continue; }
      setProgress(label, 0);
      var r = await Vane.uploadFile(f, function (frac) { setProgress(label, frac); }).promise;
      if (r.ok) { done++; continue; }
      failed++; Vane.toast('err', f.name + ': ' + r.error);
      if (r.status === 402 || r.status === 429) break;      // storage full or too many uploads: the rest would fail the same way
    }
    setProgress(null);
    S.uploading = false; $('libUpload').disabled = false;
    if (done) { Vane.toast('ok', done === 1 ? 'File uploaded.' : done + ' files uploaded.'); load(false); }
  }

  // ───────────────────────── wiring ─────────────────────────
  function init() {
    if (!$('viewLibrary')) return;
    $('libGrid').addEventListener('click', onGridClick);
    $('libGrid').addEventListener('error', function (e) {   // a file that cannot be shown (deleted behind our back): keep the tile, drop the broken image
      if (e.target && e.target.tagName === 'IMG') e.target.style.visibility = 'hidden';
    }, true);
    $('libMore').addEventListener('click', function () { load(true); });
    $('libRetry').addEventListener('click', function () { load(false); });
    $('libUpload').addEventListener('click', function () { $('libFile').click(); });
    $('libFile').addEventListener('change', function (e) { var files = e.target.files; uploadAll(files).then(function () { e.target.value = ''; }); });

    $('libKinds').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-kind]') : null;
      if (!b) return;
      S.kind = b.getAttribute('data-kind');
      [].forEach.call($('libKinds').querySelectorAll('button'), function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
      load(false);
    });
    var t = 0;
    $('libSearch').addEventListener('input', function (e) {
      clearTimeout(t);
      t = setTimeout(function () { S.q = e.target.value.trim(); load(false); }, 250);
    });

    var zone = $('viewLibrary'), depth = 0;                 // drop files anywhere on the tab
    var hasFiles = function (e) { return e.dataTransfer && [].indexOf.call(e.dataTransfer.types || [], 'Files') > -1; };
    zone.addEventListener('dragenter', function (e) { if (!hasFiles(e)) return; e.preventDefault(); depth++; zone.classList.add('is-over'); });
    zone.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
    zone.addEventListener('dragleave', function (e) { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) zone.classList.remove('is-over'); });
    zone.addEventListener('drop', function (e) { if (!hasFiles(e)) return; e.preventDefault(); depth = 0; zone.classList.remove('is-over'); uploadAll(e.dataTransfer.files); });

    window.addEventListener('hashchange', route);
    route();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
