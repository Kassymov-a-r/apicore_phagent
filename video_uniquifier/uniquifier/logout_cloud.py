"""Run once before migrating this bot from cloud to the local Bot API."""
import os
import re

from .bot import load_env
from .telegram_api import TelegramAPI


def main():
    load_env()
    token = os.getenv('TELEGRAM_BOT_TOKEN', '')
    if not re.fullmatch(r'\d+:[A-Za-z0-9_-]+', token):
        raise SystemExit('Укажите TELEGRAM_BOT_TOKEN в .env.')
    try:
        TelegramAPI(token).call('logOut')
    except Exception as error:
        raise SystemExit('Не удалось отключить облачный Bot API: ' + type(error).__name__) from None
    print('Облачный Bot API отключён. Теперь запустите локальный сервер и бота.')


if __name__ == '__main__':
    main()
