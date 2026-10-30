/* Shared helpers for /login, the Vane Post dashboard and the Vane Studio dashboard. Exposes window.Vane. */
(function () {
  'use strict';
  var Vane = {};

  Vane.esc = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  /** Navigation hook so tests can observe redirects. */
  Vane.go = function (url) { if (window.__go) window.__go(url); else window.location.assign(url); };

  /**
   * Each product has its own host (post.vaneapp.dev, studio.vaneapp.dev) and one sign-in covers both.
   * Vane.home(): where a signed-in user lands.  Vane.loginUrl(): where a signed-out visitor is sent.
   * On the main site that is Vane Post; in local dev (no subdomains) /app and /studio are plain paths, and ?next= carries the choice.
   */
  var OWN_HOST = /^(post|studio|analytics)\.vaneapp\.dev$/i;
  var DEV_PAGES = ['/app', '/studio'];
  Vane.home = function () {
    var h = location.hostname;
    if (OWN_HOST.test(h)) return '/';
    var q = new URLSearchParams(location.search);
    var back = q.get('next');
    if (/^\/checkout(\?[A-Za-z0-9=&%._-]*)?$/.test(back || '')) return back;
    if (/^\/connect\?[A-Za-z0-9=&%._~+-]{1,2000}$/.test(back || '')) return back;   // the Claude connector's sign-in: back to its consent page       // sent to sign in from a "Buy" button: back to the checkout
    var studio = q.get('product') === 'studio';                        // chosen on the sign-in page's Post / Studio switch
    if (/^(www\.)?vaneapp\.dev$/i.test(h)) return studio ? 'https://studio.vaneapp.dev/' : 'https://post.vaneapp.dev/';
    var next = q.get('next');
    if (DEV_PAGES.indexOf(next) !== -1) return next;
    return studio ? '/studio' : '/app';
  };
  Vane.loginUrl = function () {
    if (OWN_HOST.test(location.hostname) || DEV_PAGES.indexOf(location.pathname) === -1) return '/login';
    return '/login?next=' + encodeURIComponent(location.pathname);
  };

  /**
   * Address of a product's dashboard: its own host in production, the plain /app and /studio paths in local dev.
   */
  Vane.productUrl = function (product) {
    if (OWN_HOST.test(location.hostname) || /^(www\.)?vaneapp\.dev$/i.test(location.hostname)) return 'https://' + product + '.vaneapp.dev/';
    return product === 'studio' ? '/studio' : product === 'analytics' ? '/analytics' : '/app';
  };

  /**
   * "Home" is the main site (the landing page). On post. and studio. the address "/" is that product's own dashboard,
   * so a logo or "Back to site" link must point at the main site explicitly. Mark such links with data-site-home.
   */
  Vane.siteHome = function () { return OWN_HOST.test(location.hostname) ? 'https://vaneapp.dev/' : '/'; };
  function wireHomeLinks() {
    var links = document.querySelectorAll('a[data-site-home]');
    for (var i = 0; i < links.length; i++) links[i].setAttribute('href', Vane.siteHome());
  }
  /** Links marked data-product-link="post|studio" point at that product's dashboard (its own host in production). */
  function wireProductLinks() {
    var links = document.querySelectorAll('a[data-product-link]');
    for (var i = 0; i < links.length; i++) links[i].setAttribute('href', Vane.productUrl(links[i].getAttribute('data-product-link')));
  }

  /**
   * Smooth hand-off between the two dashboards: the page fades out here and the other one fades in (its #app starts hidden).
   * Links marked data-handoff (the hand-off cards) get it; a modified click (new tab) or reduced motion goes straight through.
   */
  function wireHandoff() {
    document.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('a[data-handoff]') : null;
      if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      e.preventDefault();
      document.documentElement.classList.add('is-leaving');
      setTimeout(function () { Vane.go(a.href); }, 220);
    });
    window.addEventListener('pageshow', function () { document.documentElement.classList.remove('is-leaving'); });   // back button restores the page
  }
  function onReady() { wireHomeLinks(); wireProductLinks(); wireHandoff(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady); else onReady();

  /**
   * JSON API client. Resolves to { ok, status, data, error } and never throws.
   * A 401 sends the user to the sign-in page unless opts.noRedirect is set.
   */
  Vane.api = async function (method, path, body, opts) {
    opts = opts || {};
    var res;
    try {
      res = await fetch(path, {
        method: method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
        credentials: 'same-origin'
      });
    } catch (e) {
      return { ok: false, status: 0, data: null, error: 'Network error. Check your connection and try again.' };
    }
    var data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON */ }
    if (res.status === 401 && !opts.noRedirect) Vane.go(Vane.loginUrl());
    var ok = res.ok && !(data && data.ok === false);
    var gateway = res.status === 502 || res.status === 503 || res.status === 504;   // the platform's own error page: no JSON from us
    return { ok: ok, status: res.status, data: data, error: ok ? null : ((data && data.error) || (gateway ? 'The server is not answering right now. Please try again in a moment.' : 'Request failed (' + res.status + ')')) };
  };

  /**
   * Uploads one file to /api/media/upload as multipart/form-data, with progress.
   * Returns { promise, abort }. The promise always resolves to
   *   { ok:true, kind, url, key, size, contentType, width?, height? }  or  { ok:false, error, aborted? }
   * (XMLHttpRequest is used because fetch() cannot report upload progress.)
   */
  /**
   * Small JPEG frames of a video, spread evenly over its whole length and taken in the browser: the server checks a video by them
   * (one frame every ~6 seconds, at least 3 and at most 8: the same rule as functions/api/lib/videoframes.ts). Resolves to [] when
   * the browser cannot decode the video. `budgetMs` is how long to try (15 s by default).
   */
  Vane.videoFrames = function (file, budgetMs) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file), v = document.createElement('video'), out = [], at = [], i = 0, done = false;
      var timer = setTimeout(function () { finish(); }, budgetMs || 15000);
      function finish() {
        if (done) return;
        done = true; clearTimeout(timer);
        v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url);
        resolve(out);
      }
      function next() {
        if (i >= at.length) return finish();
        v.currentTime = Math.max(0.05, (isFinite(v.duration) ? v.duration : 1) * at[i++]);
      }
      v.muted = true; v.playsInline = true; v.preload = 'auto';
      v.onerror = function () { finish(); };
      v.onloadedmetadata = function () {
        var n = Math.min(8, Math.max(3, Math.ceil((isFinite(v.duration) && v.duration > 0 ? v.duration : 1) / 6)));
        for (var k = 0; k < n; k++) at.push((k + 0.5) / n);
        next();
      };
      v.onseeked = function () {
        if (!v.videoWidth) return finish();
        var w = Math.min(480, v.videoWidth), h = Math.max(1, Math.round(v.videoHeight * w / v.videoWidth));
        var c = document.createElement('canvas'); c.width = w; c.height = h;
        try { c.getContext('2d').drawImage(v, 0, 0, w, h); } catch (e) { return finish(); }
        c.toBlob(function (b) { if (b) out.push(b); next(); }, 'image/jpeg', 0.7);
      };
      v.src = url;
    });
  };

  Vane.uploadFile = function (file, onProgress) {
    var xhr = new XMLHttpRequest();
    var aborted = false;
    var promise = new Promise(function (resolve) {
      xhr.open('POST', '/api/media/upload');
      xhr.responseType = 'text';
      xhr.upload.onprogress = function (e) {
        if (onProgress && e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
      };
      xhr.onload = function () {
        var data = null;
        try { data = JSON.parse(xhr.responseText); } catch (e) { /* not JSON */ }
        if (xhr.status === 401) Vane.go(Vane.loginUrl());
        if (xhr.status >= 200 && xhr.status < 300 && data && data.ok) resolve(data);
        else resolve({ ok: false, status: xhr.status, error: (data && data.error) || 'Upload failed (' + xhr.status + ').' });
      };
      xhr.onerror = function () { resolve({ ok: false, error: 'Network error during upload. Check your connection and try again.' }); };
      xhr.ontimeout = function () { resolve({ ok: false, error: 'The upload took too long. Try again.' }); };
      xhr.onabort = function () { resolve({ ok: false, aborted: true, error: 'Upload cancelled.' }); };
      var fd = new FormData();
      fd.append('file', file, file.name || 'upload');
      var isVideo = /^video\//.test(file.type || '') || /\.(mp4|mov)$/i.test(file.name || '');
      (isVideo ? Vane.videoFrames(file) : Promise.resolve([])).then(function (frames) {
        if (aborted) return resolve({ ok: false, aborted: true, error: 'Upload cancelled.' });
        frames.forEach(function (b, n) { fd.append('frame', b, 'frame' + n + '.jpg'); });
        xhr.send(fd);
      });
    });
    return { promise: promise, abort: function () { aborted = true; try { xhr.abort(); } catch (e) { /* already finished */ } } };
  };

  /** Toasts: Vane.toast('ok' | 'err' | 'info', text) */
  var ICONS = {
    ok: '<svg class="toast-ico mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
    err: '<svg class="toast-ico mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/></svg>',
    info: '<svg class="toast-ico mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.01"/></svg>'
  };
  Vane.toast = function (kind, text) {
    var box = document.getElementById('toasts');
    if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
    var el = document.createElement('div');
    el.className = 'toast toast-' + kind;
    el.innerHTML = ICONS[kind] + '<div class="min-w-0 flex-1 text-white/90"></div>';
    el.lastChild.textContent = text; // textContent: never interpret server text as HTML
    box.appendChild(el);
    var close = function () { el.classList.add('out'); setTimeout(function () { el.remove(); }, 280); };
    el.addEventListener('click', close);
    setTimeout(close, kind === 'err' ? 6500 : 4200);
  };

  /** Escape, then highlight links / #tags / @mentions (used by the live preview). */
  Vane.rich = function (text) {
    var h = Vane.esc(text);
    h = h.replace(/(https?:\/\/[^\s<]+)/g, '<span class="text-sky-400">$1</span>');
    h = h.replace(/(^|\s)([#@][\p{L}\p{N}_]+)/gu, '$1<span class="text-sky-400">$2</span>');
    return h.replace(/\n/g, '<br>');
  };

  Vane.isHttps = function (v) {
    try { var u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password; } catch (e) { return false; }
  };

  Vane.VIDEO = 'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260803_192301_9231ed6b-c55c-4a48-909c-4ebe11cf2e11.mp4';
  window.Vane = Vane;
})();
