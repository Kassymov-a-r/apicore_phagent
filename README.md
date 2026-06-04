# IG Agent — Instagram Login API + встроенные настройки

Это новая сборка, где ключи можно задать прямо в интерфейсе во вкладке **Секреты / настройки**.

## Что уже заполнено в проекте

В проект добавлены built-in значения:

- `INSTAGRAM_CLIENT_ID` / `META_APP_ID`: уже заполнены твоим App ID.
- `INSTAGRAM_CLIENT_SECRET` / `META_APP_SECRET`: уже заполнены твоим текущим App Secret.
- `META_GRAPH_VERSION`: `v23.0`.
- `META_WEBHOOK_VERIFY_TOKEN`: `apicore_igagent_verify_2026`.
- `DRY_RUN`: `false`.

Приоритет настроек:

1. Значения из вкладки **Секреты / настройки**.
2. Render Environment.
3. Built-in значения внутри проекта.

## Что всё равно нужно для Render

Если деплоишь через Blueprint, `render.yaml` сам создаст PostgreSQL и подставит `DATABASE_URL`.

Если деплоишь обычным Web Service, вручную добавь:

```env
DATABASE_URL=Internal Database URL из Render PostgreSQL
APP_BASE_URL=https://твой-домен.onrender.com
```

`APP_BASE_URL` можно также вписать в интерфейсе, но лучше указать в Render Environment.

## Webhook в Meta

Callback URL:

```text
https://твой-домен.onrender.com/webhook/instagram
```

Verify Token:

```text
apicore_igagent_verify_2026
```

Redirect URI для Instagram Login:

```text
https://твой-домен.onrender.com/auth/instagram/callback
```

## Проверка после деплоя

Открой:

```text
/api/auth/debug
```

Должно быть:

```json
{
  "hasAppId": true,
  "hasAppSecret": true
}
```

## Разделы платформы

- **Setup** — проверка конфигурации.
- **Аккаунты** — подключение Instagram, ручной token connect, удаление аккаунтов.
- **Автоматизации** — ключевые слова, ответы на комментарии, ответы в Direct, AI-генератор.
- **Логи** — входящие события, совпадения, ошибки отправки.
- **Секреты** — ввод/обновление всех ID, secret, token и OpenAI key.
- **Debug** — auth debug, webhook events, keyword test, health.

## Важно

Instagram Login API остаётся официальным Meta/Instagram flow. Для стабильной работы на чужих аккаунтах всё равно может понадобиться Live Mode и одобрение permissions. Эта сборка убирает путаницу с env-файлами и позволяет вводить/менять ключи из интерфейса.
