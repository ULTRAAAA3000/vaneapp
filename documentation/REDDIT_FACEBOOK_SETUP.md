# Reddit и Facebook Pages (Vane Post): настройка

Код готов. Кнопка Connect в дашборде и переключатель в админке (Networks) включаются сами, когда заданы ключи.

## База данных (один раз)
Запусти в D1 Console весь файл `migrations/0003-channel-types-reddit-facebook.sql` (пересоздаёт таблицу `channels` с новыми типами; данные сохраняются). На новой базе из `schema.sql` это уже есть.

## Reddit
1. https://www.reddit.com/prefs/apps → **create another app** → тип **web app**.
2. redirect uri: `https://vaneapp.dev/api/channels/reddit/callback`.
3. Client ID это строка под названием приложения, secret поле `secret`.
4. Pages: `REDDIT_CLIENT_ID` (переменная), `REDDIT_CLIENT_SECRET` (секрет). **Те же два значения в воркере `vane-cron`** (он обновляет токен и публикует).
5. Один канал = один subreddit (его вводит человек при подключении). Первая строка поста это заголовок (до 300 символов), остальное текст. Reddit без отдельного одобрения: для малого объёма бесплатно, но у многих сабреддитов запрет на рекламу или обязательный flair (тогда Reddit вернёт ошибку, она показывается в истории поста).
6. Reddit просит осмысленный User-Agent: он зашит в `functions/api/channels/reddit.ts` (`web:dev.vaneapp.post:1.0 (by /u/vaneapp)`): замени `vaneapp` на ник аккаунта, который создал приложение.

## Facebook Pages
1. https://developers.facebook.com → **Create App** → тип Business (или Other) → добавить продукт **Facebook Login for Business / Facebook Login**.
2. Valid OAuth Redirect URI: `https://vaneapp.dev/api/channels/facebook/callback`.
3. Разрешения: `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`. В режиме Development работает для админов и тестеров приложения (добавь себя в Roles). Для всех пользователей нужен **App Review** (демо-видео подключения и публикации) и **Business Verification**.
4. Privacy Policy URL `https://vaneapp.dev/privacy`, Data deletion instructions URL `https://vaneapp.dev/data-deletion`.
5. Pages: `FACEBOOK_APP_ID` (переменная), `FACEBOOK_APP_SECRET` (секрет). В воркере ключи не нужны: токен Страницы хранится в канале.
6. При подключении каждая выбранная Страница становится отдельным каналом. Личные профили не поддерживаются (Facebook не даёт).
