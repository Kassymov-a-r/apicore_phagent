from __future__ import annotations

import json
import logging
import os
import re
import shutil
import signal
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

from .media import Cancelled, MediaError, render, sha256
from .telegram_api import APIError, TelegramAPI, retry_rate_limit
from .platform_support import acquire_instance_lock

LOG = logging.getLogger('video_bot')


@dataclass
class Settings:
    token: str
    allowed: frozenset[int]
    api_base: str = 'https://api.telegram.org'
    local_root: Path | None = None
    local_api: bool = False
    work_dir: Path = Path('work')
    max_input: int = 20 * 1024 * 1024
    max_web_input: int = 200 * 1024 * 1024
    max_output: int = 50 * 1024 * 1024
    max_duration: int = 600
    max_pixels: int = 3840 * 2160
    max_jobs: int = 1
    crf: int = 16
    preset: str = 'slow'
    threads: int = 2
    timeout: int = 1800

    @classmethod
    def from_env(cls):
        token = os.getenv('TELEGRAM_BOT_TOKEN', '').strip()
        if not re.fullmatch(r'\d+:[A-Za-z0-9_-]+', token):
            raise ValueError('Укажите TELEGRAM_BOT_TOKEN в .env.')
        allowed = frozenset(int(x.strip()) for x in os.getenv('ALLOWED_USER_IDS', '').split(',') if x.strip())
        if not allowed:
            raise ValueError('Укажите ALLOWED_USER_IDS. Узнать ID можно у @userinfobot.')
        local = os.getenv('BOT_API_LOCAL', 'false').lower() == 'true'
        cfg = cls(token=token, allowed=allowed, local_api=local,
                  api_base=os.getenv('BOT_API_BASE_URL', 'https://api.telegram.org'),
                  local_root=Path(os.environ['BOT_API_FILE_ROOT']) if os.getenv('BOT_API_FILE_ROOT') else None,
                  work_dir=Path(os.getenv('WORK_DIR', 'work')),
                  max_input=int(os.getenv('MAX_INPUT_MB', '500' if local else '20')) * 1024 * 1024,
                  max_web_input=int(os.getenv('MAX_WEB_INPUT_MB', '200')) * 1024 * 1024,
                  max_output=int(os.getenv('MAX_OUTPUT_MB', '1900' if local else '50')) * 1024 * 1024,
                  max_duration=int(os.getenv('MAX_DURATION_SECONDS', '600')),
                  max_pixels=int(os.getenv('MAX_PIXELS', str(3840 * 2160))),
                  max_jobs=int(os.getenv('MAX_JOBS', '1')), crf=int(os.getenv('VIDEO_CRF', '16')),
                  preset=os.getenv('VIDEO_PRESET', 'slow'), threads=int(os.getenv('FFMPEG_THREADS', '2')),
                  timeout=int(os.getenv('PROCESS_TIMEOUT_SECONDS', '1800')))
        if not (1 <= cfg.max_jobs <= 4 and 0 <= cfg.crf <= 23 and 1 <= cfg.threads <= 16):
            raise ValueError('Проверьте MAX_JOBS, VIDEO_CRF и FFMPEG_THREADS.')
        if cfg.preset not in ('ultrafast','superfast','veryfast','faster','fast','medium','slow','slower','veryslow'):
            raise ValueError('Недопустимый VIDEO_PRESET.')
        if min(cfg.max_input, cfg.max_output, cfg.max_duration, cfg.max_pixels, cfg.timeout) <= 0:
            raise ValueError('Лимиты должны быть положительными.')
        if not 1 <= cfg.max_web_input <= 500 * 1024**2:
            raise ValueError('MAX_WEB_INPUT_MB должен быть от 1 до 500.')
        if not local and (cfg.max_input > 20 * 1024**2 or cfg.max_output > 50 * 1024**2):
            raise ValueError('Для больших файлов нужен BOT_API_LOCAL=true и локальный Bot API.')
        if local and ('api.telegram.org' in cfg.api_base or not cfg.local_root):
            raise ValueError('Для local API задайте BOT_API_BASE_URL и BOT_API_FILE_ROOT.')
        if cfg.max_input > 1900 * 1024**2 or cfg.max_output > 1900 * 1024**2:
            raise ValueError('Предел размера — 1900 MiB.')
        return cfg


