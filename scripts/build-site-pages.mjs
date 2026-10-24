#!/usr/bin/env node
/**
 * Builds the marketing pages (Networks, Developers, Integrations, Security, Changelog, About, Partners, Partner: WYSB) from site/*.html
 * into public/ with one shared header and footer, and writes public/sitemap.xml.
 *
 *   npm run build:pages
 *
 * Edit the text in site/<name>.html (the first line is a <!--page {...}--> comment with the slug, title and description), run the
 * command, commit both site/ and public/. Pages are plain static HTML: nothing is built at deploy time.
 * To change the header, footer, navigation or the contact email, edit the SITE object below.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NETWORK_PAGES } from './network-pages.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = {
  origin: 'https://vaneapp.dev',
  /** The public contact address. While it is empty the pages show a yellow [CONTACT EMAIL] mark. */
  email: 'info.vaneapp@gmail.com',
  nav: [
    ['Features', '/#features'],
    ['Networks', '/networks'],
    ['Developers', '/developers'],
    ['Integrations', '/integrations'],
    ['Pricing', '/pricing'],
    ['Partners', '/partners'],
  ],
  footer: [
    ['Product', [['Features', '/#features'], ['Networks', '/networks'], ['Pricing', '/pricing'], ['Changelog', '/changelog']]],
    ['Developers', [['API', '/developers'], ['Integrations', '/integrations'], ['OpenAPI spec', '/api/v1/openapi.json'], ['Security', '/security']]],
    ['Company', [['About', '/about'], ['Partners', '/partners'], ['WYSB', '/partners/wysb'], ['Contact', '/about#contact']]],
    ['Legal', [['Privacy', '/privacy'], ['Terms', '/terms'], ['Data deletion', '/data-deletion']]],
  ],
};
const PAGES_IN_SITEMAP = ['/', '/pricing', '/networks', ...NETWORK_PAGES.map((n) => `/networks/${n.id}`), '/developers', '/integrations', '/security', '/changelog', '/about', '/partners', '/partners/wysb', '/privacy', '/terms', '/data-deletion'];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** The address is NOT written into the page: it is put together in the browser (assets/nav-auth.js) from two halves, so mail harvesters reading the HTML never see it. */
const [mailUser, mailHost] = SITE.email.split('@');
const emailHtml = SITE.email ? `<span data-mail-u="${mailUser}" data-mail-h="${mailHost}"><a href="/about#contact">the contact form</a></span>` : '<span class="todo">[CONTACT EMAIL]</span>';
const mailto = '/about#contact';   // every "Tell us" / "Get in touch" button opens the contact form

const OG_IMAGE = `${SITE.origin}/assets/og.png`;
const ldTag = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`;
const ORGANIZATION = { '@type': 'Organization', '@id': `${SITE.origin}/#org`, name: 'Vane', url: SITE.origin, logo: `${SITE.origin}/assets/logo.svg`, parentOrganization: { '@type': 'Organization', name: 'WYSB', url: 'https://wysb.eu' } };

