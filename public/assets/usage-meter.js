/**
 * Vane.libraryUsage — the "12.4 MB of 100 MB used · 9 files" line with its meter, the same wherever a file is added or picked:
 * the Library tab, the editor's upload box and the "choose from your library" dialog.
 *
 *   Vane.libraryUsage.html(usage)   markup; usage = { usedBytes, count, limitBytes, upgrade } as GET /api/library/assets and
 *                                   GET /api/library/usage return it
 *   Vane.libraryUsage.show(box)     fetches GET /api/library/usage and fills `box`; the box stays hidden when there is nothing to show
 *
 * `limitBytes` is null while the plan limits are not being enforced: then only what is used is shown, never a maximum that is not applied.
 * Only numbers come from the server; everything else here is fixed text.
 */
(function () {
  'use strict';

  function size(n) {                                   // 100 MB, not 100.0 MB; an empty library is 0 KB, a tiny file 1 KB
    if (n >= 1073741824) return Number((n / 1073741824).toFixed(1)) + ' GB';
    if (n >= 1048576) return Number((n / 1048576).toFixed(1)) + ' MB';
    return (n > 0 ? Math.max(1, Math.round(n / 1024)) : 0) + ' KB';
  }

  function html(u) {
    var used = Number(u.usedBytes) || 0, count = Number(u.count) || 0;
    var files = count + (count === 1 ? ' file' : ' files');
    if (!u.limitBytes) return '<div class="text-xs text-white/55">' + size(used) + ' used · ' + files + '</div>';
    var pct = Math.min(100, Math.round(used / u.limitBytes * 100));
    var base = /^(post|studio)\.vaneapp\.dev$/i.test(location.hostname) ? 'https://vaneapp.dev' : '';
    var hint = pct < 80 ? '' : '<p class="mt-2 text-xs text-white/55">' + (pct >= 100 ? 'The library is full. ' : 'Running low on room. ') + 'Delete files you no longer need' +
      (u.upgrade ? ', or <a class="underline underline-offset-2 hover:text-white" href="' + base + '/pricing">see the plans with more space</a>' : '') + '.</p>';
    return '<div class="flex items-baseline justify-between gap-3 text-xs"><span class="text-white/70">' + size(used) + ' of ' + size(u.limitBytes) + ' used</span><span class="text-white/45">' + files + '</span></div>' +
      '<div class="meter mt-2"><i style="width:' + pct + '%;background:' + (pct >= 90 ? '#f87171' : '#fff') + '"></i></div>' + hint;
  }

  function show(box) {
    return Vane.api('GET', '/api/library/usage').then(function (r) {
      if (!r.ok || !r.data || !r.data.usage) { box.classList.add('hidden'); return; }   // not set up, signed out, offline: show nothing rather than a wrong number
      box.innerHTML = html(r.data.usage);
      box.classList.remove('hidden');
    });
  }

  Vane.libraryUsage = { html: html, show: show };
})();
