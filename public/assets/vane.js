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
  var OWN_HOST = /^(post|studio)\.vaneapp\.dev$/i;
  var DEV_PAGES = ['/app', '/studio'];
  Vane.home = function () {
    var h = location.hostname;
    if (OWN_HOST.test(h)) return '/';
    var q = new URLSearchParams(location.search);
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
   * "Home" is the main site (the landing page). On post. and studio. the address "/" is that product's own dashboard,
   * so a logo or "Back to site" link must point at the main site explicitly. Mark such links with data-site-home.
   */
  Vane.siteHome = function () { return OWN_HOST.test(location.hostname) ? 'https://vaneapp.dev/' : '/'; };
  function wireHomeLinks() {
    var links = document.querySelectorAll('a[data-site-home]');
    for (var i = 0; i < links.length; i++) links[i].setAttribute('href', Vane.siteHome());
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireHomeLinks); else wireHomeLinks();

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
    return { ok: ok, status: res.status, data: data, error: ok ? null : ((data && data.error) || 'Request failed (' + res.status + ')') };
  };

  /**
   * Uploads one file to /api/media/upload as multipart/form-data, with progress.
   * Returns { promise, abort }. The promise always resolves to
   *   { ok:true, kind, url, key, size, contentType, width?, height? }  or  { ok:false, error, aborted? }
   * (XMLHttpRequest is used because fetch() cannot report upload progress.)
   */
  Vane.uploadFile = function (file, onProgress) {
    var xhr = new XMLHttpRequest();
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
      xhr.send(fd);
    });
    return { promise: promise, abort: function () { try { xhr.abort(); } catch (e) { /* already finished */ } } };
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
