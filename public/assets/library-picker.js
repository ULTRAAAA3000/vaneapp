/**
 * Vane.openLibraryPicker({ onPick(asset) }) — a dialog with the person's Library, to attach a file they already uploaded to the post
 * they are writing (the editor's media picker opens it from "or choose from your library").
 *
 * asset = { id, key, url, kind: 'image'|'video', name, size, width, height, ... }, the same shape GET /api/library/assets returns.
 * Same data and the same escaping rules as the Library tab; picking closes the dialog and hands the asset to onPick.
 */
(function () {
  'use strict';
  var esc = Vane.esc;

  var X = '<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  var PLAY = '<svg class="h-3 w-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';

  var dlg = null;
  var S = { kind: '', q: '', items: [], cursor: null, loading: false, error: '', onPick: null };
  var seq = 0, timer = 0;

  function fmtSize(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function q(name) { return dlg.querySelector('[data-lp="' + name + '"]'); }

  function build() {
    dlg = document.createElement('dialog');
    dlg.className = 'vane-dialog';
    dlg.setAttribute('aria-labelledby', 'lpTitle');
    dlg.style.maxWidth = 'min(46rem, calc(100vw - 1.5rem))';
    dlg.innerHTML =
      '<div class="glass-d-strong max-h-[calc(100vh-2rem)] overflow-y-auto rounded-3xl p-5 shadow-2xl sm:p-7">' +
        '<div class="flex items-start justify-between gap-4">' +
          '<div><h2 id="lpTitle" class="text-xl font-semibold tracking-tight">Choose from your library</h2>' +
          '<p class="mt-0.5 text-xs text-white/45">Click a file to attach it to this post.</p></div>' +
          '<button type="button" class="icon-btn" data-lp="close" aria-label="Close">' + X + '</button>' +
        '</div>' +
        '<div class="mt-5 flex flex-wrap items-center gap-3">' +
          '<div class="flex gap-1.5" role="group" aria-label="Show" data-lp="kinds">' +
            '<button type="button" class="chip" data-kind="" aria-pressed="true">All</button>' +
            '<button type="button" class="chip" data-kind="image" aria-pressed="false">Images</button>' +
            '<button type="button" class="chip" data-kind="video" aria-pressed="false">Videos</button>' +
          '</div>' +
          '<input type="search" class="field w-full min-w-0 sm:w-auto sm:flex-1" placeholder="Search by name" maxlength="60" autocomplete="off" aria-label="Search files by name" data-lp="search" />' +
        '</div>' +
        '<div class="mt-4 hidden items-center justify-between gap-3 rounded-xl border border-red-400/25 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-300" role="alert" data-lp="error">' +
          '<span data-lp="errorText"></span><button type="button" class="btn btn-ghost btn-sm shrink-0" data-lp="retry">Try again</button></div>' +
        '<div class="mt-4 grid grid-cols-3 gap-2.5 sm:grid-cols-4" data-lp="grid"></div>' +
        '<p class="mt-6 hidden text-center text-sm leading-relaxed text-white/45" data-lp="empty"></p>' +
        '<div class="mt-5 text-center"><button type="button" class="btn btn-ghost btn-sm hidden" data-lp="more">Load more</button></div>' +
      '</div>';
    document.body.appendChild(dlg);

    q('close').addEventListener('click', function () { dlg.close(); });
    dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });          // a click on the dimmed backdrop
    q('retry').addEventListener('click', function () { load(false); });
    q('more').addEventListener('click', function () { load(true); });
    q('grid').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-id]') : null;
      if (!b) return;
      var asset = S.items.filter(function (a) { return a.id === b.getAttribute('data-id'); })[0];
      var cb = S.onPick;
      if (!asset) return;
      dlg.close();
      if (cb) cb(asset);
    });
    q('kinds').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-kind]') : null;
      if (!b) return;
      S.kind = b.getAttribute('data-kind');
      [].forEach.call(q('kinds').querySelectorAll('button'), function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
      load(false);
    });
    q('search').addEventListener('input', function (e) {
      clearTimeout(timer);
      timer = setTimeout(function () { S.q = e.target.value.trim(); load(false); }, 250);
    });
  }

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
      if (mine !== seq) return;                           // a newer request (filter, search) replaced this one
      S.loading = false;
      if (!r.ok) {
        S.error = r.status === 503 ? 'The library is not available yet. Please try again a little later.' : r.error;
        if (!append) S.items = [];
      } else {
        S.items = append ? S.items.concat(r.data.assets) : r.data.assets;
        S.cursor = r.data.nextCursor;
      }
      render();
    });
  }

  function tile(a) {
    var src = '/api/media/' + a.key;
    var media = a.kind === 'video'
      ? '<video src="' + esc(src) + '#t=0.1" muted playsinline preload="metadata" class="h-full w-full object-cover"></video>' +
        '<span class="absolute bottom-1.5 left-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/65 text-white">' + PLAY + '</span>'
      : '<img src="' + esc(src) + '" alt="" loading="lazy" decoding="async" class="h-full w-full object-cover" />';
    return '<button type="button" class="group min-w-0 rounded-xl text-left focus-visible:outline-none" data-id="' + esc(a.id) + '" aria-label="Attach ' + esc(a.name) + '">' +
      '<span class="relative block aspect-square overflow-hidden rounded-xl bg-white/[0.05] ring-1 ring-white/5 transition group-hover:ring-white/40 group-focus-visible:ring-2 group-focus-visible:ring-white">' + media + '</span>' +
      '<span class="mt-1.5 block truncate text-xs font-medium" title="' + esc(a.name) + '">' + esc(a.name) + '</span>' +
      '<span class="block truncate text-[11px] text-white/40">' + fmtSize(a.size) + '</span></button>';
  }

  function render() {
    var grid = q('grid'), filtered = !!(S.kind || S.q);
    if (S.loading && !S.items.length) grid.innerHTML = new Array(9).join('<div class="skeleton aspect-square rounded-xl"></div>');
    else grid.innerHTML = S.items.map(tile).join('');

    var err = q('error');
    err.classList.toggle('hidden', !S.error); err.classList.toggle('flex', !!S.error);
    q('errorText').textContent = S.error;

    var empty = !S.loading && !S.error && !S.items.length;
    var msg = q('empty');
    msg.classList.toggle('hidden', !empty);
    msg.textContent = filtered ? 'Nothing matches. Try another name or filter.' : 'Your library is empty. Upload a file first: it will show up here for every next post.';
    q('more').classList.toggle('hidden', !S.cursor || S.loading);
  }

  /** opts.onPick(asset) runs after the dialog has closed */
  Vane.openLibraryPicker = function (opts) {
    if (!dlg) build();
    S.onPick = opts && opts.onPick;
    S.kind = ''; S.q = ''; S.items = []; S.cursor = null;
    q('search').value = '';
    [].forEach.call(q('kinds').querySelectorAll('button'), function (x) { x.setAttribute('aria-pressed', x.getAttribute('data-kind') === '' ? 'true' : 'false'); });
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    load(false);
  };
})();
