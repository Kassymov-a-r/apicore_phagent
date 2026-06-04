# IG Agent — Instagram Login API version

Новый чистый проект под **Instagram API with Instagram Login**.

## Что внутри

- OAuth через `https://www.instagram.com/oauth/authorize`
- Без Facebook Login flow
- Без `pages_manage_metadata`
- Без `pages_messaging`
- Без `pages_*` зависимостей в OAuth
- Webhook endpoint: `/webhook/instagram`
- Accounts, Automations, Logs, Debug
- AI генератор ответов через OpenAI

## Render deploy

1. Залей проект в GitHub.
2. Render → New → Blueprint или Web Service.
3. Добавь PostgreSQL.
4. Environment:

```env
DATABASE_URL=...
APP_BASE_URL=https://your-service.onrender.com
META_APP_ID=...
META_APP_SECRET=...
META_WEBHOOK_VERIFY_TOKEN=любая_строка
META_GRAPH_VERSION=v23.0
DRY_RUN=false
OPENAI_API_KEY=...
```

## Meta settings

Instagram API → Instagram Login:

Valid OAuth Redirect URI:

```text
https://your-service.onrender.com/auth/instagram/callback
```

Webhooks:

Callback URL:

```text
https://your-service.onrender.com/webhook/instagram
```

Verify token: same as `META_WEBHOOK_VERIFY_TOKEN`.

Subscribe fields:

```text
comments
live_comments
mentions
messages
message_edit
message_reactions
messaging_postbacks
messaging_seen
```

## Debug

```text
/api/meta/debug
/api/webhook/events
/api/logs
/api/debug/match?text=апикор
```

## Important

Meta can still restrict real comment/message payloads until the app is approved or available for the tested Instagram account. This project removes the Facebook Page flow, but does not bypass Meta policies.