function layout({ slug, title, desc, body, crumbs = [], faq = [], ogTitle }) {
  const path = '/' + slug;
  const url = SITE.origin + path;
  const nav = SITE.nav.map(([label, href]) => {
    const current = href === path ? ' aria-current="page"' : '';
    return `<a href="${href}"${current} class="nav-link">${label}</a>`;
  }).join('');
  const cols = SITE.footer.map(([h, links]) =>
    `<div><p class="eyebrow">${h}</p><ul class="mt-3 space-y-2 text-sm">${links.map(([l, href]) => `<li><a href="${href}" class="text-white/55 transition-colors hover:text-white">${l}</a></li>`).join('')}</ul></div>`).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)} — Vane</title>
  <meta name="description" content="${esc(desc)}" />
  <meta name="robots" content="index, follow" />
  <meta name="theme-color" content="#070708" />
  <link rel="canonical" href="${url}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Vane" />
  <meta property="og:title" content="${esc(title)} — Vane" />
  <meta property="og:description" content="${esc(desc)}" />
  <meta property="og:url" content="${url}" />
  <meta property="og:image" content="${OG_IMAGE}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="Vane: schedule once, post everywhere" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)} — Vane" />
  <meta name="twitter:description" content="${esc(desc)}" />
  <meta name="twitter:image" content="${OG_IMAGE}" />
  ${ldTag({ '@context': 'https://schema.org', '@graph': [
    ORGANIZATION,
    { '@type': 'WebSite', '@id': `${SITE.origin}/#site`, url: SITE.origin, name: 'Vane', publisher: { '@id': `${SITE.origin}/#org` } },
    { '@type': 'WebPage', '@id': `${url}#page`, url, name: `${title} — Vane`, description: desc, isPartOf: { '@id': `${SITE.origin}/#site` }, publisher: { '@id': `${SITE.origin}/#org` } },
    { '@type': 'BreadcrumbList', itemListElement: [{ name: 'Vane', item: SITE.origin + '/' }, ...crumbs.map(([n, h]) => ({ name: n, item: SITE.origin + h })), { name: title, item: url }].map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: c.item })) },
    ...(faq.length ? [{ '@type': 'FAQPage', mainEntity: faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) }] : []),
  ] })}
  <link rel="icon" href="/favicon.ico" sizes="32x32" />
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=Silkscreen:wght@400;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/assets/site.css?v=20261024a" />
  <link rel="stylesheet" href="/assets/vane.css?v=20261017" />
  <style>
    html { scroll-behavior: smooth; scroll-padding-top: 5rem; }
    body { font-family: 'Geist', -apple-system, BlinkMacSystemFont, sans-serif; -webkit-font-smoothing: antialiased; }
    .eyebrow { font-size: .72rem; font-weight: 500; letter-spacing: .14em; text-transform: uppercase; color: rgba(255,255,255,.4); }
    .nav-link { border-radius: 9999px; padding: .375rem 1rem; font-size: .875rem; font-weight: 500; color: rgba(255,255,255,.75); transition: background-color .2s, color .2s; }
    .nav-link:hover { background: rgba(255,255,255,.1); color: #fff; }
    .nav-link[aria-current="page"] { background: rgba(255,255,255,.12); color: #fff; }
    .btn-grad { background: linear-gradient(to bottom, #2B2B2B, #101010); }
    .page h1 { font-size: clamp(2rem, 5vw, 3.4rem); font-weight: 600; line-height: 1.08; letter-spacing: -.02em; }
    .page h2 { font-size: clamp(1.4rem, 3vw, 2rem); font-weight: 600; line-height: 1.15; letter-spacing: -.015em; scroll-margin-top: 5rem; }
    .page h3 { font-size: 1.05rem; font-weight: 600; }
    .lead { max-width: 40rem; font-size: 1.05rem; line-height: 1.7; color: rgba(255,255,255,.62); }
    .page p, .page li { line-height: 1.7; }
    .copy { font-size: .93rem; color: rgba(255,255,255,.65); }
    .copy b, .copy strong { color: #fff; font-weight: 600; }
    .copy a, .link { color: #fff; text-decoration: underline; text-underline-offset: 3px; text-decoration-color: rgba(255,255,255,.3); }
    .copy a:hover, .link:hover { text-decoration-color: #fff; }
    .copy code, code.i { font-size: .82rem; padding: .05rem .35rem; border-radius: 6px; background: rgba(255,255,255,.07); color: rgba(255,255,255,.88); }
    .card { border-radius: 1.5rem; padding: 1.5rem; }
    @media (min-width: 640px) { .card { padding: 1.75rem; } }
    .check li { position: relative; padding-left: 1.5rem; margin-top: .6rem; font-size: .92rem; color: rgba(255,255,255,.72); }
    .check li::before { content: '✓'; position: absolute; left: 0; color: #34d399; }
    .badge { display: inline-flex; align-items: center; gap: .35rem; border-radius: 9999px; padding: .15rem .6rem; font-size: .68rem; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; white-space: nowrap; }
    .badge-live { background: rgba(52,211,153,.14); color: #6ee7b7; }
    .badge-next { background: rgba(251,191,36,.14); color: #fcd34d; }
    .badge-soon { background: rgba(255,255,255,.1); color: rgba(255,255,255,.65); }
    .table-wrap { overflow-x: auto; border: 1px solid rgba(255,255,255,.08); border-radius: 1.25rem; }
    .tbl { width: 100%; min-width: 40rem; border-collapse: collapse; }
    .tbl th, .tbl td { padding: .8rem 1rem; text-align: left; vertical-align: top; font-size: .86rem; line-height: 1.6; border-bottom: 1px solid rgba(255,255,255,.06); color: rgba(255,255,255,.66); }
    .tbl th { font-size: .68rem; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: rgba(255,255,255,.4); background: rgba(255,255,255,.03); }
    .tbl tr:last-child td { border-bottom: 0; }
    .tbl td:first-child { color: #fff; font-weight: 500; white-space: nowrap; }
    pre.code { overflow-x: auto; padding: 1.15rem 1.25rem; font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace; font-size: .8rem; line-height: 1.7; color: rgba(255,255,255,.82); }
    .cm { color: rgba(255,255,255,.35); } .st { color: #6ee7b7; } .kw { color: #7dd3fc; }
    .todo { background: rgba(251,191,36,.14); color: #fcd34d; border-radius: 6px; padding: 0 .35rem; }
    .reveal { opacity: 0; transform: translateY(14px); transition: opacity .6s ease, transform .6s ease; }
    .reveal.in { opacity: 1; transform: none; }
    @media (prefers-reduced-motion: reduce) { .reveal { opacity: 1; transform: none; transition: none; } html { scroll-behavior: auto; } }
    details.menu > summary { list-style: none; cursor: pointer; }
    details.menu > summary::-webkit-details-marker { display: none; }
  </style>
</head>

<body class="min-h-screen overflow-x-hidden bg-[#070708] text-white">
  <div class="fixed inset-0 -z-0 bg-gradient-to-b from-white/[0.05] via-transparent to-transparent" aria-hidden="true"></div>
  <div class="relative z-10 flex min-h-screen flex-col">
    <header class="sticky top-0 z-40 border-b border-white/[0.06] bg-[#070708]/70 backdrop-blur-xl">
     <div class="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-3 sm:px-8">
      <a href="/" class="flex items-center gap-2" aria-label="Vane home">
        <img src="/assets/logo.svg" alt="" width="31" height="30" />
        <span class="text-lg font-semibold">vane</span>
      </a>
      <div class="hidden items-center gap-3 md:flex">
        <nav class="flex items-center gap-1 rounded-full bg-white/10 px-1.5 py-1.5 backdrop-blur-lg" aria-label="Main">${nav}</nav>
        <a href="/login" data-auth-link class="btn-grad rounded-full px-5 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90">Log in</a>
      </div>
      <details class="menu relative md:hidden">
        <summary class="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 backdrop-blur-lg" aria-label="Menu">
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
        </summary>
        <div class="absolute right-0 top-12 w-56 rounded-2xl border border-white/10 bg-black/90 p-2 shadow-2xl backdrop-blur-xl">
          ${SITE.nav.map(([label, href]) => `<a href="${href}" class="block rounded-xl px-4 py-3 text-sm font-medium text-white/80 hover:bg-white/10 hover:text-white">${label}</a>`).join('')}
          <a href="/login" data-auth-link class="btn-grad mt-1 block rounded-xl px-4 py-3 text-center text-sm font-medium text-white">Log in</a>
        </div>
      </details>
     </div>
    </header>

    <main class="page mx-auto w-full max-w-5xl flex-1 px-5 pb-24 pt-6 sm:px-8 sm:pt-10">
${body}
    </main>

    <footer class="border-t border-white/5 px-5 py-12 sm:px-8">
      <div class="mx-auto max-w-6xl">
        <div class="grid grid-cols-2 gap-8 sm:grid-cols-4">${cols}</div>
        <div class="mt-10 flex flex-col items-center justify-between gap-3 border-t border-white/5 pt-6 text-xs text-white/35 sm:flex-row">
          <p>© <span id="year"></span> Vane · vaneapp.dev · Powered by <a href="https://wysb.eu" target="_blank" rel="noopener" class="font-medium text-white/50 transition-colors hover:text-white">WYSB</a></p>
          <p><a href="/privacy" class="hover:text-white">Privacy</a> · <a href="/terms" class="hover:text-white">Terms</a></p>
        </div>
      </div>
    </footer>
  </div>
  <script>
    document.getElementById('year').textContent = new Date().getFullYear();
    (function () {
      var els = document.querySelectorAll('.reveal');
      if (!('IntersectionObserver' in window)) { els.forEach(function (e) { e.classList.add('in'); }); return; }
      var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }); }, { threshold: .08 });
      els.forEach(function (e) { io.observe(e); });
    })();
  </script>
  <script src="/assets/nav-auth.js?v=20261023a"></script>
</body>
</html>
`;
}

const dir = join(root, 'site');
const built = [];
for (const file of readdirSync(dir).filter((f) => f.endsWith('.html')).sort()) {
  const src = readFileSync(join(dir, file), 'utf8');
  const m = /^<!--page (\{.*?\})-->\s*/s.exec(src);
  if (!m) throw new Error(`${file}: the first line must be <!--page {"slug":"…","title":"…","desc":"…"}-->`);
  const meta = JSON.parse(m[1]);
  const body = src.slice(m[0].length).replaceAll('{{EMAIL}}', emailHtml).replaceAll('{{MAILTO}}', mailto);
  const out = join(root, 'public', meta.slug + '.html');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, layout({ ...meta, body }));
  built.push('/' + meta.slug);
}

// One page per network (data in scripts/network-pages.mjs)
const BADGE = { live: ['badge-live', 'Live'], next: ['badge-next', 'Next'] };
for (const n of NETWORK_PAGES) {
  const [cls, label] = BADGE[n.status];
  const others = NETWORK_PAGES.filter((o) => o.id !== n.id);
  const body = `      <section class="reveal">
        <nav class="text-xs text-white/40" aria-label="Breadcrumb"><a href="/networks" class="hover:text-white">Networks</a> / ${esc(n.name)}</nav>
        <p class="eyebrow mt-4">${esc(n.product)} · <span class="badge ${cls}">${label}</span></p>
        <h1 class="mt-3 max-w-3xl">${esc(n.h1)}</h1>
        <p class="lead mt-5">${esc(n.lead)}</p>
        <div class="mt-7 flex flex-wrap gap-3">
          <a href="/login?mode=register&amp;product=${n.product === 'Vane Studio' ? 'studio' : 'post'}" class="btn-grad rounded-full px-6 py-3 text-sm font-medium text-white hover:opacity-90">Start free</a>
          <a href="/pricing" class="rounded-full bg-white/10 px-6 py-3 text-sm font-medium text-white/85 hover:bg-white/15">See pricing</a>
        </div>
        ${n.status === 'next' ? '<p class="copy mt-5">This network is built and is switched on as soon as it approves Vane. The Channels screen always shows whether it is open for you.</p>' : ''}
      </section>

      <section class="reveal mt-14 grid gap-5 md:grid-cols-2">
        <div class="glass-d card"><h2>What Vane publishes</h2><ul class="check mt-3">${n.publishes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
        <div class="glass-d card"><h2>Limits and rules</h2><div class="table-wrap mt-4"><table class="tbl" style="min-width:0"><tbody>${n.limits.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody></table></div></div>
      </section>

      <section class="reveal mt-14">
        <h2>How to connect ${esc(n.name)}</h2>
        <ol class="copy mt-4 list-decimal space-y-2 pl-5">${n.connect.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
        <p class="copy mt-4">Tokens and keys are stored encrypted and you can disconnect at any time. <a href="/security">How we protect them</a>.</p>
      </section>

      <section class="reveal mt-14">
        <h2>Questions about ${esc(n.name)}</h2>
        <div class="mt-5 grid gap-4">${n.faq.map(([q, a]) => `<div class="glass-d card"><h3>${esc(q)}</h3><p class="copy mt-2">${esc(a)}</p></div>`).join('')}</div>
      </section>

      <section class="reveal mt-14">
        <h2>More networks</h2>
        <p class="copy mt-4">${others.map((o) => `<a href="/networks/${o.id}" class="mr-4 inline-block">${esc(o.name)}</a>`).join('')}<a href="/networks" class="inline-block">All networks</a></p>
      </section>`;
  const meta = { slug: `networks/${n.id}`, title: n.product === 'Vane Studio' ? `${n.name} publishing` : `${n.name} scheduler`, desc: `${n.lead} Flat pricing, no per-channel fees.`.slice(0, 300), body, crumbs: [['Networks', '/networks']], faq: n.faq };
  const out = join(root, 'public', meta.slug + '.html');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, layout(meta));
  built.push('/' + meta.slug);
}

// ───────────── the hand-written pages: the landing page and the legal pages get the same social and structured-data tags ─────────────
const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
function injectSeo(file, { path, title, desc, canonical, extra = [] }) {
  const f = join(root, 'public', file);
  let html = readFileSync(f, 'utf8');
  const url = SITE.origin + path;
  const graph = [ORGANIZATION, { '@type': 'WebSite', '@id': `${SITE.origin}/#site`, url: SITE.origin, name: 'Vane', publisher: { '@id': `${SITE.origin}/#org` } },
    { '@type': 'WebPage', '@id': `${url}#page`, url, name: title, description: desc, isPartOf: { '@id': `${SITE.origin}/#site` } }, ...extra];
  if (path !== '/') graph.push({ '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Vane', item: SITE.origin + '/' }, { '@type': 'ListItem', position: 2, name: title, item: url }] });
  const block = `<!-- seo:start (generated by scripts/build-site-pages.mjs) -->
  ${canonical ? `<link rel="canonical" href="${url}" />\n  ` : ''}<meta property="og:site_name" content="Vane" />
  <meta property="og:image" content="${OG_IMAGE}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="Vane: schedule once, post everywhere" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(desc)}" />
  <meta name="twitter:image" content="${OG_IMAGE}" />
  ${ldTag({ '@context': 'https://schema.org', '@graph': graph })}
  <!-- seo:end -->`;
  if (html.includes('<!-- seo:start')) html = html.replace(/<!-- seo:start[\s\S]*?<!-- seo:end -->/, () => block);
  else html = html.replace('</head>', () => `  ${block}\n</head>`);
  writeFileSync(f, html);
}
{
  const idx = readFileSync(join(root, 'public', 'index.html'), 'utf8');
  const faq = [...idx.matchAll(/<summary[^>]*>([\s\S]*?)<span class="faq-plus[\s\S]*?<\/summary>\s*<(?:p|div)[^>]*>([\s\S]*?)<\/(?:p|div)>\s*<\/details>/g)].map((m) => [strip(m[1]), strip(m[2])]).filter(([q, a]) => q && a);
  const titleIdx = 'Vane — Schedule once. Post everywhere.';
  const descIdx = 'Schedule once and post to Telegram, LinkedIn, Threads, Bluesky, Mastodon, Discord, Dev.to and more, plus video with Vane Studio. Flat pricing from $9.99/mo, unlimited channels, built-in AI and a REST API. Start free, no card required.';
  injectSeo('index.html', { path: '/', title: titleIdx, desc: descIdx, canonical: true, extra: [
    { '@type': 'SoftwareApplication', '@id': `${SITE.origin}/#post`, name: 'Vane Post', url: SITE.origin, applicationCategory: 'BusinessApplication', operatingSystem: 'Web', description: 'Social media scheduler: write once, publish to many networks at the time you choose, with built-in AI and a REST API.', offers: { '@type': 'AggregateOffer', priceCurrency: 'USD', lowPrice: '0', highPrice: '9.99' }, publisher: { '@id': `${SITE.origin}/#org` } },
    { '@type': 'SoftwareApplication', '@id': `${SITE.origin}/#studio`, name: 'Vane Studio', url: SITE.origin, applicationCategory: 'MultimediaApplication', operatingSystem: 'Web', description: 'Video library and publisher: upload a video once and publish it to the video networks you connect.', publisher: { '@id': `${SITE.origin}/#org` } },
    ...(faq.length ? [{ '@type': 'FAQPage', mainEntity: faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) }] : []),
  ] });
  let html = readFileSync(join(root, 'public', 'index.html'), 'utf8');
  html = html.replace(/(<meta name="description" content=")[^"]*(")/, (_, a, b) => a + esc(descIdx) + b).replace(/(<meta property="og:description" content=")[^"]*(")/, (_, a, b) => a + esc(descIdx) + b);
  writeFileSync(join(root, 'public', 'index.html'), html);
  console.log(`index.html: ${faq.length} FAQ entries in structured data`);
}
for (const [file, path, title, desc] of [['privacy.html', '/privacy', 'Privacy Policy — Vane', 'How Vane handles your data.'], ['terms.html', '/terms', 'Terms of Service — Vane', 'The terms that apply when you use Vane.'], ['data-deletion.html', '/data-deletion', 'Data deletion — Vane', 'How to delete your Vane data.']]) {
  const h = readFileSync(join(root, 'public', file), 'utf8');
  const d = /<meta name="description" content="([^"]*)"/.exec(h)?.[1] ?? desc;
  injectSeo(file, { path, title, desc: d.replace(/&quot;/g, '"'), canonical: false });
  let t = readFileSync(join(root, 'public', file), 'utf8');
  if (!t.includes('property="og:title"')) t = t.replace('<!-- seo:start', `<meta property="og:type" content="website" />\n  <meta property="og:title" content="${esc(title)}" />\n  <meta property="og:description" content="${esc(d.replace(/&quot;/g, '"'))}" />\n  <meta property="og:url" content="${SITE.origin}${path}" />\n  <!-- seo:start`);
  writeFileSync(join(root, 'public', file), t);
}

const missing = built.filter((p) => !PAGES_IN_SITEMAP.includes(p));
if (missing.length) throw new Error('Add to PAGES_IN_SITEMAP: ' + missing.join(', '));
const today = new Date().toISOString().slice(0, 10);
writeFileSync(join(root, 'public', 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${PAGES_IN_SITEMAP.map((p) => `  <url><loc>${SITE.origin}${p === '/' ? '/' : p}</loc><lastmod>${today}</lastmod></url>`).join('\n')}\n</urlset>\n`);
console.log(`built ${built.length} pages: ${built.join(' ')}\nwrote public/sitemap.xml`);
