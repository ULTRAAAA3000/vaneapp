/* The contact form on /about#contact: every "Tell us" / "Get in touch" button leads here (?topic=network|partnership|problem preselects the subject). */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var form = $('contactForm');
  if (!form) return;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var ts = { id: null, token: '' };

  var topic = new URLSearchParams(location.search).get('topic');
  if (topic && $('cTopic').querySelector('option[value="' + topic.replace(/[^a-z]/g, '') + '"]')) $('cTopic').value = topic.replace(/[^a-z]/g, '');

  function showError(text) { $('cErr').textContent = text; $('cErr').classList.remove('hidden'); $('cOk').classList.add('hidden'); }
  function hideError() { $('cErr').classList.add('hidden'); }

  fetch('/api/auth/config', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (c) {
    if (!c || !c.turnstileSiteKey) return;
    $('cTs').classList.remove('hidden');
    var s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = function () {
      try {
        ts.id = window.turnstile.render('#cTs', { sitekey: c.turnstileSiteKey, theme: 'dark', size: 'flexible',
          callback: function (t) { ts.token = t; hideError(); }, 'expired-callback': function () { ts.token = ''; }, 'error-callback': function () { ts.token = ''; } });
      } catch (e) { showError('Could not start the human check. Reload the page and try again.'); }
    };
    document.head.appendChild(s);
  }).catch(function () { /* no human check available: the server decides */ });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    hideError();
    var name = $('cName').value.trim(), email = $('cEmail').value.trim(), message = $('cMessage').value.trim();
    if (!name) return showError('Please tell us your name.');
    if (!EMAIL_RE.test(email)) return showError('Enter a valid email address so we can answer.');
    if (message.length < 10) return showError('Please write a little more.');
    var btn = $('cSend');
    btn.disabled = true; btn.textContent = 'Sending…';
    fetch('/api/contact', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, email: email, topic: $('cTopic').value, message: message, website: $('cWebsite').value, turnstileToken: ts.token })
    }).then(function (r) { return r.json().catch(function () { return null; }).then(function (d) { return { ok: r.ok && d && d.ok, error: d && d.error, status: r.status }; }); })
      .catch(function () { return { ok: false, error: 'Network error. Check your connection and try again.' }; })
      .then(function (r) {
        btn.disabled = false; btn.textContent = 'Send message';
        if (ts.id !== null && window.turnstile) { ts.token = ''; window.turnstile.reset(ts.id); }
        if (!r.ok) return showError(r.error || 'Could not send the message (' + r.status + ').');
        form.reset();
        $('cOk').classList.remove('hidden');
      });
  });
})();
