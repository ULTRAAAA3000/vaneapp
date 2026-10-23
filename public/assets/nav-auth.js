/* Shared by every public page. 1) The contact address is revealed in the browser. 2) The "Log in" / "Sign in" button on every public page becomes "Dashboard" when you are signed in, and points straight at the dashboard
 * (no detour through /login). The session cookie is HttpOnly, so the API is asked; the last known answer is remembered so there is no flash. */
(function () {
  'use strict';
  // The contact address is never written in the page source (harvesters read that): it is assembled here from two halves.
  [].forEach.call(document.querySelectorAll('[data-mail-u]'), function (el) {
    var addr = el.getAttribute('data-mail-u') + String.fromCharCode(64) + el.getAttribute('data-mail-h');
    var a = document.createElement('a');
    a.href = 'mail' + 'to:' + addr;
    a.textContent = el.getAttribute('data-mail-label') || addr;
    if (el.getAttribute('data-mail-class')) a.className = el.getAttribute('data-mail-class');
    el.textContent = '';
    el.appendChild(a);
  });

  var HINT = 'vane_signed_in';
  var links = [].slice.call(document.querySelectorAll('[data-auth-link]'));
  if (!links.length) return;
  var dashboard = /^(www\.)?vaneapp\.dev$/i.test(location.hostname) ? 'https://post.vaneapp.dev/' : '/app';
  links.forEach(function (a) { a.setAttribute('data-label', a.textContent); a.setAttribute('data-href', a.getAttribute('href') || '/login'); });

  function show(on) {
    links.forEach(function (a) {
      a.textContent = on ? 'Dashboard' : a.getAttribute('data-label');
      a.setAttribute('href', on ? dashboard : a.getAttribute('data-href'));
    });
  }
  function check() {
    fetch('/api/auth/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (res) {
        try { if (res.ok) localStorage.setItem(HINT, '1'); else if (res.status === 401) localStorage.removeItem(HINT); } catch (e) { /* storage blocked */ }
        if (res.ok || res.status === 401) show(res.ok);
      })
      .catch(function () { /* offline: keep what is shown */ });
  }
  try { if (localStorage.getItem(HINT) === '1') show(true); } catch (e) { /* storage blocked */ }
  check();
  window.addEventListener('pageshow', function (e) { if (e.persisted) check(); });   // back button after signing out
})();
