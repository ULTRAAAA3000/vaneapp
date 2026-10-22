# Подключение YouTube, TikTok и Instagram Reels: подготовка и верификация

**Статус:** подключения этих сетей в коде ещё нет (в Studio они отмечены «Soon»). Готовы очередь публикации, история и интерфейс; сетевые
«публикаторы» и вход через OAuth пишутся по мере готовности (см. `VIDEO_ENGINE.md`, раздел «Каналы публикации»). Этот документ про то, что нужно сделать
в порталах и на сайте, и содержит готовые тексты для заявок.

> **Оговорка.** Требования Google, TikTok и Meta взяты из их публичной документации так, как я её знаю на момент написания, а такие правила часто меняются.
> Всё, что помечено ⚠, перед подачей сверь с актуальной страницей сети. Проверить заявки на живых порталах и вызвать их API я отсюда не могу.

## 0. Главное: верификация нужна для публичного запуска, а не для разработки

Все три сети позволяют разрабатывать и проверять интеграцию **без одобрения**, пока приложение в тестовом режиме и вошли вы сами (или добавленные вами тестовые пользователи):

| Сеть | Режим до одобрения | Что можно | Ограничения |
|---|---|---|---|
| YouTube | OAuth consent screen в статусе **Testing** | вход и загрузка с вашего аккаунта (до 100 тестовых пользователей) | refresh-токен живёт 7 дней; видео из непроверенного API-проекта сначала **только приватные** ⚠ |
| TikTok | **Sandbox** + target users | вход и публикация с тестового аккаунта | пока нет аудита Content Posting API, публикация возможна только как приватная ⚠ |
| Instagram | приложение в **Development mode**, аккаунт добавлен как Instagram Tester | вход и публикация Reel со своего Business/Creator аккаунта | только роли приложения, без публичных пользователей |

Поэтому порядок такой (и это важно, потому что **заявки на ревью требуют видео-демонстрации уже работающей интеграции**):

1. Создать приложения в порталах в тестовом режиме (разделы 2–4) и добавить себя тестовым пользователем.
2. Написать вход (OAuth) и публикатор каждой сети (см. раздел 6). Пока ключи приложений не заданы на сервере, сеть остаётся «Soon».
3. Проверить публикацию на своих тестовых аккаунтах, записать демо-видео по сценариям ниже.
4. Подать заявки на верификацию (тексты ниже), а на сайте к этому моменту уже должны быть политика, условия и удаление данных (раздел 1: это уже сделано).

## 1. Что должно быть на сайте до подачи (страницы есть; остались TODO и два дополнения)

| Что | Адрес |
|---|---|
| Политика конфиденциальности (с формулировкой Google «Limited Use») | `https://vaneapp.dev/privacy` |
| Условия использования | `https://vaneapp.dev/terms` |
| Удаление данных (инструкции, нужны Meta) | `https://vaneapp.dev/data-deletion` |
| Главная с описанием продукта и ссылкой на политику (нужна Google для brand verification) | `https://vaneapp.dev` |

**Перед подачей владельцу нужно сделать вручную:**
- Подставить данные в жёлтые пометки `class="todo"` на трёх страницах (`npm run test:hosts` в конце выводит, сколько их осталось; сейчас это юридическое имя, контактный email, право и суды, правила возврата и так далее).
  Страницы написаны для готового продукта и намного полнее, чем нужно для проверок; юристу их стоит показать один раз.
- Подтвердить домен `vaneapp.dev` в Google Search Console (DNS TXT на домен). Без этого Google не примет Authorized domain.
- Убедиться, что на главной странице есть слова о Vane Studio и загрузке видео на YouTube (Google сверяет описание приложения с домашней страницей), и что имя приложения в портале совпадает с брендом.
- Подготовить логотип (квадрат, 120×120 или больше) и иконку 1024×1024 для TikTok и Meta.

**Что в текстах стоит дополнить до подачи (я сверила их с требованиями сетей; это пробелы, не ошибки):**

| Страница | Чего не хватает | Зачем |
|---|---|---|
| Политика (раздел 5) | сказать, что для TikTok и Instagram Vane делает **временную публичную ссылку** на одно видео и удаляет её, как только сеть забрала файл | Instagram и TikTok скачивают видео по ссылке; ревьюер спросит, что это за ссылка. Это же обязательство ложится на код (раздел 6) |
| Политика (раздел 5) | назвать права, которые запрашиваются у TikTok и Instagram (`user.info.basic`, `video.publish`; `instagram_business_basic`, `instagram_business_content_publish`) | Meta и TikTok сверяют заявленные права с текстом политики |
| Удаление данных | шаг «удалить видео в Studio» (файл, превью, публичная ссылка, история удаляются сразу) и способ отозвать доступ в TikTok (Settings and privacy → Security and permissions → Apps and services) | Meta читает страницу удаления данных, TikTok смотрит, что описаны все подключаемые сети |

