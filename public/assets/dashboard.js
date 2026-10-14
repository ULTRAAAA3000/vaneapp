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
    uploading: false
  };

  var TG_LIMIT = 4096, CAPTION_LIMIT = 1024;

  var ICON = {
    telegram: '<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 3.5L2.8 10.7l5.9 2.2 2.3 6.6 3.1-4.2 4.6 3.4z"/><path d="M8.7 12.9l12-8.6"/></svg>',
    telegramSm: '<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 3.5L2.8 10.7l5.9 2.2 2.3 6.6 3.1-4.2 4.6 3.4z"/><path d="M8.7 12.9l12-8.6"/></svg>',
    trash: '<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6M10 11v6M14 11v6"/></svg>',
    clock: '<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
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
    S.uploads = !!(me.data.features && me.data.features.uploads);

    var display = S.user.name || S.user.email.split('@')[0];
    $('userEmail').textContent = S.user.email;
    $('avatar').textContent = display.charAt(0).toUpperCase();
    var h = new Date().getHours();
    $('greeting').textContent = (h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening') + ', ' + display;
    $('today').textContent = fmtLong.format(new Date());
    $('tz').textContent = 'Times are in your timezone: ' + (Intl.DateTimeFormat().resolvedOptions().timeZone || 'local');
    if (S.uploads) {
      $('uploadBtn').classList.remove('hidden');
      $('mediaHint').textContent = 'Paste a public https link, or upload a JPEG / PNG / WebP (max 5 MB). Text under an image is limited to 1024 characters.';
    }
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
  function openConnect() {
    $('connectForm').reset();
    $('cErr').classList.add('hidden');
    $('cToken').type = 'password'; $('cTokenToggle').textContent = 'Show';
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    setTimeout(function () { $('cName').focus(); }, 60);
  }
  function closeConnect() {
    $('cToken').value = ''; // don't leave the secret sitting in the DOM
    if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
  }
  $('connectBtn').addEventListener('click', openConnect);
  $('connectClose').addEventListener('click', closeConnect);
  $('cCancel').addEventListener('click', closeConnect);
  dlg.addEventListener('click', function (e) { if (e.target === dlg) closeConnect(); });
  dlg.addEventListener('close', function () { $('cToken').value = ''; });
  $('cTokenToggle').addEventListener('click', function () {
    var show = $('cToken').type === 'password';
    $('cToken').type = show ? 'text' : 'password';
    this.textContent = show ? 'Hide' : 'Show';
  });

  $('connectForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('cErr'), btn = $('cSubmit');
    var showErr = function (m) {
      err.textContent = m; err.classList.remove('hidden');
      var f = $('connectForm'); f.classList.remove('shake'); void f.offsetWidth; f.classList.add('shake');
    };
    err.classList.add('hidden');

    var name = $('cName').value.trim() || 'My Telegram channel';
    var token = $('cToken').value.trim();
    var chat = $('cChat').value.trim();
    if (!token) return showErr('Paste the bot token from @BotFather.');
    if (!chat) return showErr('Enter the channel @username or numeric id.');

    btn.disabled = true; $('cSpin').classList.remove('hidden'); $('cLabel').textContent = 'Checking with Telegram…';
    var r = await Vane.api('POST', '/api/channels/add', { platform: 'telegram', name: name, credentials: { botToken: token, chatId: chat } });
    btn.disabled = false; $('cSpin').classList.add('hidden'); $('cLabel').textContent = 'Verify & connect';

    if (!r.ok) return showErr(r.error);
    var title = r.data.telegram && r.data.telegram.chatTitle;
    closeConnect();
    Vane.toast('ok', 'Connected' + (title ? ' to ' + title : '') + '. Send a test message to try it.');
    S.selected.add(r.data.channel.id);
    await loadChannels();
    renderAll();
  });

  // ───────────────────────── composer ─────────────────────────
  var textEl = $('text'), mediaEl = $('mediaUrl'), whenEl = $('when');

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

  // media
  function currentMedia() { var v = mediaEl.value.trim(); return v; }
  function renderMedia() {
    var v = currentMedia(), valid = v && Vane.isHttps(v);
    mediaEl.setAttribute('aria-invalid', v && !valid ? 'true' : 'false');
    var pv = $('mediaPreview');
    if (valid) {
      pv.classList.remove('hidden'); pv.classList.add('flex');
      $('mediaImg').src = v;
      $('mediaName').textContent = v.replace(/^https:\/\//, '');
    } else {
      pv.classList.add('hidden'); pv.classList.remove('flex'); $('mediaImg').removeAttribute('src');
    }
  }
  mediaEl.addEventListener('input', function () { renderMedia(); renderPreview(); validate(); });
  $('mediaClear').addEventListener('click', function () { mediaEl.value = ''; renderMedia(); renderPreview(); validate(); });

  async function handleFile(file) {
    if (!file || S.uploading) return;
    if (['image/jpeg', 'image/png', 'image/webp'].indexOf(file.type) < 0) return Vane.toast('err', 'Only JPEG, PNG and WebP images are supported.');
    if (file.size > 5 * 1024 * 1024) return Vane.toast('err', 'Image is too large (max 5 MB).');
    S.uploading = true;
    var btn = $('uploadBtn'), old = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Uploading';
    var r = await Vane.upload(file);
    S.uploading = false; btn.disabled = false; btn.innerHTML = old;
    if (!r.ok) return Vane.toast('err', r.error);
    mediaEl.value = r.url; renderMedia(); renderPreview(); validate();
    Vane.toast('ok', 'Image uploaded.');
  }
  $('uploadBtn').addEventListener('click', function () { $('fileInput').click(); });
  $('fileInput').addEventListener('change', function () { handleFile(this.files[0]); this.value = ''; });
  var mediaBox = $('mediaBox');
  ['dragenter', 'dragover'].forEach(function (ev) {
    mediaBox.addEventListener(ev, function (e) { if (!S.uploads) return; e.preventDefault(); mediaBox.classList.add('bg-white/[0.06]', 'ring-2', 'ring-white/20'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    mediaBox.addEventListener(ev, function (e) { if (!S.uploads) return; e.preventDefault(); mediaBox.classList.remove('bg-white/[0.06]', 'ring-2', 'ring-white/20'); if (ev === 'drop' && e.dataTransfer) handleFile(e.dataTransfer.files[0]); });
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
    if (!S.channels.length) msg = 'Connect a channel to start.';
    else if (!S.selected.size) msg = 'Pick at least one channel.';
    else if (!text && !media) msg = 'Write something or add an image.';
    else if (len > limit) msg = media ? 'With an image the text can be at most ' + CAPTION_LIMIT + ' characters.' : 'Text is too long for Telegram.';
    else if (media && !Vane.isHttps(media)) msg = 'The image link must be a public https URL.';
    else if (!whenEl.value || isNaN(new Date(whenEl.value).getTime())) msg = 'Pick a date and time.';
    else if (new Date(whenEl.value).getTime() <= Date.now() + 30000) msg = 'Pick a time at least a minute from now.';

    $('hint').textContent = msg;
    $('schedBtn').disabled = !!msg || S.submitting;
    return msg;
  }

  // preview (Telegram bubble)
  function renderPreview() {
    var text = textEl.value.trim(), media = currentMedia(), validMedia = media && Vane.isHttps(media);
    var first = S.channels.filter(function (c) { return S.selected.has(c.id); })[0];
    var title = first ? first.name : 'Your channel';
    var when = whenEl.value && !isNaN(new Date(whenEl.value).getTime()) ? fmtHM.format(new Date(whenEl.value)) : '';
    $('preview').innerHTML =
      '<div class="flex items-center gap-2.5 border-b border-white/5 bg-[#17212b] px-3.5 py-2.5">' +
        '<div class="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-sky-400 text-sm font-bold">' + esc(title.charAt(0).toUpperCase()) + '</div>' +
        '<div class="min-w-0 leading-tight"><div class="truncate text-[13px] font-semibold">' + esc(title) + '</div><div class="text-[11px] text-white/45">channel</div></div>' +
      '</div>' +
      '<div class="p-3.5"><div class="max-w-[94%] overflow-hidden rounded-2xl rounded-tl-md bg-[#182533]">' +
        (validMedia ? '<img src="' + esc(media) + '" alt="" referrerpolicy="no-referrer" class="max-h-56 w-full bg-black/20 object-cover" data-hide-on-error />' : '') +
        '<div class="px-3 py-2 text-[13px] leading-snug">' +
          (text ? Vane.rich(text) : '<span class="text-white/35">Your post will appear here…</span>') +
          '<div class="mt-1.5 flex justify-end text-[10.5px] text-white/40">' + esc(when) + '</div>' +
        '</div>' +
      '</div></div>';
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
    textEl.value = ''; mediaEl.value = ''; renderMedia();
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
            (p.mediaUrl ? '<span class="inline-flex items-center gap-1.5 rounded-full bg-white/[0.06] px-2.5 py-1 text-xs text-white/55">' + ICON.image + 'Image</span>' : '') +
          '</div>' +
          errs.map(function (x) { return '<p class="mt-2 text-xs text-red-300/90">' + esc(x.channelName) + ': ' + esc(x.error) + '</p>'; }).join('') +
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
