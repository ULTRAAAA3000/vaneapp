/* The plan cards of /pricing. One function builds the markup for both the page script (assets/pricing.js, from /api/plans) and the
   build (scripts/build-site-pages.mjs, from scripts/plans-snapshot.json), so a visitor, a search engine and an AI assistant that
   reads the HTML without running JavaScript all see the same plans and prices. */
(function (root) {
  'use strict';
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  function fmt(c, cur) {
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD', minimumFractionDigits: c % 100 === 0 ? 0 : 2 }).format(c / 100); }
    catch (e) { return '$' + (c / 100).toFixed(2); }
  }
  function card(p, interval) {
    var yearly = interval === 'year' && p.yearlyPriceCents && p.interval !== 'year';
    var cents = yearly ? p.yearlyPriceCents : p.priceCents;
    var per = cents > 0 ? '/ ' + (yearly || p.interval === 'year' ? 'year' : 'month') : '';
    var was = !yearly && p.comparePriceCents && p.comparePriceCents > cents ? '<span class="pb-1 text-lg text-white/40 line-through">' + esc(fmt(p.comparePriceCents, p.currency)) + '</span>' : '';
    var badge = p.badge ? '<span class="absolute -top-3 left-6 rounded-full bg-white px-3 py-1 text-[11px] font-semibold text-[#010101]">' + esc(p.badge) + '</span>' : '';
    var soon = p.comingSoon ? '<span class="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white/55">Coming soon</span>' : '';
    var href = '/checkout?plan=' + encodeURIComponent(p.id) + (yearly ? '&interval=year' : '');
    var btn = p.highlight ? 'bg-white text-[#010101] hover:opacity-90' : 'bg-white/10 text-white hover:bg-white/20';
    var cta = p.buyable ? '<a href="' + href + '" class="block w-full rounded-full px-6 py-3 text-center text-sm font-semibold transition ' + btn + '">' + esc(p.ctaLabel) + '</a>'
      : p.id === 'free' ? '<a href="/login" class="block w-full rounded-full bg-white/10 px-6 py-3 text-center text-sm font-semibold text-white transition hover:bg-white/20">Start free</a>'
      : '<span class="block w-full cursor-default rounded-full bg-white/5 px-6 py-3 text-center text-sm font-semibold text-white/40">' + (p.comingSoon ? 'Coming soon' : 'Opens soon') + '</span>';
    return '<div class="glass-d card relative flex flex-col' + (p.highlight ? ' ring-1 ring-white/30' : '') + '">' + badge +
      '<div class="flex items-center justify-between gap-3"><p class="eyebrow">' + esc(p.name) + '</p>' + soon + '</div>' +
      '<div class="mt-4 flex items-end gap-2">' + was + '<span class="pixel text-5xl leading-none">' + esc(fmt(cents, p.currency)) + '</span><span class="pb-1 text-sm text-white/50">' + per + '</span></div>' +
      '<p class="copy mt-2">' + esc(p.tagline).replace('{price}', esc(fmt(p.priceCents, p.currency))) + '</p>' +
      '<ul class="check mt-5">' + p.features.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>' +
      '<div class="mt-auto pt-7">' + cta + '</div></div>';
  }
  var api = { card: card, fmt: fmt, esc: esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.VanePlanCard = api;
})(typeof window !== 'undefined' ? window : this);
