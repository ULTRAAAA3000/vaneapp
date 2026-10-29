(function () {
  'use strict';
  var list = document.getElementById('snipList'), form = document.getElementById('snipForm');
  if (!list || !form) return;
  var items = [], limit = 5, editId = null;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  function expand(t) {
    var d = new Date();
    return t.replace(/\{date\}/gi, d.toLocaleDateString()).replace(/\{weekday\}/gi, d.toLocaleDateString(undefined, { weekday: 'long' }));
  }

  function card(x) {
    return '<article class="rounded-2xl border border-white/10 p-4">' +
      '<div class="flex flex-wrap items-center justify-between gap-2"><h3 class="text-sm font-semibold">' + esc(x.title) + '</h3>' +
      '<div class="flex gap-2"><button type="button" class="btn btn-white btn-sm" data-act="insert" data-id="' + x.id + '">Insert</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-act="edit" data-id="' + x.id + '">Edit</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-act="del" data-id="' + x.id + '">Delete</button></div></div>' +
      '<p class="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-white/70">' + esc(x.body.slice(0, 300)) + (x.body.length > 300 ? '…' : '') + '</p></article>';
  }

  function render() {
    $('snipCount').textContent = items.length + ' of ' + limit + ' used.';
    list.innerHTML = items.length ? items.map(card).join('') : '<p class="text-sm text-white/45">No snippets yet. Press “New snippet” to save your first one.</p>';
  }

  function openForm(x) {
    editId = x ? x.id : null;
    $('snipTitle').value = x ? x.title : '';
    $('snipBody').value = x ? x.body : '';
    form.classList.remove('hidden');
    $('snipTitle').focus();
  }
  function closeForm() { form.classList.add('hidden'); editId = null; }

  async function load() {
    var r = await Vane.api('GET', '/api/snippets');
    if (!r.ok) return;
    items = r.data.items; limit = r.data.limit;
    render();
  }

  $('snipNew').addEventListener('click', function () { openForm(null); });
  $('snipCancel').addEventListener('click', closeForm);
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var r = await Vane.api('POST', '/api/snippets', { id: editId, title: $('snipTitle').value, body: $('snipBody').value });
    if (!r.ok) { Vane.toast('err', r.error || 'Could not save.'); return; }
    closeForm();
    Vane.toast('ok', 'Snippet saved.');
    load();
  });

  list.addEventListener('click', async function (e) {
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var id = b.getAttribute('data-id'), x = items.filter(function (i) { return i.id === id; })[0];
    if (!x) return;
    var act = b.getAttribute('data-act');
    if (act === 'insert') {
      location.hash = '#create';
      setTimeout(function () { Vane.composer.insert(expand(x.body)); Vane.toast('ok', 'Inserted.'); }, 50);
    } else if (act === 'edit') {
      openForm(x);
    } else {
      var r = await Vane.api('POST', '/api/snippets', { action: 'delete', id: id });
      if (r.ok) load();
    }
  });

  document.addEventListener('vane:snippets', load);
})();
