/**
 * Static translation of a marketing page: the same rules assets/lang.js applies in the browser (exact match of the whitespace-normalised
 * text of a text node or of the placeholder / aria-label / alt / title attributes, skipping svg, code, pre, textarea, noscript and
 * [data-no-i18n]), done at build time so that /ru/… and /uk/… are real pages a search engine or an AI crawler can read.
 * Used by scripts/build-lang-pages.mjs; the dictionaries are public/assets/lang-<code>.js.
 */
import { readFileSync } from 'node:fs';

export const ATTRS = ['placeholder', 'aria-label', 'alt', 'title'];
const SKIP = new Set(['svg', 'noscript', 'textarea', 'code', 'pre', 'script', 'style']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

export const norm = (s) => s.replace(/\s+/g, ' ').trim();

export function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    if (!(e in ENTITIES)) throw new Error(`lang-lib: unknown HTML entity ${m}; add it to ENTITIES`);
    return ENTITIES[e];
  });
}
export const encodeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const encodeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** Dictionary of one language: public/assets/lang-<code>.js is `window.VANE_XX={…};`. */
export function loadDict(root, code) {
  const s = readFileSync(`${root}/public/assets/lang-${code}.js`, 'utf8');
  return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
}

/** Splits html into { t: 'text' | 'tag' | 'raw' | 'comment', s } pieces that join back to the exact input. */
export function tokenize(html) {
  const out = [];
  let i = 0;
  const n = html.length;
  while (i < n) {
    if (html[i] !== '<') {
      let j = html.indexOf('<', i);
      if (j < 0) j = n;
      out.push({ t: 'text', s: html.slice(i, j) });
      i = j;
      continue;
    }
    if (html.startsWith('<!--', i)) {
      const j = html.indexOf('-->', i + 4);
      const end = j < 0 ? n : j + 3;
      out.push({ t: 'comment', s: html.slice(i, end) });
      i = end;
      continue;
    }
    if (/^<(!|\?)/.test(html.slice(i, i + 2))) {
      const j = html.indexOf('>', i);
      const end = j < 0 ? n : j + 1;
      out.push({ t: 'comment', s: html.slice(i, end) });
      i = end;
      continue;
    }
    if (!/^<\/?[a-zA-Z]/.test(html.slice(i, i + 3))) { out.push({ t: 'text', s: '<' }); i++; continue; }
    // a tag: up to the first > that is not inside quotes
    let j = i + 1, q = '';
    while (j < n) {
      const c = html[j];
      if (q) { if (c === q) q = ''; } else if (c === '"' || c === "'") q = c; else if (c === '>') break;
      j++;
    }
    const tag = html.slice(i, j + 1);
    out.push({ t: 'tag', s: tag });
    i = j + 1;
    const m = /^<([a-zA-Z][^\s>/]*)/.exec(tag);
    if (m && RAW.has(m[1].toLowerCase()) && !/\/>$/.test(tag)) {
      const close = new RegExp(`</${m[1]}\\s*>`, 'i');
      const rest = html.slice(i);
      const k = rest.search(close);
      const end = k < 0 ? n : i + k;
      if (end > i) out.push({ t: 'raw', s: html.slice(i, end) });
      i = end;
    }
  }
  return out;
}

const ATTR_RE = /([^\s"'<>/=]+)(?:(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Applies fn to the value of each attribute in names; returns the rewritten tag. */
export function mapAttrs(tag, names, fn) {
  const head = /^<\/?[a-zA-Z][^\s>/]*/.exec(tag)[0];
  const body = tag.slice(head.length);
  let out = '', last = 0;
  body.replace(ATTR_RE, (m, name, eq, dq, sq, bare, idx) => {
    if (!names.includes(name.toLowerCase()) || eq === undefined) return m;
    const raw = dq ?? sq ?? bare;
    const next = fn(name.toLowerCase(), decode(raw));
    if (next == null) return m;
    out += body.slice(last, idx) + `${name}${eq}"${encodeAttr(next)}"`;
    last = idx + m.length;
    return m;
  });
  return head + out + body.slice(last);
}

export const hasAttr = (tag, name) => new RegExp(`\\s${name}(?=[\\s=>/])`, 'i').test(tag);
export const getAttr = (tag, name) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, 'i').exec(tag);
  return m ? decode(m[1] ?? m[2] ?? m[3]) : null;
};

/**
 * Translates the body of a page. Returns { html, missing } where missing lists the English strings (text nodes and attributes)
 * that carry letters but have no dictionary entry.
 */
export function translateBody(html, dict, extra = {}) {
  const toks = tokenize(html);
  const stack = [];          // open elements: { name, skip }
  let inBody = false, skipDepth = 0;
  const missing = new Map();
  const tr = (text) => {
    const key = norm(text);
    if (!key) return null;
    if (Object.prototype.hasOwnProperty.call(dict, key)) return dict[key];
    if (extra.patterns) for (const [re, fn] of extra.patterns) { const m = re.exec(key); if (m) return fn(m); }
    if (/[A-Za-z]{2}/.test(key)) missing.set(key, (missing.get(key) || 0) + 1);
    return null;
  };
  const out = toks.map((tk) => {
    if (tk.t === 'tag') {
      const m = /^<(\/?)([a-zA-Z][^\s>/]*)/.exec(tk.s);
      const closing = m[1] === '/', name = m[2].toLowerCase();
      if (closing) {
        for (let k = stack.length - 1; k >= 0; k--) {
          if (stack[k].name === name) { for (const e of stack.splice(k)) if (e.skip) skipDepth--; break; }
        }
        return tk.s;
      }
      if (name === 'body') inBody = true;
      const selfClosed = /\/>$/.test(tk.s);
      const skipSelf = SKIP.has(name) || hasAttr(tk.s, 'data-no-i18n');
      let s = tk.s;
      if (inBody && skipDepth === 0 && !skipSelf) {
        s = mapAttrs(tk.s, ATTRS, (_a, v) => tr(v));
      }
      if (!VOID.has(name) && !selfClosed) { stack.push({ name, skip: skipSelf }); if (skipSelf) skipDepth++; }
      return s;
    }
    if (tk.t === 'text' && inBody && skipDepth === 0) {
      const text = decode(tk.s);
      const t = tr(text);
      if (t === null) return tk.s;
      const lead = /^\s*/.exec(text)[0], tail = /\s*$/.exec(text)[0];
      return encodeText(lead + t + tail);
    }
    return tk.s;
  });
  return { html: out.join(''), missing };
}
