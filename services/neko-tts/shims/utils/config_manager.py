"""Minimal stand-in for upstream utils.config_manager (not vendored).

Only the members the vendored TTS workers touch are provided. The sidecar runs
on Windows in mainland-China mode, so the free-service URL is never rewritten
to lanlan.app.
"""


def _as_bool(value, default=False):
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off", ""}:
        return False
    return default


class _SidecarConfigManager:
    def _adjust_free_api_url(self, url: str, _is_tts: bool = True) -> str:
        return url


_INSTANCE = _SidecarConfigManager()


def get_config_manager() -> _SidecarConfigManager:
    return _INSTANCE
