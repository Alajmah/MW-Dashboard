#!/usr/bin/env python3
"""Build an offline OSI demo evidence campaign index.

This tool never uploads evidence and never writes to the dashboard database.
It inventories manually transferred evidence packages and analyzer outputs,
preserves hashes/provenance, and surfaces unreviewed candidate stories.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import tarfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

VERSION = "1.0.0"
MAX_MANIFEST_BYTES = 2 * 1024 * 1024
SUPPORTED_ARCHIVE_SUFFIXES = (".tar.gz", ".tgz", ".tar", ".zip")


def utc_iso(ts: float | None = None) -> str:
    dt = datetime.fromtimestamp(ts, timezone.utc) if ts is not None else datetime.now(timezone.utc)
    return dt.isoformat()


def sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(chunk_size)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def tree_fingerprint(root: Path) -> tuple[str, int, int]:
    """Hash a directory deterministically without following symlinks."""
    h = hashlib.sha256()
    total_bytes = 0
    file_count = 0
    files = (p for p in root.rglob("*") if p.is_file() and not p.is_symlink())
    for path in sorted(files, key=lambda p: str(p.relative_to(root))):
        rel = path.relative_to(root).as_posix()
        size = path.stat().st_size
        digest = sha256_file(path)
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        h.update(str(size).encode("ascii"))
        h.update(b"\0")
        h.update(digest.encode("ascii"))
        h.update(b"\n")
        total_bytes += size
        file_count += 1
    return h.hexdigest(), total_bytes, file_count


def parse_properties(text: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        result[key.strip()] = value.strip()
    return result


def read_tar_manifest(path: Path) -> dict[str, str]:
    """Read manifest.properties from a tar package without extracting it."""
    try:
        with tarfile.open(path, "r:*") as tf:
            members = [
                m for m in tf.getmembers()
                if m.isfile()
                and m.name.endswith("/manifest.properties")
                and 0 <= m.size <= MAX_MANIFEST_BYTES
            ]
            if not members:
                return {}
            member = sorted(members, key=lambda m: (m.name.count("/"), m.name))[0]
            fh = tf.extractfile(member)
            if fh is None:
                return {}
            return parse_properties(fh.read(MAX_MANIFEST_BYTES + 1).decode("utf-8", errors="replace"))
    except (tarfile.TarError, OSError):
        return {}


def classify_path(path: Path) -> tuple[str, str] | None:
    name = path.name.lower()
    full = str(path).lower()
    if path.is_file():
        if name.startswith("mq-topology-") and name.endswith((".tar.gz", ".tgz", ".tar")):
            return "ibm_mq", "topology_runtime_archive"
        if name.startswith("mq-log-history-") and name.endswith((".tar.gz", ".tgz", ".tar")):
            return "ibm_mq", "historical_diagnostic_logs"
        if name.startswith("ace-log-history-") and name.endswith((".tar.gz", ".tgz", ".tar")):
            return "ibm_ace", "historical_diagnostic_logs"
        if name.startswith("osi-findings-") and name.endswith(".json"):
            return "ibm_mq", "operational_findings"
        if "datapower" in full and name.endswith(SUPPORTED_ARCHIVE_SUFFIXES):
            return "ibm_datapower", "manual_log_export"
    elif path.is_dir() and "datapower" in name:
        return "ibm_datapower", "manual_log_export"
    return None


def json_read(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None


def artifact_record(path: Path, root: Path, product: str, evidence_class: str) -> dict[str, Any]:
    rel = path.relative_to(root).as_posix()
    if path.is_file():
        digest = sha256_file(path)
        size = path.stat().st_size
        file_count = 1
        modified = utc_iso(path.stat().st_mtime)
        manifest = read_tar_manifest(path) if path.name.lower().endswith((".tar.gz", ".tgz", ".tar")) else {}
    else:
        digest, size, file_count = tree_fingerprint(path)
        modified = utc_iso(path.stat().st_mtime)
        manifest = {}
    return {
        "artifact_id": "evid_" + digest[:24],
        "product": product,
        "evidence_class": evidence_class,
        "path": rel,
        "kind": "file" if path.is_file() else "directory",
        "bytes": size,
        "file_count": file_count,
        "sha256": digest,
        "modified_at": modified,
        "source_metadata": {
            key: manifest[key]
            for key in (
                "format",
                "format_version",
                "collector_version",
                "host",
                "started_at_utc",
                "completed_at_utc",
                "samples",
                "interval_seconds",
                "queue_manager_count",
            )
            if key in manifest
        },
    }


def discover_artifacts(root: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    consumed_dirs: set[Path] = set()

    # DataPower manual-export directories are treated as one immutable evidence unit.
    directories = (p for p in root.rglob("*") if p.is_dir() and not p.is_symlink())
    for path in sorted(directories, key=lambda p: str(p)):
        classification = classify_path(path)
        if classification:
            product, evidence_class = classification
            records.append(artifact_record(path, root, product, evidence_class))
            consumed_dirs.add(path)

    files = (p for p in root.rglob("*") if p.is_file() and not p.is_symlink())
    for path in sorted(files, key=lambda p: str(p)):
        if any(parent in consumed_dirs for parent in path.parents):
            continue
        classification = classify_path(path)
        if not classification:
            # Contract-aware fallback for findings whose filenames changed.
            if path.suffix.lower() == ".json":
                doc = json_read(path)
                if isinstance(doc, dict) and doc.get("schema_version") == "osi.findings.evaluation/v1":
                    classification = ("ibm_mq", "operational_findings")
            if not classification:
                continue
        product, evidence_class = classification
        records.append(artifact_record(path, root, product, evidence_class))
    return records


def discover_analysis(root: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    analyses: list[dict[str, Any]] = []
    candidates: list[dict[str, Any]] = []
    for summary_path in sorted(root.rglob("summary.json")):
        if not summary_path.is_file() or summary_path.is_symlink():
            continue
        directory = summary_path.parent
        candidate_path = directory / "demo-candidates.json"
        summary = json_read(summary_path)
        candidate_doc = json_read(candidate_path) if candidate_path.exists() else None
        if not isinstance(summary, dict):
            continue

        schema = str(summary.get("schema_version", ""))
        if schema == "osi.mq-log-analysis/v1":
            product = "ibm_mq"
        elif schema == "osi.historical-log-analysis/v1":
            source_product = str(summary.get("product", "")).lower()
            product = {"ace": "ibm_ace", "datapower": "ibm_datapower"}.get(source_product, "unknown")
        else:
            continue

        summary_digest = sha256_file(summary_path)
        analyses.append({
            "analysis_id": "analysis_" + summary_digest[:24],
            "product": product,
            "path": directory.relative_to(root).as_posix(),
            "summary_schema": schema,
            "summary_sha256": summary_digest,
            "candidate_file_present": candidate_path.exists(),
            "candidate_file_sha256": sha256_file(candidate_path) if candidate_path.exists() else None,
        })

        raw_candidates = candidate_doc.get("candidates", []) if isinstance(candidate_doc, dict) else []
        if not isinstance(raw_candidates, list):
            continue
        for rank, item in enumerate(raw_candidates, 1):
            if not isinstance(item, dict):
                continue
            identity = json.dumps(
                {"product": product, "analysis": directory.relative_to(root).as_posix(), "rank": rank, "item": item},
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
            ).encode("utf-8")
            cid = "cand_" + hashlib.sha256(identity).hexdigest()[:24]
            candidates.append({
                "candidate_id": cid,
                "product": product,
                "analysis_path": directory.relative_to(root).as_posix(),
                "rank": rank,
                "state": "unreviewed",
                "score": item.get("score"),
                "count": item.get("count"),
                "key": item.get("message_id") or item.get("key"),
                "kind": item.get("kind") or ("mq_message" if item.get("message_id") else "pattern"),
                "category": item.get("category"),
                "first_seen": item.get("first_seen"),
                "last_seen": item.get("last_seen"),
                "required_corroboration": [
                    "source_log_excerpt",
                    "canonical_identity_or_explicit_unresolved_identity",
                    "topology_or_route_context",
                    "runtime_observation_or_finding_when_available",
                    "recovery_or_change_evidence_when_claimed",
                ],
            })
    return analyses, candidates


def discover_episodes(root: Path) -> list[dict[str, Any]]:
    episodes: list[dict[str, Any]] = []
    for path in sorted(root.rglob("*.demo-episode.json")):
        if not path.is_file() or path.is_symlink():
            continue
        doc = json_read(path)
        if not isinstance(doc, dict) or doc.get("schema_version") != "osi.demo.episode/v1":
            continue
        state = str(doc.get("state", "draft"))
        episodes.append({
            "episode_id": str(doc.get("episode_id", path.stem)),
            "title": str(doc.get("title", "")),
            "state": state,
            "path": path.relative_to(root).as_posix(),
            "sha256": sha256_file(path),
            "products": doc.get("products", []),
            "candidate_refs": doc.get("candidate_refs", []),
            "evidence_refs": doc.get("evidence_refs", []),
        })
    return episodes


def campaign_gaps(artifacts: list[dict[str, Any]], analyses: list[dict[str, Any]]) -> list[dict[str, str]]:
    pairs = {(a["product"], a["evidence_class"]) for a in artifacts}
    products_with_analysis = {a["product"] for a in analyses}
    checks = [
        ("ibm_mq", "topology_runtime_archive", "No MQ topology/runtime archive was indexed."),
        ("ibm_mq", "historical_diagnostic_logs", "No MQ historical diagnostic corpus was indexed."),
        ("ibm_ace", "historical_diagnostic_logs", "No ACE historical diagnostic corpus was indexed."),
        ("ibm_datapower", "manual_log_export", "No DataPower manual log export was indexed."),
    ]
    gaps = [
        {"product": product, "evidence_class": evidence_class, "state": "not_indexed", "message": message}
        for product, evidence_class, message in checks
        if (product, evidence_class) not in pairs
    ]
    for product in ("ibm_mq", "ibm_ace", "ibm_datapower"):
        if any(a["product"] == product for a in artifacts) and product not in products_with_analysis:
            gaps.append({
                "product": product,
                "evidence_class": "offline_analysis",
                "state": "not_indexed",
                "message": f"Evidence exists for {product}, but no recognized offline analysis output was indexed.",
            })
    return gaps


def main() -> int:
    parser = argparse.ArgumentParser(description="Index manually transferred OSI demo evidence without database writes")
    parser.add_argument("root", help="Campaign root containing evidence packages and offline analyzer outputs")
    parser.add_argument("--output", default="campaign-index.json", help="Output JSON path")
    args = parser.parse_args()

    root = Path(args.root).expanduser().resolve()
    if not root.is_dir():
        parser.error(f"campaign root is not a directory: {root}")

    output = Path(args.output).expanduser().resolve()
    artifacts = discover_artifacts(root)
    analyses, candidates = discover_analysis(root)
    episodes = discover_episodes(root)
    product_counts = Counter(a["product"] for a in artifacts)
    class_counts = Counter(a["evidence_class"] for a in artifacts)
    digest_material = "\n".join(sorted(a["sha256"] for a in artifacts)).encode("ascii")
    campaign_hash = hashlib.sha256(digest_material).hexdigest()

    result = {
        "schema_version": "osi.demo.evidence-campaign/v1",
        "tool_version": VERSION,
        "campaign_id": "campaign_" + campaign_hash[:24],
        "generated_at": utc_iso(),
        "source_root_name": root.name,
        "operating_mode": "manual_osi_handoff",
        "database_written": False,
        "artifacts": artifacts,
        "analyses": analyses,
        "candidates": candidates,
        "episodes": episodes,
        "gaps": campaign_gaps(artifacts, analyses),
        "summary": {
            "artifact_count": len(artifacts),
            "artifact_bytes": sum(int(a["bytes"]) for a in artifacts),
            "analysis_count": len(analyses),
            "candidate_count": len(candidates),
            "product_artifact_counts": dict(product_counts),
            "evidence_class_counts": dict(class_counts),
            "qualified_demo_episode_count": sum(1 for e in episodes if e["state"] == "qualified"),
        },
        "qualification_notice": (
            "Candidates are discovery output only. This index never auto-qualifies a demo episode. "
            "Qualification requires operator review and corroboration against source evidence, canonical "
            "identity/topology, runtime/findings, and recovery/change evidence when claimed."
        ),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({
        "output": str(output),
        "campaign_id": result["campaign_id"],
        "artifacts": len(artifacts),
        "analyses": len(analyses),
        "candidates": len(candidates),
        "episodes": len(episodes),
        "gaps": len(result["gaps"]),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
