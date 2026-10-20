# Vane — Social Platforms & Verification Specification

**Версия документа:** 1.3.0

**Статус:** Утвержденный реестр платформ

**Назначение:** Полная спецификация подключенных и планируемых социальных сетей, требований к API, процессов авторизации, условий верификации и статусов готовности.

---

## 1. Децентрализованные Сети (Без Верификации)

### 1.1. Bluesky (AT Protocol)

* **Назначение:** Vane Post (`post.vaneapp.dev`).
* **Тип авторизации:** App Passwords (`identifier` + `App Password`).
* **Требуется ли регистрация приложения / App Review:** Нет. Сеть полностью открытая.
* **Эндпоинты:**
* Сессия: `POST [https://bsky.social/xrpc/com.atproto.server.createSession](https://bsky.social/xrpc/com.atproto.server.createSession)`
* Постинг: `POST [https://bsky.social/xrpc/com.atproto.repo.createRecord](https://bsky.social/xrpc/com.atproto.repo.createRecord)`


* **Лимит символов:** 300 символов.
* **Статус:** Полностью готов и протестирован.

### 1.2. Mastodon (REST / ActivityPub)

* **Назначение:** Vane Post (`post.vaneapp.dev`).
* **Тип авторизации:** Dynamic App Registration + OAuth 2.0 (`read write`).
* **Требуется ли регистрация приложения / App Review:** Нет. Приложение Vane регистрируется на инстансе пользователя на лету через `POST /api/v1/apps`.
* **Эндпоинты:**
* Динамическая регистрация: `POST https://{instance}/api/v1/apps`
* Публикация статуса: `POST https://{instance}/api/v1/statuses`
* Загрузка медиа: `POST https://{instance}/api/v2/media`


* **Лимит символов:** 500 символов (по умолчанию на большинстве инстансов).
* **Статус:** Полностью готов.

---

## 2. Экосистема Meta (Facebook Pages & Threads)

### 2.1. Facebook Pages (Meta Graph API)

* **Назначение:** Vane Post (`post.vaneapp.dev`) — публикации текстов, ссылок с Open Graph превью и изображений на бизнес-страницах.
* **Тип авторизации:** OAuth 2.0 via Meta Developer Portal.
* **Необходимые Scopes (Права):**
* `pages_manage_posts` — публикация и редактирование постов от имени страницы.
* `pages_read_engagement` — просмотр вовлеченности.
* `pages_show_list` — выбор доступных бизнес-страниц пользователя.


* **Статус верификации (App Review):**
* **Development Mode (Тестирование):** Без модерации. Работает мгновенно для личных страниц администратора приложения.
* **Live Mode (Публичный запуск):** Требуется Meta App Review (видеозапись авторизации и отправки поста + Privacy Policy). Проверка занимает 1–5 рабочих дней.


* **Эндпоинт публикации:** `POST [https://graph.facebook.com/v19.0/](https://graph.facebook.com/v19.0/){page-id}/feed`
* **Статус:** Планируется к интеграции (Единый контур с Threads в Meta Portal).

### 2.2. Threads (Meta Graph API)

* **Назначение:** Vane Post (`post.vaneapp.dev`).
* **Тип авторизации:** OAuth 2.0 via Meta Developer Portal.
* **Необходимые Scopes:** `threads_basic`, `threads_content_publish`.
* **Статус верификации (App Review):**
* **Development Mode:** Без модерации (добавление тестеров в панели Meta).
* **Live Mode:** Прохождение Meta App Review (скринкаст работы авторизации и публикации).


* **Статус:** В процессе настройки в Development Mode.

---

## 3. Pinterest API v5 (Vane Studio)

### 3.1. Pinterest Video Pins & Idea Pins

* **Назначение:** Vane Studio (`studio.vaneapp.dev`) — выгрузка коротких видеороликов (Shorts/Reels) в формате Video Pins со ссылкой на сайт/продукт для генерации SEO-трафика.
* **Тип авторизации:** OAuth 2.0 (Pinterest Developers Portal).
* **Необходимые Scopes:** `pins:read`, `pins:write`, `boards:read`, `boards:write`.
* **Статус верификации:**
* **Sandbox / Trial Access (Тестирование):** Мгновенно без модерации. Выдается лимит до 200 запросов/день и привязка до 5 тестовых аккаунтов. Идеально для отладки R2-видеозагрузок.
* **Standard Access (Публичный запуск):** Заполнение формы с описанием продукта и ссылкой на рабочий сайт. Рассмотрение занимает 2–4 рабочих дня.


* **Эндпоинты:**
* Регистрация загрузки медиа: `POST [https://api.pinterest.com/v5/media](https://api.pinterest.com/v5/media)`
* Создание Пина: `POST [https://api.pinterest.com/v5/pins](https://api.pinterest.com/v5/pins)`


* **Статус:** Запланирован для Vane Studio (Sandbox доступ).

---

## 4. Классические Социальные Сети и Мессенджеры

### 4.1. Telegram (Bot API)

* **Назначение:** Vane Post (`post.vaneapp.dev`).
* **Тип авторизации:** Bot Token (`bot_token`).
* **Требуется ли регистрация приложения / App Review:** Нет. Токен создается мгновенно через `@BotFather`.
* **Эндпоинт:** `POST [https://api.telegram.org/bot](https://api.telegram.org/bot){token}/sendMessage`
* **Статус:** Полностью готов и протестирован.

### 4.2. X / Twitter (API v2)

* **Назначение:** Vane Post (`post.vaneapp.dev`).
* **Тип авторизации:** OAuth 2.0 PKCE / Bearer Token.
* **Статус верификации:** Требует настраиваемого App в Developer Portal с доступами Free/Basic Tier.
* **Эндпоинт:** `POST [https://api.twitter.com/2/tweets](https://api.twitter.com/2/tweets)`
* **Статус:** Полностью готов.

### 4.3. LinkedIn (Community Management API)

* **Назначение:** Vane Post (`post.vaneapp.dev`).
* **Тип авторизации:** OAuth 2.0 (`w_member_social`).
* **Статус верификации:** Для личных постов доступ открыт сразу. Для публикации от имени сторонних компании требуется дополнительное согласование.
* **Эндпоинт:** `POST [https://api.linkedin.com/v2/ugcPosts](https://api.linkedin.com/v2/ugcPosts)`
* **Статус:** Полностью готов.

---

## 5. Сводная Матрица Верификационных Статусов

* **Telegram (Vane Post):** Доступен сразу в Dev и Live режимах. Модерация: 0 дней (через BotFather).
* **Bluesky (Vane Post):** Доступен сразу в Dev и Live режимах. Модерация: 0 дней (AT Protocol).
* **Mastodon (Vane Post):** Доступен сразу в Dev и Live режимах. Модерация: 0 дней (Dynamic OAuth).
* **LinkedIn (Vane Post):** Доступен сразу в Dev и Live режимах (для постов личного профиля). Модерация: 0 дней.
* **Facebook Pages (Vane Post):** В Dev Mode доступен сразу; в Live требует Meta App Review. Модерация: 1–5 дней.
* **Threads (Vane Post):** В Dev Mode доступен сразу; в Live требует Meta App Review. Модерация: 1–5 дней.
* **Pinterest API (Vane Studio):** В Sandbox доступен сразу (до 200 req/day); в Live требует Standard Access Review. Модерация: 2–4 дня.
* **YouTube API (Vane Studio):** В Dev Audit Mode; в Live требует Google Cloud App Verification. Модерация: 1–2 недели.
* **TikTok Direct (Vane Studio):** В Sandbox Mode; в Live требует TikTok Partner Review. Модерация: 3–7 дней.
