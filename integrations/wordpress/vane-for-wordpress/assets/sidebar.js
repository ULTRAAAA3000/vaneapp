(function (wp, cfg) {
  var el = wp.element.createElement;
  var useState = wp.element.useState;
  var useEffect = wp.element.useEffect;
  var useSelect = wp.data.useSelect;
  var useDispatch = wp.data.useDispatch;
  var c = wp.components;
  var Panel = (wp.editor && wp.editor.PluginDocumentSettingPanel) || (wp.editPost && wp.editPost.PluginDocumentSettingPanel);
  if (!Panel || !wp.plugins) return;

  function len(s) { return Array.from(s).length; }
  function cut(s, n) {
    if (len(s) <= n) return s;
    return Array.from(s).slice(0, Math.max(0, n - 1)).join('').replace(/\s+$/, '') + '…';
  }
  // Same rule as vane_wp_compose() in includes/share.php
  function compose(title, excerpt, url, limit) {
    var tail = '\n\n' + url;
    title = cut(title.trim(), Math.max(10, limit - len(tail)));
    var room = limit - len(title + tail) - 2;
    var body = title;
    if (excerpt && room >= 20) body += '\n\n' + cut(excerpt.trim(), room);
    return body + tail;
  }
  function plain(html) {
    var d = document.createElement('div');
    d.innerHTML = html || '';
    return (d.textContent || '').replace(/\s+/g, ' ').trim();
  }
  function parse(json) { try { var v = JSON.parse(json); return Array.isArray(v) ? v : null; } catch (e) { return null; } }

  function VanePanel() {
    var st = useState(null), channels = st[0], setChannels = st[1];
    var er = useState(''), loadError = er[0], setLoadError = er[1];
    var bs = useState(false), busy = bs[0], setBusy = bs[1];
    var ms = useState(''), msg = ms[0], setMsg = ms[1];
    var sd = useState(''), sent = sd[0], setSent = sd[1];

    var post = useSelect(function (select) {
      var ed = select('core/editor');
      var meta = ed.getEditedPostAttribute('meta') || {};
      return {
        id: ed.getCurrentPostId(),
        title: ed.getEditedPostAttribute('title') || '',
        excerpt: ed.getEditedPostAttribute('excerpt') || '',
        content: ed.getEditedPostAttribute('content') || '',
        link: ed.getPermalink() || '',
        status: ed.getCurrentPostAttribute('status'),
        meta: meta,
      };
    }, []);
    var editPost = useDispatch('core/editor').editPost;
    var setMeta = function (patch) { editPost({ meta: patch }); };

    useEffect(function () {
      if (!cfg.configured) return;
      wp.apiFetch({ path: '/vane/v1/channels' }).then(setChannels, function (e) { setLoadError(e.message || 'Could not load channels'); });
    }, []);

    if (!cfg.configured) {
      return el(Panel, { name: 'vane', title: 'Vane Cross-Post' },
        el('p', null, 'Add your Vane API key to start cross-posting.'),
        el('a', { href: cfg.settingsUrl }, 'Open Vane settings'));
    }
    if (loadError) return el(Panel, { name: 'vane', title: 'Vane Cross-Post' }, el(c.Notice, { status: 'error', isDismissible: false }, loadError));
    if (!channels) return el(Panel, { name: 'vane', title: 'Vane Cross-Post' }, el(c.Spinner));

    var meta = post.meta;
    var enabled = meta._vane_enabled === undefined || meta._vane_enabled === null || meta._vane_enabled === ''
      ? cfg.auto
      : !!meta._vane_enabled;
    var selected = parse(meta._vane_channels || '') || cfg.defaults;
    var posted = meta._vane_posted || sent;
    var failed = meta._vane_error;
    var published = post.status === 'publish';

    var chosen = channels.filter(function (ch) { return selected.indexOf(ch.id) !== -1; });
    var limit = chosen.reduce(function (m, ch) { return Math.min(m, cfg.limits[ch.platform] || 4096); }, 4096);
    var url = post.link || 'https://your-site.example/article';
    var auto = compose(plain(post.title), plain(post.excerpt) || plain(post.content).slice(0, 400), url, limit);
    var custom = (meta._vane_text || '').trim() !== '';
    var shown = custom ? meta._vane_text.split('{url}').join(url) : auto;

    function toggle(id, on) {
      var next = selected.filter(function (x) { return x !== id; });
      if (on) next.push(id);
      setMeta({ _vane_channels: JSON.stringify(next) });
    }
    function sendNow() {
      setBusy(true); setMsg('');
      wp.apiFetch({ path: '/vane/v1/share', method: 'POST', data: { post_id: post.id } }).then(function (r) {
        setSent(r.groupId); setBusy(false);
      }, function (e) { setMsg(e.message || 'Failed'); setBusy(false); });
    }

    var kids = [];
    if (posted) {
      kids.push(el(c.Notice, { key: 'ok', status: 'success', isDismissible: false }, 'Sent to Vane (' + posted + ').'));
    } else {
      kids.push(el(c.ToggleControl, {
        key: 'on', label: 'Cross-post when published', checked: enabled,
        onChange: function (v) { setMeta({ _vane_enabled: v }); },
      }));
      if (!channels.length) {
        kids.push(el('p', { key: 'none' }, 'No channels connected yet. Connect one in the Vane dashboard.'));
      }
      channels.forEach(function (ch) {
        kids.push(el(c.CheckboxControl, {
          key: ch.id, label: ch.name + ' (' + ch.platform + ')',
          checked: selected.indexOf(ch.id) !== -1,
          onChange: function (v) { toggle(ch.id, v); },
        }));
      });
      kids.push(el(c.TextareaControl, {
        key: 'text', label: 'Post text', rows: 7, value: shown,
        help: custom ? '{url} is replaced by the article link.' : 'Made automatically from the title, excerpt and link. Edit to change it.',
        onChange: function (v) { setMeta({ _vane_text: v.split(url).join('{url}') }); },
      }));
      if (custom) {
        kids.push(el(c.Button, { key: 'reset', variant: 'link', onClick: function () { setMeta({ _vane_text: '' }); } }, 'Back to automatic text'));
      }
      chosen.forEach(function (ch) {
        var lim = cfg.limits[ch.platform] || 4096;
        var n = len(shown);
        kids.push(el('p', { key: 'n' + ch.id, style: { margin: '4px 0', color: n > lim ? '#b32d2e' : '#50575e' } }, ch.platform + ': ' + n + ' / ' + lim));
      });
      if (failed) kids.push(el(c.Notice, { key: 'err', status: 'error', isDismissible: false }, failed));
      if (published) {
        kids.push(el(c.Button, { key: 'send', variant: 'primary', isBusy: busy, disabled: busy || !chosen.length, onClick: sendNow }, 'Send now'));
      }
      if (msg) kids.push(el('p', { key: 'msg' }, msg));
    }
    return el.apply(null, [Panel, { name: 'vane', title: 'Vane Cross-Post' }].concat(kids));
  }

  wp.plugins.registerPlugin('vane-cross-post', { render: VanePanel });
})(window.wp, window.VANE_WP);
