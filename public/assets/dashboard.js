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
    quick: false,       // Quick Connect (shared bot) available on this server
    systemBot: '@VanePublishBot',
    connTab: 'quick',
    net: 'telegram'     // network shown in the preview
  };

  var TG_LIMIT = 4096, CAPTION_LIMIT = 1024;

  var ICON = {
    telegram: '<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 3.5L2.8 10.7l5.9 2.2 2.3 6.6 3.1-4.2 4.6 3.4z"/><path d="M8.7 12.9l12-8.6"/></svg>',
    telegramSm: '<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 3.5L2.8 10.7l5.9 2.2 2.3 6.6 3.1-4.2 4.6 3.4z"/><path d="M8.7 12.9l12-8.6"/></svg>',
    trash: '<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6M10 11v6M14 11v6"/></svg>',
    clock: '<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    video: '<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="14" height="14" rx="3"/><path d="M16 10l6-3v10l-6-3z"/></svg>',
    image: '<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>'
  };

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
    await Promise.all([loadChannels(), loadPosts('upcoming'), loadPosts('history')]);
    setTab('upcoming');
    renderAll();

    setInterval(function () { renderStats(); renderPosts(); }, 30000);
    setInterval(function () { if (document.visibilityState === 'visible') refreshPostsQuietly(); }, 60000);
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
    S[view] = r.data.posts;
  }
  async function refreshPostsQuietly() {
    var before = JSON.stringify(S.upcoming.map(function (p) { return p.id + p.status; }));
    await Promise.all([loadPosts('upcoming'), loadPosts('history')]);
    if (before !== JSON.stringify(S.upcoming.map(function (p) { return p.id + p.status; }))) renderAll();
  }

  // ───────────────────────── render: everything ─────────────────────────
  function renderAll() { renderStats(); renderChannels(); renderChips(); renderPreview(); renderPosts(); validate(); }

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
  }

  // ───────────────────────── channels ─────────────────────────
  function renderChannels() {
    var box = $('channels');
    if (!S.channels.length) {
      box.innerHTML =
        '<div class="rounded-2xl border border-dashed border-white/10 px-5 py-8 text-center">' +
          '<div class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-sky-500/15 text-sky-300">' + ICON.telegram + '</div>' +
          '<p class="mt-4 text-sm font-medium">No channels yet</p>' +
          '<p class="mx-auto mt-1 max-w-[16rem] text-xs leading-relaxed text-white/45">Connect a Telegram channel to start scheduling posts.</p>' +
          '<button type="button" data-act="connect" class="btn btn-white btn-sm mt-5">Connect Telegram</button>' +
        '</div>';
      return;
    }
    box.innerHTML = S.channels.map(function (c) {
      var armed = !!S.armed['del:' + c.id];
      return '<div class="flex items-center gap-3 rounded-2xl bg-white/[0.04] p-3 ring-1 ring-white/5">' +
        '<div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sky-500/15 text-sky-300">' + ICON.telegram + '</div>' +
        '<div class="min-w-0 flex-1">' +
          '<div class="truncate text-sm font-medium">' + esc(c.name) + '</div>' +
          '<div class="mt-0.5 text-xs text-white/40">Telegram · added ' + esc(new Date(c.createdAt * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })) + '</div>' +
        '</div>' +
        '<button type="button" data-act="test" data-id="' + esc(c.id) + '" class="btn btn-ghost btn-sm shrink-0">Send test</button>' +
        (armed
          ? '<button type="button" data-act="del" data-id="' + esc(c.id) + '" class="btn btn-danger btn-sm shrink-0">Remove?</button>'
          : '<button type="button" data-act="del" data-id="' + esc(c.id) + '" class="icon-btn shrink-0" aria-label="Remove ' + esc(c.name) + '">' + ICON.trash + '</button>') +
      '</div>';
    }).join('');
  }

  function arm(key, ms) {
    clearTimeout(S.armed[key]);
    S.armed[key] = setTimeout(function () { delete S.armed[key]; renderChannels(); renderPosts(); }, ms || 3200);
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
    $('tabQuick').style.color = quick ? '#010101' : 'rgba(255,255,255,.65)';
    $('tabCustom').style.color = quick ? 'rgba(255,255,255,.65)' : '#010101';
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

  // ---- open / close
  function openConnect(tab) {
    $('connectForm').reset(); hideErr($('cErr'));
    $('cToken').type = 'password'; $('cTokenToggle').textContent = 'Show';
    qReset(); $('qChat').value = '';

    $('qBot').textContent = S.systemBot;
    $('qOff').classList.toggle('hidden', S.quick);
    $('qOn').classList.toggle('hidden', !S.quick);
    $('tabQuickBadge').classList.toggle('hidden', !S.quick);
    setConnTab(tab || (S.quick ? 'quick' : 'custom'));

    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    setTimeout(function () { ($('panelQuick').classList.contains('hidden') ? $('cName') : $('qChat')).focus(); }, 60);
  }
  function closeConnect() {
    qStopTimers();
    $('cToken').value = ''; // don't leave the secret sitting in the DOM
    if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
  }
  $('connectBtn').addEventListener('click', function () { openConnect(); });
  $('connectClose').addEventListener('click', closeConnect);
  $('cCancel').addEventListener('click', closeConnect);
  dlg.addEventListener('click', function (e) { if (e.target === dlg) closeConnect(); });
  dlg.addEventListener('close', function () { $('cToken').value = ''; qStopTimers(); });

  // ───────────────────────── composer ─────────────────────────
  var textEl = $('text'), whenEl = $('when');

  function renderChips() {
    var box = $('chipsBox');
    if (!S.channels.length) {
      box.innerHTML = '<button type="button" data-act="connect" class="chip">' + ICON.telegramSm + ' Connect a channel first</button>';
      return;
    }
    box.innerHTML = S.channels.map(function (c) {
      return '<button type="button" class="chip" data-id="' + esc(c.id) + '" aria-pressed="' + S.selected.has(c.id) + '">' + ICON.telegramSm + '<span>' + esc(c.name) + '</span></button>';
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

  // validation (live: drives the hint and the button)
  function validate() {
    var text = textEl.value.trim(), media = currentMedia();
    var limit = media ? CAPTION_LIMIT : TG_LIMIT;
    var len = textEl.value.length;
    var counter = $('count');
    counter.textContent = len + ' / ' + limit;
    counter.className = 'rounded-full px-2.5 py-1 text-xs font-medium ' + (len > limit ? 'bg-red-500/15 text-red-300' : 'bg-white/[0.06] text-white/50');

    var msg = '';
    if (picker.isBusy()) msg = 'Waiting for the upload to finish…';
    else if (!S.channels.length) msg = 'Connect a channel to start.';
    else if (!S.selected.size) msg = 'Pick at least one channel.';
    else if (!text && !media) msg = 'Write something or add an image or video.';
    else if (len > limit) msg = media ? 'With an image or video the text can be at most ' + CAPTION_LIMIT + ' characters.' : 'Text is too long for Telegram.';
    else if (!whenEl.value || isNaN(new Date(whenEl.value).getTime())) msg = 'Pick a date and time.';
    else if (new Date(whenEl.value).getTime() <= Date.now() + 30000) msg = 'Pick a time at least a minute from now.';

    $('hint').textContent = msg;
    $('schedBtn').disabled = !!msg || S.submitting;
    return msg;
  }

  // ───────────────────────── preview (per network) ─────────────────────────
  // Limits: Telegram 4096 (1024 under an image or video), LinkedIn 3000, Threads 500, Bluesky 300 (graphemes).
  var NET = {
    telegram: { name: 'Telegram', limit: 4096, bg: '#0e1621', hint: '' },
    linkedin: { name: 'LinkedIn', limit: 3000, bg: '#000000', hint: 'LinkedIn folds long posts behind “see more” after about three lines.' },
    threads:  { name: 'Threads',  limit: 500,  bg: '#101010', hint: '' },
    bluesky:  { name: 'Bluesky',  limit: 300,  bg: '#161e27', hint: 'Bluesky counts graphemes, so an emoji is one character.' }
  };
  var NET_ORDER = ['telegram', 'linkedin', 'threads', 'bluesky'];
  var EMPTY = '<span class="text-white/35">Your post will appear here…</span>';
  var segmenter = window.Intl && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

  function netLen(net, text) {
    return net === 'bluesky' && segmenter ? Array.from(segmenter.segment(text)).length : text.length;
  }
  function netLimit(net, hasMedia) { return net === 'telegram' && hasMedia ? CAPTION_LIMIT : NET[net].limit; }

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
  var PV_VIEW = { telegram: viewTelegram, linkedin: viewLinkedin, threads: viewThreads, bluesky: viewBluesky };

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
    var first = S.channels.filter(function (c) { return S.selected.has(c.id); })[0];
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
    textEl.value = ''; picker.clear();
    initQuick();
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
    $('tabUpcoming').style.color = h ? 'rgba(255,255,255,.65)' : '#010101';
    $('tabHistory').style.color = h ? '#010101' : 'rgba(255,255,255,.65)';
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
          '<span class="h-1.5 w-1.5 rounded-full" style="background:' + (DOT[x.status] || DOT.scheduled) + '"></span>' + esc(x.channelName) + '</span>';
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
          : '') +
      '</article>';
    }).join('');
  }

  $('posts').addEventListener('click', async function (e) {
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

  // ───────────────────────── sign out ─────────────────────────
  $('logoutBtn').addEventListener('click', async function () {
    this.disabled = true;
    await Vane.api('POST', '/api/auth/logout', {}, { noRedirect: true });
    Vane.go('/login');
  });

  boot();
})();
