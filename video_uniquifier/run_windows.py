"""Task Scheduler entry point with a private environment and persistent log."""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main():
    os.chdir(ROOT)
    for directory in (ROOT / 'tools' / 'ffmpeg' / 'bin', ROOT / 'tools'):
        if (directory / 'ffmpeg.exe').is_file():
            os.environ['PATH'] = str(directory) + os.pathsep + os.environ.get('PATH', '')
            break
    (ROOT / 'logs').mkdir(exist_ok=True)
    with (ROOT / 'logs' / 'video_bot.log').open('a', encoding='utf-8', buffering=1) as log:
        original_stdout, original_stderr = sys.stdout, sys.stderr
        sys.stdout = sys.stderr = log
        from uniquifier.bot import main as run
        try:
            run()
        except SystemExit as error:
            print(str(error))
            return error.code if isinstance(error.code, int) else 1
        except Exception as error:
            print('Startup failed: ' + type(error).__name__)
            return 1
        finally:
            sys.stdout, sys.stderr = original_stdout, original_stderr
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
