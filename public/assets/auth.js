/* /login — sign in + create account */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  var form = $('form'), email = $('email'), password = $('password'), nameInput = $('name');
  var errBox = $('err'), submit = $('submit'), spin = $('spin'), label = $('submitLabel');
  var mode = 'login';

  // Already signed in? Skip the form.
  Vane.api('GET', '/api/auth/me', undefined, { noRedirect: true }).then(function (r) { if (r.ok) Vane.go('/app'); });

  // ── mode switching
  function setMode(next) {
    mode = next;
    var reg = mode === 'register';
    $('seg').style.transform = reg ? 'translateX(100%)' : 'translateX(0)';
    $('tabLogin').setAttribute('aria-selected', String(!reg));
    $('tabRegister').setAttribute('aria-selected', String(reg));
    $('tabLogin').style.color = reg ? 'rgba(255,255,255,.65)' : '#010101';
    $('tabRegister').style.color = reg ? '#010101' : 'rgba(255,255,255,.65)';
    $('title').textContent = reg ? 'Create your account' : 'Welcome back';
    $('sub').textContent = reg ? 'Connect a channel and schedule your first post in a minute.' : 'Sign in to schedule your next post.';
    $('nameRow').classList.toggle('hidden', !reg);
    $('meter').classList.toggle('hidden', !reg);
    password.setAttribute('autocomplete', reg ? 'new-password' : 'current-password');
    label.textContent = reg ? 'Create account' : 'Sign in';
    hideError();
    history.replaceState(null, '', reg ? '?mode=register' : location.pathname);
  }
  $('tabLogin').addEventListener('click', function () { setMode('login'); });
  $('tabRegister').addEventListener('click', function () { setMode('register'); });
  setMode(new URLSearchParams(location.search).get('mode') === 'register' ? 'register' : 'login');

  // ── show / hide password
  $('togglePw').addEventListener('click', function () {
    var show = password.type === 'password';
    password.type = show ? 'text' : 'password';
    this.textContent = show ? 'Hide' : 'Show';
  });

  // ── strength meter (register only)
  var COLORS = ['#f87171', '#fb923c', '#fbbf24', '#34d399'];
  var WORDS = ['Too short', 'Weak', 'Okay', 'Good', 'Strong'];
  function strength(pw) {
    if (pw.length < 8) return pw.length ? 0 : -1;
    var s = 1;
    if (pw.length >= 12) s++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
    if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
    return Math.min(s, 4);
  }
  password.addEventListener('input', function () {
    if (mode !== 'register') return;
    var s = strength(password.value);
    var bars = $('meter').querySelectorAll('span');
    for (var i = 0; i < bars.length; i++) bars[i].style.background = i < s ? COLORS[Math.max(0, s - 1)] : '';
    $('meterText').textContent = s < 0 ? 'At least 8 characters.' : WORDS[s];
  });

  // ── Turnstile (bot protection): active only when the server reports a site key
  var ts = { key: null, id: null, token: '' };
  function tsReset() {                       // a token works once, so fetch a fresh one after every attempt
    ts.token = '';
    if (ts.id !== null && window.turnstile) window.turnstile.reset(ts.id);
  }
  Vane.api('GET', '/api/auth/config', undefined, { noRedirect: true }).then(function (r) {
    if (!r.ok) { console.warn('[vane] could not read /api/auth/config:', r.error); return; }
    if (!r.data.turnstileSiteKey) {
      // The check is OFF. Say why in the console (the page itself stays clean for real visitors).
      var st = r.data.turnstile || {};
      if (st.siteKeySet !== st.secretKeySet) {
        console.warn('[vane] Turnstile is half-configured: ' + (st.siteKeySet ? 'TURNSTILE_SECRET_KEY' : 'TURNSTILE_SITE_KEY') + ' is not visible to the server, so the human check is OFF. See README → Bot protection.');
      } else {
        console.info('[vane] Turnstile is not configured on the server (no TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY), so there is no human check.');
      }
      return;
    }
    ts.key = r.data.turnstileSiteKey;
    $('tsBox').classList.remove('hidden');
    var s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = function () {
      try {
        ts.id = window.turnstile.render('#tsBox', {
          sitekey: ts.key, theme: 'dark', size: 'flexible',
          callback: function (t) { ts.token = t; hideError(); },
          'expired-callback': function () { ts.token = ''; },
          'error-callback': function (code) {
            ts.token = '';
            console.warn('[vane] Turnstile error', code);
            // 110xxx = the widget itself is misconfigured (bad site key / hostname not allowed): tell the user.
            if (/^110/.test(String(code))) showError('The human check is misconfigured (error ' + code + '). Please contact support.');
          }
        });
      } catch (e) {
        console.error('[vane] Turnstile render failed:', e);
        showError('Could not start the human check. Reload the page and try again.');
      }
    };
    s.onerror = function () { showError('Could not load the human check. Turn off ad-blockers for this page and reload.'); };
    document.head.appendChild(s);
  });

  // ── errors
  function showError(msg, field) {
    errBox.textContent = msg;
    errBox.classList.remove('hidden');
    form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
    [email, password].forEach(function (f) { f.removeAttribute('aria-invalid'); });
    if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
  }
  function hideError() { errBox.classList.add('hidden'); errBox.textContent = ''; [email, password].forEach(function (f) { f.removeAttribute('aria-invalid'); }); }
  [email, password].forEach(function (f) { f.addEventListener('input', hideError); });

  function setLoading(on) {
    submit.disabled = on;
    spin.classList.toggle('hidden', !on);
    label.textContent = on ? (mode === 'register' ? 'Creating account…' : 'Signing in…') : (mode === 'register' ? 'Create account' : 'Sign in');
  }

  // ── submit
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    hideError();
    var em = email.value.trim(), pw = password.value;
    if (!EMAIL_RE.test(em)) return showError('Enter a valid email address.', email);
    if (!pw) return showError('Enter your password.', password);
    if (mode === 'register' && pw.length < 8) return showError('Password must be at least 8 characters.', password);
    if (ts.key && !ts.token) return showError('Please complete the human check.');

    setLoading(true);
    var body = { email: em, password: pw };
    if (ts.key) body.turnstileToken = ts.token;
    if (mode === 'register') {
      body.name = nameInput.value.trim();
      try { body.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (err) { /* server falls back to UTC */ }
    }
    var r = await Vane.api('POST', mode === 'register' ? '/api/auth/register' : '/api/auth/login', body, { noRedirect: true });
    if (r.ok) { label.textContent = 'Redirecting…'; Vane.go('/app'); return; }
    setLoading(false);
    tsReset();
    showError(r.error, r.status === 409 ? email : (r.status === 401 ? password : null));
  });
})();
