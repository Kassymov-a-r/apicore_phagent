# IG Agent — Official Instagram Login API

Отдельная Render-ready версия под официальный Instagram API with Instagram Login.

## Что внутри

- Авторизация через Instagram Login flow, похожий на ChatPlace: `instagram.com/accounts/login` → `/oauth/authorize/third_party`.
- Альтернативный direct authorize URL: `/auth/instagram/direct`.
- Facebook fallback URL: `/auth/facebook-fallback` для старого Page-flow.
- Manual Token Connect — можно вставить официальный Instagram User Access Token из Meta, если OAuth ещё настраивается.
- Webhooks: comments, live_comments, mentions, messages.
- Правила: ключевые слова, варианты публичных ответов, варианты ответов в Direct.
- AI-помощник для генерации текстов ответов.
- Логи, raw webhook events, keyword test, ручной Poll fallback.

## Важная правда про Meta

1. Для своих тестовых аккаунтов приложение может работать в Development, если аккаунты добавлены в роли/testers и permissions доступны.
2. Для подключения чужих клиентов и стабильной работы на публичных аккаунтах нужен Live Mode + App Review / Advanced Access.
3. Неофициальные варианты через логин/пароль, private API или браузерную автоматизацию не подходят для масштабируемого SaaS: они нестабильны и могут привести к блокировкам.
4. Лучший production-путь для SaaS: один одобренный Meta App у владельца платформы, пользователи просто подключают свои Instagram Professional аккаунты.

## Render deploy

Лучший способ: Render → New → Blueprint → выбрать репозиторий с `render.yaml`.

Минимальные env vars:

```env
APP_BASE_URL=https://your-service.onrender.com
INSTAGRAM_CLIENT_ID=your_instagram_or_meta_app_id
INSTAGRAM_CLIENT_SECRET=your_app_secret
META_WEBHOOK_VERIFY_TOKEN=any-long-random-string
DRY_RUN=false
```

Можно использовать `META_APP_ID` и `META_APP_SECRET` вместо `INSTAGRAM_CLIENT_ID` / `INSTAGRAM_CLIENT_SECRET`.

## Meta setup

В Meta Developer Dashboard для Instagram API / Instagram Login добавь redirect URI:

```text
https://your-service.onrender.com/auth/instagram/callback
```

Webhook callback:

```text
https://your-service.onrender.com/webhook/instagram
```

Verify token должен совпадать с `META_WEBHOOK_VERIFY_TOKEN`.

Подписанные поля:

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

## Проверка

Открой:

```text
/api/auth/debug
```

Проверь:

- `hasAppId: true`
- `hasAppSecret: true`
- `callbackUrl` совпадает с Meta redirect URI
- `instagramLoginUrl` начинается с `https://www.instagram.com/accounts/login/`

## Manual Token Connect

Если OAuth ещё не проходит, можно временно использовать официальный токен:

1. Meta → Instagram API setup.
2. Добавить Instagram tester.
3. Сгенерировать token.
4. В платформе → Аккаунты → Manual Token Connect.

## Poll fallback

Кнопка `Poll comments/messages сейчас` пробует официально получить комментарии и разговоры через API без webhook. Webhooks всё равно лучше и рекомендованы для production.
