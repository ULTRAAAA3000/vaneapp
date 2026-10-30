(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var query = location.search.slice(1);
  var params = new URLSearchParams(location.search);
  var views = ['viewLoading', 'viewError', 'viewSignin', 'viewAllow', 'viewDone'];

  function show(id) { views.forEach(function (v) { $(v).classList.toggle('hidden', v !== id); }); }
  function keyNames(name) { Array.prototype.forEach.call(document.querySelectorAll('.keyName'), function (el) { el.textContent = name; }); }
  function names(name) { Array.prototype.forEach.call(document.querySelectorAll('.clientName'), function (el) { el.textContent = name; }); }
  function problem(text) { $('errText').textContent = text; show('viewError'); }
  function fields() {
    var o = {};
    ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state'].forEach(function (k) { var v = params.get(k); if (v !== null) o[k] = v; });
    return o;
  }

  function finish(url) { show('viewDone'); Vane.go(url); }

  function submit(button, extra) {
    var body = fields();
    Object.keys(extra).forEach(function (k) { body[k] = extra[k]; });
    button.disabled = true;
    $('err').classList.add('hidden');
    Vane.api('POST', '/api/oauth/authorize', body, { noRedirect: true }).then(function (r) {
      if (r.ok && r.data && r.data.redirect) { finish(r.data.redirect); return; }
      button.disabled = false;
      if (r.status === 401) { show('viewSignin'); return; }
      $('err').textContent = r.error || 'Could not connect. Try again.';
      $('err').classList.remove('hidden');
    });
  }

  var chosen = '';
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ago(ts) {
    if (!ts) return 'never used';
    var d = Math.max(0, Math.floor(Date.now() / 1000) - ts);
    return d < 3600 ? 'used just now' : d < 86400 ? 'used today' : 'used ' + Math.floor(d / 86400) + ' d ago';
  }
  function syncUse() { $('useKey').disabled = !chosen && !$('apiKey').value.trim(); }
  function renderKeys(keys) {
    $('keyList').innerHTML = keys.length ? keys.map(function (k) {
      return '<button type="button" role="radio" aria-checked="false" data-key="' + esc(k.id) + '" class="keyopt flex w-full items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-left hover:border-white/25 aria-checked:border-violet-400/70 aria-checked:bg-violet-400/10">' +
        '<span class="min-w-0"><span class="block truncate text-sm font-medium text-white">' + esc(k.name) + (k.claude ? ' <span class="ml-1 rounded-full bg-violet-400/20 px-1.5 py-0.5 text-[10px] font-medium text-violet-200">Claude</span>' : '') + '</span>' +
        '<span class="block text-xs text-white/45">••••' + esc(k.hint) + ' · ' + esc(ago(k.lastUsedAt)) + '</span></span>' +
        '<span class="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ' + (k.mode === 'live' ? 'bg-emerald-400/15 text-emerald-300' : 'bg-amber-400/15 text-amber-200') + '">' + esc(k.mode) + '</span></button>';
    }).join('') : '<p class="text-xs text-white/45">You have no keys yet. Press Allow and Vane makes one for you.</p>';
    syncUse();
  }
  $('keyList').addEventListener('click', function (e) {
    var b = e.target.closest('[data-key]');
    if (!b) return;
    chosen = chosen === b.getAttribute('data-key') ? '' : b.getAttribute('data-key');
    Array.prototype.forEach.call($('keyList').querySelectorAll('[data-key]'), function (x) { x.setAttribute('aria-checked', String(x.getAttribute('data-key') === chosen)); });
    syncUse();
  });
  $('apiKey').addEventListener('input', syncUse);

  function init() {
    if (!params.get('client_id') || !params.get('redirect_uri')) { problem('Start the connection from the app you are connecting (for Claude: Settings → Connectors → Vane → Connect; for Notion: the agent’s Settings → Connections).'); return; }
    Vane.api('GET', '/api/oauth/authorize?' + query, undefined, { noRedirect: true }).then(function (r) {
      if (r.status === 401) {
        names('Claude');
        $('signinLink').href = '/login?next=' + encodeURIComponent('/connect?' + query);
        show('viewSignin');
        return;
      }
      if (!r.ok) { problem(r.error || 'This connection request is not valid. Start again from the app you are connecting.'); return; }
      names(r.data.client.name);
      if (r.data.keyName) keyNames(r.data.keyName);
      $('who').textContent = r.data.user.email;
      $('testNote').classList.toggle('hidden', r.data.live);
      $('liveNote').classList.toggle('hidden', !r.data.live);
      renderKeys(r.data.keys || []);
      show('viewAllow');
    });
  }

  $('allow').addEventListener('click', function () { submit(this, {}); });
  $('useKey').addEventListener('click', function () {
    var key = $('apiKey').value.trim();
    if (!chosen && !key) { $('err').textContent = 'Pick a key from the list first.'; $('err').classList.remove('hidden'); return; }
    submit(this, chosen ? { keyId: chosen } : { apiKey: key });
  });
  $('deny').addEventListener('click', function () {
    try {
      var u = new URL(params.get('redirect_uri'));
      u.searchParams.set('error', 'access_denied');
      if (params.get('state')) u.searchParams.set('state', params.get('state'));
      Vane.go(u.toString());
    } catch (e) { Vane.go('/'); }
  });

  init();
})();
