"""Test-only ASR worker: emits interim (partial) events, then one final.

Upstream's dummy worker only emits finals, so it cannot exercise the interim
caption path. This worker follows the same upstream worker signature and
request/event protocol (vendor/main_logic/asr_client/_infra.py).

Text comes from NEKO_ASR_SCRIPT, a "|"-separated list: every entry except the
last is sent as a partial when audio arrives; the last is the final text.
NEKO_ASR_SCRIPT_DUPLICATE_FINAL=1 emits the final twice (replay test).
"""

from __future__ import annotations

import asyncio
import os

from main_logic.asr_client._infra import AsrSessionConfig, _AsrWorkerEvent, _AsrWorkerRequest

_DEFAULT_SCRIPT = "测试|测试识别|测试识别文本"


async def scripted_asr_worker(
    request_queue: asyncio.Queue[_AsrWorkerRequest],
    response_queue: asyncio.Queue[_AsrWorkerEvent],
    api_key: str,
    config: AsrSessionConfig,
) -> None:
    _ = (api_key, config)
    parts = [p for p in os.getenv("NEKO_ASR_SCRIPT", _DEFAULT_SCRIPT).split("|") if p]
    partials, final_text = parts[:-1], parts[-1]
    duplicate_final = os.getenv("NEKO_ASR_SCRIPT_DUPLICATE_FINAL", "") == "1"
    # Partials already sent per utterance key; one partial per audio frame.
    sent: dict[tuple[int, int, int | None], int] = {}
    last_generation = 0
    try:
        await response_queue.put(_AsrWorkerEvent(kind="ready", generation=0))
        while True:
            request = await request_queue.get()
            last_generation = request.generation
            key = (request.generation, request.buffer_epoch, request.utterance_id)
            if request.kind == "shutdown":
                break
            if request.kind == "clear":
                sent.clear()
            elif request.kind == "audio":
                index = sent.get(key, 0)
                sent[key] = index + 1
                if index < len(partials):
                    await response_queue.put(_AsrWorkerEvent(
                        kind="partial", generation=key[0], buffer_epoch=key[1],
                        utterance_id=key[2], text=partials[index],
                    ))
            elif request.kind == "commit":
                if key not in sent:
                    continue
                del sent[key]
                final = _AsrWorkerEvent(
                    kind="final", generation=key[0], buffer_epoch=key[1],
                    utterance_id=key[2], text=final_text,
                )
                await response_queue.put(final)
                if duplicate_final:
                    await response_queue.put(final)
    finally:
        await response_queue.put(_AsrWorkerEvent(kind="closed", generation=last_generation))
