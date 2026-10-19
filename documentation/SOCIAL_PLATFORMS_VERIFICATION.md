# Vane — Social Networks Integration & API Verification Guide

**Версия документа:** 1.1.0  
**Статус:** Рабочий регламент подключений  
**Назначение:** Полный реестр требований, типов авторизации и процессов верификации API для подключения социальных сетей к Vane.

---

## 📌 Текущий статус готовности и приоритеты

> ⚠️ **Текущий статус разработки:** На данный момент в бэкенде и дашборде полностью реализован и готов к работе **ТОЛЬКО Telegram**. Все остальные платформы находятся на этапе разработки, настройки API-консолей и прохождения верификаций.

| Платформа | Статус в Vane | Тип авторизации | Требует верификацию компании? | Время получения API |
| :--- | :--- | :--- | :--- | :--- |
| **Telegram** | 🟢 **ACTIVE (Готово)** | Bot API (Token + Chat ID) | ❌ Нет | Мгновенно (0 мин) |
| **Bluesky** | 🟡 **Phase 1 (В разработке)** | AT Protocol (App Passwords) | ❌ Нет | Мгновенно (0 мин) |
| **Mastodon** | 🟡 **Phase 1 (В разработке)** | OAuth 2.0 (Dynamic App Reg) | ❌ Нет | Мгновенно (0 мин) |
| **LinkedIn** | 🟢 **Код готов** (личные профили; ждёт ключей и ревью) | OAuth 2.0 (Community Management API) | ⚠️ Частично (Developer Portal) | 1–3 дня |
| **YouTube (Shorts/Full)**| 🟡 **Phase 1 / Phase 2** | OAuth 2.0 (YouTube Data API v3) | ⚠️ Требуется Google Brand Verification | 3–14 дней |
| **Threads** | 🟢 **Код готов** (ждёт ключей и App Review) | Meta Graph API (Threads API) | 🟢 Нужен Meta Verified Developer App | 5–14 дней |
| **Instagram Reels** | 🔴 **Phase 2 (Pending)** | Meta Graph API (Content Publishing) | 🔴 Нужен Meta Business Verification + Review | 7–21 день |
| **TikTok** | 🔴 **Phase 2 (Pending)** | TikTok Content Posting API | 🔴 Нужен TikTok Developer Business Review | 7–21 день |

---

## 1. Telegram (Каналы и Группы)
* **Текущий статус в Vane:** 🟢 **ACTIVE (Работает)**
* **Тип API:** Telegram Bot API
* **Сложность:** Минимальная

### Порядок работы:
1. Используется официальный бот Vane, созданный через `@BotFather`.
2. **Механика подключения пользователем:**
   - Пользователь добавляет бота `@vane_post_bot` в свой канал или группу в качестве администратора с правом «Публикация сообщений».
   - В дашборде Vane указывает `Chat ID` (`@channel_name` или числовой ID вида `-100...`).
   - Бэкенд проверяет права бота через запрос `getChatMember` и сохраняет активный канал.

---

## 2. Bluesky
* **Текущий статус в Vane:** 🟡 **Phase 1 (Запланировано к подключению)**
* **Тип API:** AT Protocol (`com.atproto.repo.createRecord`)
* **Сложность:** Низкая (Не требует одобрения от компании)

### Требования для подключения:
1. Платформа открыта и не требует модерации приложения со стороны команды Bluesky.
2. **Механика подключения пользователем:**
   - Пользователь заходит в настройки профиля Bluesky ➔ `Settings` ➔ `Advanced` ➔ `App Passwords`.
   - Создает отдельный **App Password** специально для Vane.
   - Вводит свой Handle (например, `user.bsky.social`) и сгенерированный `App Password` в дашборде Vane.
3. **Бэкенд-валидация:**
   - Worker отправляет POST-запрос к `https://bsky.social/xrpc/com.atproto.server.createSession`.
   - При успешном ответе `App Password` шифруется алгоритмом **AES-GCM-256** и сохраняется в D1.

---

## 3. Mastodon
* **Текущий статус в Vane:** 🟡 **Phase 1 (Запланировано к подключению)**
* **Тип API:** REST API / OAuth 2.0 (Dynamic Client Registration)
* **Сложность:** Низкая (Децентрализованная сеть)

