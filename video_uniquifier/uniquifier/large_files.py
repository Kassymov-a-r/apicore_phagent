"""Send original output bytes through MTProto; keep the cloud webhook for wake-up."""
from __future__ import annotations

import asyncio
import logging
import threading

from .media import Cancelled, MediaError, ProcessingTimeout
from .telegram_api import APIError

CLOUD_LIMIT = 50 * 1024**2


class LargeFileAPI:
    def __init__(self, cloud, settings):
        self.cloud = cloud
        self.settings = settings
        self.lock = threading.Lock()

    def call(self, *args, **kwargs):
        return self.cloud.call(*args, **kwargs)

    def download(self, *args, **kwargs):
        return self.cloud.download(*args, **kwargs)

    def prepare(self, cancel):
        with self.lock:
            return asyncio.run(self._send(None, None, None, None, cancel))

    def send_document(self, chat_id, path, caption, reply_to, cancel):
        if path.stat().st_size <= CLOUD_LIMIT:
            return self.cloud.send_document(chat_id, path, caption, reply_to, cancel)
        if chat_id <= 0 or chat_id not in self.settings.allowed:
            raise MediaError('Большие результаты отправляются только в личный чат владельца.')
        while not self.lock.acquire(timeout=.25):
            if cancel.is_set():
                raise Cancelled('Отправка отменена.')
        try:
            if cancel.is_set():
                raise Cancelled('Отправка отменена.')
            return asyncio.run(self._send(chat_id, path, caption, reply_to, cancel))
        finally:
            self.lock.release()

    async def _send(self, chat_id, path, caption, reply_to, cancel):
        from telethon import TelegramClient, errors, types
        from telethon.sessions import SQLiteSession

        # Sessions contain auth keys. Keep them private and out of application logs.
        root = self.settings.work_dir / '.mtproto'
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        root.chmod(0o700)
        session_path = root / ('sender-' + self.settings.token.split(':', 1)[0] + '.session')
        session = SQLiteSession(str(session_path))
        session_path.chmod(0o600)
        logger = logging.getLogger('video_bot.mtproto')
        logger.propagate = False
        if not logger.handlers:
            logger.addHandler(logging.NullHandler())
        client = TelegramClient(session, self.settings.telegram_api_id,
                                self.settings.telegram_api_hash, receive_updates=False,
                                request_retries=2, connection_retries=2,
                                flood_sleep_threshold=0, base_logger=logger)

        async def transfer():
            await client.connect()
            if not await client.is_user_authorized():
                await client.sign_in(bot_token=self.settings.token)
            me = await client.get_me()
            if not me or not me.bot or me.id != int(self.settings.token.split(':', 1)[0]):
                raise MediaError('Авторизация отправки больших файлов не соответствует боту.')
            if path is None:
                return True

            async def progress(current, total):
                if cancel.is_set():
                    raise Cancelled('Отправка отменена.')

            # Bots may use access_hash=0 when the user is known only by Bot API ID.
            peer = types.InputPeerUser(chat_id, 0)
            message = await client.send_file(peer, str(path), force_document=True,
                                             caption=caption, parse_mode=None,
                                             reply_to=reply_to, progress_callback=progress)
            if (not message or not getattr(message, 'id', 0)
                    or getattr(message.peer_id, 'user_id', None) != chat_id):
                raise MediaError('Telegram не подтвердил отправку большого файла в нужный чат.')
            return message

        async def watch():
            while not cancel.is_set():
                await asyncio.sleep(.25)
            raise Cancelled('Отправка отменена.')

        task = asyncio.create_task(transfer())
        watcher = asyncio.create_task(watch())
        try:
            done, _ = await asyncio.wait({task, watcher}, timeout=self.settings.timeout,
                                         return_when=asyncio.FIRST_COMPLETED)
            if task in done:
                return await task
            if watcher in done:
                await watcher
            raise ProcessingTimeout('Превышено время отправки большого видео.')
        except errors.FloodWaitError as error:
            raise APIError(429, error.seconds) from None
        except (Cancelled, MediaError, APIError):
            raise
        except Exception as error:
            logging.getLogger('video_bot').warning('Large file transfer failed: %s', type(error).__name__)
            raise MediaError('Не удалось отправить большой файл через Telegram API. '
                             'Проверьте TELEGRAM_API_ID и TELEGRAM_API_HASH.') from None
        finally:
            task.cancel()
            watcher.cancel()
            await asyncio.gather(task, watcher, return_exceptions=True)
            await client.disconnect()
            session.close()
