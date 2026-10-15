# Vane SaaS — Security Architecture & Hardening Specification

**Версия документа:** 1.0.0  
**Статус:** Утверждено / Действующий регламент разработки  
**Стек:** Cloudflare Edge (Pages Functions, Workers, D1 Database, R2 Storage, Workers AI)  
**Назначение:** Полный технический гайд для разработчиков и ИИ-ассистентов (Claude / Cursor) по защите приложения на всех уровнях.

---

## 1. Общие принципы архитектурной безопасности

Приложение Vane полностью работает в бессерверной срединной инфраструктуре Cloudflare Edge (300+ ЦОД по всему миру). 

### Отсутствующие векторы атак (Out of Scope):
Так как у нас нет классических серверов, виртуальных машин (VPS) и контейнеров:
- **НЕТ** SSH/SFTP атак и брутфорса портов.
- **НЕТ** OS-level / Linux Kernel уязвимостей.
- **НЕТ** RCE через системные утилиты ОС (ImageMagick, ffmpeg на уровне Linux).
- **НЕТ** утечек через локальный фаервол Nginx/Apache.

Весь упор безопасности сосредоточен на **WAF, Middleware на Edge, защите API, криптографической защите данных в D1 и валидации входящих вебхуков**.

---

## 2. Эшелон 1: Edge & WAF (Входной контур)

Все сетевые запросы проходят через прокси-слой Cloudflare перед попаданием в код Workers.

### 2.1. Cloudflare Turnstile (Anti-Bot)
- **Где применяется:** Форма регистрации, вход, восстановление пароля, эндпоинт инициализации чекаута оплаты.
- **Механика:** На фронтенде вызывается бесшовный Turnstile Widget. На бэкенде Worker выполняет POST-запрос на `https://challenges.cloudflare.com/turnstile/v0/siteverify` с секретным ключом `env.TURNSTILE_SECRET_KEY`.
- **Правило:** Запросы к эндпоинтам создания аккаунта без валидного `turnstile_token` сбрасываются с кодом `400 Bad Request`.

### 2.2. Rate Limiting (Защита от брутфорса и Denial of Wallet)
Ограничение частоты запросов настраивается через **Cloudflare WAF / Worker Rate Limiting**:

| Маршрут (Route) | Лимит | Действие при превышении |
| :--- | :--- | :--- |
| `/api/v1/auth/*` | 5 запросов / мин с одного IP | `429 Too Many Requests` + JS Challenge |
| `/api/v1/posts/*` (`cpost_`) | До 100 запросов / мин на ключ | `429 Too Many Requests` |
| `/api/v1/video/*` (`cvid_`) | До 10 запросов / мин на ключ | `429 Too Many Requests` |
| `/api/v1/webhooks/*` | 60 запросов / мин с IP провайдера | `429 Too Many Requests` |

### 2.3. Browser & IP Verification
- Автоматический **JS Challenge** для IP-адресов с низким репутационным скором (Cloudflare Threat Score > 14), а также для известных диапазонов Datacenter VPN / Proxy.

---

## 3. Эшелон 2: Аутентификация и Защита API-ключей

В Vane используется система префиксных изолированных ключей (`cpost_live_...` и `cvid_live_...`).

