# IG Agent — Instagram Login API + Detailed Logs

Эта сборка добавляет расширенную диагностику прямо в интерфейсе.

## Что нового

- Вкладка **Логи** теперь раскрывает каждое событие.
- Можно открыть полный JSON лога, связанный webhook event, request/response payload, проверенные правила и ошибки Meta API.
- Polling пишет подробные этапы:
  - `debug_poll_accounts_loaded`
  - `debug_poll_media_request`
  - `debug_poll_media_response`
  - `debug_media_item`
  - `debug_poll_conversations_request`
  - `debug_poll_conversations_response`
  - `poll_finished`
- Webhook пишет подробные этапы:
  - `debug_webhook_processing_started`
  - `debug_webhook_entry`
  - `debug_change_processed`
  - `debug_message_processed`
- Matching пишет `debug_rules_loaded` с полным списком правил и `matchedKeyword`.

## Как пользоваться

1. Задеплой проект на Render.
2. Подключи аккаунт через Instagram Login или Manual Token.
3. Создай правило в разделе **Автоматизации**.
4. Нажми **Логи → Проверить Instagram сейчас**.
5. В списке логов нажми **Раскрыть** на любом событии.

## Переменные

Минимально можно запускать без PostgreSQL: включится JSON fallback.

Для продакшена желательно:

```env
DATABASE_URL=...
INSTAGRAM_CLIENT_ID=...
INSTAGRAM_CLIENT_SECRET=...
META_WEBHOOK_VERIFY_TOKEN=...
APP_BASE_URL=https://your-service.onrender.com
OPENAI_API_KEY=...
DETAILED_LOGS=true
```

Чтобы уменьшить количество debug-записей:

```env
DETAILED_LOGS=false
```

## AI Assistant в интерфейсе

Добавлен раздел **AI Assistant / Помощник проекта**.

Возможности:

- отвечает на вопросы по текущему проекту и интеграции Instagram;
- использует встроенную базу знаний по архитектуре проекта и истории проблем Meta/Instagram Login;
- анализирует текущие аккаунты, правила, последние логи и webhook events;
- создаёт скачиваемые файлы прямо из интерфейса:
  - `assistant-answer-*.md` — ответ помощника;
  - `diagnostic-snapshot-*.json` — снимок текущего состояния проекта;
  - `patch-plan-*.md` — план изменений/патча.

Для полноценного AI-ответа добавь `OPENAI_API_KEY` во вкладке **Секреты** или Render Environment. Если ключ не задан, помощник работает в локальном диагностическом режиме.

Важно: помощник создаёт файлы и инструкции, но не может сам изменить GitHub/Render-деплой. Чтобы применить патч, нужно внести изменения в исходный проект, закоммитить и задеплоить.

## Update: paginated comment edge diagnostics

This build changes comment polling from a single `/{media_id}/comments` request to a paginated fetch. Some Instagram API responses can return `comments_count > 0` and an empty first `data` array while still providing `paging.next`. The poller now follows `paging.next` up to `POLL_COMMENT_MAX_PAGES` pages per media item and logs per-page diagnostics.

New optional env:

```env
POLL_COMMENT_MAX_PAGES=8
```

The logs also redact `access_token` values from `paging.next` URLs.
