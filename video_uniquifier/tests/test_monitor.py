import http.server
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from uniquifier.bot import Settings, VideoBot
from uniquifier.media import ProcessingTimeout
from uniquifier.web import ActiveJobWatch


class MonitorTests(unittest.TestCase):
    def test_heartbeat_only_for_active_jobs_and_stops_when_cancelled(self):
        requests = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                requests.append(self.path)
                self.send_response(200)
                self.send_header('Content-Length', '0')
                self.end_headers()

        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        active = False
        bot = SimpleNamespace(stop=threading.Event(), log_active_jobs=lambda: active)
        watch = ActiveJobWatch(bot, f'http://127.0.0.1:{server.server_port}/healthz', 240)
        try:
            with patch('uniquifier.web.time.monotonic', return_value=1000):
                watch.tick()
                self.assertEqual(requests, [])
                active = True
                watch.tick()
                watch.tick()
                self.assertEqual(requests, ['/healthz'])
            with patch('uniquifier.web.time.monotonic', return_value=1239):
                watch.tick()
                self.assertEqual(len(requests), 1)
            with patch('uniquifier.web.time.monotonic', return_value=1240):
                watch.tick()
                self.assertEqual(len(requests), 2)
            active = False
            with patch('uniquifier.web.time.monotonic', return_value=1500):
                watch.tick()
                self.assertEqual(len(requests), 2)
                active = True
                bot.stop.set()
                watch.tick()
                self.assertEqual(len(requests), 2)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_health_failure_does_not_kill_job_or_log_secrets(self):
        bot = SimpleNamespace(stop=threading.Event(), log_active_jobs=lambda: True)
        watch = ActiveJobWatch(bot, 'https://example.com/healthz', 240)
        with patch('uniquifier.web.urlopen', side_effect=OSError('SECRET_TOKEN')):
            with self.assertLogs('video_bot', level='WARNING') as logs:
                watch.tick()
        self.assertFalse(bot.stop.is_set())
        self.assertIn('OSError', logs.output[0])
        self.assertNotIn('SECRET_TOKEN', str(logs.output))
        with patch('uniquifier.web.urlopen') as request:
            ActiveJobWatch(bot, 'https://example.com/healthz', 0).tick()
            request.assert_not_called()

    def test_delivery_logs_count_only_successful_sends_and_timeout_is_explicit(self):
        for fail_after in (None, 2, 0):
            with self.subTest(fail_after=fail_after), tempfile.TemporaryDirectory() as folder:
                documents, messages = [], []
                api = SimpleNamespace(call=lambda method, payload: messages.append(payload['text']))
                api.download = lambda file_id, target, limit, cancel: target.write_bytes(b'source')

                def send(chat, path, caption, reply, cancel):
                    if fail_after == 2 and len(documents) == 2:
                        raise OSError('SECRET_TOKEN')
                    documents.append(path.name)

                api.send_document = send
                bot = VideoBot(Settings('123:SECRET_TOKEN', frozenset({42}), work_dir=Path(folder)), api)
                key, cancel, mode = bot.reserve_job(42, 42)

                def render(source, path, index, **kwargs):
                    if fail_after == 0:
                        raise ProcessingTimeout('Превышено время обработки видео.')
                    path.write_bytes(b'video')
                    return {'description': 'test', 'sha256': 'hash'}

                try:
                    with patch('uniquifier.bot.render', side_effect=render):
                        with self.assertLogs('video_bot', level='INFO') as logs:
                            bot.process({'message_id': 1}, {'file_id': 'source'}, key, cancel, mode)
                    output = '\n'.join(logs.output)
                    self.assertNotIn('SECRET_TOKEN', output)
                    self.assertEqual(bot.jobs, {})
                    self.assertEqual(bot.progress, {})
                    self.assertEqual(list(Path(folder).iterdir()), [])
                    if fail_after is None:
                        self.assertEqual(len(documents), 6)
                        self.assertIn('stage=delivered version=5 sent=5/5', output)
                        self.assertIn('stage=completed version=5 sent=5/5', output)
                    else:
                        self.assertEqual(len(documents), fail_after)
                        self.assertNotIn('stage=completed', output)
                        self.assertIn(f'sent={fail_after}/5', output)
                        if fail_after == 0:
                            self.assertIn('kind=ProcessingTimeout', output)
                finally:
                    bot.close()

    def test_private_status_shows_current_version_and_confirmed_count(self):
        with tempfile.TemporaryDirectory() as folder:
            messages = []
            api = SimpleNamespace(call=lambda method, payload: messages.append(payload['text']))
            bot = VideoBot(Settings('123:fake', frozenset({42}), work_dir=Path(folder)), api)
            key, _, _ = bot.reserve_job(42, 42)
            try:
                bot.job_stage(key, 'render', version=3, sent=2)
                bot.handle({'chat': {'id': 42}, 'from': {'id': 42}, 'text': '/status'})
                self.assertIn('версию 3/5', messages[-1])
                self.assertIn('Отправлено 2/5', messages[-1])
            finally:
                bot.release_job(key)
                bot.close()
