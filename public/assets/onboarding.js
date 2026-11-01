/* Onboarding checklist: the card at the top of the dashboard that walks a new person to their first post.
   The steps are read from the account by GET /api/onboarding (functions/api/lib/onboarding.ts), so they tick themselves.
   When the last one is done the card shows a short burst of confetti once (canvas-confetti, served from /assets/vendor),
   then POSTs "celebrated" so it never comes back; the cross closes it for good ("dismiss"). */
(function () {
  'use strict';

  var CONFETTI_SRC = '/assets/vendor/canvas-confetti-1.9.3.js';
  var POLL_MS = 45000;

  var STEPS = {
    channel:     { title: 'Connect your first channel', hint: 'Telegram, Bluesky, Mastodon and more. It takes a minute.', cta: 'Connect', go: function () { var b = document.getElementById('connectBtn'); if (b) { b.scrollIntoView({ block: 'center', behavior: 'smooth' }); b.click(); } } },
    key:         { title: 'Create an API key', hint: 'The key lets Claude, Notion, Obsidian, Make or your own scripts post for you.', cta: 'Create key', go: function () { location.hash = '#api'; } },
    post:        { title: 'Publish your first post', hint: 'From the editor, or by asking Claude or Notion. It counts once the post has been sent.', cta: 'Write a post', go: function () { if (location.hash && location.hash !== '#create') location.hash = '#create'; var t = document.getElementById('text'); if (t) { t.scrollIntoView({ block: 'center', behavior: 'smooth' }); t.focus({ preventScroll: true }); } } },
    integration: { title: 'Connect an integration', hint: 'Claude, Notion, Obsidian, Make… post without opening the dashboard.', links: [['Claude', '#claude'], ['Notion', '#notion'], ['Obsidian', '#obsidian']] }
  };
  var ORDER = ['channel', 'key', 'post', 'integration'];

  var root = document.getElementById('onboarding');
  if (!root) return;
  var state = null, timer = 0, celebrating = false, confettiLoad = null, lastSig = '';

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function reduced() { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }

  var CHECK = '<svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

  function render() {
    var s = state, allDone = s.done === s.total;
    var firstOpen = null;
    for (var i = 0; i < ORDER.length; i++) { if (!isDone(ORDER[i])) { firstOpen = ORDER[i]; break; } }
    var pct = Math.round((s.done / s.total) * 100);

    var rows = ORDER.map(function (id) {
      var def = STEPS[id], done = isDone(id), next = id === firstOpen;
      var action = '';
      if (!done && def.links) {
        action = '<span class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">' + def.links.map(function (l) { return '<a href="' + esc(l[1]) + '" class="underline underline-offset-2 hover:text-white">' + esc(l[0]) + '</a>'; }).join('') + '</span>';
      } else if (!done && def.cta) {
        action = '<button type="button" data-go="' + id + '" class="btn ' + (next ? 'btn-white' : 'btn-ghost') + ' btn-sm shrink-0">' + esc(def.cta) + '</button>';
      }
      return '<li class="flex items-start gap-3 rounded-2xl px-3 py-2.5 ' + (next ? 'bg-white/[0.05] ring-1 ring-white/10' : '') + '">' +
        '<span class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ' + (done ? 'bg-emerald-400 text-black' : 'border border-white/25 text-transparent') + '">' + (done ? CHECK : '') + '</span>' +
        '<span class="min-w-0 flex-1"><span class="block text-sm font-medium ' + (done ? 'text-white/45 line-through decoration-white/20' : 'text-white') + '">' + esc(def.title) + '<span class="sr-only">' + (done ? ' (done)' : '') + '</span></span>' +
        (done ? '' : '<span class="mt-0.5 block text-xs leading-relaxed text-white/50">' + esc(def.hint) + '</span>') + '</span>' +
        (action ? '<span class="shrink-0 self-center">' + action + '</span>' : '') + '</li>';
    }).join('');

    root.innerHTML =
      '<div class="flex items-start justify-between gap-3">' +
        '<div class="min-w-0"><h2 id="onboardingTitle" class="text-lg font-semibold tracking-tight">' + (allDone ? 'You are all set 🎉' : 'Get started with Vane') + '</h2>' +
        '<p class="mt-1 text-xs text-white/45" id="onboardingSub">' + (allDone ? 'Every step is done. Your first post is out and Vane is connected.' : esc(s.done + ' of ' + s.total) + ' steps done. The last one is your first published post.') + '</p></div>' +
        '<button type="button" data-close class="rounded-full p-1.5 text-white/40 hover:bg-white/10 hover:text-white" aria-label="Hide the checklist"><svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' +
      '</div>' +
      '<div class="mt-4 h-1.5 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuemin="0" aria-valuemax="' + s.total + '" aria-valuenow="' + s.done + '" aria-labelledby="onboardingTitle">' +
        '<div class="h-full rounded-full bg-gradient-to-r from-violet-400 to-emerald-400 transition-[width] duration-700 motion-reduce:transition-none" style="width:' + pct + '%"></div></div>' +
      '<ul class="mt-4 space-y-1">' + rows + '</ul>' +
      (allDone ? '<div class="mt-3 flex justify-end"><button type="button" data-close class="btn btn-white btn-sm">Close</button></div>' : '');
    root.hidden = false;
    root.setAttribute('aria-live', 'polite');
  }

  function isDone(id) { for (var i = 0; i < state.steps.length; i++) { if (state.steps[i].id === id) return state.steps[i].done; } return false; }

  function loadConfetti() {
    if (window.confetti) return Promise.resolve(window.confetti);
    if (!confettiLoad) {
      confettiLoad = new Promise(function (resolve, reject) {
        var el = document.createElement('script');
        el.src = CONFETTI_SRC; el.async = true;
        el.onload = function () { resolve(window.confetti); };
        el.onerror = function () { reject(new Error('confetti did not load')); };
        document.head.appendChild(el);
      });
    }
    return confettiLoad;
  }

  /** Two bursts from the sides, then a soft shower: about a second and a half. Nothing for people who asked for less motion. */
  function celebrate() {
    if (reduced()) return Promise.resolve();
    return loadConfetti().then(function (confetti) {
      var base = { disableForReducedMotion: true, zIndex: 9999, colors: ['#a78bfa', '#34d399', '#f472b6', '#fbbf24', '#60a5fa'] };
      confetti(Object.assign({ particleCount: 70, angle: 60, spread: 65, origin: { x: 0, y: 0.75 } }, base));
      confetti(Object.assign({ particleCount: 70, angle: 120, spread: 65, origin: { x: 1, y: 0.75 } }, base));
      setTimeout(function () { confetti(Object.assign({ particleCount: 90, spread: 100, startVelocity: 38, origin: { x: 0.5, y: 0.6 } }, base)); }, 350);
    }).catch(function () { /* no confetti is not an error */ });
  }

  function apply(data) {
    if (!data || !data.ok) return;
    var sig = JSON.stringify([data.steps, data.hidden, data.celebrate]);
    state = data;
    if (celebrating || sig === lastSig) return;                     // the final card stays until the person closes it; an unchanged card is not redrawn
    lastSig = sig;
    if (data.hidden && !data.celebrate) { root.hidden = true; root.innerHTML = ''; stop(); return; }
    render();
    if (data.celebrate) {
      celebrating = true; stop();
      Vane.api('POST', '/api/onboarding', { action: 'celebrated' });
      celebrate();
    } else if (!timer) start();
  }

  function refresh() { return Vane.api('GET', '/api/onboarding').then(function (r) { apply(r.ok ? r.data : null); }); }
  function start() { if (!timer) timer = setInterval(function () { if (!document.hidden) refresh(); }, POLL_MS); }
  function stop() { if (timer) { clearInterval(timer); timer = 0; } }

  root.addEventListener('click', function (e) {
    var go = e.target.closest('[data-go]');
    if (go && STEPS[go.getAttribute('data-go')] && STEPS[go.getAttribute('data-go')].go) { STEPS[go.getAttribute('data-go')].go(); return; }
    if (e.target.closest('[data-close]')) {
      root.hidden = true; root.innerHTML = ''; stop(); celebrating = true;   // closed for this visit at once; the server remembers it
      Vane.api('POST', '/api/onboarding', { action: 'dismiss' });
    }
  });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && !celebrating) refresh(); });

  refresh();
})();
