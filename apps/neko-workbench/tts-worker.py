"""Private one-shot N.E.K.O. free TTS worker. Communicates over stdio only."""
import base64
import json
import os
import queue
import sys
import threading
from pathlib import Path

wire = sys.stdout
sys.stdout = sys.stderr
root = Path(__file__).resolve().parents[2]
service = root / "services" / "neko-tts"
sys.path[:0] = [str(service / "shims"), str(service / "vendor"), str(service)]


def emit(message):
    wire.write(json.dumps(message, separators=(",", ":")) + "\n")
    wire.flush()


def run():
    from providers import FREE_DEFAULT_VOICE_ID, resolve_worker
    from main_logic.tts_client._infra import TTS_AUDIO_DONE_SENTINEL, TTS_SHUTDOWN_SENTINEL

    request = json.loads(sys.stdin.readline(65537))
    text = request.get("text")
    if not isinstance(text, str) or not text.strip() or len(text) > 8000:
        raise ValueError("invalid text")
    worker, key = resolve_worker("free")
    requests, responses = queue.Queue(), queue.Queue()

    def worker_main():
        try:
            worker(requests, responses, key, FREE_DEFAULT_VOICE_ID)
        except Exception:
            responses.put(("__error__", "worker failed"))
        finally:
            responses.put(("__worker_exit__",))

    threading.Thread(target=worker_main, daemon=True).start()
    speech_id = "workbench"
    requests.put((speech_id, text))
    requests.put((None, None))
    audio_bytes = 0
    try:
        while True:
            item = responses.get(timeout=90)
            if isinstance(item, (bytes, bytearray)):
                if item:
                    if len(item) % 2:
                        raise RuntimeError("invalid PCM")
                    audio_bytes += len(item)
                    emit({"type": "audio", "pcm": base64.b64encode(item).decode("ascii"), "sampleRate": 48000})
            elif isinstance(item, tuple) and item:
                if item[0] == TTS_AUDIO_DONE_SENTINEL and len(item) > 1 and item[1] == speech_id:
                    if not audio_bytes:
                        raise RuntimeError("no audio")
                    emit({"type": "ended"})
                    return
                if (item[0] in ("__error__", "__worker_exit__")
                    or (item[0] == "__tts_sentence_failed__" and len(item) > 1 and item[1] == speech_id)
                    or (item[0] == "__ready__" and len(item) > 1 and not item[1])):
                    raise RuntimeError("free TTS unavailable")
    finally:
        requests.put((TTS_SHUTDOWN_SENTINEL, None))


if __name__ == "__main__":
    try:
        run()
    except Exception:
        emit({"type": "error", "message": "N.E.K.O. 免费语音暂不可用"})
        sys.exit(1)
