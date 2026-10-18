/* /app — dashboard */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = Vane.esc;

  // ───────────────────────── state ─────────────────────────
  var S = {
    user: null,
    uploads: false,
    channels: [],
    selected: new Set(),
    selectionTouched: false,
    upcoming: [],
    history: [],
    tab: 'upcoming',
    armed: {},          // two-step confirm state: key → timeout id
    submitting: false,
    refreshing: false,  // a background posts refresh is in flight
    rev: 0,             // bumped on every posts load, so a stale background refresh can be dropped
    quick: false,       // Quick Connect (shared bot) available on this server
    systemBot: '@VanePublishBot',
    connTab: 'quick',
    net: 'telegram'     // network shown in the preview
  };

  var TG_LIMIT = 4096, CAPTION_LIMIT = 1024, MAX_LEN = 10000;

  var ICON = {
    trash: '<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6M10 11v6M14 11v6"/></svg>',
    clock: '<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    video: '<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="14" height="14" rx="3"/><path d="M16 10l6-3v10l-6-3z"/></svg>',
    image: '<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>'
  };

  // ───────────────────────── networks ─────────────────────────
  // One entry per social network: icon, tile colour, text limit, preview background and the card in the connect dialog.
  // To open a network for connecting: set ready: true and add a <div data-step="<key>"> setup block to the dialog in app.html.
  // Limits: Telegram 4096 (1024 under an image or video), LinkedIn 3000, Threads 500, Bluesky 300 (graphemes), Mastodon 500 (a link counts as 23).
  var NET = {
    telegram: {
      name: 'Telegram', ready: true, blurb: 'Channels and groups', setup: 'Choose how Vane should publish to your channel.',
      tile: 'bg-sky-500/15 text-sky-300', limit: 4096, bg: '#0e1621', hint: '',
      icon: { d: 'M21.5 3.5L2.8 10.7l5.9 2.2 2.3 6.6 3.1-4.2 4.6 3.4zM8.7 12.9l12-8.6' }
    },
    linkedin: {
      name: 'LinkedIn', ready: false, blurb: 'Profiles and pages', setup: 'Choose which profile or page Vane should publish to.',
      tile: 'bg-blue-600/20 text-blue-300', limit: 3000, bg: '#000000', hint: 'LinkedIn folds long posts behind “see more” after about three lines.',
      icon: { fill: true, d: 'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z' }
    },
    threads: {
      name: 'Threads', ready: false, blurb: 'Your Threads profile', setup: 'Choose which profile Vane should publish to.',
      tile: 'bg-white/10 text-white/85', limit: 500, bg: '#101010', hint: '',
      icon: { fill: true, d: 'M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.589 12c.027 3.086.718 5.496 2.057 7.164 1.43 1.783 3.631 2.698 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.31-.71-.873-1.3-1.634-1.75-.192 1.352-.622 2.446-1.284 3.272-.886 1.102-2.14 1.704-3.73 1.79-1.202.065-2.361-.218-3.259-.801-1.063-.689-1.685-1.74-1.752-2.964-.065-1.19.408-2.285 1.33-3.082.88-.76 2.119-1.207 3.583-1.291a13.853 13.853 0 0 1 3.02.142c-.126-.742-.375-1.332-.75-1.757-.513-.586-1.308-.883-2.359-.89h-.029c-.844 0-1.992.232-2.721 1.32L7.734 7.847c.98-1.454 2.568-2.256 4.478-2.256h.044c3.194.02 5.097 1.975 5.287 5.388.108.046.216.094.321.142 1.49.7 2.58 1.761 3.154 3.07.797 1.82.871 4.79-1.548 7.158-1.85 1.81-4.094 2.628-7.277 2.65Zm1.003-11.69c-.242 0-.487.007-.739.021-1.836.103-2.98.946-2.916 2.143.067 1.256 1.452 1.839 2.784 1.767 1.224-.065 2.818-.543 3.086-3.71a10.5 10.5 0 0 0-2.215-.221z' }
    },
    bluesky: {
      name: 'Bluesky', ready: true, blurb: 'Your Bluesky account', setup: 'Sign in with an app password. It never opens your main account.',
      tile: 'bg-cyan-400/15 text-cyan-300', limit: 300, bg: '#161e27', hint: 'Bluesky counts graphemes, so an emoji is one character.',
      icon: { fill: true, d: 'M12 10.8c-1.087-2.114-4.046-6.053-6.798-7.995C2.566.944 1.561 1.266.902 1.565.139 1.908 0 3.08 0 3.768c0 .69.378 5.65.624 6.479.815 2.736 3.713 3.66 6.383 3.364.136-.02.275-.039.415-.056-.138.022-.276.04-.415.056-3.912.58-7.387 2.005-2.83 7.078 5.013 5.19 6.87-1.113 7.823-4.308.953 3.195 2.05 9.271 7.733 4.308 4.267-4.308 1.172-6.498-2.74-7.078a8.741 8.741 0 0 1-.415-.056c.14.017.279.036.415.056 2.67.297 5.568-.628 6.383-3.364.246-.828.624-5.79.624-6.478 0-.69-.139-1.861-.902-2.206-.659-.298-1.664-.62-4.3 1.24C16.046 4.748 13.087 8.687 12 10.8z' }
    },
    mastodon: {
      name: 'Mastodon', ready: true, blurb: 'Any Mastodon server', setup: 'Enter your server, then allow Vane to post on your server.',
      tile: 'bg-indigo-500/15 text-indigo-300', limit: 500, bg: '#191b22', hint: 'Mastodon counts every link as 23 characters, however long it is.',
      icon: { fill: true, d: 'M23.268 5.313c-.35-2.578-2.617-4.61-5.304-5.004C17.51.242 15.792 0 11.813 0h-.03c-3.98 0-4.835.242-5.288.309C3.882.692 1.496 2.518.917 5.127.64 6.412.61 7.837.661 9.143c.074 1.874.088 3.745.26 5.611.118 1.24.325 2.47.62 3.68.55 2.237 2.777 4.098 4.96 4.857 2.336.792 4.849.923 7.256.38.265-.061.527-.132.786-.213.585-.184 1.27-.39 1.774-.753a.057.057 0 0 0 .023-.043v-1.809a.052.052 0 0 0-.02-.041.053.053 0 0 0-.046-.01 20.282 20.282 0 0 1-4.709.545c-2.73 0-3.463-1.284-3.674-1.818a5.593 5.593 0 0 1-.319-1.433.053.053 0 0 1 .066-.054c1.517.363 3.072.546 4.632.546.376 0 .75 0 1.125-.01 1.57-.044 3.224-.124 4.768-.422.038-.008.077-.015.11-.024 2.435-.464 4.753-1.92 4.989-5.604.008-.145.03-1.52.03-1.67.002-.512.167-3.63-.024-5.545zm-3.748 9.195h-2.561V8.29c0-1.309-.55-1.976-1.67-1.976-1.23 0-1.846.79-1.846 2.35v3.403h-2.546V8.663c0-1.56-.617-2.35-1.848-2.35-1.112 0-1.668.668-1.67 1.977v6.218H4.822V8.102c0-1.31.337-2.35 1.011-3.12.696-.77 1.608-1.164 2.74-1.164 1.311 0 2.302.5 2.962 1.498l.638 1.06.638-1.06c.66-.999 1.65-1.498 2.96-1.498 1.13 0 2.043.395 2.74 1.164.675.77 1.012 1.81 1.012 3.12z' }
    }
  };
  var NET_ORDER = ['telegram', 'linkedin', 'threads', 'bluesky', 'mastodon'];
  // channels of a network this dashboard has no entry for (for example "x" or "webhook") get the generic link icon
  var NET_OTHER = { tile: 'bg-white/[0.08] text-white/70', icon: { d: 'M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.7-1.7' } };

  function netIcon(key, cls) {
    var ic = (NET[key] || NET_OTHER).icon;
    return '<svg class="' + cls + '" viewBox="0 0 24 24" aria-hidden="true" ' +
      (ic.fill ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"') +
      '><path d="' + ic.d + '"/></svg>';
  }
  function netTile(key) { return (NET[key] || NET_OTHER).tile; }
  function netName(key) { return NET[key] ? NET[key].name : key.charAt(0).toUpperCase() + key.slice(1); }

  // channels split by network: known networks in NET_ORDER first, anything else after them
  function groupChannels(list) {
    var map = {}, keys = [];
    list.forEach(function (c) { (map[c.platform] = map[c.platform] || []).push(c); });
    NET_ORDER.forEach(function (k) { if (map[k]) keys.push(k); });
    Object.keys(map).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); });
    return keys.map(function (k) { return { net: k, items: map[k] }; });
  }
  function groupHead(g) {
    return '<div class="net-group-label">' + netIcon(g.net, 'h-3.5 w-3.5') + '<span>' + esc(netName(g.net)) + '</span><span class="net-count">' + g.items.length + '</span></div>';
  }

  // ───────────────────────── time helpers ─────────────────────────
  var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
  var fmtWhen = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  var fmtHM = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
  var fmtMon = new Intl.DateTimeFormat(undefined, { month: 'short' });
  var fmtLong = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

  function toLocalInput(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function dur(ms) {
    var m = Math.max(0, Math.round(ms / 60000));
    if (m < 1) return '<1m';
    if (m < 60) return m + 'm';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ' + pad(m % 60) + 'm';
    var d = Math.floor(h / 24);
    return d + 'd ' + (h % 24) + 'h';
  }
  function rel(ts) {
    var diff = ts * 1000 - Date.now();
    return diff >= 0 ? 'in ' + dur(diff) : (Math.abs(diff) < 60000 ? 'just now' : dur(-diff) + ' ago');
  }

  // The server's "Authorize" page sends the browser back to /app?connect=mastodon&status=…: say what happened, then tidy the address bar.
  var MASTODON_RESULT = {
    ok: ['ok', 'Mastodon connected.'],
    denied: ['err', 'Mastodon was not connected: access was not allowed.'],
    expired: ['err', 'That sign-in took too long or was already used. Start again.'],
    duplicate: ['err', 'This Mastodon account is already connected.'],
    migrate: ['err', 'Mastodon is not enabled on this server yet. The database needs one update.'],
    failed: ['err', 'Could not finish connecting Mastodon. Try again.']
  };
  function reportMastodonReturn() {
    var q = new URLSearchParams(location.search);
    if (q.get('connect') !== 'mastodon') return;
    var res = MASTODON_RESULT[q.get('status')] || MASTODON_RESULT.failed;
    Vane.toast(res[0], res[1]);
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* address bar left as it is */ }
  }

  // ───────────────────────── boot ─────────────────────────
  async function boot() {
    var me = await Vane.api('GET', '/api/auth/me'); // 401 → /login
    if (!me.ok) return;
    S.user = me.data.user;
    var feats = me.data.features || {};
    S.uploads = !!feats.uploads;
    S.quick = !!feats.quickConnect;
    if (feats.systemBot) S.systemBot = feats.systemBot;

    var display = S.user.name || S.user.email.split('@')[0];
    $('userEmail').textContent = S.user.email;
    $('avatar').textContent = display.charAt(0).toUpperCase();
    var h = new Date().getHours();
    $('greeting').textContent = (h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening') + ', ' + display;
    $('today').textContent = fmtLong.format(new Date());
    $('tz').textContent = 'Times are in your timezone: ' + (Intl.DateTimeFormat().resolvedOptions().timeZone || 'local');
    picker.setEnabled(S.uploads);
    $('app').classList.remove('opacity-0');

    initQuick();
    var restored = restoreDraft();
    await Promise.all([loadChannels(), loadPosts('upcoming'), loadPosts('history'), loadApi()]);
    setTab('upcoming');
    renderAll();
    if (restored) Vane.toast('info', 'Your unsent draft is back.');
    reportMastodonReturn();

    setInterval(function () { renderStats(); renderPosts(); }, 30000);
    // live posts: poll while the tab is visible, and catch up the moment it is back in front
    // (a post may have been scheduled or sent from another device in the meantime)
    setInterval(function () { if (document.visibilityState === 'visible') refreshPostsQuietly(); }, 15000);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') refreshPostsQuietly(); });
    window.addEventListener('focus', refreshPostsQuietly);
    window.addEventListener('online', refreshPostsQuietly);
    setInterval(function () { if (document.visibilityState === 'visible') refreshApiQuietly(); }, 30000);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') refreshApiQuietly(); });
  }

  // ───────────────────────── data ─────────────────────────
  async function loadChannels() {
    var r = await Vane.api('GET', '/api/channels');
    if (!r.ok) { Vane.toast('err', r.error); return; }
    S.channels = r.data.channels;
    var ids = new Set(S.channels.map(function (c) { return c.id; }));
    S.selected.forEach(function (id) { if (!ids.has(id)) S.selected.delete(id); });
    if (!S.selectionTouched) S.channels.forEach(function (c) { S.selected.add(c.id); });
  }
  async function loadPosts(view) {
    var r = await Vane.api('GET', '/api/posts?view=' + view);
    if (!r.ok) { Vane.toast('err', r.error); return; }
    S.rev++;
    S[view] = r.data.posts;
  }
  // changes whenever a post appears, disappears or moves to another state / time
  function postsSig() {
    return [S.upcoming, S.history].map(function (list) {
      return list.map(function (p) { return p.id + ':' + p.status + ':' + p.attempts + ':' + p.scheduledAt; }).join('|');
    }).join('#');
  }
  // Silent refresh of both lists: no toasts, no full re-render (the composer and preview are left alone).
  async function refreshPostsQuietly() {
    if (S.refreshing || S.submitting) return;
    S.refreshing = true;
    var rev = S.rev, before = postsSig();
    var rs = await Promise.all([Vane.api('GET', '/api/posts?view=upcoming'), Vane.api('GET', '/api/posts?view=history')]);
    S.refreshing = false;
    if (!rs[0].ok || !rs[1].ok) return;   // offline or a server hiccup: keep what is on screen, retry next tick
    if (rev !== S.rev) return;            // the user's own action reloaded the lists meanwhile: this answer is stale
    S.rev++;
    S.upcoming = rs[0].data.posts;
    S.history = rs[1].data.posts;
    if (before !== postsSig()) { renderStats(); renderPosts(); }
  }

  // ───────────────────────── render: everything ─────────────────────────
  function renderAll() { renderStats(); renderChannels(); renderChips(); renderPreview(); renderPosts(); renderApi(); renderApiQuick(); validate(); }

  // ───────────────────────── stats ─────────────────────────
  function groupPosts(list) {
    var order = [], map = {};
    list.forEach(function (p) {
      if (!map[p.groupId]) { map[p.groupId] = []; order.push(p.groupId); }
      map[p.groupId].push(p);
    });
    return order.map(function (id) { return map[id]; });
  }
  function renderStats() {
    $('statChannels').textContent = S.channels.length;
    var groups = groupPosts(S.upcoming);
    $('statQueued').textContent = groups.length;
    var next = S.upcoming.filter(function (p) { return p.status === 'scheduled'; })[0];
    if (next) {
      var diff = next.scheduledAt * 1000 - Date.now();
      $('statNext').textContent = diff > 0 ? dur(diff) : 'now';
      $('statNextSub').textContent = fmtWhen.format(new Date(next.scheduledAt * 1000));
    } else {
      $('statNext').textContent = '—';
      $('statNextSub').textContent = 'Until your next post';
    }
    // everything below is derived from the same two lists: hashtag memory and the Insights card
    if (tags) tags.setPosts(S.history.concat(S.upcoming));
    Vane.renderInsights($('insights'), S.history, S.upcoming, {
      limit: 200,                                   // the server returns at most 200 posts per list
      netIcon: netIcon,
      onTag: function (t) { tags.insert(t); }
    });
  }

  // ───────────────────────── channels ─────────────────────────
  function renderChannels() {
    var box = $('channels');
    if (!S.channels.length) {
      box.innerHTML =
        '<div class="rounded-2xl border border-dashed border-white/10 px-5 py-8 text-center">' +
          '<div class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl ' + netTile('other') + '">' + netIcon('other', 'h-5 w-5') + '</div>' +
          '<p class="mt-4 text-sm font-medium">No channels yet</p>' +
          '<p class="mx-auto mt-1 max-w-[16rem] text-xs leading-relaxed text-white/45">Connect a social network to start scheduling posts.</p>' +
          '<button type="button" data-act="connect" class="btn btn-white btn-sm mt-5">Connect a channel</button>' +
        '</div>';
      return;
    }
    box.innerHTML = groupChannels(S.channels).map(function (g, i) {
      return '<div' + (i ? ' class="pt-2"' : '') + '>' + groupHead(g) + '<div class="space-y-2.5">' + g.items.map(function (c) {
        var armed = !!S.armed['del:' + c.id];
        return '<div class="flex items-center gap-3 rounded-2xl bg-white/[0.04] p-3 ring-1 ring-white/5">' +
          '<div class="net-tile ' + netTile(c.platform) + '">' + netIcon(c.platform, 'h-5 w-5') + '</div>' +
          '<div class="min-w-0 flex-1">' +
            '<div class="truncate text-sm font-medium">' + esc(c.name) + '</div>' +
            '<div class="mt-0.5 text-xs text-white/40">Added ' + esc(new Date(c.createdAt * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })) + '</div>' +
          '</div>' +
          (c.platform === 'telegram' ? '<button type="button" data-act="test" data-id="' + esc(c.id) + '" class="btn btn-ghost btn-sm shrink-0">Send test</button>' : '') +
          (armed
            ? '<button type="button" data-act="del" data-id="' + esc(c.id) + '" class="btn btn-danger btn-sm shrink-0">Remove?</button>'
            : '<button type="button" data-act="del" data-id="' + esc(c.id) + '" class="icon-btn shrink-0" aria-label="Remove ' + esc(c.name) + '">' + ICON.trash + '</button>') +
        '</div>';
      }).join('') + '</div></div>';
    }).join('');
  }

  function arm(key, ms) {
    clearTimeout(S.armed[key]);
    S.armed[key] = setTimeout(function () { delete S.armed[key]; renderChannels(); renderPosts(); renderApiKeys(); }, ms || 3200);
  }
  function disarm(key) { clearTimeout(S.armed[key]); delete S.armed[key]; }

  $('channels').addEventListener('click', async function (e) {
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var act = btn.getAttribute('data-act'), id = btn.getAttribute('data-id');

    if (act === 'connect') return openConnect();

    if (act === 'test') {
      btn.disabled = true; var old = btn.textContent; btn.innerHTML = '<span class="spinner"></span>';
      var r = await Vane.api('POST', '/api/channels/' + encodeURIComponent(id) + '/test', {});
      btn.disabled = false; btn.textContent = old;
      if (r.ok) Vane.toast('ok', 'Test message sent. Check your channel.');
      else Vane.toast('err', r.error);
      return;
    }

    if (act === 'del') {
      var key = 'del:' + id;
      if (!S.armed[key]) { arm(key); renderChannels(); return; }
      disarm(key);
      btn.disabled = true;
      var d = await Vane.api('DELETE', '/api/channels/' + encodeURIComponent(id));
      if (!d.ok) { Vane.toast('err', d.error); renderChannels(); return; }
      var n = d.data.deletedScheduledPosts || 0;
      Vane.toast('ok', n ? 'Channel removed. ' + n + ' scheduled post' + (n > 1 ? 's were' : ' was') + ' cancelled.' : 'Channel removed.');
      S.selected.delete(id);
      await Promise.all([loadChannels(), loadPosts('upcoming'), loadPosts('history')]);
      renderAll();
    }
  });

  // ───────────────────────── connect dialog ─────────────────────────
  var dlg = $('connectDialog');
  var POLL_MS = window.__VANE_POLL_MS || 3000;

  /** Copies text; falls back to a hidden textarea where the Clipboard API is unavailable. */
  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
    } catch (e) { /* fall through */ }
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var done = document.execCommand && document.execCommand('copy');
      ta.remove();
      return !!done;
    } catch (e) { return false; }
  }
  function copyWithToast(text, label) {
    copyText(text).then(function (ok) { Vane.toast(ok ? 'ok' : 'info', ok ? label + ' copied.' : 'Select the text and press Ctrl+C to copy it.'); });
  }

  function showErr(box, form, msg) {
    box.textContent = msg; box.classList.remove('hidden');
    if (form) { form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake'); }
  }
  function hideErr(box) { box.classList.add('hidden'); box.textContent = ''; }

  // ---- tabs
  function setConnTab(tab) {
    var quick = tab === 'quick';
    S.connTab = tab;
    $('connSeg').style.transform = quick ? 'translateX(0)' : 'translateX(100%)';
    $('tabQuick').setAttribute('aria-selected', String(quick));
    $('tabCustom').setAttribute('aria-selected', String(!quick));
    $('panelQuick').classList.toggle('hidden', !quick);
    $('panelCustom').classList.toggle('hidden', quick);
    $('connNote').textContent = quick
      ? 'Vane publishes through its own bot, so none of your credentials are stored.'
      : 'The bot token is encrypted (AES-256) before it is stored and is never shown again.';
    if (quick) qResume(); else qPause();
  }
  $('tabQuick').addEventListener('click', function () { setConnTab('quick'); });
  $('tabCustom').addEventListener('click', function () { setConnTab('custom'); });
  $('qOffSwitch').addEventListener('click', function () { setConnTab('custom'); });

  // ---- Quick Connect state machine:  enter → verify → ready   (or → expired)
  var Q = { phase: 'enter', id: '', code: '', expiresAt: 0, title: '', pollTimer: null, tickTimer: null, polling: false };
  var fmtClock = function (sec) { sec = Math.max(0, sec); return Math.floor(sec / 60) + ':' + pad(sec % 60); };

  function qStopTimers() { clearInterval(Q.pollTimer); clearInterval(Q.tickTimer); Q.pollTimer = Q.tickTimer = null; }
  function qPause() { qStopTimers(); }
  function qResume() { if (Q.phase === 'verify') qStartTimers(); }

  function qRender() {
    var verifying = Q.phase === 'verify', ready = Q.phase === 'ready', expired = Q.phase === 'expired';
    var show = function (id, on) { var el = $(id); el.classList.toggle('hidden', !on); el.classList.toggle('flex', on); };
    show('qS3', Q.phase !== 'enter'); show('qS4', ready);
    $('qChat').disabled = Q.phase !== 'enter';
    $('qCheck').disabled = Q.phase !== 'enter';
    if (Q.phase === 'enter') return;

    $('qChatTitle').textContent = Q.title;
    $('qCode').textContent = Q.code;
    $('qWaitSpin').classList.toggle('hidden', !verifying);
    $('qRetry').classList.toggle('hidden', !expired);
    $('qReset').classList.toggle('hidden', ready);
    $('qCodeCopy').disabled = !verifying;
    if (verifying) { $('qWaitText').textContent = 'Waiting for your message…'; $('qWaitText').className = ''; }
    if (ready) { $('qWaitText').textContent = '✓ Code received. The channel is confirmed.'; $('qWaitText').className = 'font-medium text-emerald-300'; $('qTimer').textContent = ''; }
    if (expired) { $('qWaitText').textContent = 'This code expired.'; $('qWaitText').className = 'text-amber-300'; $('qTimer').textContent = ''; }
  }

  function qTick() {
    if (Q.phase !== 'verify') return;
    var left = Q.expiresAt - Math.floor(Date.now() / 1000);
    $('qTimer').textContent = fmtClock(left);
    if (left <= 0) qPoll();      // one last look: the code may have been seen right at the deadline
  }
  async function qPoll() {
    if (Q.phase !== 'verify' || Q.polling) return;
    Q.polling = true;
    var r = await Vane.api('GET', '/api/channels/quick/status?id=' + encodeURIComponent(Q.id));
    Q.polling = false;
    if (Q.phase !== 'verify') return;           // user moved on while we were waiting
    if (!r.ok) {
      if (r.status === 404) { qFail('This verification is no longer valid. Get a new code.'); }
      return;                                   // transient error: the next poll will try again
    }
    if (r.data.verified) { qPause(); Q.phase = 'ready'; $('qName').value = (Q.title || 'My Telegram channel').slice(0, 80); qRender(); $('qName').focus(); Vane.toast('ok', 'Code received. Channel confirmed.'); }
    else if (r.data.expired) { qPause(); Q.phase = 'expired'; qRender(); }
  }
  function qFail(msg) { qPause(); Q.phase = 'expired'; qRender(); $('qWaitText').textContent = msg; }
  function qStartTimers() {
    qStopTimers();
    Q.pollTimer = setInterval(qPoll, POLL_MS);
    Q.tickTimer = setInterval(qTick, 1000);
    qTick();
  }
  function qReset() {
    qStopTimers();
    Q = { phase: 'enter', id: '', code: '', expiresAt: 0, title: '', pollTimer: null, tickTimer: null, polling: false };
    hideErr($('qErr')); qRender();
  }

  $('qForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    hideErr($('qErr'));
    var chat = $('qChat').value.trim();
    if (!chat) return showErr($('qErr'), $('qForm'), 'Enter your channel @username (or a t.me link).');
    $('qCheck').disabled = true; $('qCheckSpin').classList.remove('hidden'); $('qCheckLabel').textContent = 'Checking…';
    var r = await Vane.api('POST', '/api/channels/quick/start', { chat: chat });
    $('qCheckSpin').classList.add('hidden'); $('qCheckLabel').textContent = 'Check access';
    if (!r.ok) { $('qCheck').disabled = false; return showErr($('qErr'), $('qForm'), r.error); }

    Q.id = r.data.verificationId; Q.code = r.data.code; Q.expiresAt = r.data.expiresAt;
    Q.title = (r.data.chat && r.data.chat.title) || chat; Q.phase = 'verify';
    qRender(); qStartTimers();
  });
  $('qCodeCopy').addEventListener('click', function () { copyWithToast(Q.code, 'Code'); });
  $('qBotCopy').addEventListener('click', function () { copyWithToast(S.systemBot, 'Bot name'); });
  $('qReset').addEventListener('click', qReset);
  $('qRetry').addEventListener('click', function () { var chat = $('qChat').value; qReset(); $('qChat').value = chat; $('qForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); });

  $('qConnect').addEventListener('click', async function () {
    if (Q.phase !== 'ready') return;
    hideErr($('qErr'));
    var name = $('qName').value.trim() || Q.title || 'My Telegram channel';
    $('qConnect').disabled = true; $('qConnectSpin').classList.remove('hidden'); $('qConnectLabel').textContent = 'Connecting…';
    var r = await Vane.api('POST', '/api/channels/add', { platform: 'telegram', method: 'quick', name: name, credentials: { verificationId: Q.id } });
    $('qConnect').disabled = false; $('qConnectSpin').classList.add('hidden'); $('qConnectLabel').textContent = 'Connect channel';
    if (!r.ok) {
      if (r.status === 404 || r.status === 410) { qFail(r.error); }
      return showErr($('qErr'), null, r.error);
    }
    var title = r.data.telegram && r.data.telegram.chatTitle;
    closeConnect();
    Vane.toast('ok', 'Connected' + (title ? ' to ' + title : '') + '. Send a test message to try it.');
    S.selected.add(r.data.channel.id);
    await loadChannels();
    renderAll();
  });

  // ---- Custom bot (the original flow)
  $('cTokenToggle').addEventListener('click', function () {
    var show = $('cToken').type === 'password';
    $('cToken').type = show ? 'text' : 'password';
    this.textContent = show ? 'Hide' : 'Show';
  });
  $('connectForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var btn = $('cSubmit');
    hideErr($('cErr'));

    var name = $('cName').value.trim() || 'My Telegram channel';
    var token = $('cToken').value.trim();
    var chat = $('cChat').value.trim();
    if (!token) return showErr($('cErr'), $('connectForm'), 'Paste the bot token from @BotFather.');
    if (!chat) return showErr($('cErr'), $('connectForm'), 'Enter the channel @username or numeric id.');

    btn.disabled = true; $('cSpin').classList.remove('hidden'); $('cLabel').textContent = 'Checking with Telegram…';
    var r = await Vane.api('POST', '/api/channels/add', { platform: 'telegram', method: 'custom', name: name, credentials: { botToken: token, chatId: chat } });
    btn.disabled = false; $('cSpin').classList.add('hidden'); $('cLabel').textContent = 'Verify & connect';

    if (!r.ok) return showErr($('cErr'), $('connectForm'), r.error);
    var title = r.data.telegram && r.data.telegram.chatTitle;
    closeConnect();
    Vane.toast('ok', 'Connected' + (title ? ' to ' + title : '') + '. Send a test message to try it.');
    S.selected.add(r.data.channel.id);
    await loadChannels();
    renderAll();
  });

  // ---- Bluesky: handle + app password
  $('bPassToggle').addEventListener('click', function () {
    var show = $('bPass').type === 'password';
    $('bPass').type = show ? 'text' : 'password';
    this.textContent = show ? 'Hide' : 'Show';
  });
  $('bForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var btn = $('bSubmit');
    hideErr($('bErr'));

    var handle = $('bHandle').value.trim().replace(/^@/, '');
    var pass = $('bPass').value.trim();
    var name = $('bName').value.trim() || handle;
    if (!handle) return showErr($('bErr'), $('bForm'), 'Enter your Bluesky handle, like alice.bsky.social.');
    if (!pass) return showErr($('bErr'), $('bForm'), 'Paste the app password you created in Bluesky.');

    btn.disabled = true; $('bSpin').classList.remove('hidden'); $('bLabel').textContent = 'Checking with Bluesky…';
    var r = await Vane.api('POST', '/api/channels/add', { platform: 'bluesky', name: name, credentials: { identifier: handle, appPassword: pass } });
    btn.disabled = false; $('bSpin').classList.add('hidden'); $('bLabel').textContent = 'Verify & connect';

    if (!r.ok) return showErr($('bErr'), $('bForm'), r.error);
    closeConnect();
    Vane.toast('ok', 'Connected to ' + (r.data.bluesky && r.data.bluesky.handle ? '@' + r.data.bluesky.handle : 'Bluesky') + '.');
    S.selected.add(r.data.channel.id);
    await loadChannels();
    renderAll();
  });

  // ---- Mastodon: the server address, then the server's own "Authorize" page
  $('mForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var btn = $('mSubmit');
    hideErr($('mErr'));

    var instance = $('mInstance').value.trim();
    if (!instance) return showErr($('mErr'), $('mForm'), 'Enter the address of your Mastodon server, like mastodon.social.');

    btn.disabled = true; $('mSpin').classList.remove('hidden'); $('mLabel').textContent = 'Contacting your server…';
    var r = await Vane.api('POST', '/api/channels/mastodon/start', { instance: instance, name: $('mName').value.trim() });
    if (!r.ok) {
      btn.disabled = false; $('mSpin').classList.add('hidden'); $('mLabel').textContent = 'Continue';
      return showErr($('mErr'), $('mForm'), r.error);
    }
    $('mLabel').textContent = 'Opening ' + r.data.instance + '…';
    Vane.go(r.data.authorizeUrl);
  });

  // ---- steps: pick a network, then set it up (each network's setup is the block with its data-step)
  function renderNetGrid() {
    $('netGrid').innerHTML = NET_ORDER.map(function (k) {
      var n = NET[k];
      return '<button type="button" class="net-card" data-net="' + k + '"' + (n.ready ? '' : ' disabled') + '>' +
        '<span class="net-tile ' + n.tile + '">' + netIcon(k, 'h-5 w-5') + '</span>' +
        '<span class="min-w-0 flex-1"><span class="block text-sm font-semibold">' + esc(n.name) + '</span><span class="block truncate text-xs text-white/45">' + esc(n.ready ? n.blurb : 'Coming soon') + '</span></span>' +
        (n.ready ? '' : '<span class="rounded-full bg-white/[0.08] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white/50">Soon</span>') +
      '</button>';
    }).join('');
  }
  function showStep(step) {
    var n = NET[step];
    Array.prototype.forEach.call(dlg.querySelectorAll('[data-step]'), function (el) {
      el.classList.toggle('hidden', el.getAttribute('data-step') !== step);
    });
    $('connectBack').classList.toggle('hidden', !n);
    $('connIcon').className = 'flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ' + netTile(step);
    $('connIcon').innerHTML = netIcon(step, 'h-5 w-5');
    $('connectTitle').textContent = n ? 'Connect ' + n.name : 'Connect a channel';
    $('connectSub').textContent = n ? n.setup : 'Choose a social network.';
    if (step === 'telegram') setConnTab(S.connTab); else qPause();
  }
  function openStep(step) {
    showStep(step);
    setTimeout(function () {
      var first = step === 'telegram' ? ($('panelQuick').classList.contains('hidden') ? $('cName') : $('qChat')) : step === 'bluesky' ? $('bHandle') : step === 'mastodon' ? $('mInstance') : dlg.querySelector('.net-card:not(:disabled)');
      if (first) first.focus();
    }, 60);
  }
  $('netGrid').addEventListener('click', function (e) {
    var b = e.target.closest('[data-net]');
    if (b && !b.disabled) openStep(b.getAttribute('data-net'));
  });
  $('connectBack').addEventListener('click', function () { openStep('pick'); });

  // ---- open / close
  function openConnect(net) {
    $('connectForm').reset(); hideErr($('cErr'));
    $('cToken').type = 'password'; $('cTokenToggle').textContent = 'Show';
    $('mForm').reset(); hideErr($('mErr')); $('mSubmit').disabled = false; $('mSpin').classList.add('hidden'); $('mLabel').textContent = 'Continue';
    $('bForm').reset(); hideErr($('bErr')); $('bPass').type = 'password'; $('bPassToggle').textContent = 'Show';
    qReset(); $('qChat').value = '';

    $('qBot').textContent = S.systemBot;
    $('qOff').classList.toggle('hidden', S.quick);
    $('qOn').classList.toggle('hidden', !S.quick);
    $('tabQuickBadge').classList.toggle('hidden', !S.quick);
    S.connTab = S.quick ? 'quick' : 'custom';
    renderNetGrid();

    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    openStep(NET[net] && NET[net].ready ? net : 'pick');
  }
  function closeConnect() {
    qStopTimers();
    $('cToken').value = ''; $('bPass').value = ''; // don't leave the secrets sitting in the DOM
    if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
  }
  $('connectBtn').addEventListener('click', function () { openConnect(); });
  $('connectClose').addEventListener('click', closeConnect);
  $('cCancel').addEventListener('click', closeConnect);
  $('bCancel').addEventListener('click', closeConnect);
  $('mCancel').addEventListener('click', closeConnect);
  dlg.addEventListener('click', function (e) { if (e.target === dlg) closeConnect(); });
  dlg.addEventListener('close', function () { $('cToken').value = ''; $('bPass').value = ''; qStopTimers(); });

  // ───────────────────────── composer ─────────────────────────
  var textEl = $('text'), whenEl = $('when');

  function renderChips() {
    var box = $('chipsBox');
    if (!S.channels.length) {
      box.innerHTML = '<button type="button" data-act="connect" class="chip">' + netIcon('other', 'h-3.5 w-3.5') + ' Connect a channel first</button>';
      return;
    }
    box.innerHTML = groupChannels(S.channels).map(function (g) {
      return '<div>' + groupHead(g) + '<div class="flex flex-wrap gap-2.5">' + g.items.map(function (c) {
        return '<button type="button" class="chip" data-id="' + esc(c.id) + '" aria-pressed="' + S.selected.has(c.id) + '">' + netIcon(c.platform, 'h-3.5 w-3.5') + '<span>' + esc(c.name) + '</span></button>';
      }).join('') + '</div></div>';
    }).join('');
  }
  $('chipsBox').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.getAttribute('data-act') === 'connect') return openConnect();
    var id = b.getAttribute('data-id');
    S.selectionTouched = true;
    if (S.selected.has(id)) S.selected.delete(id); else S.selected.add(id);
    b.setAttribute('aria-pressed', String(S.selected.has(id)));
    renderPreview(); validate();
  });

  // quick time chips
  var QUICK = [];
  function initQuick() {
    var now = new Date();
    var h1 = new Date(now.getTime() + 3600e3); h1.setSeconds(0, 0);
    var t9 = new Date(now); t9.setDate(t9.getDate() + 1); t9.setHours(9, 0, 0, 0);
    var t18 = new Date(now); t18.setDate(t18.getDate() + 1); t18.setHours(18, 0, 0, 0);
    QUICK = [
      { label: 'In 1 hour', value: toLocalInput(h1) },
      { label: 'Tomorrow 09:00', value: toLocalInput(t9) },
      { label: 'Tomorrow 18:00', value: toLocalInput(t18) }
    ];
    $('quick').innerHTML = QUICK.map(function (q, i) {
      return '<button type="button" class="chip" data-i="' + i + '" aria-pressed="false">' + ICON.clock + '<span>' + esc(q.label) + '</span></button>';
    }).join('');
    whenEl.value = QUICK[1].value;
    syncQuick();
  }
  function syncQuick() {
    var btns = $('quick').querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) btns[i].setAttribute('aria-pressed', String(QUICK[i].value === whenEl.value));
  }
  $('quick').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    whenEl.value = QUICK[Number(b.getAttribute('data-i'))].value;
    syncQuick(); renderPreview(); validate();
  });
  whenEl.addEventListener('focus', function () {
    var min = new Date(Date.now() + 60000); whenEl.min = toLocalInput(min);
  });
  whenEl.addEventListener('input', function () { syncQuick(); renderPreview(); validate(); });

  // media: the MediaPicker component owns upload, progress and preview
  var picker = Vane.createMediaPicker($('media'), {
    enabled: false,                         // enabled in boot() once the server reports R2 is bound
    dropTarget: $('composer'),
    onChange: function () { renderPreview(); validate(); },
    onBusy: function () { validate(); }
  });
  function currentMedia() { return picker.getUrl(); }

  // Paste a screenshot / copied image straight into the text box.
  $('text').addEventListener('paste', function (e) {
    var files = e.clipboardData && e.clipboardData.files;
    if (!files || !files.length) return;
    for (var i = 0; i < files.length; i++) {
      if (/^(image|video)\//.test(files[i].type)) { e.preventDefault(); picker.handleFile(files[i]); return; }
    }
  });

  // text + counter
  textEl.addEventListener('input', function () { renderPreview(); validate(); });

  // hashtag memory: suggestions from past posts while you type "#" (assets/insights.js)
  var tags = Vane.createTagAssist(textEl, $('tagBar'));

  // Ctrl/⌘ + Enter schedules
  textEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); $('schedBtn').click(); }
  });
  $('schedBtn').title = 'Ctrl / ⌘ + Enter';

  // Draft: the text survives a reload or a closed tab. Kept per account in this browser only; removed on sign-out and once scheduled.
  var draftTimer = null;
  function draftKey() { return 'vane:draft:' + S.user.id; }
  function saveDraft() {
    clearTimeout(draftTimer);
    if (!S.user) return;
    try {
      if (textEl.value.trim()) localStorage.setItem(draftKey(), textEl.value); else localStorage.removeItem(draftKey());
    } catch (e) { /* storage blocked or full: the draft is a convenience, never an error */ }
  }
  function restoreDraft() {
    try {
      var d = localStorage.getItem(draftKey());
      if (d && d.trim() && !textEl.value) { textEl.value = d; return true; }
    } catch (e) { /* storage blocked */ }
    return false;
  }
  textEl.addEventListener('input', function () { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 400); });
  window.addEventListener('pagehide', saveDraft);

  // The selected network whose limit is closest to (or past) the text length: with several networks that is the strictest one.
  function tightest(raw, media) {
    var worst = null;
    S.channels.forEach(function (c) {
      if (!S.selected.has(c.id)) return;
      var limit = netLimit(c.platform, !!media), len = netLen(c.platform, raw);
      if (!worst || limit - len < worst.limit - worst.len) worst = { net: c.platform, len: len, limit: limit };
    });
    return worst || { net: 'telegram', len: raw.length, limit: media ? CAPTION_LIMIT : TG_LIMIT };
  }

  // validation (live: drives the hint and the button)
  function validate() {
    var text = textEl.value.trim(), media = currentMedia();
    var t = tightest(textEl.value, media), len = t.len, limit = t.limit;
    var counter = $('count');
    counter.textContent = len + ' / ' + limit;
    counter.className = 'rounded-full px-2.5 py-1 text-xs font-medium ' + (len > limit ? 'bg-red-500/15 text-red-300' : 'bg-white/[0.06] text-white/50');

    var msg = '';
    if (picker.isBusy()) msg = 'Waiting for the upload to finish…';
    else if (!S.channels.length) msg = 'Connect a channel to start.';
    else if (!S.selected.size) msg = 'Pick at least one channel.';
    else if (!text && !media) msg = 'Write something or add an image or video.';
    else if (len > limit) msg = media && t.net === 'telegram' ? 'With an image or video the text can be at most ' + CAPTION_LIMIT + ' characters.' : 'Text is too long for ' + netName(t.net) + '.';
    else if (!whenEl.value || isNaN(new Date(whenEl.value).getTime())) msg = 'Pick a date and time.';
    else if (new Date(whenEl.value).getTime() <= Date.now() + 30000) msg = 'Pick a time at least a minute from now.';

    $('hint').textContent = msg;
    $('schedBtn').disabled = !!msg || S.submitting;
    return msg;
  }

  // ───────────────────────── preview (per network) ─────────────────────────
  var EMPTY = '<span class="text-white/35">Your post will appear here…</span>';
  var segmenter = window.Intl && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

  function netLen(net, text) {
    if (net === 'mastodon') return Array.from(text.replace(/https?:\/\/[^\s]+/g, 'x'.repeat(23))).length;
    return net === 'bluesky' && segmenter ? Array.from(segmenter.segment(text)).length : text.length;
  }
  function netLimit(net, hasMedia) {
    if (!NET[net]) return MAX_LEN;
    return net === 'telegram' && hasMedia ? CAPTION_LIMIT : NET[net].limit;
  }

  function pvAvatar(px, name) {
    return '<div class="flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-sky-400 text-xs font-bold" style="width:' + px + 'px;height:' + px + 'px">' + esc(name.charAt(0).toUpperCase()) + '</div>';
  }
  function pvIco(path) {
    return '<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="' + path + '"/></svg>';
  }
  var PV_ACTIONS =
    pvIco('M21 12a8 8 0 01-11.6 7.1L3 21l1.9-5.4A8 8 0 1121 12z') +
    pvIco('M17 2l4 4-4 4M3 11V9a3 3 0 013-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 01-3 3H3') +
    pvIco('M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 00-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 000-7.8z') +
    pvIco('M4 12v7a1 1 0 001 1h14a1 1 0 001-1v-7M16 6l-4-4-4 4M12 2v13');

  function pvMedia(m, cls) {
    if (!m) return '';
    return m.kind === 'video'
      ? '<video src="' + esc(m.url) + '" controls playsinline preload="metadata" class="' + cls + ' bg-black"></video>'
      : '<img src="' + esc(m.url) + '" alt="" referrerpolicy="no-referrer" class="' + cls + ' bg-black/20 object-cover" data-hide-on-error />';
  }

  function viewTelegram(c) {
    return '<div class="flex items-center gap-2.5 border-b border-white/5 bg-[#17212b] px-3.5 py-2.5">' +
        '<div class="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-sky-400 text-sm font-bold">' + esc(c.title.charAt(0).toUpperCase()) + '</div>' +
        '<div class="min-w-0 leading-tight"><div class="truncate text-[13px] font-semibold">' + esc(c.title) + '</div><div class="text-[11px] text-white/45">channel</div></div>' +
      '</div>' +
      '<div class="p-3.5"><div class="max-w-[94%] overflow-hidden rounded-2xl rounded-tl-md bg-[#182533]">' +
        pvMedia(c.m, 'max-h-56 w-full') +
        '<div class="px-3 py-2 text-[13px] leading-snug">' +
          (c.text ? Vane.rich(c.text) : EMPTY) +
          '<div class="mt-1.5 flex justify-end text-[10.5px] text-white/40">' + esc(c.when) + '</div>' +
        '</div>' +
      '</div></div>';
  }
  function viewLinkedin(c) {
    var shown = c.text, more = false;
    if (shown.length > 220) { shown = shown.slice(0, 220).replace(/\s+\S*$/, ''); more = true; }
    return '<div class="p-3"><div class="overflow-hidden rounded-xl bg-[#1b1f23] ring-1 ring-white/10">' +
        '<div class="flex gap-2.5 p-3 pb-0">' + pvAvatar(40, c.name) +
          '<div class="min-w-0 leading-tight"><div class="truncate text-[13px] font-semibold">' + esc(c.name) + '</div><div class="text-[11px] text-white/40">' + esc(c.when || 'Scheduled') + '</div></div></div>' +
        '<div class="break-words px-3 pt-2.5 text-[13px] leading-snug text-white/90">' + (shown ? Vane.rich(shown) : EMPTY) + (more ? '… <span class="text-white/50">see more</span>' : '') + '</div>' +
        pvMedia(c.m, 'mt-2.5 max-h-56 w-full') +
        '<div class="mt-3 flex justify-between border-t border-white/10 px-3 py-2 text-[11.5px] text-white/55"><span>Like</span><span>Comment</span><span>Repost</span><span>Send</span></div>' +
      '</div></div>';
  }
  function viewThreads(c) {
    return '<div class="p-3.5"><div class="flex gap-2.5">' + pvAvatar(36, c.name) +
      '<div class="min-w-0 flex-1">' +
        '<div class="flex flex-wrap items-center gap-x-1.5 text-[13px]"><span class="font-semibold">' + esc(c.handle) + '</span><span class="text-white/40">' + esc(c.when) + '</span></div>' +
        '<div class="mt-1 break-words text-[13.5px] leading-snug">' + (c.text ? Vane.rich(c.text) : EMPTY) + '</div>' +
        pvMedia(c.m, 'mt-2.5 max-h-56 w-full rounded-xl') +
        '<div class="mt-3 flex gap-5 text-white/40">' + PV_ACTIONS + '</div>' +
      '</div></div></div>';
  }
  function viewBluesky(c) {
    return '<div class="p-3.5"><div class="flex gap-2.5">' + pvAvatar(40, c.name) +
      '<div class="min-w-0 flex-1">' +
        '<div class="flex flex-wrap items-baseline gap-x-1 text-[13px]"><span class="font-semibold">' + esc(c.name) + '</span><span class="truncate text-white/45">@' + esc(c.handle) + '.bsky.social</span>' + (c.when ? '<span class="text-white/35">· ' + esc(c.when) + '</span>' : '') + '</div>' +
        '<div class="mt-1 break-words text-[13.5px] leading-snug">' + (c.text ? Vane.rich(c.text) : EMPTY) + '</div>' +
        pvMedia(c.m, 'mt-2.5 max-h-56 w-full rounded-xl') +
        '<div class="mt-3 flex justify-between pr-6 text-white/40">' + PV_ACTIONS + '</div>' +
      '</div></div></div>';
  }
  function viewMastodon(c) {
    return '<div class="p-3.5"><div class="overflow-hidden rounded-xl bg-[#282c37] ring-1 ring-white/10"><div class="flex gap-2.5 p-3">' + pvAvatar(40, c.name) +
      '<div class="min-w-0 flex-1">' +
        '<div class="leading-tight"><div class="truncate text-[13px] font-semibold">' + esc(c.name) + '</div><div class="truncate text-[11.5px] text-white/45">@' + esc(c.handle) + (c.when ? ' · ' + esc(c.when) : '') + '</div></div>' +
        '<div class="mt-2 break-words text-[13.5px] leading-snug">' + (c.text ? Vane.rich(c.text) : EMPTY) + '</div>' +
        pvMedia(c.m, 'mt-2.5 max-h-56 w-full rounded-lg') +
        '<div class="mt-3 flex justify-between pr-6 text-white/40">' + PV_ACTIONS + '</div>' +
      '</div></div></div></div>';
  }
  var PV_VIEW = { telegram: viewTelegram, linkedin: viewLinkedin, threads: viewThreads, bluesky: viewBluesky, mastodon: viewMastodon };

  // tabs are built once, then only their pressed state changes (keeps keyboard focus)
  function syncPvTabs() {
    var box = $('pvTabs');
    if (!box.children.length) {
      NET_ORDER.forEach(function (k) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip !px-3 !py-1.5 !text-xs';
        b.setAttribute('data-net', k);
        b.textContent = NET[k].name;
        b.addEventListener('click', function () { S.net = k; renderPreview(); });
        box.appendChild(b);
      });
    }
    Array.prototype.forEach.call(box.children, function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-net') === S.net));
    });
  }

  function renderPreview() {
    var raw = textEl.value, text = raw.trim(), m = picker.getMedia();
    var chosen = S.channels.filter(function (c) { return S.selected.has(c.id); });
    var first = chosen.filter(function (c) { return c.platform === S.net; })[0] || chosen[0];
    var display = S.user ? (S.user.name || S.user.email.split('@')[0]) : 'You';
    var c = {
      text: text, m: m,
      title: first ? first.name : 'Your channel',
      name: display,
      handle: display.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'you',
      when: whenEl.value && !isNaN(new Date(whenEl.value).getTime()) ? fmtHM.format(new Date(whenEl.value)) : ''
    };
    var net = NET[S.net] ? S.net : 'telegram';
    syncPvTabs();
    $('preview').style.background = NET[net].bg;
    $('preview').innerHTML = PV_VIEW[net](c);

    var len = netLen(net, raw), limit = netLimit(net, !!m), over = len > limit;
    $('pvCount').textContent = len + ' / ' + limit;
    $('pvCount').className = 'rounded-full px-2.5 py-1 text-xs font-medium ' + (over ? 'bg-red-500/15 text-red-300' : 'bg-white/[0.06] text-white/50');
    $('pvNote').className = 'mt-3 min-h-[1rem] text-xs ' + (over ? 'text-red-300' : 'text-white/40');
    $('pvNote').textContent = over
      ? NET[net].name + ' allows ' + limit + ' characters' + (net === 'telegram' && m ? ' under an image or video' : '') + ', so this post is ' + (len - limit) + ' over.'
      : NET[net].hint;
  }
  document.addEventListener('error', function (e) {
    if (e.target && e.target.tagName === 'IMG' && e.target.hasAttribute('data-hide-on-error')) e.target.style.display = 'none';
  }, true);

  // submit
  $('schedBtn').addEventListener('click', async function () {
    var problem = validate();
    if (problem || S.submitting) return;

    S.submitting = true; $('schedBtn').disabled = true;
    $('schedSpin').classList.remove('hidden'); $('schedLabel').textContent = 'Scheduling…';

    var body = {
      content: textEl.value.trim(),
      channelIds: Array.from(S.selected),
      scheduledAt: new Date(whenEl.value).toISOString()
    };
    if (currentMedia()) body.mediaUrl = currentMedia();

    var r = await Vane.api('POST', '/api/posts', body);
    S.submitting = false;
    $('schedSpin').classList.add('hidden'); $('schedLabel').textContent = 'Schedule post';

    if (!r.ok) { Vane.toast('err', r.error); validate(); return; }

    var n = r.data.posts.length;
    Vane.toast('ok', 'Scheduled for ' + fmtWhen.format(new Date(r.data.scheduledAt * 1000)) + (n > 1 ? ' on ' + n + ' channels.' : '.'));
    textEl.value = ''; picker.clear(); saveDraft();
    initQuick();
    refreshApiQuietly();   // dashboard posts count toward the quota
    await Promise.all([loadPosts('upcoming')]);
    S.tab = 'upcoming'; setTab('upcoming');
    renderAll();
    $('posts').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  // ───────────────────────── posts list ─────────────────────────
  function setTab(tab) {
    S.tab = tab;
    var h = tab === 'history';
    $('postsSeg').style.transform = h ? 'translateX(100%)' : 'translateX(0)';
    $('tabUpcoming').setAttribute('aria-selected', String(!h));
    $('tabHistory').setAttribute('aria-selected', String(h));
    renderPosts();
  }
  $('tabUpcoming').addEventListener('click', function () { setTab('upcoming'); });
  $('tabHistory').addEventListener('click', function () { setTab('history'); });

  var DOT = { scheduled: '#7dd3fc', processing: '#fcd34d', sent: '#6ee7b7', failed: '#fca5a5', cancelled: 'rgba(255,255,255,.35)' };
  function groupStatus(g) {
    var has = function (s) { return g.some(function (p) { return p.status === s; }); };
    if (has('failed')) return 'failed';
    if (has('processing')) return 'processing';
    var first = g[0].status;
    return g.every(function (p) { return p.status === first; }) ? first : (has('scheduled') ? 'scheduled' : 'sent');
  }

  function renderPosts() {
    var box = $('posts');
    var list = S.tab === 'upcoming' ? S.upcoming : S.history;
    var groups = groupPosts(list);

    if (!groups.length) {
      box.innerHTML =
        '<div class="rounded-2xl border border-dashed border-white/10 px-5 py-12 text-center">' +
          '<div class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-white/[0.06] text-white/60">' + ICON.clock + '</div>' +
          '<p class="mt-4 text-sm font-medium">' + (S.tab === 'upcoming' ? 'Nothing scheduled' : 'No history yet') + '</p>' +
          '<p class="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-white/45">' + (S.tab === 'upcoming' ? 'Write a post above and pick a time. It will show up here.' : 'Sent, failed and cancelled posts will appear here.') + '</p>' +
        '</div>';
      return;
    }

    box.innerHTML = groups.map(function (g) {
      var p = g[0], d = new Date(p.scheduledAt * 1000), st = groupStatus(g);
      var cancellable = g.some(function (x) { return x.status === 'scheduled'; });
      var armed = !!S.armed['cancel:' + p.groupId];
      var errs = g.filter(function (x) { return x.status === 'failed' && x.error; });

      var pills = g.map(function (x) {
        return '<span class="inline-flex items-center gap-1.5 rounded-full bg-white/[0.06] px-2.5 py-1 text-xs text-white/70">' +
          '<span class="h-1.5 w-1.5 rounded-full" style="background:' + (DOT[x.status] || DOT.scheduled) + '"></span>' + netIcon(x.platform, 'h-3 w-3 text-white/50') + esc(x.channelName) + '</span>';
      }).join('');

      return '<article class="flex gap-4 rounded-2xl bg-white/[0.04] p-4 ring-1 ring-white/5 transition-colors hover:bg-white/[0.06]">' +
        '<div class="flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-xl bg-white/[0.06]">' +
          '<span class="text-[10px] uppercase tracking-widest text-white/40">' + esc(fmtMon.format(d)) + '</span>' +
          '<span class="pixel text-xl leading-none">' + pad(d.getDate()) + '</span>' +
        '</div>' +
        '<div class="min-w-0 flex-1">' +
          '<div class="flex flex-wrap items-center gap-x-2.5 gap-y-1">' +
            '<span class="badge badge-' + st + '">' + st + '</span>' +
            '<span class="text-xs text-white/45">' + esc(fmtWhen.format(d)) + ' · ' + esc(rel(p.scheduledAt)) + '</span>' +
          '</div>' +
          '<p class="mt-2 line-clamp-2 break-words text-sm leading-relaxed text-white/85">' + esc(p.content) + '</p>' +
          '<div class="mt-2.5 flex flex-wrap items-center gap-1.5">' + pills +
            (p.mediaUrl ? '<span class="inline-flex items-center gap-1.5 rounded-full bg-white/[0.06] px-2.5 py-1 text-xs text-white/55">' + (p.mediaKind === 'video' ? ICON.video + 'Video' : ICON.image + 'Image') + '</span>' : '') +
          '</div>' +
          errs.map(function (x) { return '<p class="mt-2 text-xs text-red-300/90">' + esc(x.channelName) + ': ' + esc(x.error) + '</p>'; }).join('') +
          g.filter(function (x) { return (x.status === 'scheduled' || x.status === 'processing') && x.attempts > 0 && x.error; }).map(function (x) {
            return '<p class="mt-2 text-xs text-amber-300/90">Retrying (attempt ' + x.attempts + '): ' + esc(x.error) + '</p>';
          }).join('') +
        '</div>' +
        (cancellable
          ? '<div class="shrink-0 self-start">' +
              (armed
                ? '<button type="button" data-act="cancel" data-group="' + esc(p.groupId) + '" class="btn btn-danger btn-sm">Cancel post?</button>'
                : '<button type="button" data-act="cancel" data-group="' + esc(p.groupId) + '" class="btn btn-ghost btn-sm">Cancel</button>') +
            '</div>'
          : S.tab === 'history'
            ? '<div class="shrink-0 self-start"><button type="button" data-act="reuse" data-group="' + esc(p.groupId) + '" class="btn btn-ghost btn-sm" title="Copy this post into the editor">Reuse</button></div>'
            : '') +
      '</article>';
    }).join('');
  }

  // Reuse: a finished post's text (and the channels it went to, where they still exist) goes back into the editor.
  function reusePost(gid) {
    var g = S.history.filter(function (p) { return p.groupId === gid; });
    if (!g.length) return;
    textEl.value = g[0].content;
    var ids = g.map(function (p) { return p.channelId; }).filter(function (id) {
      return S.channels.some(function (c) { return c.id === id; });
    });
    if (ids.length) { S.selected = new Set(ids); S.selectionTouched = true; }
    picker.clear();
    renderChips(); renderPreview(); validate(); saveDraft();
    $('composer').scrollIntoView({ behavior: 'smooth', block: 'start' });
    textEl.focus();
    Vane.toast('ok', g[0].mediaUrl ? 'Text copied to the editor. Add the image or video again.' : 'Copied to the editor. Pick a time and schedule it.');
  }

  $('posts').addEventListener('click', async function (e) {
    var reuse = e.target.closest('[data-act="reuse"]');
    if (reuse) return reusePost(reuse.getAttribute('data-group'));
    var btn = e.target.closest('[data-act="cancel"]');
    if (!btn) return;
    var gid = btn.getAttribute('data-group'), key = 'cancel:' + gid;
    if (!S.armed[key]) { arm(key); renderPosts(); return; }
    disarm(key);
    btn.disabled = true;

    var targets = S.upcoming.filter(function (p) { return p.groupId === gid && p.status === 'scheduled'; });
    var results = await Promise.all(targets.map(function (p) { return Vane.api('DELETE', '/api/posts/' + encodeURIComponent(p.id)); }));
    var failed = results.filter(function (r) { return !r.ok; });
    if (failed.length) Vane.toast('err', failed[0].error); else Vane.toast('ok', 'Post cancelled.');
    await Promise.all([loadPosts('upcoming'), loadPosts('history')]);
    renderAll();
  });

  // ───────────────────────── API access ─────────────────────────
  S.keys = null;        // null until loaded
  S.usage = null;
  S.apiFailed = false;  // e.g. the usage tables are not in the database yet: the section says so instead of breaking
  S.keyMax = 10;

  async function loadApi() {
    var rs = await Promise.all([Vane.api('GET', '/api/usage'), Vane.api('GET', '/api/keys?scope=post')]);
    if (!rs[0].ok || !rs[1].ok) { if (!S.usage) S.apiFailed = true; return; }   // keep what is on screen on a hiccup
    S.apiFailed = false;
    S.usage = rs[0].data.usage;
    S.keys = rs[1].data.keys;
    S.keyMax = rs[1].data.max || 10;
  }
  // Silent refresh (a post may have been sent through the API from another place, which changes the numbers).
  async function refreshApiQuietly() {
    if (S.refreshingApi) return;
    S.refreshingApi = true;
    await loadApi();
    S.refreshingApi = false;
    renderApi();
  }

  var METER = function (pct) { return pct >= 100 ? '#f87171' : pct >= 80 ? '#fbbf24' : '#34d399'; };
  var fmtDay = function (ts) { return new Date(ts * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); };

  function renderApi() { renderApiQuota(); renderApiKeys(); }

  function renderApiQuota() {
    var box = $('apiQuota');
    if (!S.usage) {
      if (S.apiFailed) box.innerHTML = '<p class="text-sm leading-relaxed text-white/55">API access could not be loaded right now. Try again in a moment.</p>';
      return;
    }
    var u = S.usage, html =
      '<div class="flex items-start justify-between gap-3">' +
        '<div><div class="text-xs font-medium uppercase tracking-widest text-white/40">Your plan</div>' +
        '<div class="mt-1 text-base font-semibold">' + esc(u.plan.label) + '</div></div>' +
        '<a href="' + esc(Vane.siteHome()) + '#pricing" class="shrink-0 text-xs text-white/45 underline underline-offset-4 transition-colors hover:text-white">Compare plans</a>' +
      '</div>';

    if (u.plan.lapsed) {
      html += '<div class="mt-4 rounded-xl border border-amber-300/20 bg-amber-400/10 p-3.5 text-sm leading-relaxed text-amber-200">Your paid plan has ended, so Free Trial limits apply until it is renewed.</div>';
    }

    if (!u.apiAccess) {
      html += '<div class="mt-5 rounded-xl border border-amber-300/20 bg-amber-400/10 p-3.5 text-sm leading-relaxed text-amber-200">' +
        'Your plan does not include API access yet. Add the API add-on to send live requests. Test keys work today.</div>';
    } else {
      var a = u.api, pct = a.limit ? Math.min(100, Math.round(a.used / a.limit * 100)) : 100;
      var lifetime = u.period.key === 'lifetime';
      var sub = (u.shared ? 'Dashboard and API posts share these ' + a.limit + ' posts. ' : '') +
        (u.period.resetsAt ? 'Resets on ' + fmtDay(u.period.resetsAt) + ' (UTC).' : 'A one-time allowance: it does not reset.');
      html +=
        '<div class="mt-5">' +
          '<div class="text-xs text-white/45">' + (lifetime ? 'Posts used' : 'API posts used this month') + '</div>' +
          '<div class="mt-1.5 flex items-end justify-between gap-3">' +
            '<div><span class="pixel text-3xl tracking-tight">' + a.used + '</span><span class="ml-1.5 text-sm text-white/45">/ ' + a.limit + '</span></div>' +
            '<span class="text-xs text-white/45">' + a.remaining + ' left</span>' +
          '</div>' +
          '<div class="meter mt-3" role="progressbar" aria-label="Posts used" aria-valuemin="0" aria-valuemax="' + a.limit + '" aria-valuenow="' + a.used + '"><i style="width:' + pct + '%;background:' + METER(pct) + '"></i></div>' +
          '<p class="mt-3 text-xs leading-relaxed text-white/45">' + esc(sub) + '</p>' +
        '</div>';

      var ov = u.overage, line;
      if (ov.enabled) {
        line = 'Extra posts are billed at $' + ov.postUsd + ' each' + (ov.posts ? ' (' + ov.posts + ' so far, $' + ov.costUsd.toFixed(2) + ')' : '') + '.';
      } else if (u.plan.id === 'free') {
        line = 'When the allowance is used up, posting pauses. You are never charged.';
      } else {
        line = 'Over the limit, requests are refused with a 402. Nothing is charged automatically.';
      }
      html += '<p class="mt-4 border-t border-white/10 pt-4 text-xs leading-relaxed text-white/45">' + esc(line) + '</p>';
    }
    box.innerHTML = html;
  }

  var KEY_ICON = '<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3L21 2M17 6l3 3M14 9l2 2"/></svg>';

  function renderApiKeys() {
    var box = $('apiKeys'), btn = $('keyNewBtn');
    if (!S.keys) { box.innerHTML = S.apiFailed ? '' : box.innerHTML; return; }
    var full = S.keys.length >= S.keyMax;
    btn.disabled = full;
    btn.title = full ? 'You can have up to ' + S.keyMax + ' active keys. Revoke one you no longer use.' : '';

    if (!S.keys.length) {
      box.innerHTML =
        '<div class="rounded-2xl border border-dashed border-white/10 px-5 py-8 text-center">' +
          '<div class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-white/[0.07] text-white/80">' + KEY_ICON + '</div>' +
          '<p class="mt-4 text-sm font-medium">No API keys yet</p>' +
          '<p class="mx-auto mt-1 max-w-[18rem] text-xs leading-relaxed text-white/45">Create a key to connect Make, Zapier or your own scripts.</p>' +
          '<button type="button" data-act="newkey" class="btn btn-white btn-sm mt-5">Create your first key</button>' +
        '</div>';
      return;
    }
    box.innerHTML = S.keys.map(function (k) {
      var armed = !!S.armed['key:' + k.id];
      var used = k.lastUsedAt ? 'Last used ' + rel(k.lastUsedAt) : 'Never used';
      return '<div class="flex items-center gap-3 rounded-2xl bg-white/[0.04] p-3 ring-1 ring-white/5">' +
        '<div class="net-tile bg-white/[0.07] text-white/80">' + KEY_ICON + '</div>' +
        '<div class="min-w-0 flex-1">' +
          '<div class="flex items-center gap-2"><span class="truncate text-sm font-medium">' + esc(k.name) + '</span>' +
            '<span class="badge ' + (k.mode === 'live' ? 'badge-sent' : 'badge-scheduled') + '">' + (k.mode === 'live' ? 'Live' : 'Test') + '</span></div>' +
          '<div class="mt-0.5 truncate font-mono text-xs text-white/50">' + esc(k.display) + '</div>' +
          '<div class="mt-0.5 text-xs text-white/35">Created ' + esc(fmtDay(k.createdAt)) + ' · ' + esc(used) + '</div>' +
        '</div>' +
        (armed
          ? '<button type="button" data-act="revoke" data-id="' + esc(k.id) + '" class="btn btn-danger btn-sm shrink-0">Revoke?</button>'
          : '<button type="button" data-act="revoke" data-id="' + esc(k.id) + '" class="icon-btn shrink-0" aria-label="Revoke key ' + esc(k.name) + '">' + ICON.trash + '</button>') +
      '</div>';
    }).join('');
  }

  $('apiKeys').addEventListener('click', async function (e) {
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var act = btn.getAttribute('data-act'), id = btn.getAttribute('data-id');
    if (act === 'newkey') return openKeyDialog();
    if (act === 'revoke') {
      var key = 'key:' + id;
      if (!S.armed[key]) { arm(key); renderApiKeys(); return; }
      disarm(key);
      btn.disabled = true;
      var d = await Vane.api('DELETE', '/api/keys/' + encodeURIComponent(id));
      if (!d.ok) { Vane.toast('err', d.error); renderApiKeys(); return; }
      Vane.toast('ok', 'Key revoked. Anything still using it stops working now.');
      await loadApi();
      renderApi();
    }
  });
  $('keyNewBtn').addEventListener('click', openKeyDialog);

  // ---- quick start: base URL, channel ids and a ready-made request (never contains a real key)
  var quickSnippet = '';
  function renderApiQuick() {
    var base = location.origin + '/api/v1';
    var first = S.channels[0];
    var when = new Date(Date.now() + 3600e3).toISOString().replace(/\.\d+Z$/, 'Z');
    quickSnippet =
      'curl -X POST ' + base + '/posts \\\n' +
      '  -H "Authorization: Bearer $VANE_API_KEY" \\\n' +
      '  -H "Content-Type: application/json" \\\n' +
      '  -H "Idempotency-Key: $(uuidgen)" \\\n' +
      '  -d \'{"content":"Hello from the API","channelIds":["' + (first ? first.id : '<channel-id>') + '"],"scheduledAt":"' + when + '"}\'';

    var chans = S.channels.length
      ? S.channels.map(function (c) {
          return '<div class="flex items-center gap-3 rounded-xl bg-white/[0.04] px-3 py-2 ring-1 ring-white/5">' +
            '<div class="min-w-0 flex-1"><div class="truncate text-sm">' + esc(c.name) + '</div>' +
            '<div class="truncate font-mono text-[11px] text-white/45">' + esc(c.id) + '</div></div>' +
            '<button type="button" data-copy="' + esc(c.id) + '" data-label="Channel ID" class="btn btn-ghost btn-sm shrink-0">Copy</button></div>';
        }).join('')
      : '<p class="text-xs text-white/45">Connect a channel to get its ID.</p>';

    $('apiQuickBody').innerHTML =
      '<div><span class="mb-2 block text-[0.7rem] font-medium uppercase tracking-widest text-white/40">Base URL</span>' +
        '<div class="flex items-center gap-2.5"><code class="field min-w-0 flex-1 truncate font-mono !text-[13px]">' + esc(base) + '</code>' +
        '<button type="button" data-copy="' + esc(base) + '" data-label="URL" class="btn btn-ghost btn-sm shrink-0">Copy</button></div></div>' +
      '<div><span class="mb-2 block text-[0.7rem] font-medium uppercase tracking-widest text-white/40">OpenAPI spec</span>' +
        '<div class="flex items-center gap-2.5"><code class="field min-w-0 flex-1 truncate font-mono !text-[13px]">' + esc(base + '/openapi.json') + '</code>' +
        '<button type="button" data-copy="' + esc(base + '/openapi.json') + '" data-label="Spec URL" class="btn btn-ghost btn-sm shrink-0">Copy</button></div>' +
        '<p class="mt-2 text-xs leading-relaxed text-white/45">Paste it into a Custom GPT (Actions → Import from URL), Postman or any tool that reads OpenAPI.</p></div>' +
      '<div><span class="mb-2 block text-[0.7rem] font-medium uppercase tracking-widest text-white/40">Channel IDs <span class="normal-case tracking-normal text-white/30">(use them as channelIds)</span></span><div class="space-y-2">' + chans + '</div></div>' +
      '<div><div class="flex items-center justify-between"><span class="block text-[0.7rem] font-medium uppercase tracking-widest text-white/40">Example request</span>' +
        '<button type="button" data-copy-snippet class="text-xs text-white/45 transition-colors hover:text-white">Copy</button></div>' +
        '<pre class="no-scrollbar mt-2 overflow-x-auto rounded-2xl bg-black/35 p-4 font-mono text-[12px] leading-relaxed text-white/80 ring-1 ring-white/10"><code id="apiSnippet"></code></pre></div>' +
      '<p class="text-xs leading-relaxed text-white/45">In Make, add an <b class="font-semibold text-white/70">HTTP → Make a request</b> module, paste the URL, add the header <code class="rounded bg-white/10 px-1.5 py-0.5">Authorization: Bearer your-key</code> and send the body as JSON. Add an <code class="rounded bg-white/10 px-1.5 py-0.5">Idempotency-Key</code> header with a value that stays the same on a retry (for example the execution id), so a retried run never posts twice. When a run is out of quota the API answers <code class="rounded bg-white/10 px-1.5 py-0.5">402</code>.</p>';
    $('apiSnippet').textContent = quickSnippet;   // textContent: nothing from the server is ever parsed as HTML
  }
  $('apiQuickBody').addEventListener('click', function (e) {
    var c = e.target.closest('[data-copy]');
    if (c) return copyWithToast(c.getAttribute('data-copy'), c.getAttribute('data-label') || 'Text');
    if (e.target.closest('[data-copy-snippet]')) copyWithToast(quickSnippet, 'Request');
  });

  // ---- create-a-key dialog
  var kdlg = $('keyDialog');
  var K = { mode: 'live', revealed: false, copied: false, busy: false };

  function setKeyMode(mode) {
    K.mode = mode;
    $('modeLive').setAttribute('aria-pressed', String(mode === 'live'));
    $('modeTest').setAttribute('aria-pressed', String(mode === 'test'));
  }
  $('modeLive').addEventListener('click', function () { if (!this.disabled) setKeyMode('live'); });
  $('modeTest').addEventListener('click', function () { setKeyMode('test'); });

  function openKeyDialog() {
    K.revealed = false; K.copied = false; K.busy = false;
    $('keyForm').reset(); hideErr($('keyErr'));
    $('keyForm').classList.remove('hidden'); $('keyDone').classList.add('hidden');
    $('keyTitle').textContent = 'Create an API key';
    $('keySub').textContent = 'Name it after the place you will use it.';
    $('keySecret').textContent = '';
    $('keyCopy').textContent = 'Copy';
    $('keySubmit').disabled = false; $('keySpin').classList.add('hidden'); $('keyLabel').textContent = 'Create key';

    var live = !S.usage || S.usage.apiAccess;
    $('modeLive').disabled = !live;
    var note = $('keyModeNote');
    note.classList.toggle('hidden', live);
    if (!live) note.textContent = 'Live keys need API access, which your plan does not include yet. A test key is perfect while you build.';
    setKeyMode(live ? 'live' : 'test');

    if (typeof kdlg.showModal === 'function') kdlg.showModal(); else kdlg.setAttribute('open', '');
    setTimeout(function () { $('keyName').focus(); }, 60);
  }
  function closeKeyDialog() {
    if (typeof kdlg.close === 'function') kdlg.close(); else kdlg.removeAttribute('open');
  }

  $('keyForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    if (K.busy) return;
    hideErr($('keyErr'));
    var name = $('keyName').value.trim();
    if (!name) return showErr($('keyErr'), $('keyForm'), 'Give the key a name, for example Make.com.');

    K.busy = true; $('keySubmit').disabled = true; $('keySpin').classList.remove('hidden'); $('keyLabel').textContent = 'Creating…';
    var r = await Vane.api('POST', '/api/keys', { name: name, mode: K.mode });
    K.busy = false; $('keySubmit').disabled = false; $('keySpin').classList.add('hidden'); $('keyLabel').textContent = 'Create key';
    if (!r.ok) return showErr($('keyErr'), $('keyForm'), r.error);

    // The secret exists only in this response: put it on screen once, and wipe it when the dialog closes.
    K.revealed = true;
    $('keySecret').textContent = r.data.secret;
    $('keyTitle').textContent = 'Your new key';
    $('keySub').textContent = r.data.key.name + ' · ' + (r.data.key.mode === 'live' ? 'Live' : 'Test');
    $('keyForm').classList.add('hidden'); $('keyDone').classList.remove('hidden');
    refreshApiQuietly();   // the list behind the dialog
  });

  $('keyCopy').addEventListener('click', async function () {
    var ok = await copyText($('keySecret').textContent);
    if (ok) {
      K.copied = true; this.textContent = 'Copied';
      var btn = this; setTimeout(function () { btn.textContent = 'Copy'; }, 2000);
    } else {
      Vane.toast('info', 'Select the key and press Ctrl+C to copy it.');
    }
  });

  $('keyClose').addEventListener('click', closeKeyDialog);
  $('keyCancel').addEventListener('click', closeKeyDialog);
  $('keyFinish').addEventListener('click', closeKeyDialog);
  // While the secret is on screen a stray click outside or Esc must not throw it away.
  kdlg.addEventListener('click', function (e) { if (e.target === kdlg && !K.revealed) closeKeyDialog(); });
  kdlg.addEventListener('cancel', function (e) {
    if (K.revealed && !K.copied) {
      e.preventDefault();
      var w = $('keyWarn'); w.classList.remove('shake'); void w.offsetWidth; w.classList.add('shake');
    }
  });
  kdlg.addEventListener('close', function () { $('keySecret').textContent = ''; K.revealed = false; });

  // ───────────────────────── sign out ─────────────────────────
  $('logoutBtn').addEventListener('click', async function () {
    this.disabled = true;
    try { localStorage.removeItem(draftKey()); } catch (e) { /* storage blocked */ }
    await Vane.api('POST', '/api/auth/logout', {}, { noRedirect: true });
    Vane.go('/login');
  });

  boot();
})();
