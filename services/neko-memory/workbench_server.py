"""Private, parent-owned N.E.K.O. memory process for the DSH workbench.

Run with ``uv run python workbench_server.py``. The first stdin line is a JSON
configuration; credentials stay in memory and are never copied to argv, the
environment, a log, or a configuration file. Non-secret profile paths and the
character card are persisted in the isolated application root.
Keep stdin open for the process lifetime. EOF or {"type":"shutdown"} requests
a graceful exit. The sole stdout message is NEKO_MEMORY_READY plus JSON.
"""
from __future__ import annotations

import asyncio
from copy import deepcopy
import hmac
import json
import logging
import os
from pathlib import Path
import re
import socket
import sys
import threading
from types import SimpleNamespace
from urllib.parse import urlsplit
from uuid import NAMESPACE_URL, uuid5


PERSONA_ID = "bigfish"
CHARACTER_NAME = "大肥鱼"
CHARACTER_ID = "character_" + uuid5(NAMESPACE_URL, "neko-workbench:bigfish").hex
CONFIG_LIMIT = 1024 * 1024


class StartupError(Exception):
    """Intentionally carries no input or upstream exception text."""


def validate_config(value: object) -> dict:
    if not isinstance(value, dict):
        raise StartupError()
    config = deepcopy(value)
    for field in ("dataRoot", "instanceId", "token"):
        if not isinstance(config.get(field), str) or not config[field].strip():
            raise StartupError()
    if not Path(config["dataRoot"]).is_absolute():
        raise StartupError()
    if not re.fullmatch(r"[a-zA-Z0-9_-]{16,128}", config["instanceId"]):
        raise StartupError()
    if not re.fullmatch(r"[a-zA-Z0-9_-]{32,256}", config["token"]):
        raise StartupError()
    if config.get("port", 0) != 0:
        raise StartupError()
    persona = config.get("persona")
    if not isinstance(persona, dict) or persona.get("id") != PERSONA_ID or persona.get("name") != CHARACTER_NAME:
        raise StartupError()
    if not isinstance(persona.get("prompt"), str) or not persona["prompt"].strip() or len(persona["prompt"]) > 200_000:
        raise StartupError()
    model = config.get("model")
    if not isinstance(model, dict) or model.get("protocol") not in {"openai-compatible", "openai_compatible", "anthropic"}:
        raise StartupError()
    for field in ("baseUrl", "model"):
        if not isinstance(model.get(field), str) or not model[field].strip():
            raise StartupError()
    if not isinstance(model.get("apiKey", ""), str):
        raise StartupError()
    url = urlsplit(model["baseUrl"])
    if (url.scheme not in {"http", "https"} or not url.hostname or url.username
            or url.password or url.query or url.fragment):
        raise StartupError()
    if url.scheme=="http" and url.hostname not in {"127.0.0.1","localhost","::1"}:
        raise StartupError()
    try:
        url.port
    except ValueError:
        raise StartupError() from None
    timeout_ms = model.get("requestTimeoutMs", 90_000)
    if isinstance(timeout_ms, bool) or not isinstance(timeout_ms, (int, float)) or not 1000 <= timeout_ms <= 600_000:
        raise StartupError()
    model["requestTimeoutMs"] = timeout_ms
    model["apiKey"] = model.get("apiKey", "")
    return config


def _atomic_json(path: Path, value: object) -> None:
    temporary = path.with_name(path.name + ".workbench-tmp")
    with temporary.open("w",encoding="utf-8") as output:
        output.write(json.dumps(value,ensure_ascii=False,indent=2))
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)


def _seed_character(app_root: Path, persona: dict) -> None:
    """An isolated service may never adopt a different character's memory."""
    config_dir = app_root / "config"
    config_dir.mkdir(parents=True, exist_ok=True)
    path = config_dir / "characters.json"
    if path.exists():
        try:
            characters = json.loads(path.read_text(encoding="utf-8"))
            cats = characters["猫娘"]
            if not isinstance(cats, dict) or set(cats) != {CHARACTER_NAME}:
                raise StartupError()
            reserved = cats[CHARACTER_NAME].get("_reserved", {})
            if reserved.get("character_id") != CHARACTER_ID:
                raise StartupError()
            if characters.get("当前猫娘") != CHARACTER_NAME:
                raise StartupError()
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            raise StartupError() from None
        # The workbench owns this card. Retain all learned memory and stable IDs,
        # while allowing the user's current character prompt to take effect.
        cats[CHARACTER_NAME]["_reserved"]["system_prompt"] = persona["prompt"]
    else:
        memory_dir = app_root / "memory"
        if memory_dir.exists() and any(memory_dir.iterdir()):
            raise StartupError()
        characters = {
            "主人": {"档案名": "用户", "昵称": "人"},
            "猫娘": {
                CHARACTER_NAME: {
                    "昵称": CHARACTER_NAME,
                    "自称": "大肥鱼",
                    "核心特质": [],
                    "行为特点": [],
                    "_reserved": {
                        "character_id": CHARACTER_ID,
                        "system_prompt": persona["prompt"],
                        "ai_context": {},
                    },
                },
            },
            "当前猫娘": CHARACTER_NAME,
        }
    _atomic_json(path, characters)
    # The model/credential triple deliberately is not persisted in this file.
    # Keep the upstream full-memory mode; the gateway supplies per-turn work.
    core_path = config_dir / "core_config.json"
    if not core_path.exists():
        _atomic_json(core_path, {"powerful_memory_enabled": True})


