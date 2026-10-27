"""F05 launcher: run N.E.K.O memory-server standalone, with rename route.

Based on F03 adapter pattern. Adds rename orchestration route at POST /rename.

Usage:
    .venv/Scripts/python.exe launcher.py --enable-shutdown

Memory LLM is the offline stub by default. Set NEKO_MEMORY_LLM=free to use the
upstream N.E.K.O free text service (lanlan.tech free-model) instead.
"""
# No `from __future__ import annotations`: FastAPI must resolve the request models
# declared inside add_routes() at decoration time, which postponed annotations break.
import asyncio
import json
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
DATA_PARENT = Path(os.environ.get("NEKO_DATA_ROOT", str(SCRIPT_DIR / "data_test"))).resolve()
APP_ROOT = DATA_PARENT / "N.E.K.O"
LLM_LOG = DATA_PARENT / "fake_llm_calls.ndjson"


def _install_storage_isolation() -> None:
    APP_ROOT.mkdir(parents=True, exist_ok=True)
    os.environ["NEKO_STORAGE_SELECTED_ROOT"] = str(APP_ROOT)
    os.environ["NEKO_STORAGE_ANCHOR_ROOT"] = str(APP_ROOT)

    from utils.config_manager import ConfigManager

    ConfigManager._get_standard_data_directory_candidates = lambda self: [DATA_PARENT]
    ConfigManager._get_legacy_storage_candidates = lambda self: []
    ConfigManager._get_legacy_document_candidates = lambda self: []
    ConfigManager.get_legacy_app_root_candidates = lambda self: []

    import utils.logger_config as lc

    lc.RobustLoggerConfig._get_documents_directory = lambda self: DATA_PARENT


FAKE_FACT_TEXT = "（离线桩）主人在测试桌宠框架的记忆模块"


def _fake_answer(call_type: str | None, prompt_text: str) -> str:
    if call_type == "memory_compression":
        return json.dumps({"summary": "（离线桩）本段对话摘要：主人与角色进行了简短交流。"}, ensure_ascii=False)
    if call_type == "memory_review":
        return json.dumps({"explanation": "（离线桩）无需修改", "corrected_dialogue": []}, ensure_ascii=False)
    if call_type in ("memory_fact_extraction", "memory_fact_extraction_ai_aware"):
        return json.dumps([{"text": FAKE_FACT_TEXT, "importance": 6, "entity": "master"}], ensure_ascii=False)
    if call_type == "memory_signal_detection":
        return json.dumps({"signals": []})
    if call_type == "memory_recall_rerank":
        return json.dumps([])
    return json.dumps({})


def _prompt_to_text(prompt: Any) -> str:
    if isinstance(prompt, str):
        return prompt
    if isinstance(prompt, list):
        parts = []
        for m in prompt:
            c = getattr(m, "content", None)
            if c is None and isinstance(m, dict):
                c = m.get("content")
            parts.append(c if isinstance(c, str) else json.dumps(c, ensure_ascii=False, default=str))
        return "\n".join(parts)
    return str(prompt)


class _FakeResponse:
    def __init__(self, content: str) -> None:
        self.content = content
        self.response_metadata = {
            "finish_reason": "stop",
            "token_usage": {"completion_tokens": 8, "prompt_tokens": 0},
        }
        self.usage_metadata = {"input_tokens": 0, "output_tokens": 8}
        self.additional_kwargs: dict = {}
        self.metadata: dict = {}
        self.type = "ai"


class _FakeChatLLM:
    def __init__(self, model: str) -> None:
        self.model = model

    async def ainvoke(self, prompt: Any, *args: Any, **kwargs: Any):
        text = _prompt_to_text(prompt)
        try:
            from utils.token_tracker.call_context import _current_call_type
            call_type = _current_call_type.get()
        except Exception:
            call_type = None
        answer = _fake_answer(call_type, text)
        rec = {
            "ts": time.time(),
            "model": self.model,
            "call_type": call_type,
            "prompt_head": text[:160],
            "answer_head": answer[:80],
        }
        with LLM_LOG.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        return _FakeResponse(answer)

    async def astream(self, prompt: Any, *args: Any, **kwargs: Any):
        yield await self.ainvoke(prompt)

    async def aclose(self) -> None:
        return None

    def close(self) -> None:
        return None