Формулировка Google «Limited Use», ссылки на YouTube Terms of Service и Google Privacy Policy и адрес отзыва доступа в Google уже есть в политике (проверяется тестом).

## 2. Адреса для порталов (резервируем сейчас)

Все адреса даны для `https://vaneapp.dev` (переменная `APP_URL` на Pages должна быть ровно такой, как и для LinkedIn и Threads). Обработчики появятся вместе с публикаторами.

| Что | Адрес |
|---|---|
| YouTube / Google → Authorized redirect URI | `https://vaneapp.dev/api/video/channels/youtube/callback` |
| TikTok → Redirect URI | `https://vaneapp.dev/api/video/channels/tiktok/callback` |
| Instagram → Valid OAuth redirect URI | `https://vaneapp.dev/api/video/channels/instagram/callback` |
| Instagram → Deauthorize callback | `https://vaneapp.dev/api/video/channels/instagram/deauthorize` |
| Instagram → Data deletion request URL (или инструкция) | `https://vaneapp.dev/api/video/channels/instagram/delete` (или `https://vaneapp.dev/data-deletion`) |
| TikTok → URL prefix для загрузки по ссылке | `https://studio.vaneapp.dev/api/video/public/` |
| Privacy / Terms (везде) | `https://vaneapp.dev/privacy`, `https://vaneapp.dev/terms` |

Переменные окружения (на Pages и в воркере; секреты через `wrangler pages secret put`): `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`,
`TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`. Как и у LinkedIn с Threads, сеть включается в интерфейсе, когда ключи заданы.

## 3. YouTube (Google)

1. https://console.cloud.google.com → новый проект → **APIs & Services → Library → YouTube Data API v3 → Enable**.
2. **OAuth consent screen**: тип **External**; название (как на главной странице), email поддержки, логотип, Application home page `https://vaneapp.dev`,
   Privacy policy и Terms из раздела 2, **Authorized domains**: `vaneapp.dev`, контакт разработчика.
3. **Scopes** (запрашиваем минимум): `https://www.googleapis.com/auth/youtube.upload` (чувствительный) и `openid`, `email`, `profile` (обычные: нужны, чтобы подписать канал в интерфейсе).
   Не добавляй `youtube`, `youtube.readonly` и `youtube.force-ssl`: каждый лишний чувствительный scope замедляет проверку и требует отдельного обоснования.
4. **Credentials → Create credentials → OAuth client ID → Web application**; добавить Authorized redirect URI из раздела 2; сохранить Client ID и Secret.
5. Пока статус **Testing**: добавить свои аккаунты в Test users. Для публичного запуска нажать **Publish app** и пройти проверку.

**Что проверяет Google:** brand verification (название, логотип, домен, политика) и sensitive-scope verification с демо-видео. ⚠ Обычно от нескольких дней до нескольких недель.

**Квоты и аудит ⚠.** По умолчанию проект получает 10 000 единиц квоты в сутки, а загрузка видео (`videos.insert`) стоит около 1600: это примерно **6 загрузок в сутки на все
аккаунты вместе**. Чтобы поднять квоту и снять ограничение «видео из непроверенного API-проекта видно только владельцу», нужен **YouTube API Services Audit / Quota Extension** (отдельная форма Google).
До этого публикатор должен честно показывать пользователю: «до одобрения YouTube видео будет приватным», и не обещать публичность.

**Текст для заявки (scope justification, English):**
> Vane Studio lets a creator upload videos from their Vane Studio library to their own YouTube channel. We request `youtube.upload` only to upload the video the user selected,
> with the title, description and visibility the user chose in Vane. We use `openid`, `email` and `profile` only to label the connected channel in the user's dashboard.
> We do not read the user's videos, playlists, subscribers, comments or analytics. Use and transfer of information received from Google APIs adheres to the Google API Services User Data Policy,
> including the Limited Use requirements. The user can disconnect the channel in Vane at any time, and revoke access at myaccount.google.com/permissions.

