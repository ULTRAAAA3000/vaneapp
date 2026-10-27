(function () {
  'use strict';
  var form = document.getElementById('joinForm'), note = document.getElementById('joinNote'), btn = document.getElementById('joinBtn');
  var COLORS = ['#7dd3fc', '#86efac', '#fcd34d', '#f9a8d4', '#c4b5fd', '#fdba74'];
  var LABEL = { bluesky: 'Bluesky', mastodon: 'Mastodon', telegram: 'Telegram', devto: 'Dev.to' };
  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  var fmt = function (n) { return n === null || n === undefined ? '–' : n >= 10000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(n); };

  if (form) form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var email = $('joinEmail').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { note.textContent = 'Please enter a valid email address.'; return; }
    btn.disabled = true;
    try {
      var r = await fetch('/api/waitlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email, website: $('joinWebsite').value }) });
      var d = await r.json().catch(function () { return null; });
      note.textContent = r.ok && d && d.ok ? 'Thank you. We will write to you when Vane Analytics opens.' : (d && d.error) || 'Something went wrong. Please try again.';
      if (r.ok && d && d.ok) form.reset();
    } catch (err) {
      note.textContent = 'Something went wrong. Please try again.';
    }
    btn.disabled = false;
  });

  function stat(label, value) {
    var c = el('div', 'glass-d rounded-2xl p-4');
    c.appendChild(el('p', 'text-xs text-white/50', label));
    c.appendChild(el('p', 'mt-1 text-2xl font-semibold tabular-nums', fmt(value)));
    return c;
  }

  function networkCard(n, i) {
    var c = el('div', 'glass-d rounded-2xl p-4');
    var top = el('div', 'flex items-center gap-2');
    var dot = el('span', 'h-2.5 w-2.5 rounded-full'); dot.style.background = COLORS[i % COLORS.length];
    top.appendChild(dot);
    top.appendChild(el('p', 'min-w-0 flex-1 truncate text-sm font-medium', n.name));
    top.appendChild(el('span', 'text-xs text-white/45', LABEL[n.type] || n.type));
    c.appendChild(top);
    if (n.now === null) {
      c.appendChild(el('p', 'mt-3 text-sm text-white/50', n.type === 'devto' ? 'Followers are not available for this network.' : 'The first number appears after the next daily check.'));
      return c;
    }
    var row = el('div', 'mt-3 flex items-baseline gap-2');
    row.appendChild(el('p', 'text-2xl font-semibold tabular-nums', fmt(n.now)));
    var delta = n.first === null ? 0 : n.now - n.first;
    row.appendChild(el('p', 'text-sm tabular-nums ' + (delta > 0 ? 'text-emerald-300' : delta < 0 ? 'text-rose-300' : 'text-white/45'), (delta > 0 ? '+' : '') + delta));
    c.appendChild(row);
    return c;
  }

  function chart(box, d) {
    box.textContent = '';
    if (!d.pro) {
      box.appendChild(el('p', 'text-sm font-medium', 'Followers growth is part of Analytics Pro'));
      box.appendChild(el('p', 'mt-1 text-sm leading-relaxed text-white/55', 'See how every network grows day by day, with 12 months of history, best times to publish and a weekly report. $4.99 per month, included in Vane Suite.'));
      var up = el('a', 'btn btn-white btn-sm mt-3 inline-flex', 'Get Analytics Pro');
      up.href = (/^analytics\.vaneapp\.dev$/i.test(location.hostname) ? 'https://vaneapp.dev' : '') + '/checkout?plan=analytics';
      box.appendChild(up);
      return;
    }
    var byCh = {};
    d.series.forEach(function (p) { (byCh[p.channel_id] = byCh[p.channel_id] || []).push(p); });
    var ids = Object.keys(byCh).filter(function (k) { return byCh[k].length > 1; });
    if (!ids.length) { box.appendChild(el('p', 'text-sm text-white/55', 'The chart appears after two daily checks.')); return; }
    var W = 640, H = 180, P = 12, t0 = Infinity, t1 = 0;
    ids.forEach(function (k) { byCh[k].forEach(function (p) { var t = Date.parse(p.day); t0 = Math.min(t0, t); t1 = Math.max(t1, t); }); });
    var ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('class', 'w-full'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Followers growth by day');
    [P, H - P].forEach(function (y) {
      var ln = document.createElementNS(ns, 'line'); ln.setAttribute('x1', P); ln.setAttribute('x2', W - P); ln.setAttribute('y1', y); ln.setAttribute('y2', y); ln.setAttribute('stroke', 'rgba(255,255,255,.1)'); svg.appendChild(ln);
    });
    ids.forEach(function (k) {
      var rows = byCh[k], lo = Math.min.apply(null, rows.map(function (p) { return p.followers; })), hi = Math.max.apply(null, rows.map(function (p) { return p.followers; })), span = Math.max(hi - lo, 1);
      var pts = rows.map(function (p) { var x = P + ((Date.parse(p.day) - t0) / Math.max(t1 - t0, 1)) * (W - 2 * P), y = hi === lo ? H / 2 : H - P - ((p.followers - lo) / span) * (H - 2 * P); return x.toFixed(1) + ',' + y.toFixed(1); });
      var pl = document.createElementNS(ns, 'polyline'); pl.setAttribute('points', pts.join(' ')); pl.setAttribute('fill', 'none'); pl.setAttribute('stroke', COLORS[d.networks.findIndex(function (n) { return n.channel_id === k; }) % COLORS.length]); pl.setAttribute('stroke-width', '2'); pl.setAttribute('stroke-linejoin', 'round'); svg.appendChild(pl);
    });
    box.appendChild(svg);
    box.appendChild(el('p', 'mt-2 text-xs text-white/40', 'Each line is scaled to its own range, so you see the shape of growth, not the size of the audience.'));
  }

  function postRow(p) {
    var r = el('div', 'glass-d flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl p-3 sm:p-4');
    var left = el('div', 'min-w-0 flex-1 basis-60');
    left.appendChild(el('p', 'truncate text-sm', p.content.replace(/\s+/g, ' ')));
    left.appendChild(el('p', 'mt-0.5 text-xs text-white/45', (LABEL[p.type] || p.type) + ' · ' + p.channel + ' · ' + new Date(p.sent_at * 1000).toLocaleDateString()));
    r.appendChild(left);
    var nums = el('div', 'flex gap-4 text-sm tabular-nums text-white/75');
    [['views', p.views], ['likes', p.likes], ['replies', p.replies], ['reposts', p.reposts]].forEach(function (x) {
      var c = el('div', 'text-center'); c.appendChild(el('p', 'font-medium', fmt(x[1]))); c.appendChild(el('p', 'text-[10px] uppercase tracking-wide text-white/40', x[0])); nums.appendChild(c);
    });
    r.appendChild(nums);
    return r;
  }

  var current = null;
  async function load(days) {
    var r = await fetch('/api/analytics/overview' + (days ? '?days=' + days : ''), { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (r.status === 401) return false;
    var d = await r.json().catch(function () { return null; });
    if (!r.ok || !d || !d.ok) return false;
    render(d);
    return true;
  }

  function render(d) {
    $('gate').classList.add('hidden'); $('dash').classList.remove('hidden');
    $('planBadge').textContent = d.pro ? 'Pro' : 'Free';
    var sel = $('range'); sel.textContent = '';
    (d.pro ? [30, 90, 365] : [7, 30]).forEach(function (n) { var o = el('option', '', n === 365 ? '12 months' : 'Last ' + n + ' days'); o.value = n; if (n === d.days) o.selected = true; sel.appendChild(o); });
    var st = $('stats'); st.textContent = '';
    [['Posts', d.totals.posts], ['Views', d.totals.views], ['Likes', d.totals.likes], ['Replies', d.totals.replies], ['Reposts', d.totals.reposts]].forEach(function (x) { st.appendChild(stat(x[0], x[1])); });
    var nw = $('networks'); nw.textContent = '';
    if (!d.networks.length) nw.appendChild(el('p', 'text-sm text-white/55', 'Connect Bluesky, Mastodon or Telegram in Vane Post to see followers here.'));
    d.networks.forEach(function (n, i) { nw.appendChild(networkCard(n, i)); });
    chart($('chartBox'), d);
    var list = $('posts'); list.textContent = '';
    if (!d.posts.length) list.appendChild(el('p', 'text-sm text-white/55', 'No published posts in this period yet. Results show up an hour after a post goes out.'));
    d.posts.forEach(function (p) { list.appendChild(postRow(p)); });
    $('postsNote').textContent = d.pro ? '' : 'Free shows your ' + d.freePosts + ' latest posts. Analytics Pro keeps the full history.';
  }

  $('range') && $('range').addEventListener('change', function () { load(Number(this.value)); });
  function showGate() { $('gate').classList.remove('hidden'); $('gate').classList.add('flex'); }
  load().then(function (shown) { if (!shown) showGate(); }).catch(showGate);
})();