async def _fake_create_chat_llm_async(model: str = "fake", *args: Any, **kwargs: Any):
    return _FakeChatLLM(model)


def _fake_create_chat_llm(model: str = "fake", *args: Any, **kwargs: Any):
    return _FakeChatLLM(model)


# NEKO_MEMORY_LLM selects the memory LLM: "stub" (default, offline) or "free"
# (upstream N.E.K.O free text service, lanlan.tech free-model).
LLM_MODE = os.environ.get("NEKO_MEMORY_LLM", "stub").strip().lower()


def _seed_free_llm_config() -> None:
    """Point upstream core/assist providers at the free profile, keeping other keys."""
    from utils.config_manager import get_config_manager

    path = Path(get_config_manager().get_config_path("core_config.json"))
    data: dict = {}
    if path.exists():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                data = loaded
        except json.JSONDecodeError:
            pass
    data["coreApi"] = "free"
    data["assistApi"] = "free"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[launcher] memory LLM: upstream free profile ({path})", flush=True)


def _install_model_stub() -> None:
    import utils.llm_client as pkg
    import utils.llm_client.factory as factory

    for mod in (pkg, factory):
        mod.create_chat_llm_async = _fake_create_chat_llm_async
        mod.create_chat_llm = _fake_create_chat_llm


