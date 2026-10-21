Vane — Social Platforms & Verification Specification

Версия документа: 1.4.0

Статус: Утвержденный реестр платформ

Назначение: Полная спецификация подключенных и планируемых социальных сетей, требований к API, процессов авторизации, условий верификации и статусов готовности.
1. Децентрализованные Сети (Без Верификации)
1.1. Bluesky (AT Protocol)

    Назначение: Vane Post & Vane Studio (post.vaneapp.dev, studio.vaneapp.dev).

    Тип авторизации: App Passwords (identifier + App Password).

    Требуется ли регистрация приложения / App Review: Нет.

    Эндпоинты:

        Сессия: POST [https://bsky.social/xrpc/com.atproto.server.createSession](https://bsky.social/xrpc/com.atproto.server.createSession)

        Загрузка медиа/видео: POST [https://bsky.social/xrpc/com.atproto.repo.uploadBlob](https://bsky.social/xrpc/com.atproto.repo.uploadBlob)

        Постинг: POST [https://bsky.social/xrpc/com.atproto.repo.createRecord](https://bsky.social/xrpc/com.atproto.repo.createRecord)

    Лимит символов / медиа: 300 символов, поддержка видеоклипов.

    Статус: Полностью готов и протестирован.

1.2. Mastodon (REST / ActivityPub)

    Назначение: Vane Post (post.vaneapp.dev).

    Тип авторизации: Dynamic App Registration + OAuth 2.0 (read write).

    Требуется ли регистрация приложения / App Review: Нет. Приложение регистрируется на инстансе пользователя на лету.

    Эндпоинты:

        Динамическая регистрация: POST https://{instance}/api/v1/apps

        Публикация статуса: POST https://{instance}/api/v1/statuses

        Загрузка медиа: POST https://{instance}/api/v2/media

    Лимит символов: 500 символов.

    Статус: Полностью готов.

2. Легкие Платформы для Быстрого Роста Аудитории (Без Модерации)
2.1. Reddit API (Постинг и Сообщества)

    Назначение: Vane Post (post.vaneapp.dev) — публикация анонсов, ссылок и апдейтов в тематические сабреддиты (r/buildinpublic, r/webdev, r/SaaS).

    Тип авторизации: OAuth 2.0 (Script App / Web App).

    Требуется ли регистрация приложения / App Review: Нет. Ключи client_id и client_secret выдаются мгновенно в настройках профиля.

    Эндпоинты:

        Авторизация: POST [https://www.reddit.com/api/v1/access_token](https://www.reddit.com/api/v1/access_token)

        Постинг: POST [https://oauth.reddit.com/api/submit](https://oauth.reddit.com/api/submit)

    Статус: Запланирован к интеграции.

2.2. Dev.to API (IT-Сообщество)

    Назначение: Vane Post (post.vaneapp.dev) — кросс-постинг технических статей и dev-логов для разработчиков.

    Тип авторизации: API Key (Personal Access Token).

    Требуется ли регистрация приложения / App Review: Нет. Токен генерируется мгновенно в настройках аккаунта.

    Эндпоинт: POST [https://dev.to/api/articles](https://dev.to/api/articles) (Заголовок api-key).

    Статус: Запланирован к интеграции.

2.3. Discord Webhooks & Bot API

    Назначение: Vane Post & Vane Studio (post.vaneapp.dev, studio.vaneapp.dev) — авто-публикация апдейтов и видеофайлов в Discord-каналы.

    Тип авторизации: Webhook URL или Bot Token.

    Требуется ли регистрация приложения / App Review: Нет. Webhook создается за 5 секунд, бот создается мгновенно без проверок.

    Эндпоинт: POST [https://discord.com/api/webhooks/](https://discord.com/api/webhooks/){id}/{token}

    Статус: Запланирован к интеграции.

3. Экосистема Meta (Facebook Pages & Threads)
3.1. Facebook Pages (Meta Graph API)

    Назначение: Vane Post (post.vaneapp.dev).

    Тип авторизации: OAuth 2.0 via Meta Developer Portal.

    Необходимые Scopes: pages_manage_posts, pages_read_engagement, pages_show_list.

    Статус верификации: Dev Mode — мгновенно; Live Mode — Meta App Review (1–5 дней).

    Эндпоинт: POST [https://graph.facebook.com/v19.0/](https://graph.facebook.com/v19.0/){page-id}/feed

    Статус: Планируется к интеграции.

3.2. Threads (Meta Graph API)

    Назначение: Vane Post (post.vaneapp.dev).

    Тип авторизации: OAuth 2.0 via Meta Developer Portal.

    Необходимые Scopes: threads_basic, threads_content_publish.

    Статус верификации: Dev Mode — мгновенно; Live Mode — Meta App Review (1–5 дней).

    Статус: В процессе настройки в Dev Mode.

4. Pinterest API v5 (Vane Studio)
4.1. Pinterest Video Pins & Idea Pins

    Назначение: Vane Studio (studio.vaneapp.dev) — выгрузка видеороликов (Video Pins) со ссылкой на сайт для SEO-трафика.

    Тип авторизации: OAuth 2.0.

    Необходимые Scopes: pins:read, pins:write, boards:read, boards:write.

    Статус верификации: Sandbox — мгновенно (до 200 req/day); Live — Standard Access Review (2–4 дня).

    Эндпоинты: POST [https://api.pinterest.com/v5/media](https://api.pinterest.com/v5/media), POST [https://api.pinterest.com/v5/pins](https://api.pinterest.com/v5/pins)

    Статус: Запланирован для Vane Studio.

5. Классические Социальные Сети и Мессенджеры
5.1. Telegram (Bot API)

    Назначение: Vane Post & Vane Studio (post.vaneapp.dev, studio.vaneapp.dev).

    Тип авторизации: Bot Token (bot_token).

    Требуется ли регистрация приложения / App Review: Нет.

    Эндпоинты: POST /sendMessage, POST /sendVideo

    Статус: Полностью готов и протестирован.

5.2. X / Twitter (API v2)

    Назначение: Vane Post (post.vaneapp.dev).

    Тип авторизации: OAuth 2.0 PKCE / Bearer Token.

    Статус верификации: Требует настраиваемого App в Developer Portal (Free/Basic Tier).

    Эндпоинт: POST [https://api.twitter.com/2/tweets](https://api.twitter.com/2/tweets)

    Статус: Полностью готов.

5.3. LinkedIn (Community Management API)

    Назначение: Vane Post (post.vaneapp.dev).

    Тип авторизации: OAuth 2.0 (w_member_social).

    Статус верификации: Для личного профиля — мгновенно (0 дней).

    Эндпоинт: POST [https://api.linkedin.com/v2/ugcPosts](https://api.linkedin.com/v2/ugcPosts)

    Статус: Полностью готов.

6. Сводная Матрица Верификационных Статусов

    Telegram (Vane Post / Studio): Доступен сразу (0 дней).

    Bluesky (Vane Post / Studio): Доступен сразу (0 дней).

    Mastodon (Vane Post): Доступен сразу (0 дней).

    Reddit API (Vane Post): Доступен сразу (0 дней).

    Dev.to API (Vane Post): Доступен сразу (0 дней).

    Discord Webhooks (Vane Post / Studio): Доступен сразу (0 дней).


    LinkedIn (Vane Post): Доступен сразу для личных постов (0 дней).

    Pinterest API (Vane Studio): Sandbox — сразу (200 req/day); Live — Review (2–4 дня).

    Facebook Pages (Vane Post): Dev Mode — сразу; Live — Meta App Review (1–5 дней).

    Threads (Vane Post): Dev Mode — сразу; Live — Meta App Review (1–5 дней).

    YouTube API (Vane Studio): Dev Audit Mode; Live — Google Verification (1–2 недели).

    TikTok Direct (Vane Studio): Sandbox Mode; Live — Partner Review (3–7 дней).
