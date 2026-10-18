# Vane — External Integrations, Connectors & Plugins Architecture

**Версия документа:** 1.1.0  
**Статус:** Спецификация всех внешних интеграций и плагинов  
**Назначение:** Архитектурный регламент, требования к безопасности, эндпоинты и процесс верификации интеграций с платформой Vane для Make, Zapier, Claude, ChatGPT и WordPress.

---

## 📌 Общий обзор и механика авторизации

Все внешние автоматизации, ИИ-коннекторы и CMS-плагины взаимодействуют с Vane через наш **Core API** (`https://api.vaneapp.dev/v1`).

### Единый стандарт аутентификации:
- **API Ключи с префиксами:** Для сервисов автоматизации (Make, Zapier, WordPress, прямые скрипты) используется Bearer-токен вида `cpost_live_...` (Text Engine) или `cvid_live_...` (Video Engine).
- **OAuth 2.0 (для плагинов/GPTs):** Для публичных интеграций в каталогах (ChatGPT Store, Claude Apps) используется наш OAuth 2.0 провайдер на Cloudflare Workers.
- **Безопасность:** В базе D1 хранятся только **SHA-256 хеши** ключей.

---

## 1. WordPress Plugin (`Vane for WordPress`)

* **Тип интеграции:** Gutenberg Sidebar Block / Native WP Plugin
* **Сложность подключения:** Низкая (1-2 PHP файла + JS-виджет)
* **Статус верификации:** 🟢 Phase 2 (Не требует верификации для кастомного использования / WordPress.org Plugin Review для публичного каталога)

### 💡 Концепция и выгода
WordPress удерживает около 40% рынка веб-сайтов. Плагин `Vane for WordPress` служит прямым умным шлюзом между блогом/СМИ на WP и бэкендом Vane на Cloudflare Workers для автоматического кросс-постинга статей в соцсети.

### 🛠️ Архитектура и функционал плагина:

1. **Простая авторизация:**
   - Пользователь устанавливает плагин и вводит свой API-ключ Vane (`cpost_live_...`).
   - Плагин делает запрос к `GET /api/v1/channels`, чтобы подгрузить список подключенных каналов (Telegram, Bluesky, Mastodon, LinkedIn).

2. **Интерфейс в Gutenberg Editor (Sidebar Widget):**
   - В правом сайдбаре редактора записей появляется блок **Vane Cross-Post**:
     - Чекбоксы выбора каналов: `[x] Telegram`, `[x] Bluesky`, `[ ] LinkedIn`, `[x] Mastodon`.
     - Кнопка *"Сгенерировать анонсы через AI"*: обращается к Vane API для создания кастомных снайпетов под каждую сеть на основе текста статьи.
     - Интерактивный предпросмотр (Preview) постов прямо в интерфейсе WP.

3. **Автоматический триггер публикации (Publish Trigger):**
   - При нажатии кнопки «Опубликовать» в WordPress (или по расписанию WP Cron) плагин собирает заголовок, краткую выжимку, ссылку на статью и обложку из R2/Media Library и отправляет в `POST /api/v1/posts/create`.

---

## 2. Make (бывший Integromat)

* **Тип интеграции:** Custom App / Community App (позже Public Marketplace)
* **Сложность подключения:** Низкая
* **Статус верификации:** 🟢 Не требует обязательной проверки на старте (Custom App доступен по ссылке)

### 🛠️ Архитектура приложения Make:
1. **Connection:** `API Key` (Header: `Authorization: Bearer {{connection.apiKey}}`).
2. **Модули (Actions & Searches):**
   - **Create Post:** `POST /api/v1/posts/create` (отправка отложенного или мгновенного поста).
   - **List Connected Channels:** `GET /api/v1/channels` (получение списка Telegram, Bluesky и др. подключенных аккаунтов).
   - **Get Post Status:** `GET /api/v1/posts/:id` (проверка статуса публикации).
3. **Instant Webhooks:** `POST /api/v1/webhooks/subscribe` (уведомляет Make о публикации или ошибке).

---

## 3. Zapier

* **Тип интеграции:** Zapier CLI (Private App ➔ Public Integration)
* **Сложность подключения:** Средняя
* **Статус верификации:** 🟡 Требуется Invite Link для бета-теста, затем Zapier Partner Review

### 🛠️ Архитектура приложения Zapier:
1. **Authentication:** `API Key` (Header Authentication) через `GET /api/v1/me`.
2. **Triggers:** `New Published Post`, `Post Failed`.
3. **Actions:** `Create Social Post` (создание текста, выбор каналов, прикрепление медиа из R2).

---

## 4. ChatGPT Connector (Custom GPT & Actions)

* **Тип интеграции:** OpenAPI Specification (Custom GPT Action)
* **Сложность подключения:** Низкая
* **Статус верификации:** 🟢 Не требует верификации для использования по ссылке / OpenAI Builder Account для GPT Store

### 🛠️ Архитектура ChatGPT Action:
Работает через схему OpenAPI v3 (`vane-openapi.json`).

1. **Авторизация:** API Key (`cpost_live_...`) или OAuth 2.0 Auth Code Flow.
2. **Основные эндпоинты:**
   - `POST /v1/posts/publish` — отправка сгенерированного текста и выбранных каналов.
   - `GET /v1/channels` — получение списка доступных платформ пользователя.

---

## 5. Claude Connector (Model Context Protocol / Custom Tools)

* **Тип интеграции:** Anthropic Claude Custom Tools / MCP Server (Model Context Protocol)
* **Сложность подключения:** Средняя
* **Статус верификации:** 🟢 Открытый стандарт (MCP Server)

### 🛠️ Архитектура Claude MCP Server (`@vane/mcp-server`):
1. **Tool Definitions:**
   - `vane_list_channels`: возвращает список привязанных каналов.
   - `vane_create_post`: аргументы `text`, `channels`, `scheduled_at`.
2. **Безопасность:** передача переменной окружения `VANE_API_KEY` в `claude_desktop_config.json`.

---

## 🚀 Сводная дорожная карта интеграций (Roadmap)

1. **MVP (Phase 1):**
   - Выпустить `vane-openapi.json` для **ChatGPT Custom GPTs** и **Claude Custom Projects**.
   - Базовый **Make Custom App** по API-ключам `cpost_...`.
2. **Phase 2:**
   - Выпустить легкий плагин **`Vane for WordPress`** (Gutenberg Sidebar + Publish Trigger).
   - Собрать CLI-пакет для **Zapier** (Invite-ссылка).
   - Опубликовать официальный **Claude MCP Server**.
3. **Phase 3:**
   - Подача на ревью в **WordPress.org Plugin Directory**, **Zapier Marketplace** и **Make Public Apps**.
