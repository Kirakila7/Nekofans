"""Windows portable worker entry; keep the existing workbench's local runtime."""
import contextlib
import contextvars
import os
import runpy
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LIBS = Path(os.environ["NEKO_WORKBENCH_MEMORY_PYTHON_LIBS"])
if not LIBS.is_dir():
    raise RuntimeError("The configured workbench Python dependencies are missing")
for directory in (LIBS, LIBS / "win32", LIBS / "win32" / "lib"):
    sys.path.insert(0, str(directory))
if hasattr(os, "add_dll_directory") and (LIBS / "pywin32_system32").is_dir():
    _dll_directory = os.add_dll_directory(str(LIBS / "pywin32_system32"))

# Preserve the standalone worker's existing no-telemetry context shim.
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
