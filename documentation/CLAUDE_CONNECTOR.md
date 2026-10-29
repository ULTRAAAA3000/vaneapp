# Коннектор Vane для Claude (OAuth) и публикация в каталоге

## Как это работает
Удалённый MCP-сервер `https://vaneapp.dev/api/v1/mcp` теперь с OAuth 2.1:

1. Claude вызывает MCP без токена → 401 с `WWW-Authenticate: Bearer resource_metadata=…`.
2. Читает `/.well-known/oauth-protected-resource` и `/.well-known/oauth-authorization-server`, сам регистрируется (`POST /api/oauth/register`, без секрета, PKCE S256).
3. Открывает `/connect` — страница Vane: вход → кнопка **Allow** (или поле «Use my own API key»).
4. `POST /api/oauth/authorize` создаёт ключ «Claude connector» (live, если в плане есть API, иначе test) либо принимает вставленный ключ пользователя, и возвращает код.
5. `POST /api/oauth/token` обменивает код на access-токен (1 час) и refresh-токен (90 дней, одноразовый, ротация). Повторное использование кода или refresh-токена отзывает весь grant.
6. На каждый вызов MCP токен подменяется ключом grant'а, поэтому квоты, тест-режим и лимиты те же, что у API.

Отключение: удалить ключ «Claude connector» в дашборде (API keys) — токены сразу перестают работать.
Старый способ (ключ в заголовке/конфиге Claude Desktop) работает как раньше.

## Что сделать владельцу
1. Смержить PR и **запустить весь `schema.sql` в D1 Console** (новые таблицы `oauth_*`).
2. На Pages должна быть задана `ENCRYPTION_KEY` (уже есть) — ключ grant'а хранится зашифрованным.
3. Проверить: Claude → Settings → Connectors → Add custom connector → URL выше → Connect.

## Публикация в каталоге Claude (Connectors Directory)
Форма отправки — в справке Anthropic «Submit your remote MCP server» (support.claude.com). Что понадобится:

| Пункт | Значение |
|---|---|
| Название | Vane |
| URL сервера | `https://vaneapp.dev/api/v1/mcp` |
| Авторизация | OAuth 2.1 + PKCE, динамическая регистрация клиента |
| Callback Claude | `https://claude.ai/api/mcp/auth_callback` и `https://claude.com/api/mcp/auth_callback` (регистрируются сами) |
| Инструменты | `vane_list_channels` (readOnlyHint), `vane_create_post` (не destructive) |
| Политика конфиденциальности | `https://vaneapp.dev/privacy` |
| Документация / поддержка | `https://vaneapp.dev/integrations`, почта поддержки из `/about#contact` |
| Тестовый аккаунт | создать аккаунт с test-ключом и 1–2 подключёнными тестовыми каналами; логин/пароль указать в форме |
| Примеры промптов | «Show my Vane channels»; «Schedule “Hello” to Telegram tomorrow at 9:00 UTC» |

Перед отправкой: убедиться, что в `/privacy` описано, что коннектор получает список каналов и создаёт посты, и что токены хранятся в хэше, а ключ — в зашифрованном виде.
