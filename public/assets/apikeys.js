/* Shared "API access" section for Vane Post and Vane Studio: the same markup ids, the same behaviour, the same look.
   The page supplies what is specific to its product (quota card, quick start, wording) through VaneKeys.mount(). */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = Vane.esc;

  var KEY_ICON = '<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3L21 2M17 6l3 3M14 9l2 2"/></svg>';
  var TRASH = '<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6M10 11v6M14 11v6"/></svg>';

  // ───────────────────────── small helpers (also handed to the page) ─────────────────────────
  function fmtDay(ts) { return new Date(ts * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); }

  function rel(ts) {
    var s = Math.max(0, Math.round(Date.now() / 1000 - ts));
    if (s < 60) return 'just now';
    var units = [['d', 86400], ['h', 3600], ['m', 60]];
    for (var i = 0; i < units.length; i++) if (s >= units[i][1]) return Math.floor(s / units[i][1]) + units[i][0] + ' ago';
    return 'just now';
  }

  /** The usage meter colour: green, then amber from 80%, red at the limit. */
  function meterColor(pct) { return pct >= 100 ? '#f87171' : pct >= 80 ? '#fbbf24' : '#34d399'; }

  /** Copies text; falls back to a hidden textarea where the Clipboard API is unavailable. */
  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
    } catch (e) { /* fall through */ }
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var done = document.execCommand && document.execCommand('copy');
      ta.remove();
      return !!done;
    } catch (e) { return false; }
  }
  function copyWithToast(text, label) {
    copyText(text).then(function (ok) { Vane.toast(ok ? 'ok' : 'info', ok ? label + ' copied.' : 'Select the text and press Ctrl+C to copy it.'); });
  }
  function showErr(box, form, msg) {
    box.textContent = msg; box.classList.remove('hidden');
    if (form) { form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake'); }
  }
  function hideErr(box) { box.classList.add('hidden'); box.textContent = ''; }

  /**
   * cfg:
   *   scope        'post' | 'video': which keys this section lists and creates
   *   load()       Promise<boolean>: loads the product's own numbers (the quota card); false = could not load
   *   renderQuota(box)   fills the quota card from what load() fetched
   *   renderQuick(body)  fills the quick start; returns the example request text (the "Copy" button copies it)
   *   liveAllowed()      may this account create live keys right now? (default: yes)
   *   liveNote           what to tell it when it may not
   *   emptyText          the sentence under "No API keys yet"
   * Returns { refresh, render }.
   */
  function mount(cfg) {
    var S = { keys: null, max: 10, armed: {}, failed: false, loaded: false, refreshing: false };
    var snippet = '';

    async function load() {
      var rs = await Promise.all([cfg.load(), Vane.api('GET', '/api/keys?scope=' + encodeURIComponent(cfg.scope))]);
      if (!rs[0] || !rs[1].ok) { if (!S.loaded) S.failed = true; return; }   // keep what is on screen on a hiccup
      S.failed = false; S.loaded = true;
      S.keys = rs[1].data.keys;
      S.max = rs[1].data.max || 10;
    }

    function render() { renderQuota(); renderKeys(); renderQuick(); }

    /** Silent refresh (the numbers may have changed from another place, e.g. a video uploaded through the API). */
    async function refreshQuietly() {
      if (S.refreshing) return;
      S.refreshing = true;
      await load();
      S.refreshing = false;
      render();
    }
    async function refresh() { await load(); render(); }

    function renderQuota() {
      var box = $('apiQuota');
      if (!S.loaded) {
        if (S.failed) box.innerHTML = '<p class="text-sm leading-relaxed text-white/55">API access could not be loaded right now. Try again in a moment.</p>';
        return;
      }
      cfg.renderQuota(box);
    }

    function renderQuick() { if (S.loaded) snippet = cfg.renderQuick($('apiQuickBody')); }

    // ───────────────────────── the keys ─────────────────────────
    function arm(key) {
      clearTimeout(S.armed[key]);
      S.armed[key] = setTimeout(function () { delete S.armed[key]; renderKeys(); }, 3200);
    }
    function disarm(key) { clearTimeout(S.armed[key]); delete S.armed[key]; }

    function renderKeys() {
      var box = $('apiKeys'), btn = $('keyNewBtn');
      if (!S.keys) { box.innerHTML = S.failed ? '' : box.innerHTML; return; }
      var full = S.keys.length >= S.max;
      btn.disabled = full;
      btn.title = full ? 'You can have up to ' + S.max + ' active keys. Revoke one you no longer use.' : '';

      if (!S.keys.length) {
        box.innerHTML =
          '<div class="rounded-2xl border border-dashed border-white/10 px-5 py-8 text-center">' +
            '<div class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-white/[0.07] text-white/80">' + KEY_ICON + '</div>' +
            '<p class="mt-4 text-sm font-medium">No API keys yet</p>' +
            '<p class="mx-auto mt-1 max-w-[18rem] text-xs leading-relaxed text-white/45">' + esc(cfg.emptyText) + '</p>' +
            '<button type="button" data-act="newkey" class="btn btn-white btn-sm mt-5">Create your first key</button>' +
          '</div>';
        return;
      }
      box.innerHTML = S.keys.map(function (k) {
        var armed = !!S.armed['key:' + k.id];
        var used = k.lastUsedAt ? 'Last used ' + rel(k.lastUsedAt) : 'Never used';
        return '<div class="flex items-center gap-3 rounded-2xl bg-white/[0.04] p-3 ring-1 ring-white/5">' +
          '<div class="net-tile bg-white/[0.07] text-white/80">' + KEY_ICON + '</div>' +
          '<div class="min-w-0 flex-1">' +
            '<div class="flex items-center gap-2"><span class="truncate text-sm font-medium">' + esc(k.name) + '</span>' +
              '<span class="badge ' + (k.mode === 'live' ? 'badge-sent' : 'badge-scheduled') + '">' + (k.mode === 'live' ? 'Live' : 'Test') + '</span></div>' +
            '<div class="mt-0.5 truncate font-mono text-xs text-white/50">' + esc(k.display) + '</div>' +
            '<div class="mt-0.5 text-xs text-white/35">Created ' + esc(fmtDay(k.createdAt)) + ' · ' + esc(used) + '</div>' +
          '</div>' +
          (armed
            ? '<button type="button" data-act="revoke" data-id="' + esc(k.id) + '" class="btn btn-danger btn-sm shrink-0">Revoke?</button>'
            : '<button type="button" data-act="revoke" data-id="' + esc(k.id) + '" class="icon-btn shrink-0" aria-label="Revoke key ' + esc(k.name) + '">' + TRASH + '</button>') +
        '</div>';
      }).join('');
    }

    $('apiKeys').addEventListener('click', async function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var act = btn.getAttribute('data-act'), id = btn.getAttribute('data-id');
      if (act === 'newkey') return openKeyDialog();
      if (act === 'revoke') {
        var key = 'key:' + id;
        if (!S.armed[key]) { arm(key); renderKeys(); return; }   // first click arms, second confirms
        disarm(key);
        btn.disabled = true;
        var d = await Vane.api('DELETE', '/api/keys/' + encodeURIComponent(id));
        if (!d.ok) { Vane.toast('err', d.error); renderKeys(); return; }
        Vane.toast('ok', 'Key revoked. Anything still using it stops working now.');
        await refresh();
      }
    });
    $('keyNewBtn').addEventListener('click', openKeyDialog);

    $('apiQuickBody').addEventListener('click', function (e) {
      var c = e.target.closest('[data-copy]');
      if (c) return copyWithToast(c.getAttribute('data-copy'), c.getAttribute('data-label') || 'Text');
      if (e.target.closest('[data-copy-snippet]')) copyWithToast(snippet, 'Request');
    });

    // ───────────────────────── create-a-key dialog ─────────────────────────
    var kdlg = $('keyDialog');
    var K = { mode: 'live', revealed: false, copied: false, busy: false };

    function setKeyMode(mode) {
      K.mode = mode;
      $('modeLive').setAttribute('aria-pressed', String(mode === 'live'));
      $('modeTest').setAttribute('aria-pressed', String(mode === 'test'));
    }
    $('modeLive').addEventListener('click', function () { if (!this.disabled) setKeyMode('live'); });
    $('modeTest').addEventListener('click', function () { setKeyMode('test'); });

    function openKeyDialog() {
      K.revealed = false; K.copied = false; K.busy = false;
      $('keyForm').reset(); hideErr($('keyErr'));
      $('keyForm').classList.remove('hidden'); $('keyDone').classList.add('hidden');
      $('keyTitle').textContent = 'Create an API key';
      $('keySub').textContent = 'Name it after the place you will use it.';
      $('keySecret').textContent = '';
      $('keyCopy').textContent = 'Copy';
      $('keySubmit').disabled = false; $('keySpin').classList.add('hidden'); $('keyLabel').textContent = 'Create key';

      var live = !cfg.liveAllowed || cfg.liveAllowed();
      $('modeLive').disabled = !live;
      var note = $('keyModeNote');
      note.classList.toggle('hidden', live);
      if (!live) note.textContent = cfg.liveNote;
      setKeyMode(live ? 'live' : 'test');

      if (typeof kdlg.showModal === 'function') kdlg.showModal(); else kdlg.setAttribute('open', '');
      setTimeout(function () { $('keyName').focus(); }, 60);
    }
    function closeKeyDialog() {
      if (typeof kdlg.close === 'function') kdlg.close(); else kdlg.removeAttribute('open');
    }

    $('keyForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      if (K.busy) return;
      hideErr($('keyErr'));
      var name = $('keyName').value.trim();
      if (!name) return showErr($('keyErr'), $('keyForm'), 'Give the key a name, for example Make.com.');

      K.busy = true; $('keySubmit').disabled = true; $('keySpin').classList.remove('hidden'); $('keyLabel').textContent = 'Creating…';
      var r = await Vane.api('POST', '/api/keys', { name: name, mode: K.mode, scope: cfg.scope });
      K.busy = false; $('keySubmit').disabled = false; $('keySpin').classList.add('hidden'); $('keyLabel').textContent = 'Create key';
      if (!r.ok) return showErr($('keyErr'), $('keyForm'), r.error);

      // The secret exists only in this response: put it on screen once, and wipe it when the dialog closes.
      K.revealed = true;
      $('keySecret').textContent = r.data.secret;
      $('keyTitle').textContent = 'Your new key';
      $('keySub').textContent = r.data.key.name + ' · ' + (r.data.key.mode === 'live' ? 'Live' : 'Test');
      $('keyForm').classList.add('hidden'); $('keyDone').classList.remove('hidden');
      refreshQuietly();   // the list behind the dialog
    });

    $('keyCopy').addEventListener('click', async function () {
      var ok = await copyText($('keySecret').textContent);
      if (ok) {
        K.copied = true; this.textContent = 'Copied';
        var btn = this; setTimeout(function () { btn.textContent = 'Copy'; }, 2000);
      } else {
        Vane.toast('info', 'Select the key and press Ctrl+C to copy it.');
      }
    });

    $('keyClose').addEventListener('click', closeKeyDialog);
    $('keyCancel').addEventListener('click', closeKeyDialog);
    $('keyFinish').addEventListener('click', closeKeyDialog);
    // While the secret is on screen a stray click outside or Esc must not throw it away.
    kdlg.addEventListener('click', function (e) { if (e.target === kdlg && !K.revealed) closeKeyDialog(); });
    kdlg.addEventListener('cancel', function (e) {
      if (K.revealed && !K.copied) {
        e.preventDefault();
        var w = $('keyWarn'); w.classList.remove('shake'); void w.offsetWidth; w.classList.add('shake');
      }
    });
    kdlg.addEventListener('close', function () { $('keySecret').textContent = ''; K.revealed = false; });

    return { refresh: refresh, render: render };
  }

  window.VaneKeys = { mount: mount, esc: esc, fmtDay: fmtDay, meterColor: meterColor, copyText: copyText, copyWithToast: copyWithToast };
})();
