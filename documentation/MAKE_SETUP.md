# Make: ручная настройка приложения Vane (пошагово)

Если приложение собирается руками в Make (Custom Apps), каждую вкладку нужно заполнить **ровно** так. Все значения взяты из `integrations/make/`.

## Правила, на которых всё ломается

1. **Поле ключа в Connection называется `apiKey`** (регистр важен). Ключ берётся как `{{connection.apiKey}}`. Если поле названо иначе, заголовок уйдёт пустым и будет `[401] Missing API key`.
2. **Подключение в сценарии нужно создать заново после любых правок поля ключа.** Старое подключение хранит значение под старым именем и продолжает слать пустой ключ. Удали подключение в сценарии (Credentials → удалить) и создай новое.
3. **Заголовок `Authorization` есть в каждом модуле и RPC** (в репо он прописан в каждой вкладке Communication), поэтому от вкладки Base нужен только `baseUrl`.
4. **Имя RPC любое, но оно должно совпадать со ссылкой.** Если RPC называется `vaneapp`, то в поле Channels стоит `"options": "rpc://vaneapp"`. В репо RPC называется `listChannels`, ссылка `rpc://listChannels`.
5. **Поля, которые пользователь заполняет в модуле (текст, время, каналы), лежат в Mappable parameters**, а не в Static parameters. Только из Mappable можно подставлять значения из предыдущих модулей (строка Notion или Google Sheets, результат другого модуля). В Static остаётся пустой список `[]`.

## 1. Base

```json
{
  "baseUrl": "https://vaneapp.dev/api/v1",
  "headers": {
    "Authorization": "Bearer {{connection.apiKey}}",
    "Content-Type": "application/json",
    "Accept": "application/json"
  },
  "response": {
    "error": {
      "message": "[{{statusCode}}] {{body.error}}{{if(body.code; \" (\" + body.code + \")\"; \"\")}}"
    }
  },
  "log": {
    "sanitize": [
      "request.headers.authorization"
    ]
  }
}
```

## 2. Connection (тип: Basic)

*Parameters*:

```json
[
  {
    "name": "apiKey",
    "type": "password",
    "label": "API key",
    "required": true,
    "help": "Create it in the Vane dashboard. Starts with cpost_live_ (real posts) or cpost_test_ (nothing is posted or counted)."
  }
]
```

*Communication* (проверка ключа):

```json
{
  "url": "/me",
  "method": "GET",
  "headers": {
    "Authorization": "Bearer {{connection.apiKey}}",
    "Content-Type": "application/json",
    "Accept": "application/json"
  },
  "response": {
    "temp": {
      "keyName": "{{body.key.name}}"
    }
  }
}
```

## 3. Remote procedure (список каналов)

Имя RPC: `listChannels`. *Communication*:

```json
{
  "url": "/channels",
  "method": "GET",
  "headers": {
    "Authorization": "Bearer {{connection.apiKey}}",
    "Content-Type": "application/json",
    "Accept": "application/json"
  },
  "response": {
    "iterate": "{{body.channels}}",
    "output": {
      "label": "{{item.name}} ({{item.platform}})",
      "value": "{{item.id}}"
    }
  }
}
```

*Test RPC* вернёт список вида `{"label": "VaneNews (telegram)", "value": "<id>"}`. На вкладке *Connections* внизу страницы RPC должно быть выбрано подключение VaneApp.

## 4. Модули

Для каждого модуля вкладки: *Communication*, *Static parameters*, *Mappable parameters*, *Interface*.

### Schedule a Post (Action)

*Communication*:

```json
{
  "url": "/posts",
  "method": "POST",
  "headers": {
    "Authorization": "Bearer {{connection.apiKey}}",
    "Content-Type": "application/json",
    "Accept": "application/json"
  },
  "body": {
    "content": "{{parameters.content}}",
    "channelIds": "{{parameters.channelIds}}",
    "scheduledAt": "{{parameters.scheduledAt}}",
    "mediaUrl": "{{ifempty(parameters.mediaUrl; null)}}"
  },
  "response": {
    "output": "{{body}}"
  }
}
```

