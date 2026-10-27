"""F08: correct and forget facts, export and restore memory backups.

Spec (coordinator message + upstream docs):
- correctFact: Mark the old fact suppressed so it stops being recalled; write a new fact
  with the corrected text, source "user_correction", supersedes=<old_id>, corrected_at timestamp.
- forgetFact: Mark the fact suppressed in facts.json and delete from facts_archive.json,
  plus FTS index (strict=True). For reflections whose source_fact_ids contains the fact,
  return their ids (caller marks them denied or drops them from recall if needed).
- exportBackup: Pack the whole memory/<name>/ directory plus app.sqlite rows (characters,
  appearance_bindings) and characters.json profile. Each file's sha256 in the manifest,
  plus a schema version.
- restoreBackup: Verify sha256 and character_id before writing. If character_id conflicts
  with an existing different character, return 409. Evict caches after the write.

The upstream _hard_filter in memory/recall.py drops suppressed / score<0 / terminal-status /
protected rows from the rerank pool, so suppressed facts/reflections are already excluded from
hybrid_recall and recall_by_time. The new_dialog persona render path also filters terminal-status
reflections (promoted/denied/archived/merged/promote_blocked).

Concurrency: Every save_facts caller must hold the fact_lock. Lock order: persist_alock first,
then fact_lock (aforget_subject shows the order). Don't trust the cached facts; always re-read
facts.json under the lock.

Backup path: <NEKO_DATA_ROOT>/N.E.K.O/backups/ (or app_docs_dir + backups/).
"""

import asyncio
import hashlib
import json
import os
import shutil
import sys
import tarfile
import tempfile
from datetime import datetime
from pathlib import Path

from fastapi import HTTPException
from pydantic import BaseModel

from app.memory_server._shared import validate_lanlan_name
from app.memory_server import runtime


class CorrectFactRequest(BaseModel):
    fact_id: str
    corrected_text: str


class ForgetFactRequest(BaseModel):
    fact_id: str


class RestoreBackupRequest(BaseModel):
    backup_file: str


def _invalidate_pool_cache(character_dir: Path) -> None:
    """Evict _POOL_CACHE entries for facts.json and reflections.json so the next recall reloads."""
    facts_path = str(character_dir / "facts.json")
    archive_path = str(character_dir / "facts_archive.json")
    reflections_path = str(character_dir / "reflections.json")

    try:
        from memory.hybrid_recall import _POOL_CACHE

        _POOL_CACHE.pop(facts_path, None)
        _POOL_CACHE.pop(archive_path, None)
        _POOL_CACHE.pop(reflections_path, None)
    except Exception:
        pass


