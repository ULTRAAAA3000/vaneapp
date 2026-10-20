# Подключение LinkedIn и Threads: настройка и верификация

Код готов. Кнопки «LinkedIn» и «Threads» в диалоге Connect остаются на «Soon», пока на сервере не заданы ключи приложений.
Как только ключи добавлены и сайт передеплоен, кнопки включаются сами, ничего менять в коде не нужно.

Все адреса ниже даны для `https://vaneapp.dev`. Проверь, что переменная `APP_URL` на Pages равна именно `https://vaneapp.dev`
(без слэша на конце и без `www`): redirect URL строится от неё и должен **точно** совпасть с тем, что записан в портале.

## 1. Адреса, которые вводятся в порталах

| Что | Адрес |
|---|---|
| LinkedIn → Redirect URL | `https://vaneapp.dev/api/channels/linkedin/callback` |
| Threads → Redirect Callback URL | `https://vaneapp.dev/api/channels/threads/callback` |
| Threads → Deauthorize Callback URL | `https://vaneapp.dev/api/channels/threads/deauthorize` |
| Threads → Data Deletion Request URL | `https://vaneapp.dev/api/channels/threads/delete` |
| Privacy Policy URL (оба портала) | `https://vaneapp.dev/privacy` |
| Terms of Service URL (Google OAuth consent screen, Meta, TikTok) | `https://vaneapp.dev/terms` |
| Инструкция по удалению данных (Meta) | `https://vaneapp.dev/data-deletion` |

> В старой заметке `SOCIAL_PLATFORMS_VERIFICATION.md` был адрес `api.vaneapp.dev/v1/channels/linkedin/callback`. Он не используется: callback живёт на основном домене.

## 2. LinkedIn

1. https://www.linkedin.com/developers/ → **Create app**. Нужна Company Page, к которой приложение привязывается (LinkedIn требует её при создании).
2. Вкладка **Products** → добавить **Share on LinkedIn** и **Sign In with LinkedIn using OpenID Connect**. Оба доступны сразу, без ревью.
3. Вкладка **Auth** → **Authorized redirect URLs** → адрес из таблицы выше. Там же скопировать **Client ID** и **Client Secret**.
4. Scopes, которые запрашивает Vane: `openid profile w_member_social`. Больше ничего: ни ленту, ни сообщения, ни контакты Vane не читает.
5. Задать на Cloudflare Pages (Settings → Variables and Secrets):
   - `LINKEDIN_CLIENT_ID` (обычная переменная, или в `wrangler.toml` → `[vars]`),
   - `LINKEDIN_CLIENT_SECRET` (**secret**: `npx wrangler pages secret put LINKEDIN_CLIENT_SECRET --project-name=vaneapp`).
6. Передеплоить. Открыть `/app` → Connect → LinkedIn.

Что важно знать:
- Это **личные профили**. Публикация от имени Страницы компании (`w_organization_social`) требует отдельного одобрения LinkedIn
  (Community Management API, заявка и ревью). Пока оно не получено, этот scope не запрашивается: иначе LinkedIn откажет во входе всем.
  Автор поста в коде это просто URN, так что страницы добавятся без переделки (нужно будет выбрать страницу при подключении).
- Токен живёт **60 дней**. Refresh-токены LinkedIn выдаёт только одобренным партнёрам, поэтому обычно человек просто подключает профиль заново:
  за 7 дней до конца в карточке канала появляется «Reconnect», и повторное подключение обновляет тот же канал (запланированные посты не теряются).
  Пост, который застал истёкший токен, сразу получает понятную ошибку, а не ретраится.
- Версия API задаётся заголовком `Linkedin-Version` (по умолчанию `202608`). LinkedIn держит версию около года; если когда-нибудь придёт ошибка 426,
  поставь переменную `LINKEDIN_VERSION=YYYYMM` (на Pages и в воркере).
