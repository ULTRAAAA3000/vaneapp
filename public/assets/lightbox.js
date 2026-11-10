/**
 * Vane.lightbox.open(items, index, opts) — a full-size preview of the person's own images and videos in Vane's own viewer
 * (not the browser's bare "open image" page). It is a <dialog> opened with showModal(), so it sits above everything, also above
 * another dialog (the library picker), traps the focus and closes on Escape by itself.
 *
 *   item = { src, kind: 'image' | 'video', name, sub }       src is a same-site address (/api/media/…); name and sub are shown as text
 *   opts = { actions: [ { label, icon, cls?, run(item, index) }                  a button that runs something
 *                     | { label, icon, href(item), download(item) } ] }    or a link (download)
 *
 * Mouse: wheel or double-click zooms at the pointer, drag pans a zoomed image, click outside the picture closes.
 * Touch: swipe sideways for the next / previous file, double-tap zooms. Keys: Esc, ← →, Home / End, + − 0.
 * Everything that comes from the server (names, sizes) goes in with textContent; the only innerHTML is fixed markup below.
 */
(function () {
  'use strict';
  window.Vane = window.Vane || {};

  var I = {
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    prev: '<path d="M15 5l-7 7 7 7"/>',
    next: '<path d="M9 5l7 7-7 7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'
  };
  var svg = function (d, cls) { return '<svg class="' + (cls || 'lb-ic') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>'; };
  var el = function (tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

  var MAX_ZOOM = 6, STEP = 1.25;
  var dlg = null, q = {}, items = [], idx = 0, opts = {}, z = 1, tx = 0, ty = 0, media = null, opener = null, drag = null, lastTap = 0, zoomedAt = 0;

  function build() {
    dlg = el('dialog', 'lb');
    dlg.setAttribute('aria-label', 'File preview');
    dlg.innerHTML =
      '<div class="lb-top">' +
        '<div class="lb-title"><p class="lb-name" data-lb="name"></p><p class="lb-sub" data-lb="sub"></p></div>' +
        '<div class="lb-tools">' +
          '<span class="lb-count" data-lb="count"></span>' +
          '<span class="lb-group" data-lb="zoomtools">' +
            '<button type="button" class="lb-btn" data-lb="zout" aria-label="Zoom out">' + svg(I.minus) + '</button>' +
            '<button type="button" class="lb-btn lb-pct" data-lb="zfit" aria-label="Fit to screen">100%</button>' +
            '<button type="button" class="lb-btn" data-lb="zin" aria-label="Zoom in">' + svg(I.plus) + '</button>' +
          '</span>' +
          '<span class="lb-group" data-lb="actions"></span>' +
          '<button type="button" class="lb-btn lb-close" data-lb="close" aria-label="Close">' + svg(I.x) + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="lb-stage" data-lb="stage"><div class="lb-pan" data-lb="pan"></div><div class="lb-spin" data-lb="spin" hidden></div><p class="lb-err" data-lb="err" hidden>This file could not be loaded.</p></div>' +
      '<button type="button" class="lb-nav lb-prev" data-lb="prev" aria-label="Previous file">' + svg(I.prev, 'lb-ic lb-ic-lg') + '</button>' +
      '<button type="button" class="lb-nav lb-next" data-lb="next" aria-label="Next file">' + svg(I.next, 'lb-ic lb-ic-lg') + '</button>' +
      '<div class="lb-strip" data-lb="strip" role="tablist" aria-label="Files"></div>';
    document.body.appendChild(dlg);
    [].forEach.call(dlg.querySelectorAll('[data-lb]'), function (n) { q[n.getAttribute('data-lb')] = n; });

    q.close.addEventListener('click', function () { dlg.close(); });
    q.prev.addEventListener('click', function () { go(-1); });
    q.next.addEventListener('click', function () { go(1); });
    q.zin.addEventListener('click', function () { zoomBy(STEP); });
    q.zout.addEventListener('click', function () { zoomBy(1 / STEP); });
    q.zfit.addEventListener('click', function () { setZoom(1); });
    q.strip.addEventListener('click', function (e) { var b = e.target.closest ? e.target.closest('button[data-i]') : null; if (b) show(+b.getAttribute('data-i')); });
    dlg.addEventListener('keydown', onKey);
    dlg.addEventListener('close', onClose);
    q.stage.addEventListener('wheel', onWheel, { passive: false });
    q.stage.addEventListener('pointerdown', onDown);
    q.stage.addEventListener('pointermove', onMove);
    q.stage.addEventListener('pointerup', onUp);
    q.stage.addEventListener('pointercancel', function () { drag = null; q.stage.classList.remove('is-drag'); });
    q.stage.addEventListener('dblclick', function (e) { if (isImage() && Date.now() - zoomedAt > 500) { if (z > 1) setZoom(1); else setZoom(2.5, e.clientX, e.clientY); } });
  }

  function isImage() { return items[idx] && items[idx].kind !== 'video'; }
  function wrap(i) { return (i + items.length) % items.length; }
  function go(step) { if (items.length > 1) show(wrap(idx + step)); }

  // ── zoom and pan: the picture is scaled around its own centre; (px, py) is the pointer, so the point under it stays under it
  function apply() {
    q.pan.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + z + ')';
    q.stage.classList.toggle('is-zoomed', z > 1);
    q.zfit.textContent = Math.round(z * 100) + '%';
  }
  function setZoom(nz, px, py) {
    nz = Math.min(MAX_ZOOM, Math.max(1, nz));
    if (nz === 1) { tx = 0; ty = 0; }
    else {
      var r = q.pan.getBoundingClientRect(), cx, cy;   // the centre now (the transform moves it with tx, ty)
      cx = r.left + r.width / 2; cy = r.top + r.height / 2;
      if (px === undefined) { px = cx; py = cy; }
      var k = nz / z; tx += (px - cx) * (1 - k); ty += (py - cy) * (1 - k);
    }
    z = nz; apply();
  }
  function zoomBy(f) { if (isImage()) setZoom(z * f); }
  function onWheel(e) { if (!isImage()) return; e.preventDefault(); setZoom(z * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY); }

  function onDown(e) {
    if (e.target.closest && e.target.closest('video')) return;                      // let the video's own controls work
    drag = { x: e.clientX, y: e.clientY, tx: tx, ty: ty, moved: false, id: e.pointerId, onPic: !!(e.target.closest && e.target.closest('.lb-pan')) };
  }
  function onMove(e) {
    if (!drag || drag.id !== e.pointerId) return;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 6) { drag.moved = true; if (z > 1) { q.stage.setPointerCapture(e.pointerId); q.stage.classList.add('is-drag'); } }
    if (drag.moved && z > 1) { tx = drag.tx + dx; ty = drag.ty + dy; apply(); }
  }
  function onUp(e) {
    var d = drag; drag = null; q.stage.classList.remove('is-drag');
    if (!d) return;
    var dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (d.moved) {
      if (z === 1 && Math.abs(dx) > 60 && Math.abs(dy) < 90) go(dx < 0 ? 1 : -1);   // a swipe on a picture that is not zoomed
      return;
    }
    if (!d.onPic && e.target === q.stage) { dlg.close(); return; }                  // a tap on the empty dark area
    var now = Date.now();                                                           // a double tap zooms (touch has no dblclick)
    if (e.pointerType === 'touch' && isImage() && now - lastTap < 320) { if (z > 1) setZoom(1); else setZoom(2.5, e.clientX, e.clientY); lastTap = 0; zoomedAt = now; } else lastTap = now;
  }

  function onKey(e) {
    var k = e.key;
    if (k === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (k === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (k === 'Home') { e.preventDefault(); show(0); }
    else if (k === 'End') { e.preventDefault(); show(items.length - 1); }
    else if (k === '+' || k === '=') { e.preventDefault(); zoomBy(STEP); }
    else if (k === '-' || k === '_') { e.preventDefault(); zoomBy(1 / STEP); }
    else if (k === '0') { e.preventDefault(); setZoom(1); }
  }

  // ── showing one file
  function show(i) {
    idx = i; z = 1; tx = 0; ty = 0;
    var it = items[idx];
    if (media && media.tagName === 'VIDEO') media.pause();
    q.pan.textContent = ''; q.err.hidden = true; media = null;
    q.name.textContent = it.name || ''; q.sub.textContent = it.sub || '';
    q.count.textContent = items.length > 1 ? (idx + 1) + ' / ' + items.length : '';
    q.prev.hidden = q.next.hidden = items.length < 2;
    q.zoomtools.hidden = it.kind === 'video';
    apply();
    if (it.kind === 'video') {
      q.spin.hidden = true;
      media = el('video', 'lb-media'); media.controls = true; media.autoplay = true; media.playsInline = true; media.src = it.src;
      media.addEventListener('error', function () { q.err.hidden = false; });
    } else {
      q.spin.hidden = false;
      media = el('img', 'lb-media'); media.alt = it.name || ''; media.decoding = 'async'; media.draggable = false;
      media.addEventListener('load', function () { q.spin.hidden = true; });
      media.addEventListener('error', function () { q.spin.hidden = true; q.err.hidden = false; media.hidden = true; });
      media.src = it.src;
    }
    q.pan.appendChild(media);
    [].forEach.call(q.strip.children, function (b, n) {
      var on = n === idx; b.setAttribute('aria-selected', on ? 'true' : 'false'); b.classList.toggle('is-on', on);
      if (on && b.scrollIntoView) b.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'auto' });
    });
    [idx - 1, idx + 1].forEach(function (n) { var nb = items[wrap(n)]; if (nb && nb.kind !== 'video' && items.length > 1) (new Image()).src = nb.src; });   // the neighbours are ready when you press →
  }

  function buildStrip() {
    q.strip.textContent = '';
    q.strip.hidden = items.length < 2 || items.length > 80;
    if (q.strip.hidden) return;
    items.forEach(function (it, n) {
      var b = el('button', 'lb-thumb'); b.type = 'button'; b.setAttribute('data-i', n); b.setAttribute('role', 'tab'); b.setAttribute('aria-label', 'Show ' + (it.name || 'file ' + (n + 1)));
      if (it.kind === 'video') { b.appendChild(el('span', 'lb-vid', '▶')); }
      else { var im = el('img'); im.src = it.src; im.alt = ''; im.loading = 'lazy'; im.decoding = 'async'; b.appendChild(im); }
      q.strip.appendChild(b);
    });
  }
  function buildActions() {
    q.actions.textContent = '';
    (opts.actions || []).forEach(function (a) {
      var node;
      if (a.href) { node = el('a', 'lb-btn lb-act' + (a.cls ? ' ' + a.cls : '')); node.rel = 'noopener'; node.addEventListener('click', function () { var it = items[idx]; node.href = a.href(it); if (a.download) node.setAttribute('download', a.download(it) || ''); else node.removeAttribute('download'); if (a.newTab) node.target = '_blank'; }); node.href = '#'; }
      else { node = el('button', 'lb-btn lb-act' + (a.cls ? ' ' + a.cls : '')); node.type = 'button'; node.addEventListener('click', function () { a.run(items[idx], idx); }); }
      node.setAttribute('aria-label', a.label); node.title = a.label;
      node.innerHTML = a.icon || '';
      node.appendChild(el('span', 'lb-act-t', a.label));
      q.actions.appendChild(node);
    });
    q.actions.hidden = !(opts.actions && opts.actions.length);
  }

  function onClose() {
    if (media && media.tagName === 'VIDEO') media.pause();
    q.pan.textContent = ''; media = null; drag = null;
    document.documentElement.classList.remove('lb-lock');
    if (opener && opener.focus && document.contains(opener)) { try { opener.focus({ preventScroll: true }); } catch (e) { /* the opener is gone */ } }
    opener = null;
  }

  Vane.lightbox = {
    open: function (list, index, options) {
      if (!list || !list.length) return;
      if (!dlg) build();
      items = list; opts = options || {}; opener = document.activeElement;
      buildActions(); buildStrip();
      document.documentElement.classList.add('lb-lock');
      if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute('open', '');
      show(Math.min(Math.max(index || 0, 0), items.length - 1));
      q.close.focus({ preventScroll: true });
    },
    close: function () { if (dlg && dlg.open) dlg.close(); },
    icons: { svg: svg }
  };
})();
