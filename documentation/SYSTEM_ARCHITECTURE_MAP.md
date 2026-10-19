Vane — Comprehensive System Architecture & Interconnections Map

Версия документа: 2.0.0

Статус: Полная мастер-карта архитектуры и взаимосвязей

Назначение: Исчерпывающее текстовое руководство по архитектуре, структурам данных, протоколам безопасности, жизненному циклу постов, системам аутентификации, внешним коннекторам и маркетинговым механизмам платформы Vane.
🧭 1. Глобальный архитектурный обзор

Платформа Vane спроектирована как высоконагруженная, бессерверная (Serverless) Edge-архитектура на базе экосистемы Cloudflare. Система делится на четыре основных слоя:
А. Слой клиентов и источников событий (Client & Ingress Layer)

    Vane Web Dashboard: Одностраничное приложение (SPA) на Cloudflare Pages (vaneapp.dev), взаимодействующее с API через HTTPS REST и Server-Sent Events (SSE).

    Vane for WordPress: Нативный плагин для WordPress (Gutenberg Sidebar Widget), отправляющий анонсы статей при публикации.

    Платформы автоматизации: Make (Integromat) и Zapier, взаимодействующие через RestHooks и API-ключи.

    ИИ-ассистенты: ChatGPT (Custom Actions по OpenAPI v3) и Claude (MCP Server @vane/mcp-server).

    Входящие вебхуки: Resend Webhooks для отслеживания статусов доставки писем и обработка входящих запросов.

Б. Слой API и бизнес-логики (Cloudflare Edge Worker API — api.vaneapp.dev)

    API Gateway & Router: Маршрутизация запросов, валидация DTO, проверка Rate Limits (Cloudflare Rate Limiting).

    Authentication Engine: Валидация JWT-токенов пользователей и проверка SHA-256 хешей API-ключей (cpost_live_... / cvid_live_...).

    Crypto Engine: Модуль шифрования/расшифровки чувствительных токенов соцсетей по стандарту AES-GCM-256 (src/utils/crypto.ts).

    Post Execution Engine: Модуль сборки, адаптации и отправки контента в социальные сети.

В. Слой данных и хранилищ (Cloudflare Data Infrastructure)

    Cloudflare D1 (Relational SQL Database):

        users — профили пользователей, тарифные планы, лимиты.

        api_keys — SHA-256 хеши ключей доступа клиентов.

        social_accounts — зашифрованные токены и параметры подключенных соцсетей.

        posts и post_channels — очереди, статусы и тексты публикаций.

        posts_history — подробные логи попыток отправки и ответы API соцсетей.

        webhooks — подписки сторонних сервисов (Make, Zapier, пользовательские URL).

    Cloudflare R2 (Object Storage): Хранение медиафайлов (изображения, видео), загружаемых пользователями или через API, с выдачей прямых CDN-ссылок (cdn.vaneapp.dev).

    Cloudflare KV (Key-Value Store): Кэширование сессий, временных OAuth-токенов (state), лимитов и токенов авторизации AT Protocol / Mastodon.

    Cloudflare Queues / Cron Triggers: Асинхронная обработка отложенных публикаций и повторные попытки при сбоях (Retry Mechanism).

Г. Слой социальных сетей (Social Delivery Layer)

    Telegram Bot API (HTTP POST multipart/json).

    Bluesky AT Protocol (com.atproto.repo.createRecord via XRPC).

    Mastodon REST API (/api/v1/statuses + OAuth 2.0).

    LinkedIn Share & Community Management API (OAuth 2.0).

    YouTube Data API v3 (Resumable Uploads for Shorts/Videos).

    Threads API & Instagram Graph API (Meta Graph API — Phase 2).

    TikTok Content Posting API (Phase 2).

🔐 2. Безопасность и сквозное шифрование (Security Architecture)
1. Хранение секретов пользователей в D1 (social_accounts)

Секретные ключи (Bot Token Telegram, App Password Bluesky, Access Tokens LinkedIn и Mastodon) никогда не хранятся в открытом виде.

    Алгоритм: AES-GCM-256 с динамическим вектором инициализации (IV).

    Ключ шифрования: env.ENCRYPTION_SECRET (хранится в секретах Cloudflare Worker, недоступен из кода).

    Процесс записи: Исходный токен ➔ Генерация IV ➔ AES-GCM-256 Зашифровка ➔ Запись в D1 полей encrypted_access_token и encryption_iv.

    Процесс чтения: Worker читает encrypted_access_token и encryption_iv из D1 ➔ Расшифровывает в оперативной памяти Worker на время запроса ➔ Выполняет запрос к API соцсети ➔ Очищает память.

    Изоляция: Токены никогда не отдаются в ответе GET /api/v1/channels. Фронтенд получает только id, platform, title, username, avatar_url и status.

2. Безопасность API-ключей клиентов (cpost_live_...)

    При создании ключа в дашборде пользователь получает ключ вид cpost_live_1234567890abcdef... один раз.

    В базу D1 сохраняется только SHA-256 хеш этого ключа.

    При каждом вызове API Worker хеширует входящий Bearer-токен и ищет совпадение в D1.

🔄 3. Детальный жизненный цикл публикации (Post Lifecycle Execution)
Шаг 1: Инициация запроса (Ingress)

Запрос приходит в POST /api/v1/posts/create с телом:
JSON

{
  "text": "Текст анонса...",
  "media_urls": ["https://cdn.vaneapp.dev/img1.jpg"],
  "channels": ["chan_tg_123", "chan_bsky_456"],
  "scheduled_at": null
}