**Сценарий демо-видео (YouTube, неперечисляемое видео):**
1. Открыть `studio.vaneapp.dev`, показать вход и библиотеку, в адресной строке видна страница Vane.
2. **Channels → Connect → YouTube**: показать, что в окне согласия Google в адресной строке виден `client_id`, видно название приложения и запрашиваемые права.
3. Нажать «Разрешить», вернуться в Vane: канал появился в списке.
4. Выбрать видео → **Publish** → YouTube → название, описание, приватность → Publish.
5. Показать историю (статус Published) и открыть видео на YouTube Studio.
6. Показать **Channels → удалить канал** и `myaccount.google.com/permissions` (доступ отозван).

## 4. TikTok

1. https://developers.tiktok.com → **Manage apps → Connect an app** (организация).
2. Тип **Web**. Заполнить название, иконку, категорию, описание, Terms и Privacy из раздела 2, Web/Desktop URL `https://vaneapp.dev`.
3. **Products**: добавить **Login Kit** (Redirect URI из раздела 2) и **Content Posting API**. Включить **Direct Post**.
4. **Scopes**: `user.info.basic` (имя и аватар для подписи канала), `video.publish` (публикация).
5. **URL properties**: подтвердить префикс `https://studio.vaneapp.dev/api/video/public/` (DNS TXT или файл подтверждения; без этого TikTok не станет скачивать видео по ссылке ⚠).
6. **Sandbox** → добавить свой TikTok как target user и проверить вход и публикацию. Затем **Submit for review**: демо-видео и описание, как использует права.

**Что проверяет TikTok ⚠:** приложение целиком и отдельно **аудит Content Posting API**. До аудита публикация идёт только с приватной видимостью.

