/* /copy: the "Copy code" button in the sign-in email lands here. Reads the 6-digit code from the URL fragment
   (never sent to a server), removes it from the address bar and copies it with one tap. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  var m = /^#(\d{6})$/.exec(window.location.hash);
  // The code must not stay in the address bar or the browser history entry.
  try { history.replaceState(null, '', window.location.pathname); } catch (e) { /* ignore */ }

  if (!m) { $('viewBad').classList.remove('hidden'); return; }
  var code = m[1];
  $('codeBox').textContent = code;
  $('viewCode').classList.remove('hidden');

  /** true = the code is on the clipboard. Falls back to a hidden textarea where the Clipboard API is missing. */
  async function copy() {
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(code); return true; }
    } catch (e) { /* fall through to the old way */ }
    var ta = document.createElement('textarea');
    ta.value = code;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, code.length);
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
    return ok;
  }

  var timer = null;
  function shown(ok) {
    clearTimeout(timer);
    $('copyLabel').textContent = ok ? 'Copied ✓' : 'Copy code';
    $('copyNote').textContent = ok
      ? 'Now go back to the Vane sign-in page and paste it.'
      : 'Couldn’t copy automatically. Tap the code above to select it, then copy.';
    if (ok) timer = setTimeout(function () { $('copyLabel').textContent = 'Copy code'; }, 2500);
  }

  $('copyBtn').addEventListener('click', async function () { shown(await copy()); });

  // Some browsers allow copying right after the tap that opened this page; if not, the button does it.
  copy().then(function (ok) { if (ok) shown(true); });
})();
