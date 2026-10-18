/* /login — sign in + create account */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  var form = $('form'), email = $('email'), password = $('password'), nameInput = $('name');
  var errBox = $('err'), submit = $('submit'), spin = $('spin'), label = $('submitLabel');
  var mode = 'login';
  var product = 'post';   // 'post' | 'studio': where the visitor is signing in to

  // Already signed in? Skip the form.
  Vane.api('GET', '/api/auth/me', undefined, { noRedirect: true }).then(function (r) { if (r.ok) Vane.go(Vane.home()); });

  // ── which product: Vane Post or Vane Studio (one account, two dashboards)
  // On post. / studio. the host already decides, and the switch takes you to the other host's sign-in page.
  // On the main site (and in local dev) the choice rides in ?product=, which Vane.home() reads after signing in.
  var OWN_HOST = /^(post|studio)\.vaneapp\.dev$/i;
  function readProduct() {
    var h = /^(post|studio)\./i.exec(location.hostname);
    if (h && OWN_HOST.test(location.hostname)) return h[1].toLowerCase();
    return new URLSearchParams(location.search).get('product') === 'studio' ? 'studio' : 'post';
  }
  function syncUrl() {
    var q = [];
    if (mode === 'register') q.push('mode=register');
    if (!OWN_HOST.test(location.hostname) && product === 'studio') q.push('product=studio');
    var next = q.length ? '?' + q.join('&') : '';
    var keep = new URLSearchParams(location.search).get('next');       // dev only: where to return after signing in
    if (keep && !OWN_HOST.test(location.hostname)) next += (next ? '&' : '?') + 'next=' + encodeURIComponent(keep);
    history.replaceState(null, '', location.pathname + next);
  }
  function paintProduct() {
    [['post', 'prodPost'], ['studio', 'prodStudio']].forEach(function (p) {
      var on = product === p[0];
      $(p[1]).setAttribute('aria-pressed', String(on));
      $(p[1]).style.background = on ? '#fff' : 'transparent';
      $(p[1]).style.color = on ? '#010101' : 'rgba(255,255,255,.75)';
      $(p[1]).lastElementChild.style.color = on ? 'rgba(1,1,1,.55)' : '';
    });
  }
  function setProduct(next) {
    if (next === product) return;
    if (OWN_HOST.test(location.hostname)) {
      location.assign('https://' + next + '.vaneapp.dev/login' + (mode === 'register' ? '?mode=register' : ''));
      return;
    }
    product = next;
    paintProduct();
    setMode(mode);
  }
  product = readProduct();
  $('prodPost').addEventListener('click', function () { setProduct('post'); });
  $('prodStudio').addEventListener('click', function () { setProduct('studio'); });

  // ── mode switching
  function setMode(next) {
    mode = next;
    var reg = mode === 'register';
    $('seg').style.transform = reg ? 'translateX(100%)' : 'translateX(0)';
    $('tabLogin').setAttribute('aria-selected', String(!reg));
    $('tabRegister').setAttribute('aria-selected', String(reg));
    $('tabLogin').style.color = reg ? 'rgba(255,255,255,.65)' : '#010101';
    $('tabRegister').style.color = reg ? '#010101' : 'rgba(255,255,255,.65)';
    var studio = product === 'studio';
    $('title').textContent = reg ? 'Create your account' : 'Welcome back';
    $('sub').textContent = reg
      ? (studio ? 'One account for Vane Post and Vane Studio. You will land in Studio.' : 'Connect a channel and schedule your first post in a minute.')
      : (studio ? 'Sign in to your video library.' : 'Sign in to schedule your next post.');
    $('nameRow').classList.toggle('hidden', !reg);
    $('meter').classList.toggle('hidden', !reg);
    password.setAttribute('autocomplete', reg ? 'new-password' : 'current-password');
    label.textContent = reg ? 'Create account' : 'Sign in';
    hideError();
    syncUrl();
  }
  $('tabLogin').addEventListener('click', function () { setMode('login'); });
  $('tabRegister').addEventListener('click', function () { setMode('register'); });
  paintProduct();
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
    // 202 + verify = no session yet: a 6-digit code was emailed (new account, or back after more than 3 days away)
    if (r.ok && r.data && r.data.verify) { setLoading(false); tsReset(); showVerify(r.data.verify); return; }
    if (r.ok) { label.textContent = 'Redirecting…'; Vane.go(Vane.home()); return; }
    setLoading(false);
    tsReset();
    showError(r.error, r.status === 409 ? email : (r.status === 401 ? password : null));
  });

  // ───────────────────────── step 2: the 6-digit code ─────────────────────────
  var pending = null;        // { email, purpose, resendAt }  (resendAt is on THIS device's clock, built from the server's relative seconds)
  var resendTimer = null;
  var checking = false;
  var vErr = $('vErr'), codeInput = $('code');

  function showVError(msg) {
    vErr.textContent = msg; vErr.classList.remove('hidden');
    var f = $('vForm'); f.classList.remove('shake'); void f.offsetWidth; f.classList.add('shake');
  }
  function hideVError() { vErr.classList.add('hidden'); vErr.textContent = ''; }

  function tickResend() {
    var btn = $('vResend');
    var left = Math.max(0, Math.ceil((pending.resendAt - Date.now()) / 1000));
    btn.disabled = left > 0;
    btn.textContent = left > 0 ? 'Resend code in ' + (left > 120 ? Math.ceil(left / 60) + ' min' : left + 's') : 'Resend code';
    if (left <= 0) { clearInterval(resendTimer); resendTimer = null; }
  }
  function startResendTimer(seconds) {
    pending.resendAt = Date.now() + seconds * 1000;
    clearInterval(resendTimer);
    resendTimer = setInterval(tickResend, 1000);
    tickResend();
  }

  function showVerify(ch) {
    pending = { email: ch.email, purpose: ch.purpose, resendAt: 0 };
    $('viewAuth').classList.add('hidden');
    $('viewVerify').classList.remove('hidden');
    $('vSub').textContent = ch.purpose === 'login'
      ? 'You haven’t signed in for a few days, so we need to confirm it’s you. Enter the 6-digit code we sent to'
      : 'Enter the 6-digit code we sent to';
    $('vEmail').textContent = ch.email;
    codeInput.value = '';
    hideVError();
    startResendTimer(ch.resendIn);
    codeInput.focus();
  }

  // Back to the form (the typed email and password are still there). `msg` explains why, when it is not the user's own choice.
  function backToForm(msg) {
    clearInterval(resendTimer); resendTimer = null;
    pending = null; checking = false;
    $('viewVerify').classList.add('hidden');
    $('viewAuth').classList.remove('hidden');
    if (msg) showError(msg); else hideError();
    email.focus();
  }
  $('vBack').addEventListener('click', function () { backToForm(); });

  function setChecking(on) {
    checking = on;
    $('vSubmit').disabled = on;
    $('vSpin').classList.toggle('hidden', !on);
    $('vLabel').textContent = on ? 'Checking…' : 'Verify';
  }

  async function submitCode() {
    if (checking || !pending) return;
    var code = codeInput.value;
    if (code.length !== 6) return showVError('Enter the 6-digit code.');
    setChecking(true);
    var r = await Vane.api('POST', '/api/auth/verify', { email: pending.email, code: code, purpose: pending.purpose }, { noRedirect: true });
    if (r.ok) { $('vLabel').textContent = 'Redirecting…'; Vane.go(Vane.home()); return; }
    setChecking(false);
    if (r.status === 404 || r.status === 409) return backToForm(r.error);   // nothing is waiting any more, or the account already exists
    showVError(r.error);
    if (r.status === 400) { codeInput.value = ''; codeInput.focus(); }
  }

  // digits only (a pasted "123 456" works); the sixth digit sends it
  codeInput.addEventListener('input', function () {
    var digits = codeInput.value.replace(/\D/g, '').slice(0, 6);
    if (digits !== codeInput.value) codeInput.value = digits;
    hideVError();
    if (digits.length === 6) submitCode();
  });
  $('vForm').addEventListener('submit', function (e) { e.preventDefault(); submitCode(); });

  $('vResend').addEventListener('click', async function () {
    if (!pending) return;
    hideVError();
    this.disabled = true;
    var r = await Vane.api('POST', '/api/auth/resend', { email: pending.email, purpose: pending.purpose }, { noRedirect: true });
    if (r.ok && r.data && r.data.verify) {
      startResendTimer(r.data.verify.resendIn);
      codeInput.value = ''; codeInput.focus();
      Vane.toast('ok', 'A new code is on its way.');
      return;
    }
    if (r.status === 404) return backToForm(r.error);
    if (r.status === 429 && r.data && r.data.retryAfter) startResendTimer(r.data.retryAfter); else this.disabled = false;
    showVError(r.error);
  });
})();
