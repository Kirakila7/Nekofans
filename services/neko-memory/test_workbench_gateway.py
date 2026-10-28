"""Crash/replay checks against the real pinned FactStore, with synthetic data only."""
import asyncio
import logging
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import workbench_server
from workbench_gateway import NativeMemoryGateway


class GatewayRecoveryTest(unittest.IsolatedAsyncioTestCase):
    async def test_native_write_before_receipt_and_observation_before_cursor_recover(self):
        logging.disable(logging.CRITICAL)
        directory=Path(tempfile.mkdtemp(prefix="neko-memory-recovery-"))
        runtime=None;gateway=None
        try:
            app_root=directory/"N.E.K.O"
            workbench_server._seed_character(app_root,{"prompt":"仅用于恢复测试的合成角色。"})
            workbench_server._install_environment(directory,app_root,"synthetic_recovery_instance",59091)
            import sys
            sys.path.insert(0,str(Path(__file__).parent/"vendor"))
            workbench_server._install_vendor_configuration(directory,app_root,{"protocol":"openai-compatible","baseUrl":"http://127.0.0.1:9/v1","model":"unused-fixture","apiKey":"synthetic-fixture-key","requestTimeoutMs":1000})
            from app.memory_server import runtime as native_runtime
            runtime=native_runtime
            workbench_server._disable_native_sync()
            await runtime.ensure_memory_server_runtime_initialized(reason="synthetic recovery test")
            gateway=NativeMemoryGateway(runtime,directory,"bigfish","大肥鱼")
            event=dict(eventId="crash-window",itemId="recovery-item",personaId="bigfish",origin="user",operation="upsert",parents=[],occurredAt="2026-10-28T00:00:00Z",
                       value=dict(kind="preference",text="恢复测试用户喜欢安静的书房",visibility="private",certainty="user-confirmed",evidenceRefs=["synthetic-source"]))
            persist=runtime.fact_store._apersist_new_facts
            async def lose_receipt(*args,**kwargs):
                await persist(*args,**kwargs)
                raise OSError("synthetic interrupted ledger commit")
            runtime.fact_store._apersist_new_facts=lose_receipt
            with self.assertRaises(OSError):await gateway.push([event])
            self.assertEqual(gateway.db.execute("SELECT applied FROM events WHERE id=?",(event["eventId"],)).fetchone()[0],0)
            gateway.db.close();gateway=None
            runtime.fact_store._apersist_new_facts=persist
            gateway=NativeMemoryGateway(runtime,directory,"bigfish","大肥鱼")
            await gateway.push([event])
            rows=await gateway.native_facts()
            self.assertEqual(sum(f.get("text")==event["value"]["text"] for f in rows),1)
            await persist("大肥鱼",[dict(text="原生端新增的恢复测试事实",importance=6,entity="master")],semantic_dedup=False,effect_keys=["synthetic-native-origin"])
            original_set=gateway.set
            def interrupt_observation(key,value):
                if key.startswith("observed:") and value.get("item","").startswith("neko:"):
                    raise OSError("synthetic lost observation checkpoint")
                return original_set(key,value)
            gateway.set=interrupt_observation
            with self.assertRaises(OSError):await gateway.pull("0")
            gateway.db.close();gateway=None
            gateway=NativeMemoryGateway(runtime,directory,"bigfish","大肥鱼")
            pulled=await gateway.pull("0")
            native=[e for e in pulled["events"] if e.get("value",{}).get("text")=="原生端新增的恢复测试事实"]
            self.assertEqual(len(native),1)
            self.assertEqual(native[0]["value"]["certainty"],"candidate")
            # A reflection observed before a fact correction must not leak the
            # superseded preference back into future chat context.
            source_id=gateway.db.execute("SELECT native_id FROM projections WHERE item=?",(event["itemId"],)).fetchone()[0]
            reflection=dict(id="synthetic-derived-reflection",text="基于旧偏好的合成反思",source_fact_ids=[source_id],status="active")
            from app.memory_server import routes
            with patch.object(runtime.reflection_engine,"aload_reflections",new=AsyncMock(return_value=[reflection])), patch.object(routes,"query_memory",new=AsyncMock(return_value={"results":[{"id":reflection["id"],"tier":"reflection"}]})):
                self.assertEqual(len((await gateway.recall("偏好",512))["values"]),1)
                correction={**event,"eventId":"corrected-preference","parents":[event["eventId"]],"value":{**event["value"],"text":"恢复测试用户改为喜欢热闹的客厅"}}
                await gateway.push([correction])
                self.assertEqual((await gateway.recall("偏好",512))["values"],[])
        finally:
            if runtime:
                await runtime.shutdown_event_handler()
            if gateway:gateway.db.close()
            shutil.rmtree(directory)


if __name__=="__main__":unittest.main()
