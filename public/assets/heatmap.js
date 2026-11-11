(function () {
  'use strict';
  var WEEKS = 53, DAY = 86400000;
  var SHADES = ['rgba(255,255,255,.06)', 'rgba(52,211,153,.28)', 'rgba(52,211,153,.5)', 'rgba(52,211,153,.75)', 'rgb(52,211,153)'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function key(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function shift(d, days) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days); }

  function build(days, today) {
    var end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    var weekday = (end.getDay() + 6) % 7;
    var start = shift(end, -weekday - (WEEKS - 1) * 7);
    var columns = [], total = 0, max = 0;
    for (var w = 0; w < WEEKS; w++) {
      var col = [];
      for (var i = 0; i < 7; i++) {
        var d = shift(start, w * 7 + i), k = key(d), n = days[k] || 0;
        var future = d.getTime() > end.getTime();
        if (!future) { total += n; if (n > max) max = n; }
        col.push({ key: k, date: d, n: future ? 0 : n, future: future });
      }
      columns.push(col);
    }
    return { columns: columns, total: total, max: max };
  }

  function level(n, max) {
    if (!n || !max) return 0;
    return Math.min(4, Math.max(1, Math.ceil((n / max) * 4)));
  }

  function streaks(days, today) {
    var end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    var cur = 0, d = days[key(end)] ? end : shift(end, -1);
    while (days[key(d)]) { cur++; d = shift(d, -1); }
    var best = 0, run = 0, first = shift(end, -(WEEKS * 7));
    for (var t = first; t.getTime() <= end.getTime(); t = shift(t, 1)) {
      if (days[key(t)]) { run++; if (run > best) best = run; } else run = 0;
    }
    return { current: cur, best: Math.max(best, cur) };
  }

  function months(columns) {
    var out = [], last = -1;
    columns.forEach(function (col, i) {
      var m = col[0].date.getMonth();
      if (m !== last) { out.push({ at: i, name: MONTHS[m] }); last = m; }
    });
    if (out.length > 1 && out[1].at - out[0].at < 3) out.shift();
    return out;
  }

  window.Vane = window.Vane || {};
  Vane.heatmap = { build: build, level: level, streaks: streaks, months: months, key: key };

  var root = document.getElementById('activityCal');
  if (!root) return;
  var esc = Vane.esc;
  var fmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

  function render(days) {
    var today = new Date(), g = build(days, today), s = streaks(days, today);
    var cols = g.columns.map(function (col) {
      return col.map(function (c) {
        if (c.future) return '<span class="h-[13px] w-[13px]"></span>';
        var tip = (c.n ? c.n + (c.n === 1 ? ' post' : ' posts') : 'No posts') + ' · ' + fmt.format(c.date);
        return '<span class="h-[13px] w-[13px] rounded-[3px]" style="background:' + SHADES[level(c.n, g.max)] + '" title="' + esc(tip) + '"></span>';
      }).join('');
    });
    var labels = months(g.columns).map(function (m) { return '<span class="absolute top-0 text-[10px] leading-none text-white/40" style="left:' + (m.at * 16) + 'px">' + m.name + '</span>'; }).join('');
    var stat = function (v, l) { return '<div><p class="text-2xl font-semibold tracking-tight">' + v + '</p><p class="mt-0.5 text-xs text-white/45">' + l + '</p></div>'; };
    root.innerHTML =
      '<div class="flex flex-wrap items-end gap-x-10 gap-y-4">' +
        stat(g.total, g.total === 1 ? 'post in the last year' : 'posts in the last year') +
        stat(s.current, s.current === 1 ? 'day in a row' : 'days in a row') +
        stat(s.best, s.best === 1 ? 'day, longest run' : 'days, longest run') +
      '</div>' +
      '<div id="activityScroll" class="mt-5 overflow-x-auto pb-1"><div class="inline-block min-w-max">' +
        '<div class="relative mb-1.5 h-3">' + labels + '</div>' +
        '<div class="flex gap-[3px]">' + cols.map(function (c) { return '<div class="grid grid-rows-7 gap-[3px]">' + c + '</div>'; }).join('') + '</div>' +
      '</div></div>' +
      '<div class="mt-3 flex items-center justify-between gap-3 text-[11px] text-white/40">' +
        '<span>' + (g.total ? 'Every square is a day. Darker means more posts.' : 'Your first post lights up the first square.') + '</span>' +
        '<span class="flex items-center gap-1.5">Less' + SHADES.map(function (c) { return '<span class="h-[13px] w-[13px] rounded-[3px]" style="background:' + c + '"></span>'; }).join('') + 'More</span>' +
      '</div>';
    var sc = document.getElementById('activityScroll');
    sc.scrollLeft = sc.scrollWidth;
  }

  Vane.api('GET', '/api/posts/activity?offset=' + (-new Date().getTimezoneOffset())).then(function (r) {
    if (r.ok && r.data) render(r.data.days || {});
    else root.innerHTML = '<p class="text-sm text-white/45">The calendar could not be loaded.</p>';
  });
})();
