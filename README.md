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
