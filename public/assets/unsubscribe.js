(function () {
  'use strict';
  var q = new URLSearchParams(location.search), e = q.get('e') || '', t = q.get('t') || '';
  var $ = function (id) { return document.getElementById(id); };
  var show = function (id) { ['viewAsk', 'viewDone', 'viewBad'].forEach(function (v) { $(v).classList.toggle('hidden', v !== id); }); };
  var url = '/api/unsubscribe?e=' + encodeURIComponent(e) + '&t=' + encodeURIComponent(t);

  async function send(resubscribe) {
    var r = await fetch('/api/unsubscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ e: e, t: t, resubscribe: resubscribe }) });
    var d = await r.json().catch(function () { return null; });
    if (!r.ok || !d || !d.ok) { show('viewBad'); return; }
    if (d.optedOut) show('viewDone'); else { $('askText').textContent = 'You will get Vane emails again.'; show('viewAsk'); }
  }

  fetch(url).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); }).then(function (r) {
    if (!r.ok || !r.d.ok) { show('viewBad'); return; }
    $('askText').textContent = 'We will stop sending receipts and other optional emails to ' + r.d.email + '. Sign-in codes still arrive when you ask for one.';
    show(r.d.optedOut ? 'viewDone' : 'viewAsk');
  }).catch(function () { show('viewBad'); });

  $('unsubBtn').addEventListener('click', function () { send(false); });
  $('againBtn').addEventListener('click', function () { send(true); });
})();
