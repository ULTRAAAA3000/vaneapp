(function () {
  'use strict';
  var list = document.getElementById('feedList'), form = document.getElementById('feedForm');
  if (!list || !form) return;
  var items = [], limit = 1, channels = [], defaultTemplate = '{title}\n\n{link}';
  var $ = function (id) { return document.getElementById(id); };
  var esc = Vane.esc;

  function chanName(id) {
    var c = channels.filter(function (x) { return x.id === id; })[0];
    return c ? c.name : 'a removed channel';
  }

  function card(f) {
    var status = !f.enabled ? '<span class="text-amber-300">Paused</span>' : f.lastError ? '<span class="text-amber-300">' + esc(f.lastError) + '</span>' : '<span class="text-emerald-300">Watching</span>';
    return '<article class="rounded-2xl border border-white/10 p-4">' +
      '<div class="flex flex-wrap items-start justify-between gap-2"><div class="min-w-0"><h3 class="truncate text-sm font-semibold">' + esc(f.title || f.url) + '</h3>' +
      '<p class="truncate text-xs text-white/45">' + esc(f.url) + '</p></div>' +
      '<div class="flex gap-2"><button type="button" class="btn btn-ghost btn-sm" data-act="toggle" data-id="' + esc(f.id) + '">' + (f.enabled ? 'Pause' : 'Resume') + '</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-act="del" data-id="' + esc(f.id) + '">Remove</button></div></div>' +
      '<p class="mt-2 text-xs text-white/60">' + status + ' · ' + f.postedCount + (f.delayMinutes === 0 ? ' saved as drafts · to ' : ' posted · to ') + f.channelIds.map(function (i) { return esc(chanName(i)); }).join(', ') + (f.delayMinutes === 0 ? ' · new items go to your Drafts' : ' · ' + f.delayMinutes + ' min after it appears') + '</p></article>';
  }

  function render() {
    $('feedCount').textContent = items.length + ' of ' + limit + ' used.';
    list.innerHTML = items.length ? items.map(card).join('') : '<p class="text-sm text-white/45">No feeds yet. Press “Follow a feed” and paste the address of a blog or a podcast.</p>';
  }

  function chips() {
    $('feedChannels').innerHTML = channels.map(function (c) {
      return '<label class="chip cursor-pointer"><input type="checkbox" class="mr-1.5" value="' + esc(c.id) + '"' + (c.isActive === false ? ' disabled' : '') + ' /><span>' + esc(c.name) + '</span></label>';
    }).join('') || '<p class="text-xs text-white/45">Connect a channel first.</p>';
  }

  async function load() {
    var a = await Vane.api('GET', '/api/channels');
    if (a.ok) { channels = a.data.channels.filter(function (c) { return c.isActive !== false; }); chips(); }
    var r = await Vane.api('GET', '/api/feeds');
    if (!r.ok) return;
    items = r.data.items; limit = r.data.limit; defaultTemplate = r.data.defaultTemplate;
    render();
  }

  $('feedNew').addEventListener('click', function () {
    form.classList.remove('hidden');
    $('feedTemplate').value = defaultTemplate;
    $('feedUrl').focus();
  });
  $('feedCancel').addEventListener('click', function () { form.classList.add('hidden'); });

  $('feedDraft').addEventListener('change', function () { $('feedDelayBox').classList.toggle('hidden', this.checked); });

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var ids = [].map.call($('feedChannels').querySelectorAll('input:checked'), function (i) { return i.value; });
    var btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    var r = await Vane.api('POST', '/api/feeds', { url: $('feedUrl').value.trim(), channelIds: ids, template: $('feedTemplate').value, delayMinutes: $('feedDraft').checked ? 0 : Number($('feedDelay').value) });
    btn.disabled = false;
    if (!r.ok) { Vane.toast('err', r.error || 'Could not follow the feed.'); return; }
    form.classList.add('hidden');
    $('feedUrl').value = '';
    $('feedDraft').checked = false; $('feedDelayBox').classList.remove('hidden');
    Vane.toast('ok', 'Following. ' + r.data.existingItems + ' existing items will not be used; only new ones.');
    load();
  });

  list.addEventListener('click', async function (e) {
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var id = b.getAttribute('data-id'), f = items.filter(function (i) { return i.id === id; })[0];
    if (!f) return;
    var r = b.getAttribute('data-act') === 'del'
      ? await Vane.api('DELETE', '/api/feeds/' + encodeURIComponent(id))
      : await Vane.api('PATCH', '/api/feeds/' + encodeURIComponent(id), { enabled: !f.enabled });
    if (!r.ok) { Vane.toast('err', r.error || 'Something went wrong.'); return; }
    load();
  });

  document.addEventListener('vane:feeds', load);
})();
