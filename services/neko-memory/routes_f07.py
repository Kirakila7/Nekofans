"""F07: read routes for fact and reflection records, plus an opt-in scripted stub.

Upstream has no route that lists facts.json / reflections.json with their
source fields, so these are added here:
- GET /f07/facts/{lanlan_name}        active facts plus facts_archive.json rows (archived=true),
  with source, importance, entity, timestamps; recall reads both pools
- GET /f07/reflections/{lanlan_name}  all reflections (including promoted/denied)
  with status and source_fact_ids

Persona uses the upstream GET /get_persona/{lanlan_name}.

When NEKO_F07_SCRIPTED_LLM=1 and the launcher runs in stub mode, the stub's
answers for fact extraction and reflection synthesis are replaced with
deterministic ones derived from the prompt, so tests can drive the real
upstream pipeline with distinct facts. Loaded by launcher.py.
"""

import json
import os
import re
import sys

from app.memory_server._shared import validate_lanlan_name
from app.memory_server import runtime

# Facts are declared in user text as 【记住:...】; one fact per marker.
_FACT_MARKER = re.compile(r"【记住:([^】]+)】")
F07_REFLECTION_TEXT = "主人的生活节奏偏慢，喜欢安静的爱好"

# Fields copied from a fact row; embedding vectors and dedup hashes are omitted.
_FACT_FIELDS = (
    "id", "text", "source", "importance", "entity", "created_at",
    "event_start_at", "absorbed", "speaker_id", "speaker_label", "speaker_trust",
)
_REFLECTION_FIELDS = (
    "id", "text", "entity", "status", "source_fact_ids", "created_at",
    "relation_type", "temporal_scope", "reinforcement",
)


def _install_scripted_llm() -> None:
    main = sys.modules.get("__main__")
    base = getattr(main, "_fake_answer", None)
    if base is None:
        return

    def scripted(call_type, prompt_text):
        if call_type == "memory_fact_extraction":
            facts = [m.strip() for m in _FACT_MARKER.findall(prompt_text)]
            return json.dumps(
                [{"text": t, "importance": 6, "entity": "master"} for t in dict.fromkeys(facts)],
                ensure_ascii=False,
            )
        if call_type == "memory_fact_extraction_ai_aware":
            return "[]"
        if call_type == "memory_reflection":
            return json.dumps({"reflection": F07_REFLECTION_TEXT, "entity": "master"}, ensure_ascii=False)
        return base(call_type, prompt_text)

    main._fake_answer = scripted
    print("[routes_f07] scripted stub LLM enabled", flush=True)


def _pick(row: dict, fields: tuple) -> dict:
    return {k: row.get(k) for k in fields if k in row}


def add_routes(app):
    if os.environ.get("NEKO_F07_SCRIPTED_LLM") == "1":
        _install_scripted_llm()

    @app.get("/f07/facts/{lanlan_name}")
    async def f07_list_facts(lanlan_name: str):
        lanlan_name = validate_lanlan_name(lanlan_name)
        active = await runtime.fact_store.aload_facts(lanlan_name)
        rows = [{**_pick(f, _FACT_FIELDS), "archived": False} for f in active if isinstance(f, dict)]
        archive_path = runtime.fact_store._facts_archive_path(lanlan_name)
        if os.path.exists(archive_path):
            with open(archive_path, encoding="utf-8") as fh:
                archived = json.load(fh)
            if isinstance(archived, list):
                rows += [{**_pick(f, _FACT_FIELDS), "archived": True} for f in archived if isinstance(f, dict)]
        return {"facts": rows}

    @app.get("/f07/reflections/{lanlan_name}")
    async def f07_list_reflections(lanlan_name: str):
        lanlan_name = validate_lanlan_name(lanlan_name)
        refl = await runtime.reflection_engine.aload_reflections(lanlan_name, include_archived=True)
        return {"reflections": [_pick(r, _REFLECTION_FIELDS) for r in refl if isinstance(r, dict)]}
