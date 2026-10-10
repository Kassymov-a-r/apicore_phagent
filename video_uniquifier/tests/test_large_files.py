import asyncio
import hashlib
import os
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from uniquifier.bot import Settings, VideoBot
from uniquifier.large_files import CLOUD_LIMIT, LargeFileAPI
from uniquifier.media import Cancelled, MediaError, ProcessingTimeout
from uniquifier.telegram_api import APIError


class Cloud:
    def __init__(self):
        self.documents = []

    def send_document(self, *args):
        self.documents.append(args)
        return 'cloud-confirmed'


class Client:
    instances = []
    failure = None
    peer = 42
    stall = False
    authorized = False

    def __init__(self, session, api_id, api_hash, **kwargs):
        self.__class__.instances.append(self)
        self.session, self.options = session, kwargs
        self.signins, self.sends, self.disconnected = [], [], False

    async def connect(self):
        pass

    async def is_user_authorized(self):
        return self.authorized

    async def sign_in(self, **kwargs):
        self.signins.append(kwargs)

    async def get_me(self):
        return SimpleNamespace(bot=True, id=123)

    async def send_file(self, peer, path, **kwargs):
        if self.failure:
            raise self.failure
        if self.stall:
            await asyncio.sleep(5)
        await kwargs['progress_callback'](1, 2)
        with open(path, 'rb') as file:
            digest = hashlib.file_digest(file, 'sha256').hexdigest()
        self.sends.append((peer, digest, kwargs))
        return SimpleNamespace(id=17, peer_id=SimpleNamespace(user_id=self.peer))

    async def disconnect(self):
        self.disconnected = True


class LargeFileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        self.path = self.folder / 'version_1.mp4'
        with self.path.open('wb') as file:
            file.write(b'original-mp4-bytes')
            file.truncate(CLOUD_LIMIT + 1)
        self.cfg = Settings('123:fake', frozenset({42}), work_dir=self.folder,
                            large_files=True, telegram_api_id=100,
                            telegram_api_hash='a'*32, timeout=2)
        self.cloud = Cloud()
        self.api = LargeFileAPI(self.cloud, self.cfg)
        Client.instances, Client.failure = [], None
        Client.peer, Client.stall, Client.authorized = 42, False, False
        self.patch = patch('telethon.TelegramClient', Client)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def test_large_file_original_bytes_private_peer_and_acknowledgement(self):
        with self.path.open('rb') as file:
            before = hashlib.file_digest(file, 'sha256').hexdigest()
        result = self.api.send_document(42, self.path, 'caption', 9, threading.Event())
        self.assertEqual(result.id, 17)
        client = Client.instances[-1]
        peer, digest, options = client.sends[0]
        self.assertEqual((peer.user_id, peer.access_hash), (42, 0))
        self.assertEqual(digest, before)
        self.assertTrue(options['force_document'])
        self.assertIsNone(options['parse_mode'])
        self.assertEqual(options['reply_to'], 9)
        self.assertTrue(client.disconnected)
        self.assertFalse(client.options['receive_updates'])
        self.assertEqual(client.signins, [{'bot_token': '123:fake'}])
        self.assertEqual(self.cloud.documents, [])
        session = next((self.folder / '.mtproto').glob('*.session'))
        self.assertEqual(session.stat().st_mode & 0o777, 0o600)
        self.assertEqual(session.parent.stat().st_mode & 0o777, 0o700)

    def test_small_file_uses_cloud_without_mtproto_auth(self):
        self.path.write_bytes(b'mp4')
        self.assertEqual(self.api.send_document(42, self.path, '', None, threading.Event()), 'cloud-confirmed')
        self.assertEqual(len(self.cloud.documents), 1)
        self.assertFalse(Client.instances)

    def test_authorization_check_does_not_send_messages(self):
        self.assertTrue(self.api.prepare(threading.Event()))
        self.assertFalse(Client.instances[-1].sends)
        self.assertTrue(Client.instances[-1].disconnected)

    def test_groups_unknown_users_wrong_acknowledgement_and_flood_wait(self):
        from telethon.errors import FloodWaitError
        for chat in (-42, 99):
            with self.assertRaises(MediaError):
                self.api.send_document(chat, self.path, '', None, threading.Event())
        self.assertFalse(Client.instances)
        Client.peer = 99
        with self.assertRaises(MediaError):
            self.api.send_document(42, self.path, '', None, threading.Event())
        Client.peer = 42
        Client.failure = FloodWaitError(request=None, capture=7)
        with self.assertRaises(APIError) as caught:
            self.api.send_document(42, self.path, '', None, threading.Event())
        self.assertEqual((caught.exception.code, caught.exception.retry_after), (429, 7))

    def test_cancel_timeout_and_sanitized_rpc_error(self):
        cancel = threading.Event()
        cancel.set()
        with self.assertRaises(Cancelled):
            self.api.send_document(42, self.path, '', None, cancel)
        Client.stall, self.cfg.timeout = True, .05
        with self.assertRaises(ProcessingTimeout):
            self.api.send_document(42, self.path, '', None, threading.Event())
        self.assertTrue(Client.instances[-1].disconnected)
        Client.stall = False
        Client.failure = OSError('SECRET_TOKEN SECRET_API_HASH')
        with self.assertLogs('video_bot', 'WARNING') as logs:
            with self.assertRaises(MediaError) as caught:
                self.api.send_document(42, self.path, '', None, threading.Event())
        self.assertNotIn('SECRET', str(caught.exception) + str(logs.output))

    def test_configuration_requires_keys_and_keeps_input_cloud_limit(self):
        env = {'TELEGRAM_BOT_TOKEN': '123:fake', 'ALLOWED_USER_IDS': '42',
               'TELEGRAM_LARGE_FILES': 'true', 'MAX_OUTPUT_MB': '500',
               'TELEGRAM_API_ID': '100', 'TELEGRAM_API_HASH': 'a'*32}
        with patch.dict(os.environ, env, clear=True):
            cfg = Settings.from_env()
            self.assertEqual(cfg.max_input, 20*1024**2)
            self.assertEqual(cfg.max_output, 500*1024**2)
            self.assertFalse(cfg.local_api)
            os.environ['TELEGRAM_API_HASH'] = ''
            with self.assertRaises(ValueError):
                Settings.from_env()
            os.environ['TELEGRAM_API_ID'] = 'SECRET_TOKEN'
            with self.assertRaises(ValueError) as caught:
                Settings.from_env()
            self.assertNotIn('SECRET_TOKEN', str(caught.exception))
        env['TELEGRAM_LARGE_FILES'] = 'false'
        with patch.dict(os.environ, env, clear=True):
            with self.assertRaises(ValueError):
                Settings.from_env()

    def test_five_oversized_results_count_only_confirmed_sends(self):
        api = self.api
        messages = []
        api.call = lambda method, payload: messages.append(payload['text'])
        api.download = lambda file_id, target, limit, cancel: target.write_bytes(b'source')
        self.cfg.max_output = 500*1024**2
        bot = VideoBot(self.cfg, api)
        def render(source, target, index, **kwargs):
            with target.open('wb') as file:
                file.truncate(CLOUD_LIMIT + 1)
            return {'description': 'unchanged-quality', 'sha256': str(index)}
        with patch('uniquifier.bot.render', render):
            bot.handle({'from': {'id': 42}, 'chat': {'id': 42}, 'message_id': 1,
                        'document': {'file_id': 'file'}})
            bot.pool.shutdown(wait=True)
        self.assertEqual(sum(len(x.sends) for x in Client.instances), 5)
        self.assertEqual(len(self.cloud.documents), 1)  # report
        self.assertIn('отправлено 5 видео', messages[-1])
        self.assertFalse(bot.jobs)
        self.assertFalse(list(self.folder.glob('job-*')))


if __name__ == '__main__':
    unittest.main()