- В тексте поста все служебные символы LinkedIn (`( ) [ ] { } < > @ # * _ ~ | \`) экранируются автоматически, иначе пост обрезается на первой скобке.
  `#хештеги` остаются кликабельными. Упоминания `@имя` пока обычный текст.
- Картинка: одна, JPEG/PNG/WebP/GIF до 8 МБ. Видео для LinkedIn пока не поддерживается (сервер скажет об этом при создании поста).

## 3. Threads

1. https://developers.facebook.com/ → **Create app** → use case **Access the Threads API** (тип Business). Нужен Meta-аккаунт разработчика.
2. В настройках Threads API: **Redirect Callback URLs**, **Deauthorize Callback URL**, **Data Deletion Request URL**: адреса из таблицы.
3. **App settings → Basic**: Privacy Policy URL, иконка приложения 1024×1024, категория. Скопировать **Threads App ID** и **Threads App Secret**
   (именно Threads, а не «App ID» основного приложения Meta, это разные пары).
4. Permissions: `threads_basic` и `threads_content_publish`.
5. Пока приложение в режиме разработки, подключаться могут только добавленные **Threads Testers** (Roles → Roles → Add People → Threads Tester;
   принять приглашение нужно в самом Threads: Settings → Account → Website permissions → Invites).
6. На Cloudflare Pages: `THREADS_APP_ID` (переменная) и `THREADS_APP_SECRET` (**secret**). Секрет нужен и для проверки подписи вызовов Meta.
7. Передеплоить. Connect → Threads.

Что важно знать:
- Токен живёт 60 дней и **продлевается автоматически**: перед публикацией, если осталось меньше 20 дней, и раз в сутки (03:00 UTC) воркером для каналов,
  в которых давно не публиковали (`worker/src/tokens.ts`). Руками ничего делать не нужно. Если Meta всё же откажет, карточка покажет «Reconnect».
- Лимит текста 500 знаков, эмодзи считаются по размеру в UTF-8 (правило Meta), поэтому счётчик в редакторе может быть чуть строже, чем «на глаз».
- Картинка или видео берутся Meta по публичной ссылке на файл в R2, ничего не загружается с нашей стороны. Лимит Meta: 250 постов за 24 часа на аккаунт.
- Когда человек убирает Vane в настройках Threads, Meta вызывает **Deauthorize**: канал отключается, токен стирается, ожидающие посты отменяются.
  Запрос **Data Deletion** удаляет канал, его посты и логи и возвращает Meta код подтверждения и ссылку на `/data-deletion?code=…`.
  Оба вызова принимаются только с верной подписью (HMAC-SHA256 с App Secret).

## 4. Что говорить на ревью

Чек-лист перед отправкой:

- [ ] В `public/privacy.html`, `public/terms.html` и `public/data-deletion.html` заполнены все места, подсвеченные жёлтым (`class="todo"`): юридическое имя и адрес, контактный email, дата вступления в силу, применимое право и суд, сроки хранения.
- [ ] Privacy Policy и Terms (если требуются) открываются без входа по `https://vaneapp.dev/privacy`.
- [ ] Иконка 1024×1024 (Meta), логотип 300×300 (LinkedIn), описание продукта, домен `vaneapp.dev` подтверждён.
- [ ] Тестовый аккаунт для ревьюера: логин и пароль в поле «Notes for the reviewer», в аккаунте уже подключены Threads/LinkedIn.

Сценарий скринкаста (одинаковый для обоих ревью, 1–2 минуты, с озвучкой или субтитрами):

1. Открыть `vaneapp.dev/app`, войти. Показать список каналов.
2. Нажать **Connect → LinkedIn / Threads**. Показать, что открывается экран согласия самой сети с перечнем разрешений.
3. Нажать **Allow**, вернуться в Vane: канал появился в списке.
4. Написать пост, выбрать этот канал, выбрать время «In 1 hour» (или запланировать на ближайшие минуты), нажать **Schedule post**.
5. Дождаться отправки (вкладка History, статус **sent**), нажать на плашку канала: открывается опубликованный пост в LinkedIn / Threads.
6. Показать удаление: корзина у канала в Vane (и «убрать Vane» в настройках сети для Threads: показать, что Deauthorize сработал).

Формулировки, которые нужны в заявке:

- **Зачем `w_member_social` / `threads_content_publish`:** пользователь сам пишет и планирует пост в Vane, и Vane публикует его в назначенное время от его имени. Ничего не публикуется без явного действия пользователя.
- **Зачем `openid profile` / `threads_basic`:** показать в Vane, какой именно аккаунт подключён (имя / username), и не допустить подключения одного аккаунта дважды.
- **Данные:** хранятся только имя/username, id аккаунта и токен; токен шифруется AES-256-GCM; данные не продаются, не передаются, не используются для рекламы и обучения моделей.
- **Удаление:** корзина у канала, «убрать приложение» в настройках сети (Deauthorize / Data Deletion), письмо на контактный адрес. См. `/data-deletion`.

## 5. Проверка после включения

1. `https://vaneapp.dev/api/auth/me` (в залогиненном браузере): в `features` должны быть `"linkedin": true` и/или `"threads": true`.
   Если `false`, значит функция не видит одну из двух переменных (проверь, что `*_SECRET` добавлен именно в проект Pages и сайт передеплоен).
2. Connect → LinkedIn / Threads → Allow → в списке появился канал → запланировать пост «через 1 минуту» → в History он становится `sent`, плашка канала открывает пост.
3. Если пост `failed`, причина написана на карточке поста и в Cloudflare → Workers → `vane-cron` → Logs.
4. Воркеру `vane-cron` для LinkedIn ничего дополнительно не нужно (если Linkedin выдаёт refresh-токены: `LINKEDIN_CLIENT_ID` и `LINKEDIN_CLIENT_SECRET` как secret и в воркер).
   Для Threads воркеру нужен только тот же `ENCRYPTION_KEY`, что и на Pages.
