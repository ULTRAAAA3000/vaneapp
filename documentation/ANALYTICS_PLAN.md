# Vane Analytics: план продукта

Статус: **планирование**. Готово: поддомен `analytics.vaneapp.dev` (маршрутизация), страница «Coming soon» со списком ожидания, переходы из Vane Post и Vane Studio. Остальное ниже, ничего из этого пока не написано.

## 1. Идея

Vane Analytics показывает результат постов и видео по всем сетям в одном месте. Это третье звено после Post (публикация текста и картинок) и Studio (видео): путь «создал, запланировал, увидел результат».

**Принцип приватности.** Мы читаем метрики только тех публикаций, которые сделали сами: при публикации сеть возвращает id поста, и по нему мы спрашиваем цифры. Мы не читаем ленту, личные сообщения, списки подписчиков и чужие посты. Это совпадает с обещанием в Privacy Policy.

## 2. Что можно получить по сетям

| Сеть | Метрики | Сложность |
|---|---|---|
| Bluesky | лайки, репосты, ответы, подписчики | легко, открытый API |
| Mastodon | избранное, бусты, ответы, подписчики | легко |
| Reddit | оценка, комментарии | легко |
| Dev.to | просмотры, реакции, комментарии | легко |
| YouTube | просмотры, время просмотра, подписчики | средне: нужен доступ на чтение статистики (`yt-analytics.readonly`), входит в проверку Google |
| Telegram | подписчики по дням, реакции; просмотры постов Bot API не отдаёт | ограниченно |
| Threads, Facebook Pages, Instagram | просмотры, охват, подписчики | средне: нужна проверка приложения у Meta (нужна и для публикации) |
| LinkedIn, X | у личных аккаунтов метрики почти закрыты, у X платные тарифы API | показываем «недоступно» |

Данные сетей приблизительные и приходят с задержкой: в интерфейсе подпись «данные сети, могут отличаться».

## 3. Тарифы

| | Free | Analytics Pro, $4.99 |
|---|---|---|
| Подписчики сейчас | да | да, плюс рост по дням |
| Результаты постов | последние 10 постов | вся история |
| Период | 30 дней | 12 месяцев |
| Сравнение сетей | нет | да |
| Лучшее время и советы | нет | да |
| Экспорт CSV, PDF-отчёт | нет | да |
| Недельный отчёт на почту | нет | да |

Входит в Suite и Agency (см. `COWORK_AND_AGENCY_PLAN.md`). Цены предварительные. На странице «Coming soon» цены не показываются.

## 4. Этапы

1. **Основа (готово).** Поддомен, страница ожидания, переходы из Post и Studio.
2. **Сбор данных.** Таблицы, опрос по расписанию через cron-воркер, сети первой волны: Bluesky, Mastodon, Reddit, Dev.to, YouTube, подписчики Telegram.
3. **Интерфейс.** Обзор, таблица постов, сравнение с «средним по вашим постам», уровни Free и Pro, включение через `plans` (как Suite).
4. **Meta.** Threads, Facebook Pages, Instagram после проверки приложения.
5. **Отчёты.** Недельный отчёт на почту (со ссылкой отписки), экспорт CSV и PDF.
6. **Клики по ссылкам.** Короткие ссылки со счётчиком как дополнительный источник (отдельное решение).

## 5. Данные и опрос

- Для каждого опубликованного поста уже хранится канал и id поста в сети. Нужны снимки метрик: `post_metrics(post_id, channel_id, taken_at, views, likes, replies, reposts, ...)`.
- Опрос по возрасту поста: через 1 час, 24 часа, 7 дней и 30 дней. Дальше не опрашиваем (метрики почти не меняются), так нагрузка и расход лимитов API остаются малыми.
- `channel_metrics(channel_id, day, followers)`: один снимок в сутки.
- Лимиты сетей и повторные попытки учитывать в cron-воркере; ошибка одной сети не должна останавливать остальные.
- Free хранит 30 дней, Pro 12 месяцев; старше удаляется автоматически.

## 6. Политики и разрешения

- Privacy Policy: добавить абзац про метрики опубликованных постов и сроки их хранения.
- Google и Meta: добавить права на чтение статистики в проверку приложений, описать в заявках, что читаем только метрики своих публикаций.
- Terms: описание Analytics Pro после запуска продажи.

## 7. Риски

- **Задержки проверок** у Google и Meta (недели). Поэтому первая волна без Meta.
- **Закрытые API** (LinkedIn, X): честно показывать «недоступно», не выдумывать цифры.
- **Точность:** сети округляют, цифры могут отличаться от родных кабинетов.

## 8. Что нужно сделать вам, чтобы поддомен заработал

В Cloudflare → Workers & Pages → vaneapp → Custom domains добавить `analytics.vaneapp.dev` (как были добавлены `post.` и `studio.`). До этого ссылки из Post и Studio ведут на домен, который ещё не отвечает.

## 9. Открытые вопросы

1. Порядок сетей первой волны: подходит ли набор из раздела 2?
2. Включать ли расширенный бесплатный уровень в Pro за $9.99?
3. Нужны ли клики по ссылкам в первой версии или отдельным этапом после?

## 10. Dashboard v2 (built)

- **Filters:** network chips (one on by default, any combination, "All"), period (Free 7/30 days, Pro up to 12 months), sort, search (Pro). Only the networks the user switches on are counted: nothing is mixed unless asked.
- **Tabs:** Overview (stats, reactions per day, best posts), Posts (sort, search, pages, CSV export), Followers (numbers for Free, growth charts for Pro), Compare and Best times (Pro), Free and Pro (comparison table, also shown to signed-out visitors).
- **API:** `GET /api/analytics/overview` (filters: `days`, `channels`, `sort`, `page`, `q`), `/api/analytics/insights` (Pro: compare + best times in the user's time zone), `/api/analytics/export` (Pro: CSV).
- **Free vs Pro:** Free = results, filters, daily chart, best posts, followers now and change, 30 days, 10 latest posts. Pro ($4.99, included in Suite) = 12 months, all posts with search and pages, growth charts, compare, best times, CSV, weekly email.

## 11. Telegram bot (built)

- **What:** the Vane Analytics bot (its own bot, separate from the Quick Connect bot). The user connects it from analytics.vaneapp.dev → Telegram bot (one-time link, 15 minutes) and chats with it in private.
- **Commands:** `/stats [7|30]`, `/top` (best post per network), `/followers`, `/scheduled` (also `/queue`, `/upcoming`: posts waiting to go out, with a button to the queue), `/digest`, `/settings` (inline toggles), `/language` (English default, Русский, Українська, Deutsch), `/unlink`.
- **Alerts:** Free: post results after 24 hours, follower milestones. Pro: daily follower changes, hot post (threshold chosen on the site), daily or weekly digest (about 9:00 in the user's time zone, weekly on Monday).
- **Setup (once):** create the bot in @BotFather; on the Pages project add `ANALYTICS_BOT_TOKEN`, `ANALYTICS_BOT_SECRET` (any long random string) and `ANALYTICS_BOT_USERNAME`; add `ANALYTICS_BOT_TOKEN` to the cron worker; deploy; run the whole `schema.sql`; then in /admin → Settings press "Connect webhook" under "Analytics Telegram bot".
- **Code:** `functions/api/lib/analyticsbot.ts` (commands, settings, alerts), `botlang.ts` (the four languages), `functions/api/telegram/analytics.ts` (webhook), `functions/api/analytics/bot.ts` (site settings API), `functions/api/admin/analytics-bot.ts` (webhook setup).
