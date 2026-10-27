/* Vane admin: one page, hash-routed sections. Same conventions as dashboard.js (var / function, no build step). */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var esc = Vane.esc;
  var S = { signedIn: false, seq: 0, days: 30, gscDays: 28, usersQ: '', usersPage: 1, att: { kind: '', ok: '', q: '', ip: '', page: 1 }, plans: [], social: null };

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
  (function () {
    var nav = $('nav'), box = $('navSlider'), thumb = $('navThumb');
    function sync() {
      var over = nav.scrollWidth - nav.clientWidth;
      box.classList.toggle('on', over > 1);
      if (over <= 1) return;
      var w = Math.max(32, box.clientWidth * nav.clientWidth / nav.scrollWidth);
      thumb.style.width = w + 'px';
      thumb.style.left = (nav.scrollLeft / over) * (box.clientWidth - w) + 'px';
    }
    function moveTo(x) {
      var r = box.getBoundingClientRect(), w = thumb.offsetWidth, over = nav.scrollWidth - nav.clientWidth;
      nav.scrollLeft = Math.min(1, Math.max(0, (x - r.left - w / 2) / Math.max(r.width - w, 1))) * over;
    }
    nav.addEventListener('scroll', sync);
    window.addEventListener('resize', sync);
    new MutationObserver(sync).observe(nav, { childList: true });
    box.addEventListener('pointerdown', function (e) { box.setPointerCapture(e.pointerId); thumb.classList.add('drag'); moveTo(e.clientX); });
    box.addEventListener('pointermove', function (e) { if (thumb.classList.contains('drag')) moveTo(e.clientX); });
    box.addEventListener('pointerup', function () { thumb.classList.remove('drag'); });
    box.addEventListener('pointercancel', function () { thumb.classList.remove('drag'); });
    nav.addEventListener('wheel', function (e) { if (nav.scrollWidth > nav.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { nav.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
    sync();
  })();
  $('logout').addEventListener('click', function () { call('POST', '/api/admin/logout').then(function () { toGate('Signed out.'); }); });

  // ───────────────────────── navigation ─────────────────────────
  var TABS = [['overview', 'Overview'], ['users', 'Users'], ['plans', 'Plans'], ['orders', 'Orders'], ['networks', 'Networks'], ['integrations', 'Integrations'], ['ai', 'AI'], ['social', 'Social'], ['traffic', 'Traffic'], ['search', 'Search'], ['security', 'Security'], ['settings', 'Settings'], ['activity', 'Activity']];
  function route() {
    var tab = (location.hash || '#overview').slice(1);
    if (!TABS.some(function (t) { return t[0] === tab; })) tab = 'overview';
    $('nav').innerHTML = TABS.map(function (t) { return '<a class="nav-tab" href="#' + t[0] + '"' + (t[0] === tab ? ' aria-current="page"' : '') + '>' + t[1] + '</a>'; }).join('');
    var on = $('nav').querySelector('[aria-current]');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'center' });
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
        { h: 'Plan', r: function (u) { return tag(u.plan, u.plan_id === 'free' ? '' : 'info'); } },
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

  function usageBars(us) {
    var rows = [];
    if (us.shared) rows.push(['Posts in total', us.shared]);
    else {
      if (us.ui.limit || us.ui.used) rows.push(['Dashboard posts this month', us.ui]);
      if (us.api.limit || us.api.used) rows.push(['API posts this month', us.api]);
    }
    return rows.map(function (r) { return hbar(esc(r[0]), r[1].used, Math.max(r[1].limit, r[1].used, 1), num(r[1].used) + ' of ' + num(r[1].limit)); }).join('') +
      (us.overage.posts ? '<p class="mt-1 text-xs text-amber-300">' + num(us.overage.posts) + ' extra posts · $' + esc(String(us.overage.costUsd)) + '</p>' : '');
  }
  function openUser(id) {
    openDrawer('<div class="skeleton h-8 w-48"></div><div class="skeleton mt-4 h-64"></div>');
    Promise.all([call('GET', '/api/admin/users?id=' + encodeURIComponent(id)), call('GET', '/api/admin/plans')]).then(function (rs) {
      var r = rs[0];
      if (!r.ok) return openDrawer(errorBox(r.error));
      var d = r.data, u = d.user, a = d.attribution, tos = d.timeOnSite || {};
      var grantable = rs[1].ok ? rs[1].data.plans.filter(function (p) { return p.kind === 'plan' && p.isActive && p.id !== 'free'; }) : [];
      var postTotal = Object.keys(d.posts).reduce(function (x, k) { return x + d.posts[k]; }, 0);
      openDrawer(
        '<div class="flex items-start justify-between gap-3"><div class="min-w-0"><h2 class="truncate text-xl font-semibold">' + esc(u.email) + '</h2>' +
        '<p class="mt-0.5 text-sm text-white/50">' + esc(u.name || 'No name') + ' · joined ' + esc(when(u.created_at)) + ' · ' + esc(u.timezone) + '</p></div>' +
        '<button class="btn btn-ghost btn-sm" type="button" data-act="drawer-close">Close</button></div>' +
        (u.disabled ? '<div class="mt-4 rounded-xl border border-red-400/25 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-300">Account disabled' + (u.disabled_reason ? ': ' + esc(u.disabled_reason) : '') + '</div>' : '') +
        '<div class="mt-5 grid grid-cols-3 gap-3">' + stat('Plan', esc(d.plan.name) + (d.plan.apiAddon ? ' + API' : ''), d.plan.lapsed ? 'lapsed, on Free limits' : d.plan.provider === 'manual' ? 'given by hand' : d.plan.provider ? 'paid · ' + esc(d.plan.provider) : 'default') +
          stat('Time on site', tos.total ? dur(tos.total) : '—', num(tos.visits) + ' visits · ' + num(tos.views) + ' pages') + stat('Posts', num(postTotal), num(d.posts.sent || 0) + ' sent') + '</div>' +
        '<h3 class="mt-7 text-sm font-semibold">Plan and usage</h3><div class="glass-d mt-3 rounded-2xl p-4 text-sm"><div class="flex items-center justify-between gap-3"><div><div class="font-medium">' + esc(d.plan.name) + (d.plan.apiAddon ? ' + API add-on' : '') + ' ' + (d.plan.lapsed ? tag('lapsed', 'warn') : d.plan.id === 'free' ? tag('default') : tag(d.plan.status, 'ok')) + (d.plan.overageEnabled ? ' ' + tag('bills extra posts', 'info') : '') + '</div>' +
          '<div class="mt-0.5 text-xs text-white/45">' + (d.plan.id === 'free' ? 'No paid or granted plan.' : (d.plan.endsAt ? 'until ' + esc(when(d.plan.endsAt)) : 'no end date')) + '</div></div>' +
          (d.plan.id !== 'free' && !d.plan.lapsed ? '<button class="btn btn-danger btn-sm" type="button" data-act="revoke" data-id="' + esc(u.id) + '">End plan</button>' : '') + '</div>' +
          '<div class="mt-3">' + (d.usage ? usageBars(d.usage) : '') + '</div></div>' +
        '<h3 class="mt-7 text-sm font-semibold">Give a plan</h3>' +
        '<form id="grantForm" class="mt-3 grid grid-cols-2 gap-3" data-id="' + esc(u.id) + '"><div class="col-span-2"><label class="lbl" for="gPlan">Plan</label><select id="gPlan" class="field">' +
          grantable.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.name) + ' · ' + money0(p.priceCents) + '</option>'; }).join('') + '</select></div>' +
          field('gDays', 'For (days)', '', { ph: 'empty = no end date', type: 'number', attrs: 'min="1" max="3650"' }) + field('gNote', 'Note (kept in Activity)', '', { ph: 'e.g. beta tester' }) +
          '<div id="gAddonRow" class="col-span-2 flex flex-wrap gap-x-5 gap-y-2">' + check('gAddon', 'Add the API add-on (Pro only)', false) + check('gOver', 'Bill posts over the quota instead of stopping', false) + '</div>' +
          '<div class="col-span-2 flex items-center justify-between gap-3"><p class="text-xs text-white/40">Same as <code>npm run plan:set</code>. A granted plan is free and never counted as revenue; it replaces the current plan.</p><button class="btn btn-white btn-sm" type="submit">Give plan</button></div></form>' +
        '<h3 class="mt-7 text-sm font-semibold">Products next to the plan</h3>' +
        '<div id="accessBox" class="glass-d mt-3 space-y-3 rounded-2xl p-4 text-sm" data-id="' + esc(u.id) + '">' +
          [['studio', 'Vane Studio'], ['analytics', 'Vane Analytics Pro']].map(function (k) {
            var a2 = d.access && d.access[k[0]] || {};
            return '<div class="flex flex-wrap items-center justify-between gap-2"><div><span class="font-medium">' + k[1] + '</span> ' + (a2.active ? tag('active', 'ok') : tag('off')) +
              '<div class="text-xs text-white/45">' + (a2.active ? (a2.endsAt ? 'until ' + esc(when(a2.endsAt)) : 'no end date') + (a2.provider === 'manual' ? ' · given by hand' : a2.provider ? ' · paid · ' + esc(a2.provider) : '') : 'Not active.') + '</div></div>' +
              '<div class="flex gap-2">' + (a2.active ? '<button class="btn btn-danger btn-sm" type="button" data-product="' + k[0] + '" data-on="0">Switch off</button>' : '') + '<button class="btn btn-white btn-sm" type="button" data-product="' + k[0] + '" data-on="1">' + (a2.active ? 'Renew' : 'Switch on') + '</button></div></div>';
          }).join('') +
          '<div class="flex flex-wrap items-center justify-between gap-2"><div><span class="font-medium">API add-on</span> ' + (d.plan.apiAddon ? tag('active', 'ok') : tag('off')) + '<div class="text-xs text-white/45">Needs an active Pro plan.</div></div>' +
            '<button class="btn ' + (d.plan.apiAddon ? 'btn-danger' : 'btn-white') + ' btn-sm" type="button" data-api="' + (d.plan.apiAddon ? '0' : '1') + '">' + (d.plan.apiAddon ? 'Switch off' : 'Switch on') + '</button></div>' +
          '<div class="grid grid-cols-2 gap-3 border-t border-white/[0.08] pt-3">' + field('xDays', 'For (days)', '', { ph: 'empty = no end date', type: 'number', attrs: 'min="1" max="3650"' }) +
          '<p class="self-end text-xs text-white/40">Studio and Analytics are given free and never counted as revenue. Combine them with any plan, the API add-on and the AI Pass below.</p></div></div>' +
        '<h3 class="mt-7 text-sm font-semibold">AI Pass</h3>' +
        '<form id="passForm" class="mt-3 grid grid-cols-2 gap-3" data-id="' + esc(u.id) + '"><p class="col-span-2 text-sm">' + (d.aiPass && d.aiPass.active ? tag('active', 'ok') + ' ' + num(d.usage.ai.pass.used) + ' of ' + num(d.usage.ai.pass.credits) + ' credits used this month · ' + (d.aiPass.endsAt ? 'until ' + esc(when(d.aiPass.endsAt)) : 'no end date') : '<span class="text-white/55">Not active.</span>') + '</p>' +
          field('pDays', 'For (days)', '', { ph: 'empty = no end date', type: 'number', attrs: 'min="1" max="3650"' }) +
          '<div class="flex items-end justify-end gap-2">' + (d.aiPass && d.aiPass.active ? '<button class="btn btn-danger btn-sm" type="button" id="passOff">Switch off</button>' : '') + '<button class="btn btn-white btn-sm" type="submit">' + (d.aiPass && d.aiPass.active ? 'Renew' : 'Switch on') + '</button></div></form>' +
        '<h3 class="mt-7 text-sm font-semibold">AI credits</h3>' +
        '<form id="aiForm" class="mt-3 grid grid-cols-2 gap-3" data-id="' + esc(u.id) + '"><p class="col-span-2 text-xs text-white/55">' + (d.usage ? 'Plan: ' + (d.usage.ai.limit !== null ? num(d.usage.ai.used) + ' of ' + num(d.usage.ai.limit) + ' used' : num(d.usage.ai.used) + ' used') + ' · extra credits you gave: <b class="text-white">' + num(d.usage.ai.bonus) + '</b>' : '') + '</p>' +
          field('aCredits', 'Add credits', '', { ph: 'e.g. 100 (negative takes away)', type: 'number', attrs: 'step="1"' }) + field('aNote', 'Note (kept in Activity)', '', { ph: 'e.g. testing' }) +
          '<div class="col-span-2 flex items-center justify-between gap-3"><p class="text-xs text-white/40">Spent after the plan\'s own AI credits, before any billing. Works on any plan.</p><button class="btn btn-white btn-sm" type="submit">Add credits</button></div></form>' +
        '<h3 class="mt-7 text-sm font-semibold">Where they came from</h3><p class="mt-2 text-sm text-white/70">' + (a ? esc((a.ref_host || 'direct') + (a.utm_source ? ' · utm ' + a.utm_source : '') + ' · landed on ' + (a.landing_path || '?')) + ' · ' + flag(a.country) + ' ' + esc(a.country || '??') : 'Unknown.') + '</p>' +
        '<h3 class="mt-7 text-sm font-semibold">Channels (' + d.channels.length + ')</h3><div class="mt-2 flex flex-wrap gap-2">' + (d.channels.length ? d.channels.map(function (c) { return tag(c.type + ' · ' + c.name, c.is_active ? '' : 'warn'); }).join('') : '<span class="text-sm text-white/40">No channels.</span>') + '</div>' +
        '<h3 class="mt-7 text-sm font-semibold">Pages they open</h3>' + (d.pages.length ? d.pages.map(function (p) { return hbar(esc(p.path), p.views, d.pages[0].views, num(p.views) + ' views · ' + dur(p.avg_time) + ' avg'); }).join('') : '<p class="mt-2 text-sm text-white/40">No tracked visits.</p>') +
        '<h3 class="mt-7 text-sm font-semibold">Recent sign-in attempts</h3>' + table([
          { h: 'When', r: function (x) { return esc(when(x.ts)); } }, { h: 'What', r: function (x) { return esc(x.kind) + ' ' + (x.ok ? tag('ok', 'ok') : tag(x.reason || 'failed', 'bad')); } }, { h: 'From', r: function (x) { return place(x.country, x.city) + '<div class="text-[11px] text-white/35">' + esc(x.ip) + '</div>'; } }
        ], d.attempts, { empty: 'No attempts recorded.' }) +
        '<div class="mt-8 border-t border-white/[0.08] pt-5">' + (u.disabled
          ? '<button class="btn btn-white" type="button" data-act="enable" data-id="' + esc(u.id) + '">Enable account</button>'
          : '<button class="btn btn-danger" type="button" data-act="disable" data-id="' + esc(u.id) + '" data-email="' + esc(u.email) + '">Disable account…</button><p class="mt-2 text-xs text-white/40">Signs them out everywhere and refuses their sign-in. Their data is kept.</p>') + '</div>');
      var syncAddon = function () { $('gAddon').closest('label').style.display = $('gPlan').value === 'pro' ? '' : 'none'; };
      $('gPlan').addEventListener('change', syncAddon); syncAddon();
      $('accessBox').addEventListener('click', function (e) {
        var b = e.target.closest('button'); if (!b) return;
        var req = b.dataset.product
          ? { action: 'access', userId: id, product: b.dataset.product, enabled: b.dataset.on === '1', days: $('xDays').value.trim() ? Number($('xDays').value.trim()) : null }
          : b.dataset.api ? { action: 'api_addon', userId: id, enabled: b.dataset.api === '1' } : null;
        if (!req) return;
        call('POST', '/api/admin/users', req).then(function (g) { if (g.ok) { Vane.toast('ok', 'Done.'); openUser(id); } else Vane.toast('err', g.error); });
      });
      function pass(enabled) {
        var days = $('pDays').value.trim();
        call('POST', '/api/admin/users', { action: 'ai_pass', userId: id, enabled: enabled, days: days ? Number(days) : null }).then(function (g) {
          if (g.ok) { Vane.toast('ok', enabled ? 'AI Pass is on.' : 'AI Pass is off.'); openUser(id); } else Vane.toast('err', g.error);
        });
      }
      $('passForm').addEventListener('submit', function (e) { e.preventDefault(); pass(true); });
      if ($('passOff')) $('passOff').addEventListener('click', function () { pass(false); });
      $('aiForm').addEventListener('submit', function (e) {
        e.preventDefault();
        var n = Number($('aCredits').value);
        if (!n || n % 1) { Vane.toast('err', 'Enter a whole number of credits, for example 100.'); return; }
        call('POST', '/api/admin/users', { action: 'ai_credits', userId: e.target.dataset.id, credits: n, note: $('aNote').value.trim() }).then(function (g) {
          if (g.ok) { Vane.toast('ok', 'Done. Extra AI credits now: ' + g.data.balance); openUser(id); } else Vane.toast('err', g.error);
        });
      });
      $('grantForm').addEventListener('submit', function (e) {
        e.preventDefault();
        var days = $('gDays').value.trim();
        call('POST', '/api/admin/users', { action: 'grant', userId: e.target.dataset.id, planId: $('gPlan').value, days: days ? Number(days) : null, note: $('gNote').value.trim(), addon: $('gPlan').value === 'pro' && $('gAddon').checked, overage: $('gOver').checked }).then(function (g) {
          if (g.ok) { Vane.toast('ok', 'Plan given.'); openUser(id); if (location.hash === '#users') loadUsers(S.seq); } else Vane.toast('err', g.error);
        });
      });
    });
  }

  // ── Plans
  var LIMITS = [
    ['postsPerMonth', 'Dashboard posts per month', 'int', 'empty = none'],
    ['apiPostsPerMonth', 'API posts per month', 'int', 'empty = none'],
    ['postsLifetime', 'Posts in total (trial style)', 'int', 'empty = not a trial'],
    ['channels', 'Connected channels', 'int', 'empty = unlimited'],
    ['aiCredits', 'AI credits', 'int', 'empty = unlimited'],
    ['apiAccess', 'API access (1 yes, 0 no)', 'int', 'empty = yes if it has API posts'],
    ['overagePostUsd', 'Extra post price, USD', 'float', 'empty = the plan just stops'],
    ['overageAiPostUsd', 'Extra AI post price, USD', 'float', 'empty = same as an extra post'],
    ['seats', 'Team seats', 'int', 'stored, not enforced yet']
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
          '<li>Every plan has a slot for the provider reference (Monobank, crypto, Stripe). Checkout (Orders tab) creates the subscription row by itself when a payment arrives.</li>' +
          '<li>A "2 in 1" or "Ultra" plan is just a new plan with its own price and limits. Give it to a user from the Users tab (a database created before the admin needs <code>scripts/migrations/001-subscriptions-any-plan.sql</code> run once for custom plans), or sell it once checkout exists.</li>' +
          '<li>The limits are what the API engine enforces (API keys, quotas, extra-post billing), so editing them here changes it within seconds. The connected-channels limit is applied only while <b>Enforce the channel limit</b> is on in Settings (off by default).</li></ul>', '', 'mt-4'));
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
      '<h4 class="mt-6 text-sm font-semibold">Limits <span class="font-normal text-white/40">(enforced by the API engine, live within seconds)</span></h4><div class="mt-3 grid gap-4 sm:grid-cols-2">' +
        LIMITS.map(function (l) { return field('pL_' + l[0], l[1], typeof p.limits[l[0]] === 'number' ? p.limits[l[0]] : '', { type: 'number', ph: l[3], attrs: 'min="0"' + (l[2] === 'float' ? ' step="0.001"' : ' step="1"') }); }).join('') + '</div>' +
      '<h4 class="mt-6 text-sm font-semibold">Payment provider references <span class="font-normal text-white/40">(optional notes for your own records; checkout does not need them)</span></h4><div class="mt-3 grid gap-4 sm:grid-cols-3">' +
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

  // ── Social links: the landing page's "Follow Vane" section. The words, links and order are edited here; the card design is fixed.
  function netName(list, id) { var n = list.filter(function (x) { return x.id === id; })[0]; return n ? n.name : id; }
  VIEWS.social = function (seq) {
    call('GET', '/api/admin/socials').then(function (r) {
      if (!alive(seq)) return;
      if (!r.ok) return show(seq, errorBox(r.error));
      var d = S.social = r.data, sec = d.section;
      var cards = d.links.map(function (l) {
        return '<article class="glass-d flex flex-col rounded-3xl p-5">' +
          '<div class="flex items-start justify-between gap-2"><div class="min-w-0"><div class="text-[11px] font-medium uppercase tracking-wider text-white/40">' + esc(netName(d.networks, l.network)) + '</div><h3 class="mt-1 truncate text-lg font-semibold">' + esc(l.name) + '</h3></div>' +
          (l.isPublic ? tag('on landing', 'ok') : tag('hidden')) + '</div>' +
          '<p class="mt-3 text-sm font-medium">' + (l.handle ? esc(l.handle) : '<span class="text-white/35">no handle</span>') + '</p>' +
          '<p class="mt-1 text-xs leading-relaxed text-white/55">' + (l.description ? esc(l.description) : 'No description') + '</p>' +
          '<a class="mt-2 truncate text-xs text-white/45 underline-offset-2 hover:underline" href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer">' + esc(l.url) + '</a>' +
          '<p class="mt-2 text-xs text-white/40">Button: ' + esc(l.ctaLabel) + ' · order ' + esc(l.sort) + '</p>' +
          '<div class="mt-auto pt-4"><button class="btn btn-ghost btn-sm w-full" type="button" data-act="soc-edit" data-id="' + esc(l.id) + '">Edit</button></div></article>';
      }).join('');
      show(seq, title('Social links', 'The \"Follow\" section of the landing page. You change the words, the links and the order; the design stays as it is. Public changes appear within a minute.',
        '<button class="btn btn-white btn-sm" type="button" data-act="soc-new"' + (d.links.length >= d.max ? ' disabled' : '') + '>+ Add link</button>') +
        card('Words above the cards',
          '<form id="socSectionForm" novalidate><div class="grid gap-4 sm:grid-cols-2">' +
            field('sEyebrow', 'Small label (empty hides it)', sec.eyebrow, { attrs: 'maxlength="40"' }) +
            field('sTitle', 'Heading', sec.title, { attrs: 'maxlength="120"' }) +
            field('sIntro', 'Intro text (empty hides it)', sec.intro, { cls: 'sm:col-span-2', attrs: 'maxlength="300"' }) +
          '</div><div id="socSectionErr" role="alert" class="mt-4 hidden rounded-xl border border-red-400/25 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-300"></div>' +
          '<div class="mt-4 flex justify-end"><button class="btn btn-white btn-sm" type="submit">Save text</button></div></form>') +
        '<div class="mt-4 ' + (d.links.length ? 'grid gap-4 sm:grid-cols-2 xl:grid-cols-3' : '') + '">' + (cards || card('', empty('No links yet. Without any public link the section is hidden on the landing page.'))) + '</div>' +
        card('How this works', '<ul class="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-white/60"><li>The landing page reads these rows from <code>/api/socials</code>. If none is public, the whole section disappears; if the API is unreachable, the links written into the page stay.</li>' +
          '<li>The network decides the icon and colour. Pick <b>Other</b> for anything without its own icon.</li><li>Links must be full <code>https://</code> addresses. Up to ' + d.max + ' links; a lower order number goes first.</li></ul>', '', 'mt-4'));
      $('socSectionForm').addEventListener('submit', saveSocSection);
    });
  };
  function saveSocSection(e) {
    e.preventDefault();
    var box = $('socSectionErr'), btn = $('socSectionForm').querySelector('button[type=submit]');
    btn.disabled = true;
    call('PUT', '/api/admin/socials?part=section', { eyebrow: $('sEyebrow').value.trim(), title: $('sTitle').value.trim(), intro: $('sIntro').value.trim() }).then(function (r) {
      btn.disabled = false;
      box.textContent = r.ok ? '' : r.error; box.classList.toggle('hidden', r.ok);
      if (r.ok) Vane.toast('ok', 'Text saved.');
    });
  }
  function socForm(l) {
    var creating = !l, d = S.social;
    l = l || { id: '', network: 'telegram', name: 'Telegram', handle: '', description: '', url: '', ctaLabel: 'Follow', isPublic: true, sort: (d.links.length ? Math.max.apply(null, d.links.map(function (x) { return x.sort; })) + 10 : 10) };
    openModal('<form id="socLinkForm" novalidate><h3 class="text-xl font-semibold">' + (creating ? 'Add a link' : 'Edit ' + esc(l.name)) + '</h3>' +
      '<div class="mt-5 grid gap-4 sm:grid-cols-2">' +
        '<div><label class="lbl" for="lNet">Network (icon and colour)</label><select id="lNet" class="field">' + d.networks.map(function (n) { return '<option value="' + esc(n.id) + '"' + (l.network === n.id ? ' selected' : '') + '>' + esc(n.name) + '</option>'; }).join('') + '</select></div>' +
        field('lName', 'Name (small caps above)', l.name, { ph: 'Telegram', attrs: 'maxlength="40"' }) +
        field('lHandle', 'Handle (the big line)', l.handle, { ph: '@vanenews', attrs: 'maxlength="60"' }) +
        field('lCta', 'Button text', l.ctaLabel, { attrs: 'maxlength="30"' }) +
        field('lDesc', 'Description', l.description, { cls: 'sm:col-span-2', ph: 'One short line', attrs: 'maxlength="160"' }) +
        field('lUrl', 'Link', l.url, { cls: 'sm:col-span-2', type: 'url', ph: 'https://t.me/vanenews', attrs: 'maxlength="300"' }) +
        field('lSort', 'Order (lower = first)', l.sort, { type: 'number' }) +
        '<div class="flex items-end pb-2">' + check('lPublic', 'Show on the landing page', l.isPublic) + '</div>' +
      '</div>' +
      '<div id="socErr" role="alert" class="mt-5 hidden rounded-xl border border-red-400/25 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-300"></div>' +
      '<div class="mt-6 flex items-center justify-between gap-3"><div>' + (creating ? '' : '<button class="btn btn-danger btn-sm" type="button" data-act="soc-delete" data-id="' + esc(l.id) + '" data-name="' + esc(l.name) + '">Delete</button>') + '</div>' +
      '<div class="flex gap-2"><button class="btn btn-ghost" type="button" data-act="modal-close">Cancel</button><button class="btn btn-white" type="submit">' + (creating ? 'Add link' : 'Save changes') + '</button></div></div></form>');
    // picking another network renames the card for you, as long as the name is still the previous network's
    var lastNet = l.network;
    $('lNet').addEventListener('change', function () {
      var prev = netName(d.networks, lastNet), cur = $('lName').value.trim();
      lastNet = $('lNet').value;
      if (!cur || cur === prev) $('lName').value = lastNet === 'other' ? '' : netName(d.networks, lastNet);
    });
    $('socLinkForm').addEventListener('submit', function (e) { e.preventDefault(); saveSocLink(creating, l.id); });
  }
  function saveSocLink(creating, id) {
    var err = function (m) { var b = $('socErr'); b.textContent = m; b.classList.toggle('hidden', !m); };
    var body = {
      network: $('lNet').value, name: $('lName').value.trim(), handle: $('lHandle').value.trim(), description: $('lDesc').value.trim(),
      url: $('lUrl').value.trim(), ctaLabel: $('lCta').value.trim(), sort: Math.round(Number($('lSort').value) || 0), isPublic: $('lPublic').checked
    };
    var btn = $('socLinkForm').querySelector('button[type=submit]'); btn.disabled = true;
    call(creating ? 'POST' : 'PUT', '/api/admin/socials' + (creating ? '' : '?id=' + encodeURIComponent(id)), body).then(function (r) {
      btn.disabled = false;
      if (!r.ok) return err(r.error);
      closeModal(); Vane.toast('ok', creating ? 'Link added.' : 'Link saved.'); route();
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


  // ── Networks
  function netStatus(n) {
    if (!n.implemented) return tag('code not written', 'warn');
    return n.enabled ? tag('on', 'ok') : tag('switched off', 'bad');
  }
  VIEWS.networks = function (seq) {
    call('GET', '/api/admin/networks').then(function (r) {
      if (!alive(seq)) return;
      if (!r.ok) return show(seq, errorBox(r.error));
      var list = r.data.networks;
      var section = function (product, heading, hint) {
        var rows = list.filter(function (n) { return n.product === product; });
        return card(heading, '<p class="mb-4 text-sm text-white/50">' + hint + '</p>' + table([
          { h: 'Network', r: function (n) { return '<div class="font-medium">' + esc(n.name) + '</div><div class="text-[11px] text-white/40">' + esc(n.code) + '</div>' + (n.setup ? '<div class="mt-1 text-[11px] text-amber-300/90">' + esc(n.setup) + '</div>' : ''); } },
          { h: 'Status', r: netStatus },
          { h: 'Channels', cls: 'text-right', r: function (n) { return n.stats ? num(n.stats.activeChannels) + (n.stats.channels !== n.stats.activeChannels ? ' <span class="text-white/35">/ ' + num(n.stats.channels) + '</span>' : '') : '<span class="text-white/30">—</span>'; } },
          { h: 'Scheduled', cls: 'text-right', r: function (n) { return n.stats ? num(n.stats.scheduled) : '—'; } },
          { h: 'Waiting', cls: 'text-right', r: function (n) { return n.stats && n.stats.waiting ? '<span class="text-amber-300">' + num(n.stats.waiting) + '</span>' : n.stats ? '0' : '—'; } },
          { h: 'Failed 24 h', cls: 'text-right', r: function (n) { return n.stats && n.stats.failed24h ? '<span class="text-red-300">' + num(n.stats.failed24h) + '</span>' : n.stats ? '0' : '—'; } },
          { h: 'Note (your own, e.g. platform review status)', r: function (n) { return '<input class="field !py-1.5 !text-xs" data-act="net-note" data-id="' + esc(n.id) + '" maxlength="200" placeholder="e.g. waiting for approval" value="' + esc(n.note) + '" />'; } },
          { h: 'On / off', cls: 'text-right', r: function (n) {
            return n.implemented
              ? '<button type="button" class="switch" role="switch" data-act="net-toggle" data-id="' + esc(n.id) + '" data-name="' + esc(n.name) + '" aria-checked="' + n.enabled + '" aria-label="' + esc(n.name) + '"></button>'
              : '<button type="button" class="switch opacity-40" role="switch" aria-checked="false" aria-disabled="true" data-act="net-nocode" data-name="' + esc(n.name) + '" aria-label="' + esc(n.name) + ' cannot be switched on: code not written"></button>';
          } }
        ], rows));
      };
      show(seq, title('Networks', 'Switch a network on or off. A network can be switched on as soon as its code is written, even if the platform has not approved Vane yet.') +
        section('post', 'Vane Post', 'Switched off: nobody can connect a new account, no new post can be scheduled to it, and posts already scheduled for it <b>wait</b> (they are not lost). If it stays off more than 2 hours past a post’s time, that post fails with a clear reason.') +
        '<div class="mt-4"></div>' + section('studio', 'Vane Studio', 'Detected from the code: a network becomes switchable as soon as its publisher exists. Networks marked “code not written” have no connect and upload flow yet. A switched-off network cannot be connected and nothing can be published to it.'));
    });
  };

  // ── Integrations (Claude, ChatGPT, Make, Zapier, …): how each is set up, whether it is on, and how much it is used
  function trend(cur, prev) {
    if (!prev) return cur ? '<span class="text-sky-300">new</span>' : '<span class="text-white/35">—</span>';
    var ch = Math.round(((cur - prev) / prev) * 100);
    if (ch === 0) return '<span class="text-white/45">±0%</span>';
    return '<span class="' + (ch > 0 ? 'text-emerald-300' : 'text-red-300') + '">' + (ch > 0 ? '▲ ' : '▼ ') + Math.abs(ch) + '%</span>';
  }
  var INT_STATE = { live: ['Live', 'ok'], partial: ['Works through the API', 'info'], planned: ['Planned', ''], paused: ['Paused', 'bad'] };
  var INT_ACTIVITY = { active: ['Active', 'ok'], idle: ['Idle: no use in 7 days', 'warn'], none: ['No traffic yet', ''] };

  function intCard(i, days, listingOptions) {
    var u = i.usage, st = INT_STATE[i.state] || INT_STATE.live, ac = INT_ACTIVITY[i.activity] || INT_ACTIVITY.none;
    var metric = function (label, value, sub) {
      return '<div class="rounded-xl bg-white/[0.04] px-3 py-2.5 ring-1 ring-white/5"><div class="text-[10px] font-medium uppercase tracking-wider text-white/40">' + esc(label) + '</div>' +
        '<div class="mt-0.5 text-lg font-semibold tracking-tight">' + value + '</div>' + (sub ? '<div class="text-[11px] text-white/45">' + sub + '</div>' : '') + '</div>';
    };
    var ops = u.topOps.length
      ? u.topOps.map(function (o) { return '<div class="flex items-center justify-between gap-3 text-xs"><code class="truncate text-white/70">' + esc(o.op) + '</code><span class="shrink-0 text-white/45">' + num(o.requests) + '</span></div>'; }).join('')
      : '<p class="text-xs text-white/35">Nothing yet.</p>';
    var endpoints = i.endpoints.map(function (e) {
      return '<div class="flex items-center gap-2"><span class="w-24 shrink-0 text-[11px] font-medium uppercase tracking-wider text-white/40 sm:w-40">' + esc(e.label) + '</span>' +
        '<code class="field min-w-0 flex-1 truncate !py-1.5 font-mono !text-xs">' + esc(e.value) + '</code>' +
        '<button type="button" class="btn btn-ghost btn-sm shrink-0" data-act="int-copy" data-text="' + esc(e.value) + '">Copy</button></div>';
    }).join('');
    var options = listingOptions.map(function (o) { return '<option value="' + esc(o.value) + '"' + (o.value === i.listing ? ' selected' : '') + '>' + esc(o.label) + '</option>'; }).join('');

    return '<section class="glass-d rounded-3xl p-5 sm:p-6' + (i.enabled ? '' : ' opacity-80') + '" data-int="' + esc(i.id) + '">' +
      '<div class="flex items-start gap-3">' +
        '<span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-base font-semibold" style="background:' + esc(i.color) + '22;color:' + esc(i.color) + '">' + esc(i.name.charAt(0)) + '</span>' +
        '<div class="min-w-0 flex-1"><div class="flex flex-wrap items-center gap-2"><h2 class="text-base font-semibold tracking-tight">' + esc(i.name) + '</h2><span class="text-xs text-white/40">' + esc(i.kind) + '</span></div>' +
          '<div class="mt-1.5 flex flex-wrap gap-1.5">' + tag(st[0], st[1]) + tag(ac[0], ac[1]) + (i.listing ? tag(i.listingLabel, 'info') : '') + '</div></div>' +
        '<button type="button" class="switch" role="switch" data-act="int-toggle" data-id="' + esc(i.id) + '" data-name="' + esc(i.name) + '" aria-checked="' + i.enabled + '" aria-label="' + esc(i.name) + ' on or off"></button>' +
      '</div>' +
      '<p class="mt-3 text-sm leading-relaxed text-white/60">' + esc(i.summary) + '</p>' +
      '<div class="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">' +
        metric('Today', num(u.today)) +
        metric('7 days', num(u.d7), trend(u.d7, u.prev7) + ' <span class="text-white/35">vs previous 7</span>') +
        metric('30 days', num(u.d30)) +
        metric('Keys (7 d)', num(u.keys7), num(u.keys30) + ' in 30 d · ' + num(u.users30) + ' user' + (u.users30 === 1 ? '' : 's')) +
      '</div>' +
      '<div class="mt-4">' + bars(days, [{ name: 'requests', color: i.color, values: u.series }], 40) + '</div>' +
      '<p class="mt-1 text-xs text-white/40">Last request: ' + (u.lastAt ? ago(u.lastAt) : 'never') + (u.labelledKeys ? ' · ' + num(u.labelledKeys) + ' key' + (u.labelledKeys === 1 ? '' : 's') + ' labelled for it' : '') + '</p>' +
      '<div class="mt-4"><div class="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-white/40">What it is used for (30 d)</div><div class="space-y-1">' + ops + '</div></div>' +
      '<details class="mt-4 rounded-2xl bg-white/[0.03] ring-1 ring-white/5"><summary class="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm font-medium">Setup and notes<span class="text-white/40" aria-hidden="true">▾</span></summary>' +
        '<div class="space-y-4 px-4 pb-4">' +
          '<div class="space-y-2">' + endpoints + '</div>' +
          '<div><div class="mb-1 text-[11px] font-medium uppercase tracking-wider text-white/40">Authentication</div><p class="text-sm text-white/65">' + esc(i.auth) + '</p></div>' +
          '<div><div class="mb-1 text-[11px] font-medium uppercase tracking-wider text-white/40">How a user connects it</div><ol class="list-decimal space-y-1 pl-5 text-sm text-white/65">' + i.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol></div>' +
          '<div><div class="mb-1 text-[11px] font-medium uppercase tracking-wider text-white/40">Store / marketplace review</div><p class="text-sm text-white/65">' + esc(i.verification) + '</p></div>' +
          '<div class="grid gap-3 sm:grid-cols-2"><div><label class="lbl" for="il-' + esc(i.id) + '">Where the review stands</label><select id="il-' + esc(i.id) + '" class="field !py-1.5 !text-sm" data-act="int-listing" data-id="' + esc(i.id) + '">' + options + '</select></div>' +
            '<div><label class="lbl" for="in-' + esc(i.id) + '">Your note</label><input id="in-' + esc(i.id) + '" class="field !py-1.5 !text-sm" data-act="int-note" data-id="' + esc(i.id) + '" maxlength="500" placeholder="e.g. invite link sent, waiting" value="' + esc(i.note) + '" /></div></div>' +
        '</div></details>' +
    '</section>';
  }

  VIEWS.integrations = function (seq) {
    call('GET', '/api/admin/integrations').then(function (r) {
      if (!alive(seq)) return;
      if (!r.ok) return show(seq, errorBox(r.error));
      var d = r.data, list = d.integrations, t = d.totals;
      var days = d.days.map(function (x) { return x.slice(5); });
      var ranked = list.slice().sort(function (a, b) { return b.usage.d30 - a.usage.d30; });
      var top = ranked.length ? ranked[0].usage.d30 : 0;
      var withTraffic = list.filter(function (i) { return i.usage.d30 > 0; });
      var demand = t.d30
        ? '<div class="grid gap-6 lg:grid-cols-2"><div>' + ranked.map(function (i) {
            return hbar('<span class="inline-block h-2 w-2 rounded-full align-middle" style="background:' + esc(i.color) + '"></span> ' + esc(i.name), i.usage.d30, top,
              num(i.usage.d30) + ' · ' + Math.round((i.usage.d30 / t.d30) * 100) + '%', i.color);
          }).join('') + '</div><div>' + bars(days, withTraffic.map(function (i) { return { name: i.name, color: i.color, values: i.usage.series }; })) + '</div></div>'
        : empty('No API traffic yet. Counting starts with the first authenticated request after this release.');
      show(seq, title('Integrations', 'The tools people connect to Vane: how each one is set up, whether it is on, and how much it is used. Use the demand to decide what to build next.') +
        (d.needsDb ? '<div class="mb-4 rounded-2xl border border-amber-400/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">The database does not have the integrations tables yet. Run <code>npm run db:remote</code> once, then reload this page.</div>' : '') +
        '<div class="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">' +
          stat('API requests, 7 days', num(t.d7), trend(t.d7, t.prev7) + ' <span class="text-white/40">vs the 7 before</span>') +
          stat('Today', num(t.today), num(t.d30) + ' in 30 days') +
          stat('Active keys, 7 days', num(t.keys7), 'across all integrations') +
          stat('Source not known', pct(t.directShare * 100), 'of 30-day traffic is “Direct API”. Lower is better: ask users to pick “Used with” when they create a key.') +
        '</div>' +
        '<div class="mt-4">' + card('Demand, last 30 days', demand) + '</div>' +
        '<div class="mt-4 grid gap-4 lg:grid-cols-2">' + list.map(function (i) { return intCard(i, days, d.listingOptions); }).join('') + '</div>' +
        '<p class="mt-6 text-xs leading-relaxed text-white/35">How a request is told apart: it came through the MCP endpoint (Claude), the key was labelled when it was created, the client’s User-Agent, then the key’s name; anything else counts as Direct API. Only the first two are certain. Requests with an invalid key, and requests refused because an integration is switched off, are not counted. Counters are kept for 120 days and hold no request contents.</p>');
    });
  };

  // ── AI token ledger
  function tokens(n) { n = n || 0; return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : num(n); }
  function usd(x, d) { x = x || 0; return '$' + (x < 0.01 && x > 0 ? x.toFixed(4) : x.toFixed(d == null ? 2 : d)); }
  VIEWS.ai = function (seq) {
    call('GET', '/api/admin/ai?days=' + S.days).then(function (r) {
      if (!alive(seq)) return;
      if (!r.ok) return show(seq, errorBox(r.error));
      var d = r.data, t = d.totals, m = d.month, td = d.today;
      // where the month is heading at today's pace (shown once there is a day of data)
      var proj = m.projectedUsd != null ? ' · on pace for ' + usd(m.projectedUsd) + (m.projectedPct != null ? ' (' + m.projectedPct + '%)' : '') : '';
      var su = d.setup || {};
      var notice = function (cls, html) { return '<div class="mb-4 rounded-2xl border px-4 py-3 text-sm ' + cls + '">' + html + '</div>'; };
      var setupNotes =
        (su.aiBinding === false ? notice('border-red-400/25 bg-red-500/10 text-red-200', '<b>AI is not connected to this server</b>, so no call can be made or counted, and this page will stay at zero. In Cloudflare open Workers &amp; Pages → your Pages project → Settings → Bindings → Add → <b>Workers AI</b>, name the variable <code class="rounded bg-white/10 px-1 text-xs">AI</code>, then redeploy.') : '') +
        (su.aiBinding !== false && su.modelPriced === false ? notice('border-amber-400/25 bg-amber-500/10 text-amber-200', 'The model this server runs on, <b>' + esc(su.model) + '</b>, has no price yet. Its tokens will be counted but its cost will show as $0. Add its price in the table at the bottom.') : '');
      var noData = function (what) { return '<div class="flex h-28 flex-col items-center justify-center text-center text-sm text-white/40"><span>' + what + '</span></div>'; };
      var none = !t.calls;
      var budget = m.budgetUsd > 0
        ? stat('This month vs budget', usd(m.costUsd) + ' <span class="text-base font-normal text-white/40">/ ' + usd(m.budgetUsd, 0) + '</span>', '<span class="' + (m.budgetUsedPct >= 100 ? 'text-red-300' : m.budgetUsedPct >= 80 ? 'text-amber-300' : '') + '">' + m.budgetUsedPct + '% used</span> · ' + tokens(m.tokens) + ' tokens' + proj)
        : stat('This month', usd(m.costUsd), tokens(m.tokens) + ' tokens · <a class="underline" href="#settings">set a budget</a>' + proj);
      var freePct = Math.min(100, Math.round((td.neurons / td.freeNeurons) * 100));
      var noPrice = d.byModel.filter(function (x) { return !x.priced; });
      show(seq, title('AI spend', 'Every model call the AI features make, counted in tokens. Cost is tokens × the model price below.', rangeChips([7, 30, 90], d.days, 'range') + '<a class="chip !px-3 !py-1.5 !text-xs" href="/api/admin/ai?days=' + d.days + '&format=csv" download title="Every call of this period, one row each">Export CSV</a>') +
        setupNotes + (noPrice.length ? '<div class="mb-4 rounded-2xl border border-amber-400/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">No price set for <b>' + noPrice.map(function (x) { return esc(x.model); }).join(', ') + '</b>: its tokens are counted but its cost shows as $0. Add the price in the table at the bottom.</div>' : '') +
        '<div class="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">' +
          stat('Tokens', tokens(t.tokens), tokens(t.inputTokens) + ' in · ' + tokens(t.outputTokens) + ' out') +
          stat('Cost at list price', usd(t.costUsd), 'after the free allowance: ' + usd(t.afterFreeAllowanceUsd) + (t.calls ? ' · ' + usd(t.costUsd / t.calls, 4) + ' per call' : '')) +
          stat('Model calls', num(t.calls), num(t.failed) + ' failed · ' + (t.avgMs ? t.avgMs + ' ms avg' : '—')) + budget +
        '</div>' +
        '<div class="mt-4 grid gap-4 lg:grid-cols-2">' +
          card('Tokens per day', none ? noData('No AI calls in this period yet.<br>They appear here as soon as someone uses an AI tool in the editor.') : bars(d.series.labels, [{ name: 'input', color: 'rgba(125,211,252,.85)', values: d.series.inputTokens }, { name: 'output', color: 'rgba(196,181,253,.9)', values: d.series.outputTokens }])) +
          card('Cost per day (list price)', none ? noData('Nothing to price yet.') : bars(d.series.labels, [{ name: 'USD', color: 'rgba(252,211,77,.85)', values: d.series.costUsd }])) +
        '</div>' +
        card('Free allowance today', hbar('Workers AI neurons used today (this ledger)', td.neurons, td.freeNeurons, num(td.neurons) + ' of ' + num(td.freeNeurons) + ' free (' + freePct + '%)', freePct >= 100 ? '#fca5a5' : undefined) +
          '<p class="mt-2 text-xs text-white/40">Cloudflare gives 10 000 neurons a day free and bills the rest at $0.011 per 1000. The allowance belongs to the whole Cloudflare account, so anything else that uses Workers AI also eats it; this ledger only sees Vane’s own calls.' + (t.estimatedCalls ? ' ' + num(t.estimatedCalls) + ' calls had no usage numbers from the provider and use a 4-characters-per-token estimate.' : '') + '</p>', '', 'mt-4') +
        '<div class="mt-4 grid gap-4 lg:grid-cols-5">' +
          card('By feature', table([
            { h: 'Feature', r: function (x) { return '<span class="font-medium">' + esc(x.tool) + '</span> ' + (x.premium ? tag('uses credits', 'info') : tag('free tool')); } },
            { h: 'Calls', cls: 'text-right', r: function (x) { return num(x.calls) + (x.failed ? ' <span class="text-red-300">(' + x.failed + ' failed)</span>' : ''); } },
            { h: 'Tokens', cls: 'text-right', r: function (x) { return tokens(x.inputTokens + x.outputTokens); } },
            { h: 'Per call', cls: 'text-right', r: function (x) { return x.calls ? tokens(Math.round((x.inputTokens + x.outputTokens) / x.calls)) : '—'; } },
            { h: 'Cost', cls: 'text-right', r: function (x) { return usd(x.costUsd); } }], d.byTool, { empty: 'No AI calls in this period yet.' }), '', 'lg:col-span-3') +
          card('By model', table([
            { h: 'Model', r: function (x) { return '<span class="break-all text-xs">' + esc(x.model) + '</span>' + (x.priced ? '' : ' ' + tag('no price', 'warn')); } },
            { h: 'Tokens', cls: 'text-right', r: function (x) { return tokens(x.inputTokens + x.outputTokens); } },
            { h: 'Cost', cls: 'text-right', r: function (x) { return usd(x.costUsd); } }], d.byModel, { empty: 'Nothing yet.' }), '', 'lg:col-span-2') +
        '</div>' +
        '<div class="mt-4 grid gap-4 lg:grid-cols-2">' +
          card('Who uses the most', table([
            { h: 'User', r: function (x) { return x.email ? '<span class="font-medium">' + esc(x.email) + '</span>' : '<span class="text-white/40">system / unknown</span>'; } },
            { h: 'Calls', cls: 'text-right', r: function (x) { return num(x.calls); } }, { h: 'Tokens', cls: 'text-right', r: function (x) { return tokens(x.tokens); } },
            { h: 'Cost', cls: 'text-right', r: function (x) { return usd(x.costUsd); } }, { h: 'Last', r: function (x) { return esc(ago(x.lastAt)); } }], d.topUsers, { empty: 'Nobody yet.' })) +
          card('Latest calls', table([
            { h: 'When', r: function (x) { return esc(when(x.ts)); } }, { h: 'Feature', r: function (x) { return esc(x.tool) + (x.ok ? '' : ' ' + tag('failed', 'bad')); } },
            { h: 'Tokens', cls: 'text-right', r: function (x) { return num(x.inputTokens) + ' → ' + num(x.outputTokens) + (x.estimated ? ' <span class="text-white/35" title="estimated">~</span>' : ''); } },
            { h: 'ms', cls: 'text-right', r: function (x) { return x.ms == null ? '—' : num(x.ms); } }], d.recent, { empty: 'No calls yet.' })) +
        '</div>' +
        card('What a model costs', '<p class="mb-4 text-sm text-white/50">Prices per 1 million tokens. Neurons are how Cloudflare meters Workers AI. A model you have not priced still counts tokens. Source for the starter row: developers.cloudflare.com/workers-ai/platform/pricing.</p>' + table([
          { h: 'Model', r: function (x) { return '<span class="break-all text-xs font-medium">' + esc(x.model) + '</span>'; } },
          { h: '$ input', cls: 'text-right', r: function (x) { return usd(x.inputUsdPerM, 3); } }, { h: '$ output', cls: 'text-right', r: function (x) { return usd(x.outputUsdPerM, 3); } },
          { h: 'neurons in', cls: 'text-right', r: function (x) { return num(x.inputNeuronsPerM); } }, { h: 'neurons out', cls: 'text-right', r: function (x) { return num(x.outputNeuronsPerM); } },
          { h: '', r: function (x) { return '<button class="btn btn-ghost btn-sm" type="button" data-act="ai-price" data-model="' + esc(x.model) + '" data-i="' + x.inputUsdPerM + '" data-o="' + x.outputUsdPerM + '" data-ni="' + x.inputNeuronsPerM + '" data-no="' + x.outputNeuronsPerM + '">Edit</button>'; } }
        ], d.prices) + '<div class="mt-3"><button class="btn btn-white btn-sm" type="button" data-act="ai-price" data-model="" data-i="0" data-o="0" data-ni="0" data-no="0">+ Add a model price</button></div>', '', 'mt-4'));
    });
  };
  function openAiPrice(el) {
    var d = el.dataset, adding = !d.model;
    openModal('<form id="aiPriceForm"><h3 class="text-lg font-semibold">' + (adding ? 'Add a model price' : 'Price of ' + esc(d.model)) + '</h3>' +
      '<div class="mt-5 grid gap-4 sm:grid-cols-2">' + field('apModel', 'Model id', d.model, { ph: '@cf/meta/llama-3.1-8b-instruct', cls: 'sm:col-span-2', attrs: adding ? '' : 'disabled' }) +
      field('apIn', '$ per 1M input tokens', d.i, { type: 'number', attrs: 'min="0" step="0.001"' }) + field('apOut', '$ per 1M output tokens', d.o, { type: 'number', attrs: 'min="0" step="0.001"' }) +
      field('apNIn', 'Neurons per 1M input tokens', d.ni, { type: 'number', attrs: 'min="0" step="1"' }) + field('apNOut', 'Neurons per 1M output tokens', d.no, { type: 'number', attrs: 'min="0" step="1"' }) + '</div>' +
      '<p class="mt-3 text-xs text-white/40">Applies to calls made from now on; the cost of earlier calls is not rewritten.</p>' +
      '<div class="mt-6 flex justify-end gap-2"><button class="btn btn-ghost" type="button" data-act="modal-close">Cancel</button><button class="btn btn-white" type="submit">Save price</button></div></form>');
    $('aiPriceForm').addEventListener('submit', function (e) {
      e.preventDefault();
      call('PUT', '/api/admin/ai', { model: $('apModel').value.trim(), inputUsdPerM: Number($('apIn').value) || 0, outputUsdPerM: Number($('apOut').value) || 0, inputNeuronsPerM: Number($('apNIn').value) || 0, outputNeuronsPerM: Number($('apNOut').value) || 0 }).then(function (r) {
        if (r.ok) { closeModal(); Vane.toast('ok', 'Price saved.'); route(); } else Vane.toast('err', r.error);
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
    ['AI', [
      ['ai_budget_usd', 'Monthly AI budget (USD)', 'What you are willing to spend on AI model calls per month. It is only shown against the real spend in the AI tab (0 = no budget); nothing is stopped.', 'usd']]],
    ['Product', [
      ['enforce_limits', 'Enforce the channel limit', 'When on, users cannot connect more channels than their plan allows (the Free Trial: 2). Posts are always metered by the API engine. Off by default so you can test freely; switch it on at launch.', 'bool'],
      ['track_visits', 'Record page views', 'Feeds the Traffic tab and the conversion funnel. Respects the browser Do-Not-Track setting.', 'bool'],
      ['checkout_preview', 'Checkout preview (only you)', 'Opens the checkout page for this browser while you are signed in here, even before a payment method is connected, so you can see how it looks. Pay shows an error: nothing can be bought. Visitors never see it.', 'bool']]]
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
            : '<input class="field !w-24 text-right" type="number" min="' + (x[3] === 'usd' ? '0' : '1') + '" step="' + (x[3] === 'usd' ? '0.01' : '1') + '" data-act="num" data-key="' + key + '" value="' + s[key] + '" />') + '</div>';
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

  // ── Orders (payments)
  var ORDER_TONE = { paid: 'text-emerald-300', pending: 'text-amber-300', expired: 'text-white/40', failed: 'text-red-300', canceled: 'text-white/40' };
  VIEWS.orders = function (seq) {
    var st = S.orderStatus || '';
    call('GET', '/api/admin/orders' + (st ? '?status=' + st : '')).then(function (r) {
      if (!alive(seq)) return;
      if (!r.ok) return show(seq, errorBox(r.error));
      S.orders = r.data.orders;
      var filters = [['', 'All'], ['pending', 'Waiting'], ['paid', 'Paid'], ['expired', 'Expired'], ['failed', 'Failed']].map(function (f) {
        return '<button type="button" class="chip" data-act="order-filter" data-status="' + f[0] + '" aria-pressed="' + (f[0] === st) + '"><span>' + f[1] + '</span></button>';
      }).join('');
      show(seq, title('Orders', num(r.data.paid.count) + ' paid · ' + money0(r.data.paid.cents) + ' in total. Card payments confirm themselves through Monobank; crypto is found on the Solana chain. If you saw the money yourself, press Confirm.') +
        '<div class="mb-4 flex flex-wrap gap-2">' + filters + '</div>' +
        card('', table([
          { h: 'When', r: function (o) { return esc(when(o.createdAt)); } },
          { h: 'Buyer', r: function (o) { return '<span class="font-medium">' + esc(o.email) + '</span><div class="text-xs text-white/40">' + esc([o.billing.name, o.billing.country, o.billing.company].filter(Boolean).join(' · ')) + '</div>'; } },
          { h: 'Plan', r: function (o) { return esc(o.planName) + '<div class="text-xs text-white/40">' + (o.interval === 'year' ? 'a year' : 'a month') + '</div>'; } },
          { h: 'Amount', r: function (o) { return money(o.amountCents); } },
          { h: 'Method', r: function (o) { return o.method === 'crypto' ? 'Crypto' + (o.payMicro ? '<div class="text-xs text-white/40">' + (o.payMicro / 1e6).toFixed(6) + '</div>' : '') : 'Card'; } },
          { h: 'Status', r: function (o) { return '<span class="font-medium ' + (ORDER_TONE[o.status] || '') + '">' + esc(o.status) + '</span>' + (o.note ? '<div class="text-xs text-white/40">' + esc(o.note) + '</div>' : ''); } },
          { h: '', r: function (o) {
            if (o.status === 'paid') return '<span class="break-all text-[11px] text-white/35">' + esc((o.txRef || o.invoiceId || '').slice(0, 18)) + '</span>';
            if (o.status === 'canceled') return '';
            return '<div class="flex gap-2"><button type="button" class="btn btn-ghost btn-sm" data-act="order-check" data-id="' + o.id + '">Check</button>' +
              '<button type="button" class="btn btn-white btn-sm" data-act="order-confirm" data-id="' + o.id + '">Confirm</button>' +
              (o.status === 'pending' ? '<button type="button" class="btn btn-ghost btn-sm" data-act="order-cancel" data-id="' + o.id + '">Cancel</button>' : '') + '</div>';
          } },
        ], r.data.orders, { empty: 'No orders yet.' })));
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
    var note = e.target.closest('[data-act="net-note"]');
    if (note) { call('PUT', '/api/admin/networks', { network: note.dataset.id, note: note.value.trim() }).then(function (r) { Vane.toast(r.ok ? 'ok' : 'err', r.ok ? 'Note saved.' : r.error); }); return; }
    var intField = e.target.closest('[data-act="int-note"], [data-act="int-listing"]');
    if (intField) {
      var intBody = intField.dataset.act === 'int-note' ? { note: intField.value.trim() } : { listing: intField.value };
      call('PUT', '/api/admin/integrations?id=' + encodeURIComponent(intField.dataset.id), intBody).then(function (r) { Vane.toast(r.ok ? 'ok' : 'err', r.ok ? 'Saved.' : r.error); });
      return;
    }
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
    else if (a === 'ai-price') openAiPrice(el);
    else if (a === 'net-nocode') Vane.toast('err', el.dataset.name + ' cannot be switched on yet: its code is not written.');
    else if (a === 'net-toggle') {
      var wantOn = el.getAttribute('aria-checked') !== 'true';
      var go = function () {
        call('PUT', '/api/admin/networks', { network: el.dataset.id, enabled: wantOn }).then(function (r) { if (r.ok) { Vane.toast('ok', el.dataset.name + (wantOn ? ' is on.' : ' is switched off.')); } else Vane.toast('err', r.error); route(); });
      };
      if (wantOn) go(); else confirmBox('Switch <b>' + esc(el.dataset.name) + '</b> off? Nobody can connect it or schedule to it, and posts already scheduled for it will wait until you switch it on again.', 'Switch off', go, true);
    }
    else if (a === 'int-toggle') {
      var intOn = el.getAttribute('aria-checked') !== 'true';
      var intGo = function () {
        call('PUT', '/api/admin/integrations?id=' + encodeURIComponent(el.dataset.id), { enabled: intOn }).then(function (r) {
          if (r.ok) Vane.toast('ok', el.dataset.name + (intOn ? ' is on.' : ' is switched off.')); else Vane.toast('err', r.error);
          route();
        });
      };
      if (intOn) intGo(); else confirmBox('Switch <b>' + esc(el.dataset.name) + '</b> off? Every request from it is refused (403) until you switch it back on. Nothing is deleted.', 'Switch off', intGo, true);
    }
    else if (a === 'int-copy') {
      var copied = function () { Vane.toast('ok', 'Copied.'); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(el.dataset.text).then(copied, function () { Vane.toast('err', 'Could not copy. Select it and press Ctrl+C.'); });
      else { var ta = document.createElement('textarea'); ta.value = el.dataset.text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); copied(); } catch (x) { Vane.toast('err', 'Could not copy.'); } document.body.removeChild(ta); }
    }
    else if (a === 'plan-new') planForm(null);
    else if (a === 'plan-edit') planForm(S.plans.filter(function (p) { return p.id === el.dataset.id; })[0]);
    else if (a === 'plan-delete') confirmBox('Delete the plan <b>' + esc(el.dataset.id) + '</b>? This only works if nobody ever had it.', 'Delete plan', function () {
      call('DELETE', '/api/admin/plans?id=' + encodeURIComponent(el.dataset.id)).then(function (r) { if (r.ok) { Vane.toast('ok', 'Plan deleted.'); route(); } else Vane.toast('err', r.error); });
    }, true);
    else if (a === 'order-filter') { S.orderStatus = el.dataset.status; route(); }
    else if (a === 'order-check') call('POST', '/api/admin/orders', { action: 'check', orderId: el.dataset.id }).then(function (r) { if (r.ok) { Vane.toast('ok', 'Status: ' + r.data.status + '.'); route(); } else Vane.toast('err', r.error); });
    else if (a === 'order-cancel') confirmBox('Cancel this waiting order? Nothing is refunded or charged.', 'Cancel order', function () {
      call('POST', '/api/admin/orders', { action: 'cancel', orderId: el.dataset.id }).then(function (r) { if (r.ok) { Vane.toast('ok', 'Order canceled.'); route(); } else Vane.toast('err', r.error); });
    }, true);
    else if (a === 'order-confirm') confirmBox('Mark this order as <b>paid</b> and switch the plan on for the buyer? Only do this when you saw the money arrive.', 'Confirm payment', function () {
      call('POST', '/api/admin/orders', { action: 'confirm', orderId: el.dataset.id }).then(function (r) { if (r.ok) { Vane.toast('ok', 'Paid. The plan is on.'); route(); } else Vane.toast('err', r.error); });
    });
    else if (a === 'soc-new') socForm(null);
    else if (a === 'soc-edit') socForm(S.social.links.filter(function (l) { return l.id === el.dataset.id; })[0]);
    else if (a === 'soc-delete') confirmBox('Remove <b>' + esc(el.dataset.name) + '</b> from the landing page? You can add it again later.', 'Remove link', function () {
      call('DELETE', '/api/admin/socials?id=' + encodeURIComponent(el.dataset.id)).then(function (r) { if (r.ok) { Vane.toast('ok', 'Link removed.'); route(); } else Vane.toast('err', r.error); });
    }, true);
    else if (a === 'revoke') confirmBox('End this plan now? The user falls back to the Free Trial limits.', 'End plan', function () {
      call('POST', '/api/admin/users', { action: 'revoke', userId: el.dataset.id }).then(function (r) { if (r.ok) { Vane.toast('ok', 'Plan ended.'); openUser(el.dataset.id); if (location.hash === '#users') loadUsers(S.seq); } else Vane.toast('err', r.error); });
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