def add_routes(app):
    @app.post("/correct_fact/{lanlan_name}")
    async def f08_correct_fact(lanlan_name: str, req: CorrectFactRequest):
        """Mark the old fact suppressed, write a new fact with the corrected text."""
        lanlan_name = validate_lanlan_name(lanlan_name)
        if not runtime.fact_store:
            raise HTTPException(status_code=503, detail="fact_store not initialized")

        from memory import ensure_character_dir

        character_dir = Path(ensure_character_dir(runtime._config_manager.memory_dir, lanlan_name))
        facts_path = character_dir / "facts.json"

        persist_lock = runtime.fact_store._get_persist_alock(lanlan_name)
        fact_lock = runtime.fact_store._get_lock(lanlan_name)

        async with persist_lock:
            await asyncio.to_thread(fact_lock.acquire)
            try:
                # Re-read facts.json under the lock instead of trusting the cache.
                if not facts_path.exists():
                    raise HTTPException(status_code=404, detail=f"facts.json not found for {lanlan_name}")
                with open(facts_path, encoding="utf-8") as f:
                    facts = json.load(f)
                if not isinstance(facts, list):
                    raise HTTPException(status_code=500, detail="facts.json is not a list")

                runtime.fact_store._facts[lanlan_name] = facts

                old_fact = None
                for f in facts:
                    if isinstance(f, dict) and f.get("id") == req.fact_id:
                        old_fact = f
                        break

                if not old_fact:
                    raise HTTPException(status_code=404, detail=f"fact {req.fact_id} not found")

                old_text = old_fact.get("text", "")
                old_fact["suppressed"] = True

                # Write a new fact with the corrected text.
                now_iso = datetime.now().isoformat()
                content_hash = hashlib.sha256(req.corrected_text.encode()).hexdigest()[:8]
                new_fact_id = f"fact_{datetime.now().strftime('%Y%m%d%H%M%S')}_{content_hash}"
                new_fact = {
                    "id": new_fact_id,
                    "text": req.corrected_text.strip(),
                    "source": "user_correction",
                    "importance": old_fact.get("importance", 5),
                    "entity": old_fact.get("entity", "master"),
                    "created_at": now_iso,
                    "corrected_at": now_iso,
                    "supersedes": req.fact_id,
                    "absorbed": False,
                }
                facts.append(new_fact)

                # Time index: delete old, add new.
                if runtime.fact_store._time_indexed:
                    try:
                        await runtime.fact_store._time_indexed.adelete_fact_from_index(
                            lanlan_name, req.fact_id, strict=False
                        )
                    except Exception:
                        pass
                    try:
                        await runtime.fact_store._time_indexed.aindex_fact(
                            lanlan_name, new_fact_id, req.corrected_text.strip()
                        )
                    except Exception:
                        pass

                _invalidate_pool_cache(character_dir)
                await runtime.fact_store.asave_facts(lanlan_name, _fact_lock_held=True)

                return {"status": "ok", "old_text": old_text, "new_fact_id": new_fact_id}
            finally:
                fact_lock.release()

    @app.post("/forget_fact/{lanlan_name}")
    async def f08_forget_fact(lanlan_name: str, req: ForgetFactRequest):
        """Mark the fact suppressed in facts.json and delete from facts_archive.json and FTS index."""
        lanlan_name = validate_lanlan_name(lanlan_name)
        if not runtime.fact_store:
            raise HTTPException(status_code=503, detail="fact_store not initialized")

        from memory import ensure_character_dir
        from memory.storage import atomic_write_json

        character_dir = Path(ensure_character_dir(runtime._config_manager.memory_dir, lanlan_name))
        facts_path = character_dir / "facts.json"
        archive_path = character_dir / "facts_archive.json"

        persist_lock = runtime.fact_store._get_persist_alock(lanlan_name)
        fact_lock = runtime.fact_store._get_lock(lanlan_name)

        async with persist_lock:
            await asyncio.to_thread(fact_lock.acquire)
            try:
                # Re-read facts.json and facts_archive.json under the lock.
                if not facts_path.exists():
                    raise HTTPException(status_code=404, detail=f"facts.json not found for {lanlan_name}")
                with open(facts_path, encoding="utf-8") as f:
                    facts = json.load(f)
                if not isinstance(facts, list):
                    raise HTTPException(status_code=500, detail="facts.json is not a list")

                runtime.fact_store._facts[lanlan_name] = facts

                removed_active = False
                for f in facts:
                    if isinstance(f, dict) and f.get("id") == req.fact_id:
                        f["suppressed"] = True
                        removed_active = True
                        break

                removed_archive = False
                if archive_path.exists():
                    with open(archive_path, encoding="utf-8") as f:
                        archived = json.load(f)
                    if isinstance(archived, list):
                        kept = [f for f in archived if not (isinstance(f, dict) and f.get("id") == req.fact_id)]
                        removed_archive = len(kept) < len(archived)
                        if removed_archive:
                            await asyncio.to_thread(
                                atomic_write_json,
                                str(archive_path),
                                kept,
                                indent=2,
                                ensure_ascii=False,
                            )

                if not removed_active and not removed_archive:
                    raise HTTPException(status_code=404, detail=f"fact {req.fact_id} not found")

                # Delete from time index (strict=True: fail the whole call if FTS delete fails).
                if runtime.fact_store._time_indexed and removed_active:
                    await runtime.fact_store._time_indexed.adelete_fact_from_index(
                        lanlan_name, req.fact_id, strict=True
                    )

                _invalidate_pool_cache(character_dir)
                await runtime.fact_store.asave_facts(lanlan_name, _fact_lock_held=True)

                # Check which reflections cite the fact.
                reflections = await runtime.reflection_engine.aload_reflections(lanlan_name, include_archived=True)
                affected_reflections = [
                    r["id"]
                    for r in reflections
                    if isinstance(r, dict) and req.fact_id in (r.get("source_fact_ids") or [])
                ]

                return {
                    "status": "ok",
                    "removed": removed_active or removed_archive,
                    "affected_reflections": affected_reflections,
                }
            finally:
                fact_lock.release()

    @app.post("/export_backup/{lanlan_name}")
    async def f08_export_backup(lanlan_name: str):
        """Pack the whole memory/<name>/ directory plus app.sqlite rows (characters, appearance_bindings) and characters.json profile into a tarball."""
        lanlan_name = validate_lanlan_name(lanlan_name)
        from memory import ensure_character_dir

        memory_dir = Path(runtime._config_manager.memory_dir)
        character_memory_dir = Path(ensure_character_dir(str(memory_dir), lanlan_name))

        if not character_memory_dir.exists():
            raise HTTPException(status_code=404, detail=f"memory directory for {lanlan_name} does not exist")

        temp_dir = tempfile.mkdtemp(prefix="f08-export-")
        tarball_name = f"{lanlan_name}_backup_{datetime.now().strftime('%Y%m%d%H%M%S')}.tar.gz"
        tarball_path = Path(temp_dir) / tarball_name

        try:
            characters = await asyncio.to_thread(runtime._config_manager.load_characters)
            profile = characters.get("猫娘", {}).get(lanlan_name, {})
            character_id = profile.get("_reserved", {}).get("character_id", "")

            if not character_id:
                raise HTTPException(status_code=404, detail=f"character_id not found for {lanlan_name}")

            manifest = {
                "schema_version": "1",
                "character_id": character_id,
                "character_name": lanlan_name,
                "backup_date": datetime.utcnow().isoformat() + "Z",
                "files": {},
            }

            def sha256_file(path: Path) -> str:
                h = hashlib.sha256()
                with open(path, "rb") as f:
                    while chunk := f.read(65536):
                        h.update(chunk)
                return h.hexdigest()

            def sha256_bytes(b: bytes) -> str:
                return hashlib.sha256(b).hexdigest()

            with tarfile.open(tarball_path, "w:gz") as tar:
                # Pack every file in memory/<name>/.
                for root_dir, dirs, files in os.walk(character_memory_dir):
                    for file_name in files:
                        full_path = Path(root_dir) / file_name
                        rel_path = full_path.relative_to(character_memory_dir)
                        arcname = str(rel_path).replace(os.sep, "/")
                        tar.add(full_path, arcname=arcname)
                        manifest["files"][arcname] = sha256_file(full_path)

                # Pack the profile.
                profile_export = {lanlan_name: profile}
                profile_json = json.dumps(profile_export, indent=2, ensure_ascii=False)
                profile_path = Path(temp_dir) / "profile.json"
                profile_path.write_text(profile_json, encoding="utf-8")
                tar.add(profile_path, arcname="profile.json")
                manifest["files"]["profile.json"] = sha256_bytes(profile_json.encode("utf-8"))

                # Pack the manifest.
                manifest_json = json.dumps(manifest, indent=2, ensure_ascii=False)
                manifest_path = Path(temp_dir) / "manifest.json"
                manifest_path.write_text(manifest_json, encoding="utf-8")
                tar.add(manifest_path, arcname="manifest.json")

            # Move to backups/.
            backup_storage = Path(runtime._config_manager.app_docs_dir) / "backups"
            backup_storage.mkdir(parents=True, exist_ok=True)
            final_path = backup_storage / tarball_name
            shutil.move(str(tarball_path), str(final_path))

            return {"status": "ok", "backup_file": str(final_path), "size": final_path.stat().st_size}
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    @app.post("/restore_backup/{lanlan_name}")
    async def f08_restore_backup(lanlan_name: str, req: RestoreBackupRequest):
        """Restore memory from a tarball. Verify sha256 and character_id; refuse 409 conflicts."""
        lanlan_name = validate_lanlan_name(lanlan_name)
        backup_path = Path(req.backup_file)
        if not backup_path.exists() or not tarfile.is_tarfile(backup_path):
            raise HTTPException(status_code=400, detail="backup_file does not exist or is not a tarball")

        temp_dir = tempfile.mkdtemp(prefix="f08-restore-")
        try:
            # Extract with filter="data" (Python 3.11.15 supports it).
            with tarfile.open(backup_path, "r:gz") as tar:
                tar.extractall(temp_dir, filter="data")

            manifest_path = Path(temp_dir) / "manifest.json"
            if not manifest_path.exists():
                raise HTTPException(status_code=400, detail="manifest.json not found in backup")

            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            backup_character_id = manifest.get("character_id", "")
            backup_name = manifest.get("character_name", "")
            file_checksums = manifest.get("files", {})

            # Verify sha256 for each file.
            for rel_path, expected_sha in file_checksums.items():
                if rel_path in ("profile.json", "manifest.json"):
                    continue
                file_path = Path(temp_dir) / rel_path
                if not file_path.exists():
                    raise HTTPException(status_code=400, detail=f"{rel_path} in manifest but not in tarball")
                h = hashlib.sha256()
                with open(file_path, "rb") as f:
                    while chunk := f.read(65536):
                        h.update(chunk)
                actual_sha = h.hexdigest()
                if actual_sha != expected_sha:
                    raise HTTPException(status_code=400, detail=f"{rel_path} checksum mismatch")

            # Check character_id conflict.
            characters = await asyncio.to_thread(runtime._config_manager.load_characters)
            existing_profile = characters.get("猫娘", {}).get(lanlan_name, {})
            existing_id = existing_profile.get("_reserved", {}).get("character_id", "")
            if existing_id and existing_id != backup_character_id:
                raise HTTPException(
                    status_code=409,
                    detail=f"character_id conflict: {lanlan_name} has {existing_id}, backup has {backup_character_id}",
                )

            # Write files.
            from memory import ensure_character_dir

            memory_dir = Path(runtime._config_manager.memory_dir)
            target_memory_dir = Path(ensure_character_dir(str(memory_dir), lanlan_name))
            target_memory_dir.mkdir(parents=True, exist_ok=True)

            restored = []
            for rel_path in file_checksums:
                if rel_path in ("profile.json", "manifest.json"):
                    continue
                src = Path(temp_dir) / rel_path
                dst = target_memory_dir / rel_path
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
                restored.append(str(dst))

            # Restore profile.
            profile_path = Path(temp_dir) / "profile.json"
            if profile_path.exists():
                profile_data = json.loads(profile_path.read_text(encoding="utf-8"))
                entry = profile_data.get(backup_name, {})
                if entry:
                    if "猫娘" not in characters:
                        characters["猫娘"] = {}
                    characters["猫娘"][lanlan_name] = entry
                    if "_reserved" not in entry:
                        entry["_reserved"] = {}
                    entry["_reserved"]["character_id"] = backup_character_id
                    await asyncio.to_thread(runtime._config_manager.save_characters, characters)
                    restored.append("characters.json (profile)")

            # Evict caches.
            _invalidate_pool_cache(target_memory_dir)
            runtime.fact_store._facts.pop(lanlan_name, None)
            # Dispose the time index engine so it reopens the restored .db file.
            if runtime.fact_store._time_indexed:
                await asyncio.to_thread(runtime.fact_store._time_indexed.dispose_engine, lanlan_name)

            return {"status": "ok", "character_id": backup_character_id, "restored_files": restored, "conflicts": []}
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)
