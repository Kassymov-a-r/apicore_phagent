import hashlib
import http.client
import os
import re
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from uniquifier.bot import Settings, VideoBot
from uniquifier.media import MediaError, inspect
from uniquifier.web import WebhookInbox, make_server
from tests.test_pipeline import FakeAPI, ffmpeg


class ResultsTests(unittest.TestCase):
    def test_120_second_original_five_links_and_download_integrity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root/'source.mp4'
            ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=10:duration=120',
                   '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', str(source))
            with self.assertRaises(MediaError):
                inspect(source, threading.Event(), 90, 2073600)
            api = FakeAPI(source)
            bot = VideoBot(Settings('123:fake', frozenset({42}), work_dir=root/'work',
                                    max_duration=180, max_output=500*1024**2,
                                    output_delivery='links', preset='ultrafast', threads=1), api)
            inbox = WebhookInbox(bot, 'test')
            server = make_server(inbox, '127.0.0.1', 0)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            bot.download_base = f'http://127.0.0.1:{server.server_port}'
            try:
                key, cancel, mode = bot.reserve_job(42, 42)
                with self.assertLogs('video_bot', level='INFO') as logs:
                    bot.process({'message_id': 7}, {'file_id':'fake'}, key, cancel, mode)
                texts = api.messages
                urls = [re.search(r'Скачать: (\S+)', msg).group(1) for msg in texts if 'Скачать: ' in msg]
                self.assertEqual(len(urls), 5)
                self.assertEqual(len(set(urls)), 5)
                self.assertEqual([doc[1] for doc in api.documents], ['report.json'])
                self.assertTrue(any('5 ссылок' in msg for msg in texts))
                self.assertEqual(sum('stage=link_sent' in msg for msg in logs.output), 5)
                self.assertFalse(any('/results/' in msg for msg in logs.output))
                for version, url in enumerate(urls, 1):
                    conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
                    conn.request('GET', url.split(bot.download_base)[1])
                    response = conn.getresponse()
                    raw = response.read()
                    self.assertEqual(response.status, 200)
                    self.assertIn(f'version_{version}.mp4', response.getheader('Content-Disposition'))
                    path = bot.results.entries[url.rsplit('/', 1)[1]][0]
                    self.assertEqual(hashlib.sha256(raw).hexdigest(), hashlib.sha256(path.read_bytes()).hexdigest())
                    self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                    inspect(path, threading.Event(), 180, 2073600)
                    conn.close()
                self.assertFalse(bot.jobs)
                self.assertEqual({p.name for p in (root/'work').iterdir()}, {'results'})
            finally:
                bot.close()
                server.shutdown()
                server.server_close()
                thread.join()

    def test_large_download_ranges_expiry_and_budget(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bot = VideoBot(Settings('123:fake', frozenset({42}), work_dir=root/'work',
                                    output_delivery='links'), FakeAPI(root/'unused'))
            server = make_server(WebhookInbox(bot, 'test'), '127.0.0.1', 0)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            def request(token, method='GET', headers=None):
                conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
                conn.request(method, '/results/'+token, headers=headers or {})
                response = conn.getresponse()
                result = response.status, dict(response.getheaders()), response.read()
                conn.close()
                return result
            try:
                path = root/'big.mp4'
                with path.open('wb') as file:
                    file.write(b'original-output')
                    file.truncate(60*1024**2)
                token = bot.results.publish(path, 1)
                code, headers, raw = request(token, 'HEAD')
                self.assertEqual((code, int(headers['Content-Length']), raw), (200, 60*1024**2, b''))
                self.assertEqual(request(token, headers={'Range':'bytes=0-14'})[2], b'original-output')
                self.assertEqual(request(token, headers={'Range':'bytes=-10'})[2], b'\0'*10)
                self.assertEqual(request(token, headers={'Range':'bytes=999999999-'})[0], 416)
                self.assertEqual(request('../source.bin')[0], 404)
                self.assertEqual(request('x'*43)[0], 410)
                bot.results.budget = 60*1024**2
                small = root/'small.mp4'
                small.write_bytes(b'too much')
                with self.assertRaises(MediaError):
                    bot.results.publish(small, 2)
                entry = bot.results.entries[token]
                bot.results.entries[token] = (entry[0], 0, entry[2], entry[3])
                self.assertEqual(request(token)[0], 410)
                self.assertFalse(entry[0].exists())
                self.assertEqual(bot.results.root.stat().st_mode & 0o777, 0o700)
            finally:
                bot.close()
                server.shutdown()
                server.server_close()
                thread.join()

    def test_config_links_without_api_keys_and_cloud_input_guard(self):
        env = {'TELEGRAM_BOT_TOKEN':'123:fake', 'ALLOWED_USER_IDS':'42',
               'OUTPUT_DELIVERY':'links', 'MAX_OUTPUT_MB':'500', 'MAX_DURATION_SECONDS':'180'}
        with patch.dict(os.environ, env, clear=True):
            cfg = Settings.from_env()
        self.assertEqual(cfg.max_duration, 180)
        self.assertFalse(cfg.large_files)
        for overrides in ({'MAX_INPUT_MB':'90'}, {'OUTPUT_DELIVERY':'files'}, {'OUTPUT_DELIVERY':'unknown'}):
            with patch.dict(os.environ, {**env, **overrides}, clear=True):
                with self.assertRaises(ValueError):
                    Settings.from_env()

    def test_failed_link_message_revokes_file_and_releases_job(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root/'source.mp4'
            source.write_bytes(b'source')
            api = FakeAPI(source)
            def call(method, payload):
                if 'Скачать: ' in payload['text']:
                    raise OSError('secret-url-must-not-be-logged')
                api.messages.append(payload['text'])
            api.call = call
            bot = VideoBot(Settings('123:fake', frozenset({42}), work_dir=root/'work',
                                    output_delivery='links'), api)
            bot.download_base = 'https://example.test'
            def render_fake(source, target, *args, **kwargs):
                target.write_bytes(b'output')
                return {'description':'test', 'sha256':hashlib.sha256(b'output').hexdigest()}
            try:
                with self.assertRaises(MediaError):
                    bot.reserve_job(-1, 42)
                key, cancel, mode = bot.reserve_job(42, 42)
                with patch('uniquifier.bot.render', render_fake), self.assertLogs('video_bot') as logs:
                    bot.process({'message_id':1}, {'file_id':'fake'}, key, cancel, mode)
                self.assertFalse(bot.jobs)
                self.assertEqual(bot.results.entries, {})
                self.assertEqual(list(bot.results.root.iterdir()), [])
                self.assertIn('0/5 ссылок', api.messages[-1])
                self.assertFalse(any('secret-url' in msg for msg in logs.output))
            finally:
                bot.close()
