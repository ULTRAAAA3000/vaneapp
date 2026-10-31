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

## 6. Notion (Custom Agents + тот же MCP-сервер, что у Claude)
* **Идея:** контент-календарь живёт в Notion, агент Notion читает строки со статусом `Ready` и планирует посты через Vane. Это **второй флагман наравне с Claude**: у него своя вкладка в дашборде (`#notion`), своя карточка на `/integrations`, свой ключ «Notion connector» и своя строка в статистике интеграций.
* **Как подключается:** тот же удалённый MCP-сервер `https://vaneapp.dev/api/v1/mcp` с OAuth 2.1 (PKCE + динамическая регистрация клиента). Админ рабочего пространства включает Settings → Connections → *Enable custom MCP servers*, затем в Custom Agent: *Add connection → Custom MCP server*, вставляет адрес, жмёт Connect, на странице Vane жмёт Allow. Ключ копировать не нужно. Custom Agents есть в планах Business/Enterprise Notion; Notion показывает предупреждение «not reviewed» для любого кастомного сервера.
* **Что изменено в коде:** клиент определяется по OAuth-клиенту, а не по заголовкам (их можно подделать): `connectorFor(clientName, redirectUris)` в `lib/oauth.ts` узнаёт Notion по имени клиента или по хосту `*.notion.so|com|site` в redirect URI (проверяется точное окончание хоста, `notion.so.evil.com` не проходит). Для Notion создаётся ключ `Notion connector` с меткой `notion`, вызовы MCP считаются как `notion` (`markMcpClient` / `mcpClientOf` в `lib/integrations.ts`), всё остальное как раньше считается Claude. Страница `/connect` показывает имя ключа клиента.
* **Инструкции агенту** (копируются со вкладки Notion): всегда сначала `vane_list_channels`; постить только указанный текст; показать текст, каналы и время и **ждать «да»** перед `vane_create_post`; время с часовым поясом; при ошибке остановиться.
* **Не проверено на живом Notion:** сервер стандартный, но реальное подключение из Notion нужно прогнать вручную один раз (какое имя клиента присылает Notion, видно в таблице `oauth_clients`; если имя не содержит «Notion», а redirect URI не на домене Notion, ключ получит метку Claude: тогда поправьте `connectorFor`).

## 7. Obsidian (плагин `Vane for Obsidian`)
* **Идея:** отправить открытую заметку или выделенный текст в каналы, сразу или по времени, не выходя из Obsidian. Десктоп и мобильный (`isDesktopOnly: false`).
* **Исходники:** `integrations/obsidian/` (TypeScript: `src/convert.ts` Markdown → текст поста, `src/api.ts` вызовы `GET /api/v1/channels` и `POST /api/v1/posts`, `src/main.ts` команды, окно и настройки). Сборка и архив: `npm run build:obsidian` → `integrations/obsidian/main.js` и `public/downloads/vane-for-obsidian.zip` (папка `vane/`, архив воспроизводимый). `npm run test:unit` проверяет, что собранные файлы актуальны.
* **Авторизация:** ключ Vane в настройках плагина (метка «Obsidian plugin» в «Used with»). Тестовый ключ `cpost_test_…` проверяет всё и ничего не публикует.
* **Особенности:** API принимает только время в будущем, поэтому «как можно скорее» = через 90 секунд. Запросы идут через `requestUrl` Obsidian (без CORS). В регулярных выражениях нет look-behind (старые iOS не умеют). Картинки и видео плагин пока не прикладывает.
* **Публикация:** ручная установка из архива. Попадание в каталог плагинов Obsidian идёт через ревью команды Obsidian (PR в `obsidianmd/obsidian-releases` с GitHub-релизом из `manifest.json`, `main.js`, `styles.css`): пока не подано.

## 8. Agent log (вкладка «Agents»: живой лог действий ассистентов)
* **Идея:** показать пользователю «магию под капотом»: в неоновом терминале в реальном времени бегут строки о том, что делают его ассистенты и интеграции с его аккаунтом. Одна вкладка для **всех** внешних интеграций (Claude, Notion, Obsidian, Make, Zapier, WordPress, ChatGPT, свои скрипты), фильтр по интеграции чипами.
* **Примеры строк:**
  * `[14:05:12] [Claude MCP] Executed tool: vane_list_channels() → 4 channels found`
  * `[14:05:19] [Claude MCP] Executed tool: vane_create_post(2 channels) → scheduled for 2026-11-02 09:00 UTC`
  * `[14:06:02] [Make] Schedule a post → refused: quota_exceeded`
* **Откуда строки:** MCP-вызовы пишутся один раз, как вызов инструмента (`v1/mcp.ts`: результат собирается в `note()` и пишется в `logTool()`); остальные интеграции пишутся обёрткой `agentLogged(op, handler)` вокруг REST-обработчиков `v1/channels`, `v1/posts`, `v1/posts/[id]`, `v1/usage`, `v1/me` (`lib/agentlog.ts`). Внутренние запросы MCP и повторы по тому же `Idempotency-Key` в лог не попадают. Кто сделал запрос, берётся из ключа (`rememberAuth` в `lib/apikeys.ts`), а не из заголовков.
* **Только метаданные:** счётчики, время, названия платформ и **код** ошибки. Текст постов, имена каналов, ключи и тексты ошибок (в них может быть цитата поста) в лог не попадают. Покрыто тестом.
* **Хранение:** таблица `agent_events`; 300 последних строк на аккаунт и не старше 30 дней (чистка при записи), пользователь может стереть всё кнопкой «Clear log» (`DELETE /api/agent-log`). Отражено в политике конфиденциальности.
* **Интерфейс:** `assets/agentlog.js` опрашивает `GET /api/agent-log?after=<id>` раз в 3 секунды, пока вкладка открыта и страница видна; новые строки печатаются по символам (без анимации при `prefers-reduced-motion`), автопрокрутка с кнопкой «↓ New lines», Pause/Resume, «Show a demo» (выдуманные строки только на экране, не сохраняются).
* **Не покрыто:** видео-API Studio (`v1/video/*`) пока не пишет в лог. Опрос раз в 3 секунды, а не WebSocket/SSE (на Cloudflare Pages Functions это проще и дешевле).
* **Выкладка:** `npm run db:remote` (создаёт `agent_events`). Пока таблицы нет, вкладка пуста, запросы API не ломаются.

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
