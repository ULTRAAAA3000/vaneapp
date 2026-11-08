/* The balance pill of Vane Studio (the Vane Post dashboard draws its own in dashboard.js): the prepaid balance, a link to /topup.
   Markup: <a data-balance-pill hidden href="/topup"><b data-balance-val></b></a>. Refreshes when you come back to the tab. */
(function () {
  'use strict';
  var el = document.querySelector('[data-balance-pill]');
  if (!el) return;
  var TOPUP = (/^(post|studio)\.vaneapp\.dev$/i.test(location.hostname) ? 'https://vaneapp.dev' : '') + '/topup';
  var last = 0;
  async function load() {
    last = Date.now();
    var r = await Vane.api('GET', '/api/balance', null, { noRedirect: true });
    if (!r.ok) return;
    var n = r.data.balanceUsd;
    el.querySelector('[data-balance-val]').textContent = '$' + (Math.round(n * 1000) / 1000);
    el.setAttribute('href', TOPUP);
    el.hidden = false;
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && Date.now() - last > 20000) load(); });
  document.addEventListener('vane:balance', load);
  load();
})();