class VideoBot:
    def __init__(self, settings: Settings, api=None):
        self.cfg = settings
        self.api = api or TelegramAPI(settings.token, settings.api_base, settings.local_root)
        self.cfg.work_dir.mkdir(parents=True, exist_ok=True)
        self.pool = ThreadPoolExecutor(max_workers=settings.max_jobs)
        self.slots = threading.BoundedSemaphore(settings.max_jobs)
        self.lock = threading.Lock()
        self.jobs: dict[tuple[int, int], threading.Event] = {}
        self.progress: dict[tuple[int, int], dict] = {}
        self.modes: dict[int, str] = {}
        self.stop = threading.Event()
        self.upload_url: str | None = None

    def offer_upload(self, message):
        chat = message['chat']['id']
        if chat != message.get('from', {}).get('id'):
            self.say(chat, 'Для большого видео откройте личный чат со мной и отправьте /upload.')
            return
        payload = {'chat_id': chat,
                   'text': f'Загрузите исходник до {self.cfg.max_web_input // 1024**2} MiB '
                           'без сжатия через кнопку ниже. Пять результатов придут в этот чат. '
                           f'До {self.cfg.max_duration} секунд; каждый результат — '
                           f'до {self.cfg.max_output // 1024**2} MiB.',
                   'reply_markup': {'inline_keyboard': [[{'text': 'Загрузить видео без сжатия',
                                                          'web_app': {'url': self.upload_url}}]]}}
        retry_rate_limit(lambda: self.api.call('sendMessage', payload), self.stop)

    def reserve_job(self, chat, user):
        key = (chat, user)
        with self.lock:
            if self.stop.is_set():
                raise MediaError('Сервис перезапускается. Попробуйте через минуту.')
            if key in self.jobs:
                raise MediaError('Ваше видео уже обрабатывается. Дождитесь результата или /cancel.')
            if not self.slots.acquire(blocking=False):
                raise MediaError('Бот занят. Пришлите видео после завершения текущей обработки.')
            event = threading.Event()
            self.jobs[key] = event
            self.progress[key] = {'job_id': uuid.uuid4().hex[:12], 'stage': 'accepted',
                                  'version': 0, 'sent': 0, 'started': time.monotonic()}
            return key, event, self.modes.get(user, 'micro')

    def release_job(self, key):
        with self.lock:
            self.jobs.pop(key, None)
            self.progress.pop(key, None)
        self.slots.release()

    def job_stage(self, key, stage, version=0, sent=0):
        with self.lock:
            progress = self.progress[key]
            progress.update(stage=stage, version=version, sent=sent)
            snapshot = dict(progress)
        self.log_job(snapshot)

    @staticmethod
    def log_job(progress):
        # Only generated identifiers and counters; never file names, URLs, tokens or chat IDs.
        LOG.info('job=%s stage=%s version=%d sent=%d/5 elapsed_seconds=%d',
                 progress['job_id'], progress['stage'], progress['version'], progress['sent'],
                 time.monotonic() - progress['started'])

    def log_active_jobs(self):
        with self.lock:
            active = [dict(progress) for progress in self.progress.values()]
        for progress in active:
            self.log_job(progress)
        return bool(active)

    def say(self, chat: int, text: str, cancel: threading.Event | None = None):
        return retry_rate_limit(lambda: self.api.call('sendMessage', {'chat_id': chat, 'text': text}),
                                cancel or self.stop)

    def handle(self, message: dict):
        if self.stop.is_set():
            return
        user = message.get('from', {}).get('id')
        chat = message['chat']['id']
        text = message.get('text', '').split('@')[0].strip()
        if text == '/id':
            self.say(chat, f'Ваш Telegram ID: {user}')
            return
        if user not in self.cfg.allowed:
            self.say(chat, 'Доступ закрыт. Ваш Telegram ID: ' + str(user))
            return
        key = (chat, user)
        if text in ('/start', '/help'):
            self.say(chat, 'Пришлите видео как ФАЙЛ, чтобы сохранить исходное качество. '
                     'Я верну 5 версий файлами в этот чат.\n'
                     '/micro — мягкие изменения, MP4 высокого качества (по умолчанию).\n'
                     '/lossless — MP4/MOV без перекодирования, кадры и звук сохранены.\n'
                     '/status — состояние; /cancel — отменить; /id — ваш ID.\n'
                     f'Вход: до {self.cfg.max_input // 1024**2} MiB; '
                     f'выход: до {self.cfg.max_output // 1024**2} MiB на файл.\n'
                     f'Длительность: до {self.cfg.max_duration} секунд; '
                     f'кадр: до {self.cfg.max_pixels:,} пикселей.\n'
                     'Изменение хеша не гарантирует, что соцсеть сочтёт ролик новым.')
            if self.upload_url:
                self.offer_upload(message)
        elif text == '/upload' and self.upload_url:
            self.offer_upload(message)
        elif text in ('/micro', '/lossless'):
            with self.lock:
                self.modes[user] = text[1:]
            self.say(chat, 'Режим для следующих видео: ' + text[1:])
        elif text == '/status':
            with self.lock:
                progress = dict(self.progress.get(key, {}))
            if progress:
                minutes = int((time.monotonic() - progress['started']) / 60)
                stage = {'accepted': 'Принято', 'download': 'Получаю исходник',
                         'render': f'Обрабатываю версию {progress["version"]}/5',
                         'send': f'Отправляю версию {progress["version"]}/5',
                         'delivered': f'Версия {progress["version"]}/5 отправлена',
                         'report': 'Отправляю отчёт', 'completed': 'Готово'}.get(progress['stage'], 'Обрабатываю')
                self.say(chat, f'{stage}. Отправлено {progress["sent"]}/5 видео. Прошло {minutes} мин.')
            else:
                self.say(chat, 'Можно прислать видео.')
        elif text == '/cancel':
            with self.lock:
                event = self.jobs.get(key)
                if event:
                    event.set()
            self.say(chat, 'Отмена запрошена.' if event else 'Активных задач нет.')
        else:
            media = message.get('video') or message.get('document')
            if not media:
                self.say(chat, 'Пришлите видео как файл или нажмите /help.')
                return
            if media.get('file_size', 0) > self.cfg.max_input:
                if self.upload_url:
                    self.say(chat, 'Telegram не даёт боту скачать такой большой файл из чата. '
                             'Загрузите тот же исходник через кнопку — без сжатия.')
                    self.offer_upload(message)
                else:
                    self.say(chat, f'Размер превышает {self.cfg.max_input // 1024**2} MiB. '
                             'Для больших исходников настройте локальный Bot API; не сжимайте исходник.')
                return
            try:
                key, event, mode = self.reserve_job(chat, user)
            except MediaError as error:
                self.say(chat, str(error))
                return
            self.pool.submit(self.process, message, media, key, event, mode)

    def process(self, message, media, key, cancel, mode, uploaded_source=None):
        chat, user = key
        sent = 0
        try:
            self.job_stage(key, 'download')
            self.say(chat, f'Принято. Создаю 5 версий ({mode}).', cancel)
            with tempfile.TemporaryDirectory(prefix='job-', dir=self.cfg.work_dir) as temp:
                folder = Path(temp)
                (folder / '.video_bot_job').write_text('video-uniquifier-v1')
                # Reserve enough room for the source and two outputs; results are removed after delivery.
                needed = (0 if uploaded_source else self.cfg.max_input) + 2 * self.cfg.max_output + 100 * 1024**2
                if shutil.disk_usage(folder).free < needed:
                    raise MediaError('Недостаточно свободного места на сервере.')
                source = folder / 'source.bin'
                if uploaded_source:
                    uploaded_source.replace(source)
                else:
                    self.api.download(media['file_id'], source, self.cfg.max_input, cancel)
                source_hash = sha256(source)
                results = []
                for i in range(5):
                    self.job_stage(key, 'render', i + 1, sent)
                    self.say(chat, f'Обрабатываю версию {i + 1}/5…', cancel)
                    path = folder / f'version_{i + 1}.mp4'
                    result = render(source, path, i, mode=mode, cancel=cancel, crf=self.cfg.crf,
                                    preset=self.cfg.preset, threads=self.cfg.threads,
                                    timeout=self.cfg.timeout, max_duration=self.cfg.max_duration,
                                    max_pixels=self.cfg.max_pixels)
                    if path.stat().st_size > self.cfg.max_output:
                        raise MediaError('Результат превышает лимит отправки. Настройте локальный Bot API; '
                                         'качество автоматически не снижалось.')
                    caption = (f'Версия {i + 1}/5\n{result["description"]}\n'
                               f'SHA-256 до: {source_hash}\nSHA-256 после: {result["sha256"]}')
                    self.job_stage(key, 'send', i + 1, sent)
                    retry_rate_limit(lambda: self.api.send_document(chat, path, caption,
                                                                    message['message_id'], cancel), cancel)
                    sent += 1
                    self.job_stage(key, 'delivered', i + 1, sent)
                    results.append(result)
                    path.unlink()
                report = folder / 'report.json'
                report.write_text(json.dumps({'source_sha256': source_hash, 'variants': results},
                                             ensure_ascii=False, indent=2), encoding='utf-8')
                self.job_stage(key, 'report', 5, sent)
                retry_rate_limit(lambda: self.api.send_document(chat, report, 'Отчёт обработки пяти версий.',
                                                                message['message_id'], cancel), cancel)
                self.say(chat, 'Готово: отправлено 5 видео. Скачивайте файлы для публикации.', cancel)
                self.job_stage(key, 'completed', 5, sent)
        except Cancelled:
            LOG.warning('job=%s cancelled sent=%d/5', self.progress[key]['job_id'], sent)
            self.notify_failure(chat, f'Отменено. Отправлено {sent}/5 видео.')
        except (MediaError, ValueError) as error:
            LOG.warning('job=%s failed kind=%s sent=%d/5', self.progress[key]['job_id'],
                        type(error).__name__, sent)
            self.notify_failure(chat, f'{error}\nОтправлено {sent}/5 видео.')
        except Exception as error:
            # Exceptions may contain the bot token/URLs; log class only.
            LOG.error('job=%s failed kind=%s sent=%d/5', self.progress[key]['job_id'],
                      type(error).__name__, sent)
            self.notify_failure(chat, f'Ошибка обработки или отправки. Отправлено {sent}/5 видео. '
                                'Проверьте подключение и настройки сервера, затем пришлите файл снова.')
        finally:
            if uploaded_source:
                shutil.rmtree(uploaded_source.parent, ignore_errors=True)
            self.release_job(key)

    def notify_failure(self, chat, text):
        try:
            self.say(chat, text)
        except Exception as error:
            LOG.error('Cannot send status: %s', type(error).__name__)

    def poll(self):
        state = self.cfg.work_dir / 'offset.json'
        offset = json.loads(state.read_text()) if state.exists() else 0
        self.api.call('getMe')
        LOG.info('Bot started; waiting for video uploads')
        try:
            while not self.stop.is_set():
                try:
                    updates = self.api.call('getUpdates', {'offset': offset, 'timeout': 30,
                                                          'allowed_updates': ['message']})
                    for update in updates:
                        if self.stop.is_set():
                            break
                        message = update.get('message')
                        if message:
                            self.handle(message)
                        offset = update['update_id'] + 1
                        temp_state = state.with_suffix('.tmp')
                        temp_state.write_text(json.dumps(offset))
                        temp_state.replace(state)
                except APIError as error:
                    if error.code in (401, 409):
                        LOG.error('Token invalid or another polling process is running')
                        break
                    LOG.warning('Polling error: %s', type(error).__name__)
                    self.stop.wait(min(max(error.retry_after, 5), 60))
                except Exception as error:
                    LOG.warning('Polling error: %s', type(error).__name__)
                    self.stop.wait(5)
        finally:
            self.close()

    def close(self):
        self.stop.set()
        with self.lock:
            for cancel in self.jobs.values():
                cancel.set()
        self.pool.shutdown(wait=True, cancel_futures=True)


