(function () {
  'use strict';
  var list = document.getElementById('histList');
  if (!list) return;
  var items = [], maxPinned = 4;
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var TITLES = { generate: 'Post', plan: 'Week plan', winners: 'Like my best', repurpose: 'Series', ideas: 'Ideas', translate: 'Translation' };
  var DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  var many = function (it) { return it.tool === 'plan' || it.tool === 'repurpose' || it.tool === 'winners' || it.tool === 'ideas'; };
  var parts = function (it) { var r = it.result || {}; return it.tool === 'winners' || it.tool === 'ideas' ? (r.options || []).map(function (t, i) { return { label: (it.tool === 'ideas' ? 'Idea ' : 'Option ') + (i + 1), text: t }; }) : (r.items || []).map(function (x, i) { return { label: it.tool === 'plan' ? DAYS[x.day] || 'Day ' + (x.day + 1) : 'Post ' + (i + 1), text: x.text }; }); };

  function textBlock(t, id, i) {
    return '<p class="whitespace-pre-wrap rounded-xl border border-white/10 bg-[#1a1a1f] p-3 text-sm leading-relaxed text-white/90">' + esc(t) + '</p>' +
      '<div class="mt-2 flex gap-2"><button type="button" class="btn btn-ghost btn-sm" data-act="copy" data-id="' + id + '" data-i="' + i + '">Copy</button>' +
      '<button type="button" class="btn btn-white btn-sm" data-act="use" data-id="' + id + '" data-i="' + i + '">Use in editor</button></div>';
  }

  function card(it) {
    var r = it.result || {};
    var body = many(it)
      ? parts(it).map(function (x, i) { return '<div class="mt-3"><div class="mb-1 text-xs font-medium text-white/50">' + esc(x.label) + '</div>' + textBlock(x.text, it.id, i) + '</div>'; }).join('')
      : textBlock(r.text || '', it.id, 0);
    return '<article class="rounded-2xl border border-white/10 p-4">' +
      '<div class="flex flex-wrap items-center justify-between gap-2"><div class="text-xs uppercase tracking-widest text-white/40">' + (TITLES[it.tool] || esc(it.tool)) + ' · ' + new Date(it.createdAt * 1000).toLocaleString() + '</div>' +
      '<div class="flex gap-2"><button type="button" class="chip" aria-pressed="' + it.pinned + '" data-act="pin" data-id="' + it.id + '">' + (it.pinned ? 'Pinned' : 'Pin') + '</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-act="del" data-id="' + it.id + '">Delete</button></div></div>' +
      '<p class="mt-2 text-sm text-white/55">' + esc(it.prompt.slice(0, 160)) + '</p>' + body + '</article>';
  }

  function render() {
    list.innerHTML = items.length ? items.map(card).join('') : '<p class="text-sm text-white/45">Nothing here yet. Posts, plans and series written by AI will appear here.</p>';
  }

  async function load() {
    var r = await Vane.api('GET', '/api/ai/history');
    if (!r.ok) return;
    items = r.data.items;
    maxPinned = r.data.maxPinned;
    render();
  }

  list.addEventListener('click', async function (e) {
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var it = items.filter(function (x) { return x.id === b.getAttribute('data-id'); })[0];
    if (!it) return;
    var act = b.getAttribute('data-act'), i = Number(b.getAttribute('data-i') || 0);
    var text = many(it) ? (parts(it)[i] || {}).text : it.result.text;
    if (act === 'copy') {
      try { await navigator.clipboard.writeText(text); Vane.toast('ok', 'Copied.'); } catch (err) { Vane.toast('err', 'Could not copy.'); }
    } else if (act === 'use') {
      Vane.composer.set(text);
      location.hash = '#create';
    } else if (act === 'pin') {
      var r = await Vane.api('POST', '/api/ai/history', { action: it.pinned ? 'unpin' : 'pin', id: it.id });
      if (!r.ok) { Vane.toast('err', r.error || 'Could not pin.'); return; }
      load();
    } else if (act === 'del') {
      var d = await Vane.api('POST', '/api/ai/history', { action: 'delete', id: it.id });
      if (d.ok) load();
    }
  });

  document.addEventListener('vane:history', load);
  document.addEventListener('vane:ai', load);
  if (location.hash === '#ai' || location.hash === '#history') load();
})();
