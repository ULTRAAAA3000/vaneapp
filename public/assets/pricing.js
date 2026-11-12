/* /pricing — the plan cards, read from /api/plans (edited in /admin → Plans). The page already holds the same cards from scripts/plans-snapshot.json, so they read without JavaScript too. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var interval = 'month', plans = [];
  var card = function (p) { return window.VanePlanCard.card(p, interval); };   // assets/plan-card.js: the same markup the build writes into the page
  function render() {
    var list = plans.filter(function (p) { return p.kind === 'plan'; });
    $('pricingGrid').innerHTML = list.length ? list.map(card).join('') : '<div class="glass-d card"><p class="copy">The plans are being set up. Check back soon.</p></div>';
    var hasYear = list.some(function (p) { return p.yearlyPriceCents && p.interval !== 'year'; });
    $('pricingSeg').classList.toggle('hidden', !hasYear);
    $('pMonth').setAttribute('aria-pressed', String(interval === 'month')); $('pYear').setAttribute('aria-pressed', String(interval === 'year'));
    Array.prototype.forEach.call(document.querySelectorAll('#pricingSeg button'), function (b) { var on = b.getAttribute('aria-pressed') === 'true'; b.style.background = on ? '#fff' : 'transparent'; b.style.color = on ? '#010101' : ''; });
    var any = list.some(function (p) { return p.buyable; });
    $('pricingNote').classList.toggle('hidden', any);
    $('pricingNote').textContent = any ? '' : 'Online payment opens soon.';
  }
  $('pMonth').addEventListener('click', function () { interval = 'month'; render(); });
  $('pYear').addEventListener('click', function () { interval = 'year'; render(); });
  fetch('/api/plans').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) { if (d && d.ok) { plans = d.plans; } render(); }).catch(render);
})();
