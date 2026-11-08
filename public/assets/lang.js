(function(){
'use strict';
var KEY = 'vane_lang';
var TITLE_EN = document.title;
var DICT = null;
var SRC = document.currentScript && document.currentScript.getAttribute('data-dict');
var ATTRS = ['placeholder', 'aria-label', 'alt', 'title'];
var SKIP = { SCRIPT: 1, STYLE: 1, SVG: 1, NOSCRIPT: 1, TEXTAREA: 1, CODE: 1, PRE: 1 };
var AGO = { week: ['нед.', 'нед.'], weeks: ['нед.', 'нед.'], month: ['мес.', 'мес.'], months: ['мес.', 'мес.'], day: ['дн.', 'дн.'], days: ['дн.', 'дн.'], year: ['г.', 'г.'], years: ['г.', 'г.'] };
var PATTERNS = [
  [/^(\d+) characters$/, function (m) { return m[1] + ' символов'; }],
  [/^Queued for (.+) on (\d+) networks?$/, function (m) { return 'В очереди: ' + (DICT[m[1]] || m[1]) + ', сетей: ' + m[2]; }],
  [/^» fast-forwarding to (\d\d:\d\d):00 …$/, function (m) { return '» перематываем до ' + m[1] + ':00 …'; }],
  [/^delivered at (\d\d:\d\d):00 · (\d+) ms$/, function (m) { return 'доставлено в ' + m[1] + ':00 · ' + m[2] + ' мс'; }],
  [/^(\d+) \/ (\d+) uploads$/, function (m) { return m[1] + ' / ' + m[2] + ' загрузок'; }],
  [/^At this setup per-channel pricing is cheaper\. Vane wins from (\d+) channels up\.$/, function (m) { return 'При таких данных оплата за канал дешевле. Vane выигрывает от ' + m[1] + ' каналов.'; }],
  [/^(Your Channel · )?([\d.]+K) views · (\d+) (\w+) ago$/, function (m) { var u = AGO[m[4]]; return (m[1] ? 'Ваш канал · ' : '') + m[2] + ' просмотров · ' + m[3] + ' ' + (u ? u[0] : m[4]) + ' назад'; }],
  [/^Your Channel · 0 views · Just now$/, function () { return 'Ваш канал · 0 просмотров · только что'; }]
];

var lang = 'en';
var nodes = new Map();
var attrs = new Map();
var observer = null;

function norm(s) { return s.replace(/\s+/g, ' ').trim(); }

function translate(text) {
  var key = norm(text);
  if (!key) return null;
  if (Object.prototype.hasOwnProperty.call(DICT, key)) return DICT[key];
  for (var i = 0; i < PATTERNS.length; i++) {
    var m = PATTERNS[i][0].exec(key);
    if (m) return PATTERNS[i][1](m);
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
  var known = nodes.get(node);
  if (known && node.data === known.ru) return;
  if (skipped(node.parentNode)) return;
  var ru = translate(node.data);
  if (ru === null) { nodes.delete(node); return; }
  var lead = /^\s*/.exec(node.data)[0];
  var tail = /\s*$/.exec(node.data)[0];
  var out = lead + ru + tail;
  nodes.set(node, { en: node.data, ru: out });
  node.data = out;
}

function doAttrs(el) {
  if (skipped(el)) return;
  ATTRS.forEach(function (a) {
    var v = el.getAttribute(a);
    if (!v) return;
    var rec = attrs.get(el) || {};
    if (rec[a] && rec[a].ru === v) return;
    var ru = translate(v);
    if (ru === null) return;
    rec[a] = { en: v, ru: ru };
    attrs.set(el, rec);
    el.setAttribute(a, ru);
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
  nodes.forEach(function (rec, node) { if (node.data === rec.ru) node.data = rec.en; });
  attrs.forEach(function (rec, el) {
    Object.keys(rec).forEach(function (a) { if (el.getAttribute(a) === rec[a].ru) el.setAttribute(a, rec[a].en); });
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

function paint() {
  document.querySelectorAll('[data-lang]').forEach(function (b) {
    var on = b.getAttribute('data-lang') === lang;
    b.setAttribute('aria-pressed', String(on));
    b.style.color = on ? '#fff' : '';
  });
}

function withDict(done) {
  if (window.VANE_RU) { DICT = window.VANE_RU; done(); return; }
  if (!SRC) return;
  var s = document.createElement('script');
  s.src = SRC;
  s.onload = function () { DICT = window.VANE_RU; done(); };
  document.head.appendChild(s);
}

function set(next, save) {
  if (next !== 'ru') next = 'en';
  if (next === 'ru' && !DICT) { withDict(function () { set('ru', save); }); return; }
  if (next === lang && observer === null && next === 'en') { paint(); return; }
  watch(false);
  restore();
  lang = next;
  document.documentElement.lang = lang;
  document.title = lang === 'ru' ? (translate(TITLE_EN) || TITLE_EN) : TITLE_EN;
  if (lang === 'ru') { walk(document.body); watch(true); }
  paint();
  if (save) { try { localStorage.setItem(KEY, lang); } catch (e) { /* private mode */ } }
}

function start() {
  var want = 'en';
  try { want = new URLSearchParams(location.search).get('lang') || localStorage.getItem(KEY) || 'en'; } catch (e) { /* private mode */ }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-lang]');
    if (b) set(b.getAttribute('data-lang'), true);
  });
  set(want === 'ru' ? 'ru' : 'en', false);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
