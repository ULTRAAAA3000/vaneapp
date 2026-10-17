/* Dashboard extras, computed in the browser from the post lists the dashboard already loads (no new API, no new tables):
 *   Vane.createTagAssist(textarea, bar)   hashtag memory: suggests the tags you used before while you type "#", like T9
 *   Vane.renderInsights(root, posts, opts)   the Insights card: sent per day, success rate, streak, top channel / hashtags
 * The pure helpers are on Vane.tags and Vane.insights so they can be tested without a page.
 */
(function () {
  'use strict';
  var Vane = window.Vane || (window.Vane = {});
  var esc = function (s) { return Vane.esc ? Vane.esc(s) : String(s); };

  // ───────────────────────── hashtags: pure helpers ─────────────────────────
  // A tag starts at a "#" that is not glued to a word, a URL path or an HTML entity; pure numbers (#1) are not tags.
  var TAG_SRC = '(^|[^\\p{L}\\p{N}_&#/])#([\\p{L}\\p{N}_]{LEN})';

  /** Tags in a text, as written, once each (case-insensitive), in order of appearance. */
  function extractTags(text) {
    var re = new RegExp(TAG_SRC.replace('{LEN}', '{1,60}'), 'gu'), seen = {}, out = [], m;
    var s = String(text || '');
    while ((m = re.exec(s))) {
      if (/^\d+$/.test(m[2])) continue;
      var k = m[2].toLowerCase();
      if (!seen[k]) { seen[k] = 1; out.push(m[2]); }
    }
    return out;
  }

  /**
   * Every tag in the user's posts, most used first (then most recent). A post sent to three channels counts once.
   * Shape: [{ key (lower case), tag (as last written), count, last (unix seconds of the latest post) }]
   */
  function buildIndex(posts) {
    var map = {}, done = {};
    (posts || []).forEach(function (p) {
      var gid = p.groupId || p.id;
      if (done[gid]) return;
      done[gid] = 1;
      var ts = p.scheduledAt || 0;
      extractTags(p.content).forEach(function (t) {
        var k = t.toLowerCase();
        var e = map[k] || (map[k] = { key: k, tag: t, count: 0, last: -1 });
        e.count++;
        if (ts >= e.last) { e.last = ts; e.tag = t; }
      });
    });
    return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) {
      return b.count - a.count || b.last - a.last || (a.key < b.key ? -1 : 1);
    });
  }

  /** Tags that start with `prefix` (all of them when it is empty), skipping `skip` (a { key: 1 } set) and an exact match. */
  function suggest(index, prefix, skip, limit) {
    var p = String(prefix || '').toLowerCase(), out = [];
    for (var i = 0; i < index.length && out.length < limit; i++) {
      var e = index[i];
      if (skip && skip[e.key]) continue;
      if (p && (e.key.indexOf(p) !== 0 || e.key === p)) continue;
      out.push(e);
    }
    return out;
  }

  /** The "#word" the caret is inside / right after: { start (index of the #), prefix } or null. */
  function tokenAt(value, caret) {
    var m = new RegExp(TAG_SRC.replace('{LEN}', '{0,60}') + '$', 'u').exec(String(value || '').slice(0, caret));
    return m ? { start: m.index + m[1].length, prefix: m[2] } : null;
  }

  Vane.tags = { extract: extractTags, buildIndex: buildIndex, suggest: suggest, tokenAt: tokenAt };

  // ───────────────────────── hashtags: the suggestion bar under the composer ─────────────────────────
  /**
   * While the caret sits in a "#word" the bar offers matching tags from past posts (Tab inserts the highlighted one, ↑ ↓ choose,
   * Esc closes, a tap on a chip inserts it). Otherwise it shows your most used tags for one-tap insertion.
   * Returns { setPosts(list), insert(tag) }.
   */
  Vane.createTagAssist = function (ta, bar) {
    var idx = [], list = [], mode = 'top', sel = 0, dismissed = false;

    function draftSkip() {
      var skip = {};
      extractTags(ta.value).forEach(function (t) { skip[t.toLowerCase()] = 1; });
      return skip;
    }

    function paint() {
      var chips = list.map(function (e, i) {
        return '<button type="button" class="chip tag-chip' + (mode === 'suggest' && i === sel ? ' is-active' : '') + '" data-i="' + i + '">' +
          '#' + esc(e.tag) + (e.count > 1 ? '<small>×' + e.count + '</small>' : '') + '</button>';
      }).join('');
      bar.innerHTML =
        '<div class="mb-2 flex items-center justify-between gap-3">' +
          '<span class="lbl !mb-0">' + (mode === 'suggest' ? 'From your posts' : 'Your hashtags') + '</span>' +
          (mode === 'suggest' ? '<span class="hidden text-[11px] text-white/35 sm:inline"><kbd class="key">Tab</kbd> to insert · <kbd class="key">Esc</kbd> to close</span>' : '') +
        '</div><div class="flex flex-wrap gap-2">' + chips + '</div>';
    }

    function render() {
      var focused = document.activeElement === ta && ta.selectionStart === ta.selectionEnd;
      var tok = focused ? tokenAt(ta.value, ta.selectionStart) : null;
      var skip = draftSkip();
      if (tok && !dismissed) { mode = 'suggest'; list = suggest(idx, tok.prefix, skip, 6); }
      else { mode = 'top'; list = suggest(idx, '', skip, 8); }
      if (sel >= list.length) sel = 0;
      if (!list.length) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
      bar.classList.remove('hidden');
      paint();
    }

    function accept(e, forceTop) {
      var v = ta.value, caret = ta.selectionStart, focused = document.activeElement === ta;
      var tok = !forceTop && mode === 'suggest' && focused ? tokenAt(v, caret) : null;
      var head, add, after;
      if (tok) { // finish the word being typed
        head = v.slice(0, tok.start); after = v.slice(caret);
        add = '#' + e.tag + (/^\s/.test(after) ? '' : ' ');
      } else {   // drop the tag at the caret (or at the end when the box is not focused)
        var pos = focused ? caret : v.length;
        head = v.slice(0, pos); after = v.slice(pos);
        add = (head && !/\s$/.test(head) ? ' ' : '') + '#' + e.tag + (/^\s/.test(after) ? '' : ' ');
      }
      ta.value = head + add + after;
      var at = head.length + add.length;
      ta.focus();
      ta.setSelectionRange(at, at);
      dismissed = false;
      ta.dispatchEvent(new Event('input', { bubbles: true })); // the counter and the preview follow
    }

    ta.addEventListener('input', function () { dismissed = false; sel = 0; render(); });
    ['keyup', 'click', 'focus'].forEach(function (ev) { ta.addEventListener(ev, render); });
    ta.addEventListener('blur', function () { setTimeout(render, 0); });
    ta.addEventListener('keydown', function (e) {
      if (e.isComposing || mode !== 'suggest' || !list.length || bar.classList.contains('hidden')) return;
      var plain = !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
      if (e.key === 'Tab' && plain) { e.preventDefault(); accept(list[sel]); }
      else if (e.key === 'ArrowDown' && plain) { e.preventDefault(); sel = (sel + 1) % list.length; paint(); }
      else if (e.key === 'ArrowUp' && plain) { e.preventDefault(); sel = (sel - 1 + list.length) % list.length; paint(); }
      else if (e.key === 'Escape') { dismissed = true; render(); }
    });
    // mousedown: keep the focus (and the caret) in the text box while a chip is pressed
    bar.addEventListener('mousedown', function (e) { if (e.target.closest('.tag-chip')) e.preventDefault(); });
    bar.addEventListener('click', function (e) {
      var b = e.target.closest('.tag-chip');
      if (b && list[Number(b.getAttribute('data-i'))]) accept(list[Number(b.getAttribute('data-i'))]);
    });

    return {
      setPosts: function (posts) { idx = buildIndex(posts); render(); },
      insert: function (tag) { accept({ tag: tag }, true); }
    };
  };

  // ───────────────────────── insights: pure helpers ─────────────────────────
  var dayKey = function (d) { return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); };
  var stamp = function (p) { return (p.sentAt || p.scheduledAt) * 1000; };

  /**
   * Numbers for the card, from the history list (sent / failed / cancelled) and the upcoming list.
   * `days` is the length of the chart; every figure counts deliveries (a post to 3 channels is 3), like the status badges do.
   */
  function compute(history, upcoming, now, days) {
    history = history || []; upcoming = upcoming || [];
    var today = new Date(now); today.setHours(0, 0, 0, 0);
    var sent = history.filter(function (p) { return p.status === 'sent'; });
    var failed = history.filter(function (p) { return p.status === 'failed'; });

    var cols = [], byKey = {};
    for (var i = days - 1; i >= 0; i--) {
      var d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i); // calendar-day steps, so a DST change can't shift a bar
      var col = { key: dayKey(d), date: d, sent: 0, failed: 0, today: i === 0 };
      cols.push(col); byKey[col.key] = col;
    }
    sent.forEach(function (p) { var c = byKey[dayKey(new Date(stamp(p)))]; if (c) c.sent++; });
    failed.forEach(function (p) { var c = byKey[dayKey(new Date(stamp(p)))]; if (c) c.failed++; });

    var settled = sent.length + failed.length;

    // active days in a row (today may still be empty: the streak then runs up to yesterday)
    var sentDays = {};
    sent.forEach(function (p) { sentDays[dayKey(new Date(stamp(p)))] = 1; });
    var streak = 0, cur = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (!sentDays[dayKey(cur)]) cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() - 1);
    while (sentDays[dayKey(cur)]) { streak++; cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() - 1); }

    var perChannel = {};
    sent.forEach(function (p) {
      var c = perChannel[p.channelId] || (perChannel[p.channelId] = { name: p.channelName, platform: p.platform, n: 0 });
      c.n++;
    });
    var topChannel = null;
    Object.keys(perChannel).forEach(function (k) { if (!topChannel || perChannel[k].n > topChannel.n) topChannel = perChannel[k]; });

    var hours = [], hour = null;
    for (var h = 0; h < 24; h++) hours.push(0);
    sent.forEach(function (p) { hours[new Date(stamp(p)).getHours()]++; });
    if (sent.length >= 3) {
      hour = 0;
      for (var j = 1; j < 24; j++) if (hours[j] > hours[hour]) hour = j;
    }

    return {
      total: history.length,
      sent: sent.length, failed: failed.length,
      rate: settled ? Math.round(sent.length / settled * 100) : null,
      cols: cols, streak: streak, topChannel: topChannel, hour: hour,
      tags: buildIndex(history.concat(upcoming)).slice(0, 6)
    };
  }

  Vane.insights = { compute: compute };

  // ───────────────────────── insights: the card ─────────────────────────
  var fmtDay = typeof Intl !== 'undefined' ? new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : null;
  var fmtWd = typeof Intl !== 'undefined' ? new Intl.DateTimeFormat(undefined, { weekday: 'narrow' }) : null;
  var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
  var CHART_PX = 96;

  /**
   * Fills `root` with the card body.
   * opts: { limit (the list size the server caps at, to say "latest N posts"), netIcon(platform, cls), onTag(tag) }
   */
  Vane.renderInsights = function (root, history, upcoming, opts) {
    opts = opts || {};
    var d = compute(history, upcoming, Date.now(), 14);

    if (!d.total) {
      root.innerHTML =
        '<div class="rounded-2xl border border-dashed border-white/10 px-5 py-10 text-center">' +
          '<p class="text-sm font-medium">Nothing to measure yet</p>' +
          '<p class="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-white/45">Your numbers appear here after the first posts go out.</p>' +
        '</div>';
      return;
    }

    var max = 1;
    d.cols.forEach(function (c) { max = Math.max(max, c.sent + c.failed); });
    var bars = d.cols.map(function (c) {
      var total = c.sent + c.failed, h = total ? Math.max(6, Math.round(total / max * CHART_PX)) : 3;
      var failedH = c.failed ? Math.max(3, Math.round(h * c.failed / total)) : 0;
      var title = fmtDay.format(c.date) + ': ' + (total ? c.sent + ' sent' + (c.failed ? ', ' + c.failed + ' failed' : '') : 'no posts');
      return '<div class="flex min-w-0 flex-1 flex-col items-center gap-1.5" title="' + esc(title) + '">' +
        '<div class="flex w-full items-end justify-center" style="height:' + CHART_PX + 'px">' +
          '<div class="flex w-full max-w-[1.4rem] flex-col justify-end overflow-hidden rounded-md ' + (total ? '' : 'bg-white/[0.08]') + '" style="height:' + h + 'px">' +
            (failedH ? '<div class="bg-red-300/70" style="height:' + failedH + 'px"></div>' : '') +
            (c.sent ? '<div class="flex-1 ' + (c.today ? 'bg-white' : 'bg-white/70') + '"></div>' : '') +
          '</div>' +
        '</div>' +
        '<span class="text-[10px] ' + (c.today ? 'font-semibold text-white' : 'text-white/35') + '">' + esc(fmtWd.format(c.date)) + '</span>' +
      '</div>';
    }).join('');

    var tile = function (value, label, cls) {
      return '<div class="rounded-2xl bg-white/[0.04] p-4 ring-1 ring-white/5">' +
        '<div class="' + (cls || 'pixel text-2xl tracking-tight') + '">' + value + '</div>' +
        '<div class="mt-1.5 text-xs text-white/45">' + label + '</div></div>';
    };
    var top = d.topChannel
      ? '<div class="flex items-center gap-2 text-base font-semibold leading-tight">' + (opts.netIcon ? opts.netIcon(d.topChannel.platform, 'h-4 w-4 shrink-0 text-white/60') : '') +
        '<span class="truncate">' + esc(d.topChannel.name) + '</span></div>'
      : '<span class="pixel text-2xl">—</span>';

    var tags = d.tags.length
      ? '<div class="mt-4"><span class="lbl">Top hashtags</span><div class="flex flex-wrap gap-2">' + d.tags.map(function (e) {
          return '<button type="button" class="chip tag-chip" data-tag="' + esc(e.tag) + '" title="Add to the post">#' + esc(e.tag) + '<small>×' + e.count + '</small></button>';
        }).join('') + '</div></div>'
      : '';

    root.innerHTML =
      '<div class="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">' +
        '<div class="rounded-2xl bg-white/[0.04] p-5 ring-1 ring-white/5">' +
          '<div class="flex items-center justify-between"><span class="lbl !mb-0">Sent per day</span><span class="text-xs text-white/35">Last 14 days</span></div>' +
          '<div class="mt-5 flex items-end gap-1.5">' + bars + '</div>' +
          (d.hour !== null ? '<p class="mt-4 text-xs text-white/45">Most of your posts go out around <b class="font-semibold text-white/80">' + pad(d.hour) + ':00</b>.</p>' : '') +
        '</div>' +
        '<div>' +
          '<div class="grid grid-cols-2 gap-3">' +
            tile(d.sent, 'Sent in total') +
            tile(d.rate === null ? '—' : d.rate + '%', 'Delivered without errors') +
            tile(d.streak, d.streak === 1 ? 'Day in a row' : 'Days in a row') +
            tile(top, 'Most used channel', 'min-w-0') +
          '</div>' +
          tags +
        '</div>' +
      '</div>' +
      (opts.limit && d.total >= opts.limit ? '<p class="mt-4 text-xs text-white/30">Based on your latest ' + opts.limit + ' finished posts.</p>' : '');

    var btns = root.querySelectorAll('[data-tag]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function () { if (opts.onTag) opts.onTag(this.getAttribute('data-tag')); });
    }
  };
})();
