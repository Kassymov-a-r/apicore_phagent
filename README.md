# IG Agent — Instagram Login third-party OAuth version

Чистый проект под **Instagram Login API** без Facebook Page flow и без Playwright.

## Что внутри

- OAuth через Instagram web login flow, похожий на ChatPlace:
  - `https://www.instagram.com/accounts/login/`
  - `next=/oauth/authorize/third_party/`
- Scopes:
  - `instagram_business_basic`
  - `instagram_business_manage_comments`
  - `instagram_business_manage_messages`
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
INSTAGRAM_CLIENT_ID=...
INSTAGRAM_CLIENT_ID=
META_APP_ID=... # optional fallback
META_APP_SECRET=...
META_WEBHOOK_VERIFY_TOKEN=любая_строка
META_GRAPH_VERSION=v23.0
DRY_RUN=false
OPENAI_API_KEY=...
```

## Meta / Instagram API settings

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

After deploy, open:

```text
/api/auth/debug
/api/meta/debug
/api/webhook/events
/api/logs
/api/debug/match?text=апикор
```

`/api/auth/debug` should show:

```text
flow: instagram_accounts_login_third_party
loginUrl: https://www.instagram.com/accounts/login/?...
thirdPartyUrl: https://www.instagram.com/oauth/authorize/third_party/?...
```

## Important

This uses the Instagram-style OAuth screen, but it is still official Meta/Instagram OAuth. It does not bypass Meta policies. Real comments/messages can still be restricted until the app has the required access and is available for the tested Instagram account.


## Fix for `Missing client_id`

The app now accepts the Instagram client ID from any of these environment variables, in this priority order:

```text
INSTAGRAM_CLIENT_ID
INSTAGRAM_APP_ID
META_APP_ID
APP_ID
```

For Instagram Login, prefer setting `INSTAGRAM_CLIENT_ID` to the Instagram API / Instagram Login App ID shown in Meta. After deploy, open `/api/auth/debug` and confirm:

```json
{
  "hasAppId": true,
  "clientIdSource": "INSTAGRAM_CLIENT_ID",
  "loginUrl": "https://www.instagram.com/accounts/login/...client_id=..."
}
```
