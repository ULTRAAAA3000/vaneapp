/* The "How much would it cost me?" estimate on the landing page (#estimate in public/index.html).
   It picks the cheapest public plan for a number of posts and channels, from the live price list (/api/plans, edited in
   /admin → Plans). The plans below are only the fallback for when that list does not load; pick() is tested in
   scripts/estimate-unit.mjs. */
(function () {
  'use strict';

  var STEPS = [10, 30, 60, 100, 180, 300, 500, 1000, 1500, 2000, 3000, 5000, 10000];
  var FALLBACK = [
    { id: 'free', kind: 'plan', name: 'Free Trial', badge: '', priceCents: 0, comparePriceCents: null, currency: 'USD', ctaLabel: 'Get started', comingSoon: false, buyable: false,
      limits: { channels: 2, postsLifetime: 30, apiAccess: 1 } },
    { id: 'api', kind: 'plan', name: 'Developer API', badge: '', priceCents: 799, comparePriceCents: null, currency: 'USD', ctaLabel: 'Get started', comingSoon: false, buyable: false,
      limits: { apiPostsPerMonth: 180, apiAccess: 1, overagePostUsd: 0.03 } },
    { id: 'pro', kind: 'plan', name: 'Pro Dashboard', badge: 'Early Bird', priceCents: 1199, comparePriceCents: 1499, currency: 'USD', ctaLabel: 'Get started', comingSoon: false, buyable: false,
      limits: { postsPerMonth: 1000, overagePostUsd: 0.015 } }
  ];

  function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }

  // The cheapest plan that can carry `posts` posts a month on `channels` channels.
  //   mode 'dashboard' counts a plan's postsPerMonth, mode 'api' its apiPostsPerMonth;
  //   posts above the quota are paid per post (overagePostUsd), a plan without that rate cannot take them;
  //   a trial-style plan (postsLifetime) fits only while the whole volume stays inside its total.
  // Returns { plan, totalCents, extraPosts, extraCents, quota, lifetime } or null when nothing fits.
  function pick(plans, posts, channels, mode) {
    var best = null;
    (plans || []).forEach(function (p) {
      if (!p || p.kind !== 'plan' || p.comingSoon) return;
      var l = p.limits || {};
      if (l.channels != null && channels > l.channels) return;
      var cand = null;
      if (num(l.postsLifetime) > 0) {
        if (posts > l.postsLifetime || (mode === 'api' && !l.apiAccess)) return;
        cand = { plan: p, totalCents: num(p.priceCents), extraPosts: 0, extraCents: 0, quota: l.postsLifetime, lifetime: true };
      } else {
        var quota = num(mode === 'api' ? l.apiPostsPerMonth : l.postsPerMonth);
        if (quota <= 0) return;
        var over = num(l.overagePostUsd), extra = Math.max(0, posts - quota);
        if (extra > 0 && over <= 0) return;
        var extraCents = Math.round(extra * over * 100);
        cand = { plan: p, totalCents: num(p.priceCents) + extraCents, extraPosts: extra, extraCents: extraCents, quota: quota, lifetime: false, over: over };
      }
      if (!best || cand.totalCents < best.totalCents) best = cand;
    });
    return best;
  }

  function fmt(cents, cur) {
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD', minimumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100); }
    catch (e) { return '$' + (cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)); }
  }

  if (typeof document === 'undefined') {            // under node (the unit test): export the pure parts only
    if (typeof module !== 'undefined') module.exports = { pick: pick, fmt: fmt, STEPS: STEPS, FALLBACK: FALLBACK };
    return;
  }

  var root = document.getElementById('estimate');
  if (!root) return;
  var $ = function (id) { return document.getElementById(id); };
  var elPosts = $('estPosts'), elCh = $('estCh'), outPosts = $('estPostsOut'), outCh = $('estChOut'), box = $('estResult');
  var modeBtns = [].slice.call(root.querySelectorAll('[data-est-mode]'));
  var plans = FALLBACK, live = false, mode = 'dashboard';
  var esc = function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };

  function row(label, value, note) {
    return '<div class="flex items-baseline justify-between gap-4"><dt class="text-white/55">' + label + (note ? ' <span class="text-white/35">' + esc(note) + '</span>' : '') + '</dt><dd class="font-medium text-white">' + esc(value) + '</dd></div>';
  }

  function cta(p) {
    var cls = 'mt-5 block w-full rounded-full px-6 py-3 text-center text-sm font-semibold ';
    var label = esc(p.ctaLabel || 'Get started');
    if (p.id === 'free' || !live) return '<a href="/login?mode=register" class="' + cls + 'bg-white text-[#010101] transition-opacity hover:opacity-90">' + label + '</a>';
    if (p.buyable) return '<a href="/checkout?plan=' + encodeURIComponent(p.id) + '" class="' + cls + 'bg-white text-[#010101] transition-opacity hover:opacity-90">' + label + '</a>';
    return '<span class="' + cls + 'cursor-default bg-white/5 text-white/40">Opens soon</span>';
  }

  function render() {
    var posts = STEPS[+elPosts.value] || STEPS[0], channels = +elCh.value || 1;
    outPosts.textContent = posts.toLocaleString('en-US');
    outCh.textContent = String(channels);
    modeBtns.forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-est-mode') === mode)); });

    var r = pick(plans, posts, channels, mode);
    if (!r) { box.innerHTML = '<div class="rounded-2xl bg-black/30 p-5 text-sm text-white/60 ring-1 ring-white/10 sm:p-6">No public plan fits this volume yet.</div>'; return; }
    var p = r.plan, cur = p.currency, price = fmt(p.priceCents, cur);
    var compare = p.comparePriceCents && p.comparePriceCents > p.priceCents ? '<span class="pb-1 text-lg text-white/40 line-through">' + esc(fmt(p.comparePriceCents, cur)) + '</span>' : '';
    var rows = row('Plan price', price) +
      row(r.lifetime ? 'Posts included in total' : mode === 'api' ? 'API posts included' : 'Posts included', r.quota.toLocaleString('en-US')) +
      (r.extraPosts > 0 ? row('Extra posts', fmt(r.extraCents, cur), r.extraPosts.toLocaleString('en-US') + ' × $' + r.over) : '');
    var note = r.lifetime ? 'Enough to try Vane before you pay. No card required.'
      : r.extraPosts > 0 ? 'Posts beyond your monthly quota are paid from a prepaid balance (from $10), per post. Empty balance: posting stops.'
      : 'Any number of channels, no per-channel fees.';
    box.innerHTML = '<div class="rounded-2xl bg-black/30 p-5 ring-1 ring-white/10 sm:p-6">' +
      '<p class="text-xs font-medium uppercase tracking-widest text-white/40">Best fit</p>' +
      '<div class="mt-3 flex flex-wrap items-center gap-2"><span class="text-lg font-semibold">' + esc(p.name) + '</span>' +
        (p.badge ? '<span class="rounded-full bg-white px-2.5 py-0.5 text-[11px] font-semibold text-[#010101]">' + esc(p.badge) + '</span>' : '') + '</div>' +
      '<div class="mt-3 flex items-end gap-2">' + compare + '<span class="pixel text-5xl leading-none tracking-tight">' + esc(price) + '</span>' +
        (p.priceCents > 0 ? '<span class="pb-1 text-sm text-white/50">/ month</span>' : '') + '</div>' +
      '<dl class="mt-5 space-y-2 border-t border-white/10 pt-4 text-sm">' + rows +
        '<div class="flex items-baseline justify-between gap-4 border-t border-white/10 pt-2 font-semibold"><dt>Total per month</dt><dd>' + esc(fmt(r.totalCents, cur)) + '</dd></div></dl>' +
      '<p class="mt-4 text-xs leading-relaxed text-white/45">' + note + '</p>' + cta(p) + '</div>';
  }

  elPosts.addEventListener('input', render);
  elCh.addEventListener('input', render);
  modeBtns.forEach(function (b) { b.addEventListener('click', function () { mode = b.getAttribute('data-est-mode') === 'api' ? 'api' : 'dashboard'; render(); }); });
  render();

  fetch('/api/plans')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { if (d && d.ok && d.plans && d.plans.length) { plans = d.plans; live = true; render(); } })
    .catch(function () { /* offline or blocked: the fallback prices stay */ });
})();
