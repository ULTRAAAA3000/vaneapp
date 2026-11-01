# Make: ручная настройка приложения Vane (пошагово)

Если приложение собирается руками в Make (Custom Apps → Create a new app), каждую вкладку нужно заполнить **ровно** так. Все значения ниже взяты из `integrations/make/`.

## Три правила, на которых всё ломается

1. **Имя поля ключа в Connection должно быть `apiKey`** (регистр важен). Во всех запросах ключ берётся как `{{connection.apiKey}}`. Если поле называется иначе, заголовок уйдёт пустым и Vane ответит `[401] Missing API key`.
2. **В каждом модуле и RPC должен быть заголовок `Authorization`.** В репо он прописан в каждой вкладке Communication, поэтому вкладка Base (общие заголовки) может оставаться пустой, кроме `baseUrl`.
3. **RPC должен называться `listChannels`**, потому что поле Channels ссылается на `rpc://listChannels`. RPC с другим именем (например `VaneApp`) для списка каналов не подходит, и выпадающий список останется пустым.

## 1. Base

Вкладка *Base* (общие настройки):

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

## 2. Connection (тип: Basic, поле ключа)

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

## 3. Remote procedure `listChannels`

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

Кнопка *Test RPC* должна вернуть список вида `{"label": "VaneNews (telegram)", "value": "<id>"}`.

## 4. Модули

Для каждого модуля: *Communication* → *Mappable parameters* → *Interface*.

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

*Mappable parameters*:

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

*Mappable parameters*:

```json
[]
```

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

1. Создай подключение: вставь ключ `cpost_test_…` (ничего не публикуется и не списывается). Make сразу проверит его запросом `GET /me`.
2. В модуле **Schedule a Post** поле *Channels*: переключатель **Map** должен быть **выключен**, тогда откроется выпадающий список каналов по именам. Если список пуст, проверь правило 3.
3. *Publish at* должно быть в будущем.
4. Запусти *Run once*. С тестовым ключом ответ содержит `"test": true`; потом замени ключ на `cpost_live_…`.

## Частые ошибки

| Что видишь | Причина |
|---|---|
| `[401] Missing API key` в модуле, а Test RPC проходит | в *Communication* модуля нет заголовка `Authorization` (или в Connection поле называется не `apiKey`) |
| `[401] Invalid API key` | ключ неверный или отозван; ключи для видео (`cvid_`) не подходят |
| Выпадающий список каналов пуст, можно только вписать id | RPC называется не `listChannels`, или включён переключатель Map |
| `[400] scheduledAt must be in the future` | время публикации уже прошло |
| `[402] … (quota_exceeded)` | исчерпан лимит постов тарифа |
