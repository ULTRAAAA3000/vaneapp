(function () {
  'use strict';
  var off = [], NAMES = {};
  var BADGE = 'rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white/55';

  function style() {
    if (document.getElementById('modStyle')) return;
    var s = document.createElement('style');
    s.id = 'modStyle';
    s.textContent = '.mod-ov{position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.65);backdrop-filter:blur(6px)}' +
      '.mod-box{width:100%;max-width:380px;border-radius:24px;padding:28px 24px 22px;text-align:center;background:#0d0d10;border:1px solid rgba(255,255,255,.12);box-shadow:0 30px 80px rgba(0,0,0,.6);color:#fff;font-family:inherit}' +
      '.mod-ico{display:flex;align-items:center;justify-content:center;width:52px;height:52px;margin:0 auto 14px;border-radius:50%;background:rgba(255,255,255,.08)}' +
      '.mod-box h2{font-size:18px;font-weight:600;letter-spacing:-.01em;margin:0}.mod-box p{margin:8px 0 0;font-size:14px;line-height:1.55;color:rgba(255,255,255,.6)}' +
      '.mod-box button{margin-top:22px;width:100%;border:0;border-radius:999px;background:#fff;color:#010101;font-weight:600;font-size:14px;padding:12px 20px;cursor:pointer}';
    document.head.appendChild(s);
  }

  function dialog(id, onClose) {
    style();
    var name = NAMES[id] || 'This module';
    var prev = document.activeElement;
    var ov = document.createElement('div');
    ov.className = 'mod-ov';
    ov.innerHTML = '<div class="mod-box" role="dialog" aria-modal="true" aria-labelledby="modT" aria-describedby="modD"><div class="mod-ico"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></div><h2 id="modT"></h2><p id="modD">Please check back later.</p><button type="button">Got it</button></div>';
    ov.querySelector('#modT').textContent = name + ' is not available right now';
    function close() {
      document.removeEventListener('keydown', key, true);
      ov.remove();
      if (prev && prev.focus) prev.focus();
      if (onClose) onClose();
    }
    function key(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'Tab') { e.preventDefault(); ov.querySelector('button').focus(); }
    }
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    ov.querySelector('button').addEventListener('click', close);
    document.addEventListener('keydown', key, true);
    document.body.appendChild(ov);
    ov.querySelector('button').focus();
  }

  function tabOf(hash) { return hash.replace('#', ''); }

  function apply() {
    [].forEach.call(document.querySelectorAll('[data-module]'), function (el) {
      var id = el.getAttribute('data-module'), isOff = off.indexOf(id) >= 0, badge = el.querySelector('[data-mod-badge]');
      el.classList.toggle('mod-off', isOff);
      if (isOff) {
        el.setAttribute('aria-disabled', 'true');
        if (!badge && !el.hasAttribute('data-module-nobadge')) {
          badge = document.createElement('span');
          badge.setAttribute('data-mod-badge', '');
          badge.className = BADGE + ' ml-1.5';
          badge.textContent = 'Soon';
          el.appendChild(badge);
        }
      } else {
        el.removeAttribute('aria-disabled');
        if (badge) badge.remove();
      }
    });
    [].forEach.call(document.querySelectorAll('[data-module-badge]'), function (el) {
      el.hidden = off.indexOf(el.getAttribute('data-module-badge')) < 0;
    });
  }

  function guardHash() {
    var id = tabOf(location.hash);
    if (id && off.indexOf(id) >= 0 && document.querySelector('[data-module="' + id + '"]')) {
      history.replaceState(null, '', location.pathname + location.search + '#create');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      dialog(id);
    }
  }

  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-module]') : null;
    if (!el) return;
    var id = el.getAttribute('data-module');
    if (off.indexOf(id) < 0) return;
    e.preventDefault();
    e.stopPropagation();
    dialog(id);
  }, true);

  document.querySelectorAll('[data-module]').forEach(function (el) { NAMES[el.getAttribute('data-module')] = (el.getAttribute('data-module-name') || el.textContent.trim()).replace(/\s+/g, ' ').replace(/\s*Soon$/, ''); });

  window.Vane = window.Vane || {};
  Vane.moduleOff = function (id) { return off.indexOf(id) >= 0; };

  fetch('/api/modules', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) {
    if (!j || !j.ok) return;
    off = j.off || [];
    apply();
    guardHash();
    var page = document.body.getAttribute('data-module-page');
    if (page && off.indexOf(page) >= 0) {
      NAMES[page] = document.body.getAttribute('data-module-name') || NAMES[page];
      dialog(page, function () { location.href = (window.Vane && Vane.productUrl) ? Vane.productUrl('post') : '/'; });
    }
  }).catch(function () {});
})();
