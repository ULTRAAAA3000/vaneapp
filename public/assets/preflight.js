(function () {
  'use strict';
  var box = document.getElementById('preflight');
  if (!box || !window.Vane) return;
  var esc = Vane.esc;

  function when(t) {
    try { return new Date(t * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
  }

  function render(list) {
    if (!list.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.innerHTML = list.map(function (p) {
      return '<div class="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-300/25 bg-amber-300/[0.07] px-4 py-3">' +
        '<div class="min-w-0"><p class="text-sm font-semibold text-amber-200">' + esc(p.name) + ': ' + p.postCount + (p.postCount === 1 ? ' post' : ' posts') + ' may not go out</p>' +
        '<p class="mt-0.5 text-xs leading-relaxed text-white/60">' + esc(p.message) + ' First one: ' + esc(when(p.firstAt)) + '.</p></div>' +
        (p.reconnect ? '<button type="button" class="btn btn-white btn-sm shrink-0" data-net="' + esc(p.platform) + '">Reconnect</button>' : '') + '</div>';
    }).join('');
    box.classList.remove('hidden');
  }

  var busy = false;
  function load() {
    if (busy || document.hidden) return;
    busy = true;
    Vane.api('GET', '/api/posts/preflight').then(function (r) {
      busy = false;
      if (r.ok) render(r.data.problems || []);
    }, function () { busy = false; });
  }

  box.addEventListener('click', function (e) {
    var b = e.target.closest('[data-net]');
    if (b && Vane.openConnect) Vane.openConnect(b.getAttribute('data-net'));
  });

  load();
  setInterval(load, 60000);
  document.addEventListener('visibilitychange', load);
  document.addEventListener('vane:posts-changed', load);
})();
