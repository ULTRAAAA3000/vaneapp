/* /app — AI in the editor (backend: functions/api/ai): the free Make it clean and Hashtags buttons, the credits card. The AI tab itself (assets/aistudio.js) is opened from the dashboard's tab row. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var bar = $('aiBar'), panel = $('aiPanel');
  if (!bar || !panel || !window.Vane || !Vane.composer) return;
  var esc = Vane.esc;

  var A = { busy: false, ai: null, before: null };
  var SPARK = '<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/></svg>';

  bar.innerHTML =
    '<span id="aiCredits" class="mr-1 text-[11px] text-white/40"></span>' +
    '<button id="aiClean" type="button" class="btn btn-ghost btn-sm" title="Fix typos and grammar, add fitting emoji (free)">' + SPARK + ' Make it clean</button>' +
    '<button id="aiTags" type="button" class="btn btn-ghost btn-sm" title="Suggest hashtags (free)"># Hashtags</button>';
  var style = document.createElement('style');
  style.textContent = '.ai-solid{background:#131316;border:1px solid rgba(255,255,255,.14);box-shadow:0 18px 50px -12px rgba(0,0,0,.85)}' +
    '.ai-ico{display:flex;height:2rem;width:2rem;flex:none;align-items:center;justify-content:center;border-radius:.6rem;background:#23232a;color:#c4b5fd}' +
    '.ai-meter{height:.35rem;border-radius:9999px;background:#2a2a31;overflow:hidden}' +
    '.ai-meter>i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#a78bfa,#60a5fa)}' +
    '.ai-card{background:#131316;border:1px solid rgba(255,255,255,.12);border-radius:1rem}' +
    '.ai-offer{background:linear-gradient(135deg,#1e1b3a,#14213d);border:1px solid rgba(167,139,250,.35);border-radius:1rem}' +
    '.ai-opt{display:block;width:100%;text-align:left;border:1px solid rgba(255,255,255,.12);background:#1a1a1f;color:#fff;font-size:.85rem;padding:.6rem .8rem;border-radius:.85rem;cursor:pointer;line-height:1.45}' +
    '.ai-opt:hover{background:#23232a;border-color:rgba(255,255,255,.24)}' +
    '.ai-tool{display:flex;align-items:flex-start;gap:.7rem;width:100%;text-align:left;border:1px solid rgba(255,255,255,.1);background:#16161a;color:#fff;padding:.7rem .8rem;border-radius:.9rem;cursor:pointer}' +
    '.ai-tool:hover{background:#1e1e24;border-color:rgba(255,255,255,.22)}' +
    '.ai-tool[aria-pressed="true"]{border-color:rgba(167,139,250,.7);background:#1d1a33}' +
    '.ai-tool:disabled{opacity:.5;cursor:default}' +
    '.ai-t{display:block;font-size:.85rem;font-weight:500;line-height:1.2}' +
    '.ai-d{display:block;margin-top:.15rem;font-size:.72rem;color:rgba(255,255,255,.5);line-height:1.3}';
  document.head.appendChild(style);

  function meter(left, total) {
    var pct = total > 0 ? Math.max(0, Math.min(100, Math.round(left / total * 100))) : 0;
    return '<div class="ai-meter" role="progressbar" aria-valuemin="0" aria-valuemax="' + total + '" aria-valuenow="' + left + '"><i style="width:' + pct + '%"></i></div>';
  }
  function credits() {
    var ai = A.ai, text = !ai || ai.remaining === null ? '' : ai.remaining + ' AI credit' + (ai.remaining === 1 ? '' : 's') + ' left';
    ['aiCredits', 'aiCredits2'].forEach(function (id) { if ($(id)) $(id).textContent = text; });
    banner();
  }

  // The card under the editor: the AI Pass offer, or the credits and the "when they run out" switch.
  function money(n) { return '$' + (Math.round(n * 1000) / 1000); }
  function banner() {
    var ai = A.ai, bn = $('aiBanner');
    if (!ai || !bn) return;
    var html = '';
    var planCredits = ai.limit || 0;
    if (ai.offer && planCredits < ai.offer.credits) {
      html += '<div class="ai-offer mb-2 flex flex-wrap items-center justify-between gap-4 p-4">' +
        '<div class="flex min-w-0 items-start gap-3"><span class="ai-ico !h-9 !w-9 !bg-white/10">' + SPARK + '</span>' +
        '<div class="min-w-0"><div class="text-sm font-semibold">Get the Vane AI Pass for ' + money(ai.offer.priceUsd) + ' a ' + esc(ai.offer.interval === 'year' ? 'year' : 'month') + '</div>' +
        '<p class="mt-0.5 text-xs leading-relaxed text-white/65">' + ai.offer.credits + ' AI credits: your own voice, posts like your best ones, a week planned and queued, a version for each channel. Make it clean and hashtags stay free.' +
        (ai.remaining ? ' You have ' + ai.remaining + ' credit' + (ai.remaining === 1 ? '' : 's') + ' left now.' : '') + '</p></div></div>' +
        '<button type="button" id="aiBuy" class="btn btn-white btn-sm shrink-0">Buy AI Pass · ' + money(ai.offer.priceUsd) + '</button></div>';
    }
    if (ai.remaining !== null || ai.extra.rateUsd !== null) {
      var parts = [];
      if (ai.pass.active) parts.push('AI Pass: ' + ai.pass.remaining + ' of ' + ai.pass.credits + ' left this month');
      if (ai.limit !== null) parts.push('plan: ' + Math.max(ai.limit - ai.used, 0) + ' of ' + ai.limit + ' left');
      if (ai.bonus) parts.push('extra from us: ' + ai.bonus);
      var total = (ai.pass.active ? ai.pass.credits : 0) + (ai.limit || 0) + (ai.bonus || 0);
      html += '<div class="ai-card p-4"><div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">' +
        '<div class="min-w-[12rem] flex-1"><div class="text-sm font-semibold">' + (ai.remaining === null ? 'AI credits' : ai.remaining + ' AI credit' + (ai.remaining === 1 ? '' : 's') + ' left') + '</div>' +
        (ai.remaining !== null && total > 0 ? '<div class="mt-2">' + meter(ai.remaining, total) + '</div>' : '') +
        (parts.length ? '<div class="mt-2 text-xs text-white/50">' + esc(parts.join(' · ')) + '</div>' : '') + '</div>';
      if (ai.extra.rateUsd !== null) {
        html += '<div class="shrink-0"><div class="mb-1.5 text-[11px] font-medium uppercase tracking-widest text-white/40">When credits run out</div>' +
          '<div class="flex flex-wrap items-center gap-2" role="group" aria-label="When AI credits run out">' +
          '<button type="button" class="chip" data-extra="0" aria-pressed="' + (!ai.extra.enabled) + '"><span>Stop</span></button>' +
          '<button type="button" class="chip" data-extra="1" aria-pressed="' + ai.extra.enabled + '"><span>Pay ' + money(ai.extra.rateUsd) + ' per credit</span></button></div></div>';
      }
      html += '</div>' + (ai.extra.rateUsd !== null ? '<p class="mt-3 border-t border-white/10 pt-3 text-xs leading-relaxed text-white/45">' + (ai.extra.enabled ? 'Extra credits are billed per use at ' + money(ai.extra.rateUsd) + ' each. The same switch applies to extra posts over your plan.' : 'Nothing is charged: when your credits run out, AI requests are refused.') + '</p>' : '') + '</div>';
    }
    bn.innerHTML = html;
    bn.classList.toggle('hidden', !html);
  }
  document.addEventListener('click', async function (e) {
    if (!e.target.closest('#aiBanner')) return;
    if (e.target.closest('#aiBuy')) {
      var o = A.ai.offer;
      var offer = function () {
        show('Vane AI Pass', '<p class="text-sm leading-relaxed text-white/80">' + money(o.priceUsd) + ' a ' + esc(o.interval === 'year' ? 'year' : 'month') + ' for ' + o.credits + ' AI credits on top of your plan. ' +
          (o.overageUsd ? 'Need more? Extra credits cost ' + money(o.overageUsd) + ' each, and only if you switch that on.' : '') + '</p>' +
          '<p class="mt-3 rounded-xl border border-amber-300/20 bg-amber-400/10 p-3 text-sm leading-relaxed text-amber-200">Online checkout is not open yet. For now the AI Pass is switched on by hand: it will appear here as soon as it is active on your account.</p>');
      };
      var r = await Vane.api('GET', '/api/billing/plan?id=ai-pass');
      if (r.ok && r.data.plan && r.data.plan.buyable) Vane.go((/^(post|studio)\.vaneapp\.dev$/i.test(location.hostname) ? 'https://vaneapp.dev' : '') + '/checkout?plan=ai-pass');
      else offer();
      return;
    }
    var b = e.target.closest('[data-extra]');
    if (!b) return;
    var on = b.getAttribute('data-extra') === '1';
    if (on === A.ai.extra.enabled) return;
    var r = await Vane.api('POST', '/api/usage/overage', { enabled: on });
    if (!r.ok) { Vane.toast('err', r.error); return; }
    A.ai = r.data.ai; credits();
    Vane.toast('ok', on ? 'Extra credits will be billed per use.' : 'Stopped: nothing is charged over your limit.');
  });

  // ───────────────────────── panel ─────────────────────────
  function shell(title, body) {
    return '<div class="ai-solid rounded-2xl p-4">' +
      '<div class="mb-3 flex items-center justify-between gap-3"><span class="text-xs font-semibold uppercase tracking-widest text-white/45">' + esc(title) + '</span>' +
      '<button type="button" data-act="close" class="icon-btn !h-7 !w-7" aria-label="Close">✕</button></div>' + body + '</div>';
  }
  function show(title, body) { panel.innerHTML = shell(title, body); panel.classList.remove('hidden'); }
  function close() { panel.classList.add('hidden'); panel.innerHTML = ''; A.before = null; }
  function loading(label) { show(label, '<div class="flex items-center gap-2.5 text-sm text-white/60"><span class="spinner"></span> Working…</div>'); }
  function problem(title, msg) { show(title, '<p class="text-sm text-red-300">' + esc(msg) + '</p>'); }

  function applyText(t) {
    A.before = Vane.composer.text();
    Vane.composer.set(t);
  }
  function applied() {
    show('Applied', '<p class="text-sm text-white/70">Done. <button type="button" data-act="undo" class="underline underline-offset-2 hover:text-white">Undo</button></p>');
  }

  var RENDER = {
    clean: function (r) { return compare('Make it clean', r.text); },
    hashtags: function (r) {
      return shell('Hashtags', '<div class="flex flex-wrap gap-1.5">' + r.hashtags.map(function (h) { return '<button type="button" class="chip" data-act="tag" data-v="' + esc(h) + '" aria-pressed="false"><span>' + esc(h) + '</span></button>'; }).join('') +
        '</div><button type="button" data-act="alltags" class="btn btn-ghost btn-sm mt-3">Add all</button>');
    }
  };
  function compare(title, after) {
    return shell(title,
      '<div class="mb-2 text-[11px] font-medium uppercase tracking-widest text-white/35">Suggestion</div>' +
      '<p class="whitespace-pre-wrap rounded-xl border border-white/10 bg-[#1a1a1f] p-3 text-sm leading-relaxed text-white/90">' + esc(after) + '</p>' +
      '<div class="mt-3 flex flex-wrap gap-2"><button type="button" data-act="apply" class="btn btn-white btn-sm">Replace my text</button>' +
      '<button type="button" data-act="close" class="btn btn-ghost btn-sm">Keep mine</button></div>');
  }

  var TITLES = { clean: 'Make it clean', hashtags: 'Hashtags' };
  var last = null;

  async function run(tool) {
    if (A.busy) return;
    var text = Vane.composer.text().trim();
    if (!text) { Vane.toast('info', 'Write some text first.'); return; }
    A.busy = true; setBusy(true); loading(TITLES[tool]);
    var r = await Vane.api('POST', '/api/ai', { tool: tool, text: text, networks: Vane.composer.networks() });
    A.busy = false; setBusy(false);
    if (r.data && r.data.ai) { A.ai = r.data.ai; credits(); }
    if (!r.ok) { problem(TITLES[tool], r.error); return; }
    last = { tool: tool, data: r.data };
    panel.innerHTML = RENDER[tool](r.data);
    panel.classList.remove('hidden');
  }
  function setBusy(b) { ['aiClean', 'aiTags'].forEach(function (id) { $(id).disabled = b; }); }

  bar.addEventListener('click', function (e) {
    if (e.target.closest('#aiClean')) run('clean');
    else if (e.target.closest('#aiTags')) run('hashtags');
  });

  panel.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (!b || !last) { if (b && b.getAttribute('data-act') === 'close') close(); return; }
    var act = b.getAttribute('data-act'), d = last.data;
    if (act === 'close') close();
    else if (act === 'apply') { applyText(d.text); applied(); }
    else if (act === 'undo') { if (A.before !== null) Vane.composer.set(A.before); close(); }
    else if (act === 'tag') {
      var t = Vane.composer.text();
      if (t.indexOf(b.getAttribute('data-v')) === -1) Vane.composer.set(t.replace(/\s+$/, '') + (/#\S+\s*$/.test(t) ? ' ' : '\n\n') + b.getAttribute('data-v'));
      b.setAttribute('aria-pressed', 'true');
    }
    else if (act === 'alltags') {
      var cur = Vane.composer.text(), add = d.hashtags.filter(function (h) { return cur.indexOf(h) === -1; });
      if (add.length) Vane.composer.set(cur.replace(/\s+$/, '') + '\n\n' + add.join(' '));
      close();
    }
  });

  document.addEventListener('vane:aiupdate', function (e) { if (e.detail) { A.ai = e.detail; credits(); } });

  // ───────────────────────── start: show the tools only when the server has AI ─────────────────────────
  Vane.api('GET', '/api/ai', undefined, { noRedirect: true }).then(function (r) {
    if (!r.ok || !r.data || !r.data.available) return;
    A.ai = r.data.ai; credits();
    bar.classList.remove('hidden'); bar.classList.add('flex');
    document.dispatchEvent(new CustomEvent('vane:aiready', { detail: r.data }));
  });
})();
