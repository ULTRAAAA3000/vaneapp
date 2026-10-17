/* Vane admin: one page, hash-routed sections. Same conventions as dashboard.js (var / function, no build step). */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var esc = Vane.esc;
  var S = { signedIn: false, seq: 0, days: 30, gscDays: 28, usersQ: '', usersPage: 1, att: { kind: '', ok: '', q: '', ip: '', page: 1 }, plans: [] };

  // ───────────────────────── helpers ─────────────────────────
  function call(method, path, body) {
    return Vane.api(method, path, body, { noRedirect: true }).then(function (r) {
      if (r.status === 401 && S.signedIn && path.indexOf('/api/admin/login') !== 0) toGate('Your session expired. Sign in again.');
      return r;
    });
  }
  function num(x) { return Number(x || 0).toLocaleString('en-US'); }
  function money(c, cur) {
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD' }).format((c || 0) / 100); }
    catch (e) { return '$' + ((c || 0) / 100).toFixed(2); }
  }
  function dur(s) {
    s = Math.round(s || 0);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }
  function pct(x) { return (Math.round((x || 0) * 10) / 10) + '%'; }
  function when(ts) {
    if (!ts) return '—';
    return new Date(ts * 1000).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function ago(ts) {
    if (!ts) return 'never';
    var s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
    if (s < 90) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' d ago';
  }
  function flag(cc) {
    if (!cc || cc === '??') return '🌐';
    if (cc === 'T1') return '🧅';
    if (!/^[A-Z]{2}$/.test(cc)) return '🌐';
    return String.fromCodePoint.apply(null, cc.split('').map(function (c) { return 127397 + c.charCodeAt(0); }));
  }
  function place(country, city) { return flag(country) + ' ' + esc((city ? city + ', ' : '') + (country || '??')); }
  function tag(text, kind) { return '<span class="tag' + (kind ? ' tag-' + kind : '') + '">' + esc(text) + '</span>'; }
  function money0(c) { return money(c).replace(/\.00$/, ''); }

  // ───────────────────────── building blocks ─────────────────────────
  function card(title, body, right, cls) {
    return '<section class="glass-d rounded-3xl p-5 sm:p-6 ' + (cls || '') + '">' +
      (title || right ? '<div class="mb-4 flex items-center justify-between gap-3"><h2 class="text-sm font-semibold tracking-tight text-white/90">' + title + '</h2><div class="flex items-center gap-2">' + (right || '') + '</div></div>' : '') +
      body + '</section>';
  }
  function stat(label, value, sub) {
    return '<div class="glass-d rounded-2xl p-4"><div class="text-[11px] font-medium uppercase tracking-wider text-white/40">' + esc(label) + '</div>' +
      '<div class="mt-1.5 text-2xl font-semibold tracking-tight">' + value + '</div>' +
      (sub ? '<div class="mt-0.5 text-xs text-white/45">' + sub + '</div>' : '') + '</div>';
  }
  function empty(text) { return '<p class="py-6 text-center text-sm text-white/40">' + esc(text) + '</p>'; }
  function table(cols, rows, opts) {
    opts = opts || {};
    if (!rows.length) return empty(opts.empty || 'Nothing here yet.');
    var h = '<div class="scroll-x"><table class="atable"><thead><tr>' + cols.map(function (c) { return '<th class="' + (c.cls || '') + '">' + esc(c.h) + '</th>'; }).join('') + '</tr></thead><tbody>';
    rows.forEach(function (r) {
      h += '<tr' + (opts.row ? ' ' + opts.row(r) : '') + '>' + cols.map(function (c) { return '<td class="' + (c.cls || '') + '">' + c.r(r) + '</td>'; }).join('') + '</tr>';
    });
    return h + '</tbody></table></div>';
  }
  /** Stacked bar chart. series: [{ name, color, values }] */
  function bars(labels, series, height) {
    var H = height || 110, bw = 10, gap = 4, N = labels.length, W = Math.max(1, N * (bw + gap));
    var totals = labels.map(function (_, i) { return series.reduce(function (a, s) { return a + (s.values[i] || 0); }, 0); });
    var max = Math.max.apply(null, totals.concat([1]));
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" class="h-28 w-full" role="img">';
    labels.forEach(function (l, i) {
      var x = i * (bw + gap) + gap / 2, y = H;
      series.forEach(function (s) {
        var v = s.values[i] || 0, bh = (v / max) * (H - 4);
        if (bh <= 0) return;
        y -= bh;
        svg += '<rect x="' + x + '" y="' + y + '" width="' + bw + '" height="' + bh + '" rx="2" fill="' + s.color + '"><title>' + esc(l) + ' · ' + esc(s.name) + ': ' + v + '</title></rect>';
      });
      if (!totals[i]) svg += '<rect x="' + x + '" y="' + (H - 1) + '" width="' + bw + '" height="1" fill="rgba(255,255,255,.14)"/>';
    });
    svg += '</svg><div class="mt-1 flex items-center justify-between text-[10px] text-white/35"><span>' + esc(labels[0] || '') + '</span>';
    if (series.length > 1) svg += '<span class="flex gap-3">' + series.map(function (s) { return '<span><i class="mr-1 inline-block h-2 w-2 rounded-full align-middle" style="background:' + s.color + '"></i>' + esc(s.name) + '</span>'; }).join('') + '</span>';
    return svg + '<span>' + esc(labels[N - 1] || '') + '</span></div>';
  }
  function hbar(label, value, max, right, color) {
    var w = max ? Math.max(2, Math.round((value / max) * 100)) : 0;
    return '<div class="py-1.5"><div class="mb-1 flex items-center justify-between gap-3 text-xs"><span class="truncate text-white/80">' + label + '</span><span class="shrink-0 text-white/50">' + right + '</span></div>' +
      '<div class="h-1.5 overflow-hidden rounded-full bg-white/[0.07]"><div class="h-full rounded-full" style="width:' + w + '%;background:' + (color || 'rgba(255,255,255,.85)') + '"></div></div></div>';
  }
  function rangeChips(opts, cur, act) {
    return opts.map(function (d) { return '<button class="chip !px-3 !py-1.5 !text-xs" type="button" data-act="' + act + '" data-days="' + d + '" aria-pressed="' + (d === cur) + '">' + d + 'd</button>'; }).join('');
  }
  function title(h, sub, right) {
    return '<div class="mb-6 flex flex-wrap items-end justify-between gap-3"><div><h1 class="text-2xl font-semibold tracking-tight">' + h + '</h1>' +
      (sub ? '<p class="mt-1 text-sm text-white/50">' + sub + '</p>' : '') + '</div><div class="flex flex-wrap items-center gap-2">' + (right || '') + '</div></div>';
  }
  function skeleton() { return '<div class="space-y-4"><div class="skeleton h-10 w-64"></div><div class="grid grid-cols-2 gap-4 lg:grid-cols-4">' + '<div class="skeleton h-24"></div>'.repeat(8) + '</div><div class="skeleton h-56"></div></div>'; }
  function errorBox(msg) { return '<div class="rounded-2xl border border-red-400/25 bg-red-500/10 p-5 text-sm text-red-300">' + esc(msg) + '</div>'; }
  function field(id, label, value, opts) {
    opts = opts || {};
    return '<div class="' + (opts.cls || '') + '"><label class="lbl" for="' + id + '">' + esc(label) + '</label><input id="' + id + '" class="field" type="' + (opts.type || 'text') + '" value="' + esc(value == null ? '' : value) + '"' + (opts.ph ? ' placeholder="' + esc(opts.ph) + '"' : '') + (opts.attrs ? ' ' + opts.attrs : '') + ' /></div>';
  }
  function check(id, label, on) {
    return '<label class="flex cursor-pointer items-center gap-2.5 text-sm text-white/80"><input id="' + id + '" type="checkbox" class="h-4 w-4 accent-white"' + (on ? ' checked' : '') + ' /> ' + esc(label) + '</label>';
  }

  // ───────────────────────── modal + drawer ─────────────────────────
  function openModal(html) { $('modal').innerHTML = html; $('modalWrap').classList.remove('hidden'); $('modalWrap').classList.add('flex'); }
  function closeModal() { $('modalWrap').classList.add('hidden'); $('modalWrap').classList.remove('flex'); $('modal').innerHTML = ''; }
  function openDrawer(html) { $('drawer').innerHTML = html; $('drawerWrap').classList.remove('hidden'); }
  function closeDrawer() { $('drawerWrap').classList.add('hidden'); $('drawer').innerHTML = ''; }
  function confirmBox(text, actLabel, onYes, danger) {
    openModal('<h3 class="text-lg font-semibold">Are you sure?</h3><p class="mt-2 text-sm text-white/65">' + text + '</p>' +
      '<div class="mt-6 flex justify-end gap-2"><button class="btn btn-ghost" type="button" data-act="modal-close">Cancel</button><button id="confirmYes" class="btn ' + (danger ? 'btn-danger' : 'btn-white') + '" type="button">' + esc(actLabel) + '</button></div>');
    $('confirmYes').addEventListener('click', function () { closeModal(); onYes(); });
  }

  // ───────────────────────── sign-in gate ─────────────────────────
  var ts = { key: null, id: null, token: '' };
  function loadTurnstile() {
    if (!ts.key || ts.id !== null || document.getElementById('tsScript')) return;
    $('gTs').classList.remove('hidden');
    var s = document.createElement('script');
    s.id = 'tsScript';
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = function () {
      ts.id = window.turnstile.render('#gTs', {
        sitekey: ts.key, theme: 'dark', size: 'flexible',
        callback: function (t) { ts.token = t; },
        'expired-callback': function () { ts.token = ''; },
        'error-callback': function () { ts.token = ''; }
      });
    };
    document.head.appendChild(s);
  }
  function gateError(msg) { var e = $('gErr'); e.textContent = msg; e.classList.toggle('hidden', !msg); }
  function toGate(msg) {
    S.signedIn = false;
    $('panel').classList.add('hidden');
    closeDrawer(); closeModal();
    $('gate').classList.remove('hidden'); $('gate').classList.add('flex');
    if (msg) gateError(msg);
    $('gPass').value = '';
  }
  function toPanel(me) {
    S.signedIn = true;
    $('gate').classList.add('hidden'); $('gate').classList.remove('flex');
    $('panel').classList.remove('hidden');
    $('who').textContent = me.email || '';
    $('who').classList.toggle('hidden', !me.email);
    S.features = me.features || {};
    route();
  }
  $('gateForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var login = $('gLogin').value.trim(), pw = $('gPass').value;
    if (!login || !pw) return gateError('Enter your login and password.');
    if (ts.key && !ts.token) return gateError('Please complete the human check.');
    gateError('');
    $('gBtn').disabled = true; $('gBtn').textContent = 'Signing in…';
    var body = { login: login, password: pw };
    if (ts.key) body.turnstileToken = ts.token;
    call('POST', '/api/admin/login', body).then(function (r) {
      $('gBtn').disabled = false; $('gBtn').textContent = 'Sign in';
      if (r.ok) return call('GET', '/api/admin/me').then(function (m) { if (m.ok && m.data.signedIn) toPanel(m.data); else gateError('Signed in, but the session was not accepted. Check cookies.'); });
      ts.token = ''; if (ts.id !== null && window.turnstile) window.turnstile.reset(ts.id);
      gateError(r.error);
    });
  });
  $('logout').addEventListener('click', function () { call('POST', '/api/admin/logout').then(function () { toGate('Signed out.'); }); });

  // ───────────────────────── navigation ─────────────────────────
  var TABS = [['overview', 'Overview'], ['users', 'Users'], ['plans', 'Plans'], ['traffic', 'Traffic'], ['search', 'Search'], ['security', 'Security'], ['settings', 'Settings'], ['activity', 'Activity']];
  function route() {
    var tab = (location.hash || '#overview').slice(1);
    if (!TABS.some(function (t) { return t[0] === tab; })) tab = 'overview';
    $('nav').innerHTML = TABS.map(function (t) { return '<a class="nav-tab" href="#' + t[0] + '"' + (t[0] === tab ? ' aria-current="page"' : '') + '>' + t[1] + '</a>'; }).join('');
    var seq = ++S.seq;
    $('view').innerHTML = skeleton();
    VIEWS[tab](seq);
  }
  window.addEventListener('hashchange', function () { if (S.signedIn) route(); });
  function alive(seq) { return seq === S.seq; }
  function show(seq, html) { if (alive(seq)) $('view').innerHTML = html; }

  // ───────────────────────── views ─────────────────────────
  var VIEWS = {};

  // ── Overview
  VIEWS.overview = function (seq) {
    call('GET', '/api/admin/overview?days=' + S.days).then(function (r) {
      if (!alive(seq)) return;
      if (!r.ok) return show(seq, errorBox(r.error));
      var d = r.data, t = d.traffic, u = d.users, rv = d.revenue, c = d.content, sec = d.security.last24h;
      var sent = (c.posts.sent || 0), totalPosts = Object.keys(c.posts).reduce(function (a, k) { return a + c.posts[k]; }, 0);
      var top = d.funnel[0].count || 0;
      var funnel = d.funnel.map(function (s, i) {
        var prev = i ? d.funnel[i - 1].count : s.count;
        return hbar(esc(s.label), s.count, top, num(s.count) + (i ? ' · ' + (prev ? pct((s.count / prev) * 100) : '0%') + ' of previous' : ''), i === d.funnel.length - 1 ? '#34d399' : undefined);
      }).join('');
      var html = title('Overview', 'Last ' + d.days + ' days', rangeChips([7, 30, 90], d.days, 'range')) +
        '<div class="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">' +
          stat('Users', num(u.total), '+' + num(u.last24h) + ' today · +' + num(u.last7d) + ' this week') +
          stat('New in ' + d.days + 'd', num(u.inRange), 'sign-ups') +
          stat('Visitors', num(t.visitors), num(t.views) + ' page views') +
          stat('On the site now', num(t.activeNow), 'active in the last 90 s') +
          stat('Avg time on site', dur(t.avgSessionSeconds), num(t.sessions) + ' sessions') +
          stat('Pages / session', String(t.avgPagesPerSession), 'bounce rate ' + pct(t.bounceRate)) +
          stat('MRR', money0(rv.mrrCents), num(rv.paidSubscribers) + ' paying · ' + num(rv.activeGrants) + ' granted free') +
          stat('Posts', num(totalPosts), num(sent) + ' sent · ' + num(c.channels) + ' channels · ' + num(c.waitlist) + ' on the waitlist') +
        '</div>' +
        '<div class="mt-4 grid gap-4 lg:grid-cols-2">' +
          card('Visitors per day', bars(d.series.labels, [{ name: 'Visitors', color: 'rgba(125,211,252,.85)', values: d.series.visitors }])) +
          card('Sign-ups per day', bars(d.series.labels, [{ name: 'Sign-ups', color: 'rgba(167,243,208,.9)', values: d.series.signups }])) +
        '</div>' +
        '<div class="mt-4 grid gap-4 lg:grid-cols-5">' +
          card('Conversion funnel', funnel + '<p class="mt-3 text-xs text-white/40">Visitors and sign-in views come from the page-view tracker; the later steps count users who signed up in this period.</p>', '', 'lg:col-span-3') +
          card('Where sign-ups come from', table(
            [{ h: 'Source', r: function (x) { return esc(x.source); } }, { h: 'Visitors', cls: 'text-right', r: function (x) { return num(x.visitors); } }, { h: 'Sign-ups', cls: 'text-right', r: function (x) { return num(x.signups); } },
             { h: 'Conv.', cls: 'text-right', r: function (x) { return x.visitors ? pct((x.signups / x.visitors) * 100) : '—'; } }], d.sources, { empty: 'No visits recorded yet.' }), '', 'lg:col-span-2') +
        '</div>' +
        card('Security, last 24 h', '<div class="grid grid-cols-2 gap-3 sm:grid-cols-5">' +
          stat('Sign-ins ok', num(sec.loginOk)) + stat('Sign-ins failed', '<span class="' + (sec.loginFail ? 'text-amber-300' : '') + '">' + num(sec.loginFail) + '</span>') +
          stat('Sign-ups', num(sec.registerOk), num(sec.registerFail) + ' refused') + stat('Admin failures', '<span class="' + (sec.adminFail ? 'text-red-300' : '') + '">' + num(sec.adminFail) + '</span>') +
          stat('Active blocks', num(d.security.activeBlocks), '<a class="underline" href="#security">manage</a>') + '</div>', '', 'mt-4');
      show(seq, html);
    });
  };

  // ── Users
  function loadUsers(seq) {
    call('GET', '/api/admin/users?q=' + encodeURIComponent(S.usersQ) + '&page=' + S.usersPage).then(function (r) {
      if (!alive(seq)) return;
      var box = $('usersBox');
      if (!box) return;
      if (!r.ok) { box.innerHTML = errorBox(r.error); return; }
      var d = r.data, pages = Math.max(1, Math.ceil(d.total / d.pageSize));
      box.innerHTML = table([
        { h: 'User', r: function (u) { return '<div class="font-medium">' + esc(u.email) + '</div><div class="text-xs text-white/40">' + esc(u.name || '—') + '</div>'; } },
        { h: 'Plan', r: function (u) { return tag(u.plan, u.plan === 'Free' ? '' : 'info'); } },
        { h: 'Channels', cls: 'text-right', r: function (u) { return num(u.channels); } },
        { h: 'Posts', cls: 'text-right', r: function (u) { return num(u.posts); } },
        { h: 'Time on site', cls: 'text-right', r: function (u) { return u.time_on_site ? dur(u.time_on_site) : '—'; } },
        { h: 'Last sign-in', r: function (u) { return esc(ago(u.last_login)); } },
        { h: 'Joined', r: function (u) { return esc(when(u.created_at)); } },
        { h: '', r: function (u) { return u.disabled ? tag('disabled', 'bad') : ''; } }
      ], d.users, { row: function (u) { return 'class="clickable" data-act="user" data-id="' + esc(u.id) + '"'; }, empty: 'No users match.' }) +
      '<div class="mt-4 flex items-center justify-between text-xs text-white/50"><span>' + num(d.total) + ' users · page ' + d.page + ' of ' + pages + '</span><span class="flex gap-2">' +
      '<button class="btn btn-ghost btn-sm" type="button" data-act="upage" data-dir="-1"' + (d.page <= 1 ? ' disabled' : '') + '>Prev</button>' +
      '<button class="btn btn-ghost btn-sm" type="button" data-act="upage" data-dir="1"' + (d.page >= pages ? ' disabled' : '') + '>Next</button></span></div>';
    });
  }
  VIEWS.users = function (seq) {
    show(seq, title('Users', 'Search, open a user to give a plan, see their time on site or switch the account off.') +
      '<div class="glass-d rounded-3xl p-5 sm:p-6"><input id="usersQ" class="field mb-4 max-w-md" type="search" placeholder="Search by e-mail or name…" value="' + esc(S.usersQ) + '" autocomplete="off" />' +
      '<div id="usersBox"><div class="skeleton h-48"></div></div></div>');
    var t;
    $('usersQ').addEventListener('input', function (e) { clearTimeout(t); t = setTimeout(function () { S.usersQ = e.target.value.trim(); S.usersPage = 1; loadUsers(seq); }, 250); });
    loadUsers(seq);
  };

  function subRow(s) {
    var live = s.status === 'active' && (!s.ends_at || s.ends_at > Date.now() / 1000);
    return '<div class="flex items-center justify-between gap-3 border-t border-white/[0.06] py-2.5 text-sm"><div class="min-w-0"><div class="font-medium">' + esc(s.plan_name) + ' ' +
      (live ? tag('active', 'ok') : tag(s.status === 'active' ? 'expired' : s.status)) + ' ' + (s.source === 'admin' ? tag('granted') : tag(s.source, 'info')) + '</div>' +
      '<div class="text-xs text-white/45">' + esc(when(s.started_at)) + ' → ' + (s.ends_at ? esc(when(s.ends_at)) : 'no end date') + (s.note ? ' · ' + esc(s.note) : '') + '</div></div>' +
      (live ? '<button class="btn btn-danger btn-sm" type="button" data-act="revoke" data-id="' + esc(s.id) + '">End</button>' : '') + '</div>';
  }
  function openUser(id) {
    openDrawer('<div class="skeleton h-8 w-48"></div><div class="skeleton mt-4 h-64"></div>');
    Promise.all([call('GET', '/api/admin/users?id=' + encodeURIComponent(id)), call('GET', '/api/admin/plans')]).then(function (rs) {
      var r = rs[0];
      if (!r.ok) return openDrawer(errorBox(r.error));
      var d = r.data, u = d.user, a = d.attribution, tos = d.timeOnSite || {};
      var grantable = rs[1].ok ? rs[1].data.plans.filter(function (p) { return p.kind === 'plan' && p.isActive; }) : [];
      var postTotal = Object.keys(d.posts).reduce(function (x, k) { return x + d.posts[k]; }, 0);
      openDrawer(
        '<div class="flex items-start justify-between gap-3"><div class="min-w-0"><h2 class="truncate text-xl font-semibold">' + esc(u.email) + '</h2>' +
        '<p class="mt-0.5 text-sm text-white/50">' + esc(u.name || 'No name') + ' · joined ' + esc(when(u.created_at)) + ' · ' + esc(u.timezone) + '</p></div>' +
        '<button class="btn btn-ghost btn-sm" type="button" data-act="drawer-close">Close</button></div>' +
        (u.disabled ? '<div class="mt-4 rounded-xl border border-red-400/25 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-300">Account disabled' + (u.disabled_reason ? ': ' + esc(u.disabled_reason) : '') + '</div>' : '') +
        '<div class="mt-5 grid grid-cols-3 gap-3">' + stat('Plan', esc(d.plan.name), d.plan.subscription ? (d.plan.subscription.source === 'admin' ? 'given by hand' : 'paid') : 'default') +
          stat('Time on site', tos.total ? dur(tos.total) : '—', num(tos.visits) + ' visits · ' + num(tos.views) + ' pages') + stat('Posts', num(postTotal), num(d.posts.sent || 0) + ' sent') + '</div>' +
        '<h3 class="mt-7 text-sm font-semibold">Give a plan</h3>' +
        '<form id="grantForm" class="mt-3 grid grid-cols-2 gap-3" data-id="' + esc(u.id) + '"><div class="col-span-2"><label class="lbl" for="gPlan">Plan</label><select id="gPlan" class="field">' +
          grantable.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.name) + ' · ' + money0(p.priceCents) + '</option>'; }).join('') + '</select></div>' +
          field('gDays', 'For (days)', '', { ph: 'empty = no end date', type: 'number', attrs: 'min="1" max="3650"' }) + field('gNote', 'Note', '', { ph: 'e.g. beta tester' }) +
          '<div class="col-span-2 flex items-center justify-between gap-3"><p class="text-xs text-white/40">Granted plans are free and never counted as revenue.</p><button class="btn btn-white btn-sm" type="submit">Give plan</button></div></form>' +
        '<h3 class="mt-7 text-sm font-semibold">Subscriptions</h3><div class="mt-2">' + (d.subscriptions.length ? d.subscriptions.map(subRow).join('') : '<p class="text-sm text-white/40">None yet. They are on Free.</p>') + '</div>' +
        '<h3 class="mt-7 text-sm font-semibold">Where they came from</h3><p class="mt-2 text-sm text-white/70">' + (a ? esc((a.ref_host || 'direct') + (a.utm_source ? ' · utm ' + a.utm_source : '') + ' · landed on ' + (a.landing_path || '?')) + ' · ' + flag(a.country) + ' ' + esc(a.country || '??') : 'Unknown.') + '</p>' +
        '<h3 class="mt-7 text-sm font-semibold">Channels (' + d.channels.length + ')</h3><div class="mt-2 flex flex-wrap gap-2">' + (d.channels.length ? d.channels.map(function (c) { return tag(c.type + ' · ' + c.name, c.is_active ? '' : 'warn'); }).join('') : '<span class="text-sm text-white/40">No channels.</span>') + '</div>' +
        '<h3 class="mt-7 text-sm font-semibold">Pages they open</h3>' + (d.pages.length ? d.pages.map(function (p) { return hbar(esc(p.path), p.views, d.pages[0].views, num(p.views) + ' views · ' + dur(p.avg_time) + ' avg'); }).join('') : '<p class="mt-2 text-sm text-white/40">No tracked visits.</p>') +
        '<h3 class="mt-7 text-sm font-semibold">Recent sign-in attempts</h3>' + table([
          { h: 'When', r: function (x) { return esc(when(x.ts)); } }, { h: 'What', r: function (x) { return esc(x.kind) + ' ' + (x.ok ? tag('ok', 'ok') : tag(x.reason || 'failed', 'bad')); } }, { h: 'From', r: function (x) { return place(x.country, x.city) + '<div class="text-[11px] text-white/35">' + esc(x.ip) + '</div>'; } }
        ], d.attempts, { empty: 'No attempts recorded.' }) +
        '<div class="mt-8 border-t border-white/[0.08] pt-5">' + (u.disabled
          ? '<button class="btn btn-white" type="button" data-act="enable" data-id="' + esc(u.id) + '">Enable account</button>'
          : '<button class="btn btn-danger" type="button" data-act="disable" data-id="' + esc(u.id) + '" data-email="' + esc(u.email) + '">Disable account…</button><p class="mt-2 text-xs text-white/40">Signs them out everywhere and refuses their sign-in. Their data is kept.</p>') + '</div>');
      $('grantForm').addEventListener('submit', function (e) {
        e.preventDefault();
        var days = $('gDays').value.trim();
        call('POST', '/api/admin/users', { action: 'grant', userId: e.target.dataset.id, planId: $('gPlan').value, days: days ? Number(days) : null, note: $('gNote').value.trim() }).then(function (g) {
          if (g.ok) { Vane.toast('ok', 'Plan given.'); openUser(id); if (location.hash === '#users') loadUsers(S.seq); } else Vane.toast('err', g.error);
        });
      });
    });
  }

  // ── Plans
  var LIMITS = [
    ['channels', 'Connected channels', 'int'], ['postsPerMonth', 'Posts per month', 'int'], ['postsLifetime', 'Posts in total (lifetime)', 'int'],
    ['aiCredits', 'AI credits', 'int'], ['apiPostsPerMonth', 'API posts per month', 'int'], ['seats', 'Team seats', 'int'],
    ['overagePostUsd', 'Extra post price, USD', 'float'], ['overageAiPostUsd', 'Extra AI post price, USD', 'float']
  ];
  var PROVIDERS = [['monobank', 'Monobank Acquiring'], ['crypto', 'Crypto (Solana / USDT)'], ['stripe', 'Stripe']];

  function limitsSummary(l) {
    var out = [];
    LIMITS.forEach(function (x) { if (typeof l[x[0]] === 'number') out.push(x[1].replace(', USD', '') + ': ' + (x[2] === 'float' ? '$' + l[x[0]] : num(l[x[0]]))); });
    return out.length ? out.join(' · ') : 'No limits';
  }
  VIEWS.plans = function (seq) {
    call('GET', '/api/admin/plans').then(function (r) {
      if (!alive(seq)) return;
      if (!r.ok) return show(seq, errorBox(r.error));
      S.plans = r.data.plans;
      var cards = S.plans.map(function (p) {
        var price = p.priceCents === 0 ? 'Free' : money(p.priceCents, p.currency) + '<span class="text-sm font-normal text-white/45"> / ' + p.interval + '</span>';
        return '<article class="glass-d flex flex-col rounded-3xl p-5 ' + (p.highlight ? 'ring-1 ring-white/40' : '') + '">' +
          '<div class="flex items-start justify-between gap-2"><div><div class="text-[11px] font-medium uppercase tracking-wider text-white/40">' + esc(p.id) + ' · ' + esc(p.kind) + '</div><h3 class="mt-1 text-lg font-semibold">' + esc(p.name) + '</h3></div>' +
          '<div class="flex flex-wrap justify-end gap-1">' + (p.isPublic ? tag('on landing', 'ok') : tag('hidden')) + (p.isActive ? '' : tag('inactive', 'warn')) + (p.comingSoon ? tag('coming soon', 'info') : '') + (p.badge ? tag(p.badge) : '') + '</div></div>' +
          '<div class="mt-3 text-3xl font-semibold tracking-tight">' + price + '</div>' +
          '<p class="mt-1 text-xs text-white/45">' + (p.comparePriceCents ? 'was <s>' + money0(p.comparePriceCents) + '</s> · ' : '') + (p.yearlyPriceCents ? money0(p.yearlyPriceCents) + ' / year' : 'no yearly price') + '</p>' +
          '<p class="mt-3 text-xs leading-relaxed text-white/55">' + esc(limitsSummary(p.limits)) + '</p>' +
          '<p class="mt-2 text-xs text-white/45">' + p.features.length + ' features · ' + num(p.activeSubscribers) + ' active (' + num(p.paidSubscribers) + ' paying)</p>' +
          '<div class="mt-auto pt-4"><button class="btn btn-ghost btn-sm w-full" type="button" data-act="plan-edit" data-id="' + esc(p.id) + '">Edit</button></div></article>';
      }).join('');
      show(seq, title('Plans and prices', 'Everything here is live: the landing page pricing and the plan limits read these rows. Public changes appear within a minute.',
        '<button class="btn btn-white btn-sm" type="button" data-act="plan-new">+ New plan</button>') +
        '<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">' + cards + '</div>' +
        card('How this connects to payments', '<ul class="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-white/60"><li>Prices are stored as integer cents with a currency, plus an optional yearly price and a "was" price, so a checkout can charge exactly what the card shows.</li>' +
          '<li>Every plan has a slot for the provider reference (Monobank, crypto, Stripe). When the payment system is added it only has to create a subscription row; limits and the admin already read them.</li>' +
          '<li>A "2 in 1" or "Ultra" plan is just a new plan with its own price and limits. Give it to a user from the Users tab, or sell it once checkout exists.</li>' +
          '<li>Limits are only applied to users while <b>Enforce plan limits</b> is on in Settings (it is off by default).</li></ul>', '', 'mt-4'));
    });
  };

  function planForm(p) {
    var creating = !p;
    p = p || { id: '', kind: 'plan', name: '', tagline: '', badge: '', priceCents: 0, comparePriceCents: null, yearlyPriceCents: null, currency: 'USD', interval: 'month', trialDays: 0, features: [], limits: {}, ctaLabel: 'Join the waitlist', highlight: false, comingSoon: false, isPublic: true, isActive: true, sort: 100, providerRefs: {} };
    var dollars = function (c) { return c == null ? '' : (c / 100).toFixed(2); };
    openModal('<form id="planForm" novalidate data-creating="' + creating + '"><h3 class="text-xl font-semibold">' + (creating ? 'New plan' : 'Edit ' + esc(p.name)) + '</h3>' +
      '<div class="mt-5 grid gap-4 sm:grid-cols-2">' +
        field('pId', 'Id (slug)', p.id, { ph: 'ultra', attrs: creating ? 'maxlength="31"' : 'disabled' }) +
        '<div><label class="lbl" for="pKind">Shown as</label><select id="pKind" class="field"><option value="plan"' + (p.kind === 'plan' ? ' selected' : '') + '>A card in the pricing grid</option><option value="addon"' + (p.kind === 'addon' ? ' selected' : '') + '>The add-on strip under the grid</option></select></div>' +
        field('pName', 'Name', p.name, { ph: 'Ultra', cls: 'sm:col-span-2', attrs: 'maxlength="60"' }) +
        field('pTagline', 'Tagline (small text under the price)', p.tagline, { cls: 'sm:col-span-2', attrs: 'maxlength="240"' }) +
        field('pPrice', 'Price (USD per interval)', dollars(p.priceCents), { type: 'number', attrs: 'min="0" step="0.01"' }) +
        '<div><label class="lbl" for="pInterval">Billing interval</label><select id="pInterval" class="field">' + ['month', 'year', 'once'].map(function (i) { return '<option' + (p.interval === i ? ' selected' : '') + '>' + i + '</option>'; }).join('') + '</select></div>' +
        field('pCompare', 'Old price (struck through)', dollars(p.comparePriceCents), { type: 'number', ph: 'optional', attrs: 'min="0" step="0.01"' }) +
        field('pYearly', 'Yearly price', dollars(p.yearlyPriceCents), { type: 'number', ph: 'optional', attrs: 'min="0" step="0.01"' }) +
        field('pCurrency', 'Currency', p.currency, { attrs: 'maxlength="3"' }) + field('pTrial', 'Trial days', p.trialDays, { type: 'number', attrs: 'min="0" max="365"' }) +
        field('pBadge', 'Badge', p.badge, { ph: 'Early Bird', attrs: 'maxlength="24"' }) + field('pCta', 'Button text', p.ctaLabel, { attrs: 'maxlength="40"' }) +
        field('pSort', 'Order (lower = first)', p.sort, { type: 'number' }) +
        '<div class="grid grid-cols-2 content-center gap-2.5">' + check('pPublic', 'Show on the landing page', p.isPublic) + check('pActive', 'Can be given / bought', p.isActive) + check('pHighlight', 'Highlight the card', p.highlight) + check('pSoon', 'Coming soon', p.comingSoon) + '</div>' +
        '<div class="sm:col-span-2"><label class="lbl" for="pFeatures">Features (one per line)</label><textarea id="pFeatures" class="field" rows="6">' + esc(p.features.join('\n')) + '</textarea></div>' +
      '</div>' +
      '<h4 class="mt-6 text-sm font-semibold">Limits <span class="font-normal text-white/40">(leave empty = unlimited)</span></h4><div class="mt-3 grid gap-4 sm:grid-cols-2">' +
        LIMITS.map(function (l) { return field('pL_' + l[0], l[1], typeof p.limits[l[0]] === 'number' ? p.limits[l[0]] : '', { type: 'number', attrs: 'min="0"' + (l[2] === 'float' ? ' step="0.001"' : ' step="1"') }); }).join('') + '</div>' +
      '<h4 class="mt-6 text-sm font-semibold">Payment provider references <span class="font-normal text-white/40">(filled in when checkout exists)</span></h4><div class="mt-3 grid gap-4 sm:grid-cols-3">' +
        PROVIDERS.map(function (x) { return field('pR_' + x[0], x[1], p.providerRefs[x[0]] || '', { ph: 'product / price id' }); }).join('') + '</div>' +
      '<div id="planErr" role="alert" class="mt-5 hidden rounded-xl border border-red-400/25 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-300"></div>' +
      '<div class="mt-6 flex items-center justify-between gap-3"><div>' + (creating || p.id === 'free' ? '' : '<button class="btn btn-danger btn-sm" type="button" data-act="plan-delete" data-id="' + esc(p.id) + '">Delete</button>') + '</div>' +
      '<div class="flex gap-2"><button class="btn btn-ghost" type="button" data-act="modal-close">Cancel</button><button class="btn btn-white" type="submit">' + (creating ? 'Create plan' : 'Save changes') + '</button></div></div></form>');
    $('planForm').addEventListener('submit', function (e) { e.preventDefault(); savePlan(creating, p.id); });
  }
  function cents(id) {
    var v = $(id).value.trim();
    if (v === '') return null;
    var n = Math.round(parseFloat(v) * 100);
    return isNaN(n) ? NaN : n;
  }
  function savePlan(creating, id) {
    var err = function (m) { var b = $('planErr'); b.textContent = m; b.classList.toggle('hidden', !m); };
    var price = cents('pPrice');
    if (price === null || isNaN(price)) return err('Enter a price (0 for free).');
    var compare = cents('pCompare'), yearly = cents('pYearly');
    if (isNaN(compare) || isNaN(yearly)) return err('Old price / yearly price must be numbers.');
    var limits = {};
    for (var i = 0; i < LIMITS.length; i++) {
      var raw = $('pL_' + LIMITS[i][0]).value.trim();
      if (raw === '') continue;
      var v = Number(raw);
      if (isNaN(v) || v < 0) return err('Limit "' + LIMITS[i][1] + '" must be a positive number.');
      limits[LIMITS[i][0]] = v;
    }
    var refs = {};
    PROVIDERS.forEach(function (x) { var v = $('pR_' + x[0]).value.trim(); if (v) refs[x[0]] = v; });
    var body = {
      kind: $('pKind').value, name: $('pName').value.trim(), tagline: $('pTagline').value.trim(), badge: $('pBadge').value.trim(), ctaLabel: $('pCta').value.trim(),
      priceCents: price, comparePriceCents: compare, yearlyPriceCents: yearly, currency: $('pCurrency').value.trim().toUpperCase(), interval: $('pInterval').value,
      trialDays: Number($('pTrial').value) || 0, sort: Number($('pSort').value) || 0,
      highlight: $('pHighlight').checked, comingSoon: $('pSoon').checked, isPublic: $('pPublic').checked, isActive: $('pActive').checked,
      features: $('pFeatures').value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean), limits: limits, providerRefs: refs
    };
    if (creating) body.id = $('pId').value.trim();
    var btn = $('planForm').querySelector('button[type=submit]'); btn.disabled = true;
    call(creating ? 'POST' : 'PUT', '/api/admin/plans' + (creating ? '' : '?id=' + encodeURIComponent(id)), body).then(function (r) {
      btn.disabled = false;
      if (!r.ok) return err(r.error);
      closeModal(); Vane.toast('ok', creating ? 'Plan created.' : 'Plan saved.'); route();
    });
  }

  // ── Traffic
  VIEWS.traffic = function (seq) {
    call('GET', '/api/admin/traffic?days=' + S.days).then(function (r) {
      if (!alive(seq)) return;
      if (!r.ok) return show(seq, errorBox(r.error));
      var d = r.data, s = d.summary;
      var maxViews = d.pages.length ? d.pages[0].views : 0, maxVis = d.countries.length ? d.countries[0].visitors : 0;
      var totalDev = d.devices.reduce(function (a, x) { return a + x.visitors; }, 0) || 1;
      var maxBucket = Math.max.apply(null, d.durationBuckets.map(function (b) { return b.sessions; }).concat([1]));
      var HOURS = Array.from({ length: 24 }, function (_, h) { return (h < 10 ? '0' : '') + h + ':00'; });
      show(seq, title('Traffic', 'How long people stay and where they go. Times are measured by a heartbeat from the page, bots and blocked addresses are ignored.', rangeChips([7, 14, 30, 90], d.days, 'range')) +
        '<div class="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">' + stat('Sessions', num(s.sessions)) + stat('Avg time on site', dur(s.avgSessionSeconds), 'per session') + stat('Pages per session', String(s.avgPagesPerSession || 0)) +
          stat('On the site now', num(d.live.length), 'last 2 minutes') + '</div>' +
        '<div class="mt-4 grid gap-4 lg:grid-cols-2">' +
          card('Average session length per day', bars(d.series.labels, [{ name: 'Seconds', color: 'rgba(196,181,253,.9)', values: d.series.avgSessionSeconds }])) +
          card('How long sessions last', d.durationBuckets.map(function (b) { return hbar(esc(b.bucket), b.sessions, maxBucket, num(b.sessions)); }).join('')) +
        '</div>' +
        '<div class="mt-4 grid gap-4 lg:grid-cols-5">' +
          card('Pages', table([{ h: 'Page', r: function (p) { return '<span class="font-medium">' + esc(p.path) + '</span>'; } }, { h: 'Views', cls: 'text-right', r: function (p) { return num(p.views); } },
            { h: 'Visitors', cls: 'text-right', r: function (p) { return num(p.visitors); } }, { h: 'Avg time on page', cls: 'text-right', r: function (p) { return dur(p.avg_time); } }], d.pages, { empty: 'No page views yet.' }), '', 'lg:col-span-3') +
          card('Entry pages', d.entryPages.length ? d.entryPages.map(function (p) { return hbar(esc(p.path), p.n, d.entryPages[0].n, num(p.n)); }).join('') : empty('No visits yet.'), '', 'lg:col-span-2') +
        '</div>' +
        '<div class="mt-4 grid gap-4 lg:grid-cols-3">' +
          card('Countries', d.countries.length ? d.countries.map(function (c) { return hbar(flag(c.country) + ' ' + esc(c.country), c.visitors, maxVis, num(c.visitors) + ' visitors'); }).join('') : empty('No visits yet.')) +
          card('Sources', table([{ h: 'Referrer', r: function (x) { return esc(x.source); } }, { h: 'Visitors', cls: 'text-right', r: function (x) { return num(x.visitors); } }, { h: 'Sessions', cls: 'text-right', r: function (x) { return num(x.sessions); } }], d.sources, { empty: 'No visits yet.' }) +
            (d.utm.length ? '<div class="mt-4 text-[11px] font-medium uppercase tracking-wider text-white/40">UTM sources</div>' + d.utm.map(function (u) { return hbar(esc(u.utm), u.visitors, d.utm[0].visitors, num(u.visitors)); }).join('') : '')) +
          card('Devices', d.devices.length ? d.devices.map(function (x) { return hbar(esc(x.device), x.visitors, totalDev, pct((x.visitors / totalDev) * 100)); }).join('') : empty('No visits yet.')) +
        '</div>' +
        '<div class="mt-4 grid gap-4 lg:grid-cols-2">' +
          card('Busiest hours (UTC)', bars(HOURS, [{ name: 'Page views', color: 'rgba(125,211,252,.85)', values: d.byHour }])) +
          card('On the site right now', table([{ h: 'Page', r: function (x) { return esc(x.path); } }, { h: 'From', r: function (x) { return place(x.country, x.city); } }, { h: 'Device', r: function (x) { return esc(x.device || '?'); } }, { h: 'Here for', cls: 'text-right', r: function (x) { return dur(x.seconds); } }], d.live, { empty: 'Nobody right now.' })) +
        '</div>');
    });
  };

  // ── Search Console
  function gscSetup() {
    return card('Connect Google Search Console', '<ol class="list-decimal space-y-2 pl-5 text-sm leading-relaxed text-white/65">' +
      '<li>Google Cloud Console → create a project → enable the <b>Google Search Console API</b>.</li>' +
      '<li>IAM → Service accounts → create one → Keys → <b>Add key → JSON</b> and download it.</li>' +
      '<li>Search Console → <b>Settings → Users and permissions → Add user</b>: paste the service account e-mail (<code class="rounded bg-white/10 px-1.5 py-0.5 text-xs">…@….iam.gserviceaccount.com</code>), permission <i>Restricted</i> is enough.</li>' +
      '<li>Store the key and your property as Cloudflare secrets, then redeploy:<pre class="mt-2 overflow-x-auto rounded-xl bg-black/40 p-3 text-xs text-white/80">npx wrangler pages secret put GSC_SERVICE_ACCOUNT --project-name=vaneapp   # paste the whole JSON\nnpx wrangler pages secret put GSC_SITE_URL --project-name=vaneapp         # sc-domain:vaneapp.dev  (or https://vaneapp.dev/)</pre></li></ol>' +
      '<p class="mt-3 text-xs text-white/40">No password or login screen is stored: Vane signs a short-lived token with the service-account key and only asks for read-only access.</p>');
  }
  VIEWS.search = function (seq) {
    call('GET', '/api/admin/gsc?days=' + S.gscDays).then(function (r) {
      if (!alive(seq)) return;
      if (!r.ok) return show(seq, errorBox(r.error));
      var d = r.data;
      var head = title('Search', 'Google Search Console' + (d.site ? ' · ' + esc(d.site) : ''), d.configured ? rangeChips([7, 28, 90, 180], S.gscDays, 'gsc-range') : '');
      if (!d.configured) return show(seq, head + gscSetup());
      if (d.error) return show(seq, head + errorBox(d.error) + '<div class="mt-4">' + gscSetup() + '</div>');
      var t = d.totals;
      var list = function (rows, label) {
        return table([{ h: label, r: function (x) { return '<span class="break-all">' + esc(x.key) + '</span>'; } }, { h: 'Clicks', cls: 'text-right', r: function (x) { return num(x.clicks); } }, { h: 'Impr.', cls: 'text-right', r: function (x) { return num(x.impressions); } },
          { h: 'CTR', cls: 'text-right', r: function (x) { return pct(x.ctr * 100); } }, { h: 'Pos.', cls: 'text-right', r: function (x) { return (Math.round(x.position * 10) / 10).toString(); } }], rows, { empty: 'No data for this period.' });
      };
      var labels = d.series.map(function (x) { return x.key; });
      show(seq, head + '<div class="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">' + stat('Clicks', num(t.clicks)) + stat('Impressions', num(t.impressions)) + stat('CTR', pct(t.ctr * 100)) + stat('Avg position', (Math.round(t.position * 10) / 10).toString()) + '</div>' +
        '<div class="mt-4 grid gap-4 lg:grid-cols-2">' + card('Clicks per day', bars(labels, [{ name: 'Clicks', color: 'rgba(167,243,208,.9)', values: d.series.map(function (x) { return x.clicks; }) }])) +
          card('Impressions per day', bars(labels, [{ name: 'Impressions', color: 'rgba(125,211,252,.85)', values: d.series.map(function (x) { return x.impressions; }) }])) + '</div>' +
        '<div class="mt-4 grid gap-4 lg:grid-cols-2">' + card('Top queries', list(d.queries, 'Query')) + card('Top pages', list(d.pages, 'Page')) + '</div>' +
        '<div class="mt-4 grid gap-4 lg:grid-cols-2">' + card('Countries', list(d.countries, 'Country')) + card('Devices', list(d.devices, 'Device')) + '</div>' +
        '<p class="mt-4 text-xs text-white/35">Search Console data is delayed by about two days and cached here for 10 minutes. ' + esc(d.range.startDate) + ' → ' + esc(d.range.endDate) + '</p>');
    });
  };

  // ── Security
  function reasonTag(a) {
    if (a.ok) return tag('ok', 'ok');
    var r = a.reason || 'failed';
    return tag(r.replace('blocked:', 'blocked · ').replace(/_/g, ' '), /blocked|human|throttled/.test(r) ? 'warn' : 'bad');
  }
  function loadAttempts(seq) {
    var f = S.att, q = '?page=' + f.page + (f.kind ? '&kind=' + f.kind : '') + (f.ok !== '' ? '&ok=' + f.ok : '') + (f.ip ? '&ip=' + encodeURIComponent(f.ip) : '') + (f.q ? '&q=' + encodeURIComponent(f.q) : '');
    call('GET', '/api/admin/security/attempts' + q).then(function (r) {
      var box = $('attBox');
      if (!alive(seq) || !box) return;
      if (!r.ok) { box.innerHTML = errorBox(r.error); return; }
      var d = r.data, pages = Math.max(1, Math.ceil(d.total / d.pageSize));
      box.innerHTML = table([
        { h: 'When', r: function (a) { return '<span title="' + esc(new Date(a.ts * 1000).toISOString()) + '">' + esc(when(a.ts)) + '</span>'; } },
        { h: 'Type', r: function (a) { return esc(a.kind.replace('_', ' ')); } },
        { h: 'Result', r: reasonTag },
        { h: 'E-mail', r: function (a) { return esc(a.email || '—'); } },
        { h: 'From', r: function (a) { return place(a.country, a.city) + '<div class="text-[11px] text-white/35">' + esc(a.ip) + '</div>'; } },
        { h: 'Network', r: function (a) { return a.asn ? '<span class="text-xs">AS' + a.asn + '</span><div class="max-w-[12rem] truncate text-[11px] text-white/35">' + esc(a.as_org || '') + '</div>' : '—'; } },
        { h: '', r: function (a) { return '<button class="btn btn-ghost btn-sm" type="button" data-act="block-open" data-kind="ip" data-value="' + esc(a.ip) + '">Block</button>'; } }
      ], d.attempts, { empty: 'No attempts match.' }) +
      '<div class="mt-4 flex items-center justify-between text-xs text-white/50"><span>' + num(d.total) + ' attempts · page ' + d.page + ' of ' + pages + '</span><span class="flex gap-2">' +
      '<button class="btn btn-ghost btn-sm" type="button" data-act="apage" data-dir="-1"' + (d.page <= 1 ? ' disabled' : '') + '>Prev</button><button class="btn btn-ghost btn-sm" type="button" data-act="apage" data-dir="1"' + (d.page >= pages ? ' disabled' : '') + '>Next</button></span></div>';
    });
  }
  function blocksTable(blocks) {
    var rows = blocks.slice();
    return table([
      { h: 'Rule', r: function (b) { return '<span class="font-medium">' + esc(b.kind === 'asn' ? 'AS' + b.value : b.kind === 'country' ? flag(b.value) + ' ' + b.value : b.value) + '</span> <span class="text-white/35">' + esc(b.kind) + '</span>'; } },
      { h: 'Source', r: function (b) { return b.source === 'preset' ? tag('hosting / VPN', 'info') : b.source === 'auto' ? tag('auto-ban', 'warn') : tag('manual'); } },
      { h: 'Reason', r: function (b) { return esc(b.reason || '—'); } },
      { h: 'Until', r: function (b) { return b.expires_at ? esc(when(b.expires_at)) : 'removed manually'; } },
      { h: '', r: function (b) { return '<button class="btn btn-ghost btn-sm" type="button" data-act="unblock" data-id="' + b.id + '" data-label="' + esc(b.kind + ' ' + b.value) + '">Remove</button>'; } }
    ], rows, { empty: 'The blocklist is empty.' });
  }
  function loadBlocks(seq) {
    call('GET', '/api/admin/security/blocks').then(function (r) {
      var box = $('blocksBox');
      if (!alive(seq) || !box) return;
      box.innerHTML = r.ok ? blocksTable(r.data.blocks) : errorBox(r.error);
    });
  }
  VIEWS.security = function (seq) {
    var days = S.secDays || 7;
    call('GET', '/api/admin/security/summary?days=' + days).then(function (r) {
      if (!alive(seq)) return;
      if (!r.ok) return show(seq, errorBox(r.error));
      var d = r.data, sum = function (a) { return a.reduce(function (x, y) { return x + y; }, 0); }, f = S.att;
      var blockBtn = function (kind, value) { return '<button class="btn btn-ghost btn-sm" type="button" data-act="block-open" data-kind="' + kind + '" data-value="' + esc(value) + '">Block</button>'; };
      show(seq, title('Security', 'Every sign-in and sign-up attempt, where it came from, and who is blocked. Hosting / VPN networks are refused at sign-in and sign-up; automatic bans lift themselves.',
        rangeChips([1, 7, 30], days, 'sec-range')) +
        '<div class="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">' + stat('Sign-ins ok', num(sum(d.series.loginOk))) + stat('Sign-ins failed', num(sum(d.series.loginFail))) +
          stat('Sign-ups', num(sum(d.series.registerOk)), num(sum(d.series.registerFail)) + ' refused') + stat('Admin failures', num(sum(d.series.adminFail))) +
          stat('Blocks', num((d.blocks.manual || 0) + (d.blocks.auto || 0)), num(d.blocks.preset || 0) + ' hosting / VPN networks') + '</div>' +
        '<div class="mt-4 grid gap-4 lg:grid-cols-2">' +
          card('Sign-in attempts per day', bars(d.series.labels, [{ name: 'ok', color: 'rgba(110,231,183,.9)', values: d.series.loginOk }, { name: 'failed', color: 'rgba(252,165,165,.9)', values: d.series.loginFail }])) +
          card('Sign-ups per day', bars(d.series.labels, [{ name: 'created', color: 'rgba(125,211,252,.85)', values: d.series.registerOk }, { name: 'refused', color: 'rgba(252,211,77,.85)', values: d.series.registerFail }])) + '</div>' +
        '<div class="mt-4 grid gap-4 lg:grid-cols-2">' +
          card('Noisiest addresses', table([
            { h: 'Address', r: function (x) { return '<span class="font-medium">' + esc(x.ip) + '</span> ' + (x.blocked ? tag('blocked', 'bad') : '') + '<div class="text-[11px] text-white/35">' + place(x.country, x.city) + '</div>'; } },
            { h: 'Attempts', cls: 'text-right', r: function (x) { return num(x.total); } }, { h: 'Failed', cls: 'text-right', r: function (x) { return num(x.fails); } }, { h: 'Sign-ups', cls: 'text-right', r: function (x) { return num(x.registers); } },
            { h: '', r: function (x) { return x.blocked ? '' : blockBtn('ip', x.ip); } }], d.topIps, { empty: 'No attempts in this period.' })) +
          card('Networks (ASN)', table([
            { h: 'Network', r: function (x) { return 'AS' + x.asn + '<div class="max-w-[16rem] truncate text-[11px] text-white/35">' + esc(x.as_org || '') + '</div>'; } },
            { h: 'Attempts', cls: 'text-right', r: function (x) { return num(x.total); } }, { h: 'Failed', cls: 'text-right', r: function (x) { return num(x.fails); } },
            { h: '', r: function (x) { return blockBtn('asn', String(x.asn)); } }], d.networks, { empty: 'No network data yet (Cloudflare provides it on live traffic).' })) + '</div>' +
        '<div class="mt-4 grid gap-4 lg:grid-cols-2">' +
          card('Countries', table([{ h: 'Country', r: function (x) { return flag(x.country) + ' ' + esc(x.country); } }, { h: 'Sign-ins', cls: 'text-right', r: function (x) { return num(x.logins); } }, { h: 'Sign-ups', cls: 'text-right', r: function (x) { return num(x.registers); } },
            { h: 'Failed', cls: 'text-right', r: function (x) { return num(x.fails); } }, { h: '', r: function (x) { return x.country && x.country !== '??' ? blockBtn('country', x.country) : ''; } }], d.countries, { empty: 'No attempts in this period.' })) +
          card('What happened', table([{ h: 'Outcome', r: function (x) { return esc(String(x.reason).replace(/_/g, ' ').replace('blocked:', 'blocked · ')); } }, { h: 'Type', r: function (x) { return esc(x.kind.replace('_', ' ')); } }, { h: 'Count', cls: 'text-right', r: function (x) { return num(x.n); } }], d.reasons, { empty: 'Nothing yet.' })) + '</div>' +
        card('Attempts feed', '<div class="mb-4 grid gap-3 sm:grid-cols-4"><select id="aKind" class="field"><option value="">All types</option><option value="login"' + (f.kind === 'login' ? ' selected' : '') + '>Sign-in</option><option value="register"' + (f.kind === 'register' ? ' selected' : '') + '>Sign-up</option><option value="admin_login"' + (f.kind === 'admin_login' ? ' selected' : '') + '>Admin sign-in</option></select>' +
          '<select id="aOk" class="field"><option value="">Any result</option><option value="1"' + (f.ok === '1' ? ' selected' : '') + '>Succeeded</option><option value="0"' + (f.ok === '0' ? ' selected' : '') + '>Failed / refused</option></select>' +
          '<input id="aIp" class="field" placeholder="Exact IP" value="' + esc(f.ip) + '" /><input id="aQ" class="field" placeholder="E-mail, reason or network" value="' + esc(f.q) + '" /></div><div id="attBox"><div class="skeleton h-48"></div></div>', '', 'mt-4') +
        card('Blocklist', '<form id="blockForm" class="mb-5 grid gap-3 sm:grid-cols-6"><select id="bKind" class="field sm:col-span-1"><option value="ip">IP address</option><option value="cidr">IP range (CIDR)</option><option value="asn">Network (ASN)</option><option value="country">Country</option></select>' +
          '<input id="bValue" class="field sm:col-span-2" placeholder="203.0.113.7 · 203.0.113.0/24 · 9009 · RU" required /><input id="bReason" class="field sm:col-span-1" placeholder="Reason" /><input id="bHours" class="field sm:col-span-1" type="number" min="1" placeholder="Hours (empty = ∞)" /><button class="btn btn-white" type="submit">Block</button></form>' +
          '<div id="blocksBox"><div class="skeleton h-40"></div></div><p class="mt-3 text-xs text-white/40">You cannot block the network you are using right now. Hosting / VPN rows only apply to sign-in and sign-up and can be switched off in Settings.</p>', '', 'mt-4'));
      var ft; var refresh = function () { S.att.kind = $('aKind').value; S.att.ok = $('aOk').value; S.att.ip = $('aIp').value.trim(); S.att.q = $('aQ').value.trim(); S.att.page = 1; loadAttempts(seq); };
      ['aKind', 'aOk'].forEach(function (id) { $(id).addEventListener('change', refresh); });
      ['aIp', 'aQ'].forEach(function (id) { $(id).addEventListener('input', function () { clearTimeout(ft); ft = setTimeout(refresh, 300); }); });
      $('blockForm').addEventListener('submit', function (e) {
        e.preventDefault();
        var h = $('bHours').value.trim();
        call('POST', '/api/admin/security/blocks', { kind: $('bKind').value, value: $('bValue').value.trim(), reason: $('bReason').value.trim(), hours: h ? Number(h) : null }).then(function (x) {
          if (x.ok) { Vane.toast('ok', 'Blocked.'); $('bValue').value = ''; $('bReason').value = ''; $('bHours').value = ''; loadBlocks(seq); } else Vane.toast('err', x.error);
        });
      });
      loadAttempts(seq); loadBlocks(seq);
    });
  };
  function openBlock(kind, value) {
    var label = kind === 'asn' ? 'AS' + value : value;
    openModal('<form id="quickBlock"><h3 class="text-lg font-semibold">Block ' + esc(label) + '</h3><p class="mt-1 text-sm text-white/55">' + (kind === 'asn' ? 'Everyone on this network will be refused everywhere that checks the blocklist.' : kind === 'country' ? 'Everyone from this country will be refused.' : 'This address will be refused at sign-in and sign-up, and ignored by analytics.') + '</p>' +
      '<div class="mt-5 grid gap-4 sm:grid-cols-2">' + field('qReason', 'Reason', '', { ph: 'brute force, spam…' }) + field('qHours', 'For how many hours', kind === 'ip' ? '24' : '', { type: 'number', ph: 'empty = until removed', attrs: 'min="1"' }) + '</div>' +
      '<div class="mt-6 flex justify-end gap-2"><button class="btn btn-ghost" type="button" data-act="modal-close">Cancel</button><button class="btn btn-danger" type="submit">Block</button></div></form>');
    $('quickBlock').addEventListener('submit', function (e) {
      e.preventDefault();
      var h = $('qHours').value.trim();
      call('POST', '/api/admin/security/blocks', { kind: kind, value: value, reason: $('qReason').value.trim(), hours: h ? Number(h) : null }).then(function (r) {
        if (r.ok) { closeModal(); Vane.toast('ok', 'Blocked ' + label + '.'); if (location.hash === '#security') route(); } else Vane.toast('err', r.error);
      });
    });
  }

  // ── Settings
  var SETTING_ROWS = [
    ['Sign-in and sign-up protection', [
      ['block_hosting', 'Block hosting and VPN networks', 'Refuse sign-in and sign-up from the networks marked "hosting / VPN" in the Security blocklist (M247, DigitalOcean, OVH, AWS…).', 'bool'],
      ['block_tor', 'Block Tor', 'Refuse Tor exit nodes at sign-in and sign-up.', 'bool'],
      ['block_vpn_api', 'Ask the VPN lookup service', 'Check every address against proxycheck.io (needs the PROXYCHECK_KEY secret). If the service is down, people are let through.', 'bool'],
      ['registration_open', 'Allow new sign-ups', 'Turn off to close registration instantly, for example during an attack.', 'bool']]],
    ['Automatic bans', [
      ['auto_ban', 'Ban abusive addresses automatically', 'Addresses that keep failing to sign in, or mass-register, are blocked for a while.', 'bool'],
      ['auto_ban_login_fails', 'Failed sign-ins within 15 min', 'Ban threshold per address.', 'int'],
      ['auto_ban_registers', 'Sign-up attempts within 1 hour', 'Ban threshold per address.', 'int'],
      ['auto_ban_hours', 'Ban lasts (hours)', 'Automatic bans lift themselves after this long.', 'int']]],
    ['Product', [
      ['enforce_limits', 'Enforce plan limits', 'When on, users are stopped at their plan limits (connected channels, posts per month, lifetime posts). Off by default so you can test freely; switch it on at launch.', 'bool'],
      ['track_visits', 'Record page views', 'Feeds the Traffic tab and the conversion funnel. Respects the browser Do-Not-Track setting.', 'bool']]]
  ];
  VIEWS.settings = function (seq) {
    call('GET', '/api/admin/settings').then(function (r) {
      if (!alive(seq)) return;
      if (!r.ok) return show(seq, errorBox(r.error));
      var s = r.data.settings, i = r.data.integrations;
      var row = function (x) {
        var key = x[0];
        return '<div class="flex items-center justify-between gap-4 border-t border-white/[0.06] py-3.5 first:border-0"><div class="min-w-0"><div class="text-sm font-medium">' + esc(x[1]) + '</div><div class="mt-0.5 text-xs leading-relaxed text-white/45">' + esc(x[2]) + '</div></div>' +
          (x[3] === 'bool' ? '<button type="button" class="switch" role="switch" data-act="toggle" data-key="' + key + '" aria-checked="' + !!s[key] + '" aria-label="' + esc(x[1]) + '"></button>'
            : '<input class="field !w-24 text-right" type="number" min="1" data-act="num" data-key="' + key + '" value="' + s[key] + '" />') + '</div>';
      };
      var integ = function (name, on, hint) { return '<div class="flex items-center justify-between gap-4 border-t border-white/[0.06] py-3 first:border-0"><div><div class="text-sm font-medium">' + esc(name) + '</div><div class="text-xs text-white/45">' + esc(hint) + '</div></div>' + (on ? tag('connected', 'ok') : tag('not set')) + '</div>'; };
      show(seq, title('Settings', 'Switches take effect within seconds.') +
        '<div class="grid gap-4 lg:grid-cols-3"><div class="space-y-4 lg:col-span-2">' + SETTING_ROWS.map(function (g) { return card(esc(g[0]), g[1].map(row).join('')); }).join('') + '</div>' +
        '<div class="space-y-4">' + card('Integrations', integ('Cloudflare Turnstile', i.turnstile, 'Bot check on sign-in, sign-up and this login (TURNSTILE_SITE_KEY + TURNSTILE_SECRET_KEY)') +
          integ('Google Search Console', i.searchConsole, 'GSC_SERVICE_ACCOUNT + GSC_SITE_URL, see the Search tab') + integ('VPN lookup (proxycheck.io)', i.vpnLookup, 'PROXYCHECK_KEY') +
          integ('Admin IP allow-list', i.adminIpAllowList, 'ADMIN_ALLOW_IPS: only these addresses can reach the admin')) +
          card('Admin access', '<p class="text-sm leading-relaxed text-white/60">The login is the <code class="rounded bg-white/10 px-1 text-xs">ADMIN_EMAIL</code> secret and a password hash in <code class="rounded bg-white/10 px-1 text-xs">ADMIN_PASSWORD_HASH</code>. Neither is in the code or the database. Sessions last 8 hours, eight wrong passwords from one address ban it, and every change is written to the Activity log.</p>') + '</div></div>');
    });
  };

  // ── Activity
  VIEWS.activity = function (seq) {
    call('GET', '/api/admin/audit').then(function (r) {
      if (!alive(seq)) return;
      if (!r.ok) return show(seq, errorBox(r.error));
      show(seq, title('Activity', 'The last 200 changes made in this panel.') + card('', table([
        { h: 'When', r: function (e) { return esc(when(e.ts)); } }, { h: 'Action', r: function (e) { return '<span class="font-medium">' + esc(e.action) + '</span>'; } }, { h: 'Target', r: function (e) { return esc(e.target || '—'); } },
        { h: 'Details', r: function (e) { return '<span class="break-all text-xs text-white/50">' + esc(e.detail || '') + '</span>'; } }, { h: 'From', r: function (e) { return '<span class="text-xs text-white/50">' + esc(e.ip || '') + '</span>'; } }
      ], r.data.entries, { empty: 'No changes yet.' })));
    });
  };

  // ───────────────────────── clicks ─────────────────────────
  function putSetting(key, value, done) {
    var body = {}; body[key] = value;
    call('PUT', '/api/admin/settings', body).then(function (r) { if (r.ok) { Vane.toast('ok', 'Saved.'); if (done) done(r.data.settings); } else { Vane.toast('err', r.error); route(); } });
  }
  document.addEventListener('change', function (e) {
    var el = e.target.closest('[data-act="num"]');
    if (el) putSetting(el.dataset.key, Number(el.value));
  });
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el) { if (e.target.id === 'drawerBackdrop') closeDrawer(); if (e.target.id === 'modalBackdrop') closeModal(); return; }
    var a = el.dataset.act;
    if (a === 'range') { S.days = Number(el.dataset.days); route(); }
    else if (a === 'gsc-range') { S.gscDays = Number(el.dataset.days); route(); }
    else if (a === 'sec-range') { S.secDays = Number(el.dataset.days); route(); }
    else if (a === 'user') openUser(el.dataset.id);
    else if (a === 'upage') { S.usersPage = Math.max(1, S.usersPage + Number(el.dataset.dir)); loadUsers(S.seq); }
    else if (a === 'apage') { S.att.page = Math.max(1, S.att.page + Number(el.dataset.dir)); loadAttempts(S.seq); }
    else if (a === 'drawer-close') closeDrawer();
    else if (a === 'modal-close') closeModal();
    else if (a === 'plan-new') planForm(null);
    else if (a === 'plan-edit') planForm(S.plans.filter(function (p) { return p.id === el.dataset.id; })[0]);
    else if (a === 'plan-delete') confirmBox('Delete the plan <b>' + esc(el.dataset.id) + '</b>? This only works if nobody ever had it.', 'Delete plan', function () {
      call('DELETE', '/api/admin/plans?id=' + encodeURIComponent(el.dataset.id)).then(function (r) { if (r.ok) { Vane.toast('ok', 'Plan deleted.'); route(); } else Vane.toast('err', r.error); });
    }, true);
    else if (a === 'revoke') confirmBox('End this subscription now? The user falls back to their next best plan, or Free.', 'End it', function () {
      call('POST', '/api/admin/users', { action: 'revoke', subscriptionId: el.dataset.id }).then(function (r) { if (r.ok) { Vane.toast('ok', 'Subscription ended.'); var id = ($('grantForm') || {}).dataset ? $('grantForm').dataset.id : null; if (id) openUser(id); } else Vane.toast('err', r.error); });
    }, true);
    else if (a === 'disable') {
      openModal('<form id="disableForm"><h3 class="text-lg font-semibold">Disable ' + esc(el.dataset.email) + '</h3><p class="mt-1 text-sm text-white/55">They are signed out everywhere and cannot sign in until you enable the account again.</p>' +
        '<div class="mt-4">' + field('dReason', 'Reason (only you see it)', '', { ph: 'abuse, chargeback…' }) + '</div><div class="mt-6 flex justify-end gap-2"><button class="btn btn-ghost" type="button" data-act="modal-close">Cancel</button><button class="btn btn-danger" type="submit">Disable account</button></div></form>');
      $('disableForm').addEventListener('submit', function (ev) {
        ev.preventDefault();
        call('POST', '/api/admin/users', { action: 'disable', userId: el.dataset.id, reason: $('dReason').value.trim() }).then(function (r) { closeModal(); if (r.ok) { Vane.toast('ok', 'Account disabled.'); openUser(el.dataset.id); if (location.hash === '#users') loadUsers(S.seq); } else Vane.toast('err', r.error); });
      });
    }
    else if (a === 'enable') call('POST', '/api/admin/users', { action: 'enable', userId: el.dataset.id }).then(function (r) { if (r.ok) { Vane.toast('ok', 'Account enabled.'); openUser(el.dataset.id); if (location.hash === '#users') loadUsers(S.seq); } else Vane.toast('err', r.error); });
    else if (a === 'block-open') openBlock(el.dataset.kind, el.dataset.value);
    else if (a === 'unblock') confirmBox('Remove the block on <b>' + esc(el.dataset.label) + '</b>?', 'Remove block', function () {
      call('DELETE', '/api/admin/security/blocks?id=' + el.dataset.id).then(function (r) { if (r.ok) { Vane.toast('ok', 'Block removed.'); if ($('blocksBox')) loadBlocks(S.seq); } else Vane.toast('err', r.error); });
    });
    else if (a === 'toggle') {
      var on = el.getAttribute('aria-checked') !== 'true';
      el.setAttribute('aria-checked', String(on));
      putSetting(el.dataset.key, on);
    }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeModal(); closeDrawer(); } });

  // ───────────────────────── boot ─────────────────────────
  call('GET', '/api/admin/me').then(function (r) {
    if (r.ok && r.data.signedIn) return toPanel(r.data);
    toGate();
    if (!r.ok) return gateError(r.error);
    if (!r.data.configured) {
      $('gateNote').textContent = 'The admin is not set up on this server yet. Set the ADMIN_EMAIL and ADMIN_PASSWORD_HASH secrets (see the README).';
      $('gBtn').disabled = true;
    }
    ts.key = r.data.turnstileSiteKey || null;
    loadTurnstile();
  });
})();