*Static parameters*: `[]`

*Mappable parameters*:

```json
[
  {
    "name": "channelIds",
    "type": "array",
    "label": "Channels",
    "required": true,
    "spec": {
      "type": "select",
      "options": "rpc://listChannels"
    },
    "help": "Where to publish. One run counts as one post against your quota, however many channels you pick."
  },
  {
    "name": "content",
    "type": "text",
    "label": "Text",
    "required": true,
    "multiline": true
  },
  {
    "name": "scheduledAt",
    "type": "date",
    "label": "Publish at",
    "required": true,
    "help": "Must be in the future."
  },
  {
    "name": "mediaUrl",
    "type": "url",
    "label": "Image URL",
    "help": "Optional. A public https link to an image."
  }
]
```

*Interface*:

```json
[
  {
    "name": "groupId",
    "type": "text",
    "label": "Group ID"
  },
  {
    "name": "scheduledAt",
    "type": "number",
    "label": "Scheduled at (unix seconds)"
  },
  {
    "name": "test",
    "type": "boolean",
    "label": "Test run (nothing was posted)"
  },
  {
    "name": "overage",
    "type": "boolean",
    "label": "Billed as an extra post"
  },
  {
    "name": "posts",
    "type": "array",
    "label": "Posts",
    "spec": [
      {
        "name": "id",
        "type": "text",
        "label": "Post ID"
      },
      {
        "name": "channelId",
        "type": "text",
        "label": "Channel ID"
      },
      {
        "name": "status",
        "type": "text",
        "label": "Status"
      }
    ]
  }
]
```

### Get a Post (Action)

*Communication*:

```json
{
  "url": "/posts/{{parameters.id}}",
  "method": "GET",
  "headers": {
    "Authorization": "Bearer {{connection.apiKey}}",
    "Content-Type": "application/json",
    "Accept": "application/json"
  },
  "response": {
    "output": "{{body.post}}"
  }
}
```

*Static parameters*: `[]`

*Mappable parameters*:

```json
[
  {
    "name": "id",
    "type": "text",
    "label": "Post ID",
    "required": true
  }
]
```

*Interface*:

```json
[
  {
    "name": "id",
    "type": "text",
    "label": "Post ID"
  },
  {
    "name": "groupId",
    "type": "text",
    "label": "Group ID"
  },
  {
    "name": "channelId",
    "type": "text",
    "label": "Channel ID"
  },
  {
    "name": "channelName",
    "type": "text",
    "label": "Channel name"
  },
  {
    "name": "platform",
    "type": "text",
    "label": "Network"
  },
  {
    "name": "content",
    "type": "text",
    "label": "Text"
  },
  {
    "name": "mediaUrl",
    "type": "text",
    "label": "Media URL"
  },
  {
    "name": "status",
    "type": "text",
    "label": "Status"
  },
  {
    "name": "scheduledAt",
    "type": "number",
    "label": "Scheduled at (unix seconds)"
  },
  {
    "name": "sentAt",
    "type": "number",
    "label": "Sent at (unix seconds)"
  },
  {
    "name": "error",
    "type": "text",
    "label": "Error"
  }
]
```

### Cancel a Post (Action)

*Communication*:

```json
{
  "url": "/posts/{{parameters.id}}",
  "method": "DELETE",
  "headers": {
    "Authorization": "Bearer {{connection.apiKey}}",
    "Content-Type": "application/json",
    "Accept": "application/json"
  },
  "response": {
    "output": "{{body}}"
  }
}
```

*Static parameters*: `[]`

*Mappable parameters*:

```json
[
  {
    "name": "id",
    "type": "text",
    "label": "Post ID",
    "required": true,
    "help": "Only a post that is still scheduled can be cancelled. The quota unit is not given back."
  }
]
```

*Interface*:

```json
[
  {
    "name": "ok",
    "type": "boolean",
    "label": "Cancelled"
  }
]
```

### List Posts (Search)

*Communication*:

