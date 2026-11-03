"""Read-only, allowlisted projection of the main persona's native memory.

Edges describe persisted provenance, never guessed semantic similarity. This
module deliberately has no extraction, repair, model, or persistence calls.
"""
import math


def strings(value):
    return list(dict.fromkeys(v for v in value if isinstance(v, str) and v)) if isinstance(value, list) else []


def project_graph(facts, reflections, persona, events, projections, state, blocked, active_fact_ids):
    nodes, edges, pending_edges = {}, {}, []
    by_event = {e["eventId"]: e for e in events}
    mapped = {}
    for item, event, native_id, kind in projections:
        mapped.setdefault((kind, native_id), []).append((item, event))

    def management(kind, native_id):
        for item, _ in reversed(mapped.get((kind, native_id), [])):
            row = state.get(item)
            if row and not row["deleted"] and not row["conflict"]:
                return dict(id=item, revisionIds=[h["eventId"] for h in row["heads"]])
        return None

    def add(kind, row, entity=None):
        if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"]:
            return None
        if not isinstance(row.get("text"), str) or not row["text"].strip():
            return None
        # Never expose erased records or a reflection derived from an erased fact.
        rid = row["id"]
        if (kind, rid) in blocked or row.get("suppressed"):
            return None
        prefix = f"persona:{entity}:" if kind == "persona" else kind + ":"
        nid = prefix + rid
        status = row.get("status") or ("protected" if row.get("protected") else "stored")
        if kind == "fact":
            status = "archived" if rid not in active_fact_ids else "absorbed" if row.get("absorbed") else "stored"
        node = dict(id=nid, nativeId=rid, kind=kind, text=row["text"], entity=entity or row.get("entity"),
                    status=status, suppressed=bool(row.get("suppress")), protected=bool(row.get("protected")),
                    createdAt=row.get("created_at"), occurredAt=row.get("event_start_at") or row.get("created_at"),
                    sourceRefs=[], management=management(kind, rid))
        # Explicit fields only: vectors, model settings and internal prompts never cross IPC.
        importance = row.get("importance")
        if isinstance(importance, (float, int)) and not isinstance(importance, bool) and math.isfinite(importance):
            node["importance"] = importance
        if row.get("source") in ("character_card", "settings", "manual", "reflection", "reflection_time_driven"):
            node["source"] = row["source"]
        nodes[nid] = node
        return node

    # Source events are the actual durable workbench inputs, not synthetic stars.
    for item, row in state.items():
        value = row.get("value") or {}
        if row["deleted"] or row["conflict"] or value.get("nativeRef") or not value.get("text"):
            continue
        heads = row["heads"]
        event = heads[0]
        kind = "episode" if value.get("kind") in ("episode", "summary") else "fact"
        node = dict(id="event:" + item, kind=kind, text=value["text"], entity="master",
                    status=value.get("certainty", "candidate"), certainty=value.get("certainty"),
                    occurredAt=event["occurredAt"], createdAt=event["occurredAt"],
                    sourceRefs=[dict(id=ref, kind="message") for ref in strings(value.get("evidenceRefs"))],
                    management=dict(id=item, revisionIds=[h["eventId"] for h in heads]))
        nodes[node["id"]] = node

    for row in facts:
        node = add("fact", row)
        if not node:
            continue
        for item, event_id in mapped.get(("fact", row["id"]), []):
            source = by_event.get(event_id)
            if not source or source.get("origin") == "neko":
                continue
            source_node = "event:" + item
            node["sourceRefs"].append(dict(id=item, kind="episode", nodeId=source_node))
            pending_edges.append((source_node, node["id"], "extracted-from"))
        for ref in strings(row.get("source_fact_ids")):
            node["sourceRefs"].append(dict(id=ref, kind="fact", nodeId="fact:" + ref))
            pending_edges.append(("fact:" + ref, node["id"], "derived-from"))

    denied_reflections = {rid for kind, rid in blocked if kind == "reflection"}
    for row in reflections:
        if not isinstance(row, dict):
            continue
        if any(("fact", ref) in blocked for ref in strings(row.get("source_fact_ids"))):
            denied_reflections.add(row.get("id"))
            continue
        node = add("reflection", row)
        if not node:
            continue
        for ref in strings(row.get("source_fact_ids")):
            node["sourceRefs"].append(dict(id=ref, kind="fact", nodeId="fact:" + ref))
            pending_edges.append(("fact:" + ref, node["id"], "synthesized-from"))

    for entity, section in persona.items():
        if not isinstance(section, dict):
            continue
        for row in section.get("facts") or []:
            if not isinstance(row, dict):
                continue
            refs = strings([row.get("source_id")] + strings(row.get("merged_from_ids")) + strings(row.get("merged_source_ids")))
            if any(ref in denied_reflections for ref in refs):
                continue
            node = add("persona", row, entity)
            if not node:
                continue
            for ref in refs:
                # Only reflection-backed IDs establish reflection→persona provenance.
                if row.get("source", "").startswith("reflection") or "reflection:" + ref in nodes:
                    node["sourceRefs"].append(dict(id=ref, kind="reflection", nodeId="reflection:" + ref))
                    pending_edges.append(("reflection:" + ref, node["id"], "promoted-from"))
            for version in row.get("version_history") or []:
                if isinstance(version, dict) and version.get("source_fact_id"):
                    ref = version["source_fact_id"]
                    node["sourceRefs"].append(dict(id=ref, kind="fact", nodeId="fact:" + ref))
                    pending_edges.append(("fact:" + ref, node["id"], "corrected-by"))

    # Older native versions also persist the promotion target on the reflection.
    for row in reflections:
        if not isinstance(row, dict) or not isinstance(row.get("absorbed_into"), str):
            continue
        for node in nodes.values():
            if node["kind"] == "persona" and node.get("nativeId") == row["absorbed_into"]:
                pending_edges.append(("reflection:" + row["id"], node["id"], "promoted-from"))

    for source, target, kind in pending_edges:
        if source in nodes and target in nodes and source != target:
            key = (source, target, kind)
            edges[key] = dict(source=source, target=target, kind=kind)
    for node in nodes.values():
        # An unresolved stored reference stays visible as an ID; never invent a node.
        for ref in node["sourceRefs"]:
            ref["available"] = ref.get("nodeId") in nodes
    return dict(version=1, nodes=list(nodes.values()), edges=list(edges.values()))
