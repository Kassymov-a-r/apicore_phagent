# IG Remote Browser Agent — Render robust build

Эта сборка исправляет ошибку Playwright `Executable doesn't exist`.

## Важно
Деплой нужно делать как **Docker Web Service** или через **Blueprint** из `render.yaml`.
Если создать обычный Node Web Service, Render может снова искать браузер в `/opt/render/.cache/ms-playwright`.

## Render deploy
1. Залей проект в GitHub.
2. Render → New → Blueprint → выбери репозиторий.
3. Или Render → New → Web Service → Environment: **Docker**.
4. После деплоя: Manual Deploy → Clear build cache & deploy.

## Что исправлено
- используется официальный Docker image `mcr.microsoft.com/playwright:v1.56.1-jammy`;
- `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`;
- добавлен runtime fallback: если Chromium отсутствует, сервер выполнит `npx playwright install chromium` и повторит запуск браузера.

## Health
Открой `/healthz` после деплоя.
