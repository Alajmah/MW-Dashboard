#!/usr/bin/env python3
"""Offline analyzer for OSI IBM MQ historical diagnostic-log corpora.

The analyzer never connects to MQ, never writes to D1, and never modifies the source
archive. It produces derived local analysis artifacts that can be reviewed for demo value.
"""
from __future__ import annotations

import argparse
import bz2
import csv
import gzip
import hashlib
import io
import json
import lzma
import re
import shutil
import tarfile
import tempfile
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, TextIO

VERSION = "1.0.0"
AMQ_RE = re.compile(r"\b(AMQ\d{4})([A-Z])?\b")
FDC_FIELD_RE = re.compile(r"^\s*(Date/Time|UTC Time|Probe Id|Component|Program Name|QMgr Name)\s*[:-]+\s*(.*?)\s*$", re.I)
TS_PATTERNS = [
    re.compile(r"^(\d{1,2}/\d{1,2}/\d{4}\s+\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\s*(?:AM|PM)?)", re.I),
    re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)"),
    re.compile(r"^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})"),
]
IP_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
HEX_RE = re.compile(r"\b0x[0-9a-f]+\b", re.I)
NUM_RE = re.compile(r"\b\d{4,}\b")
SPACE_RE = re.compile(r"\s+")

CATEGORY_KEYWORDS = {
    "tls_security": ("ssl", "tls", "certificate", "cipher", "handshake"),
    "authorization": ("not authorized", "authorization", "authority", "2035", "mqrc_not_authorized"),
    "connectivity_channel": ("channel", "connection", "socket", "tcp", "receive from host", "remote host", "retry"),
    "queue_manager_lifecycle": ("queue manager", "starting", "started", "ending", "ended", "stopping", "stopped", "quiesc"),
    "storage_resource": ("disk", "filesystem", "space", "resource", "memory", "storage", "full"),
    "cluster": ("cluster", "repository", "clus"),
    "high_availability": ("multi-instance", "standby", "failover", "recovery", "recovered"),
    "application_connectivity": ("application", "client", "svrconn", "connect", "disconnect"),
}

@dataclass
class MessageStat:
    count: int = 0
    files: set[str] = field(default_factory=set)
    first_seen: str | None = None
    last_seen: str | None = None
    severities: Counter = field(default_factory=Counter)
    categories: Counter = field(default_factory=Counter)
    example: str = ""

@dataclass
class FdcStat:
    count: int = 0
    files: set[str] = field(default_factory=set)
    first_seen: str | None = None
    last_seen: str | None = None
    component: str = ""
    program: str = ""


def safe_extract(archive: Path, destination: Path) -> Path:
    with tarfile.open(archive, "r:*") as tf:
        root = destination.resolve()
        members = tf.getmembers()
        for member in members:
            target = (destination / member.name).resolve()
            if root != target and root not in target.parents:
                raise ValueError(f"unsafe archive member: {member.name}")
            if member.issym() or member.islnk():
                raise ValueError(f"links are not accepted in analysis corpus: {member.name}")
        tf.extractall(destination, members=members)
    top = [p for p in destination.iterdir() if p.is_dir()]
    return top[0] if len(top) == 1 else destination


def open_text(path: Path) -> TextIO:
    lower = path.name.lower()
    if lower.endswith(".gz"):
        return io.TextIOWrapper(gzip.open(path, "rb"), encoding="utf-8", errors="replace")
    if lower.endswith(".bz2"):
        return io.TextIOWrapper(bz2.open(path, "rb"), encoding="utf-8", errors="replace")
    if lower.endswith(".xz") or lower.endswith(".lzma"):
        return io.TextIOWrapper(lzma.open(path, "rb"), encoding="utf-8", errors="replace")
    return path.open("r", encoding="utf-8", errors="replace")


def parse_timestamp(line: str) -> str | None:
    for pattern in TS_PATTERNS:
        match = pattern.search(line)
        if not match:
            continue
        raw = match.group(1)
        candidates = [
            "%m/%d/%Y %I:%M:%S %p",
            "%m/%d/%Y %H:%M:%S",
            "%Y-%m-%d %H:%M:%S",
        ]
        try:
            if "T" in raw:
                value = raw.replace("Z", "+00:00")
                return datetime.fromisoformat(value).isoformat()
        except ValueError:
            pass
        raw_no_fraction = raw.split(".", 1)[0] if "." in raw and "T" not in raw else raw
        for fmt in candidates:
            try:
                dt = datetime.strptime(raw_no_fraction.strip(), fmt)
                return dt.isoformat()
            except ValueError:
                pass
        return raw
    return None


