# Vendor snapshot

- Source: Project N.E.K.O (local checkout `N-E-K-O-main/N.E.K.O`)
- Commit: `b4821ecb003dd913a4f592b2296616cd8ea7e870`
- License: Apache License 2.0 (`vendor/LICENSE`, `vendor/NOTICE`, copied unchanged)
- Vendored: 2026-10-26, for F10 (voice transcript to memory)

`vendor/` holds the smallest set of upstream modules that lets the sidecar
run the upstream ASR workers. Every `.py` file below is byte-identical to the
upstream file at the same path. Do not edit them; re-vendor instead.

## Files (byte-identical to upstream)

`config/prompts/prompts_voice.py`: Whisper priming text and silence-hallucination list.

`main_logic/asr_client/`:

- `_infra.py`: worker request/event protocol, request queue, `AsrSessionConfig`
- `_registry_meta.py`: provider metadata (implementation status, credential fields)
- `audio.py`, `audio_ranges.py`: audio buffer and sample-span helpers
- `connection_cleanup.py`, `delivery.py`, `lifecycle.py`, `provider_policy.py`,
  `transcript.py`, `warmup.py`, `worker_failure.py`: imported by `_infra.py` and the workers
- `workers/_shared.py`: PCM16 constants, WAV encoding
- `workers/dummy.py`: upstream local test worker (final per commit, no partials)
- `workers/faster_whisper.py`: upstream local Whisper worker (manual endpointing)

`main_logic/voice_turn/`: `admission.py`, `audio_delivery.py`, `contracts.py`,
`interception_events.py` (imported by `asr_client`).

## Local files (not upstream)

The six package `__init__.py` files under `vendor/` (`config`, `config/prompts`,
`main_logic`, `main_logic/asr_client`, `main_logic/asr_client/workers`,
`main_logic/voice_turn`) are short stubs. Upstream's versions import the whole
N.E.K.O runtime. `server.py` puts `vendor/` on `sys.path` and imports the leaf
modules by their upstream paths, for example `main_logic.asr_client._infra`.

## Not vendored

- Cloud workers (`qwen`, `openai`, `step`, `grok`, `glm`, `gemini`, `soniox`):
  they need API keys and are not verified. `server.py` lists their credential
  fields and refuses them with `ASR_PROVIDER_NOT_VERIFIED`.
- The free Core route: upstream marks independent `free` ASR as
  `blocked_backend`, and the free realtime Core (`omni_realtime_client`) is a
  full-duplex conversation session, not a transcriber.
- Silero VAD, ONNX models, auto endpointing: push-to-talk endpoints on key release.

## Python dependencies added to `services/neko-memory/.venv`

Pinned: `faster-whisper==1.2.1` (pulls `ctranslate2==4.8.4`, `av==18.1.0`,
`tokenizers`, `onnxruntime`), `soxr==0.5.0.post1` (imported by `_infra.py`),
`websockets==15.0.1` (uvicorn WebSocket backend). `numpy` stays at 1.26.4.
The Whisper `base` model (Systran/faster-whisper-base, about 148 MB) is cached
in `services/neko-asr/models/hf/`, which is git-ignored.
