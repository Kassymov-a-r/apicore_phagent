# IG Playwright Agent — Render Login Version

Отдельный MVP без Meta API. Работает через Instagram Web + Playwright.

## Что умеет

- Веб-панель на Render.
- Добавление нескольких Instagram-аккаунтов.
- Вход через форму логин/пароль прямо в панели.
- Пароль не сохраняется в базе: используется только один раз для входа.
- Сохраняются cookies/session в `/app/storage/sessions`.
- Автоответы в Direct по ключевым словам.
- AI-генерация вариантов ответов через `OPENAI_API_KEY`.
- Логи, лимиты, screenshots ошибок.

## Важно

Это неофициальный способ через Instagram Web. Используй только для своих аккаунтов и осторожно. Не запускай массовые действия, спам, агрессивные лимиты.

## Деплой на Render

Рекомендуемый способ: **New → Blueprint** или **Docker Web Service**.

Render должен использовать Dockerfile из проекта.

В `render.yaml` уже настроено:

- Docker runtime
- persistent disk `/app/storage`
- `HEADLESS=true`
- `SQLITE_PATH=/app/storage/data.sqlite`

Если создаёшь вручную:

- Environment: Docker
- Dockerfile Path: `./Dockerfile`
- Persistent Disk:
  - Mount path: `/app/storage`
  - Size: 1 GB+

## После деплоя

1. Открой домен Render.
2. Перейди в `Аккаунты`.
3. Добавь аккаунт без `@`.
4. Раскрой карточку аккаунта.
5. Введи Instagram username/password.
6. Если есть 2FA — введи код в поле 2FA.
7. Нажми `Войти и сохранить сессию`.
8. Нажми `Проверить`.
9. Создай правило в `Автоматизации`.
10. Нажми `Старт` в карточке аккаунта.

## Env

```env
PORT=3000
HEADLESS=true
SQLITE_PATH=/app/storage/data.sqlite
OPENAI_API_KEY=
POLL_INTERVAL_MS=35000
MAX_REPLIES_PER_ACCOUNT_PER_HOUR=12
DRY_RUN=false
```

## Если Instagram просит checkpoint

В логах появится `login_failed` и screenshot. Иногда нужно:

- зайти в Instagram вручную с того же аккаунта;
- подтвердить вход;
- повторить вход в панели;
- ввести 2FA/security code.

## Healthcheck

```text
/healthz
```
