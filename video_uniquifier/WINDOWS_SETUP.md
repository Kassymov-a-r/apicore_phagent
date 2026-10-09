# Запуск на том же компьютере, где APICORE.BOT

В сохранённом архиве APICORE.BOT найдены:

- `start_bot.bat`: Python `%LOCALAPPDATA%\Programs\Python\Python312\python.exe`;
- `install_scheduled_tasks.ps1`: локальные задачи Windows;
- журнал с путём `C:\Users\ak\OneDrive\Рабочий стол\APICORE.BOT\run_delivery_status_agent.py`.

Это подтверждает локальный запуск на Windows на момент создания архива в июне 2026. Текущее состояние компьютера/процесса не проверено: у этой сессии нет доступа к твоему ПК. Настроить и запустить его там автоматически отсюда нельзя.

## Как запустить

1. Распакуй папку `video-uniquifier` рядом с папкой `APICORE.BOT` на том же ПК. Все её настройки отдельные. Не заменяй файлы APICORE.BOT.
2. Взятый из APICORE.BOT путь Python 3.12 уже прописан в `start_video_bot.bat`.
3. Для FFmpeg нужны `ffmpeg.exe` и `ffprobe.exe` версии 6.1 или новее. Если они уже доступны через `PATH`, ничего добавлять не нужно. Иначе возьми Windows-сборку по ссылкам на [официальной странице FFmpeg](https://ffmpeg.org/download.html#build-windows) и положи оба файла и необходимые DLL в `video-uniquifier\tools\ffmpeg\bin\`.
4. Создай отдельного бота у @BotFather. **Не копируй токен действующего APICORE.BOT**: два polling-процесса на одном токене будут конфликтовать. На одном ПК можно одновременно запускать ботов с разными токенами.
5. Дважды нажми `start_video_bot.bat`. При первом запуске откроется `.env` в Блокноте. Заполни `TELEGRAM_BOT_TOKEN` токеном нового бота и `ALLOWED_USER_IDS` своим Telegram ID. ID можно узнать у @userinfobot. Сохрани файл и закрой Блокнот — бот продолжит запуск.
6. В Telegram отправь новому боту `/start`, затем видео как файл/без сжатия. Он вернёт пять MP4 в этот же чат.

Окно должно оставаться открытым. Остановка — `Ctrl+C`. Этот бот работает, пока ПК включён, подключён к интернету и не спит. Факт размещения рядом с APICORE.BOT не делает запуск круглосуточным.

## Автозапуск, как у APICORE

После успешного ручного запуска закрой окно бота и дважды нажми `install_video_autostart.bat`. Будет создана отдельная задача Windows `VIDEO - Telegram Uniquifier`, запускающая бота при входе твоего пользователя. Пароль Windows не требуется. Задачи APICORE не изменяются.

Для запуска сразу после установки выполни в PowerShell:

```powershell
Start-ScheduledTask -TaskName "VIDEO - Telegram Uniquifier"
```

В фоновом режиме журнал находится в `video-uniquifier\logs\video_bot.log`.

Остановить фоновый экземпляр:

```powershell
Stop-ScheduledTask -TaskName "VIDEO - Telegram Uniquifier"
```

Удалить только его автозапуск:

```powershell
Unregister-ScheduledTask -TaskName "VIDEO - Telegram Uniquifier" -Confirm:$false
```

## Большие файлы

Для первого запуска оставь обычный Bot API: вход до 20 MiB, выход до 50 MiB. Для исходников крупнее нужен локальный **Telegram Bot API server**, даже если Python-бот уже работает на твоём компьютере. Это две разные службы.

В основном README есть вариант Docker Compose с официальным локальным API, общим диском и лимитом 500 MiB на вход. На Windows его можно запускать через Docker Desktop. Инструкция нативной установки локального API есть у [Telegram](https://github.com/tdlib/telegram-bot-api); сборка этого сервера в архив не включена.

## Что проверено

Обработка роликов и отправка пяти результатов проверены автоматическими тестами. Управление процессами и блокировка второго экземпляра адаптированы под Windows и POSIX. Реальный запуск Windows, регистрация задания и живая доставка в Telegram в этой сессии не выполнялись.
