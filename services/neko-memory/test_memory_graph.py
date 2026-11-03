"""Provenance, deletion fences, and read-only graph checks (synthetic data)."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock

from memory_graph import project_graph


class GraphProjectionTest(unittest.TestCase):
    def fixture(self):
        event = dict(eventId="turn-1", itemId="turn:a", origin="user", parents=[], operation="upsert", occurredAt="2026-10-01T12:00:00Z",
            value=dict(kind="episode", text="用户原话：合成茶偏好", certainty="inferred", evidenceRefs=["msg-1"]))
        state = {"turn:a": dict(heads=[event], value=event["value"], deleted=False, conflict=False)}
        facts = [dict(id="f1", text="合成用户喜欢茶", importance=6, created_at="2026-10-01T12:05:00Z", event_start_at="2026-09-30T12:00:00Z", embedding=[123], apiKey="do-not-export")]
        reflections = [dict(id="r1", text="合成反思", source_fact_ids=["f1"], status="pending"),dict(id="r-unrelated", text="无来源反思", source_fact_ids=["missing"], status="confirmed")]
        persona = {"master": {"facts": [dict(id="p1", text="合成人格", source="reflection", source_id="r1")]}}
        args = [facts, reflections, persona, [event], [("turn:a", "turn-1", "f1", "fact")], state, set(), {"f1"}]
        return args

    def test_persisted_provenance_only_and_original_event_time(self):
        args = self.fixture()
        graph = project_graph(*args)
        edges = {(e["source"], e["target"], e["kind"]) for e in graph["edges"]}
        self.assertEqual(edges, {("event:turn:a", "fact:f1", "extracted-from"), ("fact:f1", "reflection:r1", "synthesized-from"), ("reflection:r1", "persona:master:p1", "promoted-from")})
        nodes = {n["id"]: n for n in graph["nodes"]}
        self.assertEqual(nodes["fact:f1"]["occurredAt"], "2026-09-30T12:00:00Z")
        self.assertFalse(nodes["reflection:r-unrelated"]["sourceRefs"][0]["available"])
        self.assertEqual(nodes["reflection:r1"]["status"], "pending")
        self.assertNotIn("do-not-export", json.dumps(graph))
        self.assertNotIn("embedding", json.dumps(graph))
        self.assertEqual(args[0][0]["embedding"], [123])  # projection didn't mutate native records

    def test_deleted_source_hides_fact_dependent_reflection_and_persona(self):
        args = self.fixture()
        args[5]["turn:a"]["deleted"] = True
        args[6] = {("fact", "f1")}
        graph = project_graph(*args)
        self.assertEqual([n["id"] for n in graph["nodes"]], ["reflection:r-unrelated"])
        self.assertEqual(graph["edges"], [])

    def test_merge_audit_is_a_real_edge_and_missing_origins_stay_missing(self):
        args = self.fixture()
        args[2]["master"]["facts"][0] = dict(id="p1", text="合并后的知识", merged_from_ids=["r1", "r-unrelated"])
        graph = project_graph(*args)
        edges = [(e["source"], e["target"]) for e in graph["edges"]]
        self.assertIn(("reflection:r1", "persona:master:p1"), edges)
        self.assertIn(("reflection:r-unrelated", "persona:master:p1"), edges)
        self.assertNotIn(("fact:missing", "reflection:r-unrelated"), edges)


class GraphReadOnlyTest(unittest.IsolatedAsyncioTestCase):
    async def test_gateway_graph_never_repairs_observes_or_calls_a_model(self):
        from workbench_gateway import NativeMemoryGateway
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "大肥鱼"
            path.mkdir()
            persona_file = path / "persona.json"
            persona_file.write_text(json.dumps({"neko": {"facts": [dict(id="p", text="合成角色设定", protected=True, source="character_card")]}}))
            runtime = SimpleNamespace(fact_store=SimpleNamespace(aload_facts_strict=AsyncMock(return_value=[dict(id="f", text="真实存储格式的合成事实")])),
                reflection_engine=SimpleNamespace(aload_reflections=AsyncMock(return_value=[])),
                persona_manager=SimpleNamespace(_config_manager=SimpleNamespace(memory_dir=directory)))
            gateway = NativeMemoryGateway(runtime, directory, "bigfish", "大肥鱼")
            gateway.repair = AsyncMock(side_effect=AssertionError("graph repaired"))
            gateway.observe = AsyncMock(side_effect=AssertionError("graph observed"))
            before = persona_file.read_bytes()
            try:
                graph = await gateway.graph()
                self.assertEqual(graph["personaId"], "bigfish")
                self.assertEqual(len(graph["nodes"]), 2)
                gateway.repair.assert_not_awaited()
                gateway.observe.assert_not_awaited()
                self.assertEqual(gateway.events(), [])
                self.assertEqual(persona_file.read_bytes(), before)
            finally:
                gateway.db.close()


if __name__ == "__main__":
    unittest.main()