def _install_environment(data_root: Path, app_root: Path, instance_id: str, port: int) -> None:
    # Do not inherit a native NEKO instance, its storage, debug prompt audit, or
    # launcher test controls from the Electron parent's environment.
    for key in list(os.environ):
        if key.startswith("NEKO_") or key == "_NEKO_MAIN_SERVER_INITIALIZED":
            os.environ.pop(key, None)
    roaming = data_root / "Roaming"
    roaming.mkdir(parents=True, exist_ok=True)
    os.environ.update({
        "NEKO_STORAGE_SELECTED_ROOT": str(app_root),
        "NEKO_STORAGE_ANCHOR_ROOT": str(app_root),
        "NEKO_INSTANCE_ID": instance_id,
        "NEKO_MEMORY_SERVER_PORT": str(port),
        "NEKO_MAIN_SERVER_PORT": "59011",
        "NEKO_TOOL_SERVER_PORT": "59012",
        "NEKO_MONITOR_SERVER_PORT": "59013",
        "NEKO_COMMENTER_SERVER_PORT": "59014",
        "NEKO_USER_PLUGIN_SERVER_PORT": "59016",
        "NEKO_CLOUDSAVE_DISABLED": "workbench",
        "NEKO_LLM_PROMPT_AUDIT": "0",
        "_NEKO_MAIN_SERVER_INITIALIZED": "1",
        "APPDATA": str(roaming),
        "LOCALAPPDATA": str(data_root),
    })


def _install_vendor_configuration(data_root: Path, app_root: Path, model: dict) -> None:
    """Install process-local adapters before importing any memory component."""
    import utils.logger_config as logger_config

    # setup_logging constructs rotating files even with logging.disable().
    # Replace the setup hook before memory imports can construct those files.
    quiet_logger = logging.getLogger("neko.workbench.memory")
    quiet_logger.addHandler(logging.NullHandler())
    quiet_logger.propagate = False
    logger_config.setup_logging = lambda *args, **kwargs: (
        quiet_logger, SimpleNamespace(app_name="N.E.K.O", service_name="Memory"),
    )

    from utils.config_manager import ConfigManager, get_config_manager

    ConfigManager._get_documents_directory = lambda self: data_root
    ConfigManager._get_standard_data_directory_candidates = lambda self: [data_root]
    ConfigManager._get_legacy_storage_candidates = lambda self: []
    ConfigManager._get_legacy_document_candidates = lambda self: []
    ConfigManager.get_legacy_app_root_candidates = lambda self: []
    # Default-template migration must not inspect another checkout's user data.
    ConfigManager._get_project_memory_directory = lambda self: data_root / ".empty-source" / "memory"

    base_url=model["baseUrl"].rstrip("/")
    if model["protocol"]=="anthropic" and base_url.endswith("/v1"):
        base_url=base_url[:-3]  # The native Anthropic client appends /v1/messages.
    api = {
        "model": model["model"],
        "base_url": base_url,
        "api_key": model["apiKey"],
        "provider_type": "anthropic" if model["protocol"] == "anthropic" else "openai_compatible",
        "is_custom": True,
    }

    def get_model_api_config(self, model_type, *, _core_config=None):
        return dict(api)

    async def aget_model_api_config(self, model_type, *, core_config=None):
        return dict(api)

    async def awarmup_region_check(self, *args, **kwargs):
        return True

    ConfigManager.get_model_api_config = get_model_api_config
    ConfigManager.aget_model_api_config = aget_model_api_config
    ConfigManager.awarmup_region_check = awarmup_region_check
    # This worker has an explicit endpoint and never needs GeoIP or free-model
    # resolution, including an indirect config read while rendering a persona.
    ConfigManager._ensure_ip_probe_started = lambda *args, **kwargs: None

    from utils.storage.policy import save_storage_policy
    cm = get_config_manager()
    if Path(cm.app_docs_dir).resolve() != app_root or Path(cm.anchor_root).resolve() != app_root:
        raise StartupError()
    save_storage_policy(cm, selected_root=app_root, anchor_root=app_root, selection_source="default")

    # Retain the real provider implementations; cap every memory LLM request by
    # the workbench timeout even when upstream selects a larger per-tier limit.
    import utils.llm_client as client
    import utils.llm_client.factory as factory
    sync_factory = factory.create_chat_llm
    async_factory = factory.create_chat_llm_async
    timeout_seconds = model["requestTimeoutMs"] / 1000

    def options(kwargs):
        kwargs = dict(kwargs)
        supplied = kwargs.get("timeout")
        kwargs["timeout"] = min(supplied, timeout_seconds) if isinstance(supplied, (int, float)) else timeout_seconds
        kwargs["provider_type"] = api["provider_type"]
        return kwargs

    def configured_sync(*args, **kwargs):
        return sync_factory(*args, **options(kwargs))

    async def configured_async(*args, **kwargs):
        return await async_factory(*args, **options(kwargs))

    for module in (client, factory):
        module.create_chat_llm = configured_sync
        module.create_chat_llm_async = configured_async

    from utils import llm_prompt_audit
    llm_prompt_audit.is_enabled = lambda: False
    llm_prompt_audit.record_llm_request = lambda *args, **kwargs: None


