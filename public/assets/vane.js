/* Shared helpers for /login and /app. Exposes window.Vane. */
(function () {
  'use strict';
  var Vane = {};

  Vane.esc = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  /** Navigation hook so tests can observe redirects. */
  Vane.go = function (url) { if (window.__go) window.__go(url); else window.location.assign(url); };

  /**
   * JSON API client. Resolves to { ok, status, data, error } and never throws.
   * A 401 sends the user to /login unless opts.noRedirect is set.
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
    if (res.status === 401 && !opts.noRedirect) Vane.go('/login');
    var ok = res.ok && !(data && data.ok === false);
    return { ok: ok, status: res.status, data: data, error: ok ? null : ((data && data.error) || 'Request failed (' + res.status + ')') };
  };

  /** Raw image upload to /api/media/upload → { ok, url, size, width, height, error } */
  Vane.upload = async function (file) {
    var res;
    try {
      res = await fetch('/api/media/upload', { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file, credentials: 'same-origin' });
    } catch (e) { return { ok: false, error: 'Network error during upload.' }; }
    var data = null; try { data = await res.json(); } catch (e) {}
    if (res.status === 401) Vane.go('/login');
    return res.ok && data && data.ok
      ? { ok: true, url: data.url, size: data.size, width: data.width, height: data.height }
      : { ok: false, status: res.status, error: (data && data.error) || 'Upload failed.' };
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
