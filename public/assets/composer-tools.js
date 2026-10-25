/* Composer tools: small helpers for the post box in Vane Post.
     Tidy up        removes the mess that comes with copied text: extra spaces and blank lines, hidden characters, tracking
                    parameters in links (utm_*, fbclid, gclid, …)
     Clear          empties the box
     Tidy on paste  an option that does the same to whatever is pasted
   Every change can be undone with one click (the bar that appears under the toolbar).
   The cleaning rules are VaneTidy.tidy() below: a pure function, tested in scripts/composer-tools-test.mjs.
   Loaded after dashboard.js: it uses Vane.composer (text / set) and the toolbar row of the post box. */
(function (root) {
  'use strict';

  // ───────────────────────── the rules ─────────────────────────

  // Parameters that only follow you around (they change nothing on the page). `ref`, `v`, `id`, `page`… are NOT here: they are real.
  var TRACKING = /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|yclid|igshid|igsh|mc_cid|mc_eid|_hsenc|_hsmi|mkt_tok|vero_id|ref_src)$/i;
  // `si` is a share id on these sites, and a real parameter elsewhere.
  var SHARE_ID_HOSTS = /^(www\.|music\.)?(youtu\.be|youtube\.com|open\.spotify\.com)$/i;
  // Soft hyphen, Mongolian vowel separator, zero-width space, word joiner, byte-order mark. NOT the zero-width joiner / non-joiner
  // (emoji sequences and several scripts need them) and not the left/right marks (right-to-left text needs them).
  var INVISIBLE = /[\u00AD\u180E\u200B\u2060\uFEFF]/g;
  // No-break space and the typographic spaces become a plain space. The CJK ideographic space (U+3000) is left alone.
  var ODD_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F]/g;

  function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

  /** Removes tracking parameters from one link. Returns the new link; `stat.params` and `stat.links` are counted. */
  function cleanLink(raw, stat) {
    // punctuation that belongs to the sentence, not to the link: "see https://a.com/x." / "(https://a.com/x)"
    var tail = '';
    for (;;) {
      var last = raw.charAt(raw.length - 1);
      var open = (raw.match(/\(/g) || []).length, close = (raw.match(/\)/g) || []).length;
      if (/[.,;:!?'"\]}»”’]/.test(last) || (last === ')' && close > open)) { tail = last + tail; raw = raw.slice(0, -1); } else break;
    }
    var hash = '', hi = raw.indexOf('#');
    if (hi > -1) { hash = raw.slice(hi); raw = raw.slice(0, hi); }
    var qi = raw.indexOf('?');
    if (qi === -1) return raw + hash + tail;
    var base = raw.slice(0, qi), host = (/^https?:\/\/([^\/:?#]+)/i.exec(base) || [])[1] || '';
    var parts = raw.slice(qi + 1).split('&');
    var kept = parts.filter(function (p) {
      if (!p) return true;
      var key = safeDecode(p.split('=')[0]).toLowerCase();
      return !(TRACKING.test(key) || (key === 'si' && SHARE_ID_HOSTS.test(host)));
    });
    var removed = parts.length - kept.length;
    if (!removed) return raw + hash + tail;           // nothing to remove: the link stays exactly as it was
    stat.params += removed; stat.links += 1;
    kept = kept.filter(Boolean);
    return base + (kept.length ? '?' + kept.join('&') : '') + hash + tail;
  }

  /**
   * Tidies a text. Returns { text, changed, changes } where changes counts what was removed:
   * { invisible, spaces, blankLines, params, links }. A text that is already clean comes back unchanged (changed: false),
   * and tidying twice gives the same as tidying once.
   */
  function tidy(input) {
    var original = String(input == null ? '' : input);
    var stat = { invisible: 0, spaces: 0, blankLines: 0, params: 0, links: 0 };

    var t = original.replace(/\r\n?/g, '\n');
    t = t.replace(INVISIBLE, function () { stat.invisible++; return ''; });
    t = t.replace(ODD_SPACES, ' ');
    t = t.replace(/https?:\/\/[^\s<>"']+/g, function (u) { return cleanLink(u, stat); });

    var lines = t.split('\n').map(function (line) {
      var tidied = line.replace(/[ \t]+/g, ' ').replace(/^ | $/g, '');
      stat.spaces += line.length - tidied.length;
      return tidied;
    });
    var blankBefore = lines.filter(function (l) { return l === ''; }).length;
    t = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
    var blankAfter = t === '' ? 0 : t.split('\n').filter(function (l) { return l === ''; }).length;
    stat.blankLines = Math.max(blankBefore - blankAfter, 0);

    return { text: t, changed: t !== original, changes: stat };
  }

  /** "Removed 3 extra blank lines, 12 extra spaces and 2 tracking parameters." */
  function describe(c) {
    var bits = [];
    if (c.blankLines) bits.push(c.blankLines + ' extra blank line' + (c.blankLines === 1 ? '' : 's'));
    if (c.spaces) bits.push(c.spaces + ' extra space' + (c.spaces === 1 ? '' : 's'));
    if (c.invisible) bits.push(c.invisible + ' hidden character' + (c.invisible === 1 ? '' : 's'));
    if (c.params) bits.push(c.params + ' tracking parameter' + (c.params === 1 ? '' : 's') + (c.links > 1 ? ' in ' + c.links + ' links' : ''));
    if (!bits.length) return 'Tidied the text.';
    return 'Removed ' + (bits.length > 1 ? bits.slice(0, -1).join(', ') + ' and ' + bits[bits.length - 1] : bits[0]) + '.';
  }

  root.VaneTidy = { tidy: tidy, describe: describe };

  // ───────────────────────── the buttons ─────────────────────────
  if (typeof document === 'undefined') return;       // loaded for testing only

  var $ = function (id) { return document.getElementById(id); };
  var PASTE_KEY = 'vane:tidyPaste';

  function mount() {
    var composer = root.Vane && root.Vane.composer, box = $('text'), emoji = $('emojiBtn');
    if (!composer || !box || !emoji) return;
    var row = emoji.parentElement.parentElement;      // the toolbar row: emoji · (our tools) · AI tools

    var tools = document.createElement('div');
    tools.id = 'composerTools';
    tools.className = 'flex flex-wrap items-center gap-1.5';
    tools.innerHTML =
      '<button id="toolTidy" type="button" class="btn btn-ghost btn-sm" title="Remove extra spaces and blank lines, hidden characters and tracking parameters in links">' +
        '<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>Tidy up</button>' +
      '<button id="toolClear" type="button" class="btn btn-ghost btn-sm" title="Empty the text box (you can undo it)">' +
        '<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>Clear</button>' +
      '<label for="toolPaste" class="ml-1 flex cursor-pointer items-center gap-1.5 text-xs text-white/55" title="Tidy text when you paste it">' +
        '<input id="toolPaste" type="checkbox" class="peer sr-only" />' +
        '<span class="relative h-4 w-7 rounded-full bg-white/15 transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-3 after:w-3 after:rounded-full after:bg-white after:transition-transform peer-checked:bg-emerald-400/80 peer-checked:after:translate-x-3 peer-focus-visible:ring-2 peer-focus-visible:ring-white/60" aria-hidden="true"></span>Tidy on paste</label>';
    var ai = $('aiBar');
    if (ai && ai.parentElement === row) row.insertBefore(tools, ai); else row.appendChild(tools);

    var note = document.createElement('div');
    note.id = 'toolNote';
    note.className = 'mt-2 hidden items-center gap-2 rounded-xl bg-white/[0.05] px-3 py-1.5 text-xs text-white/70';
    note.setAttribute('role', 'status');
    row.insertAdjacentElement('afterend', note);

    var undoTimer = null;
    function hideNote() { clearTimeout(undoTimer); note.classList.add('hidden'); note.classList.remove('flex'); note.innerHTML = ''; }
    /** Shows what happened; with `previous` it also offers Undo for 10 seconds. */
    function say(message, previous) {
      clearTimeout(undoTimer);
      note.innerHTML = '<span class="min-w-0 flex-1"></span>' + (previous === undefined ? '' : '<button type="button" class="shrink-0 font-semibold text-white underline underline-offset-2" data-undo>Undo</button>');
      note.firstChild.textContent = message;
      note.classList.remove('hidden'); note.classList.add('flex');
      if (previous !== undefined) note.querySelector('[data-undo]').addEventListener('click', function () {
        composer.set(previous);
        say('Restored.');
      });
      undoTimer = setTimeout(hideNote, previous === undefined ? 4000 : 10000);
    }

    $('toolTidy').addEventListener('click', function () {
      var before = composer.text();
      if (!before.trim()) return say('Nothing to tidy yet.');
      var r = VaneTidy.tidy(before);
      if (!r.changed) return say('Already clean: nothing to tidy.');
      composer.set(r.text);
      say(describe(r.changes), before);
    });

    $('toolClear').addEventListener('click', function () {
      var before = composer.text();
      if (!before) return say('The box is already empty.');
      composer.set('');
      say('Text cleared.', before);
    });

    var paste = $('toolPaste');
    try { paste.checked = localStorage.getItem(PASTE_KEY) === '1'; } catch (e) { /* storage blocked: it just starts off each time */ }
    paste.addEventListener('change', function () {
      try { localStorage.setItem(PASTE_KEY, paste.checked ? '1' : '0'); } catch (e) { /* ignore */ }
      say(paste.checked ? 'Pasted text will be tidied.' : 'Pasted text is left as it is.');
    });

    box.addEventListener('paste', function (e) {
      if (!paste.checked) return;
      var data = e.clipboardData;
      if (!data || (data.files && data.files.length)) return;        // pasting an image: dashboard.js handles it
      var raw = data.getData('text/plain');
      if (!raw) return;
      var r = VaneTidy.tidy(raw);
      e.preventDefault();
      var before = box.value, a = box.selectionStart, b = box.selectionEnd;
      var room = box.maxLength > 0 ? box.maxLength - (before.length - (b - a)) : r.text.length;
      var text = r.text.slice(0, Math.max(room, 0));
      box.setRangeText(text, a, b, 'end');
      box.dispatchEvent(new Event('input', { bubbles: true }));       // counter, preview and draft follow
      if (r.changed) say('Pasted and tidied. ' + describe(r.changes), before);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})(typeof window !== 'undefined' ? window : globalThis);