Шаг 2: Аутентификация и валидация

    Worker проверяет API-ключ или JWT-сессию.

    Проверяется соответствие лимитам тарифного плана пользователя в D1.

    В D1 создается запись в таблице posts со статусом processing (или scheduled).

Шаг 3: Адаптация контента под платформы (Format Normalizer)

Worker пропускает текст через адаптеры конкретных платформ:

    Telegram: Сохранение HTML/Markdown форматирования, сплит текста при превышении 4096 символов.

    Bluesky: Сокращение до 300 символов (или создание тред-поста), конвертация ссылок в формат AT Protocol Facets, прикрепление обложек.

    Mastodon: Сокращение до 500 символов, подготовка медиа-вложений через POST /api/v2/media.

    LinkedIn: Преобразование форматирования под требования LinkedIn API, валидация внешних ссылок.

Шаг 4: Параллельная отправка (Execution Phase)

    Worker запрашивает зашифрованные ключи выбранных каналов из D1.

    Crypto Module расшифровывает ключи в памяти.

    Запускаются параллельные асинхронные задачи (Promise.allSettled):

        sendToTelegram(channel, text, media)

        sendToBluesky(channel, text, media)

        sendToMastodon(channel, text, media)

        sendToLinkedIn(channel, text, media)

Шаг 5: Фиксация результатов и вебхуки

    Каждая соцсеть возвращает результат (success: true, external_post_id или success: false, error_message).

    В D1 обновляется статус в posts (published / partially_failed / failed) и создаются подробные записи в posts_history.

    Если у пользователя настроены Webhook Subscriptions (для Make/Zapier/Custom Server), Worker отправляет событие post.published или post.failed на сторонний URL.

📧 4. Почтовая инфраструктура и DNS-маршрутизация (Resend & Cloudflare)
1. Настройка DNS в Cloudflare (vaneapp.dev)

Все записи настроены в режиме DNS only (серые облака) для обеспечения проходимости почтовых протоколов:

    DKIM Record: TXT | Name: resend._domainkey | Content: p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQ...

    SPF Records:

        CNAME | Name: rsend | Content: rsend-euw1.forge.rmta.net

        CNAME | Name: send | Content: send.forge.rmta.net

    DMARC Record: TXT | Name: _dmarc | Content: v=DMARC1; p=none;

2. Модуль отправки писем (Worker Mailer)

    Все сервисные письма (подтверждение регистрации, сброс пароля, алерты о сбоях публикаций) отправляются с адресного пространства noreply@vaneapp.dev.

    Вызов выполняется через REST API Resend (POST [https://api.resend.com/emails](https://api.resend.com/emails)) с аутентификацией через секрет env.RESEND_API_KEY.

🛠️ 5. Сводный реестр всех внешних клиентов и интеграций

    Vane Web Dashboard UI (Cloudflare Pages):

        Протокол: REST API / JSON.

        Авторизация: JWT Cookie / Authorization Bearer.

        Возможности: Управление каналами, аналитический дашборд, создание и планирование постов, генерация API-ключей.

    WordPress Plugin (Vane for WordPress):

        Протокол: REST API (POST /api/v1/posts/create).

        Авторизация: API Key (cpost_live_...).

        Возможности: Gutenberg Sidebar блок, генерация AI-анонсов, автоматический кросс-постинг при публикации записи в WP.

    Make (Integromat) Custom App:

        Протокол: REST API + Instant Webhooks.

        Авторизация: API Key (cpost_live_...).

        Возможности: Модули "Create Post", "List Channels", "Get Post Status", мгновенный триггер "Watch Published Posts".

    Zapier CLI Integration:

        Протокол: REST API (Header Auth).

        Авторизация: API Key (cpost_live_...).

        Возможности: Триггеры New Published Post, Post Failed, действия Create Social Post.

    ChatGPT Connector (Custom GPT & Actions):

        Протокол: OpenAPI v3 Specification (vane-openapi.json).

        Авторизация: API Key / OAuth 2.0.

        Возможности: Автоматическое определение подключенных соцсетей пользователя и публикация сгенерированного ИИ текста прямо из чата.

    Claude Connector (Model Context Protocol / MCP):

        Протокол: Anthropic MCP Protocol (@vane/mcp-server).

        Авторизация: Переменная окружения VANE_API_KEY.

        Возможности: Системные инструменты vane_list_channels и vane_create_post в Claude Desktop и агентах Anthropic.

📑 6. Полный реестр документов проекта Vane

    SOCIAL_PLATFORMS_VERIFICATION.md — Подробнейший регламент верификации, лимитов, типов API и статусов подключений всех социальных сетей (Telegram — Active; Bluesky, Mastodon, LinkedIn, YouTube, Threads, Instagram, TikTok — Phase 1/2).

    AUTOMATION_INTEGRATIONS.md — Полная техническая спецификация коннекторов автоматизации (Make, Zapier, ChatGPT, Claude MCP) и архитектура плагина Vane for WordPress.

    MARKETING_AND_DISTRIBUTION.md — Стратегия привлечения пользователей, воронка Product-Led Growth (PLG), программное SEO, запуск на Product Hunt и каналы дистрибуции.

    VIDEO_ENGINE.md — Архитектура и реализация Vane Studio (Video Engine): отдельный дашборд и API, загрузка кусками в R2, библиотека видео, ключи cvid_.

    SYSTEM_ARCHITECTURE_MAP.md (Данный документ) — Единая текстовая мастер-карта всей архитектуры, потоков данных, безопасности и интеграционных точек Vane.
