# SEO: что сделано и как обновлять

**Что есть в коде**
- У каждой публичной страницы: `title`, `description`, `canonical`, Open Graph и Twitter-карточка с картинкой `public/assets/og.png` (1200×630), структурированные данные JSON-LD (Organization, WebSite, WebPage, BreadcrumbList; на главной ещё SoftwareApplication для Vane Post и Vane Studio и FAQPage из блока FAQ).
- 11 страниц по сетям `/networks/<сеть>` (Telegram, Bluesky, Mastodon, Discord, Dev.to, LinkedIn, Threads, Reddit, Facebook Pages, YouTube, Instagram Reels) с лимитами, шагами подключения и FAQ (FAQPage). Тексты: `scripts/network-pages.mjs`: когда меняется лимит или сеть в коде, меняй и там.
- Все страницы в `sitemap.xml`; приватные (`/app`, `/studio`, `/admin`, `/login`, `/checkout`, `/copy`) закрыты `noindex`, публичные ссылки на видео отдают `X-Robots-Tag: noindex`.
- Публичные страницы больше не грузят `cdn.tailwindcss.com` (скрипт блокировал отрисовку): стили собираются в `public/assets/site.css` (32 КБ).

**Как обновить**
- Тексты страниц: `site/*.html` или `scripts/network-pages.mjs`, затем `npm run build:pages`.
- Если добавил новые классы Tailwind на публичных страницах: `npm run build:css` (список файлов в `tailwind.config.cjs`).
- Коммить `site/` и `public/` вместе.

**Что сделать вручную (вне кода)**
1. Google Search Console → добавить `https://vaneapp.dev` → Sitemaps → `https://vaneapp.dev/sitemap.xml`; то же в Bing Webmaster Tools.
2. Cloudflare → Rules → Redirect Rules: `www.vaneapp.dev` → `https://vaneapp.dev` (301), чтобы не было дубля.
3. После слияния проверь превью ссылки (https://developers.facebook.com/tools/debug/) и разметку (https://search.google.com/test/rich-results).
4. Трафик дальше растёт от контента и ссылок с других сайтов: гайды («как запланировать пост в Bluesky»), сравнения с Buffer и Hootsuite, Product Hunt, каталоги ИИ-инструментов, dev.to.