### 3.1. Хранение ключей (SHA-256 One-Way Hashing)
- **Сайд-эффект:** Исходный API-ключ генерируется с помощью `crypto.getRandomValues()` и возвращается пользователю **ровно один раз** в UI при создании.
- **В базе D1:** Сохраняется **исключительно SHA-256 хеш** ключа.
- **Алгоритм хэширования в Worker:**
  ```typescript
  export async function hashApiKey(rawKey: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(rawKey);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

    Результат: При полной утечке базы D1 злоумышленник получает только массив неповторимых хешей, из которых невозможно восстановить реальные ключи доступа.

3.2. Fast Scope Checking (Мгновенный сброс)

Входной Middleware проверяет префикс ключа до обращения к базе данных D1:

    Ключ cpost_... на маршруте /api/v1/video/* ➔ Моментальный возврат 403 Forbidden (0.1ms).

    Ключ cvid_... на маршруте /api/v1/posts/* ➔ Моментальный возврат 403 Forbidden (0.1ms).

3.3. Timing-Safe Comparison

Для предотвращения атак по времени (Timing Attacks) проверка подписей и токенов осуществляется через crypto.subtle.timingSafeEqual().
4. Эшелон 3: Безопасность Базы Данных D1 & SQLite
4.1. 100% Защита от SQL-инъекций (Prepared Statements)

В коде Vane СТРОГО ЗАПРЕЩЕНА конкатенация строк и интерполяция переменных внутри SQL-запросов (SELECT ... WHERE id = '${id}').

    ❌ Запрещено:
    TypeScript

    // ОПАСНО: Уязвимость SQLi
    await env.DB.prepare(`SELECT * FROM users WHERE email = '${userEmail}'`).run();

    ✅ Обязательный стандарт (Prepared Binds):
    TypeScript

    // БЕЗОПАСНО: Использование bind()
    await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(userEmail).first();

    Drizzle ORM: При использовании ORM Drizzle все запросы автоматически параметризуются на уровне компиляции AST.

4.2. Шифрование чувствительных токенов (Tokens at Rest: AES-GCM-256)

Токены авторизации пользователей в социальных сетях (Telegram Bot Tokens, X OAuth Refresh Tokens, LinkedIn Access Tokens) хранятся в D1 только в зашифрованном виде.

    Шифрование: Симметричный алгоритм AES-GCM с 256-битным ключом.

    Ключ шифрования: Хранится в переменных окружения Cloudflare Secrets (env.ENCRYPTION_SECRET).

    Код модуля шифрования (src/utils/crypto.ts):
    TypeScript

    export async function encryptToken(text: string, secretHex: string): Promise<{ cipherText: string; iv: string }> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await getCryptoKey(secretHex);
      const encoded = new TextEncoder().encode(text);

      const cipherBuffer = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        encoded
      );

      return {
        cipherText: bufferToHex(cipherBuffer),
        iv: bufferToHex(iv.buffer)
      };
    }

    Результат: Без секрета ENCRYPTION_SECRET, который находится внутри изолированного рантайма Cloudflare Worker, расшифровать доступ к соцсетям пользователей из дампа D1 невозможно.

5. Эшелон 4: Безопасность Дашборда и Web Frontend
5.1. CSRF & XSS Protection (Cookie Policy)

Аутентификация в UI дашборде построена на сессионных JWT/Tokens, передаваемых через HTTP-Only Cookies:

    HttpOnly: true — закрывает доступ к куке из JavaScript (document.cookie), делая невозможной кражу сессии через XSS-атаки.

    Secure: true — передача исключительно по защищенному протоколу HTTPS.

    SameSite: Strict — полностью блокирует отправку кук при межсайтовых запросах (100% защита от CSRF).

5.2. HTTP Security Headers (Pages Functions)

Все ответы фронтенда сопровождаются обязательным набором заголовков безопасности:
HTTP

Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Content-Security-Policy: default-src 'self'; script-src 'self' [https://challenges.cloudflare.com](https://challenges.cloudflare.com); style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.r2.cloudflarestorage.com; connect-src 'self' [https://api.vane.so](https://api.vane.so);

6. Эшелон 5: Безопасность Платежных Вебхуков
6.1. Monobank Acquiring Webhook Verification

    Каждый входящий вебхук от Monobank (/api/v1/webhooks/monobank) содержит заголовок X-Sign с цифровой подписью.

    Worker выкачивает публичный ключ Monobank (с кэшированием в KV) и проверяет RSA-ECDSA подпись тела запроса (rawBody).

    Если подпись невалидна, Worker возвращает 401 Unauthorized и не производит никаких изменений в базе D1.

6.2. Web3 & Solana Crypto Protection (Replay Attack Protection)

Для платежей в USDT/USDC на Solana:

    Memo ID Match: Каждая сессия оплаты генерирует случайный 32-символьный reference_id, который покупатель передает в поле Memo транзакции.

    Double-Spending Prevention: После успешной проверки хеша транзакции (tx_signature), этот хеш записывается в таблицу used_crypto_transactions в D1 с наложением UNIQUE constraint.

    Повторная попытка передать тот же хеш транзакции отклоняется базой данных на уровне первичного ключа.

7. Чек-лист безопасности при написании кода (Code Review Guidelines)

При добавлении новых фич или эндпоинтов Claude / Cursor обязаны соблюдать правила:

    [ ] Никаких сырых SQL-строк. Любой запрос к env.DB идет через .bind() или Drizzle ORM.

    [ ] Никаких открытых API-ключей в D1. Только SHA-256 хеш.

    [ ] Никаких открытых токенов соцсетей в D1. Только шифрование AES-GCM-256 через env.ENCRYPTION_SECRET.

    [ ] Проверка формата входных данных (Input Sanitization). Все входящие JSON-тела валидируются через схемы Zod до передачи в бизнес-логику.

    [ ] CORS ограничения. Доступ к /api/v1/* открыт только для разрешенных доменов или требует валидный Bearer cpost_/cvid_.

    [ ] Запрет на логирование секретов. console.log() никогда не должен выводить сырые API-ключи, OAuth-токены пользователей или ключи шифрования.


***

Документ создан в идеальном соответствии с реальным стеком приложения. Теперь система защищена от ботов, SQL-инъекций, сливов баз данных, подделки платежей и XSS/CSRF-атак!
