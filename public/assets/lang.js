(function(){
'use strict';
var KEY = 'vane_lang';
var TITLE_EN = document.title;
var SCRIPT = document.currentScript;
var DICT = null;
var ATTRS = ['placeholder', 'aria-label', 'alt', 'title'];
var SKIP = { SCRIPT: 1, STYLE: 1, SVG: 1, NOSCRIPT: 1, TEXTAREA: 1, CODE: 1, PRE: 1 };

// One entry per translation: the global its dictionary file defines (assets/lang-<code>.js), the attribute of this script tag that holds that
// file's address, how "N weeks ago" is written, and the few phrases that carry numbers or names and so cannot be a plain dictionary entry.
// A page shows English until a language is picked; picking one loads only that dictionary. Both read DICT, the dictionary of the language on the page.
var LANGS = {
  ru: {
    global: 'VANE_RU', attr: 'data-dict',
    ago: { week: ['нед.'], weeks: ['нед.'], month: ['мес.'], months: ['мес.'], day: ['дн.'], days: ['дн.'], year: ['г.'], years: ['г.'] },
    patterns: [
      [/^(\d+) characters$/, function (m) { return m[1] + ' символов'; }],
      [/^Queued for (.+) on (\d+) networks?$/, function (m) { return 'В очереди: ' + (DICT[m[1]] || m[1]) + ', сетей: ' + m[2]; }],
      [/^» fast-forwarding to (\d\d:\d\d):00 …$/, function (m) { return '» перематываем до ' + m[1] + ':00 …'; }],
      [/^delivered at (\d\d:\d\d):00 · (\d+) ms$/, function (m) { return 'доставлено в ' + m[1] + ':00 · ' + m[2] + ' мс'; }],
      [/^(\d+) \/ (\d+) uploads$/, function (m) { return m[1] + ' / ' + m[2] + ' загрузок'; }],
      [/^At this setup per-channel pricing is cheaper\. Vane wins from (\d+) channels up\.$/, function (m) { return 'При таких данных оплата за канал дешевле. Vane выигрывает от ' + m[1] + ' каналов.'; }],
      [/^(Your Channel · )?([\d.]+K) views · (\d+) (\w+) ago$/, function (m) { var u = LANGS.ru.ago[m[4]]; return (m[1] ? 'Ваш канал · ' : '') + m[2] + ' просмотров · ' + m[3] + ' ' + (u ? u[0] : m[4]) + ' назад'; }],
      [/^Your Channel · 0 views · Just now$/, function () { return 'Ваш канал · 0 просмотров · только что'; }]
    ]
  },
  uk: {
    global: 'VANE_UK', attr: 'data-dict-uk',
    ago: { week: ['тиж.'], weeks: ['тиж.'], month: ['міс.'], months: ['міс.'], day: ['дн.'], days: ['дн.'], year: ['р.'], years: ['р.'] },
    patterns: [
      [/^(\d+) characters$/, function (m) { return m[1] + ' символів'; }],
      [/^Queued for (.+) on (\d+) networks?$/, function (m) { return 'У черзі: ' + (DICT[m[1]] || m[1]) + ', мереж: ' + m[2]; }],
      [/^» fast-forwarding to (\d\d:\d\d):00 …$/, function (m) { return '» перемотуємо до ' + m[1] + ':00 …'; }],
      [/^delivered at (\d\d:\d\d):00 · (\d+) ms$/, function (m) { return 'доставлено о ' + m[1] + ':00 · ' + m[2] + ' мс'; }],
      [/^(\d+) \/ (\d+) uploads$/, function (m) { return m[1] + ' / ' + m[2] + ' завантажень'; }],
      [/^At this setup per-channel pricing is cheaper\. Vane wins from (\d+) channels up\.$/, function (m) { return 'За таких даних оплата за канал дешевша. Vane виграє від ' + m[1] + ' каналів.'; }],
      [/^(Your Channel · )?([\d.]+K) views · (\d+) (\w+) ago$/, function (m) { var u = LANGS.uk.ago[m[4]]; return (m[1] ? 'Ваш канал · ' : '') + m[2] + ' переглядів · ' + m[3] + ' ' + (u ? u[0] : m[4]) + ' тому'; }],
      [/^Your Channel · 0 views · Just now$/, function () { return 'Ваш канал · 0 переглядів · щойно'; }]
    ]
  }
};
var dicts = {};

var lang = 'en';
// /ru/… and /uk/… are translated at build time (scripts/build-lang-pages.mjs), so a search engine and an AI assistant read them in that
// language, and every page lists its twins as <link rel="alternate" hreflang>. There the address decides the language; this script
// still loads the dictionary for the text a page adds later (prices, widgets). Picking another language goes to that language's page.
var PAGE = 'en';
var TWIN = {};
var nodes = new Map();
var attrs = new Map();
var observer = null;

function known(code) { return Object.prototype.hasOwnProperty.call(LANGS, code); }
function norm(s) { return s.replace(/\s+/g, ' ').trim(); }

function translate(text) {
  var key = norm(text);
  if (!key || !DICT) return null;
  if (Object.prototype.hasOwnProperty.call(DICT, key)) return DICT[key];
  var patterns = LANGS[lang].patterns;
  for (var i = 0; i < patterns.length; i++) {
    var m = patterns[i][0].exec(key);
    if (m) return patterns[i][1](m);
  }
  return null;
}

function skipped(el) {
  for (var e = el; e && e.nodeType === 1; e = e.parentNode) {
    if (SKIP[e.nodeName.toUpperCase()] || e.hasAttribute('data-no-i18n')) return true;
  }
  return false;
}

function doText(node) {
  var done = nodes.get(node);
  if (done && node.data === done.tr) return;
  if (skipped(node.parentNode)) return;
  var tr = translate(node.data);
  if (tr === null) { nodes.delete(node); return; }
  var lead = /^\s*/.exec(node.data)[0];
  var tail = /\s*$/.exec(node.data)[0];
  var out = lead + tr + tail;
  nodes.set(node, { en: node.data, tr: out });
  node.data = out;
}

function doAttrs(el) {
  if (skipped(el)) return;
  ATTRS.forEach(function (a) {
    var v = el.getAttribute(a);
    if (!v) return;
    var rec = attrs.get(el) || {};
    if (rec[a] && rec[a].tr === v) return;
    var tr = translate(v);
    if (tr === null) return;
    rec[a] = { en: v, tr: tr };
    attrs.set(el, rec);
    el.setAttribute(a, tr);
  });
}

function walk(root) {
  if (root.nodeType === 3) { doText(root); return; }
  if (root.nodeType !== 1 || skipped(root)) return;
  doAttrs(root);
  var tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: function (n) { return n.nodeType === 1 && skipped(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; }
  });
  var n;
  while ((n = tw.nextNode())) { if (n.nodeType === 3) doText(n); else doAttrs(n); }
}

function restore() {
  nodes.forEach(function (rec, node) { if (node.data === rec.tr) node.data = rec.en; });
  attrs.forEach(function (rec, el) {
    Object.keys(rec).forEach(function (a) { if (el.getAttribute(a) === rec[a].tr) el.setAttribute(a, rec[a].en); });
  });
  nodes.clear();
  attrs.clear();
}

function watch(on) {
  if (!on) { if (observer) observer.disconnect(); observer = null; return; }
  if (observer) return;
  observer = new MutationObserver(function (list) {
    list.forEach(function (m) {
      if (m.type === 'characterData') doText(m.target);
      else if (m.type === 'attributes') doAttrs(m.target);
      else m.addedNodes.forEach(walk);
    });
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}

function twins() {
  var map = {};
  document.querySelectorAll('link[rel="alternate"][hreflang]').forEach(function (l) { map[l.getAttribute('hreflang')] = l.getAttribute('href'); });
  return map;
}

// The page of another language, when there is one (same host, the #hash stays). Returns true when it navigated.
function go(code, replace) {
  var url = TWIN[code];
  if (!url || code === PAGE) return false;
  url = url.replace(/^https?:\/\/[^/]+/, '') + location.hash;
  if (replace) location.replace(url); else location.assign(url);
  return true;
}

function paint() {
  document.querySelectorAll('[data-lang]').forEach(function (b) {
    var on = b.getAttribute('data-lang') === lang;
    b.setAttribute('aria-pressed', String(on));
    b.style.color = on ? '#fff' : '';
  });
}

function withDict(code, done) {
  var L = LANGS[code];
  if (window[L.global]) { dicts[code] = window[L.global]; done(); return; }
  var src = SCRIPT && SCRIPT.getAttribute(L.attr);
  if (!src) return;
  var s = document.createElement('script');
  s.src = src;
  s.onload = function () { dicts[code] = window[L.global]; done(); };
  document.head.appendChild(s);
}

function set(next, save) {
  if (!known(next)) next = 'en';
  if (next !== 'en' && !dicts[next]) { withDict(next, function () { set(next, save); }); return; }
  if (next === lang && observer === null && next === 'en') { paint(); return; }
  watch(false);
  restore();
  lang = next;
  DICT = dicts[lang] || null;
  document.documentElement.lang = lang;
  document.title = DICT ? (translate(TITLE_EN) || TITLE_EN) : TITLE_EN;
  if (DICT) { walk(document.body); watch(true); }
  paint();
  if (save) { try { localStorage.setItem(KEY, lang); } catch (e) { /* private mode */ } }
}

function start() {
  var want = 'en';
  try { want = new URLSearchParams(location.search).get('lang') || localStorage.getItem(KEY) || 'en'; } catch (e) { /* private mode */ }
  PAGE = known(document.documentElement.lang) ? document.documentElement.lang : 'en';
  TWIN = twins();
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-lang]');
    if (!b) return;
    var to = b.getAttribute('data-lang');
    if (known(to) || to === 'en') { try { localStorage.setItem(KEY, to); } catch (err) { /* private mode */ } }
    if (!go(to, false)) set(to, true);
  });
  if (PAGE !== 'en') want = PAGE;                                  // a translated page is in its language, whatever was saved
  else if (known(want) && go(want, true)) return;                  // the English page, another language wanted: its own page
  set(known(want) ? want : 'en', false);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
