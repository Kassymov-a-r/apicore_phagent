"""Stream authorized Mini App uploads to disk, using the bot's existing job slot."""
from __future__ import annotations

import hashlib
import hmac
import json
import re
import shutil
import tempfile
import threading
import time
from collections import OrderedDict
from pathlib import Path
from urllib.parse import parse_qsl

from .media import Cancelled, MediaError


def telegram_user(init_data, token, allowed, now=None):
    if not init_data or len(init_data) > 8192:
        raise ValueError('Откройте загрузку кнопкой в личном чате с ботом.')
    pairs = parse_qsl(init_data, keep_blank_values=True, strict_parsing=True, max_num_fields=64)
    fields = dict(pairs)
    if len(fields) != len(pairs):
        raise ValueError('Некорректная подпись Telegram.')
    signature = fields.pop('hash', '')
    check = '\n'.join(f'{key}={fields[key]}' for key in sorted(fields))
    secret = hmac.new(b'WebAppData', token.encode(), hashlib.sha256).digest()
    expected = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    if not re.fullmatch('[a-f0-9]{64}', signature) or not hmac.compare_digest(signature, expected):
        raise ValueError('Некорректная подпись Telegram.')
    current = time.time() if now is None else now
    date = int(fields.get('auth_date', '0'))
    if not -60 <= current - date <= 3600:
        raise ValueError('Окно загрузки устарело. Откройте кнопку в боте заново.')
    user = json.loads(fields.get('user', '{}'))
    user_id = user.get('id') if isinstance(user, dict) else None
    if type(user_id) is not int or user_id <= 0 or user_id not in allowed:
        raise ValueError('Доступ к боту закрыт для этого Telegram ID.')
    return user_id


class Uploads:
    def __init__(self, bot):
        self.bot = bot
        self.lock = threading.Lock()
        self.accepted = OrderedDict()

    def authorize(self, handler):
        return telegram_user(handler.headers.get('X-Telegram-Init-Data', ''),
                             self.bot.cfg.token, self.bot.cfg.allowed)

    def status(self, user):
        with self.bot.lock:
            return {'active': (user, user) in self.bot.jobs,
                    'mode': self.bot.modes.get(user, 'micro'),
                    'max_bytes': self.bot.cfg.max_web_input,
                    'max_duration': self.bot.cfg.max_duration,
                    'max_output_bytes': self.bot.cfg.max_output}

    def receive(self, handler, user):
        if handler.headers.get('Transfer-Encoding'):
            handler.respond_json(400, {'error': 'Не удалось определить размер файла.'})
            return
        try:
            size = int(handler.headers.get('Content-Length', '0'))
        except ValueError:
            size = 0
        if not 0 < size <= self.bot.cfg.max_web_input:
            handler.respond_json(413, {'error': f'Выберите видео до '
                                     f'{self.bot.cfg.max_web_input // 1024**2} MiB.'})
            return
        upload_id = handler.headers.get('X-Upload-ID', '')
        if not re.fullmatch('[A-Za-z0-9_-]{16,64}', upload_id):
            handler.respond_json(400, {'error': 'Некорректный запрос загрузки.'})
            return
        request_id = (user, upload_id)
        with self.lock:
            if request_id in self.accepted:
                handler.respond_json(202, {'ok': True, 'already_accepted': True})
                return
            try:
                key, cancel, mode = self.bot.reserve_job(user, user)
            except MediaError as error:
                handler.respond_json(409, {'error': str(error)})
                return
        folder = None
        submitted = False
        response = (202, {'ok': True})
        try:
            if shutil.disk_usage(self.bot.cfg.work_dir).free < size + 2*self.bot.cfg.max_output + 100*1024**2:
                raise MediaError('Недостаточно места. Попробуйте позже.')
            folder = Path(tempfile.mkdtemp(prefix='job-upload-', dir=self.bot.cfg.work_dir))
            (folder / '.video_bot_job').write_text('video-uniquifier-v1')
            source = folder / 'source.bin'
            handler.connection.settimeout(30)
            deadline = time.monotonic() + 600
            remaining = size
            with source.open('wb') as target:
                while remaining:
                    if cancel.is_set() or self.bot.stop.is_set():
                        raise Cancelled('Загрузка отменена.')
                    if time.monotonic() > deadline:
                        raise MediaError('Загрузка заняла более 10 минут. Попробуйте снова.')
                    block = handler.rfile.read(min(64 * 1024, remaining))
                    if not block:
                        raise MediaError('Загрузка прервалась. Выберите исходник ещё раз.')
                    target.write(block)
                    remaining -= len(block)
            if cancel.is_set() or self.bot.stop.is_set():
                raise Cancelled('Загрузка отменена.')
            # The chat comes from signed Telegram identity, never from client input.
            message = {'from': {'id': user}, 'chat': {'id': user}, 'message_id': None}
            self.bot.pool.submit(self.bot.process, message, {}, key, cancel, mode, source)
            submitted = True
            with self.lock:
                self.accepted[request_id] = time.monotonic()
                while len(self.accepted) > 2048:
                    self.accepted.popitem(last=False)
        except (Cancelled, MediaError) as error:
            response = (400, {'error': str(error)})
        except (OSError, RuntimeError):
            response = (503, {'error': 'Загрузка прервалась. Попробуйте ещё раз.'})
        finally:
            if not submitted:
                if folder:
                    shutil.rmtree(folder, ignore_errors=True)
                self.bot.release_job(key)
        handler.respond_json(*response)


UPLOAD_PAGE = (Path(__file__).with_name('upload.html')).read_bytes()
