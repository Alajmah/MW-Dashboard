#!/usr/bin/env python3
"""Strict telemetry-to-canonical identity resolver for a trusted ingestion boundary.

The MQ observer emits source-native identity hints and does not mint canonical IDs.
This resolver consumes a telemetry batch plus a bounded canonical identity snapshot.
It fills canonical_entity_id only when one unique, resolved canonical entity matches.
Ambiguous, missing, mismatched, or pre-populated canonical IDs are quarantined.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

BATCH_SCHEMA = "osi.telemetry.batch/v1"
SNAPSHOT_SCHEMA = "osi.telemetry.identity-snapshot/v1"
RESOLUTION_SCHEMA = "osi.telemetry.resolution/v1"
SUPPORTED_SCOPED = {"mq.queue", "mq.channel", "mq.listener"}


class ResolutionError(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def sha256_hex(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def lower(value: Any) -> str:
    return str(value or "").strip().lower()


def parse_identity_key(value: Any) -> dict[str, str]:
    out: dict[str, str] = {}
    for part in str(value or "").split("|"):
        if "=" not in part:
            continue
        key, raw = part.split("=", 1)
        if key.strip() and raw.strip():
            out[key.strip().lower()] = raw.strip().lower()
    return out


def load_json(path: str) -> dict[str, Any]:
    try:
        raw = sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8")
        value = json.loads(raw)
    except (OSError, json.JSONDecodeError) as exc:
        raise ResolutionError(f"cannot load JSON {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ResolutionError(f"JSON root must be an object: {path}")
    return value


def validate_batch(batch: dict[str, Any]) -> None:
    if batch.get("schema_version") != BATCH_SCHEMA:
        raise ResolutionError(f"expected {BATCH_SCHEMA}")
    if not isinstance(batch.get("observations"), list) or not isinstance(batch.get("coverage"), list):
        raise ResolutionError("telemetry batch observations and coverage must be arrays")
    run = batch.get("run")
    if not isinstance(run, dict) or not str(run.get("run_id") or "").strip():
        raise ResolutionError("telemetry batch run.run_id is required")


def validate_snapshot(snapshot: dict[str, Any]) -> None:
    if snapshot.get("schema_version") != SNAPSHOT_SCHEMA:
        raise ResolutionError(f"expected {SNAPSHOT_SCHEMA}")
    if not str(snapshot.get("estate_revision_id") or "").strip():
        raise ResolutionError("identity snapshot estate_revision_id is required")
    if not isinstance(snapshot.get("entities"), list):
        raise ResolutionError("identity snapshot entities must be an array")


class IdentityIndex:
    def __init__(self, snapshot: dict[str, Any]):
        validate_snapshot(snapshot)
        self.estate_revision_id = str(snapshot["estate_revision_id"])
        self.qmgr_by_qmid: dict[str, list[dict[str, Any]]] = {}
        self.qmgr_by_name: dict[str, list[dict[str, Any]]] = {}
        self.scoped: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
        self.by_id: dict[str, dict[str, Any]] = {}
        for raw in snapshot["entities"]:
            if not isinstance(raw, dict):
                continue
            entity_id = str(raw.get("entity_id") or "").strip()
            semantic_type = str(raw.get("semantic_type") or "").strip()
            if not entity_id or not semantic_type or raw.get("identity_state", "resolved") != "resolved":
                continue
            item = dict(raw)
            self.by_id[entity_id] = item
            if semantic_type == "mq.queue_manager":
                name = lower(item.get("display_name"))
                if name:
                    self.qmgr_by_name.setdefault(name, []).append(item)
                props = item.get("properties") if isinstance(item.get("properties"), dict) else {}
                qmid = lower(props.get("QMID") or props.get("qmid"))
                if not qmid:
                    identity_key = str(item.get("identity_key") or "")
                    parsed = parse_identity_key(identity_key)
                    qmid = lower(parsed.get("qmid"))
                    if not qmid and str(item.get("identity_rule") or "").lower() == "qmid" and "=" not in identity_key:
                        qmid = lower(identity_key)
                if qmid:
                    self.qmgr_by_qmid.setdefault(qmid, []).append(item)
            elif semantic_type in SUPPORTED_SCOPED:
                parsed = parse_identity_key(item.get("identity_key"))
                qmgr = lower(parsed.get("queue_manager_key"))
                name = lower(parsed.get("name"))
                if qmgr and name:
                    self.scoped.setdefault((semantic_type, qmgr, name), []).append(item)

    @staticmethod
    def candidate_ids(candidates: list[dict[str, Any]]) -> list[str]:
        return sorted(str(item.get("entity_id")) for item in candidates if item.get("entity_id"))

    def resolve_qmgr(self, hints: dict[str, Any]) -> tuple[str | None, str, list[str]]:
        qmid = lower(hints.get("queue_manager_qmid"))
        name = lower(hints.get("queue_manager_name"))
        if qmid:
            candidates = self.qmgr_by_qmid.get(qmid, [])
            ids = self.candidate_ids(candidates)
            if len(candidates) == 1:
                candidate = candidates[0]
                if name and lower(candidate.get("display_name")) and lower(candidate.get("display_name")) != name:
                    return None, "queue_manager_identity_mismatch", ids
                return str(candidate["entity_id"]), "resolved_by_qmid", ids
            return None, "ambiguous_qmid" if len(candidates) > 1 else "qmid_not_found", ids
        if not name:
            return None, "missing_queue_manager_identity", []
        candidates = self.qmgr_by_name.get(name, [])
        ids = self.candidate_ids(candidates)
        if len(candidates) == 1:
            return str(candidates[0]["entity_id"]), "resolved_by_name", ids
        return None, "ambiguous_queue_manager_name" if len(candidates) > 1 else "queue_manager_name_not_found", ids

    def resolve_observation(self, observation: dict[str, Any]) -> tuple[str | None, str, list[str]]:
        entity = observation.get("entity")
        if not isinstance(entity, dict):
            return None, "invalid_entity", []
        supplied = entity.get("canonical_entity_id")
        if supplied not in (None, ""):
            return None, "untrusted_canonical_id_supplied", [str(supplied)]
        semantic_type = str(entity.get("semantic_type") or "").strip()
        hints = entity.get("identity_hints")
        if not isinstance(hints, dict):
            return None, "missing_identity_hints", []
        if semantic_type == "mq.queue_manager":
            return self.resolve_qmgr(hints)
        if semantic_type in SUPPORTED_SCOPED:
            qmgr_name = lower(hints.get("queue_manager_name"))
            object_name = lower(hints.get("name"))
            if not qmgr_name or not object_name:
                return None, "missing_scoped_identity", []
            # If QMID is present, establish that it still identifies the named owner.
            if lower(hints.get("queue_manager_qmid")):
                owner_id, owner_reason, owner_candidates = self.resolve_qmgr(hints)
                if not owner_id:
                    return None, owner_reason, owner_candidates
            candidates = self.scoped.get((semantic_type, qmgr_name, object_name), [])
            ids = self.candidate_ids(candidates)
            if len(candidates) == 1:
                return str(candidates[0]["entity_id"]), "resolved_by_scoped_identity", ids
            return None, "ambiguous_scoped_identity" if len(candidates) > 1 else "scoped_identity_not_found", ids
        return None, "unsupported_semantic_type", []


def resolve_batch(batch: dict[str, Any], snapshot: dict[str, Any]) -> dict[str, Any]:
    validate_batch(batch)
    index = IdentityIndex(snapshot)
    resolved: list[dict[str, Any]] = []
    quarantine: list[dict[str, Any]] = []
    for raw in batch["observations"]:
        if not isinstance(raw, dict):
            quarantine.append({"observation_id": None, "reason": "invalid_observation", "candidate_entity_ids": []})
            continue
        canonical_id, reason, candidates = index.resolve_observation(raw)
        if canonical_id:
            item = json.loads(json.dumps(raw))
            entity = item["entity"]
            entity["canonical_entity_id"] = canonical_id
            item["resolution"] = {"state": "resolved", "method": reason, "estate_revision_id": index.estate_revision_id}
            resolved.append(item)
        else:
            quarantine.append({
                "observation_id": raw.get("observation_id"),
                "semantic_type": (raw.get("entity") or {}).get("semantic_type") if isinstance(raw.get("entity"), dict) else None,
                "display_name": (raw.get("entity") or {}).get("display_name") if isinstance(raw.get("entity"), dict) else None,
                "reason": reason,
                "candidate_entity_ids": candidates,
            })
    payload = canonical_json_bytes(batch)
    run = batch.get("run") if isinstance(batch.get("run"), dict) else {}
    return {
        "schema_version": RESOLUTION_SCHEMA,
        "resolved_at": utc_now(),
        "estate_revision_id": index.estate_revision_id,
        "source_batch": {
            "run_id": run.get("run_id"),
            "sha256": sha256_hex(payload),
            "source_id": ((run.get("source") or {}).get("source_id") if isinstance(run.get("source"), dict) else None),
        },
        "coverage": batch["coverage"],
        "resolved_observations": resolved,
        "quarantine": quarantine,
        "summary": {
            "input_observations": len(batch["observations"]),
            "resolved": len(resolved),
            "quarantined": len(quarantine),
        },
    }


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Resolve OSI telemetry identity hints against a canonical snapshot")
    p.add_argument("--batch", required=True, help="osi.telemetry.batch/v1 JSON path or - for stdin")
    p.add_argument("--identity-snapshot", required=True)
    p.add_argument("--output", default="-", help="Output path or - for stdout")
    p.add_argument("--fail-on-quarantine", action="store_true", help="Exit 3 when any observation is quarantined")
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        batch = load_json(args.batch)
        snapshot = load_json(args.identity_snapshot)
        result = resolve_batch(batch, snapshot)
    except ResolutionError as exc:
        print(f"osi-telemetry-resolver: {exc}", file=sys.stderr)
        return 2
    text = json.dumps(result, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    if args.output == "-":
        sys.stdout.write(text)
    else:
        Path(args.output).write_text(text, encoding="utf-8")
    if args.fail_on_quarantine and result["summary"]["quarantined"]:
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
