(function (wp, cfg) {
  var root = document.getElementById('vane-app');
  if (!root) return;
  var api = wp.apiFetch;
  var NAMES = { telegram: 'Telegram', bluesky: 'Bluesky', mastodon: 'Mastodon', threads: 'Threads', x: 'X', linkedin: 'LinkedIn', discord: 'Discord', devto: 'Dev.to', reddit: 'Reddit', pinterest: 'Pinterest', facebook: 'Facebook', webhook: 'Webhook' };
  var TABS = [['compose', 'Write'], ['queue', 'Scheduled'], ['history', 'History'], ['settings', 'Settings']];

  var S = {
    tab: new URLSearchParams(location.search).get('tab') || 'compose',
    status: null, channels: null, chosen: {}, text: '', image: '', when: 'now', at: '',
    notice: null, busy: false, posts: null, articles: null, requestId: uid()
  };

  function uid() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2); }
  function h(tag, attrs) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') el.className = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  function len(s) { return Array.from(s).length; }
  function name(p) { return NAMES[p] || p; }
  function when(sec) { return new Date(sec * 1000).toLocaleString(); }
  function fail(e) { return (e && e.message) || 'Something went wrong. Try again.'; }
  function note(kind, text) { S.notice = text ? { kind: kind, text: text } : null; }

  function load() {
    return api({ path: '/vane/v1/status' }).then(function (s) {
      S.status = s;
      if (!s.configured || s.error) return null;
      return api({ path: '/vane/v1/channels' }).then(function (c) {
        S.channels = c;
        if (!S.touched) { S.chosen = {}; (s.defaults || []).forEach(function (id) { S.chosen[id] = true; }); }
      }, function (e) { note('err', fail(e)); S.channels = []; });
    }, function (e) { S.status = { configured: false, fatal: fail(e) }; });
  }

  function go(tab, keep) {
    S.tab = tab; S.posts = null;
    if (!keep) note();
    try { history.replaceState(null, '', location.pathname + '?page=vane-for-wordpress&tab=' + tab); } catch (e) { /* not worth failing for */ }
    if (tab === 'queue' || tab === 'history') {
      api({ path: '/vane/v1/posts?view=' + (tab === 'queue' ? 'upcoming' : 'history') }).then(function (r) { S.posts = r.posts; draw(); }, function (e) { S.posts = []; note('err', fail(e)); draw(); });
    }
    draw();
  }

  function header() {
    var st = S.status, quota = st && st.usage && st.usage.api;
    return h('div', { class: 'vane-head' },
      h('h1', {}, 'Vane'),
      h('div', {},
        st && st.plan ? h('span', { class: 'vane-chip' }, String(st.plan).replace(/^./, function (c) { return c.toUpperCase(); }) + ' plan') : null,
        st && st.mode ? h('span', { class: 'vane-chip ' + st.mode }, st.mode === 'test' ? 'Test mode: nothing is posted' : 'Live') : null,
        quota ? h('span', { class: 'vane-chip' }, quota.remaining + ' of ' + quota.limit + ' posts left') : null,
        ' ', h('a', { href: cfg.dashboard, target: '_blank', rel: 'noopener' }, 'Open the full Vane app ↗')));
  }

  function tabs() {
    return h('nav', { class: 'nav-tab-wrapper' }, TABS.map(function (t) {
      return h('a', { href: '#', class: 'nav-tab' + (S.tab === t[0] ? ' nav-tab-active' : ''), onclick: function (e) { e.preventDefault(); go(t[0]); } }, t[1]);
    }));
  }

  function noticeEl() { return S.notice ? h('div', { class: 'vane-note ' + S.notice.kind }, S.notice.text) : null; }

  function connect() {
    var input = h('input', { type: 'password', class: 'regular-text', placeholder: 'cpost_live_…', autocomplete: 'off', id: 'vane-key' });
    var btn = h('button', { class: 'button button-primary', onclick: function () {
      btn.disabled = true;
      api({ path: '/vane/v1/settings', method: 'POST', data: { apiKey: input.value } }).then(function () { return load(); }).then(function () { note('ok', 'Connected.'); draw(); }, function (e) { note('err', fail(e)); draw(); });
    } }, 'Connect');
    var st = S.status || {};
    return h('div', { class: 'vane-card' },
      h('h2', {}, 'Connect your Vane account'),
      st.fatal || st.error ? h('div', { class: 'vane-note err' }, st.fatal || st.error) : null,
      h('ol', { class: 'vane-steps' },
        h('li', {}, 'Open ', h('a', { href: cfg.dashboard, target: '_blank', rel: 'noopener' }, 'Vane'), ', sign in (or create a free account) and connect your social channels.'),
        h('li', {}, 'Go to API keys and create a key. Start with a ', h('code', {}, 'cpost_test_…'), ' key: it tries everything and posts nothing.'),
        h('li', {}, 'Paste the key here.')),
      cfg.canManage ? h('div', { class: 'vane-row' }, input, btn) : h('p', {}, 'Ask a site administrator to connect Vane.'),
      h('p', { class: 'vane-meta' }, 'Step-by-step: ', h('a', { href: cfg.keysHelp, target: '_blank', rel: 'noopener' }, 'vaneapp.dev/wordpress')));
  }

  function counts() {
    var picked = (S.channels || []).filter(function (c) { return S.chosen[c.id]; });
    var n = len(S.text), over = false, seen = {}, parts = [];
    picked.forEach(function (c) {
      var limit = cfg.limits[c.platform];
      if (!limit || seen[c.platform]) return;
      seen[c.platform] = true;
      var bad = n > limit; over = over || bad;
      parts.push(h('span', { class: bad ? 'over' : '' }, name(c.platform) + ' ' + n + '/' + limit));
    });
    return { el: h('div', { class: 'vane-counts' }, h('span', {}, n + ' characters'), parts), over: over, picked: picked };
  }

  function compose() {
    if (!S.channels) return h('p', {}, 'Loading channels…');
    if (!S.channels.length) return h('div', { class: 'vane-card' }, h('p', {}, 'No channels are connected in Vane yet. Connect one in the Vane app, then come back.'), h('a', { class: 'button', href: cfg.dashboard, target: '_blank', rel: 'noopener' }, 'Open Vane'));
    var c = counts();
    var ta = h('textarea', { class: 'vane-text large-text', placeholder: 'What do you want to say?', oninput: function () { S.text = ta.value; refresh(); } });
    ta.value = S.text;
    var countsHost = h('div', {});
    var sendBtn = h('button', { class: 'button button-primary button-large' }, S.when === 'now' ? 'Post now' : 'Schedule');
    function refresh() {
      var k = counts();
      countsHost.replaceChildren(k.el);
      sendBtn.disabled = S.busy || !S.text.trim() || !k.picked.length || k.over || (S.when === 'later' && !S.at);
    }
    sendBtn.addEventListener('click', function () {
      S.busy = true; note(); refresh();
      var body = { content: S.text, channelIds: c.picked.map(function (x) { return x.id; }), mediaUrl: S.image || undefined, requestId: S.requestId };
      if (S.when === 'later') body.scheduledAt = new Date(S.at).toISOString();
      api({ path: '/vane/v1/posts', method: 'POST', data: body }).then(function (r) {
        S.busy = false; S.requestId = uid(); S.text = ''; S.image = '';
        note('ok', (r.test ? 'Test mode: nothing was saved or posted. ' : '') + 'Scheduled for ' + when(r.scheduledAt) + ' on ' + body.channelIds.length + (body.channelIds.length === 1 ? ' channel.' : ' channels.'));
        load().then(draw);
      }, function (e) { S.busy = false; note('err', fail(e)); draw(); });
    });

    var articleSel = h('select', { onchange: function () {
      var a = (S.articles || [])[Number(articleSel.value)];
      if (!a) return;
      S.text = (S.text ? S.text.replace(/\s+$/, '') + '\n\n' : '') + a.title + '\n\n' + a.link;
      draw();
    } }, h('option', { value: '' }, 'Insert a recent article…'), (S.articles || []).map(function (a, i) { return h('option', { value: String(i) }, a.title); }));
    if (!S.articles) api({ path: '/wp/v2/posts?per_page=10&_fields=title,link' }).then(function (r) {
      S.articles = r.map(function (p) { var t = document.createElement('textarea'); t.innerHTML = p.title.rendered; return { title: t.value, link: p.link }; });
      if (S.tab === 'compose') draw();
    }, function () { S.articles = []; });

    var pick = h('button', { class: 'button', onclick: function (e) {
      e.preventDefault();
      var frame = wp.media({ title: 'Choose an image', library: { type: 'image' }, multiple: false });
      frame.on('select', function () { var a = frame.state().get('selection').first().toJSON(); S.image = a.url; draw(); });
      frame.open();
    } }, S.image ? 'Change image' : 'Add image');

    var radio = function (value, label) { return h('label', {}, h('input', { type: 'radio', name: 'vane-when', checked: S.when === value, onchange: function () { S.when = value; draw(); } }), ' ' + label + '  '); };
    var dt = h('input', { type: 'datetime-local', onchange: function () { S.at = dt.value; refresh(); } });
    dt.value = S.at;

    var el = h('div', { class: 'vane-card' },
      h('h2', {}, 'Where to post'),
      h('div', { class: 'vane-channels' }, S.channels.map(function (ch) {
        return h('label', { class: S.chosen[ch.id] ? 'on' : '' }, h('input', { type: 'checkbox', checked: !!S.chosen[ch.id], onchange: function (e) { S.touched = true; S.chosen[ch.id] = e.target.checked; draw(); } }), ch.name + ' · ' + name(ch.platform));
      })),
      h('h2', { style: 'margin-top:16px' }, 'Your post'), ta, countsHost,
      h('div', { class: 'vane-row' }, articleSel, pick),
      S.image ? h('div', { class: 'vane-row' }, h('img', { class: 'vane-thumb', src: S.image, alt: '' }), h('button', { class: 'button-link', onclick: function (e) { e.preventDefault(); S.image = ''; draw(); } }, 'Remove image')) : null,
      S.image && S.image.indexOf('https://') !== 0 ? h('div', { class: 'vane-note warn' }, 'Networks need an https image address. This site serves it over http, so the image will be skipped.') : null,
      h('div', { class: 'vane-row' }, radio('now', 'In about a minute'), radio('later', 'Pick a time'), S.when === 'later' ? [dt, h('span', { class: 'vane-meta' }, 'your browser’s time')] : null),
      h('div', { class: 'vane-row' }, sendBtn));
    refresh();
    return el;
  }

  function groups(posts) {
    var order = [], map = {};
    posts.forEach(function (p) { if (!map[p.groupId]) { map[p.groupId] = []; order.push(p.groupId); } map[p.groupId].push(p); });
    return order.map(function (id) { return map[id]; });
  }

  function listView(kind) {
    if (!S.posts) return h('p', {}, 'Loading…');
    if (!S.posts.length) return h('div', { class: 'vane-card' }, h('p', {}, kind === 'queue' ? 'Nothing is scheduled.' : 'Nothing has been sent yet.'));
    return h('div', { class: 'vane-card' }, groups(S.posts).map(function (g) {
      var first = g[0];
      var cancellable = g.filter(function (p) { return p.status === 'scheduled'; });
      return h('div', { class: 'vane-item' },
        h('p', {}, first.content.length > 280 ? first.content.slice(0, 280) + '…' : first.content),
        first.mediaUrl ? h('p', { class: 'vane-meta' }, '🖼 with an image') : null,
        h('div', { class: 'vane-meta' }, when(first.scheduledAt)),
        h('div', { class: 'vane-meta' }, g.map(function (p) {
          return h('div', {}, h('span', { class: 'vane-badge ' + p.status }, p.status), p.channelName + ' · ' + name(p.platform),
            p.url ? [' ', h('a', { href: p.url, target: '_blank', rel: 'noopener' }, 'Open ↗')] : null,
            p.error ? h('div', { style: 'color:#b32d2e' }, p.error) : null);
        })),
        kind === 'queue' && cancellable.length ? h('p', {}, h('button', { class: 'button', onclick: function (e) {
          if (!confirm('Cancel this post?')) return;
          e.target.disabled = true;
          cancellable.reduce(function (chain, p) { return chain.then(function () { return api({ path: '/vane/v1/posts/' + p.id, method: 'DELETE' }); }); }, Promise.resolve())
            .then(function () { note('ok', 'Cancelled.'); go('queue', true); }, function (err) { note('err', fail(err)); go('queue', true); });
        } }, 'Cancel')) : null);
    }));
  }

  function settings() {
    var st = S.status, chosen = {};
    (st.defaults || []).forEach(function (id) { chosen[id] = true; });
    var key = h('input', { type: 'password', class: 'regular-text', placeholder: st.keyMasked || 'cpost_live_…', autocomplete: 'off' });
    var auto = h('input', { type: 'checkbox', checked: st.auto });
    var boxes = (S.channels || []).map(function (c) { return h('label', { style: 'display:block' }, h('input', { type: 'checkbox', checked: !!chosen[c.id], 'data-id': c.id }), ' ' + c.name + ' · ' + name(c.platform)); });
    var disabledAttr = cfg.canManage ? null : true;
    return h('div', { class: 'vane-card' },
      h('h2', {}, 'API key'),
      h('p', {}, st.keyMasked ? 'Saved: ' + st.keyMasked : 'No key saved.'),
      h('div', { class: 'vane-row' }, key, h('button', { class: 'button', disabled: disabledAttr, onclick: function () {
        if (!key.value.trim()) return;
        api({ path: '/vane/v1/settings', method: 'POST', data: { apiKey: key.value } }).then(function () { note('ok', 'Key saved.'); return load(); }).then(draw, function (e) { note('err', fail(e)); draw(); });
      } }, 'Replace key'), h('button', { class: 'button-link-delete', disabled: disabledAttr, onclick: function () {
        if (!confirm('Disconnect Vane from this site?')) return;
        api({ path: '/vane/v1/settings', method: 'POST', data: { apiKey: '' } }).then(function () { S.channels = null; return load(); }).then(draw);
      } }, 'Disconnect')),
      h('h2', { style: 'margin-top:18px' }, 'New articles'),
      h('label', {}, auto, ' Cross-post new articles when they are published (can be turned off per article in the editor)'),
      boxes.length ? [h('h2', { style: 'margin-top:18px' }, 'Default channels for articles'), boxes] : null,
      h('p', {}, h('button', { class: 'button button-primary', disabled: disabledAttr, onclick: function () {
        var ids = Array.prototype.slice.call(document.querySelectorAll('[data-id]')).filter(function (b) { return b.checked; }).map(function (b) { return b.getAttribute('data-id'); });
        api({ path: '/vane/v1/settings', method: 'POST', data: { auto: auto.checked, defaults: ids } }).then(function () { note('ok', 'Saved.'); S.touched = false; return load(); }).then(draw, function (e) { note('err', fail(e)); draw(); });
      } }, 'Save')));
  }

  function draw() {
    var st = S.status;
    var parts = [header()];
    if (!st) { parts.push(h('p', {}, 'Loading…')); }
    else if (!st.configured || st.error) { parts.push(noticeEl(), connect()); }
    else {
      parts.push(tabs(), noticeEl());
      parts.push(S.tab === 'queue' ? listView('queue') : S.tab === 'history' ? listView('history') : S.tab === 'settings' ? settings() : compose());
    }
    root.replaceChildren.apply(root, parts.filter(Boolean));
  }

  draw();
  load().then(function () { go(S.tab, true); });
})(window.wp, window.VANE_ADMIN);
