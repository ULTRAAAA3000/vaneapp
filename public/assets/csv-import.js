(function () {
  'use strict';
  var MAX_ROWS = 200, MAX_TEXT = 10000, HORIZON = 366 * 86400000;
  var ALIAS = {
    text: ['text', 'content', 'post', 'message', 'caption'],
    date: ['date', 'when', 'datetime', 'time', 'scheduled', 'scheduledat', 'schedule'],
    networks: ['networks', 'network', 'channels', 'channel', 'platforms', 'platform'],
    image: ['image', 'imageurl', 'media', 'mediaurl', 'photo']
  };

  function parse(src) {
    var text = String(src || '').replace(/^﻿/, '');
    var first = text.split(/\r?\n/)[0] || '';
    var delim = [',', ';', '\t'].map(function (d) { return [d, first.split(d).length]; }).sort(function (a, b) { return b[1] - a[1]; })[0][0];
    var rows = [], row = [], cell = '', quoted = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (quoted) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
        else cell += ch;
      } else if (ch === '"' && cell === '') quoted = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.some(function (c) { return c.trim() !== ''; })) rows.push(row);
        row = [];
      } else cell += ch;
    }
    row.push(cell);
    if (row.some(function (c) { return c.trim() !== ''; })) rows.push(row);
    return rows;
  }

  function columns(head) {
    var map = {};
    head.forEach(function (h, i) {
      var k = String(h).toLowerCase().replace(/[^a-z]/g, '');
      Object.keys(ALIAS).forEach(function (name) { if (map[name] === undefined && ALIAS[name].indexOf(k) !== -1) map[name] = i; });
    });
    return map;
  }

  function build(y, mo, d, h, mi) {
    var dt = new Date(+y, +mo - 1, +d, +h, +mi);
    return dt.getFullYear() === +y && dt.getMonth() === +mo - 1 && dt.getDate() === +d && dt.getHours() === +h ? dt : null;
  }

  function parseDate(v) {
    var s = String(v || '').trim(), m;
    if (!s) return null;
    if ((m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(s))) return build(m[1], m[2], m[3], m[4], m[5]);
    if ((m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})[ T](\d{1,2}):(\d{2})$/.exec(s))) return build(m[3], m[2], m[1], m[4], m[5]);
    if (/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(s)) { var t = Date.parse(s); return isNaN(t) ? null : new Date(t); }
    return null;
  }

  var norm = function (s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ''); };

  function pickChannels(cell, channels) {
    var live = channels.filter(function (c) { return c.isActive !== false; });
    var names = String(cell || '').split(/[;|,]/).map(function (x) { return x.trim(); }).filter(Boolean);
    if (!names.length) return live.length ? { ids: live.map(function (c) { return c.id; }) } : { error: 'No channel is connected yet.' };
    var ids = [];
    for (var i = 0; i < names.length; i++) {
      var n = norm(names[i]);
      var hit = live.filter(function (c) { return norm(c.platform) === n || norm(c.name) === n; });
      if (!hit.length) return { error: 'No connected channel called “' + names[i] + '”.' };
      hit.forEach(function (c) { if (ids.indexOf(c.id) === -1) ids.push(c.id); });
    }
    return { ids: ids };
  }

  function check(table, channels, now) {
    if (table.length < 2) return { rows: [], cut: 0, error: 'The file needs a header row and at least one post.' };
    var col = columns(table[0]);
    if (col.text === undefined || col.date === undefined) return { rows: [], cut: 0, error: 'The first row must name the columns, at least “text” and “date”.' };
    var body = table.slice(1);
    var rows = body.slice(0, MAX_ROWS).map(function (r, i) {
      var text = (r[col.text] || '').trim(), when = parseDate(r[col.date]);
      var out = { line: i + 2, text: text, when: when, ids: [], image: col.image !== undefined ? (r[col.image] || '').trim() : '', error: '' };
      if (!text) out.error = 'The text is empty.';
      else if (text.length > MAX_TEXT) out.error = 'The text is longer than ' + MAX_TEXT + ' characters.';
      else if (!when) out.error = 'Could not read the date. Use 2026-11-20 09:30.';
      else if (when.getTime() < now + 60000) out.error = 'The date is in the past.';
      else if (when.getTime() > now + HORIZON) out.error = 'The date is more than a year ahead.';
      else if (out.image && !/^https:\/\/\S+$/i.test(out.image)) out.error = 'The image must be an https link.';
      if (!out.error) {
        var c = pickChannels(col.networks !== undefined ? r[col.networks] : '', channels);
        if (c.error) out.error = c.error; else out.ids = c.ids;
      }
      return out;
    });
    return { rows: rows, cut: Math.max(0, body.length - MAX_ROWS), error: '' };
  }

  function template(now) {
    var d = function (days, hm) {
      var t = new Date(now + days * 86400000);
      return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0') + ' ' + hm;
    };
    return 'text,date,networks,image\r\n' +
      '"Launch day is here! Details on our site.",' + d(1, '09:30') + ',telegram; bluesky,\r\n' +
      '"One more tip for the week",' + d(2, '18:00') + ',,https://example.com/photo.jpg\r\n';
  }

  window.Vane = window.Vane || {};
  Vane.csvImport = { parse: parse, columns: columns, parseDate: parseDate, pickChannels: pickChannels, check: check, template: template };

  var dlg = document.getElementById('csvDialog');
  if (!dlg) return;
  var $ = function (id) { return document.getElementById(id); };
  var esc = Vane.esc;
  var S = { channels: [], rows: [], running: false };
  var fmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  function setState(name) {
    ['csvPick', 'csvReview'].forEach(function (id) { $(id).hidden = id !== name; });
  }
  function reset() {
    S.rows = []; $('csvFile').value = ''; $('csvError').classList.add('hidden'); setState('csvPick');
  }
  function showError(msg) { $('csvError').textContent = msg; $('csvError').classList.remove('hidden'); }

  function render() {
    var good = S.rows.filter(function (r) { return !r.error && !r.done; }).length;
    var bad = S.rows.filter(function (r) { return r.error; }).length;
    var sent = S.rows.filter(function (r) { return r.done; }).length;
    $('csvList').innerHTML = S.rows.map(function (r) {
      var tone = r.done ? 'bg-emerald-400' : r.error ? 'bg-red-400' : 'bg-white/30';
      return '<li class="flex gap-3 px-4 py-3"><span class="mt-1.5 h-2 w-2 shrink-0 rounded-full ' + tone + '"></span><div class="min-w-0 flex-1">' +
        '<p class="line-clamp-2 break-words text-sm text-white/90">' + esc(r.text || '(empty)') + '</p>' +
        '<p class="mt-1 text-xs text-white/45">' + (r.when ? esc(fmt.format(r.when)) : 'No date') + (r.ids.length ? ' · ' + r.ids.length + (r.ids.length === 1 ? ' channel' : ' channels') : '') + (r.image ? ' · image' : '') + ' · row ' + r.line + '</p>' +
        (r.error ? '<p class="mt-1 text-xs text-red-300">' + esc(r.error) + '</p>' : r.done ? '<p class="mt-1 text-xs text-emerald-300">Scheduled.</p>' : '') +
        '</div></li>';
    }).join('');
    $('csvSummary').textContent = sent ? sent + ' scheduled' + (bad + good ? ' · ' + (bad + good) + ' skipped' : '') : good + ' ready' + (bad ? ' · ' + bad + ' need fixing' : '');
    $('csvGo').disabled = S.running || !good;
    $('csvGoLabel').textContent = S.running ? 'Scheduling…' : good ? 'Schedule ' + good + (good === 1 ? ' post' : ' posts') : 'Nothing to schedule';
  }

  async function load(file) {
    $('csvError').classList.add('hidden');
    if (!file) return;
    if (file.size > 1024 * 1024) { showError('The file is larger than 1 MB.'); return; }
    var r = await Vane.api('GET', '/api/channels');
    if (!r.ok) { showError(r.error || 'Could not load your channels.'); return; }
    S.channels = r.data.channels;
    var res = check(parse(await file.text()), S.channels, Date.now());
    if (res.error) { showError(res.error); return; }
    S.rows = res.rows;
    $('csvCut').textContent = res.cut ? 'Only the first ' + MAX_ROWS + ' rows are used; ' + res.cut + ' more were left out.' : '';
    setState('csvReview'); render();
  }

  async function run() {
    if (S.running) return;
    S.running = true; render();
    var stop = '';
    for (var i = 0; i < S.rows.length && !stop; i++) {
      var row = S.rows[i];
      if (row.error || row.done) continue;
      var body = { content: row.text, channelIds: row.ids, scheduledAt: row.when.toISOString() };
      if (row.image) body.mediaUrl = row.image;
      var r = await Vane.api('POST', '/api/posts', body);
      if (r.ok) row.done = true;
      else { row.error = r.error || 'Could not schedule this post.'; if (r.status === 402 || r.status === 429) stop = r.error || 'Stopped: the limit is reached for now.'; }
      render();
    }
    S.running = false; render();
    var done = S.rows.filter(function (x) { return x.done; }).length;
    if (done) { document.dispatchEvent(new CustomEvent('vane:scheduled')); document.dispatchEvent(new Event('vane:posts-changed')); }
    if (stop) Vane.toast('err', stop); else if (done) Vane.toast('ok', done + (done === 1 ? ' post' : ' posts') + ' scheduled.');
  }

  $('csvBtn').addEventListener('click', function () { reset(); dlg.showModal(); });
  $('csvClose').addEventListener('click', function () { dlg.close(); });
  $('csvAgain').addEventListener('click', reset);
  $('csvFile').addEventListener('change', function () { load(this.files[0]); });
  $('csvGo').addEventListener('click', run);
  $('csvTemplate').addEventListener('click', function (e) {
    e.preventDefault();
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([template(Date.now())], { type: 'text/csv' }));
    a.download = 'vane-posts-template.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });
  var drop = $('csvDrop');
  ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('ring-2', 'ring-white/40'); }); });
  ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('ring-2', 'ring-white/40'); }); });
  drop.addEventListener('drop', function (e) { load(e.dataTransfer.files[0]); });
  dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
})();