def _disable_native_sync() -> None:
    from services.chat_sync import recent_wake

    async def no_sync():
        return None

    recent_wake.forward_recent_memory_changes = no_sync
    from app.memory_server import long_term_sync
    # No writer authority means both capture and replay are inert. Keep native
    # memory evidence/reconciliation and all other background tasks intact.
    long_term_sync._authority = lambda: None


class PrivateMemoryAccess:
    """Outer ASGI boundary; native endpoints and browser requests stay private."""

    def __init__(self, app, token: str):
        self.app = app
        self.authorization = ("Bearer " + token).encode("ascii")

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            await self.app(scope, receive, send)
            return
        if scope["type"] != "http":
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 1008})
            return
        headers = scope.get("headers", [])
        authorizations = [value for key, value in headers if key.lower() == b"authorization"]
        # Node's Undici also sends Sec-Fetch-Mode. Origin is the browser boundary;
        # a bearer token known only to the parent remains mandatory for every read.
        browser_request = any(key.lower() == b"origin" for key, _ in headers)
        authorized = len(authorizations) == 1 and hmac.compare_digest(authorizations[0], self.authorization)
        allowed_path = scope.get("path", "").startswith("/workbench-memory/")
        if not allowed_path or not authorized or browser_request:
            status = 404 if not allowed_path else 403 if browser_request else 401
            await send({"type": "http.response.start", "status": status, "headers": [(b"content-type", b"application/json"), (b"cache-control", b"no-store")]})
            await send({"type": "http.response.body", "body": b'{"error":"memory_access_denied"}'})
            return
        await self.app(scope, receive, send)


def _watch_parent(descriptor, shutdown: threading.Event) -> None:
    try:
        pending=b""
        peek=None
        if os.name=="nt":
            import ctypes
            import msvcrt
            from ctypes import wintypes
            handle=msvcrt.get_osfhandle(descriptor)
            peek=ctypes.windll.kernel32.PeekNamedPipe
            peek.argtypes=[wintypes.HANDLE,wintypes.LPVOID,wintypes.DWORD,wintypes.LPVOID,ctypes.POINTER(wintypes.DWORD),wintypes.LPVOID]
            peek.restype=wintypes.BOOL
        while True:
            available=4096
            if peek is not None:
                count=wintypes.DWORD()
                if not peek(handle,None,0,None,ctypes.byref(count),None):return
                if not count.value:
                    if shutdown.wait(0.05):return
                    continue
                available=min(count.value,4096)
            chunk=os.read(descriptor,available)
            if not chunk:
                break
            pending+=chunk
            if len(pending)>4096:
                return
            while b"\n" in pending:
                line,pending=pending.split(b"\n",1)
                try:command=json.loads(line)
                except (ValueError,UnicodeError):return
                if isinstance(command,dict) and command.get("type")=="shutdown":return
    finally:
        shutdown.set()