def _seed_storage_policy() -> None:
    from utils.config_manager import get_config_manager
    from utils.storage.policy import save_storage_policy, should_require_storage_selection

    cm = get_config_manager()
    root = Path(cm.app_docs_dir).resolve()
    if not root.is_relative_to(DATA_PARENT):
        raise SystemExit(f"[launcher] runtime root escaped sandbox: {root} (expected under {DATA_PARENT})")
    if should_require_storage_selection(cm):
        save_storage_policy(cm, selected_root=root, selection_source="default")
        print(f"[launcher] seeded storage_policy (selected_root={root})", flush=True)

    characters_path = Path(cm.app_docs_dir) / "config" / "characters.json"
    if not characters_path.exists():
        characters_path.parent.mkdir(parents=True, exist_ok=True)
        characters = {
            "主人": {"档案名": "碳基生物", "性别": "男", "昵称": "人类"},
            "猫娘": {
                "YUI": {
                    "昵称": "YUI",
                    "性别": "女",
                    "年龄": "15",
                    "种族": "猫娘",
                    "自称": "本喵",
                    "核心特质": ["理智可靠", "内心温柔"],
                    "行为特点": ["喜欢待在碳基生物身边"],
                    "一句话台词": "哼，当然只有本喵啦~",
                    "_reserved": {
                        "character_id": "character_0f05a000000000000000000000009999",
                        "ai_context": {},
                    },
                }
            },
            "当前猫娘": "YUI"
        }
        characters_path.write_text(json.dumps(characters, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[launcher] seeded characters.json with YUI", flush=True)


SANDBOX_PORT = "59005"
SANDBOX_SIBLING_PORTS = {
    "NEKO_MAIN_SERVER_PORT": "59011",
    "NEKO_MONITOR_SERVER_PORT": "59013",
    "NEKO_COMMENTER_SERVER_PORT": "59014",
    "NEKO_TOOL_SERVER_PORT": "59012",
    "NEKO_USER_PLUGIN_SERVER_PORT": "59016",
}


def install() -> None:
    vendor_path = str(SCRIPT_DIR / "vendor")
    if sys.path[0:1] != [vendor_path]:
        sys.path.insert(0, vendor_path)

    os.environ.setdefault("NEKO_MEMORY_SERVER_PORT", SANDBOX_PORT)
    for key, value in SANDBOX_SIBLING_PORTS.items():
        os.environ.setdefault(key, value)

    (DATA_PARENT / "Roaming").mkdir(parents=True, exist_ok=True)
    os.environ["APPDATA"] = str(DATA_PARENT / "Roaming")
    os.environ["LOCALAPPDATA"] = str(DATA_PARENT)

    _install_storage_isolation()
    if LLM_MODE == "free":
        _seed_free_llm_config()
    elif LLM_MODE == "stub":
        _install_model_stub()
    else:
        raise SystemExit(f"[launcher] unknown NEKO_MEMORY_LLM={LLM_MODE!r} (expected stub or free)")
    _seed_storage_policy()

    import config as neko_config

    ports = {
        name: int(getattr(neko_config, name))
        for name in ("MAIN_SERVER_PORT", "MEMORY_SERVER_PORT", "MONITOR_SERVER_PORT",
                     "COMMENTER_SERVER_PORT", "TOOL_SERVER_PORT", "USER_PLUGIN_SERVER_PORT")
        if hasattr(neko_config, name)
    }
    clash = {k: v for k, v in ports.items() if 48911 <= v <= 48916}
    if clash:
        raise SystemExit(f"[launcher] refusing default N.E.K.O ports {clash}")
    print(f"[launcher] ports={ports}", flush=True)
    print(f"[launcher] storage root={APP_ROOT}", flush=True)
    if LLM_MODE == "stub":
        print(f"[launcher] model layer=fake (log {LLM_LOG})", flush=True)
    else:
        print("[launcher] model layer=upstream free-model (lanlan.tech)", flush=True)


def add_routes(runtime_app) -> None:
    from fastapi import HTTPException
    from pydantic import BaseModel
    import shutil
    import tempfile

    class RegisterRequest(BaseModel):
        character_id: str
        name: str

    @runtime_app.post("/register")
    async def register_character(req: RegisterRequest):
        from app.memory_server._shared import validate_lanlan_name
        from utils.config_manager import get_config_manager
        from utils.config_manager.reserved_schema import (
            get_reserved,
            set_reserved,
        )

        name = req.name.strip()
        if not name:
            return {"success": False, "message": "name required"}
        try:
            validate_lanlan_name(name)
        except Exception as e:
            return {"success": False, "message": f"validate failed: {e}"}

        cm = get_config_manager()
        chars = await asyncio.to_thread(cm.load_characters)
        if name in chars.get("猫娘", {}):
            return {"success": False, "message": f"{name} already exists"}

        chars["猫娘"][name] = {
            "昵称": name,
            "性别": "女",
            "年龄": "15",
            "种族": "猫娘",
            "自称": "本喵",
            "核心特质": ["理智可靠", "内心温柔"],
            "行为特点": [f"喜欢待在主人身边"],
            "一句话台词": f"当然只有本喵啦~",
            "_reserved": {
                "character_id": req.character_id,
                "ai_context": {},
            }
        }
        await asyncio.to_thread(cm.save_characters, chars)
        print(f"[register] created {name} with character_id={req.character_id}", flush=True)
        return {"success": True, "message": "registered"}

    class RenameRequest(BaseModel):
        character_id: str
        old_name: str
        new_name: str

    @runtime_app.post("/rename")
    async def rename_character_orchestration(req: RenameRequest):
        print(f"[rename] received: {req.dict()}", flush=True)
        from app.memory_server._shared import validate_lanlan_name
        from utils.config_manager import get_config_manager
        from utils.config_manager.reserved_schema import get_reserved
        from utils.character_memory import (
            begin_character_recent_transaction,
            rename_character_memory_storage,
            finalize_character_recent_rename,
            rollback_character_recent_rename,
            release_character_recent_transaction,
            list_character_memory_paths,
        )
        from utils.recent_file import capture_recent_generation
        from copy import deepcopy
        import httpx

        old_name = req.old_name.strip()
        new_name = req.new_name.strip()
        if not old_name or not new_name or old_name == new_name:
            return {"success": False, "message": "invalid names"}

        try:
            validate_lanlan_name(old_name)
            validate_lanlan_name(new_name)
        except Exception as e:
            return {"success": False, "message": f"validate failed: {e}"}

        cm = get_config_manager()

        chars = await asyncio.to_thread(cm.load_characters)
        if old_name not in chars.get("猫娘", {}):
            return {"success": False, "message": f"{old_name} not found in characters.json"}

        profile = chars["猫娘"][old_name]
        profile_id = str(get_reserved(profile, "character_id", default="") or "")
        if profile_id != req.character_id:
            return {"success": False, "message": f"character_id mismatch"}

        token = uuid.uuid4().hex
        memory_dir = Path(cm.memory_dir)
        recent_path = memory_dir / old_name / "recent.json"
        generation = 0
        if recent_path.exists():
            _, generation = capture_recent_generation(recent_path)

        print(f"[rename] old={old_name} new={new_name} token={token} gen={generation}", flush=True)

        base_url = f"http://127.0.0.1:{os.environ.get('NEKO_MEMORY_SERVER_PORT', SANDBOX_PORT)}"
        temp_snapshot_dir = None
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(
                    f"{base_url}/release_character/{old_name}",
                    params={
                        "hold_derived_task_admission": "true",
                        "derived_task_claim_token": token,
                        "derived_task_claim_generation": generation,
                    },
                )
                release_data = resp.json()
                print(f"[rename] release_character: {release_data}", flush=True)
                if release_data.get("status") != "success":
                    return {"success": False, "message": f"release failed: {release_data}"}

                tx = None
                result = None
                characters_snapshot = None
                memory_targets = []
                try:
                    tx = await asyncio.to_thread(begin_character_recent_transaction, cm, old_name, new_name)
                    characters_snapshot = deepcopy(chars)

                    memory_targets = list_character_memory_paths(cm, old_name)
                    memory_targets.extend(list_character_memory_paths(cm, new_name))
                    memory_targets.append(memory_dir / new_name)
                    temp_snapshot_dir = tempfile.mkdtemp(prefix="f05-rename-")
                    memory_snapshot_records = []
                    for idx, target_path in enumerate(sorted(memory_targets, key=lambda p: (len(p.parts), str(p)))):
                        normalized = str(target_path)
                        if not target_path.exists():
                            memory_snapshot_records.append({"target": target_path, "backup": None})
                            continue
                        backup_path = Path(temp_snapshot_dir) / f"{idx:02d}" / target_path.name
                        backup_path.parent.mkdir(parents=True, exist_ok=True)
                        if target_path.is_dir():
                            shutil.copytree(target_path, backup_path, dirs_exist_ok=True)
                        else:
                            shutil.copy2(target_path, backup_path)
                        memory_snapshot_records.append({"target": target_path, "backup": backup_path})

                    result = await asyncio.to_thread(
                        rename_character_memory_storage,
                        cm,
                        old_name,
                        new_name,
                        keep_recent_locks=True,
                        recent_transaction=tx,
                    )
                    print(f"[rename] rename_character_memory_storage done", flush=True)

                    chars = await asyncio.to_thread(cm.load_characters)
                    if old_name in chars.get("猫娘", {}):
                        chars["猫娘"][new_name] = chars["猫娘"].pop(old_name)
                        profile = chars["猫娘"][new_name]
                        if "_reserved" not in profile:
                            profile["_reserved"] = {}
                        if "ai_context" not in profile["_reserved"]:
                            profile["_reserved"]["ai_context"] = {}
                        events = profile["_reserved"]["ai_context"].get("rename_events", [])
                        if not isinstance(events, list):
                            events = []
                        events.append({
                            "type": "profile_rename",
                            "old_name": old_name,
                            "new_name": new_name,
                            "timestamp": time.time(),
                        })
                        profile["_reserved"]["ai_context"]["rename_events"] = events[-20:]
                        await asyncio.to_thread(cm.save_characters, chars)
                        print(f"[rename] characters.json updated", flush=True)

                    resp2 = await client.post(
                        f"{base_url}/reload",
                        json={
                            "resume_derived_task_names": [new_name],
                            "resume_derived_task_generations": {new_name: generation},
                        },
                    )
                    reload_data = resp2.json()
                    print(f"[rename] reload: {reload_data}", flush=True)
                    if reload_data.get("status") != "success":
                        raise Exception(f"reload failed: {reload_data}")

                    await asyncio.to_thread(finalize_character_recent_rename, result)
                    print(f"[rename] finalized", flush=True)
                    return {"success": True, "message": "renamed"}

                except Exception as inner_exc:
                    print(f"[rename] rollback due to: {inner_exc}", flush=True)
                    if result:
                        await asyncio.to_thread(rollback_character_recent_rename, result)
                    elif tx:
                        await asyncio.to_thread(release_character_recent_transaction, tx)

                    if characters_snapshot and memory_snapshot_records:
                        print(f"[rename] restoring snapshot", flush=True)
                        for record in sorted(memory_snapshot_records, key=lambda r: len(r["target"].parts), reverse=True):
                            target_path = record["target"]
                            backup_path = record.get("backup")
                            try:
                                if target_path.exists():
                                    if target_path.is_dir():
                                        shutil.rmtree(target_path)
                                    else:
                                        target_path.unlink()
                                if backup_path and backup_path.exists():
                                    if backup_path.is_dir():
                                        shutil.copytree(backup_path, target_path, dirs_exist_ok=True)
                                    else:
                                        target_path.parent.mkdir(parents=True, exist_ok=True)
                                        shutil.copy2(backup_path, target_path)
                            except Exception as restore_err:
                                print(f"[rename] restore {target_path} failed: {restore_err}", flush=True)
                        try:
                            await asyncio.to_thread(cm.save_characters, characters_snapshot)
                            print(f"[rename] characters.json restored", flush=True)
                        except Exception as save_err:
                            print(f"[rename] characters.json restore failed: {save_err}", flush=True)

                    resp3 = await client.post(
                        f"{base_url}/reload",
                        json={
                            "release_derived_task_claims": {old_name: [token]},
                        },
                    )
                    print(f"[rename] rollback reload: {resp3.json()}", flush=True)
                    return {"success": False, "message": f"rename failed: {inner_exc}"}

                finally:
                    if temp_snapshot_dir:
                        try:
                            shutil.rmtree(temp_snapshot_dir)
                        except Exception:
                            pass

        except Exception as e:
            print(f"[rename] outer error: {e}", flush=True)
            return {"success": False, "message": f"error: {e}"}


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="F05 N.E.K.O memory launcher")
    parser.add_argument("--enable-shutdown", action="store_true", help="Enable /shutdown endpoint")
    args = parser.parse_args()

    install()

    from app.memory_server import runtime

    runtime.enable_shutdown = args.enable_shutdown
    add_routes(runtime.app)

    # Per-task route modules (see docs/COLLAB.md); each exposes add_routes(app).
    import importlib

    for _mod in ("routes_f07", "routes_f08"):
        if (SCRIPT_DIR / f"{_mod}.py").exists():
            importlib.import_module(_mod).add_routes(runtime.app)

    import uvicorn

    server = uvicorn.Server(uvicorn.Config(
        runtime.app,
        host="127.0.0.1",
        port=int(os.environ.get("NEKO_MEMORY_SERVER_PORT", SANDBOX_PORT)),
        log_level="info",
    ))

    # /shutdown only sets runtime.shutdown_event; upstream __main__ watches it in a thread.
    # Ask uvicorn to exit gracefully instead of SIGTERM, which is a hard kill on Windows.
    if args.enable_shutdown:
        import threading

        def _watch_shutdown() -> None:
            while not runtime.shutdown_event.is_set():
                time.sleep(0.1)
            print("[launcher] shutdown requested", flush=True)
            server.should_exit = True

        threading.Thread(target=_watch_shutdown, daemon=True).start()

    server.run()
