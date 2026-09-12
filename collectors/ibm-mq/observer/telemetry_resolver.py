#!/usr/bin/env python3
"""Strict telemetry-to-canonical identity resolver for a trusted ingestion boundary.

The MQ observer emits source-native identity hints and does not mint canonical IDs.
This resolver consumes a telemetry batch plus a bounded canonical identity snapshot.
It fills canonical_entity_id only when one unique, resolved canonical entity matches.
Ambiguous, missing, mismatched, conflicted, or pre-populated canonical IDs are
quarantined rather than guessed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

BATCH_SCHEMA = "osi.telemetry.batch/v1"
SNAPSHOT_SCHEMA = "osi.telemetry.identity-snapshot/v1"
RESOLUTION_SCHEMA = "osi.telemetry.resolution/v1"
SUPPORTED_SCOPED = {"mq.queue", "mq.channel", "mq.listener"}
IDENTITY_STATES = {"resolved", "ambiguous", "conflicted"}
CENT_RE = re.compile(r"^cent_[0-9a-f]{24}$")
TOBS_RE = re.compile(r"^tobs_[0-9a-f]{24}$")
MAX_OBSERVATIONS = 100_000
MAX_COVERAGE = 100_000
MAX_SNAPSHOT_ENTITIES = 100_000


class ResolutionError(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def sha256_hex(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def scalar(value: Any) -> str:
    if value is None or isinstance(value, (dict, list, tuple, set)):
        return ""
    return str(value).strip()


def lower(value: Any) -> str:
    return scalar(value).lower()


def parse_identity_key(value: Any) -> dict[str, str]:
    out: dict[str, str] = {}
    for index, part in enumerate(str(value or "").split("|")):
        if "=" not in part:
            continue
        key, raw = part.split("=", 1)
        key = key.strip().lower()
        if index == 0 and ":" in key:
            # Accept registry logical-key form such as rule_2:qmid=... in
            # addition to the current estate's plain identity_key projection.
            key = key.rsplit(":", 1)[-1]
        raw = raw.strip().lower()
        if key and raw:
            out[key] = raw
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
    observations = batch.get("observations")
    coverage = batch.get("coverage")
    if not isinstance(observations, list) or len(observations) > MAX_OBSERVATIONS:
        raise ResolutionError(f"telemetry batch observations must be an array with at most {MAX_OBSERVATIONS} items")
    if not isinstance(coverage, list) or len(coverage) > MAX_COVERAGE:
        raise ResolutionError(f"telemetry batch coverage must be an array with at most {MAX_COVERAGE} items")
    run = batch.get("run")
    if not isinstance(run, dict) or not scalar(run.get("run_id")):
        raise ResolutionError("telemetry batch run.run_id is required")
    run_source = run.get("source")
    if not isinstance(run_source, dict) or not scalar(run_source.get("source_id")) or not scalar(run_source.get("source_host")):
        raise ResolutionError("telemetry batch run.source source_id and source_host are required")
    run_source_id = scalar(run_source.get("source_id"))
    run_source_host = scalar(run_source.get("source_host"))
    seen_ids: set[str] = set()
    for index, raw in enumerate(observations):
        if not isinstance(raw, dict):
            continue
        obs_id = scalar(raw.get("observation_id"))
        if obs_id:
            if not TOBS_RE.fullmatch(obs_id):
                raise ResolutionError(f"observations[{index}].observation_id is invalid")
            if obs_id in seen_ids:
                raise ResolutionError(f"duplicate observation_id in telemetry batch: {obs_id}")
            seen_ids.add(obs_id)
        source = raw.get("source")
        if isinstance(source, dict):
            source_id = scalar(source.get("source_id"))
            source_host = scalar(source.get("source_host"))
            if source_id and source_id != run_source_id:
                raise ResolutionError(f"observations[{index}].source_id does not match run.source.source_id")
            if source_host and source_host != run_source_host:
                raise ResolutionError(f"observations[{index}].source_host does not match run.source.source_host")


def validate_snapshot(snapshot: dict[str, Any]) -> None:
    if snapshot.get("schema_version") != SNAPSHOT_SCHEMA:
        raise ResolutionError(f"expected {SNAPSHOT_SCHEMA}")
    if not scalar(snapshot.get("estate_revision_id")):
        raise ResolutionError("identity snapshot estate_revision_id is required")
    if not scalar(snapshot.get("built_at")):
        raise ResolutionError("identity snapshot built_at is required")
    entities = snapshot.get("entities")
    if not isinstance(entities, list) or len(entities) > MAX_SNAPSHOT_ENTITIES:
        raise ResolutionError(f"identity snapshot entities must be an array with at most {MAX_SNAPSHOT_ENTITIES} items")
    seen: set[str] = set()
    for index, raw in enumerate(entities):
        if not isinstance(raw, dict):
            raise ResolutionError(f"identity snapshot entities[{index}] must be an object")
        entity_id = scalar(raw.get("entity_id"))
        if not CENT_RE.fullmatch(entity_id):
            raise ResolutionError(f"identity snapshot entities[{index}].entity_id is invalid")
        if entity_id in seen:
            raise ResolutionError(f"duplicate entity_id in identity snapshot: {entity_id}")
        seen.add(entity_id)
        if not scalar(raw.get("semantic_type")) or not scalar(raw.get("identity_rule")) or not scalar(raw.get("identity_key")):
            raise ResolutionError(f"identity snapshot entities[{index}] is missing identity metadata")
        if raw.get("identity_state") not in IDENTITY_STATES:
            raise ResolutionError(f"identity snapshot entities[{index}].identity_state is invalid")
        if not scalar(raw.get("display_name")):
            raise ResolutionError(f"identity snapshot entities[{index}].display_name is required")
        if not isinstance(raw.get("properties"), dict):
            raise ResolutionError(f"identity snapshot entities[{index}].properties must be an object")


class IdentityIndex:
    def __init__(self, snapshot: dict[str, Any]):
        validate_snapshot(snapshot)
        self.estate_revision_id = str(snapshot["estate_revision_id"])
        self.qmgr_by_qmid: dict[str, list[dict[str, Any]]] = {}
        self.qmgr_by_name: dict[str, list[dict[str, Any]]] = {}
        self.scoped: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
        self.by_id: dict[str, dict[str, Any]] = {}
        for raw in snapshot["entities"]:
            item = dict(raw)
            entity_id = scalar(item.get("entity_id"))
            semantic_type = scalar(item.get("semantic_type"))
            self.by_id[entity_id] = item
            if semantic_type == "mq.queue_manager":
                name = lower(item.get("display_name"))
                if name:
                    self.qmgr_by_name.setdefault(name, []).append(item)
                props = item.get("properties") if isinstance(item.get("properties"), dict) else {}
                qmid = lower(props.get("QMID") or props.get("qmid"))
                if not qmid:
                    identity_key = scalar(item.get("identity_key"))
                    parsed = parse_identity_key(identity_key)
                    qmid = lower(parsed.get("qmid"))
                    if not qmid and lower(item.get("identity_rule")) == "qmid" and "=" not in identity_key:
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
        return sorted(scalar(item.get("entity_id")) for item in candidates if CENT_RE.fullmatch(scalar(item.get("entity_id"))))

    def _unique_resolved(
        self,
        candidates: list[dict[str, Any]],
        *,
        resolved_reason: str,
        ambiguous_reason: str,
        not_found_reason: str,
    ) -> tuple[str | None, str, list[str]]:
        ids = self.candidate_ids(candidates)
        if not candidates:
            return None, not_found_reason, ids
        unresolved = [item for item in candidates if item.get("identity_state") != "resolved"]
        resolved = [item for item in candidates if item.get("identity_state") == "resolved"]
        if unresolved:
            reason = "canonical_identity_conflict" if resolved else "canonical_identity_not_resolved"
            return None, reason, ids
        if len(resolved) == 1:
            return scalar(resolved[0].get("entity_id")), resolved_reason, ids
        return None, ambiguous_reason, ids

    def resolve_qmgr(self, hints: dict[str, Any]) -> tuple[str | None, str, list[str]]:
        qmid = lower(hints.get("queue_manager_qmid"))
        name = lower(hints.get("queue_manager_name"))
        if qmid:
            candidates = self.qmgr_by_qmid.get(qmid, [])
            entity_id, reason, ids = self._unique_resolved(
                candidates,
                resolved_reason="resolved_by_qmid",
                ambiguous_reason="ambiguous_qmid",
                not_found_reason="qmid_not_found",
            )
            if not entity_id:
                return None, reason, ids
            candidate = self.by_id[entity_id]
            candidate_name = lower(candidate.get("display_name"))
            if name and candidate_name and candidate_name != name:
                return None, "queue_manager_identity_mismatch", ids
            return entity_id, reason, ids
        if not name:
            return None, "missing_queue_manager_identity", []
        return self._unique_resolved(
            self.qmgr_by_name.get(name, []),
            resolved_reason="resolved_by_name",
            ambiguous_reason="ambiguous_queue_manager_name",
            not_found_reason="queue_manager_name_not_found",
        )

    def resolve_observation(self, observation: dict[str, Any]) -> tuple[str | None, str, list[str]]:
        entity = observation.get("entity")
        if not isinstance(entity, dict):
            return None, "invalid_entity", []
        supplied = entity.get("canonical_entity_id")
        if supplied not in (None, ""):
            return None, "untrusted_canonical_id_supplied", []
        semantic_type = scalar(entity.get("semantic_type"))
        hints = entity.get("identity_hints")
        if not isinstance(hints, dict):
            return None, "missing_identity_hints", []
        source = observation.get("source") if isinstance(observation.get("source"), dict) else {}
        source_qmgr = lower(source.get("queue_manager"))
        hint_qmgr = lower(hints.get("queue_manager_name"))
        if source_qmgr and hint_qmgr and source_qmgr != hint_qmgr:
            return None, "source_identity_mismatch", []
        if semantic_type == "mq.queue_manager":
            return self.resolve_qmgr(hints)
        if semantic_type in SUPPORTED_SCOPED:
            qmgr_name = hint_qmgr
            object_name = lower(hints.get("name"))
            if not qmgr_name or not object_name:
                return None, "missing_scoped_identity", []
            if lower(hints.get("queue_manager_qmid")):
                owner_id, owner_reason, owner_candidates = self.resolve_qmgr(hints)
                if not owner_id:
                    return None, owner_reason, owner_candidates
            return self._unique_resolved(
                self.scoped.get((semantic_type, qmgr_name, object_name), []),
                resolved_reason="resolved_by_scoped_identity",
                ambiguous_reason="ambiguous_scoped_identity",
                not_found_reason="scoped_identity_not_found",
            )
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