**Требования TikTok к интерфейсу публикации ⚠ (Content Sharing Guidelines).** Их нужно выполнить в окне Publish до аудита, это отдельная работа:
- показать **имя аккаунта TikTok**, в который идёт публикация, и дать выбрать **видимость из списка, который TikTok вернул для этого аккаунта** (не фиксированный набор);
- переключатели «разрешить комментарии / Duet / Stitch» по настройкам аккаунта; ничего не включать за пользователя и не ставить значения по умолчанию, кроме тех, что допускает TikTok;
- переключатель **«раскрыть коммерческий контент»** (свой бренд / оплаченное партнёрство) с обязательной пометкой;
- текст согласия перед публикацией («By posting, you agree to TikTok's Music Usage Confirmation», а для коммерческого контента ещё и Branded Content Policy);
- не добавлять свои водяные знаки и промо-надписи; показать превью, дать название; пользователь сам решает отправить.

**Текст для заявки (English):**
> Vane Studio lets a creator publish videos from their own library to their own TikTok account. We request `user.info.basic` to show the connected account's name in the dashboard and
> `video.publish` to post the video the user selected, with the title, privacy and interaction settings the user chose in Vane. We do not read the user's videos, followers or messages,
> and we post only when the user presses Publish. The video is fetched by TikTok from a temporary link that Vane removes as soon as TikTok has downloaded it.

**Сценарий демо-видео:** вход в Studio → Connect → TikTok (окно согласия TikTok с названием приложения) → выбор видео → Publish: видно имя аккаунта, выбор видимости, переключатели, декларация →
история Published → открытое видео в приложении TikTok → удаление канала.

Токены ⚠: access-токен живёт сутки, refresh-токен около года; публикатор обновляет access-токен перед использованием.

## 5. Instagram Reels (Meta)

1. https://developers.facebook.com → **Create app** → тип **Business**.
2. Добавить продукт **Instagram** → **API setup with Instagram login** (подключение Instagram Business или Creator аккаунта; личные аккаунты публиковать через API не могут).
3. **Permissions**: `instagram_business_basic` и `instagram_business_content_publish`. Других не запрашивать.
4. Valid OAuth redirect URI, Deauthorize callback и Data deletion из раздела 2; Privacy и Terms; иконка 1024×1024; категория.
5. **Roles → Instagram Testers**: добавить свой аккаунт и принять приглашение в Instagram. Проверить вход и публикацию.
6. Для публичных пользователей: **App Review** (Advanced Access к двум правам, демо-видео) и **Business Verification** компании ⚠. Обычно самое долгое из трёх (недели).

**Особенность публикации:** Instagram не принимает файл напрямую. Он скачивает видео по **публичной ссылке**, которую Vane даёт в контейнере `media_type=REELS`, затем публикация вызывается отдельно после того, как
контейнер перешёл в `FINISHED`. Поэтому нужны публичные ссылки на видео (они уже есть, раздел «Публичная ссылка» в `VIDEO_ENGINE.md`). Лимит публикаций через API на аккаунт около 100 в сутки, требования к Reel
(формат, длительность, размер) ⚠ сверь с документацией Meta в момент написания публикатора.

**Текст для заявки (English):**
> Vane Studio lets a creator publish Reels from their own video library to their own Instagram professional account. We request `instagram_business_basic` to show the connected account's name
> in the dashboard and `instagram_business_content_publish` to create the Reel the user selected, with the caption the user wrote. We do not read the user's posts, followers, messages or insights,
> and we publish only when the user presses Publish. Instagram fetches the video from a temporary link that Vane removes as soon as the Reel is published.

**Сценарий демо-видео:** вход в Studio → Connect → Instagram (окно входа и согласия Meta) → выбор видео → Publish с подписью → история Published → Reel в приложении Instagram → удаление канала → страница
удаления данных `vaneapp.dev/data-deletion`.

## 6. Что должен сделать код при подключении (чек-лист для публикаторов)

- **Вход:** OAuth start и callback на адресах из раздела 2 по образцу LinkedIn и Threads (подписанный `state`, обмен кода, токены шифруются как в `channels`, `account_ref` защищает от дубля), включение сети по наличию ключей.
- **Обновление токенов** перед публикацией; просроченный токен даёт понятную постоянную ошибку («Reconnect»), а не бесконечные повторы.
- **Публикатор** (`videopublishers.ts`): YouTube: resumable upload из R2 кусками; TikTok: инициализация, загрузка по ссылке или кусками, опрос статуса; Instagram: контейнер Reels, опрос `status_code`, публикация.
- **Временная публичная ссылка** для TikTok и Instagram: создать перед запросом и **удалить** после того, как сеть забрала видео (в политике этого пока нет, см. таблицу выше).
- **Ошибки:** квота исчерпана или лимит публикаций в сутки не повторять сразу (`retryable: false` с понятным текстом), сетевые сбои и 5xx повторять.
- **Параметры в окне Publish для каждой сети:** YouTube: обязательное заявление «сделано для детей» (`selfDeclaredMadeForKids`) и категория; TikTok: пункты из раздела 4; Instagram: подпись, «показать в ленте».
  Приватность «Public» для сети без аудита заменять понятным предупреждением.
- **Отзыв доступа:** обработчики Deauthorize и Data deletion для Instagram (по образцу Threads: проверка `signed_request`), корректная реакция на отозванный токен.
- **Проверка** с настоящими тестовыми аккаунтами: у меня нет доступа к этим API, поэтому каждая сеть после написания проходит ручную проверку на твоём тестовом аккаунте.

## 7. Тестовый аккаунт для ревьюеров

Ревьюеры TikTok и Meta иногда просят данные для входа. Заведи аккаунт специально для них:
1. Зарегистрируйся на `https://vaneapp.dev/login?mode=register&product=studio` с отдельной почтой.
2. Включи ему Studio в D1 Console (без срока):
   ```sql
   INSERT INTO video_subscriptions (user_id, status, current_period_end, provider, created_at, updated_at)
   SELECT id, 'active', NULL, 'manual', unixepoch(), unixepoch() FROM users WHERE email = 'review@example.com'
   ON CONFLICT(user_id) DO UPDATE SET status = 'active', current_period_end = NULL, updated_at = unixepoch();
   ```
3. Проверь, что вход по паролю не требует кода из письма (регистрация его требует, вход по паролю не должен). Если кода не избежать, дай ревьюерам доступ к ящику или положись на демо-видео.
4. Загрузи в библиотеку 1–2 небольших видео и впиши логин, пароль и короткую инструкцию в поле «Test instructions» заявки.

## 8. Порядок и ориентировочные сроки ⚠

| Шаг | Что | Кто |
|---|---|---|
| 1 | Заполнить TODO на трёх страницах, показать юристу, задеплоить | владелец |
| 2 | Search Console для `vaneapp.dev`; создать приложения в тестовом режиме, внести ключи | владелец |
| 3 | Написать вход и публикаторы (раздел 6), включить сети по ключам | разработка |
| 4 | Проверить на своих аккаунтах, записать три демо | владелец |
| 5 | Подать: Google (бренд и scope), TikTok (приложение и аудит), Meta (App Review и Business Verification) | владелец |
| 6 | После одобрения: поднять квоту YouTube (аудит), снять «private only» | владелец |

Самое долгое обычно Meta (Business Verification) и аудит квоты YouTube; подавать их можно сразу после шага 4, не дожидаясь остальных.