```json
{
  "url": "/posts",
  "method": "GET",
  "headers": {
    "Authorization": "Bearer {{connection.apiKey}}",
    "Content-Type": "application/json",
    "Accept": "application/json"
  },
  "qs": {
    "view": "{{parameters.view}}"
  },
  "response": {
    "iterate": "{{body.posts}}",
    "limit": "{{parameters.limit}}",
    "output": "{{item}}"
  }
}
```

*Static parameters*:

```json
[
  {
    "name": "view",
    "type": "select",
    "label": "Which posts",
    "default": "upcoming",
    "options": [
      {
        "label": "Upcoming",
        "value": "upcoming"
      },
      {
        "label": "History (sent, failed, cancelled)",
        "value": "history"
      }
    ]
  },
  {
    "name": "limit",
    "type": "uinteger",
    "label": "Limit",
    "default": 10,
    "help": "The maximum number of posts returned in one run."
  }
]
```

*Mappable parameters*: `[]`

*Interface*:

```json
[
  {
    "name": "id",
    "type": "text",
    "label": "Post ID"
  },
  {
    "name": "groupId",
    "type": "text",
    "label": "Group ID"
  },
  {
    "name": "channelId",
    "type": "text",
    "label": "Channel ID"
  },
  {
    "name": "channelName",
    "type": "text",
    "label": "Channel name"
  },
  {
    "name": "platform",
    "type": "text",
    "label": "Network"
  },
  {
    "name": "content",
    "type": "text",
    "label": "Text"
  },
  {
    "name": "mediaUrl",
    "type": "text",
    "label": "Media URL"
  },
  {
    "name": "status",
    "type": "text",
    "label": "Status"
  },
  {
    "name": "scheduledAt",
    "type": "number",
    "label": "Scheduled at (unix seconds)"
  },
  {
    "name": "sentAt",
    "type": "number",
    "label": "Sent at (unix seconds)"
  },
  {
    "name": "error",
    "type": "text",
    "label": "Error"
  }
]
```

### List Channels (Search)

*Communication*:

```json
{
  "url": "/channels",
  "method": "GET",
  "headers": {
    "Authorization": "Bearer {{connection.apiKey}}",
    "Content-Type": "application/json",
    "Accept": "application/json"
  },
  "response": {
    "iterate": "{{body.channels}}",
    "output": "{{item}}"
  }
}
```

*Static parameters*:

```json
[]
```

*Mappable parameters*: `[]`

*Interface*:

```json
[
  {
    "name": "id",
    "type": "text",
    "label": "Channel ID"
  },
  {
    "name": "platform",
    "type": "text",
    "label": "Network"
  },
  {
    "name": "name",
    "type": "text",
    "label": "Name"
  },
  {
    "name": "isActive",
    "type": "boolean",
    "label": "Active"
  },
  {
    "name": "createdAt",
    "type": "number",
    "label": "Connected at (unix seconds)"
  }
]
```

## 5. Проверка в сценарии

1. Создай новое подключение: вставь ключ `cpost_test_…` (ничего не публикуется и не списывается). Make проверит его запросом `GET /me`.
2. В модуле **Schedule a Post** в поле *Channels* переключатель **Map** выключен: открывается выпадающий список каналов по именам. Если вместо него красная ошибка `[401]`, значит подключение в сценарии держит пустой ключ (правила 1 и 2).
3. *Publish at* должно быть в будущем.
4. *Run once*. С тестовым ключом ответ содержит `"test": true`; потом замени ключ на `cpost_live_…`.

## Частые ошибки

| Что видишь | Причина |
|---|---|
| `[401] Missing API key` под полем Channels или в модуле | подключение в сценарии держит пустой ключ: поле названо не `apiKey`, или подключение создано до правки. Создай новое |
| `[401] Invalid API key` | ключ неверный или отозван; ключи для видео (`cvid_`) не подходят |
| Выпадающего списка каналов нет, можно только вписать id | включён переключатель Map, или имя в `rpc://…` не совпадает с именем RPC |
| Нельзя подставить текст из предыдущего модуля | поля лежат в Static parameters, перенеси в Mappable |
| `[400] scheduledAt must be in the future` | время публикации уже прошло |
| `[402] … (quota_exceeded)` | исчерпан лимит постов тарифа |
