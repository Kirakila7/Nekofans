"""Launch the standalone memory service without the desktop telemetry subsystem."""
import contextvars
import contextlib
import os
import runpy
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LIBS = Path(os.environ.get("NEKO_WORKBENCH_MEMORY_PYTHON_LIBS", ROOT / "memory-python-libs"))
if LIBS.is_dir():
    for item in (LIBS, LIBS / "win32", LIBS / "win32" / "lib"):
        sys.path.insert(0, str(item))
    if hasattr(os, "add_dll_directory") and (LIBS / "pywin32_system32").is_dir():
        _dll_directory = os.add_dll_directory(str(LIBS / "pywin32_system32"))
# The standalone service has no product usage-reporting UI. Preserve the LLM
# call-type context used by memory processing without installing network hooks.
tracker = types.ModuleType("utils.token_tracker")
tracker.__path__ = [str(ROOT / "vendor" / "utils" / "token_tracker")]
tracker._current_call_type = contextvars.ContextVar("_llm_call_type", default="unknown")
tracker._DO_NOT_TRACK = True

def set_call_type(value):
    tracker._current_call_type.set(value)

@contextlib.contextmanager
def llm_call_context(value):
    token = tracker._current_call_type.set(value)
    try:
        yield
    finally:
        tracker._current_call_type.reset(token)

class _NoTelemetryTracker:
    @classmethod
    def get_instance(cls):
        return cls()
    def start_periodic_save(self):
        pass
    def record_app_start(self, **_kwargs):
        pass
    def record(self, *_args, **_kwargs):
        pass
    def save(self):
        pass

tracker.set_call_type = set_call_type
tracker.llm_call_context = llm_call_context
tracker.TokenTracker = _NoTelemetryTracker
tracker.install_hooks = lambda: None
tracker.record_anthropic_usage = lambda *_args, **_kwargs: None
sys.modules[tracker.__name__] = tracker

runpy.run_path(str(ROOT / "workbench_server.py"), run_name="__main__")
