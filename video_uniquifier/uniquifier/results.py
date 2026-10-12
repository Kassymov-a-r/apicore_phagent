"""Temporary, unlisted result downloads; never log bearer URLs."""
from __future__ import annotations

import re
import secrets
import shutil
import threading
import time
from pathlib import Path

from .media import MediaError


class ResultDownloads:
    def __init__(self, root: Path, ttl=3600, budget=1024**3):
        self.root = root
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        root.chmod(0o700)
        self.ttl, self.budget = ttl, budget
        self.entries = {}
        self.lock = threading.Lock()
        self.slots = threading.BoundedSemaphore(2)

    def cleanup(self):
        with self.lock:
            self._cleanup()

    def _cleanup(self):
        now = time.monotonic()
        for token, (path, expires, size, name) in list(self.entries.items()):
            if expires <= now:
                path.unlink(missing_ok=True)
                del self.entries[token]

    def publish(self, source: Path, version: int):
        size = source.stat().st_size
        with self.lock:
            self._cleanup()
            if sum(entry[2] for entry in self.entries.values()) + size > self.budget:
                raise MediaError('Хранилище временных результатов заполнено. Скачайте готовые файлы и попробуйте позже.')
            if shutil.disk_usage(self.root).free < size + 100*1024**2:
                raise MediaError('Недостаточно места для временного результата.')
            token = secrets.token_urlsafe(32)
            path = self.root / token
            source.replace(path)
            path.chmod(0o600)
            self.entries[token] = (path, time.monotonic() + self.ttl, size, f'version_{version}.mp4')
            return token

    def revoke(self, token):
        with self.lock:
            entry = self.entries.pop(token, None)
            if entry:
                entry[0].unlink(missing_ok=True)

    def serve(self, handler, token, head=False):
        if not re.fullmatch(r'[A-Za-z0-9_-]{43}', token):
            handler.respond(404)
            return
        if not self.slots.acquire(blocking=False):
            handler.respond(429)
            return
        stream = None
        try:
            with self.lock:
                self._cleanup()
                entry = self.entries.get(token)
                if entry is None:
                    handler.respond_json(410, {'error': 'Ссылка истекла или сервер перезапустился. Загрузите исходник в бота снова.'})
                    return
                path, expires, size, name = entry
                try:
                    stream = path.open('rb')
                except OSError:
                    handler.respond(410)
                    return
            start, end, code = 0, size-1, 200
            range_header = handler.headers.get('Range')
            if range_header:
                match = re.fullmatch(r'bytes=(\d*)-(\d*)', range_header)
                if not match or not any(match.groups()):
                    handler.respond(416)
                    return
                first, last = match.groups()
                if first:
                    start = int(first)
                    end = min(int(last), size-1) if last else size-1
                else:
                    start = max(0, size-int(last))
                if start > end or start >= size:
                    handler.respond(416)
                    return
                code = 206
            handler.connection.settimeout(30)
            handler.send_response(code)
            handler.send_header('Content-Type', 'video/mp4')
            handler.send_header('Content-Disposition', f'attachment; filename="{name}"')
            handler.send_header('Content-Length', str(end-start+1))
            handler.send_header('Accept-Ranges', 'bytes')
            if code == 206:
                handler.send_header('Content-Range', f'bytes {start}-{end}/{size}')
            handler.send_header('Cache-Control', 'private, no-store')
            handler.send_header('Referrer-Policy', 'no-referrer')
            handler.send_header('X-Content-Type-Options', 'nosniff')
            handler.send_header('Connection', 'close')
            handler.end_headers()
            if not head:
                stream.seek(start)
                remaining = end-start+1
                while remaining:
                    block = stream.read(min(256*1024, remaining))
                    if not block:
                        break
                    handler.wfile.write(block)
                    remaining -= len(block)
        except (OSError, ValueError):
            pass  # Client disconnects and malformed requests must not reveal bearer URLs.
        finally:
            if stream:
                stream.close()
            self.slots.release()
