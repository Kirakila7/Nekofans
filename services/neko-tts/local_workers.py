"""Sidecar-local TTS workers (not part of the upstream vendor snapshot).

tone_tts_worker follows the upstream worker contract
``(request_queue, response_queue, audio_api_key, voice_id)`` and the same
control items as the vendored workers:

    (speech_id, text)        text for the current utterance
    (None, None)             finish and flush the current utterance
    ("__interrupt__", None)  stop synthesis, emit nothing more for it
    ("__shutdown__", None)   exit the thread

It produces a two-pitch tone whose length is proportional to the text, as
48 kHz mono s16le PCM, so tests and the playback harness have real audio
without any network service.
"""

from __future__ import annotations

import math
import time
from collections import deque

import numpy as np

from main_logic.tts_client._infra import AudioDoneEmitter, TTS_SHUTDOWN_SENTINEL

SAMPLE_RATE = 48000


def tone_pcm(duration_ms: int, offset_ms: int = 0) -> bytes:
    """Tone segment; pitch alternates every 150 ms so it sounds speech-like."""
    n = int(SAMPLE_RATE * duration_ms / 1000)
    t0 = offset_ms / 1000
    t = t0 + np.arange(n, dtype=np.float64) / SAMPLE_RATE
    freq = np.where((np.floor(t / 0.15) % 2) == 0, 330.0, 440.0)
    wave = 0.2 * np.sin(2 * math.pi * freq * t)
    return (wave * 32767).astype("<i2").tobytes()


def tone_tts_worker(
    request_queue,
    response_queue,
    audio_api_key,
    voice_id,
    *,
    ms_per_char: int = 90,
    min_ms: int = 400,
    first_audio_delay_ms: int = 150,
    chunk_ms: int = 100,
    speed: float = 2.0,
):
    """Deterministic local worker; ``speed`` is production rate vs real time."""
    _ = audio_api_key, voice_id
    audio_done = AudioDoneEmitter(response_queue)
    pending: deque = deque()
    response_queue.put(("__ready__", True))

    def next_item():
        return pending.popleft() if pending else request_queue.get()

    def poll_control():
        """Non-blocking check during synthesis. Returns "stop", "shutdown" or None."""
        while True:
            try:
                item = request_queue.get_nowait()
            except Exception:
                return None
            sid, _text = item
            if sid == TTS_SHUTDOWN_SENTINEL:
                return "shutdown"
            if sid == "__interrupt__":
                return "stop"
            # Anything else (new speech text, flush) is handled after this
            # utterance; a different speech_id supersedes the current one.
            pending.append(item)
            if sid is not None and sid != current_speech_id:
                return "stop"

    def synthesize(text: str) -> str:
        total_ms = max(min_ms, len(text.strip()) * ms_per_char)
        deadline = time.monotonic() + first_audio_delay_ms / 1000
        while time.monotonic() < deadline:
            ctl = poll_control()
            if ctl:
                return ctl
            time.sleep(0.01)
        produced = 0
        while produced < total_ms:
            ctl = poll_control()
            if ctl:
                return ctl
            seg = min(chunk_ms, total_ms - produced)
            response_queue.put(tone_pcm(seg, produced))
            produced += seg
            time.sleep(seg / 1000 / max(speed, 0.1))
        return "done"

    current_speech_id = None
    text_buf = ""
    while True:
        try:
            sid, text = next_item()
        except Exception:
            break
        if sid == TTS_SHUTDOWN_SENTINEL:
            break
        if sid == "__interrupt__":
            audio_done.begin_interrupt()
            current_speech_id, text_buf = None, ""
            audio_done.reset()
            audio_done.end_interrupt()
            continue
        if sid is None:
            finished = current_speech_id
            if finished is not None and text_buf.strip():
                result = synthesize(text_buf)
                if result == "shutdown":
                    break
                if result == "done":
                    audio_done.emit(finished)
            current_speech_id, text_buf = None, ""
            continue
        if sid != current_speech_id:
            current_speech_id, text_buf = sid, ""
            audio_done.reset()
        text_buf += text or ""
