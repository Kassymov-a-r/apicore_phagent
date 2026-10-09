"""Telegram webhook entry point for Render Free; updates are kept in memory."""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import queue
import shutil
import signal
import threading
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from .bot import Settings, VideoBot, load_env
from .uploads import UPLOAD_PAGE, Uploads

LOG = logging.getLogger('video_bot')
WEBHOOK_PATH = '/telegram/webhook'
MAX_BODY = 64 * 1024


def webhook_config():
    base = os.getenv('APP_BASE_URL') or os.getenv('RENDER_EXTERNAL_URL', '')
    parsed = urlsplit(base)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.path not in ('', '/') or parsed.query or parsed.fragment):
        raise ValueError('Задайте HTTPS APP_BASE_URL или RENDER_EXTERNAL_URL без пути.')
    raw_secret = os.getenv('WEBHOOK_SECRET', '')
    if len(raw_secret) < 32:
        raise ValueError('WEBHOOK_SECRET должен содержать минимум 32 символа.')
    # Render generates Base64; Telegram only accepts A-Z, a-z, 0-9, _ and -.
    secret = hashlib.sha256(raw_secret.encode()).hexdigest()
    port = int(os.getenv('PORT', '10000'))
    if not 1 <= port <= 65535:
        raise ValueError('Некорректный PORT.')
    return base.rstrip('/') + WEBHOOK_PATH, secret, port


def register_webhook(api, url, secret):
    api.call('getMe')
    if api.call('setWebhook', {'url': url, 'secret_token': secret,
                             'allowed_updates': ['message'], 'max_connections': 1}) is not True:
        raise ValueError('Telegram не подтвердил webhook.')


class WebhookInbox:
    def __init__(self, bot, secret, capacity=32):
        self.bot = bot
        self.secret = secret
        self.ready = threading.Event()
        self.updates = queue.Queue(maxsize=capacity)
        self.seen = OrderedDict()
        self.lock = threading.Lock()
        self.dispatcher = threading.Thread(target=self.dispatch, daemon=True)

    def accept(self, update):
        if not isinstance(update, dict) or type(update.get('update_id')) is not int:
            return 400
        message = update.get('message')
        if message is not None and (not isinstance(message, dict)
                or not isinstance(message.get('chat'), dict)
                or type(message['chat'].get('id')) is not int
                or type(message.get('message_id')) is not int
                or not isinstance(message.get('from'), dict)
                or type(message['from'].get('id')) is not int
                or ('text' in message and not isinstance(message['text'], str))):
            return 400
        with self.lock:
            if not self.ready.is_set() or self.bot.stop.is_set():
                return 503
            update_id = update['update_id']
            if update_id in self.seen:
                return 200
            try:
                self.updates.put_nowait(update)
            except queue.Full:
                return 503  # Telegram retries; don't acknowledge a discarded update.
            self.seen[update_id] = None
            if len(self.seen) > 2048:
                self.seen.popitem(last=False)
            return 200

    def dispatch(self):
        while not self.bot.stop.is_set():
            try:
                update = self.updates.get(timeout=.25)
            except queue.Empty:
                continue
            try:
                if not self.bot.stop.is_set() and update.get('message'):
                    self.bot.handle(update['message'])
            except Exception as error:
                LOG.error('Cannot handle update: %s', type(error).__name__)
            finally:
                self.updates.task_done()


def make_server(inbox, host='0.0.0.0', port=10000):
    uploads = Uploads(inbox.bot) if isinstance(inbox.bot, VideoBot) else None
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, *args):
            pass  # Never log URLs, headers, tokens or message payloads.

        def respond(self, code):
            self.send_response(code)
            self.send_header('Content-Length', '0')
            self.send_header('Connection', 'close')
            if code == 503:
                self.send_header('Retry-After', '5')
            self.end_headers()

        def respond_json(self, code, payload):
            raw = json.dumps(payload, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(raw)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(raw)

        def upload_user(self):
            if not uploads or not inbox.ready.is_set() or inbox.bot.stop.is_set():
                self.respond_json(503, {'error': 'Сервис запускается. Попробуйте через минуту.'})
                return None
            try:
                return uploads.authorize(self)
            except (ValueError, TypeError, UnicodeError):
                self.respond_json(403, {'error': 'Откройте загрузку кнопкой /upload '
                                               'в личном чате с ботом. Доступ разрешён владельцу.'})
                return None

        def do_GET(self):
            path = urlsplit(self.path).path
            if path == '/upload':
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(UPLOAD_PAGE)))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Referrer-Policy', 'no-referrer')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline' https://telegram.org; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors https://web.telegram.org https://*.telegram.org")
                self.end_headers()
                self.wfile.write(UPLOAD_PAGE)
                return
            if path == '/upload/status':
                user = self.upload_user()
                if user is not None:
                    self.respond_json(200, uploads.status(user))
                return
            self.respond((200 if inbox.ready.is_set() and not inbox.bot.stop.is_set() else 503)
                         if self.path == '/healthz' else 404)

        def do_POST(self):
            if self.path == '/upload/video':
                user = self.upload_user()
                if user is not None:
                    uploads.receive(self, user)
                return
            if self.path != WEBHOOK_PATH:
                self.respond(404)
                return
            supplied = self.headers.get('X-Telegram-Bot-Api-Secret-Token', '')
            if not hmac.compare_digest(supplied.encode(), inbox.secret.encode()):
                self.respond(403)
                return
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if length <= 0 or length > MAX_BODY or self.headers.get('Transfer-Encoding'):
                    self.respond(413)
                    return
                payload = self.rfile.read(length)
                if len(payload) != length:
                    self.respond(400)
                    return
                update = json.loads(payload)
            except (ValueError, UnicodeError, OSError):
                self.respond(400)
                return
            self.respond(inbox.accept(update))

    return ThreadingHTTPServer((host, port), Handler)


def main():
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    load_env()
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        raise SystemExit('Установите FFmpeg и ffprobe.')
    try:
        url, secret, port = webhook_config()
        settings = Settings.from_env()
        if settings.local_api:
            raise ValueError('Render webhook использует облачный Telegram Bot API.')
    except ValueError as error:
        raise SystemExit(str(error)) from None
    bot = VideoBot(settings)
    bot.upload_url = url.removesuffix(WEBHOOK_PATH) + '/upload'
    inbox = WebhookInbox(bot, secret)
    server = make_server(inbox, port=port)
    http_thread = threading.Thread(target=server.serve_forever, daemon=True)

    def stop(signum, frame):
        inbox.ready.clear()
        bot.stop.set()
        with bot.lock:
            for cancel in bot.jobs.values():
                cancel.set()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    http_thread.start()
    inbox.dispatcher.start()
    try:
        while not bot.stop.is_set():
            try:
                register_webhook(bot.api, url, secret)
                if not bot.stop.is_set():
                    inbox.ready.set()
                LOG.info('Webhook ready; waiting for video uploads')
                break
            except Exception as error:
                LOG.error('Webhook registration failed: %s', type(error).__name__)
                bot.stop.wait(10)
        bot.stop.wait()
    finally:
        inbox.ready.clear()
        bot.stop.set()
        server.shutdown()
        server.server_close()
        inbox.dispatcher.join()
        bot.close()
        # Keep the webhook registered: incoming messages wake a sleeping Render service.


if __name__ == '__main__':
    main()
