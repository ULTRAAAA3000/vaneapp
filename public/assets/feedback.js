/**
 * Feedback & Roadmap board: the "Feedback / Vote for features" button in the corner of the dashboard.
 * Opens a dialog where people vote on which network or feature gets built next, and suggest their own.
 *
 * Data: GET /api/feedback (the ideas with votes), POST /api/feedback { action: 'vote' | 'create' }.
 * You answer ideas (planned / building / shipped), hide spam and add polls in /admin → Feedback.
 * Texts from the server are put into the page escaped.
 */
(function () {
  'use strict';
  var esc = Vane.esc;
  var KINDS = { network: 'Network', feature: 'Feature', bug: 'Bug', other: 'Other' };
  var FILTERS = { all: 'All', network: 'Networks', feature: 'Features', bug: 'Bugs', other: 'Other' };
  var STATUS = { planned: ['Planned', 'bg-sky-400/15 text-sky-300'], building: ['Building now', 'bg-amber-400/15 text-amber-300'], done: ['Shipped', 'bg-emerald-400/15 text-emerald-300'] };
  var S = { items: [], kind: 'all', sort: 'top', tab: 'vote', loaded: false, busy: false, limits: { title: 80, body: 500 }, unavailable: false };
  var dlg, btn;

  function build() {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'fbOpen';
    btn.className = 'fixed bottom-4 left-4 z-40 inline-flex items-center gap-2 rounded-full bg-white px-4 py-2.5 text-sm font-medium text-[#010101] shadow-xl shadow-black/40 transition hover:scale-[1.03] active:scale-[.98]';
    btn.innerHTML = '<span aria-hidden="true">💬</span><span class="sm:hidden">Feedback</span><span class="hidden sm:inline">Feedback / Vote for Features</span>';
    document.body.appendChild(btn);

    dlg = document.createElement('dialog');
    dlg.id = 'fbDialog';
    dlg.className = 'vane-dialog';
    dlg.setAttribute('aria-labelledby', 'fbTitle');
    dlg.innerHTML =
      '<div class="glass-d-strong max-h-[calc(100vh-2rem)] overflow-y-auto rounded-3xl p-6 shadow-2xl sm:p-8">' +
        '<div class="flex items-start justify-between gap-4">' +
          '<div><h2 id="fbTitle" class="text-xl font-semibold tracking-tight">What should we build next?</h2>' +
          '<p class="mt-1 text-xs leading-relaxed text-white/50">Vote for the networks and features you want. The most wanted ones get built first, and you can follow the progress right here.</p></div>' +
          '<button id="fbClose" type="button" class="icon-btn" aria-label="Close"><svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' +
        '</div>' +
        '<div class="mt-5 flex gap-1.5" role="tablist" aria-label="Feedback">' +
          '<button type="button" role="tab" data-fb-tab="vote" class="btn btn-sm">Vote</button>' +
          '<button type="button" role="tab" data-fb-tab="suggest" class="btn btn-sm">Suggest an idea</button>' +
        '</div>' +
        '<div id="fbVote" class="mt-4">' +
          '<div class="flex flex-wrap items-center gap-1.5" id="fbKinds"></div>' +
          '<div id="fbList" class="mt-3 space-y-2" aria-live="polite"></div>' +
        '</div>' +
        '<div id="fbSuggest" class="mt-4 hidden">' +
          '<div class="space-y-4">' +
            '<div><label class="lbl" for="fbKind">What is it about?</label>' +
              '<select id="fbKind" class="field"><option value="network">A network to add</option><option value="feature" selected>A feature</option><option value="bug">Something that does not work</option><option value="other">Something else</option></select></div>' +
            '<div><label class="lbl" for="fbName">Title</label><input id="fbName" class="field" maxlength="80" placeholder="e.g. Pinterest, or: Repeat a post every week" autocomplete="off" /></div>' +
            '<div><label class="lbl" for="fbBody">Details <span class="normal-case tracking-normal text-white/30">(optional)</span></label>' +
              '<textarea id="fbBody" class="field min-h-[6rem] resize-y" maxlength="500" placeholder="What would you use it for?"></textarea>' +
              '<div id="fbCount" class="mt-1 text-right text-[11px] text-white/35">0 / 500</div></div>' +
            '<div id="fbErr" role="alert" class="hidden rounded-xl border border-red-400/25 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-300"></div>' +
            '<button id="fbSend" type="button" class="btn btn-white w-full !py-3">Add to the board</button>' +
            '<p class="text-center text-[11px] text-white/35">Your idea is shown to other users without your name, and it starts with your vote.</p>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(dlg);

    btn.addEventListener('click', open);
    $('fbClose').addEventListener('click', function () { dlg.close(); });
    dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener('click', onClick);
    $('fbBody').addEventListener('input', function () { $('fbCount').textContent = $('fbBody').value.length + ' / ' + S.limits.body; });
    $('fbSend').addEventListener('click', send);
  }

  function $(id) { return document.getElementById(id); }

  function setTab(tab) {
    S.tab = tab;
    $('fbVote').classList.toggle('hidden', tab !== 'vote');
    $('fbSuggest').classList.toggle('hidden', tab !== 'suggest');
    Array.prototype.forEach.call(dlg.querySelectorAll('[data-fb-tab]'), function (b) {
      var on = b.getAttribute('data-fb-tab') === tab;
      b.className = 'btn btn-sm ' + (on ? 'btn-white' : 'btn-ghost');
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (tab === 'suggest') $('fbName').focus();
  }

  async function open() {
    if (!dlg.open) dlg.showModal();
    setTab(S.tab);
    if (!S.loaded) $('fbList').innerHTML = '<p class="py-6 text-center text-sm text-white/40">Loading…</p>';
    var r = await Vane.api('GET', '/api/feedback');
    if (!r.ok) { $('fbList').innerHTML = '<p class="py-6 text-center text-sm text-red-300">' + esc(r.error || 'Could not load the board.') + '</p>'; return; }
    S.items = r.data.items || [];
    S.unavailable = !!r.data.unavailable;
    if (r.data.limits) S.limits = r.data.limits;
    S.loaded = true;
    render();
  }

  function render() {
    var kinds = ['all'].concat(Object.keys(KINDS));
    $('fbKinds').innerHTML = kinds.map(function (k) {
      var on = S.kind === k;
      return '<button type="button" data-fb-kind="' + k + '" aria-pressed="' + on + '" class="rounded-full px-3 py-1 text-xs font-medium transition ' + (on ? 'bg-white text-[#010101]' : 'bg-white/[0.07] text-white/70 hover:bg-white/[0.12]') + '">' + FILTERS[k] + '</button>';
    }).join('') +
      '<button type="button" data-fb-sort="' + (S.sort === 'top' ? 'new' : 'top') + '" class="ml-auto text-xs text-white/50 underline underline-offset-2 hover:text-white">' + (S.sort === 'top' ? 'Most voted first' : 'Newest first') + '</button>';

    var list = S.items.filter(function (i) { return S.kind === 'all' || i.kind === S.kind; });
    list.sort(function (a, b) {
      var da = a.status === 'done' ? 1 : 0, db = b.status === 'done' ? 1 : 0;
      if (da !== db) return da - db;
      return S.sort === 'new' ? b.createdAt - a.createdAt : b.votes - a.votes || b.createdAt - a.createdAt;
    });

    if (S.unavailable) { $('fbList').innerHTML = '<p class="py-6 text-center text-sm text-white/45">The feedback board is not available yet. Please check back soon.</p>'; return; }
    if (!list.length) {
      $('fbList').innerHTML = '<div class="py-8 text-center"><p class="text-sm text-white/50">' + (S.items.length ? 'Nothing here yet.' : 'No ideas yet.') + '</p><button type="button" data-fb-tab="suggest" class="btn btn-white btn-sm mt-3">Suggest the first one</button></div>';
      return;
    }
    $('fbList').innerHTML = list.map(function (i) {
      var st = STATUS[i.status];
      var closed = i.status === 'done';
      return '<div id="fb-' + esc(i.id) + '" class="flex items-start gap-3 rounded-2xl bg-white/[0.04] p-3.5 ring-1 ring-white/5">' +
        '<button type="button" data-fb-vote="' + esc(i.id) + '"' + (closed ? ' disabled' : '') + ' aria-pressed="' + i.mine + '" aria-label="' + (i.mine ? 'Take back your vote for ' : 'Vote for ') + esc(i.title) + '" ' +
          'class="flex h-14 w-12 shrink-0 flex-col items-center justify-center rounded-xl text-xs font-semibold transition disabled:opacity-50 ' + (i.mine ? 'bg-white text-[#010101]' : 'bg-white/[0.07] text-white hover:bg-white/[0.14]') + '">' +
          '<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg><span class="mt-0.5 text-sm">' + i.votes + '</span></button>' +
        '<div class="min-w-0 flex-1"><div class="flex flex-wrap items-center gap-1.5"><span class="break-words text-sm font-medium">' + esc(i.title) + '</span>' +
          '<span class="rounded-full bg-white/[0.07] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-white/50">' + esc(KINDS[i.kind] || i.kind) + '</span>' +
          (st ? '<span class="rounded-full px-2 py-0.5 text-[10px] font-semibold ' + st[1] + '">' + st[0] + '</span>' : '') +
          (i.own ? '<span class="text-[10px] text-white/35">Yours</span>' : '') + '</div>' +
          (i.body ? '<p class="mt-1 whitespace-pre-line break-words text-xs leading-relaxed text-white/55">' + esc(i.body) + '</p>' : '') + '</div></div>';
    }).join('');
  }

  async function vote(id, el) {
    if (S.busy) return;
    S.busy = true; el.disabled = true;
    var r = await Vane.api('POST', '/api/feedback', { action: 'vote', id: id });
    S.busy = false;
    if (!r.ok) { Vane.toast('err', r.error); el.disabled = false; return; }
    S.items.forEach(function (i) { if (i.id === id) { i.mine = r.data.voted; i.votes = r.data.votes; } });
    render();
  }

  async function send() {
    if (S.busy) return;
    var err = $('fbErr'), title = $('fbName').value.trim();
    err.classList.add('hidden');
    if (title.length < 3) { err.textContent = 'Give the idea a short title (at least 3 characters).'; err.classList.remove('hidden'); $('fbName').focus(); return; }
    S.busy = true; $('fbSend').disabled = true;
    var r = await Vane.api('POST', '/api/feedback', { action: 'create', kind: $('fbKind').value, title: title, body: $('fbBody').value.trim() });
    S.busy = false; $('fbSend').disabled = false;
    if (!r.ok) {
      // the same idea is already there: take the person to it instead of leaving them with a dead end
      var dupId = r.data && r.data.itemId;
      if (dupId) { Vane.toast('err', r.error); S.kind = 'all'; setTab('vote'); await open(); var row = $('fb-' + dupId); if (row) row.scrollIntoView({ block: 'center' }); return; }
      err.textContent = r.error || 'Could not add the idea.'; err.classList.remove('hidden');
      return;
    }
    Vane.toast('ok', 'Thank you! Your idea is on the board and has your vote.');
    $('fbName').value = ''; $('fbBody').value = ''; $('fbCount').textContent = '0 / ' + S.limits.body;
    S.kind = 'all'; S.sort = 'new'; setTab('vote');
    await open();
  }

  function onClick(e) {
    var t = e.target.closest('[data-fb-tab],[data-fb-kind],[data-fb-sort],[data-fb-vote]');
    if (!t) return;
    if (t.hasAttribute('data-fb-tab')) setTab(t.getAttribute('data-fb-tab'));
    else if (t.hasAttribute('data-fb-kind')) { S.kind = t.getAttribute('data-fb-kind'); render(); }
    else if (t.hasAttribute('data-fb-sort')) { S.sort = t.getAttribute('data-fb-sort'); render(); }
    else if (t.hasAttribute('data-fb-vote')) vote(t.getAttribute('data-fb-vote'), t);
  }

  build();
})();
