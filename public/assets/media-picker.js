/**
 * MediaPicker — attach ONE image or video to a post.
 *
 *   var picker = Vane.createMediaPicker(rootEl, {
 *     enabled: true,                    // false → shows the "not enabled" state
 *     dropTarget: composerEl,           // optional: dropping a file anywhere on it uploads it
 *     onChange: function (media) {},    // media = { url, kind: 'image'|'video', name, size, ... } | null
 *     onBusy:   function (busy) {}      // true while a file is uploading
 *   });
 *   picker.getUrl() · picker.getMedia() · picker.isBusy() · picker.clear()
 *   picker.setEnabled(bool) · picker.handleFile(file)   // handleFile is also used for paste
 *
 * Flow: pick / drop / paste → validated in the browser → uploaded with a live progress bar
 * (cancellable) → mini preview with name, size and type → "Remove" to detach.
 * Or: "choose from your library" (library-picker.js) attaches a file that is already uploaded, with no upload at all.
 */
(function () {
  'use strict';
  var esc = Vane.esc;

  var IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  var VIDEO_TYPES = ['video/mp4', 'video/quicktime'];
  var MAX_IMAGE = 5 * 1024 * 1024, MAX_VIDEO = 20 * 1024 * 1024;
  var BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime' };

  var ICON = {
    upload: '<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5M4 20h16"/></svg>',
    close: '<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    play: '<svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    image: '<svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>'
  };

  function mimeOf(file) {
    if (file.type) return file.type;
    var m = /\.([a-z0-9]+)$/i.exec(file.name || '');
    return m ? (BY_EXT[m[1].toLowerCase()] || '') : '';
  }
  function fmtSize(n) { return n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }

  /** Returns an error message, or '' if the file is acceptable. */
  function validateFile(file) {
    var type = mimeOf(file);
    var isImage = IMAGE_TYPES.indexOf(type) > -1, isVideo = VIDEO_TYPES.indexOf(type) > -1;
    if (!isImage && !isVideo) return 'Unsupported file. Use JPEG, PNG or WebP images, or MP4 / MOV videos.';
    if (!file.size) return 'That file is empty.';
    if (isImage && file.size > MAX_IMAGE) return 'Images can be up to 5 MB.';
    if (isVideo && file.size > MAX_VIDEO) return 'Videos can be up to 20 MB.';
    return '';
  }

  Vane.createMediaPicker = function (root, opts) {
    opts = opts || {};
    var enabled = opts.enabled !== false;
    var media = null;              // the attached file once uploaded
    var state = 'idle';            // 'idle' | 'uploading' | 'ready'
    var current = null;            // in-flight upload { abort }
    var discardPrevious = false;   // clear() during an upload: don't restore the old attachment afterwards
    var objectUrl = '';            // local preview URL (revoked when no longer needed)

    root.innerHTML =
      '<input type="file" class="hidden" data-mp="input" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime" />' +
      '<button type="button" class="dropzone" data-mp="drop">' +
        '<span class="flex h-11 w-11 items-center justify-center rounded-full bg-white/[0.08]">' + ICON.upload + '</span>' +
        '<span class="text-sm font-medium" data-mp="dropTitle">Drag &amp; drop or <span class="underline underline-offset-4">click to upload</span></span>' +
        '<span class="text-xs leading-relaxed text-white/40" data-mp="dropHint">Images: JPEG, PNG, WebP up to 5 MB<br />Videos: MP4, MOV up to 20 MB</span>' +
      '</button>' +
      '<button type="button" class="mt-2.5 hidden w-full text-center text-xs text-white/50 underline-offset-4 hover:text-white hover:underline" data-mp="library">or choose from your library</button>' +
      '<div class="hidden items-center gap-3.5 rounded-2xl bg-white/[0.04] p-3 ring-1 ring-white/5" data-mp="card">' +
        '<div class="relative h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-white/[0.06]">' +
          '<div class="flex h-full w-full items-center justify-center text-white/35" data-mp="thumb"></div>' +
          '<span class="absolute bottom-1 left-1 hidden h-5 w-5 items-center justify-center rounded-full bg-black/65 text-white" data-mp="badge">' + ICON.play + '</span>' +
          '<span class="absolute inset-0 hidden items-center justify-center bg-black/55" data-mp="busy"><span class="spinner"></span></span>' +
        '</div>' +
        '<div class="min-w-0 flex-1">' +
          '<div class="truncate text-sm font-medium" data-mp="name"></div>' +
          '<div class="mt-0.5 text-xs text-white/45" data-mp="meta"></div>' +
          '<div class="progress mt-2 hidden" data-mp="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span data-mp="bar"></span></div>' +
        '</div>' +
        '<button type="button" class="icon-btn shrink-0" data-mp="action" aria-label="Remove attachment">' + ICON.close + '</button>' +
      '</div>' +
      '<p class="mt-2 hidden text-xs text-red-300" role="alert" data-mp="error"></p>';

    var q = function (name) { return root.querySelector('[data-mp="' + name + '"]'); };
    var input = q('input'), drop = q('drop'), libBtn = q('library'), card = q('card'), thumb = q('thumb'), badge = q('badge'), busy = q('busy');
    var nameEl = q('name'), metaEl = q('meta'), progress = q('progress'), bar = q('bar'), action = q('action'), errEl = q('error');

    function setError(msg) { errEl.textContent = msg || ''; errEl.classList.toggle('hidden', !msg); }
    function revoke() { if (objectUrl) { try { URL.revokeObjectURL(objectUrl); } catch (e) { /* noop */ } objectUrl = ''; } }

    /** shown only while nothing is attached, uploads are on, and library-picker.js is loaded */
    function renderLibButton() { libBtn.classList.toggle('hidden', state !== 'idle' || !enabled || typeof Vane.openLibraryPicker !== 'function'); }

    function renderEnabled() {
      renderLibButton();
      drop.disabled = !enabled;
      q('dropTitle').innerHTML = enabled ? 'Drag &amp; drop or <span class="underline underline-offset-4">click to upload</span>' : 'Media uploads are not enabled yet';
      q('dropHint').innerHTML = enabled ? 'Images: JPEG, PNG, WebP up to 5 MB<br />Videos: MP4, MOV up to 20 MB' : 'Ask the site owner to finish the storage setup.';
    }

    /** thumbnail = the local file while uploading, the same file afterwards (no re-download) */
    function renderThumb(kind, src) {
      thumb.innerHTML = '';
      if (src && kind === 'video') {
        var v = document.createElement('video');
        v.src = src + '#t=0.1'; v.muted = true; v.playsInline = true; v.preload = 'metadata';
        v.className = 'h-full w-full object-cover';
        thumb.appendChild(v);
      } else if (src) {
        var img = document.createElement('img');
        img.src = src; img.alt = ''; img.className = 'h-full w-full object-cover';
        thumb.appendChild(img);
      } else {
        thumb.innerHTML = ICON.image;
      }
      badge.classList.toggle('hidden', kind !== 'video'); badge.classList.toggle('flex', kind === 'video');
    }

    function render() {
      var showCard = state !== 'idle';
      drop.classList.toggle('hidden', showCard);
      renderLibButton();
      card.classList.toggle('hidden', !showCard); card.classList.toggle('flex', showCard);
      if (state === 'ready' && media) {
        busy.classList.add('hidden'); busy.classList.remove('flex'); progress.classList.add('hidden');
        nameEl.textContent = media.name;
        var kindLabel = media.kind === 'video' ? 'Video' : 'Image';
        metaEl.textContent = kindLabel + ' · ' + fmtSize(media.size) + (media.width ? ' · ' + media.width + '×' + media.height : '');
        action.setAttribute('aria-label', 'Remove attachment');
        action.innerHTML = ICON.close;
      }
    }

    function setBusy(on) { if (opts.onBusy) opts.onBusy(on); }
    function setProgress(frac, processing) {
      var pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
      progress.classList.remove('hidden');
      progress.classList.toggle('is-indeterminate', !!processing);
      bar.style.width = pct + '%';
      progress.setAttribute('aria-valuenow', String(pct));
      metaEl.textContent = processing ? 'Processing…' : 'Uploading… ' + pct + '%';
    }

    async function handleFile(file) {
      if (!file) return;
      if (!enabled) { Vane.toast('err', 'Media uploads are not enabled yet.'); return; }
      if (state === 'uploading') { Vane.toast('info', 'Wait for the current upload to finish, or cancel it first.'); return; }

      var problem = validateFile(file);
      if (problem) { setError(problem); Vane.toast('err', problem); return; }
      setError('');

      var kind = VIDEO_TYPES.indexOf(mimeOf(file)) > -1 ? 'video' : 'image';
      var previous = media, previousObjectUrl = objectUrl;
      try { objectUrl = URL.createObjectURL(file); } catch (e) { objectUrl = ''; }   // not available everywhere

      state = 'uploading';
      renderThumb(kind, objectUrl);
      render();
      nameEl.textContent = file.name || (kind === 'video' ? 'video' : 'image');
      busy.classList.remove('hidden'); busy.classList.add('flex');
      action.setAttribute('aria-label', 'Cancel upload'); action.innerHTML = ICON.close;
      setProgress(0, false);
      setBusy(true);

      current = Vane.uploadFile(file, function (frac) { setProgress(frac, frac >= 1); });
      var res = await current.promise;
      current = null;

      if (!res.ok) {
        // Put things back exactly as they were before this attempt.
        revoke(); objectUrl = previousObjectUrl;
        if (discardPrevious) { discardPrevious = false; previous = null; revoke(); }
        media = previous; state = previous ? 'ready' : 'idle';
        if (previous) renderThumb(previous.kind, objectUrl || previous.url);
        render(); setBusy(false);
        if (!res.aborted) { setError(res.error); Vane.toast('err', res.error); }
        return;
      }

      if (previousObjectUrl && previousObjectUrl !== objectUrl) { try { URL.revokeObjectURL(previousObjectUrl); } catch (e) { /* noop */ } }
      media = { url: res.url, key: res.key, kind: res.kind || kind, name: file.name || 'file', size: res.size || file.size, width: res.width, height: res.height };
      state = 'ready';
      renderThumb(media.kind, objectUrl || media.url);
      render(); setBusy(false);
      Vane.toast('ok', media.kind === 'video' ? 'Video uploaded.' : 'Image uploaded.');
      if (opts.onChange) opts.onChange(media);
    }

    /** attach a file that is already in the library: no upload, the post just points at it */
    function attach(asset) {
      if (state === 'uploading') { Vane.toast('info', 'Wait for the current upload to finish, or cancel it first.'); return; }
      revoke(); setError('');
      media = { url: asset.url, key: asset.key, kind: asset.kind, name: asset.name, size: asset.size, width: asset.width || undefined, height: asset.height || undefined };
      state = 'ready';
      renderThumb(media.kind, '/api/media/' + asset.key);
      render();
      Vane.toast('ok', media.kind === 'video' ? 'Video attached.' : 'Image attached.');
      if (opts.onChange) opts.onChange(media);
    }

    function clear() {
      if (current) { discardPrevious = true; current.abort(); }
      revoke(); media = null; state = 'idle'; setError('');
      render();
      if (opts.onChange) opts.onChange(null);
    }

    // ── wiring
    drop.addEventListener('click', function () { if (enabled) input.click(); });
    libBtn.addEventListener('click', function () {
      if (enabled && state !== 'uploading' && Vane.openLibraryPicker) Vane.openLibraryPicker({ onPick: attach });
    });
    input.addEventListener('change', function () { var f = input.files && input.files[0]; input.value = ''; handleFile(f); });
    action.addEventListener('click', function () {
      if (state === 'uploading') { if (current) current.abort(); } else clear();
    });

    var target = opts.dropTarget || root;
    var depth = 0;
    function over(on) { drop.classList.toggle('is-over', on && enabled && state !== 'uploading'); }
    target.addEventListener('dragenter', function (e) { e.preventDefault(); depth++; over(true); });
    target.addEventListener('dragover', function (e) { e.preventDefault(); over(true); });
    target.addEventListener('dragleave', function () { depth = Math.max(0, depth - 1); if (!depth) over(false); });
    target.addEventListener('drop', function (e) {
      e.preventDefault(); depth = 0; over(false);
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      if (files.length > 1) Vane.toast('info', 'One file per post: using the first one.');
      handleFile(files[0]);
    });

    renderEnabled(); render();

    return {
      handleFile: handleFile,
      clear: clear,
      set: function (m) { if (current) { discardPrevious = true; current.abort(); } revoke(); media = m || null; state = m ? 'ready' : 'idle'; setError(''); render(); if (opts.onChange) opts.onChange(media); },
      getMedia: function () { return media; },
      getUrl: function () { return media ? media.url : ''; },
      isBusy: function () { return state === 'uploading'; },
      setEnabled: function (on) { enabled = !!on; renderEnabled(); }
    };
  };
})();
