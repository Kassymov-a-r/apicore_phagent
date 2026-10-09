import hashlib
import http.server
import json
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

from uniquifier.bot import Settings, VideoBot
from uniquifier.media import Cancelled, MediaError, probe, render, run, sha256
from uniquifier.telegram_api import TelegramAPI


def ffmpeg(*args):
    return subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *args],
                          check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout


class PipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.folder = Path(cls.temp.name)
        cls.source = cls.folder / 'input.mp4'
        ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=2',
               '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
               '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', str(cls.source))

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_five_variants_av_dimensions_hashes_and_duration(self):
        hashes = {sha256(self.source)}
        for i in range(5):
            target = self.folder / f'micro{i}.mp4'
            result = render(self.source, target, i, mode='micro', cancel=threading.Event(), preset='fast')
            self.assertNotIn(result['sha256'], hashes)
            hashes.add(result['sha256'])
            streams = probe(target)['streams']
            self.assertEqual((streams[0]['width'], streams[0]['height']), (320, 240))
            self.assertEqual(streams[0]['avg_frame_rate'], '30/1')
            self.assertEqual(streams[1]['codec_type'], 'audio')
            video_duration = float(streams[0]['duration'])
            audio_duration = float(streams[1]['duration'])
            self.assertLess(abs(video_duration - audio_duration), .10)
            ffmpeg('-i', str(target), '-f', 'null', '-')  # Fully decode every result.

    def test_lossless_decoded_video_and_audio_equal(self):
        original_video = ffmpeg('-i', str(self.source), '-map', '0:v:0', '-f', 'rawvideo', '-')
        original_audio = ffmpeg('-i', str(self.source), '-map', '0:a:0', '-f', 's16le', '-')
        hashes = set()
        for i in range(5):
            target = self.folder / f'lossless{i}.mp4'
            result = render(self.source, target, i, mode='lossless', cancel=threading.Event())
            self.assertNotIn(result['sha256'], hashes)
            hashes.add(result['sha256'])
            self.assertEqual(ffmpeg('-i', str(target), '-map', '0:v:0', '-f', 'rawvideo', '-'), original_video)
            self.assertEqual(ffmpeg('-i', str(target), '-map', '0:a:0', '-f', 's16le', '-'), original_audio)

    def test_phone_rotation(self):
        source = self.folder / 'rotated.mp4'
        ffmpeg('-display_rotation', '90', '-i', str(self.source), '-c', 'copy', str(source))
        output = self.folder / 'upright.mp4'
        render(source, output, 0, mode='micro', cancel=threading.Event(), preset='fast')
        stream = probe(output)['streams'][0]
        self.assertEqual((stream['width'], stream['height']), (240, 320))
        self.assertFalse(any(side.get('rotation', 0) for side in stream.get('side_data_list', [])))
        copied = self.folder / 'rotated-lossless.mp4'
        render(source, copied, 0, mode='lossless', cancel=threading.Event())
        self.assertEqual(ffmpeg('-i', str(copied), '-map', '0:v:0', '-f', 'rawvideo', '-'),
                         ffmpeg('-i', str(source), '-map', '0:v:0', '-f', 'rawvideo', '-'))

    def test_silent_video(self):
        source = self.folder / 'silent.mp4'
        ffmpeg('-i', str(self.source), '-an', '-c:v', 'copy', str(source))
        output = self.folder / 'silent-output.mp4'
        render(source, output, 0, mode='micro', cancel=threading.Event(), preset='fast')
        self.assertEqual(len(probe(output)['streams']), 1)

    def test_invalid_input_duration_and_hdr(self):
        source = self.folder / 'invalid.bin'
        source.write_text('not a video')
        with self.assertRaises(MediaError):
            render(source, self.folder / 'bad.mp4', 0, mode='micro', cancel=threading.Event())
        with self.assertRaises(MediaError):
            render(self.source, self.folder / 'long.mp4', 0, mode='micro',
                   cancel=threading.Event(), max_duration=1)
        hdr = self.folder / 'hdr.mp4'
        ffmpeg('-i', str(self.source), '-c', 'copy', '-bsf:v', 'h264_metadata=transfer_characteristics=16',
               str(hdr))
        with self.assertRaisesRegex(MediaError, 'HDR'):
            render(hdr, self.folder / 'hdr-out.mp4', 0, mode='micro', cancel=threading.Event())

    def test_cancel_and_process_timeout(self):
        cancel = threading.Event()
        cancel.set()
        with self.assertRaises(Cancelled):
            render(self.source, self.folder / 'cancel.mp4', 0, mode='micro', cancel=cancel)
        with self.assertRaises(MediaError):
            run([sys.executable, '-c', 'import time; time.sleep(2)'], threading.Event(), .01)


