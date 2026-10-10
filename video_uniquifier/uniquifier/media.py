from __future__ import annotations

import hashlib
import json
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path

from .platform_support import process_options, terminate_process


class MediaError(Exception):
    pass


class Cancelled(MediaError):
    pass


class ProcessingTimeout(MediaError):
    pass


@dataclass(frozen=True)
class Variant:
    speed: float
    zoom: float
    brightness: float
    contrast: float
    saturation: float


VARIANTS = (
    Variant(.98, 1.010, .002, 1.003, 1.003),
    Variant(.99, 1.015, -.002, .997, .997),
    Variant(1.01, 1.020, .003, 1.005, 1.002),
    Variant(1.02, 1.012, -.003, 1.002, 1.005),
    Variant(1.00, 1.018, .001, .998, .995),
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def run(command: list[str], cancel: threading.Event, timeout: float) -> str:
    if cancel.is_set():
        raise Cancelled('Задача отменена.')
    # A process group ensures codecs are also stopped on timeout/cancellation.
    proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            **process_options())
    started = time.monotonic()
    try:
        while True:
            try:
                out, err = proc.communicate(timeout=.25)
                break
            except subprocess.TimeoutExpired:
                if cancel.is_set():
                    raise Cancelled('Задача отменена.')
                if time.monotonic() - started > timeout:
                    raise ProcessingTimeout('Превышено время обработки видео.')
        if proc.returncode:
            # Keep codec diagnostics local; never reflect arbitrary file data into chat.
            raise MediaError('FFmpeg не смог прочитать или обработать видео.')
        return out.decode('utf-8')
    finally:
        if proc.poll() is None:
            terminate_process(proc)
            proc.communicate()


def probe(path: Path, cancel: threading.Event | None = None) -> dict:
    return json.loads(run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-show_format',
                           '-of', 'json', str(path)], cancel or threading.Event(), 30))


def inspect(path: Path, cancel: threading.Event, max_duration: float,
            max_pixels: int) -> tuple[dict, dict, bool, int, int, str]:
    data = probe(path, cancel)
    video = next((s for s in data['streams'] if s['codec_type'] == 'video'
                  and not s.get('disposition', {}).get('attached_pic')), None)
    if not video:
        raise MediaError('В файле нет видеодорожки.')
    duration = float(data.get('format', {}).get('duration', 0))
    if not 0 < duration <= max_duration:
        raise MediaError('Видео слишком длинное или его длительность не определена.')
    width, height = video['width'], video['height']
    if width * height > max_pixels:
        raise MediaError('Разрешение превышает установленный предел.')
    rotation = int(round(float(video.get('tags', {}).get('rotate', 0))))
    for side in video.get('side_data_list', []):
        if 'rotation' in side:
            rotation = int(round(float(side['rotation'])))
    if abs(rotation) % 180 == 90:
        width, height = height, width
    rate = video.get('avg_frame_rate', '0/0')
    try:
        if not 1 <= float(Fraction(rate)) <= 120:
            raise ValueError
    except (ValueError, ZeroDivisionError):
        raise MediaError('Неподдерживаемая частота кадров.') from None
    audio = any(s['codec_type'] == 'audio' for s in data['streams'])
    return data, video, audio, width, height, rate


