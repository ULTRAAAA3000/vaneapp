(function () {
  'use strict';
  var form = document.getElementById('joinForm'), note = document.getElementById('joinNote'), btn = document.getElementById('joinBtn');
  if (!form) return;
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var email = document.getElementById('joinEmail').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { note.textContent = 'Please enter a valid email address.'; return; }
    btn.disabled = true;
    try {
      var r = await fetch('/api/waitlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email, website: document.getElementById('joinWebsite').value }) });
      var d = await r.json().catch(function () { return null; });
      note.textContent = r.ok && d && d.ok ? 'Thank you. We will write to you when Vane Analytics opens.' : (d && d.error) || 'Something went wrong. Please try again.';
      if (r.ok && d && d.ok) form.reset();
    } catch (err) {
      note.textContent = 'Something went wrong. Please try again.';
    }
    btn.disabled = false;
  });
})();