def normalize_signature(text: str) -> str:
    text = IP_RE.sub("<ip>", text.lower())
    text = HEX_RE.sub("<hex>", text)
    text = NUM_RE.sub("<n>", text)
    return SPACE_RE.sub(" ", text).strip()[:500]


def classify(text: str) -> str:
    lower = text.lower()
    scores = [(sum(1 for keyword in keys if keyword in lower), name) for name, keys in CATEGORY_KEYWORDS.items()]
    score, name = max(scores, default=(0, "other"))
    return name if score else "other"


def update_range(stat: MessageStat | FdcStat, timestamp: str | None) -> None:
    if not timestamp:
        return
    if stat.first_seen is None or timestamp < stat.first_seen:
        stat.first_seen = timestamp
    if stat.last_seen is None or timestamp > stat.last_seen:
        stat.last_seen = timestamp


def iter_candidate_files(root: Path) -> Iterable[Path]:
    raw = root / "raw"
    if not raw.exists():
        raw = root
    for path in raw.rglob("*"):
        if not path.is_file():
            continue
        name = path.name.lower()
        if name.endswith((".rc", ".command", ".sha256")):
            continue
        if name in {"package-checksums.sha256", "manifest.tsv", "manifest.properties"}:
            continue
        yield path


def analyze(root: Path, out_dir: Path) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    messages: dict[str, MessageStat] = defaultdict(MessageStat)
    fdcs: dict[str, FdcStat] = defaultdict(FdcStat)
    signature_counts: Counter[str] = Counter()
    category_counts: Counter[str] = Counter()
    severity_counts: Counter[str] = Counter()
    file_count = 0
    total_bytes = 0
    lines_scanned = 0
    event_count = 0
    earliest: str | None = None
    latest: str | None = None
    events_path = out_dir / "events.ndjson.gz"

    with gzip.open(events_path, "wt", encoding="utf-8") as events:
        for path in iter_candidate_files(root):
            file_count += 1
            try:
                total_bytes += path.stat().st_size
            except OSError:
                pass
            rel = str(path.relative_to(root)) if path.is_relative_to(root) else str(path)
            current_ts: str | None = None
            fdc_fields: dict[str, str] = {}
            try:
                handle = open_text(path)
            except OSError:
                continue
            with handle:
                for raw in handle:
                    lines_scanned += 1
                    line = raw.rstrip("\r\n")
                    ts = parse_timestamp(line)
                    if ts:
                        current_ts = ts
                        if earliest is None or ts < earliest:
                            earliest = ts
                        if latest is None or ts > latest:
                            latest = ts

                    field_match = FDC_FIELD_RE.match(line)
                    if field_match:
                        key = field_match.group(1).lower().replace(" ", "_")
                        fdc_fields[key] = field_match.group(2).strip()
                        if key == "probe_id":
                            probe = fdc_fields.get("probe_id", "")
                            component = fdc_fields.get("component", "")
                            program = fdc_fields.get("program_name", "")
                            signature = f"{probe}|{component}|{program}"
                            stat = fdcs[signature]
                            stat.count += 1
                            stat.files.add(rel)
                            stat.component = component
                            stat.program = program
                            update_range(stat, current_ts)

                    for match in AMQ_RE.finditer(line):
                        code = match.group(1)
                        severity = match.group(2) or ""
                        category = classify(line)
                        signature = normalize_signature(line)
                        stat = messages[code]
                        stat.count += 1
                        stat.files.add(rel)
                        stat.severities[severity or "unknown"] += 1
                        stat.categories[category] += 1
                        if not stat.example:
                            stat.example = line.strip()[:300]
                        update_range(stat, current_ts)
                        signature_counts[signature] += 1
                        category_counts[category] += 1
                        severity_counts[severity or "unknown"] += 1
                        event_count += 1
                        events.write(json.dumps({
                            "timestamp": current_ts,
                            "source_file": rel,
                            "event_type": "mq_message",
                            "code": code,
                            "severity": severity or None,
                            "category": category,
                            "summary": line.strip()[:1000],
                            "signature_sha256": hashlib.sha256(signature.encode()).hexdigest(),
                        }, ensure_ascii=False) + "\n")

    with (out_dir / "mq-message-catalog.csv").open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(["message_id", "count", "files", "first_seen", "last_seen", "severities", "categories", "example"])
        for code, stat in sorted(messages.items(), key=lambda item: (-item[1].count, item[0])):
            writer.writerow([
                code, stat.count, len(stat.files), stat.first_seen or "", stat.last_seen or "",
                json.dumps(stat.severities, sort_keys=True), json.dumps(stat.categories, sort_keys=True), stat.example,
            ])

    with (out_dir / "fdc-signatures.csv").open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(["signature", "count", "files", "first_seen", "last_seen", "component", "program"])
        for signature, stat in sorted(fdcs.items(), key=lambda item: (-item[1].count, item[0])):
            writer.writerow([signature, stat.count, len(stat.files), stat.first_seen or "", stat.last_seen or "", stat.component, stat.program])

    candidates = []
    for code, stat in messages.items():
        error_weight = stat.severities.get("E", 0) * 5 + stat.severities.get("W", 0) * 3
        recurrence = min(stat.count, 100)
        breadth = min(len(stat.files) * 2, 20)
        time_span_bonus = 10 if stat.first_seen and stat.last_seen and stat.first_seen != stat.last_seen else 0
        score = error_weight + recurrence + breadth + time_span_bonus
        top_category = stat.categories.most_common(1)[0][0] if stat.categories else "other"
        candidates.append({
            "message_id": code,
            "score": score,
            "count": stat.count,
            "file_count": len(stat.files),
            "first_seen": stat.first_seen,
            "last_seen": stat.last_seen,
            "category": top_category,
            "severities": dict(stat.severities),
            "example": stat.example,
            "demo_use": "candidate_only_requires_operator_review",
        })
    candidates.sort(key=lambda item: (-item["score"], -item["count"], item["message_id"]))

    summary = {
        "schema_version": "osi.mq-log-analysis/v1",
        "analyzer_version": VERSION,
        "analyzed_at": datetime.now(timezone.utc).isoformat(),
        "source_root": str(root),
        "files_scanned": file_count,
        "bytes_scanned": total_bytes,
        "lines_scanned": lines_scanned,
        "mq_message_occurrences": event_count,
        "unique_mq_message_ids": len(messages),
        "fdc_signature_count": len(fdcs),
        "earliest_observed_timestamp": earliest,
        "latest_observed_timestamp": latest,
        "severity_counts": dict(severity_counts),
        "category_counts": dict(category_counts),
        "top_message_ids": [
            {"message_id": code, "count": stat.count}
            for code, stat in sorted(messages.items(), key=lambda item: (-item[1].count, item[0]))[:50]
        ],
        "top_normalized_signatures": [
            {"signature": signature, "count": count}
            for signature, count in signature_counts.most_common(50)
        ],
        "limitations": [
            "Historical log retention bounds are whatever the source host retained at collection time.",
            "Timestamp parsing is best-effort; unparsed events retain null timestamps.",
            "Categories and demo-candidate scores are heuristic discovery aids, not operational findings.",
            "No database persistence or canonical-entity mapping is performed by this analyzer.",
        ],
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (out_dir / "demo-candidates.json").write_text(json.dumps({
        "schema_version": "osi.mq-log-demo-candidates/v1",
        "generated_at": summary["analyzed_at"],
        "candidates": candidates[:100],
        "notice": "Candidates are ranked for discovery only. Validate against topology/runtime evidence before using them in the demo.",
    }, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description="Analyze an OSI IBM MQ historical log corpus offline")
    parser.add_argument("input", help="mq-log-history-*.tar.gz archive or extracted corpus directory")
    parser.add_argument("--output-dir", help="Directory for derived analysis files")
    args = parser.parse_args()

    source = Path(args.input).expanduser().resolve()
    output = Path(args.output_dir).expanduser().resolve() if args.output_dir else Path.cwd() / f"mq-log-analysis-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    temp: Path | None = None
    try:
        if source.is_dir():
            root = source
        else:
            temp = Path(tempfile.mkdtemp(prefix="osi-mq-log-analysis."))
            root = safe_extract(source, temp)
        summary = analyze(root, output)
        print(json.dumps({
            "output_dir": str(output),
            "files_scanned": summary["files_scanned"],
            "mq_message_occurrences": summary["mq_message_occurrences"],
            "unique_mq_message_ids": summary["unique_mq_message_ids"],
            "fdc_signature_count": summary["fdc_signature_count"],
        }, indent=2))
        return 0
    finally:
        if temp:
            shutil.rmtree(temp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