### Требования для подключения:
1. Так как Mastodon состоит из независимых инстансов (`mastodon.social`, `fosstodon.org` и т.д.), единого Developer Portal не существует.
2. **Механика подключения пользователем:**
   - Пользователь вводит адрес своего инстанса (например, `https://mastodon.social`).
   - Бэкенд Vane делает динамический запрос `POST /api/v1/apps` к этому инстансу для получения `client_id` и `client_secret`.
   - Пользователь перенаправляется на страницу OAuth-авторизации своего инстанса и подтверждает доступ.
3. Полученный Access Token шифруется в D1 через **AES-GCM-256**.

---

## 4. LinkedIn (Профили и Страницы Компаний)
* **Текущий статус в Vane:** 🟡 **Phase 1 (Настройка Developer Portal)**
* **Тип API:** OAuth 2.0 (Share API / Community Management API)
* **Сложность:** Средняя

### Требования для Vane Developer Portal:
1. Зарегистрировать приложение в [LinkedIn Developers](https://www.linkedin.com/developers/).
2. Подключить продукты:
   - **Share on LinkedIn** (для личных профилей).
   - **Community Management API** (для публичных страниц компаний).
3. Прописать Redirect URL: `https://vaneapp.dev/api/channels/linkedin/callback`.
4. **Необходимые Scopes:** `openid`, `profile`, `w_member_social` (личные профили, запрашиваются сейчас). `w_organization_social` для Страниц компаний добавляется только после одобрения Community Management API.
5. Подробная настройка, чек-лист и сценарий скринкаста: `documentation/LINKEDIN_THREADS_SETUP.md`.

---

## 5. YouTube & YouTube Shorts
* **Текущий статус в Vane:** 🟡 **Phase 1 / Phase 2 (Подготовка к Video Engine)**
* **Тип API:** YouTube Data API v3 (Resumable Uploads)
* **Сложность:** Высокая (Brand Verification)

### Требования для Google Cloud Console:
1. Создать проект в Google Cloud Console и включить **YouTube Data API v3**.
2. Настроить **OAuth consent screen**:
   - Название, логотип Vane, контактный Email support.
   - Ссылки на `Privacy Policy` и `Terms of Service` на домене `vaneapp.dev`.
3. Запросить Scope: `https://www.googleapis.com/auth/youtube.upload`.
4. **Прохождение аудита Google:** Подача заявки на увеличение квот (Quota Increase) и запись скринкаста работы UI Vane.

---

## 6. Threads (Meta)
* **Текущий статус в Vane:** 🟠 **Phase 2 (Public Beta API)**
* **Тип API:** Meta Graph API for Threads
* **Сложность:** Высокая

### Требования для Meta for Developers:
1. Создать приложение типа **Business** в [Meta Developer Dashboard](https://developers.facebook.com/).
2. Включить продукт **Threads API**.
3. Запросить разрешения: `threads_basic`, `threads_content_publish`. Callback-адреса (redirect, deauthorize, data deletion) и чек-лист: `documentation/LINKEDIN_THREADS_SETUP.md`.
4. Пройти **App Review** с предоставлением тестового видео публикации.

---

## 7. Instagram Reels & Feed
* **Текущий статус в Vane:** 🔴 **Phase 2 (Require Business Verification)**
* **Тип API:** Instagram Graph API
* **Сложность:** Очень высокая

### Требования и ограничения:
1. Поддерживаются **только Instagram Business / Creator аккаунты**, привязанные к Facebook Page.
2. Прохождение **Meta Business Verification** (загрузка юридических документов, подтверждение домена `vaneapp.dev`).
3. Запрос разрешений: `instagram_basic`, `instagram_content_publish`.

---

## 8. TikTok (Shorts & Video)
* **Текущий статус в Vane:** 🔴 **Phase 2 (Require Commercial Review)**
* **Тип API:** TikTok Content Posting API
* **Сложность:** Очень высокая

### Требования для TikTok for Developers:
1. Регистрация в [TikTok Developer Portal](https://developers.tiktok.com/).
2. Настройка Webhooks и прямой доступ к видео-файлам по публичным URL из Cloudflare R2.
3. Прохождение **Content Posting API Review** и проверки политики конфиденциальности.
