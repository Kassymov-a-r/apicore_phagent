import hashlib
import hmac
import http.client
import json
import struct
import tempfile
import threading
import time
import unittest
from pathlib import Path
from urllib.parse import urlencode
from unittest.mock import patch

from uniquifier.bot import Settings, VideoBot
from uniquifier.uploads import telegram_user
from uniquifier.web import WebhookInbox, make_server
from tests.test_pipeline import FakeAPI, ffmpeg

TOKEN = '123:fake'


def signed_data(user=42, date=None, extra=None):
    fields = {'auth_date': str(int(time.time()) if date is None else date),
              'user': json.dumps({'id': user}, separators=(',', ':')),
              'query_id': 'test-query', **(extra or {})}
    check = '\n'.join(f'{key}={fields[key]}' for key in sorted(fields))
    secret = hmac.new(b'WebAppData', TOKEN.encode(), hashlib.sha256).digest()
    fields['hash'] = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    return urlencode(fields)


class IdentityTests(unittest.TestCase):
    def test_signature_owner_expiry_duplicate_and_tampering(self):
        valid = signed_data(date=1000, extra={'signature': 'telegram-signature'})
        self.assertEqual(telegram_user(valid, TOKEN, {42}, now=1001), 42)
        for data in ('', valid.replace('1000', '1001'), valid+'&auth_date=1000',
                     signed_data(user=99, date=1000), signed_data(user=True, date=1000)):
            with self.assertRaises(ValueError):
                telegram_user(data, TOKEN, {42}, now=1001)
        for now in (4601, 900):
            with self.assertRaises(ValueError):
                telegram_user(valid, TOKEN, {42}, now=now)


class UploadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'input.mp4'
        ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=1',
               '-c:v', 'libx264', '-threads', '1', str(self.source))
        self.api = FakeAPI(self.source)
        self.api.download = lambda *args: self.fail('Web upload must not use Telegram getFile')
        cfg = Settings(TOKEN, frozenset({42}), work_dir=self.root/'work',
                       max_web_input=25*1024**2, preset='veryfast', threads=1, max_duration=90)
        self.bot = VideoBot(cfg, self.api)
        self.bot.upload_url = 'https://example.test/upload'
        self.inbox = WebhookInbox(self.bot, 'secret')
        self.inbox.ready.set()
        self.server = make_server(self.inbox, '127.0.0.1', 0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.bot.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, method='POST', body=b'video', data=None, path='/upload/video',
                upload_id='test-upload-id-0001', headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=10)
        request_headers = {'X-Telegram-Init-Data': signed_data() if data is None else data,
                           'X-Upload-ID': upload_id, **(headers or {})}
        conn.request(method, path, body=body, headers=request_headers)
        response = conn.getresponse()
        raw = response.read()
        result = (response.status, json.loads(raw))
        conn.close()
        return result

    def wait_job(self):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            with self.bot.lock:
                active = bool(self.bot.jobs)
            if not active:
                return
            self.bot.stop.wait(.05)
        self.fail('Upload job did not finish')

    def test_real_over_20mb_video_five_files_private_chat_and_no_download(self):
        target_size = 21 * 1024**2
        padding = target_size - self.source.stat().st_size
        with self.source.open('ab') as output:
            output.write(struct.pack('>I4s', padding, b'free'))
            remaining = padding - 8
            while remaining:
                chunk = min(65536, remaining)
                output.write(b'\0'*chunk)
                remaining -= chunk
        with self.source.open('rb') as body:
            code, result = self.request(body=body, headers={'Content-Length': str(target_size)})
        self.assertEqual((code, result), (202, {'ok': True}))
        self.wait_job()
        self.assertEqual([doc[0] for doc in self.api.documents], [42]*6)
        self.assertEqual([doc[1] for doc in self.api.documents[:5]],
                         [f'version_{i}.mp4' for i in range(1,6)])
        self.assertTrue(all(doc[4] is None for doc in self.api.documents))
        self.assertEqual(len({doc[2] for doc in self.api.documents[:5]}), 5)
        self.assertEqual(list(self.bot.cfg.work_dir.iterdir()), [])
        code, result = self.request(body=b'retry')
        self.assertEqual(code, 202)
        self.assertTrue(result['already_accepted'])
        self.assertEqual(len(self.api.documents), 6)

    def test_unauthorized_oversize_missing_id_and_readiness(self):
        for data in ('', signed_data(user=99), signed_data(date=1)):
            self.assertEqual(self.request(data=data)[0], 403)
        self.assertEqual(self.request(upload_id='bad')[0], 400)
        self.assertEqual(self.request(headers={'Content-Length': str(26*1024**2)})[0], 413)
        self.assertEqual(self.request(headers={'Transfer-Encoding': 'chunked'})[0], 400)
        self.assertEqual(self.bot.jobs, {})
        self.assertEqual(list(self.bot.cfg.work_dir.iterdir()), [])
        self.inbox.ready.clear()
        self.assertEqual(self.request()[0], 503)

    def test_busy_status_cancel_and_slot_release(self):
        key, cancel, mode = self.bot.reserve_job(42, 42)
        self.assertEqual(self.request()[0], 409)
        code, status = self.request('GET', body=None, path='/upload/status')
        self.assertEqual(code, 200)
        self.assertTrue(status['active'])
        self.bot.handle({'from': {'id': 42}, 'chat': {'id': 42}, 'message_id': 1, 'text': '/cancel'})
        self.assertTrue(cancel.is_set())
        self.bot.release_job(key)
        self.assertFalse(self.request('GET', body=None, path='/upload/status')[1]['active'])

    def test_invalid_video_and_submit_failure_cleanup(self):
        self.assertEqual(self.request()[0], 202)
        self.wait_job()
        self.assertEqual(self.api.documents, [])
        self.assertEqual(list(self.bot.cfg.work_dir.iterdir()), [])
        with patch.object(self.bot.pool, 'submit', side_effect=RuntimeError('closed')):
            self.assertEqual(self.request(upload_id='test-upload-id-0002')[0], 503)
        self.assertEqual(self.bot.jobs, {})
        self.assertEqual(list(self.bot.cfg.work_dir.iterdir()), [])
        key, cancel, mode = self.bot.reserve_job(42, 42)
        self.bot.release_job(key)

    def test_button_private_scope_and_large_file_guidance(self):
        calls = []
        self.bot.api.call = lambda method, payload: calls.append((method, payload))
        private = {'from': {'id': 42}, 'chat': {'id': 42}, 'message_id': 1, 'text': '/upload'}
        self.bot.handle(private)
        self.assertEqual(calls[-1][1]['reply_markup']['inline_keyboard'][0][0]['web_app']['url'],
                         'https://example.test/upload')
        self.bot.handle({**private, 'chat': {'id': -123}})
        self.assertNotIn('reply_markup', calls[-1][1])
        self.bot.handle({**private, 'text': '', 'document': {'file_size': 21*1024**2}})
        self.assertIn('reply_markup', calls[-1][1])
        self.assertEqual(self.bot.jobs, {})

    def test_early_disconnect_cleans_partial_file_and_releases_slot(self):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        conn.putrequest('POST', '/upload/video')
        conn.putheader('X-Telegram-Init-Data', signed_data())
        conn.putheader('X-Upload-ID', 'test-upload-id-0003')
        conn.putheader('Content-Length', '100000')
        conn.endheaders()
        conn.send(b'partial')
        conn.sock.shutdown(1)
        response = conn.getresponse()
        self.assertEqual(response.status, 400)
        response.read()
        conn.close()
        self.wait_job()
        self.assertEqual(list(self.bot.cfg.work_dir.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
