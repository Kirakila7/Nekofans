"""neko-asr: local push-to-talk ASR sidecar for neko-fish (F10).

Runs upstream N.E.K.O ASR workers (vendored under vendor/, see VENDOR.md)
behind a small WebSocket protocol. One WebSocket connection owns one worker.

Client -> server (JSON text frames):
  {"kind": "start", "utterance_id": str}
  {"kind": "audio", "utterance_id": str, "data": base64 PCM16LE mono 16 kHz}
  {"kind": "stop",  "utterance_id": str}
Server -> client:
  {"kind": "ready", "provider": str}
  {"kind": "partial", "utterance_id": str, "text": str}   display only
  {"kind": "final",   "utterance_id": str, "text": str}   at most once per stop
  {"kind": "empty",   "utterance_id": str}                stop without audio/speech
  {"kind": "error",   "utterance_id": str | null, "error_code": str, "error_message": str}

Environment:
  NEKO_ASR_PORT (default 59067), NEKO_ASR_HOST (default 127.0.0.1)
  NEKO_ASR_PROVIDER: faster_whisper (default) | dummy | scripted | <cloud key>
  NEKO_WHISPER_MODEL (default base), NEKO_WHISPER_DEVICE (default cpu)
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import logging
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODELS_DIR = HERE / "models"

# Model cache must be configured before huggingface_hub is imported (lazily,
# by the faster_whisper worker thread).
os.environ.setdefault("HF_HOME", str(MODELS_DIR / "hf-home"))
os.environ.setdefault("HF_HUB_CACHE", str(MODELS_DIR / "hf"))
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("NEKO_WHISPER_MODEL", "base")
# CUDA is opt-in: a visible GPU without cuBLAS/cuDNN would otherwise cost a
# failed probe on every model load.
os.environ.setdefault("NEKO_WHISPER_DEVICE", "cpu")

sys.path.insert(0, str(HERE / "vendor"))
sys.path.insert(0, str(HERE))

import uvicorn  # noqa: E402
from fastapi import FastAPI, WebSocket, WebSocketDisconnect  # noqa: E402

from main_logic.asr_client._infra import (  # noqa: E402
    AsrSessionConfig,
    _AsrRequestQueue,
    _AsrWorkerEvent,
    _AsrWorkerRequest,
)
from main_logic.asr_client.workers.dummy import dummy_asr_worker  # noqa: E402
from main_logic.asr_client.workers.faster_whisper import faster_whisper_asr_worker  # noqa: E402
from scripted_worker import scripted_asr_worker  # noqa: E402

logger = logging.getLogger("neko-asr")

LOCAL_WORKERS = {
    "faster_whisper": faster_whisper_asr_worker,
    "dummy": dummy_asr_worker,
    "scripted": scripted_asr_worker,
}

# Upstream cloud workers and the credential field upstream reads for each
# (vendor snapshot _registry_meta.py). They are not vendored or verified here:
# selecting one fails with ASR_PROVIDER_NOT_VERIFIED instead of calling out.
CLOUD_PROVIDERS = {
    "qwen": "ASSIST_API_KEY_QWEN",
    "openai": "ASSIST_API_KEY_OPENAI",
    "step": "ASSIST_API_KEY_STEP",
    "grok": "ASSIST_API_KEY_GROK",
    "glm": "ASSIST_API_KEY_GLM",
    "gemini": "ASSIST_API_KEY_GEMINI",
    "soniox": "SONIOX_API_KEY",
}

PROVIDER = os.getenv("NEKO_ASR_PROVIDER", "faster_whisper").strip().lower()
PCM_MAX_FRAME_BYTES = 16_000 * 2 * 2  # 2 s per audio frame

app = FastAPI(title="neko-asr")
_server: uvicorn.Server | None = None


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "provider": PROVIDER,
        "local_providers": sorted(LOCAL_WORKERS),
        "cloud_providers_not_verified": sorted(CLOUD_PROVIDERS),
        "whisper_model": os.environ["NEKO_WHISPER_MODEL"],
        "whisper_device": os.environ["NEKO_WHISPER_DEVICE"],
    }


@app.post("/shutdown")
async def shutdown() -> dict:
    if _server is not None:
        _server.should_exit = True
    return {"status": "shutting_down"}


class _Session:
    """One connection: string utterance ids mapped onto upstream worker keys."""

    GENERATION = 1
    BUFFER_EPOCH = 0

    def __init__(self, websocket: WebSocket) -> None:
        self.ws = websocket
        self.requests = _AsrRequestQueue()
        self.events: asyncio.Queue[_AsrWorkerEvent] = asyncio.Queue()
        self.next_worker_id = 1
        self.worker_ids: dict[str, int] = {}
        self.utterances: dict[int, str] = {}
        self.has_audio: set[int] = set()
        self.committed: set[int] = set()
        self.finalized: set[int] = set()
        self.send_lock = asyncio.Lock()

    async def send(self, payload: dict) -> None:
        async with self.send_lock:
            await self.ws.send_json(payload)

    async def error(self, utterance_id: str | None, code: str, message: str) -> None:
        await self.send({
            "kind": "error",
            "utterance_id": utterance_id,
            "error_code": code,
            "error_message": message,
        })

    def request(self, kind: str, worker_id: int, audio: bytes = b"") -> _AsrWorkerRequest:
        return _AsrWorkerRequest(
            kind=kind,  # type: ignore[arg-type]
            generation=self.GENERATION,
            buffer_epoch=self.BUFFER_EPOCH,
            utterance_id=worker_id,
            audio=audio,
        )

    async def handle_client(self) -> None:
        while True:
            msg = await self.ws.receive_json()
            kind = msg.get("kind") if isinstance(msg, dict) else None
            utterance_id = msg.get("utterance_id") if isinstance(msg, dict) else None
            if not isinstance(utterance_id, str) or not utterance_id:
                await self.error(None, "ASR_PROTOCOL_ERROR", "utterance_id is required")
                continue
            if kind == "start":
                if utterance_id in self.worker_ids:
                    await self.error(utterance_id, "ASR_PROTOCOL_ERROR", "utterance_id already started")
                    continue
                worker_id = self.next_worker_id
                self.next_worker_id += 1
                self.worker_ids[utterance_id] = worker_id
                self.utterances[worker_id] = utterance_id
                continue
            worker_id = self.worker_ids.get(utterance_id)
            if worker_id is None:
                await self.error(utterance_id, "ASR_PROTOCOL_ERROR", "utterance_id was not started")
                continue
            if worker_id in self.committed:
                # Late audio or a repeated stop after commit is ignored.
                continue
            if kind == "audio":
                try:
                    pcm = base64.b64decode(str(msg.get("data", "")), validate=True)
                except (binascii.Error, ValueError):
                    await self.error(utterance_id, "ASR_PROTOCOL_ERROR", "audio data is not base64")
                    continue
                if not pcm or len(pcm) % 2 or len(pcm) > PCM_MAX_FRAME_BYTES:
                    await self.error(utterance_id, "ASR_PROTOCOL_ERROR", "audio frame must be non-empty PCM16")
                    continue
                self.has_audio.add(worker_id)
                await self.requests.put(self.request("audio", worker_id, pcm))
            elif kind == "stop":
                self.committed.add(worker_id)
                if worker_id not in self.has_audio:
                    self.finalized.add(worker_id)
                    await self.send({"kind": "empty", "utterance_id": utterance_id})
                    continue
                await self.requests.put(self.request("commit", worker_id))
            else:
                await self.error(utterance_id, "ASR_PROTOCOL_ERROR", f"unknown kind: {kind}")

    async def handle_worker(self) -> None:
        while True:
            event = await self.events.get()
            utterance_id = self.utterances.get(event.utterance_id or -1)
            if event.kind == "ready":
                await self.send({"kind": "ready", "provider": PROVIDER})
            elif event.kind == "partial" and utterance_id is not None:
                if event.utterance_id not in self.finalized:
                    await self.send({"kind": "partial", "utterance_id": utterance_id, "text": event.text})
            elif event.kind == "final" and utterance_id is not None:
                # Forward every final the worker emits: replay dedup is the
                # memory write path's job (turn_id receipts), and tests rely
                # on duplicates reaching it.
                self.finalized.add(event.utterance_id)  # type: ignore[arg-type]
                text = event.text.strip()
                if text:
                    await self.send({"kind": "final", "utterance_id": utterance_id, "text": text})
                else:
                    await self.send({"kind": "empty", "utterance_id": utterance_id})
            elif event.kind == "error":
                await self.error(utterance_id, event.error_code or "ASR_WORKER_ERROR", event.error_message)
            elif event.kind == "closed":
                return


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    session = _Session(websocket)
    worker_fn = LOCAL_WORKERS.get(PROVIDER)
    if worker_fn is None:
        code = "ASR_PROVIDER_NOT_VERIFIED" if PROVIDER in CLOUD_PROVIDERS else "ASR_UNKNOWN_PROVIDER"
        await session.error(None, code, f"provider {PROVIDER!r} is not available in this sidecar")
        await websocket.close(code=1011)
        return
    language = websocket.query_params.get("language", "zh")
    try:
        config = AsrSessionConfig(language=language, input_sample_rate_hz=16000, endpointing_mode="manual")
    except ValueError as exc:
        await session.error(None, "ASR_INVALID_CONFIG", str(exc))
        await websocket.close(code=1008)
        return

    worker = asyncio.create_task(worker_fn(session.requests, session.events, "", config))
    client = asyncio.create_task(session.handle_client())
    pump = asyncio.create_task(session.handle_worker())
    try:
        done, _ = await asyncio.wait({client, pump}, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            exc = task.exception()
            if exc is not None and not isinstance(exc, WebSocketDisconnect):
                logger.warning("asr session ended: %r", exc)
    finally:
        client.cancel()
        await session.requests.put(_AsrWorkerRequest(kind="shutdown", generation=_Session.GENERATION))
        try:
            await asyncio.wait_for(asyncio.shield(worker), timeout=5.0)
        except (asyncio.TimeoutError, Exception):
            worker.cancel()
        pump.cancel()
        await asyncio.gather(client, pump, worker, return_exceptions=True)
        try:
            await websocket.close()
        except RuntimeError:
            pass


def main() -> None:
    global _server
    logging.basicConfig(level=os.getenv("NEKO_ASR_LOG_LEVEL", "INFO").upper())
    MODELS_DIR.mkdir(exist_ok=True)
    host = os.getenv("NEKO_ASR_HOST", "127.0.0.1")
    port = int(os.getenv("NEKO_ASR_PORT", "59067"))
    logger.info("neko-asr provider=%s on %s:%d", PROVIDER, host, port)
    _server = uvicorn.Server(uvicorn.Config(app, host=host, port=port, log_level="warning", ws="websockets"))
    _server.run()


if __name__ == "__main__":
    main()
