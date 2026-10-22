/* /pricing — the plan cards, read from /api/plans (edited in /admin → Plans). */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var interval = 'month', plans = [];
  function fmt(c, cur) {
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD', minimumFractionDigits: c % 100 === 0 ? 0 : 2 }).format(c / 100); }
    catch (e) { return '$' + (c / 100).toFixed(2); }
  }
  function card(p) {
    var yearly = interval === 'year' && p.yearlyPriceCents && p.interval !== 'year';
    var cents = yearly ? p.yearlyPriceCents : p.priceCents;
    var per = cents > 0 ? '/ ' + (yearly || p.interval === 'year' ? 'year' : 'month') : '';
    var badge = p.badge ? '<span class="absolute -top-3 left-6 rounded-full bg-white px-3 py-1 text-[11px] font-semibold text-[#010101]">' + esc(p.badge) + '</span>' : '';
    var soon = p.comingSoon ? '<span class="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white/55">Coming soon</span>' : '';
    var href = '/checkout?plan=' + encodeURIComponent(p.id) + (yearly ? '&interval=year' : '');
    var btn = p.highlight ? 'bg-white text-[#010101] hover:opacity-90' : 'bg-white/10 text-white hover:bg-white/20';
    var cta = p.buyable ? '<a href="' + href + '" class="block w-full rounded-full px-6 py-3 text-center text-sm font-semibold transition ' + btn + '">' + esc(p.ctaLabel) + '</a>'
      : p.id === 'free' ? '<a href="/login" class="block w-full rounded-full bg-white/10 px-6 py-3 text-center text-sm font-semibold text-white transition hover:bg-white/20">Start free</a>'
      : '<a href="/#join" class="block w-full rounded-full bg-white/10 px-6 py-3 text-center text-sm font-semibold text-white transition hover:bg-white/20">' + (p.comingSoon ? 'Get notified' : 'Join the waitlist') + '</a>';
    return '<div class="glass-d card relative flex flex-col' + (p.highlight ? ' ring-1 ring-white/30' : '') + '">' + badge +
      '<div class="flex items-center justify-between gap-3"><p class="eyebrow">' + esc(p.name) + '</p>' + soon + '</div>' +
      '<div class="mt-4 flex items-end gap-2"><span class="pixel text-5xl leading-none">' + esc(fmt(cents, p.currency)) + '</span><span class="pb-1 text-sm text-white/50">' + per + '</span></div>' +
      '<p class="copy mt-2">' + esc(p.tagline).replace('{price}', esc(fmt(p.priceCents, p.currency))) + '</p>' +
      '<ul class="check mt-5">' + p.features.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>' +
      '<div class="mt-auto pt-7">' + cta + '</div></div>';
  }
  function render() {
    var list = plans.filter(function (p) { return p.kind === 'plan'; });
    $('pricingGrid').innerHTML = list.length ? list.map(card).join('') : '<div class="glass-d card"><p class="copy">The plans are being set up. Check back soon.</p></div>';
    var hasYear = list.some(function (p) { return p.yearlyPriceCents && p.interval !== 'year'; });
    $('pricingSeg').classList.toggle('hidden', !hasYear);
    $('pMonth').setAttribute('aria-pressed', String(interval === 'month')); $('pYear').setAttribute('aria-pressed', String(interval === 'year'));
    Array.prototype.forEach.call(document.querySelectorAll('#pricingSeg button'), function (b) { var on = b.getAttribute('aria-pressed') === 'true'; b.style.background = on ? '#fff' : 'transparent'; b.style.color = on ? '#010101' : ''; });
    var any = list.some(function (p) { return p.buyable; });
    $('pricingNote').classList.toggle('hidden', any);
    $('pricingNote').textContent = any ? '' : 'Online payment opens soon. Join the waitlist and we will write to you.';
  }
  $('pMonth').addEventListener('click', function () { interval = 'month'; render(); });
  $('pYear').addEventListener('click', function () { interval = 'year'; render(); });
  fetch('/api/plans').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) { if (d && d.ok) { plans = d.plans; } render(); }).catch(render);
})();
