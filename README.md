# IG Remote Browser Agent MVP

Отдельный экспериментальный проект без Meta API. Работает через серверный Playwright Chromium и встроенное remote browser окно в панели.

## Как работает вход

1. Открой `/accounts`.
2. Создай аккаунт.
3. Нажми `Открыть Remote Browser`.
4. Внутри страницы появится серверный Instagram Web.
5. Войди вручную, включая 2FA/checkpoint.
6. Нажми `Сохранить сессию`.
7. Пароль не сохраняется. На диске хранится только Playwright storageState/cookies.

## Render

Деплой как Docker Web Service или Blueprint через `render.yaml`.

Обязательно нужен persistent disk `/app/storage`, иначе сессии будут теряться после рестарта.

## Ограничения

Это неофициальная автоматизация Instagram Web. Используй только для собственных аккаунтов, с маленькими лимитами и без массового спама.
