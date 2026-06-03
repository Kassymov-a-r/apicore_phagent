# IG Remote Browser Agent — Render Browser Fixed

Эта версия исправляет ошибку Render:

`Executable doesn't exist ... chrome-headless-shell`

Причина была в том, что Playwright был установлен, но Chromium не был установлен или версия Chromium не совпадала с версией Playwright.

## Деплой на Render

Используй **Docker Web Service** или **Blueprint**.

Важно: не деплой как обычный Node Web Service.

После загрузки новой версии сделай:

`Manual Deploy -> Clear build cache & deploy`

## Что изменено

- Docker image обновлён до `mcr.microsoft.com/playwright:v1.56.1-jammy`
- `playwright` зафиксирован на версии `1.56.1`
- добавлен `RUN npx playwright install chromium`
- добавлен `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`
- добавлен persistent disk `/app/storage`

## Проверка

Открой:

`/healthz`

Потом в панели создай аккаунт и нажми открыть Remote Browser.
