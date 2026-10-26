(function () {
  'use strict';
  var list = document.getElementById('draftList'), btn = document.getElementById('draftBtn');
  if (!list || !btn) return;
  var items = [], currentId = null;
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  function card(d) {
    return '<article class="rounded-2xl border border-white/10 p-4">' +
      '<div class="flex flex-wrap items-center justify-between gap-2"><div class="text-xs uppercase tracking-widest text-white/40">' + new Date(d.updatedAt * 1000).toLocaleString() +
      (d.media ? ' · ' + esc(d.media.kind) : '') + '</div>' +
      '<div class="flex gap-2"><button type="button" class="btn btn-white btn-sm" data-act="edit" data-id="' + d.id + '">Continue</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-act="del" data-id="' + d.id + '">Delete</button></div></div>' +
      '<p class="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-white/85">' + esc(d.content.slice(0, 400)) + (d.content.length > 400 ? '…' : '') + '</p></article>';
  }

  async function load() {
    var r = await Vane.api('GET', '/api/drafts');
    if (!r.ok) return;
    items = r.data.items;
    list.innerHTML = items.length ? items.map(card).join('') : '<p class="text-sm text-white/45">No drafts. Press “Save draft” under the editor to keep an unfinished post.</p>';
  }

  btn.addEventListener('click', async function () {
    var st = Vane.composer.state();
    if (!st.text.trim() && !st.media) { Vane.toast('info', 'Write something first.'); return; }
    btn.disabled = true;
    var r = await Vane.api('POST', '/api/drafts', { id: currentId, content: st.text, channelIds: st.channelIds, media: st.media });
    btn.disabled = false;
    if (!r.ok) { Vane.toast('err', r.error || 'Could not save the draft.'); return; }
    currentId = r.data.id;
    Vane.toast('ok', 'Draft saved. We keep the last 5.');
  });

  list.addEventListener('click', async function (e) {
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var id = b.getAttribute('data-id');
    if (b.getAttribute('data-act') === 'edit') {
      var d = items.filter(function (x) { return x.id === id; })[0];
      if (!d) return;
      Vane.composer.load(d);
      currentId = id;
      location.hash = '#create';
    } else {
      var r = await Vane.api('POST', '/api/drafts', { action: 'delete', id: id });
      if (r.ok) { if (currentId === id) currentId = null; load(); }
    }
  });

  document.addEventListener('vane:drafts', load);
  document.addEventListener('vane:scheduled', function () {
    if (currentId) Vane.api('POST', '/api/drafts', { action: 'delete', id: currentId });
    currentId = null;
  });
})();