async def serve(config: dict, shutdown: threading.Event, protocol_output) -> None:
    data_root = Path(config["dataRoot"]).resolve()
    data_root.mkdir(parents=True, exist_ok=True)
    app_root = (data_root / "N.E.K.O").resolve()
    if app_root.parent != data_root:
        raise StartupError()
    app_root.mkdir(parents=True, exist_ok=True)
    from filelock import FileLock
    lock = FileLock(str(data_root / ".workbench-memory.lock"), timeout=0)
    with lock:
        _seed_character(app_root, config["persona"])
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            listener.bind(("127.0.0.1", 0))
            listener.set_inheritable(False)
            port = listener.getsockname()[1]
            _install_environment(data_root, app_root, config["instanceId"], port)
            vendor = Path(__file__).resolve().parent / "vendor"
            if not (vendor / "app" / "memory_server" / "runtime.py").is_file():
                raise StartupError()
            sys.path.insert(0, str(vendor))
            _install_vendor_configuration(data_root, app_root, config["model"])
            from app.memory_server import runtime
            _disable_native_sync()
            runtime.enable_shutdown = False
            runtime.app.state.workbench_instance_id = config["instanceId"]
            runtime.app.state.workbench_persona_id = PERSONA_ID
            runtime.app.state.workbench_character_name = CHARACTER_NAME
            from workbench_gateway import install_gateway
            install_gateway(runtime.app, runtime, state_dir=data_root, persona_id=PERSONA_ID, character_name=CHARACTER_NAME)
            import uvicorn
            server = uvicorn.Server(uvicorn.Config(
                PrivateMemoryAccess(runtime.app, config["token"]),
                host="127.0.0.1", port=port, log_config=None,
                access_log=False, lifespan="on", timeout_graceful_shutdown=10,
            ))
            ready_sent = False

            async def supervise():
                nonlocal ready_sent
                while True:
                    if shutdown.is_set():
                        server.should_exit = True
                        return
                    if server.started and not ready_sent:
                        if not runtime._memory_runtime_init_completed:
                            server.should_exit = True
                            raise StartupError()
                        if any(getattr(runtime, name, None) is None for name in (
                            "recent_history_manager", "time_manager", "fact_store", "persona_manager", "reflection_engine",
                        )):
                            server.should_exit = True
                            raise StartupError()
                        protocol_output.write("NEKO_MEMORY_READY " + json.dumps({"port": port, "instanceId": config["instanceId"]}, separators=(",", ":")) + "\n")
                        protocol_output.flush()
                        ready_sent = True
                    await asyncio.sleep(0.05)

            supervisor = asyncio.create_task(supervise())
            try:
                await server.serve(sockets=[listener])
                if supervisor.done():
                    supervisor.result()
                if not ready_sent and not shutdown.is_set():
                    raise StartupError()
            finally:
                supervisor.cancel()
                await asyncio.gather(supervisor, return_exceptions=True)
                from utils.internal_http_client import aclose_internal_http_client
                await aclose_internal_http_client()
        finally:
            listener.close()


def main() -> int:
    # Capture the protocol channel before redirecting both ordinary and native
    # writes. This also catches vendor sys.__stdout__, C libraries and tracebacks.
    protocol_output = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
    error_output = os.fdopen(os.dup(sys.stderr.fileno()), "w", encoding="utf-8", buffering=1)
    with open(os.devnull, "w") as sink:
        os.dup2(sink.fileno(), sys.stdout.fileno())
        os.dup2(sink.fileno(), sys.stderr.fileno())
        logging.disable(logging.CRITICAL)
        try:
            # A blocking buffered stdin reader holds a CRT stream lock on Windows.
            # Native NumPy/OpenBLAS initialization flushes CRT streams and can then
            # deadlock. Use descriptor I/O for both the boot record and EOF watcher.
            line=bytearray()
            while len(line)<=CONFIG_LIMIT:
                byte=os.read(sys.stdin.fileno(),1)
                if not byte or byte==b"\n":break
                line.extend(byte)
            if not line or len(line) > CONFIG_LIMIT:
                raise StartupError()
            config = validate_config(json.loads(line))
            del line
            shutdown = threading.Event()
            threading.Thread(target=_watch_parent, args=(sys.stdin.fileno(), shutdown), daemon=True, name="workbench-memory-parent").start()
            asyncio.run(serve(config, shutdown, protocol_output))
            return 0
        except (Exception, KeyboardInterrupt):
            error_output.write("NEKO_MEMORY_START_FAILED\n")
            error_output.flush()
            return 1
        finally:
            protocol_output.close()
            error_output.close()


if __name__ == "__main__":
    raise SystemExit(main())
