(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var query = location.search.slice(1);
  var params = new URLSearchParams(location.search);
  var views = ['viewLoading', 'viewError', 'viewSignin', 'viewAllow', 'viewDone'];

  function show(id) { views.forEach(function (v) { $(v).classList.toggle('hidden', v !== id); }); }
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

  function init() {
    if (!params.get('client_id') || !params.get('redirect_uri')) { problem('Start the connection from Claude: Settings → Connectors → Vane → Connect.'); return; }
    Vane.api('GET', '/api/oauth/authorize?' + query, undefined, { noRedirect: true }).then(function (r) {
      if (r.status === 401) {
        names('Claude');
        $('signinLink').href = '/login?next=' + encodeURIComponent('/connect?' + query);
        show('viewSignin');
        return;
      }
      if (!r.ok) { problem(r.error || 'This connection request is not valid. Start again from Claude.'); return; }
      names(r.data.client.name);
      $('who').textContent = r.data.user.email;
      $('testNote').classList.toggle('hidden', r.data.live);
      $('liveNote').classList.toggle('hidden', !r.data.live);
      show('viewAllow');
    });
  }

  $('allow').addEventListener('click', function () { submit(this, {}); });
  $('useKey').addEventListener('click', function () {
    var key = $('apiKey').value.trim();
    if (!key) { $('err').textContent = 'Paste your API key first.'; $('err').classList.remove('hidden'); return; }
    submit(this, { apiKey: key });
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
