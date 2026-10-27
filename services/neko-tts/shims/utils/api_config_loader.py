"""Subset of upstream utils/api_config_loader.py used by the vendored TTS modules.

Reads the vendored config/api_providers.json. The native-voice resolution
(including "inherits") mirrors upstream b4821ecb; livestream mode is always off.
"""

import json
from copy import deepcopy
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, Optional

_PROVIDERS_JSON = Path(__file__).resolve().parents[2] / "vendor" / "config" / "api_providers.json"


@lru_cache(maxsize=1)
def get_config() -> Dict[str, Any]:
    with open(_PROVIDERS_JSON, "r", encoding="utf-8") as f:
        return json.load(f)


def get_free_voices() -> Dict[str, str]:
    return get_config().get("free_voices", {})


def get_livestream_config() -> Dict[str, Any]:
    return {"enabled": False, "server_prefix": "", "voice_id": ""}


def is_livestream_active() -> bool:
    return False


def _normalize_str_dict(raw: Any) -> Dict[str, str]:
    if not isinstance(raw, dict):
        return {}
    result: Dict[str, str] = {}
    for key, value in raw.items():
        normalized_key = str(key or "").strip()
        if normalized_key:
            result[normalized_key] = str(value or "").strip()
    return result


def _resolve(provider_key: str, raw_configs: Dict[str, Any], resolving: Optional[set] = None) -> Dict[str, Any]:
    key = str(provider_key or "").strip()
    raw = raw_configs.get(key) if key else None
    if not isinstance(raw, dict):
        return {}
    resolving = set(resolving or set())
    if key in resolving:
        return {}
    resolving.add(key)
    inherit_key = str(raw.get("inherits") or "").strip()
    merged = deepcopy(_resolve(inherit_key, raw_configs, resolving)) if inherit_key else {}
    for field, value in raw.items():
        if field == "inherits":
            continue
        if field in ("voices", "aliases") and isinstance(value, dict) and isinstance(merged.get(field), dict):
            merged[field] = {**merged[field], **deepcopy(value)}
        else:
            merged[field] = deepcopy(value)
    return merged


def get_native_tts_voice_provider_config(provider_key: str) -> Dict[str, Any]:
    raw_configs = get_config().get("native_tts_voice_providers", {})
    if not isinstance(raw_configs, dict):
        return {}
    resolved = _resolve(provider_key, raw_configs)
    if not resolved:
        return {}
    voices = _normalize_str_dict(resolved.get("voices"))
    aliases = _normalize_str_dict(resolved.get("aliases"))
    default_voice = str(resolved.get("default_voice") or "").strip()
    default_male_voice = str(resolved.get("default_male_voice") or "").strip()
    if not default_voice and voices:
        default_voice = next(iter(voices))
    if not default_male_voice:
        default_male_voice = default_voice
    return {
        "key": str(provider_key or "").strip(),
        "catalog_prefix": str(resolved.get("catalog_prefix") or provider_key or "").strip(),
        "default_voice": default_voice,
        "default_male_voice": default_male_voice,
        "catalog_value_is_display_name": bool(resolved.get("catalog_value_is_display_name", False)),
        "voices": voices,
        "aliases": aliases,
    }
