"""Native Windows and POSIX process/instance handling without dependencies."""
from __future__ import annotations

import os
import signal
import subprocess
from pathlib import Path


def process_options() -> dict:
    if os.name == 'nt':
        return {'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW}
    return {'start_new_session': True}


def terminate_process(proc):
    if os.name == 'nt':
        # FFmpeg uses threads rather than child processes. Windows kill terminates it.
        proc.kill()
    else:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def acquire_instance_lock(path: Path):
    file = path.open('a+b')
    try:
        if os.name == 'nt':
            import msvcrt
            file.seek(0, 2)
            if file.tell() == 0:
                file.write(b'0')
                file.flush()
            file.seek(0)
            try:
                msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError:
                raise BlockingIOError('Another bot owns the work directory') from None
        else:
            import fcntl
            fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return file
    except BaseException:
        file.close()
        raise
