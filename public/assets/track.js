/* Privacy-friendly page-view tracker: no cookies, no third parties, nothing sent when the browser says Do-Not-Track.
   Sends a "view" when a page opens and a heartbeat every 20 s while the tab is visible (that is how time on page is measured). */
(function () {
  'use strict';
  try {
    if (navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl) return;
    if (location.pathname.indexOf('/admin') === 0) return;
    // A page can name itself: the dashboard is served at "/" on post.vaneapp.dev, which must not count as the landing page.
    var tag = document.currentScript;
    var path = (tag && tag.getAttribute('data-path')) || location.pathname;

    var mem = {};
    function store(area, key, make, validFor) {
      var raw = null;
      try { raw = window[area].getItem(key); } catch (e) { raw = mem[area + key] || null; }
      var parts = raw ? raw.split('|') : [];
      var fresh = parts[0] && (!validFor || Date.now() - Number(parts[1] || 0) < validFor);
      var v = fresh ? parts[0] : make();
      var packed = v + '|' + Date.now();
      try { window[area].setItem(key, packed); } catch (e) { mem[area + key] = packed; }
      return v;
    }
    function uid() {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
      return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
    }

    var vid = store('localStorage', 'vane_vid', uid);                       // anonymous browser id
    var sid = store('sessionStorage', 'vane_sid', uid, 30 * 60 * 1000);     // a visit ends after 30 min of silence
    var id = uid();                                                          // this page view
    window.VaneTrack = { vid: vid };

    function send(body, beacon) {
      var data = JSON.stringify(body);
      try {
        if (beacon && navigator.sendBeacon && navigator.sendBeacon('/api/track', new Blob([data], { type: 'application/json' }))) return;
      } catch (e) { /* fall through to fetch */ }
      try { fetch('/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: data, keepalive: true, credentials: 'same-origin' }).catch(function () {}); } catch (e) { /* ignore */ }
    }

    var q = new URLSearchParams(location.search);
    send({ t: 'view', id: id, sid: sid, vid: vid, path: path, ref: document.referrer || '', utm: q.get('utm_source') || '' });

    function ping(beacon) { send({ t: 'ping', id: id, vid: vid }, beacon); }
    setInterval(function () { if (document.visibilityState === 'visible') ping(false); }, 20000);
    document.addEventListener('visibilitychange', function () { ping(document.visibilityState === 'hidden'); });
    window.addEventListener('pagehide', function () { ping(true); });
  } catch (e) { /* analytics must never break a page */ }
})();