def load_env(path: Path = Path('.env')):
    if path.exists():
        for line in path.read_text(encoding='utf-8-sig').splitlines():
            if not line.strip() or line.lstrip().startswith('#'):
                continue
            key, separator, value = line.partition('=')
            if separator and re.fullmatch(r'[A-Z][A-Z0-9_]*', key.strip()):
                os.environ.setdefault(key.strip(), value.strip().strip('"\''))


def main():
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    load_env()
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        raise SystemExit('Установите FFmpeg и ffprobe.')
    try:
        bot = VideoBot(Settings.from_env())
    except ValueError as error:
        raise SystemExit(str(error)) from None
    # Only one process may use this work directory. Cleanup is safe after taking the lock.
    try:
        instance_lock = acquire_instance_lock(bot.cfg.work_dir / 'bot.lock')
    except BlockingIOError:
        bot.close()
        raise SystemExit('Бот с этой рабочей директорией уже запущен.') from None
    for folder in bot.cfg.work_dir.glob('job-*'):
        marker = folder / '.video_bot_job'
        if (folder.is_dir() and not folder.is_symlink() and marker.is_file()
                and marker.read_text() == 'video-uniquifier-v1'):
            shutil.rmtree(folder)
    def stop(signum, frame):
        bot.stop.set()
        with bot.lock:
            for cancel in bot.jobs.values():
                cancel.set()
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    try:
        bot.poll()
    finally:
        instance_lock.close()


if __name__ == '__main__':
    main()
