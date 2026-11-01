/**
 * Status badge: "All Systems Operational • Edge Latency: 18 ms", with a pulsing dot.
 * Both parts are measured, nothing is decorative:
 *   - the latency is the median of three timed round trips to GET /api/health?ping=1 (a first request is thrown away: it pays
 *     for opening the connection, which says nothing about the edge). It is the visitor's own distance to the Cloudflare edge.
 *   - the status comes from GET /api/health (database answers, no post waits too long). What each word means is written in
 *     functions/api/lib/health.ts.
 * Markup: <div data-status-badge data-status-poll="60"></div>. With data-status-poll the badge refreshes every N seconds while
 * the tab is visible (and at once when you come back); without it (marketing pages) it checks once.
 */
(function () {
  'use strict';
  var Vane = window.Vane || (window.Vane = {});

  var TIMEOUT_MS = 6000;   // one request may take this long before we call the service unreachable
  var SAMPLES = 3;         // timed pings (after one warm-up that is not counted)
  var SLOW_MS = 500;       // above this the latency is shown in amber

  function median(a) {
    if (!a.length) return null;
    var s = a.slice().sort(function (x, y) { return x - y; }), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /** "18 ms", "1.2 s" */
  function fmtMs(ms) { return ms < 1000 ? Math.round(ms) + ' ms' : (Math.round(ms / 100) / 10) + ' s'; }

  /**
   * health: the parsed /api/health answer, or null when it could not be reached. online: navigator.onLine.
   * Returns { state: 'ok' | 'degraded' | 'down' | 'unreachable' | 'offline', label }.
   */
  function classify(health, online) {
    if (online === false) return { state: 'offline', label: 'You are offline' };
    if (!health || typeof health.status !== 'string') return { state: 'unreachable', label: 'Can’t reach Vane' };
    if (health.status === 'down') return { state: 'down', label: 'Service disruption' };
    if (health.status === 'degraded') {
      return { state: 'degraded', label: health.checks && health.checks.publishing === 'delayed' ? 'Publishing delayed' : 'Degraded performance' };
    }
    return { state: 'ok', label: 'All Systems Operational' };
  }

  /** The hover text: only what was really measured. */
  function details(health, ms, at) {
    var out = ['Checked ' + at];
    if (health && health.colo) out.push('Edge: Cloudflare ' + health.colo);
    if (ms != null) out.push('Round trip: ' + fmtMs(ms));
    if (health && health.checks) {
      out.push('Database: ' + (health.checks.database === 'ok' ? 'ok' : 'not answering'));
      if (health.checks.publishing === 'ok') out.push('Publishing: on time');
      else if (health.checks.publishing === 'delayed') out.push('Publishing: oldest post is ' + Math.max(1, Math.round((health.delaySeconds || 0) / 60)) + ' min late');
    }
    return out.join(' · ');
  }

  var DOT = { ok: 'bg-emerald-400', degraded: 'bg-amber-400', down: 'bg-red-400', unreachable: 'bg-red-400', offline: 'bg-white/40', checking: 'bg-white/40' };

  function timed(url) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, TIMEOUT_MS) : null;
    var t0 = performance.now();
    return fetch(url, { cache: 'no-store', credentials: 'omit', signal: ctl ? ctl.signal : undefined })
      .then(function (res) { return res.json().then(function (body) { return { ms: performance.now() - t0, status: res.status, body: body }; }); })
      .then(function (r) { if (timer) clearTimeout(timer); return r; }, function (e) { if (timer) clearTimeout(timer); throw e; });
  }

  /** Median round trip to the edge in ms, or null when it could not be measured. */
  function measureLatency() {
    var samples = [];
    function one(n) {
      return timed('/api/health?ping=1').then(function (r) { if (n > 0) samples.push(r.ms); }, function () { /* a lost ping is just not counted */ });
    }
    var p = one(0); // warm-up
    for (var i = 1; i <= SAMPLES; i++) (function (k) { p = p.then(function () { return one(k); }); })(i);
    return p.then(function () { return median(samples); });
  }

  function readHealth() {
    return timed('/api/health').then(function (r) { return r.body && typeof r.body === 'object' ? r.body : null; }, function () { return null; });
  }

  var two = function (n) { return (n < 10 ? '0' : '') + n; };
  var clock = function () { var d = new Date(); return two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds()); };

  function build(host) {
    host.textContent = '';
    var pill = document.createElement('span');
    pill.className = 'inline-flex items-center gap-2 rounded-full bg-white/[0.04] px-3 py-1.5 text-xs text-white/60 ring-1 ring-white/10';
    var dotWrap = document.createElement('span');
    dotWrap.className = 'relative flex h-2 w-2';
    var ping = document.createElement('span');
    ping.className = 'absolute inline-flex h-full w-full rounded-full opacity-60 motion-reduce:animate-none';
    var dot = document.createElement('span');
    dot.className = 'relative inline-flex h-2 w-2 rounded-full';
    dotWrap.appendChild(ping); dotWrap.appendChild(dot);
    var label = document.createElement('span');
    label.setAttribute('role', 'status'); // only the state is announced, not the latency that changes every minute
    var sep = document.createElement('span'); sep.setAttribute('aria-hidden', 'true'); sep.className = 'text-white/25'; sep.textContent = '•';
    var lat = document.createElement('span'); lat.setAttribute('aria-hidden', 'true');
    pill.appendChild(dotWrap); pill.appendChild(label); pill.appendChild(sep); pill.appendChild(lat);
    host.appendChild(pill);
    return { pill: pill, ping: ping, dot: dot, label: label, sep: sep, lat: lat };
  }

  function paint(ui, state, label, ms, title) {
    var color = DOT[state] || DOT.checking;
    ui.dot.className = 'relative inline-flex h-2 w-2 rounded-full ' + color;
    ui.ping.className = 'absolute inline-flex h-full w-full rounded-full opacity-60 motion-reduce:animate-none ' + (state === 'ok' || state === 'degraded' ? color + ' animate-ping' : '');
    if (ui.label.textContent !== label) ui.label.textContent = label;
    var show = ms != null && (state === 'ok' || state === 'degraded');
    ui.sep.hidden = ui.lat.hidden = !show;
    if (show) {
      ui.lat.textContent = 'Edge Latency: ' + fmtMs(ms);
      ui.lat.className = ms > SLOW_MS ? 'text-amber-300' : '';
    }
    ui.pill.title = title || '';
  }

  /** Fill one badge element and, with opts.poll (seconds), keep it fresh. Returns { refresh }. */
  function mount(host, opts) {
    opts = opts || {};
    var ui = build(host), last = 0, busy = false;
    paint(ui, 'checking', 'Checking status…', null, '');

    function refresh() {
      if (busy) return Promise.resolve();
      busy = true;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        busy = false; var off = classify(null, false); paint(ui, off.state, off.label, null, 'No network connection'); return Promise.resolve();
      }
      // One after the other, so the status request never inflates the latency samples.
      return measureLatency().then(function (ms) {
        return readHealth().then(function (health) {
          var c = classify(health, true);
          paint(ui, c.state, c.label, ms, health ? details(health, ms, clock()) : 'The status check did not answer in time. Checked ' + clock());
        });
      }).then(function () { last = Date.now(); busy = false; }, function () { busy = false; });
    }

    refresh();
    if (opts.poll > 0) {
      setInterval(function () { if (!document.hidden) refresh(); }, opts.poll * 1000);
      document.addEventListener('visibilitychange', function () { if (!document.hidden && Date.now() - last > 20000) refresh(); });
      window.addEventListener('online', refresh);
      window.addEventListener('offline', function () { refresh(); });
    }
    return { refresh: refresh };
  }

  Vane.status = { mount: mount, median: median, fmtMs: fmtMs, classify: classify, details: details };

  if (typeof document !== 'undefined' && document.querySelectorAll) {
    var start = function () {
      var hosts = document.querySelectorAll('[data-status-badge]');
      for (var i = 0; i < hosts.length; i++) mount(hosts[i], { poll: parseInt(hosts[i].getAttribute('data-status-poll') || '0', 10) });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  }
})();
