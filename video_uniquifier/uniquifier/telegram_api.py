"""Minimal Bot API client: standard library only, streaming file transfers."""
from __future__ import annotations

import http.client
import json
import threading
import urllib.parse
import uuid
from pathlib import Path

from .media import Cancelled


class APIError(Exception):
    def __init__(self, code: int, retry_after: int = 0):
        super().__init__(f'Telegram API error {code}')
        self.code, self.retry_after = code, retry_after


class TelegramAPI:
    def __init__(self, token: str, base: str = 'https://api.telegram.org',
                 local_root: Path | None = None):
        parsed = urllib.parse.urlsplit(base.rstrip('/'))
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.query or parsed.fragment:
            raise ValueError('Invalid BOT_API_BASE_URL')
        self.base, self.token, self.local_root = parsed, token, local_root

    def connection(self, timeout: int = 300):
        cls = http.client.HTTPSConnection if self.base.scheme == 'https' else http.client.HTTPConnection
        return cls(self.base.hostname, self.base.port, timeout=timeout)

    def prefix(self) -> str:
        return self.base.path.rstrip('/')

    def call(self, method: str, payload: dict | None = None):
        connection = self.connection()
        try:
            body = json.dumps(payload or {}).encode()
            connection.request('POST', f'{self.prefix()}/bot{self.token}/{method}', body,
                               {'Content-Type': 'application/json'})
            return self.result(connection.getresponse())
        finally:
            connection.close()

    @staticmethod
    def result(response):
        body = response.read(16 * 1024 * 1024)
        try:
            data = json.loads(body)
        except (ValueError, UnicodeDecodeError):
            raise APIError(response.status) from None
        if not data.get('ok'):
            raise APIError(data.get('error_code', response.status),
                           data.get('parameters', {}).get('retry_after', 0))
        return data['result']

    def download(self, file_id: str, target: Path, limit: int, cancel: threading.Event):
        meta = self.call('getFile', {'file_id': file_id})
        if meta.get('file_size', 0) > limit:
            raise ValueError('Файл превышает предел размера.')
        file_path = meta['file_path']
        if file_path.startswith('/'):
            if not self.local_root:
                raise ValueError('Для локального Bot API настройте общий BOT_API_FILE_ROOT.')
            path = Path(file_path).resolve()
            if not path.is_relative_to(self.local_root.resolve()):
                raise ValueError('Файл Bot API находится вне разрешённой директории.')
            with path.open('rb') as src, target.open('wb') as dst:
                self.copy_limited(src, dst, limit, cancel)
        else:
            connection = self.connection()
            try:
                quoted = urllib.parse.quote(file_path, safe='/')
                connection.request('GET', f'{self.prefix()}/file/bot{self.token}/{quoted}')
                response = connection.getresponse()
                if response.status != 200:
                    raise APIError(response.status)
                with target.open('wb') as dst:
                    self.copy_limited(response, dst, limit, cancel)
            finally:
                connection.close()

    @staticmethod
    def copy_limited(src, dst, limit: int, cancel: threading.Event):
        total = 0
        while True:
            if cancel.is_set():
                raise Cancelled('Загрузка отменена.')
            chunk = src.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > limit:
                raise ValueError('Файл превышает предел размера.')
            dst.write(chunk)

    def send_document(self, chat_id: int, path: Path, caption: str, reply_to: int,
                      cancel: threading.Event):
        boundary = 'VideoBot' + uuid.uuid4().hex
        fields = {'chat_id': str(chat_id), 'caption': caption,
                  'reply_parameters': json.dumps({'message_id': reply_to,
                                                  'allow_sending_without_reply': True})}
        head = b''
        for key, value in fields.items():
            head += (f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n'
                     f'{value}\r\n').encode()
        # Filenames are generated internally and never derived from incoming names.
        head += (f'--{boundary}\r\nContent-Disposition: form-data; name="document"; '
                 f'filename="{path.name}"\r\nContent-Type: application/octet-stream\r\n\r\n').encode()
        tail = f'\r\n--{boundary}--\r\n'.encode()
        connection = self.connection()
        try:
            connection.putrequest('POST', f'{self.prefix()}/bot{self.token}/sendDocument')
            connection.putheader('Content-Type', f'multipart/form-data; boundary={boundary}')
            connection.putheader('Content-Length', str(len(head) + path.stat().st_size + len(tail)))
            connection.endheaders()
            connection.send(head)
            with path.open('rb') as file:
                while chunk := file.read(1024 * 1024):
                    if cancel.is_set():
                        raise Cancelled('Отправка отменена.')
                    connection.send(chunk)
            connection.send(tail)
            return self.result(connection.getresponse())
        finally:
            connection.close()


def retry_rate_limit(action, cancel: threading.Event):
    for attempt in range(4):
        if cancel.is_set():
            raise Cancelled('Задача отменена.')
        try:
            return action()
        except APIError as error:
            if error.code != 429 or attempt == 3:
                raise
            remaining = min(max(error.retry_after, 1), 300)
            while remaining:
                interval = min(remaining, 30)
                if cancel.wait(interval):
                    raise Cancelled('Задача отменена.')
                remaining -= interval