class FakeAPI:
    def __init__(self, source, fail_number=None):
        self.source, self.fail_number = source, fail_number
        self.messages, self.documents = [], []

    def call(self, method, payload):
        self.messages.append(payload['text'])

    def download(self, file_id, target, limit, cancel):
        target.write_bytes(self.source.read_bytes())

    def send_document(self, chat, path, caption, reply, cancel):
        if len(self.documents) == self.fail_number:
            raise OSError('Network unavailable')
        self.documents.append((chat, path.name, path.read_bytes(), caption, reply))


class BotTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        PipelineTests.setUpClass()

    @classmethod
    def tearDownClass(cls):
        PipelineTests.tearDownClass()

    def make_bot(self, folder, fail_number=None, max_output=50*1024**2):
        api = FakeAPI(PipelineTests.source, fail_number)
        cfg = Settings('123:fake', frozenset({42}), work_dir=Path(folder),
                       preset='fast', max_output=max_output)
        return VideoBot(cfg, api), api

    def test_same_chat_five_videos_report_and_cleanup(self):
        with tempfile.TemporaryDirectory() as folder:
            bot, api = self.make_bot(folder)
            bot.handle({'from': {'id': 42}, 'chat': {'id': -123}, 'message_id': 9,
                        'document': {'file_id': 'file', 'file_size': PipelineTests.source.stat().st_size}})
            bot.pool.shutdown(wait=True)
            self.assertEqual([doc[0] for doc in api.documents], [-123] * 6)
            self.assertEqual([doc[1] for doc in api.documents[:5]], [f'version_{i}.mp4' for i in range(1,6)])
            self.assertTrue(all(doc[4] == 9 for doc in api.documents))
            self.assertEqual(len(json.loads(api.documents[5][2])['variants']), 5)
            self.assertEqual(list(Path(folder).iterdir()), [])
            self.assertEqual(bot.jobs, {})

    def test_failure_reports_partial_result_and_cleanup(self):
        with tempfile.TemporaryDirectory() as folder:
            bot, api = self.make_bot(folder, fail_number=2)
            bot.handle({'from': {'id': 42}, 'chat': {'id': 42}, 'message_id': 1,
                        'video': {'file_id': 'file'}})
            bot.pool.shutdown(wait=True)
            self.assertEqual(len(api.documents), 2)
            self.assertIn('2/5', api.messages[-1])
            self.assertEqual(list(Path(folder).iterdir()), [])

    def test_auth_input_limit_and_output_limit(self):
        with tempfile.TemporaryDirectory() as folder:
            bot, api = self.make_bot(folder, max_output=10)
            base = {'from': {'id': 99}, 'chat': {'id': 42}, 'message_id': 1,
                    'document': {'file_id': 'file'}}
            bot.handle(base)
            self.assertIn('закрыт', api.messages[-1])
            base['from']['id'] = 42
            base['document']['file_size'] = 21*1024**2
            bot.handle(base)
            self.assertIn('Размер превышает', api.messages[-1])
            base['document']['file_size'] = 10
            bot.handle(base)
            bot.pool.shutdown(wait=True)
            self.assertEqual(api.documents, [])
            self.assertIn('качество автоматически не снижалось', api.messages[-1])
            self.assertEqual(list(Path(folder).iterdir()), [])


class HTTPTests(unittest.TestCase):
    def test_real_http_download_and_streamed_multipart(self):
        payload = b'video-bytes' * 200000
        received = []
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                body = self.rfile.read(int(self.headers['Content-Length']))
                received.append((self.path, self.headers['Content-Type'], body))
                result = {'file_path': 'video.mp4', 'file_size': len(payload)} if self.path.endswith('getFile') else True
                raw = json.dumps({'ok': True, 'result': result}).encode()
                self.send_response(200)
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
            def do_GET(self):
                self.send_response(200)
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            api = TelegramAPI('123:test', f'http://127.0.0.1:{server.server_port}')
            with tempfile.TemporaryDirectory() as folder:
                path = Path(folder) / 'version_1.mp4'
                api.download('id', path, len(payload), threading.Event())
                self.assertEqual(path.read_bytes(), payload)
                api.send_document(42, path, 'Версия 1/5', 5, threading.Event())
                body = received[-1][2]
                self.assertIn(payload, body)
                self.assertIn('Версия 1/5'.encode(), body)
                self.assertIn(b'filename="version_1.mp4"', body)
                self.assertIn(b'name="chat_id"\r\n\r\n42', body)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_shared_local_api_path_and_containment(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'source'
            source.write_bytes(b'video')
            api = TelegramAPI('123:test', 'http://localhost:8081', root)
            api.call = lambda *args: {'file_path': str(source)}
            target = root / 'target'
            api.download('id', target, 20, threading.Event())
            self.assertEqual(target.read_bytes(), b'video')
            api.call = lambda *args: {'file_path': '/etc/passwd'}
            with self.assertRaises(ValueError):
                api.download('id', target, 20, threading.Event())


if __name__ == '__main__':
    unittest.main()
