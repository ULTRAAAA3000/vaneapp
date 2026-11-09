(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  var fmt = function (n) { return n === null || n === undefined ? '–' : n >= 10000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(n); };
  var NS = 'http://www.w3.org/2000/svg';
  var COLORS = ['#7dd3fc', '#86efac', '#fcd34d', '#f9a8d4', '#c4b5fd', '#fdba74'];
  var LABEL = { bluesky: 'Bluesky', mastodon: 'Mastodon', telegram: 'Telegram', devto: 'Dev.to', slack: 'Slack', hashnode: 'Hashnode', x: 'X', linkedin: 'LinkedIn', threads: 'Threads', discord: 'Discord', reddit: 'Reddit', pinterest: 'Pinterest', facebook: 'Facebook', webhook: 'Webhook' };
  var TABS = [['overview', 'Overview'], ['activity', 'Activity'], ['posts', 'Posts'], ['followers', 'Followers'], ['compare', 'Compare', true], ['times', 'Best times', true], ['formats', 'Formats', true], ['bot', 'Telegram bot'], ['plans', 'Free and Pro']];
  var STAGES = { 1: '1 hour', 2: '24 hours', 3: '7 days', 4: '30 days' };
  var MILESTONES = [100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000];
  var SORTS = [['new', 'Newest first'], ['old', 'Oldest first'], ['reactions', 'Most reactions'], ['likes', 'Most likes'], ['replies', 'Most replies'], ['reposts', 'Most reposts'], ['views', 'Most views']];
  var DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var S = { tab: 'overview', days: 30, sel: null, sort: 'new', q: '', page: 1, d: null, ins: null, insKey: '', act: null, actKey: '', actSel: null };

  function store(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem('vane.analytics.' + k)); localStorage.setItem('vane.analytics.' + k, JSON.stringify(v)); } catch (e) { return null; } }
  var checkoutUrl = function () { return (/^analytics\.vaneapp\.dev$/i.test(location.hostname) ? 'https://vaneapp.dev' : '') + '/checkout?plan=analytics'; };
  var svg = function (tag, attrs) { var n = document.createElementNS(NS, tag); Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); }); return n; };
  var reactions = function (p) { return (p.likes || 0) + (p.replies || 0) + (p.reposts || 0); };

  // ── Free vs Pro table (also shown to visitors who are not signed in)
  var ROWS = [
    ['Results of every post you publish through Vane', true, true],
    ['Bluesky, Mastodon, Dev.to results · followers on Bluesky, Mastodon, Telegram', true, true],
    ['Filter by network, period and sort', true, true],
    ['Reactions per day chart and best posts', true, true],
    ['Comparison with the previous period', true, true],
    ['Activity of every network: sent, failed, queue, streak', true, true],
    ['Followers now and change', true, true],
    ['History', '30 days', '12 months'],
    ['Posts list', '10 latest', 'All, with search and pages'],
    ['Followers growth charts by network', false, true],
    ['Compare your networks', false, true],
    ['Best day and time to publish', false, true],
    ['Formats: what works better (media, length, link, hashtags, question)', false, true],
    ['Growth of one post from 1 hour to 30 days', false, true],
    ['Followers forecast to the next milestone', false, true],
    ['Activity: when you publish, why posts fail, how punctual Vane is', false, true],
    ['CSV export: posts, followers, activity', false, true],
    ['Weekly report by email', false, true],
    ['Telegram bot: commands, post results, follower milestones', true, true],
    ['Telegram bot: daily follower changes, hot post alerts, digests', false, true]
  ];
  function cellVal(v) { var c = el('td', 'px-3 py-2.5 text-center text-sm'); if (v === true) { c.textContent = '✓'; c.className += ' text-emerald-300'; } else if (v === false) { c.textContent = '–'; c.className += ' text-white/25'; } else c.textContent = v; return c; }
  function plansTable(pro) {
    var box = el('div', 'space-y-4');
    var wrap = el('div', 'glass-d overflow-hidden rounded-2xl');
    var t = el('table', 'w-full text-left');
    var head = el('tr', 'border-b border-white/10');
    head.appendChild(el('th', 'px-3 py-3 text-xs font-medium text-white/45', ''));
    var free = el('th', 'px-3 py-3 text-center'); free.appendChild(el('div', 'text-sm font-semibold', 'Free')); free.appendChild(el('div', 'text-xs font-normal text-white/45', '$0'));
    var pr = el('th', 'px-3 py-3 text-center'); pr.appendChild(el('div', 'text-sm font-semibold', 'Analytics Pro')); pr.appendChild(el('div', 'text-xs font-normal text-white/45', '$4.99 / month'));
    head.appendChild(free); head.appendChild(pr); t.appendChild(head);
    ROWS.forEach(function (r) { var tr = el('tr', 'border-b border-white/[0.06] last:border-0'); tr.appendChild(el('td', 'px-3 py-2.5 text-sm text-white/75', r[0])); tr.appendChild(cellVal(r[1])); tr.appendChild(cellVal(r[2])); t.appendChild(tr); });
    wrap.appendChild(t); box.appendChild(wrap);
    box.appendChild(el('p', 'text-sm text-white/55', 'Analytics Pro is included in Vane Suite. Payment is a one-off purchase for a month or a year, no automatic renewal.'));
    if (pro) box.appendChild(el('p', 'text-sm font-medium text-emerald-300', 'You have Analytics Pro.'));
    else { var up = el('a', 'btn btn-white inline-flex', 'Get Analytics Pro · $4.99'); up.href = checkoutUrl(); box.appendChild(up); }
    return box;
  }

  function lock(title, text) {
    var c = el('div', 'an-lock glass-d rounded-2xl p-6 text-center');
    var ic = svg('svg', { viewBox: '0 0 24 24', width: 22, height: 22, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: 'an-lock-ic', 'aria-hidden': 'true' });
    ic.appendChild(svg('rect', { x: 5, y: 11, width: 14, height: 9, rx: 2.5 })); ic.appendChild(svg('path', { d: 'M8 11V8a4 4 0 018 0v3' }));
    c.appendChild(ic);
    c.appendChild(el('p', 'mt-3 text-base font-semibold', title));
    c.appendChild(el('p', 'mx-auto mt-2 max-w-md text-sm leading-relaxed text-white/55', text));
    var up = el('a', 'btn btn-white btn-sm mt-4 inline-flex', 'Get Analytics Pro · $4.99'); up.href = checkoutUrl(); c.appendChild(up);
    var more = el('a', 'ml-2 text-sm text-white/55 underline underline-offset-4', 'See Free vs Pro'); more.href = '#plans'; c.appendChild(more);
    return c;
  }

  // ── charts
  function bucket(daily, days) {
    var byDay = {}; daily.forEach(function (r) { byDay[r.day] = r; });
    var today = Math.floor(Date.now() / 86400000), out = [], step = days > 90 ? 7 : 1;
    for (var i = days - 1; i >= 0; i -= step) {
      var agg = { label: '', likes: 0, replies: 0, reposts: 0, posts: 0 };
      for (var k = 0; k < step && i - k >= 0; k++) { var day = new Date((today - (i - k)) * 86400000).toISOString().slice(0, 10); if (k === 0) agg.label = day; var r = byDay[day]; if (r) { agg.likes += r.likes; agg.replies += r.replies; agg.reposts += r.reposts; agg.posts += r.posts; } }
      out.push(agg);
    }
    return out;
  }
  // Round the top of the scale up to 1, 2, 5 × 10^n so the grid lines read as whole numbers.
  function niceMax(m) { if (m <= 10) return m <= 1 ? 1 : Math.ceil(m / 2) * 2; var p = Math.pow(10, Math.floor(Math.log10(m))), f = m / p, k = [1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(function (x) { return x >= f; }); return k * p; }
  function shortDay(iso) { return new Date(iso + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }); }
  // One drawer for every "per day" chart: a scale with grid lines, stacked bars, four dates, and the same tooltip text as before (tip(row)).
  // On a phone the drawing is 340 wide instead of 640, so its text stays readable instead of shrinking with the screen.
  function stackedBars(rows, series, aria, tip) {
    var narrow = window.innerWidth < 640, W = narrow ? 340 : 640, H = narrow ? 170 : 170, FS = narrow ? 11 : 10, max = 1;
    rows.forEach(function (r) { var t = 0; series.forEach(function (c) { t += r[c[0]]; }); max = Math.max(max, t); });
    var top = niceMax(max), padL = 10 + String(top).length * FS * 0.6, padR = 4, padT = 8, plotH = H - padT;
    var s = svg('svg', { viewBox: '0 0 ' + W + ' ' + (H + 22), class: 'an-chart w-full', role: 'img', 'aria-label': aria });
    [0, 0.5, 1].forEach(function (f) {
      var y = H - f * plotH;
      s.appendChild(svg('line', { x1: padL, x2: W - padR, y1: y, y2: y, stroke: f ? 'rgba(255,255,255,.08)' : 'rgba(255,255,255,.16)', 'stroke-dasharray': f ? '3 4' : '0' }));
      var v = top * f; if (v % 1) return;
      var t = svg('text', { x: padL - 6, y: y + 3.5, fill: 'rgba(255,255,255,.4)', 'font-size': FS, 'text-anchor': 'end' }); t.textContent = fmt(v); s.appendChild(t);
    });
    var bw = (W - padL - padR) / rows.length;
    rows.forEach(function (r, i) {
      var g = svg('g', { class: 'an-col' }), x = padL + i * bw, y = H;
      g.appendChild(svg('rect', { x: x, y: padT, width: bw, height: plotH, fill: 'rgba(255,255,255,0.001)' }));
      series.forEach(function (c) {
        var h = (r[c[0]] / top) * plotH; if (h <= 0) return; y -= h;
        g.appendChild(svg('rect', { x: x + bw * 0.16, y: y, width: Math.max(bw * 0.68, 1), height: Math.max(h - 0.5, 0.5), fill: c[1], rx: Math.min(bw * 0.2, 2.5) }));
      });
      g.appendChild(svg('title')).textContent = tip(r);
      s.appendChild(g);
    });
    var seen = {};
    [0, 1 / 3, 2 / 3, 1].forEach(function (f) {
      var i = Math.round(f * (rows.length - 1)); if (seen[i] || !rows[i].label) return; seen[i] = 1;
      var first = i === 0, last = i === rows.length - 1;
      var t = svg('text', { x: first ? padL : last ? W - padR : padL + (i + 0.5) * bw, y: H + 16, fill: 'rgba(255,255,255,.4)', 'font-size': FS, 'text-anchor': first ? 'start' : last ? 'end' : 'middle' }); t.textContent = shortDay(rows[i].label); s.appendChild(t);
    });
    return s;
  }
  function barChart(daily, days) {
    return stackedBars(bucket(daily, days), [['likes', COLORS[0]], ['replies', COLORS[1]], ['reposts', COLORS[2]]], 'Reactions per day', function (r) { return r.label + ': ' + r.likes + ' likes, ' + r.replies + ' replies, ' + r.reposts + ' reposts, ' + r.posts + ' posts'; });
  }
  function legend() {
    var l = el('div', 'flex flex-wrap gap-4 text-xs text-white/55');
    [['Likes', COLORS[0]], ['Replies', COLORS[1]], ['Reposts', COLORS[2]]].forEach(function (c) { var i = el('span', 'inline-flex items-center gap-1.5'); var d = el('span', 'h-2.5 w-2.5 rounded-sm'); d.style.background = c[1]; i.appendChild(d); i.appendChild(document.createTextNode(c[0])); l.appendChild(i); });
    return l;
  }
  var sparkId = 0;
  function line(points, color) {
    var W = 320, H = 90, P = 6, vals = points.map(function (p) { return p.followers; }), lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals), span = Math.max(hi - lo, 1);
    var t0 = Date.parse(points[0].day), t1 = Date.parse(points[points.length - 1].day), s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'w-full', role: 'img', 'aria-label': 'Followers by day' });
    var xy = points.map(function (p) { return [P + ((Date.parse(p.day) - t0) / Math.max(t1 - t0, 1)) * (W - 2 * P), hi === lo ? H / 2 : H - P - ((p.followers - lo) / span) * (H - 2 * P)]; });
    var pts = xy.map(function (q) { return q[0].toFixed(1) + ',' + q[1].toFixed(1); }), id = 'spark' + (++sparkId);
    var defs = svg('defs'), grad = svg('linearGradient', { id: id, x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.appendChild(svg('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': 0.32 })); grad.appendChild(svg('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0 }));
    defs.appendChild(grad); s.appendChild(defs);
    s.appendChild(svg('polygon', { points: P + ',' + (H - P) + ' ' + pts.join(' ') + ' ' + (W - P) + ',' + (H - P), fill: 'url(#' + id + ')' }));
    s.appendChild(svg('polyline', { points: pts.join(' '), fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    var end = xy[xy.length - 1]; s.appendChild(svg('circle', { cx: end[0].toFixed(1), cy: end[1].toFixed(1), r: 3.5, fill: color, stroke: '#0b0b0d', 'stroke-width': 2 }));
    return s;
  }

  // ── parts
  function stat(label, value, sub, dl) {
    var c = el('div', 'an-kpi glass-d rounded-2xl p-4'); c.appendChild(el('p', 'an-kpi-l', label)); c.appendChild(el('p', 'an-kpi-v', fmt(value)));
    if (sub) c.appendChild(el('p', 'an-kpi-s', sub));
    if (dl) {
      var kind = /emerald/.test(dl.cls) ? 'up' : /rose/.test(dl.cls) ? 'down' : 'flat', row = el('p', 'an-kpi-d'); row.title = 'Compared with the previous period of the same length';
      var pill = el('span', 'an-delta ' + kind, (dl.text.charAt(0) === '+' ? '▲ ' : dl.text.charAt(0) === '-' ? '▼ ' : '') + dl.text.replace(/^[+-]/, '')); row.appendChild(pill); row.appendChild(el('span', 'an-kpi-vs', 'vs prev.'));
      c.appendChild(row);
    }
    return c;
  }
  // Change against the period just before: a percentage, "new" when there was nothing before, nothing at all when both are empty. `invert`: down is good (failed posts).
  function delta(now, prev, invert) {
    if (prev === undefined || prev === null) return null;
    if (!prev) return now ? { text: 'new', cls: 'text-white/55' } : null;
    var pct = Math.round(((now - prev) / prev) * 100);
    if (!pct) return { text: '0%', cls: 'text-white/45' };
    return { text: (pct > 0 ? '+' : '') + pct + '%', cls: (invert ? pct < 0 : pct > 0) ? 'text-emerald-300' : 'text-rose-300' };
  }
  var avgOf = function (t) { return t && t.posts ? Math.round(((t.likes + t.replies + t.reposts) / t.posts) * 10) / 10 : 0; };
  function colorOfType(type) { var c = S.d.channels.find(function (x) { return x.type === type; }); return c ? colorOf(c.id) : COLORS[Object.keys(LABEL).indexOf(type) % COLORS.length]; }
  function colorOf(id) { var i = S.d.channels.findIndex(function (c) { return c.id === id; }); return COLORS[(i < 0 ? 0 : i) % COLORS.length]; }
  function netTag(p) { var t = el('span', 'inline-flex items-center gap-1.5 text-xs text-white/55'); var d = el('span', 'h-2 w-2 rounded-full'); d.style.background = colorOf(p.channel_id); t.appendChild(d); t.appendChild(document.createTextNode((LABEL[p.type] || p.type) + ' · ' + p.channel)); return t; }
  function postRow(p) {
    var r = el('div', 'an-post glass-d flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl p-3 sm:p-4'); r.style.setProperty('--c', colorOf(p.channel_id));
    var left = el('div', 'min-w-0 flex-1 basis-60');
    left.appendChild(el('p', 'line-clamp-2 break-words text-sm', p.content.replace(/\s+/g, ' ')));
    var meta = el('div', 'mt-1 flex flex-wrap items-center gap-x-3 text-xs text-white/45'); meta.appendChild(netTag(p)); meta.appendChild(el('span', '', new Date(p.sent_at * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })));
    if (p.stage === null) meta.appendChild(el('span', 'text-white/35', 'numbers appear 1 hour after publishing'));
    left.appendChild(meta); r.appendChild(left);
    var nums = el('div', 'flex gap-4 text-sm tabular-nums text-white/75');
    [['views', p.views], ['likes', p.likes], ['replies', p.replies], ['reposts', p.reposts]].forEach(function (x) { var c = el('div', 'text-center'); c.appendChild(el('p', 'font-medium', fmt(x[1]))); c.appendChild(el('p', 'text-[10px] uppercase tracking-wide text-white/40', x[0])); nums.appendChild(c); });
    r.appendChild(nums);
    if (S.d && S.d.pro && p.stage !== null) {
      var g = el('button', 'btn btn-ghost btn-sm', 'Growth'); g.type = 'button'; var panel = null;
      g.addEventListener('click', function () {
        if (panel) { panel.remove(); panel = null; g.textContent = 'Growth'; return; }
        panel = el('div', 'basis-full w-full border-t border-white/10 pt-3 text-sm text-white/50', 'Loading…'); r.appendChild(panel); g.textContent = 'Hide';
        fetch('/api/analytics/post?id=' + encodeURIComponent(p.id), { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(function (x) { return x.json(); }).then(function (j) { if (panel) growthPanel(panel, j); }).catch(function () { if (panel) panel.textContent = 'Could not load the growth of this post.'; });
      });
      r.appendChild(g);
    }
    return r;
  }
  function growthPanel(panel, j) {
    panel.textContent = '';
    if (!j || !j.ok || !j.stages.length) { panel.textContent = 'Not enough snapshots yet. They are taken 1 hour, 24 hours, 7 days and 30 days after publishing.'; return; }
    var max = 1; j.stages.forEach(function (x) { max = Math.max(max, (x.likes || 0) + (x.replies || 0) + (x.reposts || 0)); });
    panel.appendChild(el('p', 'mb-2 text-xs uppercase tracking-wide text-white/40', 'Reactions after…'));
    j.stages.forEach(function (x) {
      var total = (x.likes || 0) + (x.replies || 0) + (x.reposts || 0), row = el('div', 'mb-1.5 flex items-center gap-3 text-xs tabular-nums');
      row.appendChild(el('span', 'w-16 shrink-0 text-white/55', STAGES[x.stage] || ('stage ' + x.stage)));
      var bar = el('div', 'h-2 flex-1 overflow-hidden rounded-full bg-white/10'), fill = el('div', 'h-full rounded-full bg-sky-300/80'); fill.style.width = Math.max(total / max * 100, total ? 3 : 0) + '%'; bar.appendChild(fill); row.appendChild(bar);
      row.appendChild(el('span', 'w-44 shrink-0 text-right text-white/65', fmt(x.likes) + ' likes · ' + fmt(x.replies) + ' replies · ' + fmt(x.reposts) + ' reposts' + (x.views ? ' · ' + fmt(x.views) + ' views' : '')));
      panel.appendChild(row);
    });
  }
  function empty(text) { return el('div', 'glass-d rounded-2xl p-6 text-center text-sm text-white/55', text); }
  function section(title, hint) { var h = el('div', 'flex items-baseline justify-between gap-3'); h.appendChild(el('h2', 'text-sm font-semibold uppercase tracking-wide text-white/50', title)); if (hint) h.appendChild(el('span', 'text-xs text-white/35', hint)); return h; }

  // ── tabs
  function renderOverview() {
    var d = S.d, root = $('tab-overview'); root.textContent = '';
    if (!d.selected.length) {
      var none = empty(d.channels.length ? 'None of your networks gives numbers back yet (results: Bluesky, Mastodon, Dev.to). ' : 'Pick at least one network above to see its numbers.');
      if (d.channels.length) { var go = el('a', 'text-white underline underline-offset-4', 'See what Vane did for them in Activity →'); go.href = '#activity'; none.appendChild(go); }
      root.appendChild(none); return;
    }
    var t = d.totals, pv = d.prev, avg = t.posts ? avgOf(t) : null;
    var g = el('div', 'grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6'); [['Posts', t.posts, pv && pv.posts], ['Views', t.views, pv && pv.views], ['Likes', t.likes, pv && pv.likes], ['Replies', t.replies, pv && pv.replies], ['Reposts', t.reposts, pv && pv.reposts], ['Per post', avg, pv && pv.posts ? avgOf(pv) : 0]].forEach(function (x) { g.appendChild(stat(x[0], x[1], x[0] === 'Per post' ? 'average reactions' : null, pv ? delta(x[1] || 0, x[2]) : null)); });
    root.appendChild(g);
    var c = el('div', 'glass-d rounded-2xl p-4 sm:p-5'); var h = el('div', 'mb-3 flex flex-wrap items-center justify-between gap-2'); h.appendChild(el('p', 'text-sm font-medium', 'Reactions' + (d.days > 90 ? ' per week' : ' per day'))); h.appendChild(legend()); c.appendChild(h);
    if (t.posts) c.appendChild(barChart(d.daily, d.days)); else c.appendChild(el('p', 'py-8 text-center text-sm text-white/50', 'No published posts here in the last ' + d.days + ' days yet. Results show up an hour after a post goes out.'));
    root.appendChild(c);
    if (d.top.length) { var top = el('div', 'space-y-2'); top.appendChild(section('Best posts', 'by reactions')); d.top.forEach(function (p) { top.appendChild(postRow(p)); }); root.appendChild(top); }
    var more = el('div', 'text-center'); var all = el('a', 'text-sm text-white/55 underline underline-offset-4', 'All posts →'); all.href = '#posts'; more.appendChild(all); root.appendChild(more);
  }

  function toolbar() {
    var bar = el('div', 'flex flex-wrap items-center gap-2');
    var sel = el('select', 'field !w-auto !py-2 text-sm'); sel.setAttribute('aria-label', 'Sort'); SORTS.forEach(function (s) { var o = el('option', '', s[1]); o.value = s[0]; if (s[0] === S.sort) o.selected = true; sel.appendChild(o); });
    sel.addEventListener('change', function () { S.sort = sel.value; S.page = 1; store('sort', S.sort); load(); }); bar.appendChild(sel);
    var q = el('input', 'field !w-auto min-w-0 flex-1 !py-2 text-sm'); q.type = 'search'; q.placeholder = S.d.pro ? 'Search in your posts' : 'Search is part of Pro'; q.value = S.q; q.disabled = !S.d.pro; q.setAttribute('aria-label', 'Search posts');
    var timer; q.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { S.q = q.value.trim(); S.page = 1; load(true); }, 350); }); bar.appendChild(q);
    if (S.d.pro) { var ex = el('a', 'btn btn-ghost btn-sm', 'Export CSV'); ex.href = '/api/analytics/export?days=' + S.d.days + '&channels=' + encodeURIComponent(S.d.selected.join(',')) + '&q=' + encodeURIComponent(S.q); ex.setAttribute('download', 'vane-analytics.csv'); bar.appendChild(ex); }
    return bar;
  }
  function renderPosts() {
    var d = S.d, root = $('tab-posts'); root.textContent = '';
    root.appendChild(toolbar());
    if (!d.selected.length) { root.appendChild(empty('Pick at least one network above.')); return; }
    if (!d.posts.length) { root.appendChild(empty(S.q ? 'Nothing matches this search.' : 'No published posts in this period yet.')); return; }
    d.posts.forEach(function (p) { root.appendChild(postRow(p)); });
    if (d.pro) {
      var pages = Math.max(1, Math.ceil(d.postsTotal / d.pageSize)), nav = el('div', 'flex items-center justify-between pt-1');
      var prev = el('button', 'btn btn-ghost btn-sm', 'Previous'); prev.disabled = d.page <= 1; prev.addEventListener('click', function () { S.page = d.page - 1; load(true); });
      var next = el('button', 'btn btn-ghost btn-sm', 'Next'); next.disabled = d.page >= pages; next.addEventListener('click', function () { S.page = d.page + 1; load(true); });
      nav.appendChild(prev); nav.appendChild(el('span', 'text-sm text-white/55', 'Page ' + d.page + ' of ' + pages + ' · ' + d.postsTotal + ' posts')); nav.appendChild(next); root.appendChild(nav);
    } else if (d.postsTotal > d.posts.length) {
      var n = el('p', 'text-center text-sm text-white/55', 'Free shows the ' + d.pageSize + ' posts of this selection. ' + (d.postsTotal - d.posts.length) + ' more are kept in Analytics Pro. '); var a = el('a', 'text-white underline underline-offset-4', 'Get Pro'); a.href = checkoutUrl(); n.appendChild(a); root.appendChild(n);
    }
  }

  // Pace over the period on screen and the next round number; a straight line, said as such ("~"), never a promise.
  function forecast(pts) {
    var p = el('p', 'mt-2 text-xs text-white/55'), a = pts[0], b = pts[pts.length - 1], span = (Date.parse(b.day) - Date.parse(a.day)) / 86400000, next = null;
    if (span < 3) { p.textContent = 'A forecast appears after a few more days of numbers.'; return p; }
    for (var i = 0; i < MILESTONES.length; i++) if (MILESTONES[i] > b.followers) { next = MILESTONES[i]; break; }
    if (!next) return p;
    var pace = (b.followers - a.followers) / span;
    if (pace <= 0) { p.textContent = 'No growth in this period, so no forecast for ' + next.toLocaleString() + '.'; return p; }
    var eta = Math.ceil((next - b.followers) / pace);
    p.textContent = '+' + (Math.round(pace * 10) / 10) + ' per day · ' + (eta > 730 ? 'more than 2 years to ' + next.toLocaleString() : '~' + eta + ' days to ' + next.toLocaleString() + ' (' + new Date(Date.now() + eta * 86400000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) + ')');
    return p;
  }
  function renderFollowers() {
    var d = S.d, root = $('tab-followers'); root.textContent = '';
    var chans = d.channels.filter(function (c) { return d.selected.indexOf(c.id) >= 0 && c.followers; });
    if (!chans.length) { root.appendChild(empty(d.selected.length ? 'Followers are tracked for Bluesky, Mastodon and Telegram. Pick one of them above.' : 'Pick at least one network above.')); return; }
    var grid = el('div', 'grid gap-3 sm:grid-cols-2');
    chans.forEach(function (n) {
      var c = el('div', 'glass-d rounded-2xl p-4'), top = el('div', 'flex items-center gap-2'); var dot = el('span', 'h-2.5 w-2.5 rounded-full'); dot.style.background = colorOf(n.id); top.appendChild(dot); top.appendChild(el('p', 'min-w-0 flex-1 truncate text-sm font-medium', n.name)); top.appendChild(el('span', 'text-xs text-white/45', LABEL[n.type] || n.type)); c.appendChild(top);
      if (n.now === null) { c.appendChild(el('p', 'mt-3 text-sm text-white/50', 'The first number appears after the next daily check.')); grid.appendChild(c); return; }
      var delta = n.first === null ? 0 : n.now - n.first, row = el('div', 'mt-3 flex items-baseline gap-2'); row.appendChild(el('p', 'text-3xl font-semibold tabular-nums', fmt(n.now))); row.appendChild(el('p', 'text-sm tabular-nums ' + (delta > 0 ? 'text-emerald-300' : delta < 0 ? 'text-rose-300' : 'text-white/45'), (delta > 0 ? '+' : '') + delta + ' in ' + d.days + ' days')); c.appendChild(row);
      if (d.pro) { var pts = d.series.filter(function (p) { return p.channel_id === n.id; }); if (pts.length > 1) { var w = el('div', 'mt-3'); w.appendChild(line(pts, colorOf(n.id))); var ax = el('div', 'flex justify-between text-[11px] text-white/35'); ax.appendChild(el('span', '', shortDay(pts[0].day))); ax.appendChild(el('span', '', shortDay(pts[pts.length - 1].day))); w.appendChild(ax); c.appendChild(w); c.appendChild(forecast(pts)); } else c.appendChild(el('p', 'mt-3 text-xs text-white/45', 'The chart appears after two daily checks.')); }
      grid.appendChild(c);
    });
    root.appendChild(grid);
    if (d.pro) { var fx = el('a', 'btn btn-ghost btn-sm inline-flex', 'Export CSV'); fx.href = '/api/analytics/export?kind=followers&days=' + d.days + '&channels=' + encodeURIComponent(d.selected.join(',')); fx.setAttribute('download', 'vane-followers.csv'); root.appendChild(fx); }
    if (!d.pro) root.appendChild(lock('Followers growth charts are part of Analytics Pro', 'See how each network grows day by day, with up to 12 months of history.'));
  }

  function needInsights(cb) {
    var key = S.d.days + '|' + S.d.selected.join(',');
    if (S.insKey === key && S.ins) return cb(S.ins);
    fetch('/api/analytics/insights?days=' + S.d.days + '&channels=' + encodeURIComponent(S.d.selected.join(',')), { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(function (r) { return r.json(); }).then(function (j) { if (j && j.ok) { S.ins = j; S.insKey = key; cb(j); } else cb(null); }).catch(function () { cb(null); });
  }
  function renderCompare() {
    var root = $('tab-compare'); root.textContent = '';
    if (!S.d.pro) { root.appendChild(lock('Compare your networks', 'See which network brings the most reactions per post, side by side, and where your effort pays off.')); return; }
    root.appendChild(el('p', 'text-sm text-white/45', 'Loading…'));
    needInsights(function (j) {
      root.textContent = '';
      if (!j || !j.compare.length) { root.appendChild(empty('Nothing to compare yet. Publish through two or more networks and numbers will appear here.')); return; }
      var best = 0; j.compare.forEach(function (c) { c.avg = c.posts ? c.reactions / c.posts : 0; best = Math.max(best, c.avg); });
      var box = el('div', 'glass-d space-y-4 rounded-2xl p-4 sm:p-5'); box.appendChild(el('p', 'text-sm font-medium', 'Average reactions per post, last ' + j.days + ' days'));
      j.compare.slice().sort(function (a, b) { return b.avg - a.avg; }).forEach(function (c) {
        var r = el('div'), top = el('div', 'flex items-baseline justify-between gap-3 text-sm'); var l = el('span', 'min-w-0 truncate', (LABEL[c.type] || c.type) + ' · ' + c.name); top.appendChild(l); top.appendChild(el('span', 'tabular-nums text-white/75', (Math.round(c.avg * 10) / 10) + ' per post')); r.appendChild(top);
        var bar = el('div', 'mt-1.5 h-2.5 overflow-hidden rounded-full bg-white/10'), fill = el('div', 'h-full rounded-full'); fill.style.width = (best ? Math.max(c.avg / best * 100, 2) : 0) + '%'; fill.style.background = colorOf(c.channel_id); bar.appendChild(fill); r.appendChild(bar);
        r.appendChild(el('p', 'mt-1 text-xs text-white/40', c.posts + ' posts · ' + fmt(c.reactions) + ' reactions' + (c.views ? ' · ' + fmt(c.views) + ' views' : ''))); box.appendChild(r);
      });
      root.appendChild(box);
    });
  }
  function renderTimes() {
    var root = $('tab-times'); root.textContent = '';
    if (!S.d.pro) { root.appendChild(lock('Best day and time to publish', 'See which weekdays and hours bring the most reactions, based on your own posts.')); return; }
    if (!S.d.selected.length) { root.appendChild(empty('Pick at least one network above.')); return; }
    root.appendChild(el('p', 'text-sm text-white/45', 'Loading…'));
    needInsights(function (j) {
      root.textContent = '';
      if (!j || !j.best.grid.length || !j.best.grid.some(function (r) { return r.some(function (c) { return c.n; }); })) { root.appendChild(empty('Not enough posts with results yet. Best times need a few published posts.')); return; }
      var max = 0; j.best.grid.forEach(function (r) { r.forEach(function (c) { max = Math.max(max, c.avg); }); });
      if (j.best.top.length) { var tp = el('div', 'glass-d rounded-2xl p-4 sm:p-5'); tp.appendChild(el('p', 'text-sm font-medium', 'Your best slots')); var ul = el('ul', 'mt-3 space-y-2 text-sm text-white/75'); j.best.top.forEach(function (x, ri) { var li = el('li', 'flex items-center gap-3'); li.appendChild(el('span', 'an-rank', String(ri + 1))); li.appendChild(el('span', 'min-w-0', DAYS[x.day] + ' ' + pad(x.slot * 3) + '–' + pad(x.slot * 3 + 3) + ' · ' + x.avg + ' reactions per post (' + x.n + ' posts)')); ul.appendChild(li); }); tp.appendChild(ul); root.appendChild(tp); }
      var c = el('div', 'glass-d rounded-2xl p-4 sm:p-5'); c.appendChild(el('p', 'text-sm font-medium', 'Average reactions per post')); c.appendChild(el('p', 'mb-3 text-xs text-white/40', 'Time zone: ' + j.timeZone + '. Brighter is better; empty cells have no posts.'));
      var scroll = el('div', 'overflow-x-auto'), grid = el('div', 'grid min-w-[300px] gap-1'); grid.style.gridTemplateColumns = '2.5rem repeat(8, minmax(0, 1fr))';
      grid.appendChild(el('div')); for (var h = 0; h < 8; h++) grid.appendChild(el('div', 'text-center text-[10px] text-white/40', pad(h * 3)));
      DAYS.forEach(function (name, di) {
        grid.appendChild(el('div', 'flex items-center text-xs text-white/50', name));
        for (var si = 0; si < 8; si++) { var cell = j.best.grid[di][si], b = el('div', 'flex h-9 items-center justify-center rounded-md text-[11px] tabular-nums'); if (cell.n) { b.style.background = 'rgba(125,211,252,' + (0.12 + 0.75 * (max ? cell.avg / max : 0)).toFixed(2) + ')'; b.style.color = (max && cell.avg / max > 0.55) ? '#04121c' : 'rgba(255,255,255,.8)'; b.textContent = String(cell.avg); b.title = DAYS[di] + ' ' + pad(si * 3) + '–' + pad(si * 3 + 3) + ': ' + cell.avg + ' per post, ' + cell.n + ' posts'; } else b.style.background = 'rgba(255,255,255,.04)'; grid.appendChild(b); }
      });
      scroll.appendChild(grid); c.appendChild(scroll); c.appendChild(heatLegend('125,211,252')); root.appendChild(c);
    });
  }
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };

  // ── Activity: what Vane published for you, on EVERY network (no numbers from the networks needed)
  function needActivity(cb) {
    var key = S.days + '|' + (S.actSel ? S.actSel.join(',') : 'all');
    if (S.actKey === key && S.act) return cb(S.act);
    fetch('/api/analytics/activity?days=' + S.days + (S.actSel ? '&channels=' + encodeURIComponent(S.actSel.join(',')) : ''), { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(function (r) { return r.json(); }).then(function (j) { if (j && j.ok) { S.act = j; S.actKey = key; cb(j); } else cb(null); }).catch(function () { cb(null); });
  }
  function legendOf(pairs) {
    var l = el('div', 'flex flex-wrap gap-4 text-xs text-white/55');
    pairs.forEach(function (c) { var i = el('span', 'inline-flex items-center gap-1.5'); var d = el('span', 'h-2.5 w-2.5 rounded-sm'); d.style.background = c[1]; i.appendChild(d); i.appendChild(document.createTextNode(c[0])); l.appendChild(i); });
    return l;
  }
  var RED = '#fca5a5';
  function activityBars(daily, days) {
    var byDay = {}; daily.forEach(function (r) { byDay[r.day] = r; });
    var today = Math.floor(Date.now() / 86400000), step = days > 90 ? 7 : 1, rows = [];
    for (var i = days - 1; i >= 0; i -= step) {
      var agg = { label: '', sent: 0, failed: 0 };
      for (var k = 0; k < step && i - k >= 0; k++) { var day = new Date((today - (i - k)) * 86400000).toISOString().slice(0, 10); if (k === 0) agg.label = day; var r = byDay[day]; if (r) { agg.sent += r.sent; agg.failed += r.failed; } }
      rows.push(agg);
    }
    return stackedBars(rows, [['sent', COLORS[1]], ['failed', RED]], 'Posts per day', function (r) { return r.label + ': ' + r.sent + ' published, ' + r.failed + ' failed'; });
  }
  function barRows(title, items) {
    var box = el('div', 'glass-d space-y-4 rounded-2xl p-4 sm:p-5'); box.appendChild(el('p', 'text-sm font-medium', title));
    var best = 0; items.forEach(function (x) { best = Math.max(best, x.value); });
    items.forEach(function (x) {
      var r = el('div'), top = el('div', 'flex items-baseline justify-between gap-3 text-sm'); top.appendChild(el('span', 'min-w-0 flex-1 truncate', x.label)); top.appendChild(el('span', 'shrink-0 whitespace-nowrap tabular-nums text-white/75', x.text)); r.appendChild(top);
      var bar = el('div', 'mt-1.5 h-2.5 overflow-hidden rounded-full bg-white/10'), fill = el('div', 'h-full rounded-full'); fill.style.width = (best ? Math.max(x.value / best * 100, x.value ? 2 : 0) : 0) + '%'; fill.style.background = x.color; bar.appendChild(fill); r.appendChild(bar);
      if (x.sub) r.appendChild(el('p', 'mt-1 text-xs text-white/40', x.sub)); box.appendChild(r);
    });
    return box;
  }
  function habitHeat(grid, tz) {
    var max = 0, sum = 0; grid.forEach(function (r) { r.forEach(function (v) { max = Math.max(max, v); sum += v; }); });
    var c = el('div', 'glass-d rounded-2xl p-4 sm:p-5'); c.appendChild(el('p', 'text-sm font-medium', 'When you publish')); c.appendChild(el('p', 'mb-3 text-xs text-white/40', 'Number of posts by weekday and hour. Time zone: ' + tz + '. This is about your habits; Best times shows what works.'));
    if (!sum) { c.appendChild(el('p', 'py-6 text-center text-sm text-white/50', 'No published posts in this period.')); return c; }
    var scroll = el('div', 'overflow-x-auto'), g = el('div', 'grid min-w-[300px] gap-1'); g.style.gridTemplateColumns = '2.5rem repeat(8, minmax(0, 1fr))';
    g.appendChild(el('div')); for (var h = 0; h < 8; h++) g.appendChild(el('div', 'text-center text-[10px] text-white/40', pad(h * 3)));
    DAYS.forEach(function (name, di) {
      g.appendChild(el('div', 'flex items-center text-xs text-white/50', name));
      for (var si = 0; si < 8; si++) { var n = grid[di][si], b = el('div', 'flex h-9 items-center justify-center rounded-md text-[11px] tabular-nums'); if (n) { b.style.background = 'rgba(134,239,172,' + (0.12 + 0.75 * n / max).toFixed(2) + ')'; b.style.color = n / max > 0.55 ? '#04170c' : 'rgba(255,255,255,.8)'; b.textContent = String(n); b.title = DAYS[di] + ' ' + pad(si * 3) + '–' + pad(si * 3 + 3) + ': ' + n + ' posts'; } else b.style.background = 'rgba(255,255,255,.04)'; g.appendChild(b); }
    });
    scroll.appendChild(g); c.appendChild(scroll); c.appendChild(heatLegend('134,239,172')); return c;
  }
  function heatLegend(rgb) {
    var l = el('div', 'an-heat-legend'); l.appendChild(el('span', '', 'Fewer'));
    [0.12, 0.3, 0.5, 0.7, 0.87].forEach(function (a) { var b = el('span', 'an-heat-sw'); b.style.background = 'rgba(' + rgb + ',' + a + ')'; l.appendChild(b); });
    l.appendChild(el('span', '', 'More')); return l;
  }
  var human = function (sec) { return sec < 60 ? sec + ' s' : sec < 3600 ? Math.round(sec / 60) + ' min' : (Math.round(sec / 360) / 10) + ' h'; };
  function reliability(a) {
    var c = el('div', 'glass-d rounded-2xl p-4 sm:p-5'), pu = a.punctuality; c.appendChild(el('p', 'text-sm font-medium', 'Reliability'));
    if (pu.n) {
      var pct = pu.onTimePct, tone = pct >= 95 ? '#6ee7b7' : pct >= 80 ? '#fcd34d' : '#fda4af', row = el('div', 'mt-3 flex items-center gap-4');
      var big = el('p', 'an-big', pct + '%'); big.style.color = tone; row.appendChild(big);
      var tx = el('div', 'min-w-0'); tx.appendChild(el('p', 'text-sm text-white/75', 'of posts went out within 2 minutes of the scheduled time.')); tx.appendChild(el('p', 'mt-0.5 text-xs text-white/45', 'The slowest 5% waited ' + human(pu.p95Sec) + '.'));
      row.appendChild(tx); c.appendChild(row);
      var bar = el('div', 'an-meter mt-3'), fill = el('div'); fill.style.width = pct + '%'; fill.style.background = tone; bar.appendChild(fill); c.appendChild(bar);
    } else c.appendChild(el('p', 'mt-1 text-sm text-white/65', 'No published posts in this period.'));
    if (!a.failures.length) { c.appendChild(el('p', 'mt-3 text-sm text-emerald-300', 'No failed posts in this period.')); return c; }
    c.appendChild(el('p', 'mb-1 mt-4 text-xs uppercase tracking-wide text-white/40', 'Why posts failed'));
    var ul = el('ul', 'space-y-1.5 text-sm text-white/70');
    a.failures.forEach(function (f) { var li = el('li', 'flex items-baseline gap-3'); li.appendChild(el('span', 'w-8 shrink-0 text-right tabular-nums text-rose-300', f.count + '×')); li.appendChild(el('span', 'min-w-0 break-words', f.reason)); ul.appendChild(li); });
    c.appendChild(ul); return c;
  }
  function renderActivity() {
    var root = $('tab-activity'); root.textContent = '';
    if (!S.d.channels.length) { root.appendChild(empty('No networks connected yet. Connect one in Vane Post and what Vane publishes for you shows up here.')); return; }
    root.appendChild(el('p', 'text-sm text-white/45', 'Loading…'));
    needActivity(function (a) {
      if (S.tab !== 'activity') return;
      root.textContent = '';
      if (!a) { root.appendChild(empty('Could not load the activity. Try again in a moment.')); return; }
      var t = a.totals, pv = a.prev, total = t.sent + t.failed, rate = total ? Math.round(t.sent / total * 100) : null;
      root.appendChild(el('p', 'text-sm text-white/45', 'What Vane published for you on every network, including the ones that give no numbers back.'));
      var g = el('div', 'grid grid-cols-2 gap-3 lg:grid-cols-4');
      g.appendChild(stat('Published', t.sent, null, delta(t.sent, pv.sent)));
      g.appendChild(stat('Failed', t.failed, rate === null ? null : rate + '% went through', delta(t.failed, pv.failed, true)));
      g.appendChild(stat('In the queue', a.upcoming, 'waiting to go out'));
      g.appendChild(stat('Streak', a.streak.current, 'days in a row · best ' + a.streak.longest + ' · ' + a.streak.activeDays + ' active days'));
      root.appendChild(g);
      var c = el('div', 'glass-d rounded-2xl p-4 sm:p-5'), h = el('div', 'mb-3 flex flex-wrap items-center justify-between gap-2'); h.appendChild(el('p', 'text-sm font-medium', 'Posts' + (a.days > 90 ? ' per week' : ' per day'))); h.appendChild(legendOf([['Published', COLORS[1]], ['Failed', RED]])); c.appendChild(h);
      if (total) c.appendChild(activityBars(a.daily, a.days)); else c.appendChild(el('p', 'py-8 text-center text-sm text-white/50', 'Nothing was published on these networks in the last ' + a.days + ' days.'));
      root.appendChild(c);
      if (a.byNetwork.length) root.appendChild(barRows('By network', a.byNetwork.map(function (n) { return { label: LABEL[n.type] || n.type, value: n.sent, text: n.sent + ' published' + (n.failed ? ' · ' + n.failed + ' failed' : ''), color: colorOfType(n.type) }; })));
      if (!a.pro) { root.appendChild(lock('When you publish, why posts fail, how punctual Vane is', 'See your posting habits by weekday and hour, the most common reasons posts fail, how close to the scheduled minute they go out, and every channel side by side. Up to 12 months of history.')); return; }
      root.appendChild(habitHeat(a.habits, a.timeZone));
      root.appendChild(reliability(a));
      if (a.byChannel.length) root.appendChild(barRows('By channel', a.byChannel.map(function (n) { return { label: (LABEL[n.type] || n.type) + ' · ' + n.name, value: n.sent, text: n.sent + ' published' + (n.failed ? ' · ' + n.failed + ' failed' : ''), sub: n.sent ? Math.round(n.media / n.sent * 100) + '% with media' : '', color: colorOf(n.channel_id) }; })));
      var ex = el('a', 'btn btn-ghost btn-sm inline-flex', 'Export CSV'); ex.href = '/api/analytics/export?kind=activity&days=' + a.days + '&channels=' + encodeURIComponent(a.selected.join(',')); ex.setAttribute('download', 'vane-activity.csv'); root.appendChild(ex);
    });
  }
  function actChips(box, chip) {
    var d = S.d, all = d.channels.map(function (c) { return c.id; }), cur = (S.actSel || all).filter(function (id) { return all.indexOf(id) >= 0; });
    if (!cur.length) cur = all;
    if (d.channels.length > 1) box.appendChild(chip('All', cur.length === all.length, function () { S.actSel = null; refreshAct(); }));
    d.channels.forEach(function (c) {
      var on = cur.indexOf(c.id) >= 0;
      var b = chip((LABEL[c.type] || c.type) + ' · ' + c.name, on, function () { var x = cur.slice(), i = x.indexOf(c.id); if (i >= 0) { if (x.length === 1) return; x.splice(i, 1); } else x.push(c.id); S.actSel = x.length === all.length ? null : x; refreshAct(); }, false);
      if (on) { var dot = el('span', 'mr-1.5 inline-block h-2 w-2 rounded-full align-middle'); dot.style.background = colorOf(c.id); b.insertBefore(dot, b.firstChild); }
      box.appendChild(b);
    });
  }
  function refreshAct() { renderChips(); renderTab(); }

  // ── Formats: which traits of your own posts go with more reactions
  function renderFormats() {
    var root = $('tab-formats'); root.textContent = '';
    if (!S.d.pro) { root.appendChild(lock('What works better in your posts', 'Compare posts with and without media, short and long ones, with a link, with hashtags or a question, by the reactions they get.')); return; }
    if (!S.d.selected.length) { root.appendChild(empty('Pick at least one network above.')); return; }
    root.appendChild(el('p', 'text-sm text-white/45', 'Loading…'));
    needInsights(function (j) {
      root.textContent = '';
      var f = j && j.formats;
      if (!f || f.n < 5) { root.appendChild(empty('Not enough posts with results yet. Formats need at least 5 posts that already have their numbers (' + (f ? f.n : 0) + ' so far).')); return; }
      root.appendChild(el('p', 'text-sm text-white/45', 'Average reactions per post, last ' + j.days + ' days, ' + f.n + ' posts with numbers. This shows what happened with your own posts, not why: a trait with only a few posts proves little.'));
      var grid = el('div', 'grid gap-3 sm:grid-cols-2');
      f.groups.forEach(function (gr) {
        var best = 0; gr.rows.forEach(function (r) { if (r.n >= 3) best = Math.max(best, r.avg); });
        var card = el('div', 'glass-d space-y-3 rounded-2xl p-4'); card.appendChild(el('p', 'text-sm font-medium', gr.title));
        var top = 0; gr.rows.forEach(function (r) { top = Math.max(top, r.avg); });
        gr.rows.forEach(function (r) {
          var few = r.n < 3, row = el('div', few ? 'opacity-60' : ''), head = el('div', 'flex items-baseline justify-between gap-3 text-sm'), l = el('span', 'min-w-0 truncate', r.label);
          if (!few && best && r.avg === best && gr.rows.length > 1) l.appendChild(el('span', 'ml-2 rounded bg-emerald-400/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-300', 'Best'));
          head.appendChild(l); head.appendChild(el('span', 'tabular-nums text-white/75', r.avg + ' per post')); row.appendChild(head);
          var bar = el('div', 'mt-1.5 h-2 overflow-hidden rounded-full bg-white/10'), fill = el('div', 'h-full rounded-full bg-sky-300/80'); fill.style.width = (top ? Math.max(r.avg / top * 100, r.avg ? 2 : 0) : 0) + '%'; bar.appendChild(fill); row.appendChild(bar);
          row.appendChild(el('p', 'mt-1 text-xs text-white/40', r.n + (r.n === 1 ? ' post' : ' posts') + (few ? ' · too few to tell' : ''))); card.appendChild(row);
        });
        grid.appendChild(card);
      });
      root.appendChild(grid);
    });
  }


  // ── Telegram bot
  var LANG_NAME = { en: 'English', ru: 'Русский', uk: 'Українська', de: 'Deutsch' };
  var pollTimer = null;
  function api(method, body) { return fetch('/api/analytics/bot', { method: method, credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Something went wrong.' }; }); }); }
  function note(root, text, bad) { var n = root.querySelector('[data-note]'); if (n) { n.textContent = text; n.className = 'text-sm ' + (bad ? 'text-rose-300' : 'text-emerald-300'); } }
  function botCommands() {
    var c = el('div', 'glass-d rounded-2xl p-4 sm:p-5'); c.appendChild(el('p', 'text-sm font-medium', 'What the bot can do'));
    var ul = el('ul', 'mt-2 space-y-1 text-sm text-white/65');
    [['/stats', 'totals for 7 or 30 days (Pro: 90 days, 12 months)'], ['/top', 'the most popular post on each network'], ['/followers', 'followers now and change'], ['/digest', 'a summary right now'], ['/settings', 'switch alerts on and off'], ['/language', 'English, Русский, Українська, Deutsch (English by default)']].forEach(function (x) { var li = el('li'); li.appendChild(el('code', 'rounded bg-white/10 px-1.5 py-0.5 text-xs text-white', x[0])); li.appendChild(document.createTextNode(' ' + x[1])); ul.appendChild(li); });
    c.appendChild(ul); return c;
  }
  function renderBot() {
    var root = $('tab-bot'); root.textContent = ''; clearTimeout(pollTimer);
    root.appendChild(el('p', 'text-sm text-white/45', 'Loading…'));
    api('GET').then(function (j) {
      if (S.tab !== 'bot') return;
      root.textContent = '';
      if (!j || !j.ok) { root.appendChild(empty('Could not load the bot settings. Try again in a moment.')); return; }
      if (!j.configured) { var c0 = el('div', 'glass-d rounded-2xl p-6 text-center'); c0.appendChild(el('p', 'text-base font-semibold', 'Telegram bot is coming soon')); c0.appendChild(el('p', 'mx-auto mt-2 max-w-md text-sm leading-relaxed text-white/55', 'Results of your posts, follower news and digests will arrive in Telegram. It is being switched on.')); root.appendChild(c0); root.appendChild(botCommands()); return; }
      if (!j.linked) return botConnect(root, j);
      botSettings(root, j);
    }).catch(function () { root.textContent = ''; root.appendChild(empty('Could not load the bot settings.')); });
  }
  function botConnect(root, j) {
    var c = el('div', 'glass-d rounded-2xl p-5 sm:p-6');
    c.appendChild(el('p', 'text-base font-semibold', 'Get your numbers in Telegram'));
    var ul = el('ul', 'check mt-3 space-y-1.5 text-sm text-white/70');
    ['Results of every post after 24 hours', 'Follower milestones (100, 1 000, 10 000…)', 'Most popular post on each network on request', 'Pro: daily follower changes, hot post alerts, daily or weekly digests', 'Languages: English (default), Русский, Українська, Deutsch'].forEach(function (x) { ul.appendChild(el('li', '', x)); });
    c.appendChild(ul);
    var row = el('div', 'mt-5 flex flex-wrap items-center gap-3'), b = el('button', 'btn btn-white', 'Connect Telegram'); b.type = 'button'; row.appendChild(b); var st = el('p', 'text-sm text-white/55'); st.setAttribute('data-note', ''); row.appendChild(st); c.appendChild(row);
    b.addEventListener('click', function () {
      b.disabled = true;
      api('POST', { action: 'link' }).then(function (r) {
        b.disabled = false;
        if (!r.ok) { note(c, r.error || 'Something went wrong.', true); return; }
        b.textContent = 'Open Telegram'; var a = el('a', 'btn btn-white', 'Open Telegram'); a.href = r.url; a.target = '_blank'; a.rel = 'noopener'; row.replaceChild(a, b);
        note(c, 'Press Start in Telegram. This page updates by itself.', false); st.className = 'text-sm text-white/55';
        var until = Date.now() + 15 * 60000;
        (function poll() { pollTimer = setTimeout(function () { if (S.tab !== 'bot' || Date.now() > until) return; api('GET').then(function (g) { if (g && g.ok && g.linked) renderBot(); else poll(); }).catch(poll); }, 3000); })();
      });
    });
    root.appendChild(c); root.appendChild(botCommands());
  }
  function botSettings(root, j) {
    var s = j.settings, pro = j.pro, c = el('div', 'glass-d rounded-2xl p-4 sm:p-5');
    var head = el('div', 'flex flex-wrap items-center justify-between gap-2'); head.appendChild(el('p', 'text-base font-semibold', 'Telegram is connected')); var tag = el('span', 'rounded-full bg-emerald-400/15 px-2.5 py-1 text-[11px] font-semibold uppercase text-emerald-300', 'Active'); head.appendChild(tag); c.appendChild(head);
    var status = el('p', 'mt-2 text-sm'); status.setAttribute('data-note', ''); c.appendChild(status);
    function save(patch) { var body = { action: 'save' }; Object.keys(patch).forEach(function (k) { body[k] = patch[k]; }); api('POST', body).then(function (r) { if (r && r.ok) { botSettings2(root, r); } else note(c, (r && r.error) || 'Could not save.', true); }); }
    function toggle(label, hint, key, on, locked) {
      var r = el('label', 'flex items-center justify-between gap-4 border-t border-white/[0.07] py-3 first:border-0' + (locked ? ' opacity-60' : ' cursor-pointer'));
      var l = el('div', 'min-w-0'); var t1 = el('p', 'text-sm font-medium', label); if (locked) t1.appendChild(el('span', 'ml-2 rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white/55', 'Pro')); l.appendChild(t1); l.appendChild(el('p', 'mt-0.5 text-xs text-white/45', hint)); r.appendChild(l);
      var i = el('input', 'h-5 w-5 shrink-0 accent-white'); i.type = 'checkbox'; i.checked = !!on && !locked; i.disabled = !!locked; i.addEventListener('change', function () { var p = {}; p[key] = i.checked; save(p); }); r.appendChild(i); return r;
    }
    var list = el('div', 'mt-3');
    list.appendChild(toggle('Post results', 'When a post has its numbers after 24 hours.', 'results', s.results, false));
    list.appendChild(toggle('Follower milestones', 'When a network passes 100, 250, 500, 1 000 followers and so on.', 'milestones', s.milestones, false));
    list.appendChild(toggle('Daily follower changes', 'One message a day with the change on each network.', 'followers', s.followers, !pro));
    list.appendChild(toggle('Hot post alerts', 'When a post gets more reactions than the number below.', 'hot', s.hot, !pro));
    var th = el('div', 'flex items-center justify-between gap-4 border-t border-white/[0.07] py-3' + (pro ? '' : ' opacity-60')); var tl = el('div'); tl.appendChild(el('p', 'text-sm font-medium', 'Hot post threshold')); tl.appendChild(el('p', 'mt-0.5 text-xs text-white/45', 'Reactions = likes + replies + reposts.')); th.appendChild(tl);
    var ti = el('input', 'field !w-24 text-right'); ti.type = 'number'; ti.min = 1; ti.max = 100000; ti.value = s.hotThreshold; ti.disabled = !pro; ti.addEventListener('change', function () { var n = Number(ti.value); if (!n || n < 1) { ti.value = s.hotThreshold; return; } save({ hotThreshold: Math.floor(n) }); }); th.appendChild(ti); list.appendChild(th);
    var dg = el('div', 'flex items-center justify-between gap-4 border-t border-white/[0.07] py-3' + (pro ? '' : ' opacity-60')); var dl = el('div'); var dt = el('p', 'text-sm font-medium', 'Digest'); if (!pro) dt.appendChild(el('span', 'ml-2 rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white/55', 'Pro')); dl.appendChild(dt); dl.appendChild(el('p', 'mt-0.5 text-xs text-white/45', 'A summary around 9:00 in your time zone. Weekly arrives on Monday.')); dg.appendChild(dl);
    var ds = el('select', 'field !w-auto !py-2 text-sm'); [['off', 'Off'], ['daily', 'Daily'], ['weekly', 'Weekly']].forEach(function (o) { var op = el('option', '', o[1]); op.value = o[0]; if (o[0] === s.digest) op.selected = true; ds.appendChild(op); }); ds.disabled = !pro; ds.addEventListener('change', function () { save({ digest: ds.value }); }); dg.appendChild(ds); list.appendChild(dg);
    var lg = el('div', 'flex items-center justify-between gap-4 border-t border-white/[0.07] py-3'); var ll = el('div'); ll.appendChild(el('p', 'text-sm font-medium', 'Language: ' + (LANG_NAME[s.lang] || s.lang))); ll.appendChild(el('p', 'mt-0.5 text-xs text-white/45', 'Change it in the bot with /language (English, Русский, Українська, Deutsch).')); lg.appendChild(ll); list.appendChild(lg);
    c.appendChild(list);
    if (!pro) { var up = el('p', 'mt-3 text-sm text-white/55', 'Locked options are part of Analytics Pro. '); var ua = el('a', 'text-white underline underline-offset-4', 'Get Pro'); ua.href = checkoutUrl(); up.appendChild(ua); c.appendChild(up); }
    var acts = el('div', 'mt-4 flex flex-wrap gap-2');
    var test = el('button', 'btn btn-ghost btn-sm', 'Send a test message'); test.type = 'button'; test.addEventListener('click', function () { test.disabled = true; api('POST', { action: 'test' }).then(function (r) { test.disabled = false; note(c, r.ok ? 'Sent. Look in Telegram.' : (r.error || 'Could not send.'), !r.ok); }); });
    var off = el('button', 'btn btn-ghost btn-sm', 'Disconnect'); off.type = 'button'; off.addEventListener('click', function () { if (!window.confirm('Disconnect Telegram? You will stop getting messages.')) return; api('POST', { action: 'unlink' }).then(function () { renderBot(); }); });
    acts.appendChild(test); acts.appendChild(off); c.appendChild(acts);
    root.textContent = ''; root.appendChild(c); root.appendChild(botCommands());
  }
  function botSettings2(root, j) { botSettings(root, j); }

  function renderPlans() { var root = $('tab-plans'); root.textContent = ''; root.appendChild(plansTable(S.d.pro)); }

  // ── filters and tabs
  function renderChips() {
    var d = S.d, box = $('chips'); box.textContent = '';
    var usable = d.channels.filter(function (c) { return c.results || c.followers; });
    function chip(text, on, handler, disabled, title) {
      var b = el('button', 'max-w-full truncate rounded-full border px-3 py-1.5 text-[13px] transition sm:text-sm ' + (on ? 'border-white/40 bg-white/15 text-white' : 'border-white/10 text-white/55 hover:border-white/25 hover:text-white') + (disabled ? ' cursor-not-allowed opacity-40' : ''), text);
      b.type = 'button'; b.setAttribute('aria-pressed', on ? 'true' : 'false'); if (title) b.title = title; if (disabled) b.disabled = true; else b.addEventListener('click', handler); return b;
    }
    if (S.tab === 'activity') actChips(box, chip);
    else {
    if (usable.length > 1) box.appendChild(chip('All', d.selected.length === usable.length, function () { S.sel = usable.map(function (c) { return c.id; }); store('sel', S.sel); S.page = 1; load(); }));
    d.channels.forEach(function (c) {
      var ok = c.results || c.followers, on = d.selected.indexOf(c.id) >= 0;
      var b = chip((LABEL[c.type] || c.type) + ' · ' + c.name, on, function () {
        var cur = d.selected.slice(), i = cur.indexOf(c.id); if (i >= 0) { if (cur.length === 1) return; cur.splice(i, 1); } else cur.push(c.id);
        S.sel = cur; store('sel', cur); S.page = 1; load();
      }, !ok, ok ? '' : 'No numbers from this network yet. What Vane published there is in Activity.');
      if (on) { var dot = el('span', 'mr-1.5 inline-block h-2 w-2 rounded-full align-middle'); dot.style.background = colorOf(c.id); b.insertBefore(dot, b.firstChild); }
      box.appendChild(b);
    });
    }
    if (!d.channels.length) box.appendChild(el('p', 'text-sm text-white/55', 'No networks connected yet. Connect a network in Vane Post.'));
    var sel = $('range'); sel.textContent = '';
    (d.pro ? [[7, '7 days'], [30, '30 days'], [90, '90 days'], [365, '12 months']] : [[7, '7 days'], [30, '30 days']]).forEach(function (n) { var o = el('option', '', 'Last ' + n[1]); if (n[0] === 365) o.textContent = 'Last 12 months'; o.value = n[0]; if (n[0] === d.days) o.selected = true; sel.appendChild(o); });
  }
  function renderTabs() {
    var box = $('tabs'); box.textContent = '';
    TABS.forEach(function (t) {
      var a = el('a', 'an-tab' + (S.tab === t[0] ? ' is-on' : ''), t[1]);
      a.href = '#' + t[0]; a.setAttribute('role', 'tab'); a.setAttribute('aria-selected', S.tab === t[0] ? 'true' : 'false');
      if (t[2] && !S.d.pro) a.appendChild(el('span', 'ml-1.5 rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white/55', 'Pro'));
      box.appendChild(a);
    });
    TABS.forEach(function (t) { $('tab-' + t[0]).classList.toggle('hidden', S.tab !== t[0]); });
    $('filters').classList.toggle('hidden', S.tab === 'plans' || S.tab === 'bot');
  }
  function renderTab() { ({ overview: renderOverview, activity: renderActivity, posts: renderPosts, followers: renderFollowers, compare: renderCompare, times: renderTimes, formats: renderFormats, bot: renderBot, plans: renderPlans })[S.tab](); }
  function render() {
    var d = S.d;
    $('gate').classList.add('hidden'); $('gate').classList.remove('flex'); $('dash').classList.remove('hidden');
    $('planBadge').textContent = d.pro ? 'Pro' : 'Free'; $('upgradeTop').classList.toggle('hidden', d.pro);
    $('upgradeTop').href = checkoutUrl();
    renderChips(); renderTabs(); renderTab();
  }
  function route() { var h = location.hash.slice(1); S.tab = TABS.some(function (t) { return t[0] === h; }) ? h : 'overview'; if (S.d) { renderChips(); renderTabs(); renderTab(); } }

  async function load(soft) {
    var qs = '?days=' + S.days + '&sort=' + S.sort + '&page=' + S.page + (S.sel ? '&channels=' + encodeURIComponent(S.sel.join(',')) : '') + (S.q ? '&q=' + encodeURIComponent(S.q) : '');
    $('busy').classList.add('opacity-60');
    try {
      var r = await fetch('/api/analytics/overview' + qs, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (r.status === 401) return false;
      var d = await r.json().catch(function () { return null; });
      if (!r.ok || !d || !d.ok) return false;
      S.d = d; S.days = d.days; S.sel = d.selected.slice();
      render(); return true;
    } finally { $('busy').classList.remove('opacity-60'); }
  }

  $('range').addEventListener('change', function () { S.days = Number(this.value); store('days', S.days); S.page = 1; load(); });
  window.addEventListener('hashchange', route);
  S.days = store('days') || 30; S.sel = store('sel'); S.sort = store('sort') || 'new';
  if (!Array.isArray(S.sel)) S.sel = null;
  route();
  $('gatePlans').appendChild(plansTable(false));
  function showGate() { $('gate').classList.remove('hidden'); $('gate').classList.add('flex'); }
  load().then(function (shown) { if (!shown) showGate(); }).catch(showGate);
})();
