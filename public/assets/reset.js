/**
 * /reset: "Forgot password?". Step 1 asks for the email (POST /api/auth/forgot), step 2 takes the 6-digit code and the new password
 * (POST /api/auth/reset), step 3 sends the person to sign in. The reset itself does not sign anyone in.
 * The server answers step 1 the same way for any address, so this page never says whether an account exists.
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var email = '';
  var cooldown = 0, timer = null;

  function show(which) {
    ['askForm', 'setForm', 'done', 'off'].forEach(function (id) { $(id).classList.toggle('hidden', id !== which); });
    $('title').textContent = which === 'done' ? 'All set' : which === 'setForm' ? 'Check your email' : 'Forgot your password?';
    $('sub').textContent = which === 'setForm' ? 'Enter the code we sent and choose a new password.' : which === 'done' || which === 'off' ? '' : 'Enter your email and we will send you a 6-digit code.';
    $('sub').classList.toggle('hidden', !$('sub').textContent);
  }
  function err(id, msg) { var e = $(id); e.textContent = msg || ''; e.classList.toggle('hidden', !msg); }
  function busy(prefix, on, label) {
    $(prefix + 'Btn').disabled = on;
    $(prefix + 'Spin').classList.toggle('hidden', !on);
    $(prefix + 'Label').textContent = on ? 'Please wait' : label;
  }

  function tick() {
    var b = $('resend');
    if (cooldown > 0) { b.disabled = true; b.textContent = 'Send a new code (' + cooldown + ' s)'; cooldown--; timer = setTimeout(tick, 1000); }
    else { b.disabled = false; b.textContent = 'Send a new code'; }
  }
  function startCooldown(s) { clearTimeout(timer); cooldown = s || 60; tick(); }

  async function ask(fromResend) {
    err('askErr', ''); err('setErr', '');
    email = ($('email').value || '').trim().toLowerCase();
    if (!email) { err('askErr', 'Enter your email address.'); return; }
    busy('ask', true, 'Send the code');
    var r = await Vane.api('POST', '/api/auth/forgot', { email: email }, { noRedirect: true });
    busy('ask', false, 'Send the code');
    if (r.status === 404) { show('off'); return; }                                   // email is not set up on the server
    if (!r.ok) { err(fromResend ? 'setErr' : 'askErr', r.error || 'Something went wrong. Please try again.'); return; }
    $('sentTo').textContent = 'If an account exists for ' + email + ', a code is on its way.';
    show('setForm');
    startCooldown((r.data && r.data.resendIn) || 60);
    $('code').focus();
  }

  $('askForm').addEventListener('submit', function (e) { e.preventDefault(); ask(false); });
  $('resend').addEventListener('click', function () { if (cooldown <= 0) ask(true); });
  $('togglePw').addEventListener('click', function () {
    var p = $('password'), show_ = p.type === 'password';
    p.type = show_ ? 'text' : 'password';
    $('togglePw').textContent = show_ ? 'Hide' : 'Show';
  });

  $('setForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    err('setErr', '');
    var code = ($('code').value || '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(code)) { err('setErr', 'The code is 6 digits.'); return; }
    if ($('password').value.length < 8) { err('setErr', 'Password must be at least 8 characters.'); return; }
    busy('set', true, 'Set the new password');
    var r = await Vane.api('POST', '/api/auth/reset', { email: email, code: code, password: $('password').value }, { noRedirect: true });
    busy('set', false, 'Set the new password');
    if (!r.ok) { err('setErr', r.error || 'Something went wrong. Please try again.'); return; }
    $('password').value = '';
    show('done');
  });

  var preset = new URLSearchParams(location.search).get('email');
  if (preset) $('email').value = preset;
  history.replaceState(null, '', location.pathname);   // the address does not stay in the URL or the history
})();
