/* Vane Studio — the video dashboard (studio.vaneapp.dev) */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = Vane.esc;

  // ───────────────────────── state ─────────────────────────
  var S = {
    user: null,
    active: false,        // is Vane Studio switched on for this account?
    lapsed: false,        // it was on once and has stopped
    limits: { maxVideos: 90, maxFileBytes: 2 * 1024 * 1024 * 1024, partSize: 8 * 1024 * 1024 },
    usage: { videos: 0, storageBytes: 0 },
    uploadsOn: true,      // the server has video storage bound
    videos: [],
    channels: [],         // connected video channels
    publications: [],     // the publishing history
    pubTimer: null,       // polls while anything is queued or publishing
    platforms: [],        // the networks the server knows, with whether each is open yet
    armed: {},            // two-step delete: ids waiting for the second click
    file: null,           // the file chosen in the uploader
    preview: null,        // Promise of its preview frame and length (made in the browser), see makePreview()
    cover: null,          // the cover picture chosen in the uploader (optional)
    coverUrl: '',
    up: null              // the upload in progress (see "uploading")
  };

  var Keys = null;        // the API access section (assigned below)
  var PARALLEL = 3;       // chunks sent at once
  var RETRIES = 3;        // a failed chunk is tried again this many times
  var RESUME_KEY = 'vane.studio.uploads';

  // ───────────────────────── small helpers ─────────────────────────
  function fmtBytes(n) {
    if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  function fmtDate(sec) { return new Date(sec * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
  function fmtDuration(ms) {
    var s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') + m : m) + ':' + (ss < 10 ? '0' : '') + ss;
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function parseTags(text) { return text.split(',').map(function (t) { return t.trim(); }).filter(Boolean); }

  function loadResume() { try { return JSON.parse(localStorage.getItem(RESUME_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function saveResume(map) { try { localStorage.setItem(RESUME_KEY, JSON.stringify(map)); } catch (e) { /* storage blocked: uploads still work, they just cannot be resumed */ } }
  function fingerprint(f) { return f.name + ':' + f.size + ':' + f.lastModified; }
  function forget(fp) { var m = loadResume(); delete m[fp]; saveResume(m); }

  // ───────────────────────── overview ─────────────────────────
  function renderStats() {
    $('statVideos').textContent = S.usage.videos + ' / ' + S.limits.maxVideos;
    $('statStorage').textContent = fmtBytes(S.usage.storageBytes);
    $('statStatus').textContent = S.active ? 'Active' : 'Off';
    $('statStatusSub').textContent = S.active ? 'Vane Studio is on' : 'Vane Studio is not active';
    $('inactive').classList.toggle('hidden', S.active);
    $('uploader').classList.toggle('hidden', !S.active);
    if (S.active && !S.uploadsOn) { $('uploader').classList.add('hidden'); $('inactive').classList.remove('hidden'); $('inactiveText').textContent = 'Video storage is not enabled on this server yet.'; }
    if (Keys) Keys.render();   // the API section shows the same numbers
  }

  async function refreshOverview() {
    var r = await Vane.api('GET', '/api/video/me');
    if (!r.ok) return false;
    S.active = r.data.entitlement.active;
    S.lapsed = r.data.entitlement.lapsed;
    S.endsAt = r.data.entitlement.currentPeriodEnd;
    S.limits = r.data.limits;
    S.usage = { videos: r.data.usage.videos.used, storageBytes: r.data.usage.storageBytes };
    S.uploadsOn = r.data.features.uploads;
    renderStats();
    return true;
  }

  // ───────────────────────── library ─────────────────────────
  var BADGE = {
    uploading: '<span class="rounded-full bg-amber-400/15 px-2 py-0.5 text-[11px] text-amber-200">Unfinished</span>',
    failed: '<span class="rounded-full bg-red-400/15 px-2 py-0.5 text-[11px] text-red-200">Failed</span>',
    ready: ''
  };
  var FILM_ICON = '<svg class="h-8 w-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="3"/><path d="M10 9l5 3-5 3z"/></svg>';
  var PLAY_ICON = '<svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';

  /** The picture on top of a card: the preview frame (or a placeholder), the length, and a play button for finished videos. */
  function cover(v) {
    var picture = v.thumbnailUrl
      ? '<img src="' + esc(v.thumbnailUrl) + '" alt="" loading="lazy" class="h-full w-full object-cover" />'
      : '<div class="flex h-full w-full items-center justify-center bg-gradient-to-br from-violet-500/15 via-white/[0.03] to-fuchsia-500/15 text-white/35">' + FILM_ICON + '</div>';
    var length = v.durationMs ? '<span class="absolute bottom-2 right-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-medium tabular-nums">' + fmtDuration(v.durationMs) + '</span>' : '';
    var status = v.status !== 'ready' ? '<span class="absolute left-2 top-2">' + BADGE[v.status] + '</span>' : '';
    var play = v.status === 'ready'
      ? '<button type="button" data-act="play" data-id="' + v.id + '" class="group absolute inset-0 flex items-center justify-center" aria-label="Play ' + esc(v.title) + '">' +
          '<span class="flex h-12 w-12 items-center justify-center rounded-full bg-black/55 text-white opacity-80 ring-1 ring-white/20 backdrop-blur transition group-hover:scale-105 group-hover:opacity-100">' + PLAY_ICON + '</span></button>'
      : '';
    return '<div class="relative aspect-video overflow-hidden bg-black/40">' + picture + play + length + status + '</div>';
  }

  function card(v) {
    var tags = v.tags.map(function (t) { return '<span class="rounded-full bg-white/8 px-2 py-0.5 text-[11px] text-white/60">#' + esc(t) + '</span>'; }).join(' ');
    var note = '';
    var actions = '';
    if (v.status === 'ready') {
      actions = '<button class="btn btn-ghost btn-sm" data-act="share" data-id="' + v.id + '">' + (v.publicUrl ? 'Link' : 'Share') + '</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="publish" data-id="' + v.id + '">Publish</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="announce" data-id="' + v.id + '">Announce</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="edit" data-id="' + v.id + '">Edit</button>' +
        '<button class="btn btn-danger btn-sm" data-act="delete" data-id="' + v.id + '">Delete</button>';
    } else if (v.status === 'uploading') {
      note = '<p class="mt-2 text-xs text-white/50">Choose the same file again to continue this upload, or cancel it.</p>';
      actions = '<button class="btn btn-danger btn-sm" data-act="delete" data-id="' + v.id + '">Cancel upload</button>';
    } else {
      note = '<p class="mt-2 text-xs text-red-200/80">' + esc(v.error || 'This upload was rejected.') + '</p>';
      actions = '<button class="btn btn-danger btn-sm" data-act="delete" data-id="' + v.id + '">Delete</button>';
    }
    var pub = v.publicUrl ? '<span class="badge badge-sent shrink-0">Public</span>' : '';
    var size = v.width && v.height ? fmtBytes(v.sizeBytes) + ' · ' + v.width + '×' + v.height : fmtBytes(v.sizeBytes);
    return '<article class="glass-d flex flex-col overflow-hidden rounded-2xl">' + cover(v) +
      '<div class="flex flex-1 flex-col p-4">' +
        '<div class="flex items-start justify-between gap-2"><h3 class="min-w-0 break-words text-sm font-semibold">' + esc(v.title) + '</h3>' + pub + '</div>' +
        '<p class="mt-1 text-xs text-white/45">' + size + ' · ' + fmtDate(v.createdAt) + '</p>' +
        (tags ? '<div class="mt-2 flex flex-wrap gap-1">' + tags + '</div>' : '') + note +
        '<div class="mt-auto flex flex-wrap gap-2 pt-4">' + actions + '</div></div></article>';
  }

  function renderLibrary() {
    $('library').innerHTML = S.videos.map(card).join('');
    $('libEmpty').classList.toggle('hidden', S.videos.length > 0);
  }

  async function loadLibrary() {
    var r = await Vane.api('GET', '/api/video/videos');
    if (r.ok) { S.videos = r.data.videos; renderLibrary(); if (Keys) Keys.render(); }
  }

  function find(id) { return S.videos.filter(function (v) { return v.id === id; })[0]; }

  $('library').addEventListener('click', async function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var v = find(btn.getAttribute('data-id'));
    if (!v) return;
    var act = btn.getAttribute('data-act');
    if (act === 'play') openPlayer(v);
    else if (act === 'edit') openEditor(v);
    else if (act === 'share') openShare(v);
    else if (act === 'publish') openPublish(v);
    else if (act === 'announce') openAnnounce(v);
    else if (act === 'delete') await removeVideo(v, btn);
  });

  async function removeVideo(v, btn) {
    var unfinished = v.status === 'uploading';
    if (!window.confirm(unfinished ? 'Cancel this unfinished upload?' : 'Delete "' + v.title + '"? The file is removed for good.')) return;
    btn.disabled = true;
    var r = await Vane.api('DELETE', '/api/video/videos/' + v.id);
    if (!r.ok) { btn.disabled = false; Vane.toast('err', r.error); return; }
    // an unfinished upload may be remembered for resuming: forget it
    var map = loadResume();
    Object.keys(map).forEach(function (fp) { if (map[fp] === v.id) delete map[fp]; });
    saveResume(map);
    Vane.toast('ok', unfinished ? 'Upload cancelled' : 'Video deleted');
    await Promise.all([loadLibrary(), refreshOverview()]);
  }

  // ───────────────────────── player and editor ─────────────────────────
  var modal = $('modal');
  function openModal(html) { $('modalBody').innerHTML = html; modal.classList.remove('hidden'); modal.classList.add('flex'); }
  function closeModal() { modal.classList.add('hidden'); modal.classList.remove('flex'); $('modalBody').innerHTML = ''; } // emptying it also stops a playing video
  modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

  function openPlayer(v) {
    openModal('<h3 class="mb-3 break-words text-base font-semibold">' + esc(v.title) + '</h3>' +
      '<video class="w-full rounded-2xl bg-black" controls autoplay playsinline preload="metadata" src="' + esc(v.fileUrl) + '"></video>' +
      (v.description ? '<p class="mt-3 whitespace-pre-line break-words text-sm text-white/60">' + esc(v.description) + '</p>' : '') +
      '<div class="mt-4 flex justify-end"><button class="btn btn-ghost btn-sm" id="mClose">Close</button></div>');
    $('mClose').addEventListener('click', closeModal);
  }

  function openEditor(v) {
    openModal('<h3 class="mb-4 text-base font-semibold">Edit video</h3>' +
      '<div class="space-y-3">' +
      '<div><label for="eTitle" class="mb-1 block text-xs text-white/55">Title</label><input id="eTitle" class="field" maxlength="100" value="' + esc(v.title) + '" /></div>' +
      '<div><label for="eDesc" class="mb-1 block text-xs text-white/55">Description</label><textarea id="eDesc" class="field" rows="4" maxlength="5000">' + esc(v.description) + '</textarea></div>' +
      '<div><label for="eTags" class="mb-1 block text-xs text-white/55">Tags, separated by commas</label><input id="eTags" class="field" value="' + esc(v.tags.join(', ')) + '" /></div>' +
      '<div><span class="mb-1 block text-xs text-white/55">Cover</span><div class="flex flex-wrap items-center gap-3">' +
        (v.thumbnailUrl ? '<img id="eCoverImg" src="' + esc(v.thumbnailUrl) + '?t=' + Date.now() + '" alt="" class="h-14 w-24 rounded-lg object-cover ring-1 ring-white/10" />' : '') +
        '<label for="eCover" class="btn btn-ghost btn-sm cursor-pointer">' + (v.hasCover ? 'Change cover' : 'Upload a cover') + '</label>' +
        (v.hasCover ? '<button type="button" class="text-xs text-white/45 underline underline-offset-4 hover:text-white" id="eCoverRemove">Use a frame from the video</button>' : '') +
        '<input id="eCover" type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" class="sr-only" /></div>' +
        '<p class="mt-1 text-xs text-white/40">JPEG, PNG or WebP up to 2 MB. It is the picture people see before they press play.</p></div>' +
      '</div><div class="mt-5 flex justify-end gap-2"><button class="btn btn-ghost btn-sm" id="mCancel">Cancel</button><button class="btn btn-white btn-sm" id="mSave">Save</button></div>');
    $('mCancel').addEventListener('click', closeModal);
    $('eCover').addEventListener('change', async function () {
      var f = this.files[0];
      if (!f) return;
      var problem = coverProblem(f);
      if (problem) { Vane.toast('err', problem); this.value = ''; return; }
      var r = await uploadCover(v.id, f);
      if (!r.ok) { Vane.toast('err', r.error); this.value = ''; return; }
      closeModal();
      Vane.toast('ok', 'Cover saved');
      await loadLibrary();
    });
    if ($('eCoverRemove')) $('eCoverRemove').addEventListener('click', async function () {
      this.disabled = true;
      var r = await Vane.api('DELETE', '/api/video/videos/' + v.id + '/cover');
      if (!r.ok) { this.disabled = false; Vane.toast('err', r.error); return; }
      closeModal();
      Vane.toast('ok', 'The cover was removed');
      await loadLibrary();
    });
    $('mSave').addEventListener('click', async function () {
      this.disabled = true;
      var r = await Vane.api('PATCH', '/api/video/videos/' + v.id, { title: $('eTitle').value, description: $('eDesc').value, tags: parseTags($('eTags').value) });
      if (!r.ok) { this.disabled = false; Vane.toast('err', r.error); return; }
      closeModal();
      Vane.toast('ok', 'Saved');
      await loadLibrary();
    });
  }

  /** Share: make the video's public link, copy it, or remove it. Anyone with the address can watch and download the video. */
  function openShare(v) {
    function paint() {
      var cur = find(v.id) || v;
      openModal('<h3 class="mb-1 break-words text-base font-semibold">Share "' + esc(cur.title) + '"</h3>' +
        (cur.publicUrl
          ? '<p class="text-xs leading-relaxed text-white/50">Anyone with this link can watch and download the video. Remove the link and it stops working at once.</p>' +
            '<div class="mt-4 flex items-center gap-2.5"><input id="shareUrl" class="field min-w-0 flex-1 font-mono !text-[13px]" readonly value="' + esc(cur.publicUrl) + '" />' +
            '<button class="btn btn-white btn-sm shrink-0" id="shareCopy">Copy</button></div>' +
            '<div class="mt-5 flex justify-between gap-2"><button class="btn btn-danger btn-sm" id="shareRemove">Remove link</button><button class="btn btn-ghost btn-sm" id="mClose">Done</button></div>'
          : '<p class="text-xs leading-relaxed text-white/50">The video is private now. Make a link to let anyone with the address watch and download it, or to give a platform a file to pull. You can remove the link at any time.</p>' +
            '<div class="mt-5 flex justify-end gap-2"><button class="btn btn-ghost btn-sm" id="mClose">Cancel</button><button class="btn btn-white btn-sm" id="shareMake">Create link</button></div>'));
      $('mClose').addEventListener('click', closeModal);
      var copy = $('shareCopy');
      if (copy) {
        $('shareUrl').addEventListener('focus', function () { this.select(); });
        copy.addEventListener('click', function () { VaneKeys.copyWithToast(cur.publicUrl, 'Link'); });
        $('shareRemove').addEventListener('click', async function () { await change('DELETE', this, 'Link removed'); });
      }
      var make = $('shareMake');
      if (make) make.addEventListener('click', async function () { await change('POST', this, 'Link created'); });
    }
    async function change(method, btn, message) {
      btn.disabled = true;
      var r = await Vane.api(method, '/api/video/videos/' + v.id + '/link');
      if (!r.ok) { btn.disabled = false; Vane.toast('err', r.error); return; }
      S.videos = S.videos.map(function (x) { return x.id === v.id ? r.data.video : x; });
      renderLibrary();
      Vane.toast('ok', message);
      paint();
    }
    paint();
  }

  // ───────────────────────── channels (video networks) ─────────────────────────
  // One entry per video network: icon, tile colour and the card in the connect dialog. The server decides whether a network is
  // open (GET /api/video/channels → platforms[].available). To open one: the server flag, the connect flow behind
  // POST /api/video/channels/connect (see functions/api/lib/videochannels.ts), then `ready: true` here and a setup block in the dialog.
  var VNET = {
    youtube: {
      name: 'YouTube', ready: true, blurb: 'Videos and Shorts', setup: 'Choose which channel Vane should publish to.',
      tile: 'bg-red-500/15 text-red-300',
      icon: { d: 'M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17zM10 15l5-3-5-3z' }
    },
    tiktok: {
      name: 'TikTok', ready: true, blurb: 'Short videos', setup: 'Choose which account Vane should publish to.',
      tile: 'bg-pink-500/15 text-pink-300',
      icon: { d: 'M9 18V5l12-2v13M3 18a3 3 0 1 0 6 0 3 3 0 1 0-6 0M15 16a3 3 0 1 0 6 0 3 3 0 1 0-6 0' }
    },
    instagram: {
      name: 'Instagram Reels', ready: true, blurb: 'Business and Creator accounts', setup: 'Choose which account Vane should publish to.',
      tile: 'bg-orange-500/15 text-orange-300',
      icon: { d: 'M7 2h10a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5zM16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37zM17.5 6.5h.01' }
    },
    pinterest: {
      name: 'Pinterest', ready: false, blurb: 'Video Pins with a link to your site', setup: 'Choose which board Vane should publish to.',
      tile: 'bg-rose-500/15 text-rose-300',
      icon: { d: 'M12 3a9 9 0 0 0-3.3 17.4c-.1-.8-.2-2 0-2.9l1.1-4.6s-.3-.6-.3-1.4c0-1.3.8-2.3 1.7-2.3.8 0 1.2.6 1.2 1.3 0 .8-.5 2-.8 3.1-.2.9.5 1.7 1.4 1.7 1.7 0 3-1.8 3-4.4 0-2.3-1.6-3.9-4-3.9a4.1 4.1 0 0 0-4.3 4.1c0 .8.3 1.7.7 2.2M10 14l-1.300 5.300' }
    }
  };
  var VNET_ORDER = ['youtube', 'tiktok', 'instagram', 'pinterest'];
  var VNET_OTHER = { tile: 'bg-white/[0.08] text-white/70', icon: { d: 'M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.7-1.7' } };
  var TRASH = '<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6M10 11v6M14 11v6"/></svg>';

  function netIcon(key, cls) {
    var ic = (VNET[key] || VNET_OTHER).icon;
    return '<svg class="' + cls + '" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="' + ic.d + '"/></svg>';
  }
  function netTile(key) { return (VNET[key] || VNET_OTHER).tile; }
  function netName(key) { return VNET[key] ? VNET[key].name : key.charAt(0).toUpperCase() + key.slice(1); }
  function isOpen(key) {
    var p = S.platforms.filter(function (x) { return x.id === key; })[0];
    return !!(VNET[key] && VNET[key].ready && p && p.available);
  }

  async function loadChannels() {
    var r = await Vane.api('GET', '/api/video/channels');
    if (!r.ok) return;
    S.channels = r.data.channels;
    S.platforms = r.data.platforms;
    renderChannels();
  }

  function renderChannels() {
    var box = $('channels');
    if (!S.channels.length) {
      box.innerHTML =
        '<div class="rounded-2xl border border-dashed border-white/10 px-5 py-8 text-center">' +
          '<div class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl ' + netTile('other') + '">' + netIcon('other', 'h-5 w-5') + '</div>' +
          '<p class="mt-4 text-sm font-medium">No channels yet</p>' +
          '<p class="mx-auto mt-1 max-w-[20rem] text-xs leading-relaxed text-white/45">YouTube, TikTok, Instagram Reels and Pinterest open one by one as each network approves Vane. You will connect them here.</p>' +
          '<div class="mt-4 flex flex-wrap justify-center gap-2">' + VNET_ORDER.map(function (k) {
            return '<span class="inline-flex items-center gap-1.5 rounded-full bg-white/[0.06] px-2.5 py-1 text-xs text-white/60">' + netIcon(k, 'h-3.5 w-3.5') + esc(VNET[k].name) + '<span class="text-[10px] font-semibold uppercase tracking-wide text-white/40">Soon</span></span>';
          }).join('') + '</div>' +
          '<button type="button" data-act="connect" class="btn btn-white btn-sm mt-5">See the networks</button>' +
        '</div>';
      return;
    }
    box.innerHTML = S.channels.map(function (c) {
      var armed = !!S.armed['del:' + c.id];
      return '<div class="flex items-center gap-3 rounded-2xl bg-white/[0.04] p-3 ring-1 ring-white/5">' +
        '<div class="net-tile ' + netTile(c.platform) + '">' + netIcon(c.platform, 'h-5 w-5') + '</div>' +
        '<div class="min-w-0 flex-1"><div class="truncate text-sm font-medium">' + esc(c.name) + '</div>' +
          '<div class="mt-0.5 text-xs text-white/40">' + esc(netName(c.platform)) + ' · Added ' + esc(fmtDate(c.createdAt)) + '</div></div>' +
        (armed
          ? '<button type="button" data-act="del" data-id="' + esc(c.id) + '" class="btn btn-danger btn-sm shrink-0">Remove?</button>'
          : '<button type="button" data-act="del" data-id="' + esc(c.id) + '" class="icon-btn shrink-0" aria-label="Remove ' + esc(c.name) + '">' + TRASH + '</button>') +
      '</div>';
    }).join('');
  }

  $('channels').addEventListener('click', async function (e) {
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var act = btn.getAttribute('data-act'), id = btn.getAttribute('data-id');
    if (act === 'connect') return openConnect();
    if (act === 'del') {
      var key = 'del:' + id;
      if (!S.armed[key]) {                       // the first click arms, the second confirms
        S.armed[key] = setTimeout(function () { delete S.armed[key]; renderChannels(); }, 3200);
        renderChannels();
        return;
      }
      clearTimeout(S.armed[key]); delete S.armed[key];
      btn.disabled = true;
      var r = await Vane.api('DELETE', '/api/video/channels/' + encodeURIComponent(id));
      if (!r.ok) { Vane.toast('err', r.error); renderChannels(); return; }
      Vane.toast('ok', 'Channel removed');
      await loadChannels();
    }
  });

  // ---- the connect dialog: pick a network (those not open yet are "Soon" and cannot be chosen)
  var cdlg = $('connectDialog');
  function renderNetGrid() {
    $('netGrid').innerHTML = VNET_ORDER.map(function (k) {
      var n = VNET[k], open = isOpen(k);
      return '<button type="button" class="net-card" data-net="' + k + '"' + (open ? '' : ' disabled') + '>' +
        '<span class="net-tile ' + n.tile + '">' + netIcon(k, 'h-5 w-5') + '</span>' +
        '<span class="min-w-0 flex-1"><span class="block text-sm font-semibold">' + esc(n.name) + '</span><span class="block truncate text-xs text-white/45">' + esc(open ? n.blurb : 'Coming soon') + '</span></span>' +
        (open ? '' : '<span class="rounded-full bg-white/[0.08] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white/50">Soon</span>') +
      '</button>';
    }).join('');
  }
  function openConnect() {
    renderNetGrid();
    if (typeof cdlg.showModal === 'function') cdlg.showModal(); else cdlg.setAttribute('open', '');
  }
  function closeConnect() { if (typeof cdlg.close === 'function') cdlg.close(); else cdlg.removeAttribute('open'); }
  $('connectBtn').addEventListener('click', openConnect);
  $('connectClose').addEventListener('click', closeConnect);
  cdlg.addEventListener('click', function (e) { if (e.target === cdlg) closeConnect(); });
  // The connect step of an open network goes here (the setup block of that network, see the note above VNET).
  $('netGrid').addEventListener('click', function (e) {
    var b = e.target.closest('[data-net]');
    if (!b || b.disabled) return;
    var key = b.getAttribute('data-net');
    if (!isOpen(key)) { Vane.toast('info', netName(key) + ' cannot be connected yet.'); return; }
    b.disabled = true;
    Vane.api('POST', '/api/video/channels/connect', { platform: key }).then(function (r) {
      // The network's own page asks for permission; it brings the person back here with the result in the address.
      if (r.ok && r.data && r.data.redirect) { window.location.assign(r.data.redirect); return; }
      b.disabled = false;
      Vane.toast('err', r.ok ? 'Could not start the connection.' : r.error);
    });
  });

  // Back from Google: say how it went, then clean the address.
  var CONNECT_ERRORS = {
    cancelled: 'You cancelled the connection.', expired: 'The sign-in took too long or was opened in another browser. Try again.',
    no_upload: 'Vane needs the permission to upload videos. Connect again and leave that box ticked.',
    no_refresh: 'Google did not give a lasting connection. Remove Vane at myaccount.google.com/permissions and connect again.',
    unavailable: 'This network is not available yet.', plan: 'Vane Studio is not active on your account.', busy: 'Too many attempts. Wait a little and try again.',
    no_publish: 'Vane needs the permission to publish. Connect again and keep it ticked.',
    signin: 'Sign in again, then connect the channel.', failed: 'Google did not complete the connection. Try again.'
  };
  (function () {
    var q = new URLSearchParams(window.location.search);
    var ok = q.get('connected'), err = q.get('connect_error');
    if (!ok && !err) return;
    if (ok) Vane.toast('ok', netName(ok) + ' is connected.');
    else Vane.toast('err', CONNECT_ERRORS[err] || 'The connection did not finish.');
    try { window.history.replaceState(null, '', window.location.pathname); } catch (e) { /* not important */ }
  })();

  // ───────────────────────── publishing (the queue is network-agnostic; the networks plug in behind it) ─────────────────────────
  var YT_CATS = { '22': 'People & Blogs', '1': 'Film & Animation', '2': 'Autos & Vehicles', '10': 'Music', '15': 'Pets & Animals', '17': 'Sports', '19': 'Travel & Events', '20': 'Gaming', '23': 'Comedy', '24': 'Entertainment', '25': 'News & Politics', '26': 'Howto & Style', '27': 'Education', '28': 'Science & Technology', '29': 'Nonprofits & Activism' };
  var PRIVACY_TEXT = {
    private: 'Only you can see it.',
    unlisted: 'Anyone with the link can see it, but it is not listed.',
    public: 'Everyone can find and watch it.'
  };
  var PUB_BADGE = {
    queued: ['badge-scheduled', 'Queued'],
    publishing: ['badge-processing', 'Publishing'],
    published: ['badge-sent', 'Published'],
    failed: ['badge-failed', 'Failed']
  };

  function untilText(ts) {
    var s = Math.max(0, ts - Math.floor(Date.now() / 1000));
    if (s < 60) return 'in ' + s + ' s';
    if (s < 3600) return 'in ' + Math.round(s / 60) + ' min';
    return 'in ' + Math.round(s / 3600) + ' h';
  }

  function renderPublications() {
    var box = $('publications');
    if (!S.publications.length) {
      box.innerHTML = '<p class="rounded-2xl border border-dashed border-white/10 px-5 py-6 text-center text-xs leading-relaxed text-white/45">Nothing published yet. Use <span class="font-medium text-white/70">Publish</span> on a video once a channel is connected.</p>';
      return;
    }
    box.innerHTML = S.publications.map(function (p) {
      var b = PUB_BADGE[p.status];
      var detail = '';
      if (p.status === 'queued') detail = (p.error ? esc(p.error) + ' ' : '') + 'Next try ' + untilText(p.nextAttemptAt) + ' (attempt ' + (p.attempts + 1) + ' of ' + p.maxAttempts + ').';
      else if (p.status === 'publishing') detail = 'Uploading to ' + esc(netName(p.platform)) + '…';
      else if (p.status === 'failed') detail = esc(p.error || 'Something went wrong.');
      else if (p.status === 'published' && p.error) detail = esc(p.error);
      var actions = '';
      if (p.status === 'published' && p.url) actions += '<a class="btn btn-ghost btn-sm" href="' + esc(p.url) + '" target="_blank" rel="noopener noreferrer">View</a>';
      if (p.status === 'failed') actions += '<button class="btn btn-white btn-sm" data-act="retry" data-id="' + esc(p.id) + '">Retry</button>';
      if (p.status !== 'publishing') actions += '<button class="icon-btn" data-act="remove" data-id="' + esc(p.id) + '" aria-label="' + (p.status === 'queued' ? 'Cancel' : 'Remove from history') + '" title="' + (p.status === 'queued' ? 'Cancel' : 'Remove from history') + '">' + TRASH + '</button>';
      return '<div class="flex flex-wrap items-center gap-3 rounded-2xl bg-white/[0.04] p-3 ring-1 ring-white/5">' +
        '<div class="net-tile ' + netTile(p.platform) + '">' + netIcon(p.platform, 'h-5 w-5') + '</div>' +
        '<div class="min-w-0 flex-1">' +
          '<div class="flex flex-wrap items-center gap-2"><span class="truncate text-sm font-medium">' + esc(p.title) + '</span><span class="badge ' + b[0] + '">' + b[1] + '</span></div>' +
          '<div class="mt-0.5 truncate text-xs text-white/45">' + esc(netName(p.platform)) + ' · ' + esc(p.channelName) + ' · ' + esc(p.privacy) + ' · ' + esc(fmtDate(p.createdAt)) + '</div>' +
          (detail ? '<div class="mt-1 text-xs ' + (p.status === 'failed' ? 'text-red-200/80' : 'text-white/50') + '">' + detail + '</div>' : '') +
        '</div>' +
        '<div class="flex shrink-0 items-center gap-2">' + actions + '</div></div>';
    }).join('');
  }

  /** Reloads the history. While something is queued or publishing it keeps itself fresh (the server also nudges due retries on each call). */
  async function loadPublications() {
    var r = await Vane.api('GET', '/api/video/publications');
    if (!r.ok) return;
    S.publications = r.data.publications;
    renderPublications();
    var busy = S.publications.some(function (p) { return p.status === 'queued' || p.status === 'publishing'; });
    $('pubLive').classList.toggle('hidden', !busy);
    clearTimeout(S.pubTimer);
    S.pubTimer = busy ? setTimeout(loadPublications, 4000) : null;
  }

  $('publications').addEventListener('click', async function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var id = btn.getAttribute('data-id'), act = btn.getAttribute('data-act');
    btn.disabled = true;
    var r = act === 'retry' ? await Vane.api('POST', '/api/video/publications/' + id + '/retry', {}) : await Vane.api('DELETE', '/api/video/publications/' + id);
    if (!r.ok) { btn.disabled = false; Vane.toast('err', r.error); return; }
    Vane.toast('ok', act === 'retry' ? 'Trying again' : 'Removed');
    await loadPublications();
  });

  /** The publish dialog: which channels, and the title, description and privacy for them. */
  async function openPublish(v) {
    openModal('<h3 class="mb-3 break-words text-base font-semibold">Publish "' + esc(v.title) + '"</h3><p class="text-sm text-white/50">Loading your channels…</p>');
    var r = await Vane.api('GET', '/api/video/channels');
    if (!r.ok) { closeModal(); Vane.toast('err', r.error); return; }
    S.channels = r.data.channels; S.platforms = r.data.platforms;
    var channels = S.channels.filter(function (c) { return c.isActive; });

    if (!channels.length) {
      openModal('<h3 class="mb-2 text-base font-semibold">Publish "' + esc(v.title) + '"</h3>' +
        '<p class="text-sm leading-relaxed text-white/60">You have no video channels yet. YouTube, TikTok, Instagram Reels and Pinterest open one by one as each network approves Vane. Once a channel is connected, publishing is one click here.</p>' +
        '<div class="mt-5 flex justify-end gap-2"><button class="btn btn-ghost btn-sm" id="mClose">Close</button><button class="btn btn-white btn-sm" id="pubNets">See the networks</button></div>');
      $('mClose').addEventListener('click', closeModal);
      $('pubNets').addEventListener('click', function () { closeModal(); openConnect(); });
      return;
    }

    openModal('<h3 class="mb-1 break-words text-base font-semibold">Publish "' + esc(v.title) + '"</h3>' +
      '<p class="text-xs text-white/45">The video goes up in the background. If a network is busy, Vane tries again by itself.</p>' +
      '<fieldset class="mt-4"><legend class="mb-2 text-xs text-white/55">Channels</legend><div id="pubChannels" class="flex flex-wrap gap-2">' +
        channels.map(function (c) {
          return '<label class="flex cursor-pointer items-center gap-2 rounded-full bg-white/[0.06] px-3 py-1.5 text-sm ring-1 ring-white/10 has-[:checked]:bg-white has-[:checked]:text-black">' +
            '<input type="checkbox" class="sr-only" value="' + esc(c.id) + '" />' +
            '<span class="font-medium">' + esc(netName(c.platform)) + '</span><span class="opacity-60">' + esc(c.name) + '</span></label>';
        }).join('') + '</div></fieldset>' +
      '<div class="mt-4 space-y-3">' +
        '<div><label for="pubName" class="mb-1 block text-xs text-white/55">Title</label><input id="pubName" class="field" maxlength="100" value="' + esc(v.title) + '" /></div>' +
        '<div><label for="pubDesc" class="mb-1 block text-xs text-white/55">Description</label><textarea id="pubDesc" class="field" rows="4" maxlength="5000">' + esc(v.description) + '</textarea></div>' +
        '<div id="pubPrivacyBox"><label for="pubPrivacy" class="mb-1 block text-xs text-white/55">Who can see it</label><select id="pubPrivacy" class="field"><option value="private">Private</option><option value="unlisted">Unlisted</option><option value="public">Public</option></select>' +
          '<p id="pubPrivacyHint" class="mt-1.5 text-xs text-white/45"></p></div>' +
        '<div id="pubIg" class="hidden space-y-2 rounded-2xl bg-white/[0.04] p-3 ring-1 ring-white/5">' +
          '<p class="text-xs font-medium text-white/70">Instagram Reels</p>' +
          '<label class="flex items-center gap-2 text-xs text-white/65"><input type="checkbox" id="pubFeed" checked /> Also show the Reel in my profile feed</label>' +
          '<p class="text-xs leading-relaxed text-amber-200/80">Instagram has no private or unlisted videos: a Reel is always public, so choose <b>Public</b> above. Business and Creator accounts only; the video can be up to 300 MB.</p>' +
        '</div>' +
        '<div id="pubTt" class="hidden space-y-3 rounded-2xl bg-white/[0.04] p-3 ring-1 ring-white/5">' +
          '<p class="text-xs font-medium text-white/70">TikTok <span id="pubTtName" class="font-normal text-white/50"></span></p>' +
          '<p id="pubTtState" class="text-xs text-white/45">Loading what TikTok allows for this account…</p>' +
          '<div id="pubTtForm" class="hidden space-y-3">' +
            '<div><label for="pubTtPrivacy" class="mb-1 block text-xs text-white/55">Who can see this video</label><select id="pubTtPrivacy" class="field"></select></div>' +
            '<div class="space-y-1.5"><p class="text-xs text-white/55">Allow others to</p>' +
              '<label class="flex items-center gap-2 text-xs text-white/65"><input type="checkbox" id="pubTtComment" /> Comment</label>' +
              '<label class="flex items-center gap-2 text-xs text-white/65"><input type="checkbox" id="pubTtDuet" /> Duet</label>' +
              '<label class="flex items-center gap-2 text-xs text-white/65"><input type="checkbox" id="pubTtStitch" /> Stitch</label></div>' +
            '<div><label class="flex items-center gap-2 text-xs text-white/65"><input type="checkbox" id="pubTtCom" /> This video promotes a brand, product or service</label>' +
              '<div id="pubTtComBox" class="mt-2 hidden space-y-1.5 pl-5">' +
                '<label class="flex items-center gap-2 text-xs text-white/65"><input type="checkbox" id="pubTtOwn" /> Your own brand</label>' +
                '<label class="flex items-center gap-2 text-xs text-white/65"><input type="checkbox" id="pubTtThird" /> A third party (branded content)</label>' +
                '<p id="pubTtComHint" class="text-xs text-white/45"></p></div></div>' +
            '<label class="flex items-start gap-2 text-xs leading-relaxed text-white/65"><input type="checkbox" id="pubTtConsent" class="mt-0.5" /> <span id="pubTtConsentText"></span></label>' +
            '<p class="text-xs leading-relaxed text-amber-200/80">Until TikTok approves Vane, it accepts only "Only me" posts. Vane shows you what TikTok answered.</p>' +
          '</div>' +
        '</div>' +
        '<div id="pubYt" class="hidden space-y-3 rounded-2xl bg-white/[0.04] p-3 ring-1 ring-white/5">' +
          '<p class="text-xs font-medium text-white/70">YouTube</p>' +
          '<div><label for="pubKids" class="mb-1 block text-xs text-white/55">Is this video made for kids?</label><select id="pubKids" class="field"><option value="">Choose…</option><option value="no">No, it is not made for kids</option><option value="yes">Yes, it is made for kids</option></select>' +
            '<p class="mt-1.5 text-xs text-white/45">YouTube requires this answer for every video.</p></div>' +
          '<div><label for="pubCat" class="mb-1 block text-xs text-white/55">Category</label><select id="pubCat" class="field">' +
            Object.keys(YT_CATS).map(function (k) { return '<option value="' + k + '"' + (k === '22' ? ' selected' : '') + '>' + esc(YT_CATS[k]) + '</option>'; }).join('') + '</select></div>' +
          '<p class="text-xs leading-relaxed text-amber-200/80">Until Google approves Vane, YouTube may keep new videos private whatever you choose here. Vane tells you what YouTube did.</p>' +
        '</div>' +
      '</div>' +
      '<div class="mt-5 flex justify-end gap-2"><button class="btn btn-ghost btn-sm" id="mClose">Cancel</button><button class="btn btn-white btn-sm" id="pubSend" disabled>Publish</button></div>');

    var TT_LEVELS = { PUBLIC_TO_EVERYONE: 'Everyone', MUTUAL_FOLLOW_FRIENDS: 'Friends', FOLLOWER_OF_CREATOR: 'Followers', SELF_ONLY: 'Only me' };
    var ttCreators = {}, ttLoading = '';
    function ttChannel() {
      var i = picked().filter(function (x) { var c = channels.filter(function (y) { return y.id === x.value; })[0]; return c && c.platform === 'tiktok'; })[0];
      return i ? i.value : '';
    }
    async function ttLoad(id) {
      if (ttCreators[id] || ttLoading === id) return;
      ttLoading = id;
      var r = await Vane.api('GET', '/api/video/channels/tiktok/creator?channel=' + encodeURIComponent(id));
      ttLoading = '';
      ttCreators[id] = r.ok && r.data && r.data.creator ? r.data.creator : { error: r.error || 'TikTok did not answer.' };
      sync();
    }
    function ttShow(id) {
      var c = ttCreators[id], st = $('pubTtState'), form = $('pubTtForm');
      if (!c) { st.textContent = 'Loading what TikTok allows for this account…'; st.classList.remove('hidden'); form.classList.add('hidden'); return; }
      if (c.error) { st.textContent = c.error; st.classList.remove('hidden'); form.classList.add('hidden'); return; }
      st.classList.add('hidden'); form.classList.remove('hidden');
      $('pubTtName').textContent = c.username ? '@' + c.username : c.nickname;
      var sel = $('pubTtPrivacy');
      if (sel.dataset.for !== id) {
        sel.dataset.for = id;
        sel.innerHTML = '<option value="">Choose…</option>' + c.privacyOptions.map(function (k) { return '<option value="' + k + '">' + TT_LEVELS[k] + '</option>'; }).join('');
        [['pubTtComment', c.commentDisabled], ['pubTtDuet', c.duetDisabled], ['pubTtStitch', c.stitchDisabled]].forEach(function (a) { $(a[0]).checked = false; $(a[0]).disabled = a[1]; });
      }
      var com = $('pubTtCom').checked;
      $('pubTtComBox').classList.toggle('hidden', !com);
      var third = com && $('pubTtThird').checked;
      var priv = $('pubTtPrivacy').value;
      $('pubTtComHint').textContent = com && !$('pubTtOwn').checked && !$('pubTtThird').checked ? 'Choose at least one.' : (third && priv === 'SELF_ONLY' ? 'Branded content cannot be "Only me".' : '');
      $('pubTtConsentText').textContent = third
        ? "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation."
        : "By posting, you agree to TikTok's Music Usage Confirmation.";
    }
    function ttReady() {
      var id = ttChannel(), c = ttCreators[id];
      if (!c || c.error || !$('pubTtPrivacy').value || !$('pubTtConsent').checked) return false;
      if ($('pubTtCom').checked) {
        if (!$('pubTtOwn').checked && !$('pubTtThird').checked) return false;
        if ($('pubTtThird').checked && $('pubTtPrivacy').value === 'SELF_ONLY') return false;
      }
      return true;
    }
    function picked() { return Array.prototype.slice.call(document.querySelectorAll('#pubChannels input:checked')); }
    function sync() {
      $('pubPrivacyHint').textContent = PRIVACY_TEXT[$('pubPrivacy').value];
      var yt = picked().some(function (i) { var c = channels.filter(function (x) { return x.id === i.value; })[0]; return c && c.platform === 'youtube'; });
      $('pubYt').classList.toggle('hidden', !yt);
      var ig = picked().some(function (i) { var c = channels.filter(function (x) { return x.id === i.value; })[0]; return c && c.platform === 'instagram'; });
      $('pubIg').classList.toggle('hidden', !ig);
      var tid = ttChannel(), tt = !!tid;
      $('pubTt').classList.toggle('hidden', !tt);
      if (tt) { ttShow(tid); ttLoad(tid); }
      var onlyTt = tt && picked().every(function (i) { var c = channels.filter(function (x) { return x.id === i.value; })[0]; return c && c.platform === 'tiktok'; });
      $('pubPrivacyBox').classList.toggle('hidden', onlyTt);
      $('pubSend').disabled = !picked().length || !$('pubName').value.trim() || (yt && !$('pubKids').value) || (ig && $('pubPrivacy').value !== 'public') || (tt && !ttReady());
    }
    $('pubKids').addEventListener('change', function () { sync(); });
    $('pubTt').addEventListener('change', sync);
    $('pubChannels').addEventListener('change', sync);
    $('pubName').addEventListener('input', sync);
    $('pubPrivacy').addEventListener('change', sync);
    $('mClose').addEventListener('click', closeModal);
    sync();

    $('pubSend').addEventListener('click', async function () {
      var btn = this;
      btn.disabled = true;
      var payload = {
        channelIds: picked().map(function (i) { return i.value; }),
        title: $('pubName').value.trim(), description: $('pubDesc').value, privacy: $('pubPrivacy').value
      };
      if (!$('pubTt').classList.contains('hidden')) {
        var lvl = $('pubTtPrivacy').value, com = $('pubTtCom').checked;
        payload.tiktok = { privacyLevel: lvl, allowComment: $('pubTtComment').checked, allowDuet: $('pubTtDuet').checked, allowStitch: $('pubTtStitch').checked, commercial: com, brandOrganic: com && $('pubTtOwn').checked, brandContent: com && $('pubTtThird').checked, consent: $('pubTtConsent').checked };
        if ($('pubPrivacyBox').classList.contains('hidden')) payload.privacy = lvl === 'PUBLIC_TO_EVERYONE' ? 'public' : lvl === 'SELF_ONLY' ? 'private' : 'unlisted';
      }
      if (!$('pubIg').classList.contains('hidden')) payload.instagram = { shareToFeed: $('pubFeed').checked };
      if (!$('pubYt').classList.contains('hidden')) payload.youtube = { madeForKids: $('pubKids').value === 'yes', category: $('pubCat').value };
      var res = await Vane.api('POST', '/api/video/videos/' + v.id + '/publish', payload);
      if (!res.ok) { btn.disabled = false; Vane.toast('err', res.error); return; }
      closeModal();
      var n = res.data.publications.length;
      Vane.toast('ok', 'Publishing to ' + n + (n === 1 ? ' channel' : ' channels') + ' has started.');
      await loadPublications();
    });
  }

  // ───────────────────────── announce in Vane Post (the Studio → Post hand-off) ─────────────────────────
  // The text and the channels are chosen here; the server writes the post with the same code as Vane Post, so the same limits
  // apply and the post goes out within a minute, without opening the posting dashboard.
  var NET_LIMIT = { telegram: 4096, x: 280, linkedin: 3000, webhook: 10000, bluesky: 300, mastodon: 500, discord: 2000, devto: 10000, threads: 500 };
  var NET_NAME = { telegram: 'Telegram', x: 'X', linkedin: 'LinkedIn', webhook: 'Webhook', bluesky: 'Bluesky', mastodon: 'Mastodon', discord: 'Discord', devto: 'Dev.to', threads: 'Threads' };
  var LINK_PLACEHOLDER = '{link}';
  var LINK_LENGTH = 76;   // a public link: host + path + 32-character token (Mastodon counts any link as 23)

  /** A first draft: the title, the start of the description, the tags as hashtags, and the link. Editable before sending. */
  function composeText(v) {
    var desc = (v.description || '').replace(/\s+/g, ' ').trim();
    if (desc.length > 140) desc = desc.slice(0, 139).trimEnd() + '…';
    var tags = v.tags.slice(0, 4).map(function (t) { return '#' + t.replace(/\s+/g, ''); }).join(' ');
    return v.title + (desc ? '\n\n' + desc : '') + (tags ? '\n\n' + tags : '') + '\n\n' + LINK_PLACEHOLDER;
  }

  /** How long the text will be on a network (the link counts as it will really be). */
  function lengthOn(text, platform) {
    var n = platform === 'mastodon' ? 23 : LINK_LENGTH;
    var filled = text.split(LINK_PLACEHOLDER).join(new Array(n + 1).join('x'));
    return platform === 'bluesky' && window.Intl && Intl.Segmenter ? Array.from(new Intl.Segmenter().segment(filled)).length : filled.length;
  }

  async function openAnnounce(v) {
    openModal('<h3 class="mb-3 break-words text-base font-semibold">Announce "' + esc(v.title) + '"</h3><p class="text-sm text-white/50">Loading your channels…</p>');
    var r = await Vane.api('GET', '/api/video/announce');
    if (!r.ok) { closeModal(); Vane.toast('err', r.error); return; }
    var channels = r.data.channels.filter(function (c) { return c.isActive; });

    if (!channels.length) {
      openModal('<h3 class="mb-2 text-base font-semibold">Announce "' + esc(v.title) + '"</h3>' +
        '<p class="text-sm leading-relaxed text-white/60">You have no social channels yet. Connect Telegram, Bluesky or another channel in Vane Post, then come back and announce your video in one click.</p>' +
        '<div class="mt-5 flex justify-end gap-2"><button class="btn btn-ghost btn-sm" id="mClose">Close</button><a class="btn btn-white btn-sm" href="' + esc(Vane.productUrl('post')) + '">Open Vane Post</a></div>');
      $('mClose').addEventListener('click', closeModal);
      return;
    }

    openModal('<h3 class="mb-1 break-words text-base font-semibold">Announce "' + esc(v.title) + '"</h3>' +
      '<p class="text-xs text-white/45">Posts to your channels within a minute. <span class="pixel">{link}</span> becomes this video\'s public link (made now if it has none).</p>' +
      '<fieldset class="mt-4"><legend class="mb-2 text-xs text-white/55">Channels</legend><div id="annChannels" class="flex flex-wrap gap-2">' +
        channels.map(function (c) {
          return '<label class="flex cursor-pointer items-center gap-2 rounded-full bg-white/[0.06] px-3 py-1.5 text-sm ring-1 ring-white/10 has-[:checked]:bg-white has-[:checked]:text-black">' +
            '<input type="checkbox" class="sr-only" data-plat="' + esc(c.platform) + '" value="' + esc(c.id) + '" checked />' +
            '<span class="font-medium">' + esc(NET_NAME[c.platform] || c.platform) + '</span><span class="opacity-60">' + esc(c.name) + '</span></label>';
        }).join('') + '</div></fieldset>' +
      '<div class="mt-4"><label for="annText" class="mb-1 block text-xs text-white/55">Text</label>' +
        '<textarea id="annText" class="field" rows="7" maxlength="10000">' + esc(composeText(v)) + '</textarea>' +
        '<p id="annHint" class="mt-1.5 min-h-[1rem] text-xs text-white/45" aria-live="polite"></p></div>' +
      '<div class="mt-5 flex justify-end gap-2"><button class="btn btn-ghost btn-sm" id="mClose">Cancel</button><button class="btn btn-white btn-sm" id="annSend">Announce</button></div>');

    function picked() { return Array.prototype.slice.call(document.querySelectorAll('#annChannels input:checked')); }
    function check() {
      var text = $('annText').value, hint = $('annHint'), problems = [];
      picked().forEach(function (i) {
        var p = i.getAttribute('data-plat'), len = lengthOn(text, p), limit = NET_LIMIT[p] || 10000;
        if (len > limit && problems.indexOf(p) === -1) problems.push(NET_NAME[p] + ' ' + len + '/' + limit);
      });
      var ok = text.trim() && picked().length && !problems.length;
      hint.textContent = !picked().length ? 'Choose at least one channel.' : problems.length ? 'Too long for ' + problems.join(', ') + '. Shorten the text.' : '';
      hint.className = 'mt-1.5 min-h-[1rem] text-xs ' + (problems.length || !picked().length ? 'text-amber-200' : 'text-white/45');
      $('annSend').disabled = !ok;
    }
    $('annText').addEventListener('input', check);
    $('annChannels').addEventListener('change', check);
    $('mClose').addEventListener('click', closeModal);
    check();

    $('annSend').addEventListener('click', async function () {
      var btn = this;
      btn.disabled = true;
      var res = await Vane.api('POST', '/api/video/videos/' + v.id + '/announce', { text: $('annText').value, channelIds: picked().map(function (i) { return i.value; }) });
      if (!res.ok) { btn.disabled = false; Vane.toast('err', res.error); return; }
      closeModal();
      Vane.toast('ok', 'Announcement queued for ' + res.data.channels + (res.data.channels === 1 ? ' channel' : ' channels') + '. It goes out within a minute.');
      await Promise.all([loadLibrary(), refreshOverview()]);
    });
  }

  /** After an upload: offer to announce it, but only when there is somewhere to announce it (never nag an account with no channels). */
  async function offerAnnounce(videoId) {
    var r = await Vane.api('GET', '/api/video/announce', undefined, { noRedirect: true });
    if (!r.ok || !r.data.channels.some(function (c) { return c.isActive; })) return;
    var banner = $('announceBanner');
    banner.classList.remove('hidden'); banner.classList.add('flex');
    banner.setAttribute('data-video', videoId);
  }
  function hideBanner() { var b = $('announceBanner'); b.classList.add('hidden'); b.classList.remove('flex'); b.removeAttribute('data-video'); }
  $('announceLater').addEventListener('click', hideBanner);
  $('announceNow').addEventListener('click', function () {
    var v = find($('announceBanner').getAttribute('data-video'));
    hideBanner();
    if (v) openAnnounce(v);
  });

  // ───────────────────────── cover ─────────────────────────
  var COVER_MAX = 2 * 1024 * 1024;
  /** A picture the person chose, or null (with a message) when it cannot be a cover. The server checks it again from the bytes. */
  function coverProblem(f) {
    if (!f) return 'Choose a picture.';
    if (!/\.(jpe?g|png|webp)$/i.test(f.name) && !/^image\/(jpeg|png|webp)$/.test(f.type)) return 'The cover must be a JPEG, PNG or WebP picture.';
    if (f.size > COVER_MAX) return 'The cover can be up to 2 MB.';
    return '';
  }
  function setCover(f) {
    var problem = f ? coverProblem(f) : '';
    if (problem) { Vane.toast('err', problem); return; }
    if (S.coverUrl) URL.revokeObjectURL(S.coverUrl);
    S.cover = f || null;
    S.coverUrl = f ? URL.createObjectURL(f) : '';
    $('upCoverImg').src = S.coverUrl;
    $('upCoverImg').classList.toggle('hidden', !f);
    $('upCoverClear').classList.toggle('hidden', !f);
    $('upCoverBtn').textContent = f ? 'Change' : 'Choose a picture';
    if (!f) $('upCover').value = '';
  }
  $('upCover').addEventListener('change', function () { if (this.files[0]) setCover(this.files[0]); });
  $('upCoverClear').addEventListener('click', function () { setCover(null); });

  /** Sends the chosen cover of a finished upload. Says so when it is refused (the video itself is safe). */
  async function sendCover(videoId, file) {
    var r = await uploadCover(videoId, file);
    if (!r.ok) Vane.toast('err', 'The video is uploaded, but its cover was not: ' + r.error);
    return r.ok;
  }
  async function uploadCover(videoId, file) {
    try {
      var res = await fetch('/api/video/videos/' + videoId + '/cover', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
      var data = null;
      try { data = await res.json(); } catch (e) { /* not JSON */ }
      if (res.status === 401) { Vane.go(Vane.loginUrl()); return { ok: false, error: 'Please sign in again.' }; }
      return res.ok && data && data.ok ? { ok: true } : { ok: false, error: (data && data.error) || 'The cover could not be saved (' + res.status + ').' };
    } catch (e) { return { ok: false, error: 'Network error. Check your connection.' }; }
  }

  // ───────────────────────── choosing a file ─────────────────────────
  function setFile(f) {
    if (!f) return;
    if (!/\.(mp4|mov)$/i.test(f.name)) { Vane.toast('err', 'Only MP4 and MOV videos are supported.'); return; }
    if (f.size <= 0) { Vane.toast('err', 'That file is empty.'); return; }
    if (f.size > S.limits.maxFileBytes) { Vane.toast('err', 'Videos can be up to ' + fmtBytes(S.limits.maxFileBytes) + '.'); return; }
    S.file = f;
    $('dropTitle').textContent = f.name;
    $('dropSub').textContent = fmtBytes(f.size);
    $('uploadBtn').disabled = false;
    $('dropPreview').classList.add('hidden');
    var mine = S.preview = makePreview(f);
    mine.then(function (p) {                                      // show the frame once it is ready, unless another file was chosen since
      if (S.preview !== mine || !p || !p.blob) return;
      $('dropPreview').src = p.url;
      $('dropPreview').classList.remove('hidden');
    });
  }

  /**
   * A preview frame and the length of the chosen video, made in the browser (nothing leaves the machine until the upload finishes).
   * Resolves to { blob, url, d, w, h }, or null when the browser cannot decode the file (some codecs): the video then just
   * shows a placeholder, and the upload is unaffected.
   */
  function makePreview(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var v = document.createElement('video');
      var info = { d: 0, w: 0, h: 0 };
      var done = false;
      var timer = setTimeout(function () { finish(null); }, 8000);
      function finish(result) {
        if (done) return;
        done = true; clearTimeout(timer);
        v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url);
        resolve(result);
      }
      v.muted = true; v.playsInline = true; v.preload = 'metadata';
      v.onerror = function () { finish(null); };
      v.onloadedmetadata = function () {
        var dur = isFinite(v.duration) ? v.duration : 0;
        info = { d: Math.round(dur * 1000), w: v.videoWidth, h: v.videoHeight };
        v.currentTime = dur > 0 ? Math.min(1, dur * 0.1) : 0.1;   // a little after the start: the very first frame is often black
      };
      v.onseeked = function () {
        if (!info.w || !info.h) return finish(null);
        var w = Math.min(480, info.w), h = Math.max(1, Math.round(info.h * w / info.w));
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        try { canvas.getContext('2d').drawImage(v, 0, 0, w, h); } catch (e) { return finish(null); }
        canvas.toBlob(function (blob) {
          finish(blob ? { blob: blob, url: URL.createObjectURL(blob), d: info.d, w: info.w, h: info.h } : null);
        }, 'image/jpeg', 0.8);
      };
      v.src = url;
    });
  }

  /**
   * Takes frames from the uploaded file and sends them to be checked for 18+ or violent content (the server cannot decode video).
   * One flagged frame removes the video; without a passed check it can be neither published nor shared. Tries twice: a checker
   * that was busy a moment ago usually is not now. Resolves to true when the video passed.
   */
  async function sendFrames(videoId, file) {
    var frames = await Vane.videoFrames(file, 20000);
    if (frames.length < 3) {
      Vane.toast('err', 'This browser could not read frames from the video to check it, so it cannot be published yet. Try another browser, or export the video as H.264 MP4.');
      return false;
    }
    for (var attempt = 0; attempt < 2; attempt++) {
      var fd = new FormData();
      frames.forEach(function (b, n) { fd.append('frame', b, 'frame' + n + '.jpg'); });
      try {
        var res = await fetch('/api/video/videos/' + videoId + '/frames', { method: 'POST', credentials: 'same-origin', body: fd });
        var data = await res.json().catch(function () { return null; });
        if (res.ok) return true;
        if (res.status === 503 && attempt === 0) { await new Promise(function (r) { setTimeout(r, 2500); }); continue; }
        Vane.toast('err', (data && data.error) || 'The video could not be checked. Upload it again.');
        return false;
      } catch (e) {
        if (attempt === 1) Vane.toast('err', 'The video could not be checked (network error). Upload it again.');
      }
    }
    return false;
  }

  /** Sends the preview frame of a finished upload. Best effort: the video is already safe, so a failure is not shown. */
  async function sendPreview(videoId, previewPromise) {
    try {
      var p = await previewPromise;
      if (!p || !p.blob) return;
      await fetch('/api/video/videos/' + videoId + '/thumbnail?d=' + p.d + '&w=' + p.w + '&h=' + p.h, {
        method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'image/jpeg' }, body: p.blob
      });
    } catch (e) { /* the placeholder is shown instead */ }
  }
  $('fileInput').addEventListener('change', function () { setFile(this.files[0]); });
  var drop = $('drop');
  ['dragenter', 'dragover'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('border-white/50'); }); });
  ['dragleave', 'drop'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('border-white/50'); }); });
  drop.addEventListener('drop', function (e) { if (!S.up) setFile(e.dataTransfer.files[0]); });

  // ───────────────────────── uploading ─────────────────────────
  // The server fixes the chunk size (partSize): every chunk but the last is exactly that long. Chunks go up three at a time,
  // each one retried with a growing pause; what the server already has is never sent twice, so a reload or a dropped
  // connection costs only the chunks that were in flight.

  function partLen(U, n) { return n < U.partCount ? U.partSize : U.file.size - U.partSize * (U.partCount - 1); }

  function showProgress() {
    var U = S.up;
    var sent = 0;
    for (var n = 1; n <= U.partCount; n++) {
      if (U.done[n]) sent += partLen(U, n);
      else if (U.loaded[n]) sent += U.loaded[n];
    }
    var pct = Math.min(100, Math.floor((sent / U.file.size) * 100));
    $('progressPct').textContent = pct + '%';
    $('progressFill').style.width = pct + '%';
    $('progressBar').setAttribute('aria-valuenow', String(pct));
  }

  function putPart(U, n, blob) {
    return new Promise(function (resolve) {
      var xhr = new XMLHttpRequest();
      U.xhrs.push(xhr);
      xhr.open('PUT', '/api/video/uploads/' + U.videoId + '/parts/' + n);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.responseType = 'text';
      xhr.upload.onprogress = function (e) { if (e.lengthComputable) { U.loaded[n] = e.loaded; showProgress(); } };
      var finish = function (r) { U.xhrs.splice(U.xhrs.indexOf(xhr), 1); U.loaded[n] = 0; resolve(r); };
      xhr.onload = function () {
        var data = null;
        try { data = JSON.parse(xhr.responseText); } catch (e) { /* not JSON */ }
        if (xhr.status >= 200 && xhr.status < 300 && data && data.ok) { U.done[n] = true; finish({ ok: true }); }
        else finish({ ok: false, status: xhr.status, code: data && data.code, error: (data && data.error) || 'Upload failed (' + xhr.status + ').' });
      };
      xhr.onerror = function () { finish({ ok: false, status: 0, error: 'Network error. Check your connection.' }); };
      xhr.ontimeout = xhr.onerror;
      xhr.onabort = function () { finish({ ok: false, aborted: true }); };
      xhr.send(blob);
    });
  }

  async function sendPart(U, n) {
    var from = (n - 1) * U.partSize;
    var blob = U.file.slice(from, from + partLen(U, n));
    var r = { ok: false, error: 'Upload failed.' };
    for (var attempt = 0; attempt <= RETRIES; attempt++) {
      if (U.cancelled) return { ok: false, aborted: true };
      r = await putPart(U, n, blob);
      if (r.ok || r.aborted) return r;
      if (r.status === 401) { Vane.go(Vane.loginUrl()); return r; }
      var permanent = r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429;
      if (permanent) return r;                 // the server said no: sending it again will not change that
      await sleep(1000 * Math.pow(2, attempt));
    }
    return r;
  }

  function setBusy(busy) {
    $('uploadBtn').disabled = busy || !S.file;
    $('fileInput').disabled = busy; $('upCover').disabled = busy; $('upCoverClear').disabled = busy;
    ['upTitle', 'upDesc', 'upTags'].forEach(function (id) { $(id).disabled = busy; });
    $('cancelBtn').classList.toggle('hidden', !busy);
    $('progressBox').classList.toggle('hidden', !busy);
    if (!busy) { $('progressFill').style.width = '0%'; $('progressPct').textContent = '0%'; }
  }

  function resetForm() {
    S.file = null;
    $('fileInput').value = '';
    $('dropTitle').textContent = 'Choose a video, or drop it here';
    $('dropSub').textContent = 'MP4 or MOV';
    ['upTitle', 'upDesc', 'upTags'].forEach(function (id) { $(id).value = ''; });
    $('uploadBtn').disabled = true;
    $('dropPreview').classList.add('hidden');
    S.preview = null;
    setCover(null);
  }

  /** Starts a new upload, or picks up the unfinished one that belongs to this same file. Resolves to the upload state or null. */
  async function openUpload(file, meta) {
    var fp = fingerprint(file);
    var saved = loadResume()[fp];
    if (saved) {
      var st = await Vane.api('GET', '/api/video/uploads/' + saved);
      if (st.ok && st.data.video.status === 'uploading') {
        var done = {};
        st.data.uploadedParts.forEach(function (n) { done[n] = true; });
        return { file: file, fp: fp, videoId: saved, partSize: st.data.partSize, partCount: st.data.partCount, done: done, loaded: {}, xhrs: [], cancelled: false, resumed: true };
      }
      forget(fp);                                // it finished, expired or was cancelled elsewhere
    }
    var body = { size: file.size, contentType: /\.mov$/i.test(file.name) ? 'video/quicktime' : 'video/mp4', fileName: file.name };
    if (meta.title) body.title = meta.title;
    if (meta.description) body.description = meta.description;
    if (meta.tags.length) body.tags = meta.tags;
    var r = await Vane.api('POST', '/api/video/uploads', body);
    if (!r.ok) { Vane.toast('err', r.error); return null; }
    var map = loadResume(); map[fp] = r.data.videoId; saveResume(map);
    return { file: file, fp: fp, videoId: r.data.videoId, partSize: r.data.partSize, partCount: r.data.partCount, done: {}, loaded: {}, xhrs: [], cancelled: false, resumed: false };
  }

  async function startUpload() {
    if (!S.file || S.up) return;
    var meta = { title: $('upTitle').value.trim(), description: $('upDesc').value.trim(), tags: parseTags($('upTags').value) };
    var previewPromise = S.preview, coverFile = S.cover;
    setBusy(true);
    $('progressLabel').textContent = 'Preparing…';
    var U = await openUpload(S.file, meta);
    if (!U) { setBusy(false); return; }
    S.up = U;
    $('progressLabel').textContent = U.resumed ? 'Resuming…' : 'Uploading…';
    showProgress();

    var queue = [];
    for (var n = 1; n <= U.partCount; n++) if (!U.done[n]) queue.push(n);
    var failure = null;
    var worker = async function () {
      while (queue.length && !failure && !U.cancelled) {
        var r = await sendPart(U, queue.shift());
        if (!r.ok && !r.aborted) failure = r;
      }
    };
    var workers = [];
    for (var i = 0; i < PARALLEL; i++) workers.push(worker());
    await Promise.all(workers);

    if (U.cancelled) return;                     // cancelUpload() has already cleaned up
    if (failure) return endUpload(U, failure);

    $('progressLabel').textContent = 'Finishing…';
    var c = await Vane.api('POST', '/api/video/uploads/' + U.videoId + '/complete', {});
    if (!c.ok) return endUpload(U, { status: c.status, code: c.data && c.data.code, error: c.error });

    if (U.resumed && (meta.title || meta.description || meta.tags.length)) {
      var patch = {};
      if (meta.title) patch.title = meta.title;
      if (meta.description) patch.description = meta.description;
      if (meta.tags.length) patch.tags = meta.tags;
      await Vane.api('PATCH', '/api/video/videos/' + U.videoId, patch);
    }
    forget(U.fp);
    S.up = null;
    setBusy(false);
    resetForm();
    Vane.toast('ok', 'Video uploaded');
    if (await sendFrames(U.videoId, U.file)) await sendPreview(U.videoId, previewPromise);   // a removed video has no preview to send
    if (coverFile) await sendCover(U.videoId, coverFile);
    await Promise.all([loadLibrary(), refreshOverview()]);
    offerAnnounce(U.videoId);
  }

  /** The upload stopped. A broken connection keeps the unfinished upload (choose the file again to continue); a server "no" ends it. */
  async function endUpload(U, failure) {
    var recoverable = !failure.status || failure.status >= 500 || failure.status === 408 || failure.status === 429;
    S.up = null;
    setBusy(false);
    if (recoverable) {
      Vane.toast('err', (failure.error || 'The upload was interrupted.') + ' Choose the same file again to continue.');
    } else {
      forget(U.fp);
      if (failure.code !== 'upload_expired' && failure.code !== 'invalid_video') await Vane.api('DELETE', '/api/video/uploads/' + U.videoId, undefined, { noRedirect: true });
      Vane.toast('err', failure.error);
    }
    await Promise.all([loadLibrary(), refreshOverview()]);
  }

  async function cancelUpload() {
    var U = S.up;
    if (!U) return;
    U.cancelled = true;
    U.xhrs.slice().forEach(function (x) { try { x.abort(); } catch (e) { /* already done */ } });
    S.up = null;
    forget(U.fp);
    await Vane.api('DELETE', '/api/video/uploads/' + U.videoId, undefined, { noRedirect: true });
    setBusy(false);
    Vane.toast('info', 'Upload cancelled');
    await Promise.all([loadLibrary(), refreshOverview()]);
  }

  $('uploadBtn').addEventListener('click', startUpload);
  $('cancelBtn').addEventListener('click', cancelUpload);
  window.addEventListener('beforeunload', function (e) { if (S.up) { e.preventDefault(); e.returnValue = ''; } });

  // ───────────────────────── API access (same section as in Vane Post: see assets/apikeys.js) ─────────────────────────
  /** The quota card: your plan and how full the library is (the posting side shows posts used here). */
  function renderApiQuota(box) {
    var used = S.usage.videos, limit = S.limits.maxVideos;
    var pct = limit ? Math.min(100, Math.round(used / limit * 100)) : 100;
    var html =
      '<div class="flex items-start justify-between gap-3">' +
        '<div><div class="text-xs font-medium uppercase tracking-widest text-white/40">Your plan</div>' +
        '<div class="mt-1 text-base font-semibold">Vane Studio</div></div>' +
        '<a href="' + esc(Vane.siteHome()) + '#pricing" class="shrink-0 text-xs text-white/45 underline underline-offset-4 transition-colors hover:text-white">Compare plans</a>' +
      '</div>';

    if (!S.active) {
      html += '<div class="mt-5 rounded-xl border border-amber-300/20 bg-amber-400/10 p-3.5 text-sm leading-relaxed text-amber-200">' +
        (S.lapsed ? 'Your Vane Studio subscription has ended. Renew it to upload again and use live keys. Test keys work today.'
                  : 'Vane Studio is not active on your account yet. Uploads and live keys need it. Test keys work today.') + '</div>';
    } else {
      html +=
        '<div class="mt-5">' +
          '<div class="text-xs text-white/45">Videos in your library</div>' +
          '<div class="mt-1.5 flex items-end justify-between gap-3">' +
            '<div><span class="pixel text-3xl tracking-tight">' + used + '</span><span class="ml-1.5 text-sm text-white/45">/ ' + limit + '</span></div>' +
            '<span class="text-xs text-white/45">' + Math.max(limit - used, 0) + ' left</span>' +
          '</div>' +
          '<div class="meter mt-3" role="progressbar" aria-label="Videos stored" aria-valuemin="0" aria-valuemax="' + limit + '" aria-valuenow="' + used + '"><i style="width:' + pct + '%;background:' + VaneKeys.meterColor(pct) + '"></i></div>' +
          '<p class="mt-3 text-xs leading-relaxed text-white/45">Dashboard and API uploads share these ' + limit + ' slots. Delete a video to free one.</p>' +
        '</div>' +
        '<p class="mt-4 border-t border-white/10 pt-4 text-xs leading-relaxed text-white/45">Each key can make up to 10 requests a minute. A full library answers with a 409 until you delete a video.</p>';
    }
    box.innerHTML = html;
    var buy = async function () {
      var r = await Vane.api('GET', '/api/billing/plan?id=video');
      if (!r.ok || !r.data.plan || !r.data.plan.buyable || !box.isConnected) return;
      var a = document.createElement('a');
      a.className = 'btn btn-white mt-4 inline-flex';
      a.href = (/^studio\.vaneapp\.dev$/i.test(location.hostname) ? 'https://vaneapp.dev' : '') + '/checkout?plan=video';
      a.textContent = S.active || S.lapsed ? 'Renew Vane Studio' : 'Get Vane Studio';
      if (!S.active || (S.endsAt && S.endsAt - Date.now() / 1000 < 7 * 86400)) box.appendChild(a);
    };
    buy();
    // Vane Suite = Studio + Vane Post Pro in one payment.
    (async function () {
      var r = await Vane.api('GET', '/api/billing/plan?id=suite');
      if (!r.ok || !r.data.plan || !r.data.plan.buyable || !box.isConnected || box.querySelector('[data-suite]')) return;
      var a = document.createElement('a');
      a.setAttribute('data-suite', '1');
      a.className = 'btn mt-3 inline-flex';
      a.href = (/^studio\.vaneapp\.dev$/i.test(location.hostname) ? 'https://vaneapp.dev' : '') + '/checkout?plan=suite';
      a.textContent = 'Or get Vane Suite: video + posting';
      box.appendChild(a);
    })();
  }

  /** Quick start: base URL, your videos' ids and a ready-made request (never contains a real key). Returns the request text. */
  function renderApiQuick(body) {
    var base = location.origin + '/api/v1/video';
    var snippet =
      'curl -X POST ' + base + '/uploads \\\n' +
      '  -H "Authorization: Bearer $VANE_VIDEO_KEY" \\\n' +
      '  -H "Content-Type: application/json" \\\n' +
      '  -d \'{"size":52428800,"contentType":"video/mp4","fileName":"trip.mp4"}\'';

    var ready = S.videos.filter(function (v) { return v.status === 'ready'; }).slice(0, 5);
    var ids = ready.length
      ? ready.map(function (v) {
          return '<div class="flex items-center gap-3 rounded-xl bg-white/[0.04] px-3 py-2 ring-1 ring-white/5">' +
            '<div class="min-w-0 flex-1"><div class="truncate text-sm">' + esc(v.title) + '</div>' +
            '<div class="truncate font-mono text-[11px] text-white/45">' + esc(v.id) + '</div></div>' +
            '<button type="button" data-copy="' + esc(v.id) + '" data-label="Video ID" class="btn btn-ghost btn-sm shrink-0">Copy</button></div>';
        }).join('')
      : '<p class="text-xs text-white/45">Upload a video to get its ID.</p>';

    body.innerHTML =
      '<div><span class="mb-2 block text-[0.7rem] font-medium uppercase tracking-widest text-white/40">Base URL</span>' +
        '<div class="flex items-center gap-2.5"><code class="field min-w-0 flex-1 truncate font-mono !text-[13px]">' + esc(base) + '</code>' +
        '<button type="button" data-copy="' + esc(base) + '" data-label="URL" class="btn btn-ghost btn-sm shrink-0">Copy</button></div></div>' +
      '<div><span class="mb-2 block text-[0.7rem] font-medium uppercase tracking-widest text-white/40">Video IDs <span class="normal-case tracking-normal text-white/30">(use them in /videos/&lt;id&gt;)</span></span><div class="space-y-2">' + ids + '</div></div>' +
      '<div><div class="flex items-center justify-between"><span class="block text-[0.7rem] font-medium uppercase tracking-widest text-white/40">Example request: start an upload</span>' +
        '<button type="button" data-copy-snippet class="text-xs text-white/45 transition-colors hover:text-white">Copy</button></div>' +
        '<pre class="no-scrollbar mt-2 overflow-x-auto rounded-2xl bg-black/35 p-4 font-mono text-[12px] leading-relaxed text-white/80 ring-1 ring-white/10"><code id="apiSnippet"></code></pre></div>' +
      '<p class="text-xs leading-relaxed text-white/45">The answer carries a <code class="rounded bg-white/10 px-1.5 py-0.5">videoId</code>, a <code class="rounded bg-white/10 px-1.5 py-0.5">partSize</code> and a <code class="rounded bg-white/10 px-1.5 py-0.5">partCount</code>. ' +
        'Send each chunk with <code class="rounded bg-white/10 px-1.5 py-0.5">PUT ' + esc(base) + '/uploads/&lt;videoId&gt;/parts/&lt;n&gt;</code> (the raw bytes; every chunk but the last is exactly partSize), then <code class="rounded bg-white/10 px-1.5 py-0.5">POST …/complete</code>. ' +
        'In Make, add an <b class="font-semibold text-white/70">HTTP → Make a request</b> module and add the header <code class="rounded bg-white/10 px-1.5 py-0.5">Authorization: Bearer your-key</code>.</p>';
    document.getElementById('apiSnippet').textContent = snippet;   // textContent: nothing from the server is ever parsed as HTML
    return snippet;
  }

  Keys = VaneKeys.mount({
    scope: 'video',
    emptyText: 'Create a key to connect Make, Zapier or your own scripts.',
    liveNote: 'Live keys need Vane Studio, which is not active on your account yet. A test key is perfect while you build.',
    liveAllowed: function () { return S.active; },
    load: refreshOverview,
    renderQuota: renderApiQuota,
    renderQuick: renderApiQuick
  });

  // ───────────────────────── sign out ─────────────────────────
  $('logoutBtn').addEventListener('click', async function () {
    this.disabled = true;
    await Vane.api('POST', '/api/auth/logout', {}, { noRedirect: true });
    Vane.go('/login');
  });

  // ───────────────────────── boot ─────────────────────────
  (async function boot() {
    var me = await Vane.api('GET', '/api/auth/me');
    if (!me.ok) return;                          // a 401 has already sent the visitor to the sign-in page
    S.user = me.data.user;
    $('userEmail').textContent = S.user.email;
    $('avatar').textContent = (S.user.name || S.user.email).charAt(0).toUpperCase();
    await Promise.all([loadLibrary(), Keys.refresh(), loadChannels(), loadPublications()]);
    $('app').classList.remove('opacity-0');
  })();
})();