def render(source: Path, target: Path, index: int, *, mode: str,
           cancel: threading.Event, crf: int = 16, preset: str = 'slow',
           timeout: float = 1800, max_duration: float = 600,
           max_pixels: int = 3840 * 2160, threads: int = 2) -> dict:
    data, video, audio, width, height, rate = inspect(source, cancel, max_duration, max_pixels)
    variant = VARIANTS[index]
    command = ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
               '-threads', str(threads), '-protocol_whitelist', 'file,pipe', '-i', str(source),
               '-map', f"0:{video['index']}", '-map', '0:a:0?',
               '-map_metadata', '-1', '-map_chapters', '-1']
    if mode == 'lossless':
        if not any(name in data['format']['format_name'].split(',') for name in ('mov', 'mp4')):
            raise MediaError('/lossless поддерживает исходники MP4/MOV. Для этого контейнера используйте /micro.')
        command += ['-c', 'copy', '-movflags', '+faststart+use_metadata_tags']
        description = 'Без перекодирования: кадры и звук сохранены; изменены метаданные MP4.'
    elif mode == 'micro':
        if width % 2 or height % 2:
            raise MediaError('Для MP4 нужны чётные размеры кадра. Используйте /lossless.')
        if video.get('sample_aspect_ratio', '1:1') not in ('1:1', '0:1', 'N/A'):
            raise MediaError('Анаморфное видео: используйте /lossless для сохранения пропорций.')
        # Refuse silent HDR/10-bit -> SDR conversion. Remux mode remains available.
        pixel_format = video.get('pix_fmt', '')
        if (video.get('color_transfer') in ('smpte2084', 'arib-std-b67')
                or any(bit in pixel_format for bit in ('10', '12', '16'))):
            raise MediaError('HDR/10-bit: используйте /lossless для сохранения цвета и разрядности.')
        vf = (f"setpts=(PTS-STARTPTS)/{variant.speed},"
              f"crop=trunc(iw/{variant.zoom}/2)*2:trunc(ih/{variant.zoom}/2)*2,"
              f"scale={width}:{height}:flags=lanczos,"
              f"eq=brightness={variant.brightness}:contrast={variant.contrast}:"
              f"saturation={variant.saturation},setsar=1")
        command += ['-vf', vf, '-c:v', 'libx264', '-crf', str(crf), '-preset', preset,
                    '-threads', str(threads), '-filter_threads', '1', '-pix_fmt', 'yuv420p',
                    '-fps_mode', 'cfr', '-r', rate, '-metadata:s:v:0', 'rotate=0']
        # Preserve source colour declarations where available.
        for key, option in [('color_primaries', '-color_primaries'),
                            ('color_transfer', '-color_trc'), ('color_space', '-colorspace'),
                            ('color_range', '-color_range')]:
            if video.get(key) and video[key] not in ('unknown', 'reserved'):
                command += [option, video[key]]
        if audio:
            audio_stream = next(s for s in data['streams'] if s['codec_type'] == 'audio')
            delta = float(audio_stream.get('start_time', 0)) - float(video.get('start_time', 0))
            af = (f'atrim=start={-delta},' if delta < 0 else '')
            af += f'asetpts=PTS-STARTPTS,atempo={variant.speed}'
            if delta > 0:
                af += f',adelay={round(delta / variant.speed * 1000)}:all=1'
            command += ['-af', af,
                        '-c:a', 'aac', '-b:a', '256k']
        command += ['-movflags', '+faststart']
        description = (f'Скорость {variant.speed:.2f}×; приближение {variant.zoom:.3f}×; '
                       'мягкая цветокоррекция.')
    else:
        raise ValueError('Unknown processing mode')
    marker = uuid.uuid4().hex
    command += ['-metadata', f'comment=variant-{index + 1}-{marker}', str(target)]
    run(command, cancel, timeout)
    verified = probe(target, cancel)
    if not target.is_file() or target.stat().st_size == 0:
        raise MediaError('Получен пустой файл.')
    out_video = next(s for s in verified['streams'] if s['codec_type'] == 'video')
    if mode == 'micro' and (out_video['width'], out_video['height']) != (width, height):
        raise MediaError('Не удалось сохранить размеры видео.')
    expected_duration = float(data['format']['duration']) / (variant.speed if mode == 'micro' else 1)
    actual_duration = float(verified['format']['duration'])
    if abs(actual_duration - expected_duration) > max(.25, expected_duration * .005):
        raise MediaError('Проверка длительности результата не пройдена.')
    return {'number': index + 1, 'sha256': sha256(target), 'description': description,
            'size_bytes': target.stat().st_size, 'duration': actual_duration,
            'mode': mode, 'file': target.name}
