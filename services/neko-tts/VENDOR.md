# Vendor snapshot

`vendor/` is an unmodified subset of N.E.K.O (local checkout
`N-E-K-O-main/N.E.K.O`, origin `https://github.com/CN-Zephyr/N.E.K.O.git`)
at commit `b4821ecb003dd913a4f592b2296616cd8ea7e870` (2026-10-25).
License: see `vendor/LICENSE` and `vendor/NOTICE`.

Do not edit files under `vendor/`. Sidecar-specific code lives in
`server.py`, `providers.py`, `local_workers.py` and `shims/`.

## Vendored files

- `main_logic/__init__.py`
- `main_logic/tts_client/_infra.py`, `_telemetry.py`
- `main_logic/tts_client/workers/__init__.py`, `dummy.py`, `free.py`, `_step_protocol.py`
- `utils/tts/native_voice_registry.py`
- `utils/tts/providers/stepfun.py`, `gemini.py`, `grok.py` (imported by the registry)
- `config/api_providers.json` (free / StepFun voice tables)
- `LICENSE`, `NOTICE`

`main_logic/tts_client/__init__.py` is not vendored: it imports every
provider worker. The sidecar imports worker modules directly.

## Shims (`shims/utils/`)

Upstream modules the vendored code imports but that pull in the whole app:

- `config_manager.get_config_manager()`: only `_adjust_free_api_url`, which
  returns the URL unchanged (mainland `wss://www.lanlan.tech/tts`).
- `api_config_loader`: free voices, native voice provider config, livestream off.
- `language_utils`: language hint detection copied from upstream; TTS
  language code fixed to `cmn-CN`.
- `logger_config.get_module_logger`.

## Integrity (SHA-256, first 16 hex chars; equal to upstream at the commit)

```
0d99b64baf1323c3  LICENSE
96199da23327c508  NOTICE
22964f8244a15bf6  config/api_providers.json
e894656ad7eb4723  main_logic/__init__.py
35a4cd359cd5a170  main_logic/tts_client/_infra.py
f913e588a4cf52b6  main_logic/tts_client/_telemetry.py
fa7195d9cb036cde  main_logic/tts_client/workers/__init__.py
87251fa45f51581f  main_logic/tts_client/workers/_step_protocol.py
d162254311aa40d4  main_logic/tts_client/workers/dummy.py
a579fb63d1d60e37  main_logic/tts_client/workers/free.py
ed88d43f5036d45f  utils/tts/native_voice_registry.py
c5c1ed72aed52b71  utils/tts/providers/gemini.py
7167cb13ede9f979  utils/tts/providers/grok.py
f221c96cfa852ff2  utils/tts/providers/stepfun.py
```

## Providers

| key   | source                         | network          | verified here |
|-------|--------------------------------|------------------|---------------|
| tone  | `local_workers.py` (test tone) | no               | yes (default, offline tests) |
| dummy | vendored `dummy.py`            | no               | yes (produces no audio) |
| free  | vendored `free.py`             | lanlan.tech      | live smoke only (`NEKO_LIVE_FREE=1`) |
| step  | vendored `_step_protocol.py`   | StepFun, API key | no: config path only, never called |
