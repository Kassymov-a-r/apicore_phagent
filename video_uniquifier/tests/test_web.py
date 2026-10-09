import http.client
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from uniquifier.bot import Settings, VideoBot
from uniquifier.web import MAX_BODY, WebhookInbox, make_server, register_webhook, webhook_config
from tests.test_pipeline import FakeAPI, ffmpeg


class WebTests(unittest.TestCase):
    def setUp(self):
        self.bot = SimpleNamespace(stop=threading.Event(), handle=lambda message: None)
        self.inbox = WebhookInbox(self.bot, 'test-secret', capacity=1)
        self.server = make_server(self.inbox, '127.0.0.1', 0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.bot.stop.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        if self.inbox.dispatcher.is_alive():
            self.inbox.dispatcher.join(timeout=5)

    def request(self, method='POST', body=None, secret='test-secret', path='/telegram/webhook'):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=2)
        headers = {'X-Telegram-Bot-Api-Secret-Token': secret}
        conn.request(method, path, body=body, headers=headers)
        response = conn.getresponse()
        code = response.status
        response.read()
        conn.close()
        return code

    def update(self, number=1):
        return json.dumps({'update_id': number, 'message': {'from': {'id': 42},
                          'chat': {'id': -123}, 'message_id': 9, 'text': '/status'}})

    def test_auth_payload_and_readiness(self):
        self.assertEqual(self.request(secret='wrong', body=self.update()), 403)
        self.assertEqual(self.request(body='invalid json'), 400)
        self.assertEqual(self.request(body='x'*(MAX_BODY+1)), 413)
        self.assertEqual(self.request(body='{}'), 400)
        self.assertEqual(self.request(body='{"update_id": 1, "message": {}}'), 400)
        self.assertEqual(self.request(body=self.update()), 503)
        self.assertEqual(self.request('GET', path='/healthz'), 503)
        self.inbox.ready.set()
        self.assertEqual(self.request('GET', path='/healthz'), 200)
        self.assertEqual(self.request('GET', path='/'), 404)
        self.bot.stop.set()
        self.assertEqual(self.request(body=self.update()), 503)

    def test_duplicate_and_queue_full_retry(self):
        self.inbox.ready.set()
        self.assertEqual(self.request(body=self.update(1)), 200)
        self.assertEqual(self.request(body=self.update(1)), 200)
        self.assertEqual(self.inbox.updates.qsize(), 1)
        self.assertEqual(self.request(body=self.update(2)), 503)
        self.inbox.updates.get_nowait()
        self.assertEqual(self.request(body=self.update(2)), 200)
        self.assertEqual(self.inbox.updates.get_nowait()['update_id'], 2)

    def test_http_ack_does_not_wait_for_processing(self):
        entered, release = threading.Event(), threading.Event()
        handled = []
        def handle(message):
            handled.append(message)
            entered.set()
            release.wait(5)
        self.bot.handle = handle
        self.inbox.ready.set()
        self.inbox.dispatcher.start()
        try:
            self.assertEqual(self.request(body=self.update()), 200)
            self.assertTrue(entered.wait(2))
            self.assertEqual(self.request('GET', path='/healthz'), 200)
            self.assertEqual(self.request(body=self.update()), 200)
            self.assertEqual(self.request(body=self.update(2)), 200)
            self.assertEqual(len(handled), 1)
        finally:
            self.bot.stop.set()
            release.set()

    def test_render_url_and_generated_secret_registration(self):
        env = {'RENDER_EXTERNAL_URL': 'https://test.onrender.com', 'WEBHOOK_SECRET': '+/='*16,
               'PORT': '12345'}
        with patch.dict(os.environ, env, clear=True):
            url, secret, port = webhook_config()
        self.assertEqual(url, 'https://test.onrender.com/telegram/webhook')
        self.assertEqual(port, 12345)
        self.assertRegex(secret, '^[a-f0-9]{64}$')
        calls = []
        api = SimpleNamespace(call=lambda method, payload=None: calls.append((method, payload)) or True)
        register_webhook(api, url, secret)
        self.assertEqual(calls[1][1]['secret_token'], secret)
        self.assertEqual(calls[1][1]['allowed_updates'], ['message'])
        self.assertNotIn('drop_pending_updates', calls[1][1])
        for invalid in ('http://test.com', 'https://test.com/path', 'https://user:test@test.com'):
            with patch.dict(os.environ, {**env, 'APP_BASE_URL': invalid}, clear=True):
                with self.assertRaises(ValueError):
                    webhook_config()

    def test_real_video_through_webhook_five_files_same_chat(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'input.mp4'
            ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=1',
                   '-c:v', 'libx264', '-threads', '1', str(source))
            api = FakeAPI(source)
            bot = VideoBot(Settings('123:fake', frozenset({42}), work_dir=root/'work',
                                    preset='veryfast', threads=1, max_pixels=2073600,
                                    max_duration=90), api)
            self.inbox.bot = bot
            self.inbox.ready.set()
            self.inbox.dispatcher.start()
            try:
                update = {'update_id': 100, 'message': {'from': {'id': 42}, 'chat': {'id': -123},
                          'message_id': 9, 'document': {'file_id': 'fake', 'file_size': source.stat().st_size}}}
                self.assertEqual(self.request(body=json.dumps(update)), 200)
                self.inbox.updates.join()
                deadline = time.monotonic() + 30
                while time.monotonic() < deadline:
                    with bot.lock:
                        active = bool(bot.jobs)
                    if not active:
                        break
                    bot.stop.wait(.05)
                self.assertFalse(active, 'FFmpeg job did not finish')
                self.assertEqual([doc[0] for doc in api.documents], [-123]*6)
                self.assertEqual([doc[1] for doc in api.documents[:5]],
                                 [f'version_{i}.mp4' for i in range(1,6)])
                self.assertTrue(all(doc[4] == 9 for doc in api.documents))
                self.assertEqual(len({doc[2] for doc in api.documents[:5]}), 5)
                self.assertEqual(list((root/'work').iterdir()), [])
            finally:
                bot.close()
                self.inbox.dispatcher.join(timeout=5)
