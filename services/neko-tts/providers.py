"""TTS provider table for the sidecar.

Each entry resolves to an upstream-contract worker callable plus its API key.
"verified" marks providers exercised by this repo's tests; keyed providers are
wired through the config path only and have never been called from here.

Keyed provider credentials come from the JSON file named by NEKO_TTS_CONFIG
({"step": {"api_key": "..."}}) or from NEKO_TTS_<PROVIDER>_API_KEY.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from functools import partial
from typing import Any, Callable

# Upstream DEFAULT_ASSIST_API_PROFILES['free']['AUDIO_API_KEY'] (config/api_profiles.py @ b4821ecb).
FREE_AUDIO_API_KEY = "free-access"
# Upstream DEFAULT_NEW_CHARACTER_FREE_VOICE_ID (utils/api_config_loader.py @ b4821ecb), "cuteGirl".
FREE_DEFAULT_VOICE_ID = "voice-tone-PGLiyZt65w"

TONE_OPTION_KEYS = ("ms_per_char", "min_ms", "first_audio_delay_ms", "chunk_ms", "speed")


@dataclass(frozen=True)
class ProviderInfo:
    key: str
    verified: bool
    network: bool
    default_voice_id: str = ""


PROVIDERS: dict[str, ProviderInfo] = {
    "dummy": ProviderInfo("dummy", verified=True, network=False),
    "tone": ProviderInfo("tone", verified=True, network=False),
    "free": ProviderInfo("free", verified=True, network=True, default_voice_id=FREE_DEFAULT_VOICE_ID),
    "step": ProviderInfo("step", verified=False, network=True),
}


class ProviderError(Exception):
    pass


def _configured_api_key(provider_key: str) -> str:
    env_key = os.getenv(f"NEKO_TTS_{provider_key.upper()}_API_KEY", "").strip()
    if env_key:
        return env_key
    path = os.getenv("NEKO_TTS_CONFIG", "").strip()
    if not path:
        return ""
    try:
        with open(path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        return ""
    entry = cfg.get(provider_key) if isinstance(cfg, dict) else None
    return str((entry or {}).get("api_key") or "").strip()


def resolve_worker(provider_key: str, options: dict[str, Any] | None = None) -> tuple[Callable[..., Any], str]:
    """Return (worker, api_key) for a provider, or raise ProviderError."""
    options = options or {}
    if provider_key == "dummy":
        from main_logic.tts_client.workers.dummy import dummy_tts_worker

        return dummy_tts_worker, ""
    if provider_key == "tone":
        from local_workers import tone_tts_worker

        kwargs = {}
        for k in TONE_OPTION_KEYS:
            if k in options:
                try:
                    kwargs[k] = float(options[k]) if k == "speed" else int(options[k])
                except (TypeError, ValueError):
                    raise ProviderError(f"invalid tone option {k}")
        return partial(tone_tts_worker, **kwargs), ""
    if provider_key == "free":
        from main_logic.tts_client.workers.free import free_realtime_tts_worker

        return free_realtime_tts_worker, FREE_AUDIO_API_KEY
    if provider_key == "step":
        api_key = _configured_api_key("step")
        if not api_key:
            raise ProviderError("step: API key not configured (NEKO_TTS_CONFIG or NEKO_TTS_STEP_API_KEY)")
        from main_logic.tts_client.workers._step_protocol import run_step_protocol_tts_worker

        return partial(run_step_protocol_tts_worker, provider_key="step"), api_key
    raise ProviderError(f"unknown provider: {provider_key}")
