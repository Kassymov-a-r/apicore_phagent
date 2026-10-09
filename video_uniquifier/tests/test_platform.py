import os
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from uniquifier import platform_support
from uniquifier.bot import load_env


class PlatformTests(unittest.TestCase):
    def test_scheduler_runner_logs_and_restores_process_streams(self):
        import run_windows
        from uniquifier import bot
        stdout, stderr, cwd = sys.stdout, sys.stderr, Path.cwd()
        with tempfile.TemporaryDirectory() as directory:
            try:
                with mock.patch.object(run_windows, 'ROOT', Path(directory)), \
                        mock.patch.object(bot, 'main', side_effect=lambda: print('Test start')):
                    self.assertEqual(run_windows.main(), 0)
                self.assertEqual((Path(directory) / 'logs' / 'video_bot.log').read_text(), 'Test start\n')
                self.assertIs(sys.stdout, stdout)
                self.assertIs(sys.stderr, stderr)
            finally:
                os.chdir(cwd)

    def test_instance_lock_blocks_second_process_and_releases(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'bot.lock'
            script = ("from pathlib import Path; from uniquifier.platform_support import acquire_instance_lock; "
                      "lock=acquire_instance_lock(Path(__import__('sys').argv[1])); lock.close()")
            lock = platform_support.acquire_instance_lock(path)
            try:
                other = subprocess.run([sys.executable, '-c', script, str(path)], capture_output=True)
                self.assertNotEqual(other.returncode, 0)
            finally:
                lock.close()
            other = subprocess.run([sys.executable, '-c', script, str(path)], capture_output=True)
            self.assertEqual(other.returncode, 0, other.stderr)

    def test_windows_termination_and_creation_do_not_use_posix_api(self):
        process = mock.Mock()
        windows = types.SimpleNamespace(name='nt')
        with mock.patch.object(platform_support, 'os', windows), \
                mock.patch.object(subprocess, 'CREATE_NEW_PROCESS_GROUP', 512, create=True), \
                mock.patch.object(subprocess, 'CREATE_NO_WINDOW', 134217728, create=True):
            options = platform_support.process_options()
            self.assertNotIn('start_new_session', options)
            self.assertEqual(options['creationflags'], 512 | 134217728)
            platform_support.terminate_process(process)
            process.kill.assert_called_once()

    def test_windows_msvcrt_lock_conflict_closes_handle(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'bot.lock'
            msvcrt = types.SimpleNamespace(LK_NBLCK=2, locking=mock.Mock(side_effect=OSError()))
            # Construct the Path before switching the mocked platform module.
            with mock.patch.object(platform_support, 'os', types.SimpleNamespace(name='nt')), \
                    mock.patch.dict(sys.modules, {'msvcrt': msvcrt}):
                with self.assertRaises(BlockingIOError):
                    platform_support.acquire_instance_lock(path)
            # Failed acquisition must leave the file removable (particularly on Windows).
            path.unlink()

    def test_windows_utf8_bom_env_and_cyrillic_folder(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory) / 'Рабочий стол'
            folder.mkdir()
            env = folder / '.env'
            env.write_text('VIDEO_TEST_SETTING=value\n', encoding='utf-8-sig')
            with mock.patch.dict(os.environ, {}, clear=True):
                load_env(env)
                self.assertEqual(os.environ['VIDEO_TEST_SETTING'], 'value')


if __name__ == '__main__':
    unittest.main()
