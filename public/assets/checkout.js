/* /checkout — the plan, billing details and payment method (backend: functions/api/billing). ?plan=<id>&interval=month|year, or ?order=<id> on the way back from the bank. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var q = new URLSearchParams(location.search);
  var S = { plan: null, interval: 'month', method: null, asset: 'usdt', cfg: null, order: null, busy: false, poll: null, tick: null };
  var COUNTRIES = 'AL AD AM AT AZ BY BE BA BG HR CY CZ DK EE FI FR GE DE GR HU IS IE IT KZ XK LV LI LT LU MT MD MC ME NL MK NO PL PT RO RS SK SI ES SE CH TR UA GB US CA MX BR AR CL CO PE AU NZ JP KR SG HK TW IN ID MY TH VN PH IL AE SA QA EG ZA NG KE MA TN'.split(' ');

  function fmt(c, cur) {
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD', minimumFractionDigits: c % 100 === 0 ? 0 : 2 }).format(c / 100); }
    catch (e) { return '$' + (c / 100).toFixed(2); }
  }
  function show(step) {
    ['stepForm', 'stepCrypto', 'stepWait', 'stepDone', 'stepClosed'].forEach(function (id) { $(id).classList.toggle('hidden', id !== step); });
  }
  function fatal(msg) { $('loading').classList.add('hidden'); $('main').classList.add('hidden'); $('fatalText').textContent = msg; $('fatal').classList.remove('hidden'); }
  function err(msg) { var e = $('err'); e.textContent = msg || ''; e.classList.toggle('hidden', !msg); }
  function stop() { if (S.poll) clearInterval(S.poll); if (S.tick) clearInterval(S.tick); S.poll = S.tick = null; }

  // ── the plan side
  function price() {
    var p = S.plan;
    if (S.interval === 'year') return p.interval === 'year' ? p.priceCents : p.yearlyPriceCents;
    return p.priceCents;
  }
  function renderPlan() {
    var p = S.plan;
    $('planName').textContent = p.name;
    $('planTagline').textContent = (p.tagline || '').replace('{price}', fmt(p.priceCents, p.currency));
    $('planBadge').textContent = p.badge || ''; $('planBadge').classList.toggle('hidden', !p.badge);
    $('planFeatures').innerHTML = (p.features || []).map(function (f) { return '<li class="flex gap-3"><span class="text-emerald-400">✓</span><span></span></li>'; }).join('');
    Array.prototype.forEach.call($('planFeatures').children, function (li, i) { li.lastChild.textContent = p.features[i]; });
    var yearly = p.interval !== 'year' && p.yearlyPriceCents;
    $('intervalBox').classList.toggle('hidden', !yearly);
    if (yearly) {
      var save = p.priceCents * 12 - p.yearlyPriceCents;
      $('saveNote').textContent = save > 0 ? 'Save ' + fmt(save, p.currency) + ' a year' : '';
    }
    $('iMonth').setAttribute('aria-pressed', String(S.interval === 'month'));
    $('iYear').setAttribute('aria-pressed', String(S.interval === 'year'));
    var yr = S.interval === 'year' || p.interval === 'year';
    $('total').textContent = fmt(price(), p.currency);
    $('totalNote').textContent = (yr ? 'For one year of ' : 'For one month of ') + p.name + '. No automatic renewal.';
    renderTerms(yr);
    updatePay();
  }
  // The terms of this purchase, in plain words, before anything is paid: what is bought, for how long, that it does not renew, how to stop, refunds.
  function renderTerms(yr) {
    var end = new Date(); if (yr) end.setFullYear(end.getFullYear() + 1); else end.setMonth(end.getMonth() + 1);
    var until = end.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
    var items = [
      'One payment of ' + fmt(price(), S.plan.currency) + ' for one ' + (yr ? 'year' : 'month') + ' of ' + S.plan.name + '. Access runs for the full period, about until ' + until + ' if you pay today (a period you still have left is added to).',
      'No automatic renewal: we never charge you again by ourselves. To continue, pay again before the period ends; after it ends your account returns to the Free plan.',
      'Nothing to cancel: there is no subscription to stop. Your data stays; features and limits above the Free plan switch off when the period ends.',
      'Paid periods are not refunded for the part you have used, except where the law gives you a right to a refund. Details: Terms, “Cancelling and refunds”.'
    ];
    $('purchaseTerms').innerHTML = items.map(function () { return '<li class="flex gap-2.5"><span class="mt-[0.4rem] h-1 w-1 shrink-0 rounded-full bg-white/40" aria-hidden="true"></span><span></span></li>'; }).join('');
    Array.prototype.forEach.call($('purchaseTerms').children, function (li, i) { li.lastChild.textContent = items[i]; });
  }
  // EU, EEA, UK and Switzerland: the 14-day withdrawal right applies, so the buyer must ask for an immediate start
  var WITHDRAWAL = 'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO GB CH'.split(' ');
  function needsWaiver() { return WITHDRAWAL.indexOf($('fCountry').value) !== -1; }
  function syncConsent() {
    var w = needsWaiver();
    $('waiverRow').classList.toggle('hidden', !w); $('waiverRow').classList.toggle('flex', w);
    updatePay();
  }
  function consented() { return $('fAccept').checked && (!needsWaiver() || $('fWaiver').checked); }
  function updatePay() {
    var label = !S.method ? 'Choose a payment method' : S.method === 'crypto' ? 'Continue to crypto payment · ' + fmt(price(), S.plan.currency) : 'Pay ' + fmt(price(), S.plan.currency) + ' by card';
    $('payLabel').textContent = S.busy ? 'Please wait…' : label;
    $('pay').disabled = S.busy || !S.method || !consented();
  }

  // ── methods
  function renderMethods() {
    var m = S.cfg.methods;
    [['mCard', 'monobank', 'mCardSoon'], ['mCrypto', 'crypto', 'mCryptoSoon']].forEach(function (x) {
      var on = !!m[x[1]];
      $(x[0]).disabled = !on; $(x[2]).classList.toggle('hidden', on);
    });
    if (!S.method) S.method = m.monobank ? 'monobank' : m.crypto ? 'crypto' : null;
    paintMethod();
  }
  function paintMethod() {
    $('mCard').setAttribute('aria-checked', String(S.method === 'monobank'));
    $('mCrypto').setAttribute('aria-checked', String(S.method === 'crypto'));
    $('assetBox').classList.toggle('hidden', S.method !== 'crypto');
    Array.prototype.forEach.call(document.querySelectorAll('[data-asset]'), function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-asset') === S.asset)); });
    updatePay();
  }

  ['fAccept', 'fWaiver', 'fCountry'].forEach(function (id) { $(id).addEventListener('change', syncConsent); });

  // ── submit
  $('form').addEventListener('submit', async function (e) {
    e.preventDefault();
    if (S.busy || !S.method) return;
    err('');
    var name = $('fName').value.trim(), email = $('fEmail').value.trim(), country = $('fCountry').value;
    if (name.length < 2) return err('Enter your name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return err('Enter a valid email for the receipt.');
    if (!country) return err('Choose your country.');
    if (!$('fAccept').checked) return err('Please agree to the Terms and the purchase terms to continue.');
    if (needsWaiver() && !$('fWaiver').checked) return err('Please confirm that you want the plan to start immediately.');
    S.busy = true; updatePay(); $('paySpin').classList.remove('hidden');
    var r = await Vane.api('POST', '/api/billing/checkout', {
      planId: S.plan.id, interval: S.interval, method: S.method, asset: S.asset, accept: true, waiver: needsWaiver() ? true : undefined,
      billing: { name: name, email: email, country: country, company: $('fCompany').value.trim(), vatId: $('fVat').value.trim() },
    }, { noRedirect: true });
    S.busy = false; $('paySpin').classList.add('hidden'); updatePay();
    if (r.status === 401) return Vane.go('/login?next=' + encodeURIComponent('/checkout' + location.search));
    if (!r.ok) return err(r.error);
    S.order = r.data.order;
    if (S.order.method === 'monobank' && S.order.payUrl) { Vane.go(S.order.payUrl); return; }
    showCrypto();
  });

  // ── crypto panel
  function showCrypto() {
    var c = S.order.crypto;
    if (!c) return err('The crypto details are not available. Please try again.');
    $('cAssetTitle').textContent = c.assetLabel;
    $('cAmount').textContent = c.amount + ' ' + c.assetLabel;
    $('cAddress').textContent = c.address;
    $('cOpen').setAttribute('href', c.solanaPayUrl);
    var box = $('qr'); box.innerHTML = '';
    if (window.QRCode) { try { new QRCode(box, { text: c.solanaPayUrl, width: 144, height: 144, correctLevel: QRCode.CorrectLevel.M }); } catch (x) { box.textContent = 'QR'; } }
    show('stepCrypto');
    startWatching();
    history.replaceState(null, '', '/checkout?order=' + S.order.id);
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-copy]');
    if (!b) return;
    var text = $(b.getAttribute('data-copy')).textContent.replace(/\s[A-Z]+$/, '');
    var done = function () { var t = b.textContent; b.textContent = 'Copied'; setTimeout(function () { b.textContent = t; }, 1400); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
  });

  // ── watching an order
  function startWatching() {
    stop();
    var left = function () { return Math.max(0, S.order.expiresAt - Math.floor(Date.now() / 1000)); };
    var paintTimer = function () { var s = left(); $('cTimer').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
    paintTimer(); S.tick = setInterval(paintTimer, 1000);
    S.poll = setInterval(refresh, 5000);
    refresh();
  }
  async function refresh() {
    if (!S.order) return;
    var r = await Vane.api('GET', '/api/billing/order?id=' + encodeURIComponent(S.order.id), undefined, { noRedirect: true });
    if (!r.ok) return;
    S.order = r.data.order;
    var st = S.order.status;
    if (st === 'paid') return done();
    if (st === 'failed') { stop(); return closed('The payment did not go through', 'Nothing was charged. You can try again, or choose another way to pay.'); }
    if (st === 'canceled') { stop(); return closed('This order was canceled', 'You can start a new one.'); }
    if (st === 'expired' && S.order.method === 'monobank') { stop(); return closed('The payment window closed', 'No money was taken. Start again to get a new payment page.'); }
    if (st === 'expired') $('cStatus').textContent = 'Time is up, still watching';
  }
  function done() {
    stop();
    var id = S.order.planId;
    $('doneText').textContent = S.order.planName + ' is now active on your account.';
    var studio = id === 'video', stats = id === 'analytics';
    $('doneLink').setAttribute('href', Vane.productUrl(stats ? 'analytics' : studio ? 'studio' : 'post'));
    $('doneLink').textContent = stats ? 'Open Vane Analytics' : studio ? 'Open Vane Studio' : 'Open Vane Post';
    show('stepDone');
    history.replaceState(null, '', '/checkout?order=' + S.order.id);
  }
  function closed(title, text) { $('closedTitle').textContent = title; $('closedText').textContent = text; show('stepClosed'); }
  $('again').addEventListener('click', function () { S.order = null; history.replaceState(null, '', '/checkout?plan=' + encodeURIComponent(S.plan.id)); show('stepForm'); });

  // ── events
  $('iMonth').addEventListener('click', function () { S.interval = 'month'; renderPlan(); });
  $('iYear').addEventListener('click', function () { S.interval = 'year'; renderPlan(); });
  $('mCard').addEventListener('click', function () { if (!this.disabled) { S.method = 'monobank'; paintMethod(); } });
  $('mCrypto').addEventListener('click', function () { if (!this.disabled) { S.method = 'crypto'; paintMethod(); } });
  document.addEventListener('click', function (e) { var b = e.target.closest('[data-asset]'); if (b) { S.asset = b.getAttribute('data-asset'); paintMethod(); } });

  // ── start
  (async function init() {
    var me = await Vane.api('GET', '/api/auth/me', undefined, { noRedirect: true });
    if (!me.ok) return Vane.go('/login?next=' + encodeURIComponent('/checkout' + location.search));
    var names = typeof Intl !== 'undefined' && Intl.DisplayNames ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;
    $('fCountry').innerHTML = '<option value="">Choose…</option>' + COUNTRIES.map(function (c) { var n = names ? names.of(c) : c; return [c, n]; })
      .sort(function (a, b) { return a[1].localeCompare(b[1]); }).map(function (x) { return '<option value="' + x[0] + '">' + x[1].replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</option>'; }).join('');
    if (me.data && me.data.user && me.data.user.email) $('fEmail').value = me.data.user.email;
    if (me.data && me.data.user && me.data.user.name) $('fName').value = me.data.user.name;

    var cfg = await Vane.api('GET', '/api/billing/config');
    S.cfg = cfg.ok ? cfg.data : { methods: { monobank: false, crypto: false } };
    if (S.cfg.preview) {
      var bar = document.createElement('div');
      bar.className = 'mb-5 rounded-xl border border-amber-300/25 bg-amber-400/10 px-4 py-3 text-sm text-amber-200';
      bar.textContent = 'Preview mode: only you can see this page. Pay shows an error because payment is not connected yet.';
      $('main').insertBefore(bar, $('main').firstChild);
    }

    var orderId = q.get('order');
    if (orderId) {
      var o = await Vane.api('GET', '/api/billing/order?id=' + encodeURIComponent(orderId), undefined, { noRedirect: true });
      if (!o.ok) return fatal('We could not find this order.');
      S.order = o.data.order;
      var pr = await Vane.api('GET', '/api/billing/plan?id=' + encodeURIComponent(S.order.planId));
      if (pr.ok) { S.plan = pr.data.plan; S.interval = S.order.interval; }
      $('loading').classList.add('hidden'); $('main').classList.remove('hidden');
      if (S.plan) { renderPlan(); renderMethods(); }
      if (S.order.status === 'paid') return done();
      if (S.order.method === 'crypto' && S.order.crypto) return showCrypto();
      if (S.order.status === 'pending') { show('stepWait'); if (S.order.payUrl) { $('wRetry').setAttribute('href', S.order.payUrl); $('wRetry').classList.remove('hidden'); } startWatching(); return; }
      return closed('This order is closed', 'Start a new one to buy the plan.');
    }

    var id = q.get('plan');
    if (!id && S.cfg.preview) {
      var list = await Vane.api('GET', '/api/plans');
      var first = list.ok && list.data.plans.filter(function (p) { return p.kind === 'plan' && p.priceCents > 0; })[0];
      id = first ? first.id : 'pro';
      history.replaceState(null, '', '/checkout?plan=' + encodeURIComponent(id));
    }
    if (!id) return Vane.go('/pricing');
    var r = await Vane.api('GET', '/api/billing/plan?id=' + encodeURIComponent(id));
    if (!r.ok) return fatal(r.error || 'This plan does not exist.');
    S.plan = r.data.plan;
    if (!S.cfg.methods.monobank && !S.cfg.methods.crypto) return fatal('Online payment is not open yet. Please check back soon.');
    if (!S.plan.buyable) return fatal(S.cfg.methods.monobank || S.cfg.methods.crypto ? 'This plan is not on sale yet.' : 'Online payment is not open yet. Please check back soon.');
    if (q.get('interval') === 'year' && (S.plan.yearlyPriceCents || S.plan.interval === 'year')) S.interval = 'year';
    $('loading').classList.add('hidden'); $('main').classList.remove('hidden');
    renderPlan(); renderMethods(); show('stepForm');
  })();
})();
