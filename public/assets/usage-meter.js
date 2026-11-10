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

  /** only null (or missing) means "no limit": 0 MB is a limit, a plan that allows no files */
  function limited(u) { return u.limitBytes !== null && u.limitBytes !== undefined; }

  function html(u) {
    var used = Number(u.usedBytes) || 0, count = Number(u.count) || 0;
    var files = count + (count === 1 ? ' file' : ' files');
    if (!limited(u)) return '<div class="text-xs text-white/55">' + size(used) + ' used · ' + files + '</div>';
    var pct = u.limitBytes > 0 ? Math.min(100, Math.round(used / u.limitBytes * 100)) : (used > 0 ? 100 : 0);       // a plan of 0 MB is full from the start
    var base = /^(post|studio)\.vaneapp\.dev$/i.test(location.hostname) ? 'https://vaneapp.dev' : '';
    var hint = pct < 80 ? '' : '<p class="mt-2 text-xs text-white/55">' + (pct >= 100 ? 'The library is full. ' : 'Running low on room. ') + 'Delete files you no longer need' +
      (u.upgrade ? ', or <a class="underline underline-offset-2 hover:text-white" href="' + base + '/pricing">see the plans with more space</a>' : '') + '.</p>';
    return '<div class="flex items-baseline justify-between gap-3 text-xs"><span class="text-white/70">' + size(used) + ' of ' + size(u.limitBytes) + ' used</span><span class="text-white/45">' + files + '</span></div>' +
      '<div class="meter mt-2"><i style="width:' + pct + '%;background:' + (pct >= 90 ? '#f87171' : '#fff') + '"></i></div>' + hint;
  }

  function warn(box, u) {
    if (!u || !u.over || !limited(u) || !(Number(u.usedBytes) > u.limitBytes)) { box.classList.add('hidden'); box.innerHTML = ''; return; }   // nothing over any more (cleaned up, limit raised): no banner
    var day = new Date(u.over.deadline * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    box.innerHTML = '<a href="#library" class="block rounded-2xl border border-red-400/30 bg-red-500/15 px-4 py-3 text-sm text-red-100 transition-colors hover:bg-red-500/20">' +
      '<b class="font-semibold">Your library is over your plan: ' + size(u.usedBytes) + ' of ' + size(u.limitBytes) + '.</b> ' +
      'Your latest uploads will be removed on ' + day + ' to make room. Delete files you no longer need before then. <span class="underline underline-offset-2">Open the Library</span></a>';
    box.classList.remove('hidden');
  }

  function short(u) {
    var used = Number(u.usedBytes) || 0;
    return limited(u) ? size(used).replace(' MB', '') + ' / ' + size(u.limitBytes) : size(used);
  }

  function show(box) {
    return Vane.api('GET', '/api/library/usage').then(function (r) {
      if (!r.ok || !r.data || !r.data.usage) { box.classList.add('hidden'); return; }   // not set up, signed out, offline: show nothing rather than a wrong number
      box.innerHTML = html(r.data.usage);
      box.classList.remove('hidden');
    });
  }

  function check(box) {
    return Vane.api('GET', '/api/library/usage').then(function (r) { warn(box, r.ok && r.data ? r.data.usage : null); });
  }

  Vane.libraryUsage = { html: html, short: short, show: show, warn: warn, check: check };
})();
