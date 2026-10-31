/* "Agents" tab: a live terminal with what your AI assistants and integrations do with your Vane account
   (Claude / Notion tool calls over MCP, Make, Zapier, WordPress, Obsidian, scripts…).
   Lines come from GET /api/agent-log (functions/api/lib/agentlog.ts): metadata only, never the text of a post.
   The tab polls every few seconds while it is open and the page is visible; new lines are typed out. */
(function () {
  'use strict';

  var root = document.getElementById('viewAgents');
  if (!root) return;
  var body = document.getElementById('agentTerm'), status = document.getElementById('agentStatus'), dot = document.getElementById('agentDot'),
      pauseBtn = document.getElementById('agentPause'), clearBtn = document.getElementById('agentClear'), jump = document.getElementById('agentJump'),
      chips = document.getElementById('agentChips'), demoBtn = document.getElementById('agentDemo'), demoNote = document.getElementById('agentDemoNote'), demoExit = document.getElementById('agentDemoExit');

  var POLL_MS = 3000, FIRST = 80, KEEP = 300, TYPE_MS = 11, TYPE_MAX_MS = 900, QUEUE_LIMIT = 8;
  var NAMES = { claude: 'Claude', notion: 'Notion', obsidian: 'Obsidian', make: 'Make', zapier: 'Zapier', wordpress: 'WordPress', chatgpt: 'ChatGPT', api: 'API' };
  var COLORS = { claude: '#c4b5fd', notion: '#e5e7eb', obsidian: '#a78bfa', make: '#f0abfc', zapier: '#fdba74', wordpress: '#7dd3fc', chatgpt: '#6ee7b7', api: '#67e8f9' };

  var events = [], cursor = 0, filter = '', paused = false, loaded = false, stick = true, timer = 0, busy = false, lostShown = false;
  var typing = [], typingNow = false, demo = false, clearArmed = 0;

  function reduced() { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function tagOf(e) { return (NAMES[e.integration] || e.integration) + (e.via === 'mcp' ? ' MCP' : ''); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function clock(at) { var d = new Date(at * 1000); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }

  /** One terminal line; the message goes in as TEXT, never as HTML. */
  function lineEl(e) {
    var li = document.createElement('span');
    li.className = 'term-line' + (e.ok ? '' : ' is-err') + (e.demo ? ' is-demo' : '');
    li.setAttribute('data-int', e.integration);
    var t = document.createElement('span'); t.className = 'term-time'; t.textContent = '[' + clock(e.at) + '] ';
    var g = document.createElement('span'); g.className = 'term-tag'; g.style.color = COLORS[e.integration] || '#67e8f9'; g.textContent = '[' + tagOf(e) + '] ';
    var m = document.createElement('span'); m.className = 'term-msg'; m.textContent = e.message;
    li.appendChild(t); li.appendChild(g); li.appendChild(m);
    return li;
  }
  function br() { return document.createElement('br'); }

  function atBottom() { return body.scrollHeight - body.scrollTop - body.clientHeight < 28; }
  function toBottom() { body.scrollTop = body.scrollHeight; jump.hidden = true; }
  function visible(e) { return !filter || e.integration === filter; }

  function cursorEl() { var c = document.createElement('span'); c.className = 'term-cursor'; c.id = 'agentCursor'; c.setAttribute('aria-hidden', 'true'); return c; }

  /** Redraws everything (first load, a filter change, clear). */
  function redraw() {
    body.textContent = '';
    var shown = events.filter(visible);
    if (!shown.length) {
      var s = document.createElement('span'); s.className = 'term-line term-sys';
      s.textContent = events.length ? '$ no lines for this filter yet' : (loaded ? '$ waiting for your assistants… ask Claude or Notion to list your channels' : '$ connecting…');
      body.appendChild(s); body.appendChild(br()); body.appendChild(cursorEl());
    } else {
      shown.forEach(function (e) { body.appendChild(lineEl(e)); body.appendChild(br()); });
      body.appendChild(cursorEl());
    }
    demoBtn.hidden = events.length > 0 && !demo;
    toBottom(); stick = true;
  }

  /** Adds one new line before the cursor, typed out character by character (instantly for reduced motion or a long queue). */
  function addLine(e, instant) {
    var cur = document.getElementById('agentCursor');
    var first = body.querySelector('.term-sys'); if (first) { first.remove(); }
    var el = lineEl(e), msg = el.querySelector('.term-msg'), full = e.message;
    if (!instant) msg.textContent = '';
    body.insertBefore(el, cur); body.insertBefore(br(), cur);
    if (stick) toBottom(); else jump.hidden = false;
    if (instant) return Promise.resolve();
    return new Promise(function (done) {
      var i = 0, step = Math.max(1, Math.ceil(full.length / (TYPE_MAX_MS / TYPE_MS)));
      (function tick() {
        i = Math.min(full.length, i + step); msg.textContent = full.slice(0, i);
        if (stick) body.scrollTop = body.scrollHeight;
        if (i < full.length) setTimeout(tick, TYPE_MS); else done();
      })();
    });
  }

  function drain() {
    if (typingNow) return;
    typingNow = true;
    (function next() {
      var e = typing.shift();
      if (!e) { typingNow = false; return; }
      addLine(e, reduced() || typing.length > QUEUE_LIMIT).then(next);
    })();
  }

  function push(list, fromServer) {
    list.forEach(function (e) {
      events.push(e);
      if (visible(e)) typing.push(e);
    });
    if (events.length > KEEP) events = events.slice(-KEEP);
    drain();
  }

  function setStatus() {
    var on = !paused && !document.hidden;
    dot.classList.toggle('is-off', !on || lostShown);
    status.textContent = lostShown ? 'Reconnecting…' : paused ? 'Paused' : 'Live';
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    pauseBtn.setAttribute('aria-pressed', paused ? 'true' : 'false');
  }

  function poll() {
    if (busy || paused || document.hidden || root.hidden || demo) return Promise.resolve();
    busy = true;
    var q = cursor ? '?after=' + cursor + '&limit=100' : '?limit=' + FIRST;
    return Vane.api('GET', '/api/agent-log' + q).then(function (r) {
      busy = false;
      if (!r.ok || !r.data || !r.data.ok) { if (!lostShown) { lostShown = true; setStatus(); } return; }
      if (lostShown) { lostShown = false; setStatus(); }
      var d = r.data;
      if (!loaded) {
        loaded = true; events = d.events.map(norm); cursor = d.latest || 0; redraw();
      } else if (d.events.length) {
        cursor = d.events[d.events.length - 1].id; push(d.events.map(norm));
      }
    }).catch(function () { busy = false; lostShown = true; setStatus(); });
  }
  function norm(e) { return { id: e.id, at: e.at, integration: e.integration, via: e.via, ok: !!e.ok, message: String(e.message || '') }; }

  function start() { if (!timer) timer = setInterval(poll, POLL_MS); poll(); setStatus(); }
  function stop() { if (timer) { clearInterval(timer); timer = 0; } }

  // The tab is a section the dashboard shows or hides: start polling when it appears, stop when it goes.
  new MutationObserver(function () { if (root.hidden) stop(); else start(); }).observe(root, { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('visibilitychange', function () { setStatus(); if (!document.hidden && !root.hidden) poll(); });
  if (!root.hidden) start();

  body.addEventListener('scroll', function () { stick = atBottom(); if (stick) jump.hidden = true; }, { passive: true });
  jump.addEventListener('click', function () { toBottom(); stick = true; });
  pauseBtn.addEventListener('click', function () { paused = !paused; setStatus(); if (!paused) poll(); });

  chips.addEventListener('click', function (e) {
    var b = e.target.closest('[data-int]'); if (!b) return;
    filter = b.getAttribute('data-int') || '';
    Array.prototype.forEach.call(chips.querySelectorAll('[data-int]'), function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
    typing = []; redraw();
  });

  clearBtn.addEventListener('click', function () {
    if (!clearArmed) { clearArmed = setTimeout(function () { clearArmed = 0; clearBtn.textContent = 'Clear log'; }, 3500); clearBtn.textContent = 'Click again to wipe'; return; }
    clearTimeout(clearArmed); clearArmed = 0; clearBtn.textContent = 'Clear log';
    typing = []; events = []; demo = false;
    Vane.api('DELETE', '/api/agent-log').then(function () { redraw(); });
  });

  /** A made-up session so a new person can see what the terminal does before connecting anything. Local only, marked "demo", never stored. */
  demoBtn.addEventListener('click', function () {
    demo = true; demoBtn.hidden = true; typing = []; events = []; redraw();
    var t = Math.floor(Date.now() / 1000), in1 = new Date(Date.now() + 86400000); in1.setUTCHours(9, 0, 0, 0);
    var when = in1.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    var script = [
      { integration: 'claude', via: 'mcp', ok: true, message: 'Executed tool: vane_list_channels() → 4 channels found' },
      { integration: 'claude', via: 'mcp', ok: true, message: 'Executed tool: vane_create_post(2 channels) → scheduled for ' + when },
      { integration: 'notion', via: 'mcp', ok: true, message: 'Executed tool: vane_list_posts(upcoming) → 3 scheduled posts found' },
      { integration: 'obsidian', via: 'api', ok: true, message: 'Scheduled a post for ' + when + ' on 1 channel' },
      { integration: 'make', via: 'api', ok: false, message: 'Schedule a post → refused: quota_exceeded' }
    ].map(function (e, i) { e.id = -i; e.at = t + i; e.demo = true; return e; });
    var i = 0;
    (function next() { if (i >= script.length || !demo) return; var e = script[i++]; events.push(e); addLine(e, reduced()).then(function () { setTimeout(next, reduced() ? 0 : 450); }); })();
    demoNote.hidden = false;
  });

  demoExit.addEventListener('click', function () {
    demo = false; demoNote.hidden = true; typing = []; events = []; cursor = 0; loaded = false; redraw(); poll();
  });
})();
