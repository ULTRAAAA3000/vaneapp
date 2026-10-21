/* /app — AI tools of the post editor (backend: functions/api/ai). Free: Make it clean, hashtags. AI Pass: tone, hooks, CTAs, per-network versions, write from an idea, week plan. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var bar = $('aiBar'), panel = $('aiPanel');
  if (!bar || !panel || !window.Vane || !Vane.composer) return;
  var esc = Vane.esc;

  var A = { busy: false, ai: null, before: null };
  var TONES = [['professional', 'Professional'], ['viral', 'Viral / hook-driven'], ['friendly', 'Friendly'], ['tech', 'Tech / indie hacker']];
  var SPARK = '<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/></svg>';

  function ic(d) { return '<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>'; }
  var I = {
    pen: ic('<path d="M4 20l4-1 11-11a2.1 2.1 0 00-3-3L5 16l-1 4z"/>'),
    bolt: ic('<path d="M13 3L5 13h6l-1 8 8-10h-6z"/>'),
    smile: ic('<circle cx="12" cy="12" r="9"/><path d="M8.5 14a4 4 0 007 0M9 9.5h.01M15 9.5h.01"/>'),
    code: ic('<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>'),
    hook: ic('<path d="M7 4v9a5 5 0 0010 0v-1M17 8l0 4-3-2"/>'),
    arrow: ic('<path d="M5 12h14M13 6l6 6-6 6"/>'),
    split: ic('<path d="M6 4v6a4 4 0 004 4h8M18 10l0 8M15 15l3 3 3-3"/>'),
    spark: ic('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>'),
    cal: ic('<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>')
  };
  function group(title, items) {
    return '<div class="ai-group">' + esc(title) + '</div>' + items.map(function (t) {
      return '<button type="button" role="menuitem" class="ai-item" data-tool="' + t[0] + '"' + (t[1] ? ' data-tone="' + t[1] + '"' : '') + '>' +
        '<span class="ai-ico">' + t[4] + '</span>' +
        '<span class="min-w-0"><span class="ai-t">' + t[2] + '</span><span class="ai-d">' + t[3] + '</span></span></button>';
    }).join('');
  }

  bar.innerHTML =
    '<span id="aiCredits" class="mr-1 text-[11px] text-white/40"></span>' +
    '<button id="aiClean" type="button" class="btn btn-ghost btn-sm" title="Fix typos and grammar, add fitting emoji (free)">' + SPARK + ' Make it clean</button>' +
    '<button id="aiTags" type="button" class="btn btn-ghost btn-sm" title="Suggest hashtags (free)"># Hashtags</button>' +
    '<div class="relative">' +
      '<button id="aiMore" type="button" class="btn btn-ghost btn-sm" aria-haspopup="true" aria-expanded="false">AI Pass <span aria-hidden="true">▾</span></button>' +
      '<div id="aiMenu" class="ai-solid absolute right-0 top-full z-30 mt-2 hidden w-[19rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl" role="menu">' +
        '<div id="aiMenuHead" class="ai-head"></div>' +
        '<div class="p-1.5">' +
          group('Rewrite', [
            ['tone', 'professional', 'Professional', 'Clear and polished', I.pen],
            ['tone', 'viral', 'Viral', 'A hook-driven voice', I.bolt],
            ['tone', 'friendly', 'Friendly', 'Warm and personal', I.smile],
            ['tone', 'tech', 'Tech / indie hacker', 'Direct, builder voice', I.code]
          ]) +
          group('Ideas', [
            ['hook', '', 'Hook ideas', 'Options for the first line', I.hook],
            ['cta', '', 'Call to action', 'Ways to end the post', I.arrow],
            ['reformat', '', 'Version per channel', 'Fits each selected network', I.split]
          ]) +
          group('Create', [
            ['generate', '', 'Write from an idea', 'A full post from one line', I.spark],
            ['plan', '', 'Plan my week', 'A set of posts from a topic', I.cal]
          ]) +
        '</div>' +
      '</div>' +
    '</div>';
  var style = document.createElement('style');
  style.textContent = '.ai-solid{background:#131316;border:1px solid rgba(255,255,255,.14);box-shadow:0 18px 50px -12px rgba(0,0,0,.85)}' +
    '.ai-head{padding:.85rem .95rem .8rem;border-bottom:1px solid rgba(255,255,255,.08);background:#18181c}' +
    '.ai-group{padding:.65rem .65rem .25rem;font-size:.625rem;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.38)}' +
    '.ai-item{display:flex;align-items:center;gap:.7rem;width:100%;text-align:left;border:0;background:transparent;color:#fff;padding:.45rem .55rem;border-radius:.75rem;cursor:pointer}' +
    '.ai-item:hover,.ai-item:focus-visible{background:#202026;outline:0}' +
    '.ai-ico{display:flex;height:2rem;width:2rem;flex:none;align-items:center;justify-content:center;border-radius:.6rem;background:#23232a;color:#c4b5fd}' +
    '.ai-item:hover .ai-ico{background:#2c2c36}' +
    '.ai-t{display:block;font-size:.82rem;font-weight:500;line-height:1.2}' +
    '.ai-d{display:block;margin-top:.1rem;font-size:.7rem;color:rgba(255,255,255,.45);line-height:1.2}' +
    '.ai-meter{height:.35rem;border-radius:9999px;background:#2a2a31;overflow:hidden}' +
    '.ai-meter>i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#a78bfa,#60a5fa)}' +
    '.ai-card{background:#131316;border:1px solid rgba(255,255,255,.12);border-radius:1rem}' +
    '.ai-offer{background:linear-gradient(135deg,#1e1b3a,#14213d);border:1px solid rgba(167,139,250,.35);border-radius:1rem}' +
    '.ai-opt{display:block;width:100%;text-align:left;border:1px solid rgba(255,255,255,.12);background:#1a1a1f;color:#fff;font-size:.85rem;padding:.6rem .8rem;border-radius:.85rem;cursor:pointer;line-height:1.45}' +
    '.ai-opt:hover{background:#23232a;border-color:rgba(255,255,255,.24)}';
  document.head.appendChild(style);

  var menu = $('aiMenu'), more = $('aiMore');
  function setMenu(open) { menu.classList.toggle('hidden', !open); more.setAttribute('aria-expanded', String(open)); }
  more.addEventListener('click', function () { setMenu(menu.classList.contains('hidden')); });
  document.addEventListener('click', function (e) { if (!menu.classList.contains('hidden') && !e.target.closest('#aiMenu, #aiMore')) setMenu(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !menu.classList.contains('hidden')) { setMenu(false); more.focus(); } });

  function meter(left, total) {
    var pct = total > 0 ? Math.max(0, Math.min(100, Math.round(left / total * 100))) : 0;
    return '<div class="ai-meter" role="progressbar" aria-valuemin="0" aria-valuemax="' + total + '" aria-valuenow="' + left + '"><i style="width:' + pct + '%"></i></div>';
  }
  function menuHead() {
    var ai = A.ai, el = $('aiMenuHead');
    if (!el) return;
    if (!ai) { el.innerHTML = ''; return; }
    var left = ai.remaining, total = (ai.pass.active ? ai.pass.credits : 0) + (ai.limit || 0) + (ai.bonus || 0);
    el.innerHTML = '<div class="flex items-center justify-between gap-3"><span class="text-sm font-semibold">AI Pass</span>' +
      '<span class="text-xs ' + (ai.pass.active ? 'text-violet-300' : 'text-white/45') + '">' + (ai.pass.active ? 'Active' : 'Not active') + '</span></div>' +
      (left === null ? '<p class="mt-1.5 text-xs text-white/55">Unlimited AI credits.</p>' :
        '<div class="mt-2.5">' + meter(left, total) + '</div><p class="mt-1.5 text-xs text-white/55">' + left + ' of ' + total + ' credit' + (total === 1 ? '' : 's') + ' left</p>');
  }
  function credits() {
    var el = $('aiCredits'), ai = A.ai;
    menuHead();
    if (!ai || ai.remaining === null) { el.textContent = ''; banner(); return; }
    el.textContent = ai.remaining + ' AI credit' + (ai.remaining === 1 ? '' : 's') + ' left';
    banner();
  }

  // The card under the editor: the AI Pass offer, or the credits and the "when they run out" switch.
  var bn = $('aiBanner');
  function money(n) { return '$' + (Math.round(n * 1000) / 1000); }
  function banner() {
    var ai = A.ai;
    if (!ai || !bn) return;
    var html = '';
    var planCredits = ai.limit || 0;
    if (ai.offer && planCredits < ai.offer.credits) {
      html += '<div class="ai-offer mb-2 flex flex-wrap items-center justify-between gap-4 p-4">' +
        '<div class="flex min-w-0 items-start gap-3"><span class="ai-ico !h-9 !w-9 !bg-white/10">' + SPARK + '</span>' +
        '<div class="min-w-0"><div class="text-sm font-semibold">Get the Vane AI Pass for ' + money(ai.offer.priceUsd) + ' a ' + esc(ai.offer.interval === 'year' ? 'year' : 'month') + '</div>' +
        '<p class="mt-0.5 text-xs leading-relaxed text-white/65">' + ai.offer.credits + ' AI credits: tone, hooks, calls to action, a version for each channel, a post from an idea. Make it clean and hashtags stay free.' +
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
  if (bn) bn.addEventListener('click', async function (e) {
    if (e.target.closest('#aiBuy')) {
      var o = A.ai.offer;
      show('Vane AI Pass', '<p class="text-sm leading-relaxed text-white/80">' + money(o.priceUsd) + ' a ' + esc(o.interval === 'year' ? 'year' : 'month') + ' for ' + o.credits + ' AI credits on top of your plan. ' +
        (o.overageUsd ? 'Need more? Extra credits cost ' + money(o.overageUsd) + ' each, and only if you switch that on.' : '') + '</p>' +
        '<p class="mt-3 rounded-xl border border-amber-300/20 bg-amber-400/10 p-3 text-sm leading-relaxed text-amber-200">Online checkout is not open yet. For now the AI Pass is switched on by hand: it will appear here as soon as it is active on your account.</p>');
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
    clean: function (r, orig) { return compare('Make it clean', orig, r.text); },
    tone: function (r, orig) { return compare('New tone', orig, r.text); },
    generate: function (r) { return compare('Your post', null, r.text); },
    hashtags: function (r) {
      return shell('Hashtags', '<div class="flex flex-wrap gap-1.5">' + r.hashtags.map(function (h) { return '<button type="button" class="chip" data-act="tag" data-v="' + esc(h) + '" aria-pressed="false"><span>' + esc(h) + '</span></button>'; }).join('') +
        '</div><button type="button" data-act="alltags" class="btn btn-ghost btn-sm mt-3">Add all</button>');
    },
    hook: function (r) { return options('Pick an opening line', r.options, 'hook'); },
    cta: function (r) { return options('Pick a call to action', r.options, 'cta'); },
    reformat: function (r) {
      return shell('A version for each channel',
        '<div class="space-y-3">' + r.variants.map(function (v, i) {
          return '<div class="rounded-xl border border-white/10 bg-[#1a1a1f] p-3">' +
            '<div class="mb-1.5 flex items-center justify-between text-xs"><span class="font-medium text-white/80">' + esc(label(v.platform)) + '</span><span class="' + (v.length > v.limit ? 'text-red-300' : 'text-white/40') + '">' + v.length + ' / ' + v.limit + '</span></div>' +
            '<p class="whitespace-pre-wrap text-sm leading-relaxed text-white/85">' + esc(v.text) + '</p>' +
            '<button type="button" data-act="use" data-i="' + i + '" class="btn btn-ghost btn-sm mt-2.5">Use this text</button></div>';
        }).join('') + '</div><p class="mt-3 text-xs text-white/40">A post goes out with one text to all channels. Pick the version you want to send, or schedule the others one by one.</p>');
    },
    plan: function (r) {
      var days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
      return shell('Your week',
        '<div class="space-y-2">' + r.items.map(function (it, i) {
          return '<button type="button" class="ai-opt" data-act="use" data-i="' + i + '"><span class="mb-0.5 block text-[11px] font-medium uppercase tracking-widest text-white/40">' + days[it.day] + '</span>' + esc(it.text) + '</button>';
        }).join('') + '</div><p class="mt-3 text-xs text-white/40">Click a day to load its text into the editor.</p>');
    }
  };
  function label(p) { return { telegram: 'Telegram', linkedin: 'LinkedIn', bluesky: 'Bluesky', mastodon: 'Mastodon', threads: 'Threads', x: 'X', webhook: 'Webhook' }[p] || p; }
  function options(title, list, kind) {
    return shell(title, '<div class="space-y-2">' + list.map(function (o, i) { return '<button type="button" class="ai-opt" data-act="' + kind + '" data-i="' + i + '">' + esc(o) + '</button>'; }).join('') + '</div>');
  }
  function compare(title, before, after) {
    return shell(title,
      (before !== null ? '<div class="mb-2 text-[11px] font-medium uppercase tracking-widest text-white/35">Suggestion</div>' : '') +
      '<p class="whitespace-pre-wrap rounded-xl border border-white/10 bg-[#1a1a1f] p-3 text-sm leading-relaxed text-white/90">' + esc(after) + '</p>' +
      '<div class="mt-3 flex flex-wrap gap-2"><button type="button" data-act="apply" class="btn btn-white btn-sm">Replace my text</button>' +
      '<button type="button" data-act="close" class="btn btn-ghost btn-sm">Keep mine</button></div>');
  }

  // ───────────────────────── running a tool ─────────────────────────
  var TITLES = { clean: 'Make it clean', hashtags: 'Hashtags', tone: 'New tone', hook: 'Hook ideas', cta: 'Call-to-action ideas', reformat: 'Versions per channel', generate: 'Writing your post', plan: 'Planning your week' };
  var last = null;

  async function run(tool, tone) {
    if (A.busy) return;
    var text = Vane.composer.text().trim();
    if (!text) {
      Vane.toast('info', tool === 'generate' || tool === 'plan' ? 'Type a short idea or topic in the box first, then try again.' : 'Write some text first.');
      return;
    }
    var networks = Vane.composer.networks();
    if (tool === 'reformat' && !networks.length) { Vane.toast('info', 'Select at least one channel under “Publish to” first.'); return; }
    A.busy = true; setBusy(true); loading(TITLES[tool] || 'AI');
    var body = { tool: tool, text: text, networks: networks };
    if (tone) body.tone = tone;
    var r = await Vane.api('POST', '/api/ai', body);
    A.busy = false; setBusy(false);
    if (r.data && r.data.ai) { A.ai = r.data.ai; credits(); }
    if (!r.ok) { problem(TITLES[tool] || 'AI', r.error); return; }
    last = { tool: tool, data: r.data, orig: text };
    panel.innerHTML = RENDER[tool](r.data, text);
    panel.classList.remove('hidden');
  }
  function setBusy(b) { ['aiClean', 'aiTags', 'aiMore'].forEach(function (id) { $(id).disabled = b; }); }

  bar.addEventListener('click', function (e) {
    var item = e.target.closest('.ai-item');
    if (item) { setMenu(false); run(item.getAttribute('data-tool'), item.getAttribute('data-tone')); return; }
    if (e.target.closest('#aiClean')) run('clean');
    else if (e.target.closest('#aiTags')) run('hashtags');
  });

  panel.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (!b || !last) { if (b && b.getAttribute('data-act') === 'close') close(); return; }
    var act = b.getAttribute('data-act'), d = last.data, i = Number(b.getAttribute('data-i'));
    if (act === 'close') close();
    else if (act === 'apply') { applyText(d.text); applied(); }
    else if (act === 'undo') { if (A.before !== null) Vane.composer.set(A.before); close(); }
    else if (act === 'hook') { applyText(d.options[i] + '\n\n' + Vane.composer.text()); applied(); }
    else if (act === 'cta') { applyText(Vane.composer.text().replace(/\s+$/, '') + '\n\n' + d.options[i]); applied(); }
    else if (act === 'use') { applyText(last.tool === 'plan' ? d.items[i].text : d.variants[i].text); applied(); }
    else if (act === 'tag') {
      var t = Vane.composer.text();
      if (t.indexOf(b.getAttribute('data-v')) === -1) Vane.composer.set(t.replace(/\s+$/, '') + (/\n#\S+\s*$/.test(t) || /#\S+\s*$/.test(t) ? ' ' : '\n\n') + b.getAttribute('data-v'));
      b.setAttribute('aria-pressed', 'true');
    }
    else if (act === 'alltags') {
      var cur = Vane.composer.text(), add = d.hashtags.filter(function (h) { return cur.indexOf(h) === -1; });
      if (add.length) Vane.composer.set(cur.replace(/\s+$/, '') + '\n\n' + add.join(' '));
      close();
    }
  });

  // ───────────────────────── start: show the tools only when the server has AI ─────────────────────────
  Vane.api('GET', '/api/ai', undefined, { noRedirect: true }).then(function (r) {
    if (!r.ok || !r.data || !r.data.available) return;
    A.ai = r.data.ai; credits();
    bar.classList.remove('hidden'); bar.classList.add('flex');
  });
})();
