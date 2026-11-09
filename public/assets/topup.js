/* /topup: the prepaid balance. Add funds (a normal checkout, from $10), see the balance, and the one switch that lets extra use spend from it.
   Backend: GET /api/balance, POST /api/usage/overage, checkout: /checkout?plan=balance&amount=N (functions/api/billing). */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var S = { data: null, amount: 25 };

  function usd(n) { return '$' + (Math.round(n * 1000) / 1000).toFixed(n % 1 === 0 ? 0 : (Math.round(n * 100) / 100 === n ? 2 : 3)); }
  function day(unix) { return new Date(unix * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); }
  function fatal(text) { $('loading').classList.add('hidden'); $('fatalText').textContent = text; $('fatal').classList.remove('hidden'); }

  function renderStop(d) {
    var el = $('stop'), l = d.limit;
    if (!l || !l.reached) { el.classList.add('hidden'); return; }
    var when = l.resetsAt ? 'It resets on ' + day(l.resetsAt) + '.' : 'It does not reset.';
    el.textContent = 'You have reached your ' + d.plan + ' quota of posts. ' + when + ' To keep going now, add funds below' +
      (l.extraPostUsd !== null ? ' and switch on paying for extra use (' + usd(l.extraPostUsd) + ' per extra post).' : ', or choose a plan.');
    el.classList.remove('hidden');
  }

  function renderSwitch(d) {
    var e = d.extra, sw = $('sw');
    var parts = [];
    if (e.postUsd !== null) parts.push('extra posts over your plan: ' + usd(e.postUsd) + ' each');
    if (e.aiUsd !== null) parts.push('extra AI credits: ' + usd(e.aiUsd) + ' each');
    $('useText').textContent = e.available
      ? 'When your plan’s quota runs out, requests go on and the price comes out of your balance (' + parts.join('; ') + '). With the switch off, or an empty balance, they stop.'
      : 'Your plan has no price for extra use, so there is nothing to switch on. A plan with extras, or the AI Pass, would add it.';
    sw.disabled = !e.available;
    sw.classList.toggle('opacity-40', !e.available);
    sw.setAttribute('aria-checked', String(e.enabled));
    sw.style.backgroundColor = e.enabled ? '#34d399' : '';
    $('swKnob').style.transform = e.enabled ? 'translateX(1.25rem)' : '';
  }

  var WHAT = { post: 'Extra post', ai: 'Extra AI credit', video_ai: 'Extra Studio AI', order: 'Top-up', admin: 'Adjustment' };
  function renderLedger(d) {
    var ul = $('ledger'); ul.innerHTML = '';
    $('empty').classList.toggle('hidden', d.ledger.length > 0);
    d.ledger.forEach(function (r) {
      var li = document.createElement('li'); li.className = 'flex items-center justify-between gap-4 py-3';
      var left = document.createElement('div');
      var t = document.createElement('div'); t.textContent = r.kind === 'refund' ? 'Refunded: ' + (WHAT[r.what] || r.what).toLowerCase() : (WHAT[r.what] || r.what); left.appendChild(t);
      var s = document.createElement('div'); s.className = 'text-xs text-white/40'; s.textContent = new Date(r.at * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + (r.note ? ' · ' + r.note : ''); left.appendChild(s);
      var a = document.createElement('div'); a.className = 'shrink-0 font-medium ' + (r.usd >= 0 ? 'text-emerald-300' : 'text-white/80'); a.textContent = (r.usd >= 0 ? '+' : '−') + usd(Math.abs(r.usd));
      li.appendChild(left); li.appendChild(a); ul.appendChild(li);
    });
  }

  function renderAmounts(d) {
    var box = $('presets'); box.innerHTML = '';
    d.presets.forEach(function (n) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'amt'; b.textContent = '$' + n;
      b.setAttribute('aria-pressed', String(S.amount === n && !$('custom').value));
      b.addEventListener('click', function () { S.amount = n; $('custom').value = ''; $('amtErr').classList.add('hidden'); renderAmounts(d); });
      box.appendChild(b);
    });
  }

  function chosen() {
    var raw = $('custom').value.trim();
    var n = raw ? Number(raw) : S.amount, d = S.data;
    if (!isFinite(n) || n !== Math.floor(n)) return { error: 'Enter a whole number of dollars.' };
    if (n < d.min || n > d.max) return { error: 'The amount must be from ' + usd(d.min) + ' to ' + usd(d.max) + '.' };
    return { amount: n };
  }

  function render(d) {
    S.data = d;
    $('bal').textContent = usd(d.balanceUsd);
    $('min').textContent = usd(d.min); $('max').textContent = usd(d.max);
    renderStop(d); renderSwitch(d); renderLedger(d); renderAmounts(d);
  }

  $('custom').addEventListener('input', function () { $('amtErr').classList.add('hidden'); if (S.data) renderAmounts(S.data); });
  $('go').addEventListener('click', function () {
    var c = chosen();
    if (c.error) { $('amtErr').textContent = c.error; $('amtErr').classList.remove('hidden'); return; }
    // Payment is the one checkout for everything (billing details, Terms, card or crypto); only the plan differs.
    Vane.go((/^(post|studio)\.vaneapp\.dev$/i.test(location.hostname) ? 'https://vaneapp.dev' : '') + '/checkout?plan=balance&amount=' + c.amount);
  });

  $('sw').addEventListener('click', async function () {
    var d = S.data, on = !d.extra.enabled;
    // Say what will be spent BEFORE it is switched on: one switch covers extra posts and extra AI credits.
    if (on && !window.confirm('Extra use will be paid from your balance, never from a card.' +
        (d.extra.postUsd !== null ? '\n\nExtra posts over your plan: ' + usd(d.extra.postUsd) + ' each.' : '') +
        (d.extra.aiUsd !== null ? '\n\nExtra AI credits: ' + usd(d.extra.aiUsd) + ' each.' : '') +
        '\n\nWhen the balance is empty they stop. You can switch this off at any time. Turn it on?')) return;
    var r = await Vane.api('POST', '/api/usage/overage', { enabled: on });
    if (!r.ok) { $('amtErr').textContent = r.error || 'Could not change it. Please try again.'; $('amtErr').classList.remove('hidden'); return; }
    load();
  });

  async function load() {
    var r = await Vane.api('GET', '/api/balance');
    if (!r.ok) return fatal(r.error || 'Could not load your balance.');
    $('loading').classList.add('hidden'); $('main').classList.remove('hidden');
    render(r.data);
  }

  $('back').setAttribute('href', Vane.productUrl ? Vane.productUrl('post') : '/');
  load();
})();
