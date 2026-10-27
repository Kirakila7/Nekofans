"""neko-tts: local TTS sidecar for neko-fish (F11).

Runs vendored N.E.K.O TTS workers (vendor/, see VENDOR.md) behind a small
WebSocket protocol. One WebSocket connection owns one worker thread and its
upstream request/response queues.

Client -> server (JSON text frames):
  {"kind": "speak", "speech_id": str, "text": str}   text for that speech (may repeat)
  {"kind": "flush", "speech_id": str}                no more text for that speech
  {"kind": "interrupt", "speech_id": str | null}     stop the current speech
  {"kind": "stats"}
Server -> client:
  {"kind": "ready", "provider": str, "verified": bool}
  {"kind": "started", "speech_id": str, "sample_rate": 48000}     first PCM of a speech
  {"kind": "audio_chunk", "speech_id": str, "bytes": int, "sample_rate": 48000}
  <binary frame>  PCM16LE mono 48 kHz, belongs to the preceding audio_chunk header
  {"kind": "ended", "speech_id": str}            upstream __audio_done__ for the current speech
  {"kind": "interrupted", "speech_id": str, "dropped_bytes": int}
  {"kind": "stats", ...counters}
  {"kind": "error", "speech_id": str | null, "error_code": str, "error_message": str}

Queue semantics follow upstream main_logic/core/tts_runtime.py:
  (speech_id, text), (None, None) flush, ("__interrupt__", None), ("__shutdown__", None).
Raw PCM on the response queue carries no speech_id; it is attributed to the
current speech. On interrupt the current speech is cleared first, then the
worker is told to stop, then PCM is dropped for a landing window
(NEKO_TTS_INTERRUPT_LAND_MS) before the next speech may start. A done marker
whose speech_id is not the current speech is dropped as stale.

Environment:
  NEKO_TTS_PORT (default 59077), NEKO_TTS_HOST (default 127.0.0.1)
  NEKO_TTS_PROVIDER: tone (default) | dummy | free | step   (per-connection ?provider=)
  NEKO_TTS_VOICE: voice_id override (per-connection ?voice=)
  NEKO_TTS_INTERRUPT_LAND_MS (default 120)
  NEKO_TTS_CONFIG / NEKO_TTS_<PROVIDER>_API_KEY: keyed providers, see providers.py
  NEKO_TTS_ALLOWED_ORIGINS: extra comma-separated browser origins. Requests
    without Origin (native clients), "null"/file:// (Electron) and
    http(s)://127.0.0.1|localhost on any port are always allowed.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import threading
from pathlib import Path
from queue import Queue

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "vendor"))
sys.path.insert(0, str(HERE / "shims"))
sys.path.insert(0, str(HERE))

import uvicorn  # noqa: E402
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402

from main_logic.tts_client._infra import TTS_AUDIO_DONE_SENTINEL, TTS_SHUTDOWN_SENTINEL  # noqa: E402
from providers import PROVIDERS, ProviderError, resolve_worker  # noqa: E402

logger = logging.getLogger("neko-tts")
app = FastAPI()
_server: uvicorn.Server | None = None

SAMPLE_RATE = 48000
DEFAULT_PROVIDER = os.getenv("NEKO_TTS_PROVIDER", "tone")
DEFAULT_VOICE = os.getenv("NEKO_TTS_VOICE", "").strip()
LAND_S = max(0, int(os.getenv("NEKO_TTS_INTERRUPT_LAND_MS", "120"))) / 1000
_PUMP_EXIT = "__pump_exit__"
_EXTRA_ORIGINS = {o.strip() for o in os.getenv("NEKO_TTS_ALLOWED_ORIGINS", "").split(",") if o.strip()}


def _origin_allowed(origin: str | None) -> bool:
    """Block other web pages in a local browser from driving the sidecar."""
    if not origin or origin in ("null", "file://") or origin in _EXTRA_ORIGINS:
        return True
    from urllib.parse import urlsplit

    parts = urlsplit(origin)
    return parts.scheme in ("http", "https") and parts.hostname in ("127.0.0.1", "localhost", "::1")


@app.get("/health")
async def health() -> dict:
    info = PROVIDERS.get(DEFAULT_PROVIDER)
    return {
        "provider": DEFAULT_PROVIDER,
        "verified": bool(info and info.verified),
        "sample_rate": SAMPLE_RATE,
        "providers": {k: {"verified": v.verified, "network": v.network} for k, v in PROVIDERS.items()},
        "providers_not_verified": [k for k, v in PROVIDERS.items() if not v.verified],
    }


@app.post("/shutdown")
async def shutdown(request: Request):
    if not _origin_allowed(request.headers.get("origin")):
        return JSONResponse({"ok": False, "error": "origin not allowed"}, status_code=403)
    if _server:
        _server.should_exit = True
    return {"ok": True}


class _Session:
    def __init__(self, websocket: WebSocket, provider_key: str) -> None:
        self.ws = websocket
        self.provider_key = provider_key
        self.requests: Queue = Queue()
        self.responses: Queue = Queue()
        self.current: str | None = None
        self.started: set[str] = set()
        self.ready = False
        self.landing_until = 0.0
        self.send_lock = asyncio.Lock()
        self.stats = {"dropped_landing_bytes": 0, "dropped_late_bytes": 0, "stale_done": 0, "interrupts": 0}

    async def send(self, payload: dict, binary: bytes | None = None) -> None:
        async with self.send_lock:
            await self.ws.send_text(json.dumps(payload, ensure_ascii=False))
            if binary is not None:
                await self.ws.send_bytes(binary)

    async def error(self, speech_id: str | None, code: str, message: str) -> None:
        await self.send({"kind": "error", "speech_id": speech_id, "error_code": code, "error_message": message})

    async def interrupt(self) -> None:
        old = self.current
        before = self.stats["dropped_landing_bytes"]
        self.current = None
        self.stats["interrupts"] += 1
        loop = asyncio.get_running_loop()
        self.landing_until = loop.time() + LAND_S
        self.requests.put(("__interrupt__", None))
        await asyncio.sleep(LAND_S)
        if old is not None:
            self.started.discard(old)
            await self.send({
                "kind": "interrupted",
                "speech_id": old,
                "dropped_bytes": self.stats["dropped_landing_bytes"] - before,
            })

    async def handle_client(self) -> None:
        while True:
            raw = await self.ws.receive_text()
            try:
                msg = json.loads(raw)
            except ValueError:
                await self.error(None, "BAD_MESSAGE", "invalid JSON")
                continue
            kind = msg.get("kind")
            sid = msg.get("speech_id")
            sid = str(sid) if sid not in (None, "") else None
            if kind == "speak":
                text = str(msg.get("text") or "")
                if not sid or sid.startswith("__"):
                    await self.error(sid, "BAD_SPEECH_ID", "speak needs a speech_id")
                    continue
                if self.current is not None and self.current != sid:
                    # A new speech always preempts the old one, as upstream does on a new turn.
                    await self.interrupt()
                self.current = sid
                if text:
                    self.requests.put((sid, text))
            elif kind == "flush":
                if sid is not None and sid == self.current:
                    self.requests.put((None, None))
            elif kind == "interrupt":
                if self.current is not None and (sid is None or sid == self.current):
                    await self.interrupt()
            elif kind == "stats":
                await self.send({"kind": "stats", **self.stats})
            else:
                await self.error(sid, "BAD_MESSAGE", f"unknown kind {kind!r}")

    async def handle_worker(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            item = await loop.run_in_executor(None, self.responses.get)
            if isinstance(item, (bytes, bytearray)):
                await self._on_pcm(bytes(item), loop.time())
                continue
            if not isinstance(item, tuple) or not item:
                continue
            tag = item[0]
            if tag == _PUMP_EXIT:
                return
            if tag == "__ready__":
                ok = bool(item[1]) if len(item) > 1 else False
                if not self.ready:
                    if not ok:
                        await self.error(None, "TTS_NOT_READY", f"{self.provider_key} worker failed to start")
                        return
                    self.ready = True
                    info = PROVIDERS[self.provider_key]
                    await self.send({"kind": "ready", "provider": self.provider_key, "verified": info.verified})
                elif not ok:
                    await self.error(self.current, "TTS_NOT_READY", f"{self.provider_key} worker lost readiness")
                continue
            if tag == TTS_AUDIO_DONE_SENTINEL and len(item) == 2:
                done_sid = str(item[1] or "")
                if done_sid and done_sid == self.current:
                    self.current = None
                    self.started.discard(done_sid)
                    await self.send({"kind": "ended", "speech_id": done_sid})
                else:
                    self.stats["stale_done"] += 1
                    logger.info("stale done marker dropped speech_id=%s current=%s", done_sid, self.current)
                continue
            if tag == "__error__":
                await self.error(self.current, "TTS_WORKER_ERROR", str(item[1] if len(item) > 1 else ""))
                continue
            # __reconnecting__, sentence markers and other upstream diagnostics are not forwarded.
            logger.debug("worker item ignored: %r", tag)

    async def _on_pcm(self, pcm: bytes, now: float) -> None:
        sid = self.current
        if sid is None:
            key = "dropped_landing_bytes" if now <= self.landing_until else "dropped_late_bytes"
            self.stats[key] += len(pcm)
            return
        if sid not in self.started:
            self.started.add(sid)
            await self.send({"kind": "started", "speech_id": sid, "sample_rate": SAMPLE_RATE})
        await self.send({"kind": "audio_chunk", "speech_id": sid, "bytes": len(pcm), "sample_rate": SAMPLE_RATE}, pcm)


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket) -> None:
    if not _origin_allowed(websocket.headers.get("origin")):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    query = dict(websocket.query_params)
    provider_key = query.pop("provider", DEFAULT_PROVIDER)
    voice_id = query.pop("voice", DEFAULT_VOICE).strip()
    session = _Session(websocket, provider_key)
    try:
        if provider_key not in PROVIDERS:
            raise ProviderError(f"unknown provider: {provider_key}")
        worker_fn, api_key = resolve_worker(provider_key, query)
    except ProviderError as exc:
        await session.error(None, "PROVIDER_UNAVAILABLE", str(exc))
        await websocket.close()
        return
    voice_id = voice_id or PROVIDERS[provider_key].default_voice_id

    def run_worker() -> None:
        try:
            worker_fn(session.requests, session.responses, api_key, voice_id)
        except Exception as exc:  # worker crash must not hang the pump
            logger.exception("tts worker crashed")
            session.responses.put(("__error__", f"worker crashed: {exc!r}"))
        finally:
            session.responses.put((_PUMP_EXIT, None))

    thread = threading.Thread(target=run_worker, name=f"tts-{provider_key}", daemon=True)
    thread.start()
    client = asyncio.create_task(session.handle_client())
    pump = asyncio.create_task(session.handle_worker())
    try:
        done, _ = await asyncio.wait({client, pump}, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            exc = task.exception()
            if exc is not None and not isinstance(exc, (WebSocketDisconnect, RuntimeError)):
                logger.warning("tts session ended: %r", exc)
    finally:
        client.cancel()
        session.requests.put((TTS_SHUTDOWN_SENTINEL, None))
        await asyncio.get_running_loop().run_in_executor(None, thread.join, 5.0)
        session.responses.put((_PUMP_EXIT, None))
        await asyncio.gather(client, pump, return_exceptions=True)
        try:
            await websocket.close()
        except RuntimeError:
            pass


def main() -> None:
    global _server
    logging.basicConfig(level=os.getenv("NEKO_TTS_LOG_LEVEL", "INFO").upper())
    host = os.getenv("NEKO_TTS_HOST", "127.0.0.1")
    port = int(os.getenv("NEKO_TTS_PORT", "59077"))
    logger.info("neko-tts provider=%s on %s:%d", DEFAULT_PROVIDER, host, port)
    _server = uvicorn.Server(uvicorn.Config(app, host=host, port=port, log_level="warning", ws="websockets"))
    _server.run()


if __name__ == "__main__":
    main()
