"""Subset of upstream utils/language_utils.py used by the vendored TTS workers.

detect_tts_language_hint, TTS_LANG_DETECT_MIN_CHARS and TTS_LANGUAGE_CODE_MAP
are copied from upstream b4821ecb (lines ~1320-1370). get_tts_language_code is
fixed to the zh-CN mapping because the sidecar has no global language config.
"""

import re
from typing import Optional

_TTS_KANA_RE = re.compile(r'[぀-ゟ゠-ヿ]')
TTS_LANG_DETECT_MIN_CHARS = 6

TTS_LANGUAGE_CODE_MAP = {
    'zh': 'cmn-CN',
    'zh-CN': 'cmn-CN',
    'zh-TW': 'cmn-tw',
    'en': 'en-US',
    'ja': 'ja-JP',
    'ko': 'ko-KR',
}


def detect_tts_language_hint(text: str) -> Optional[str]:
    if text and _TTS_KANA_RE.search(text):
        return 'ja'
    return None


def get_tts_language_code() -> str:
    return TTS_LANGUAGE_CODE_MAP['zh-CN']
