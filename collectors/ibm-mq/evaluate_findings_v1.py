#!/usr/bin/env python3
"""OSI Phase 2 Findings v1 evaluator for IBM MQ raw evidence.

This is deliberately an offline/read-only evaluator. It reads an existing
mq-topology-*.tar.gz collector artifact, promotes selected runtime facts into
OSI-owned operational observations, evaluates a conservative first rule set,
and emits evidence-linked findings.

It does not connect to IBM MQ, mutate queue-manager state, consume event queues,
or depend on Prometheus/Grafana/OpenTelemetry or any third-party monitoring
runtime.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import tarfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import PurePosixPath
from typing import Any, Iterable

SCHEMA_VERSION = "osi.findings.evaluation/v1"
EVALUATOR_VERSION = "1.0.0"

DISPLAY_MARKER_RE = re.compile(r"^AMQ\d+[A-Z]:\s+Display\b", re.IGNORECASE)
ATTRIBUTE_RE = re.compile(r"\b([A-Z][A-Z0-9_]*)\(([^()]*)\)")
MQ_MESSAGE_RE = re.compile(r"\b(AMQ\d{4}[A-Z]):\s*([^\r\n]*)", re.IGNORECASE)
EMPTY_ENUMERATION_CODES = frozenset({"AMQ8147E", "AMQ8933I"})

NORMAL_QMGR_STATES = frozenset({"RUNNING"})
NORMAL_LISTENER_STATES = frozenset({"RUNNING"})
NORMAL_CHANNEL_STATES = frozenset({"RUNNING"})


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def sha256_file(filename: str) -> str:
    digest = hashlib.sha256()
    with open(filename, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_id(semantic_type: str, rule: str, key: str) -> str:
    return "cent_" + sha256_text(f"{semantic_type}|{rule}|{key}")[:24]


def qmgr_entity_id(name: str, qmid: str | None = None) -> str:
    if qmid:
        return canonical_id("mq.queue_manager", "qmid", qmid.strip().lower())
    return canonical_id("mq.queue_manager", "name", name.strip().lower())


def scoped_entity_id(semantic_type: str, qmgr: str, name: str) -> str:
    key = f"queue_manager_key={qmgr.strip().lower()}|name={name.strip().lower()}"
    return canonical_id(semantic_type, "rule_2", key)


def finding_id(rule_id: str, entity_id: str) -> str:
    return "find_" + sha256_text(f"{rule_id}|{entity_id}")[:24]


def observation_id(entity_id: str, observation_type: str, sample_id: str, evidence_ref: str) -> str:
    return "obs_" + sha256_text(f"{entity_id}|{observation_type}|{sample_id}|{evidence_ref}")[:24]


def parse_int(value: Any) -> int | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text or text in {"-", "N/A"}:
        return None
    try:
        return int(text)
    except ValueError:
        return None


def parse_blocks(text: str) -> list[dict[str, str]]:
    """Parse DISPLAY output into records without relying on product libraries."""
    records: list[dict[str, str]] = []
    current: dict[str, str] = {}
    saw_marker = False
    for line in text.splitlines():
        if DISPLAY_MARKER_RE.search(line.strip()):
            if saw_marker and current:
                records.append(current)
                current = {}
            saw_marker = True
            continue
        if not saw_marker:
            continue
        for key, value in ATTRIBUTE_RE.findall(line):
            current[key] = value.strip()
    if current:
        records.append(current)
    return records


def iso_to_epoch(value: str) -> float:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def elapsed_seconds(samples: list["SampleRecord"]) -> float:
    if len(samples) < 2:
        return 0.0
    return max(0.0, iso_to_epoch(samples[-1].observed_at) - iso_to_epoch(samples[0].observed_at))


class RawArchive:
    def __init__(self, filename: str):
        self.filename = filename
        self.tf = tarfile.open(filename, "r:gz")
        roots = {
            PurePosixPath(member.name).parts[0]
            for member in self.tf.getmembers()
            if member.name and PurePosixPath(member.name).parts
        }
        if len(roots) != 1:
            self.tf.close()
            raise ValueError("raw archive must contain exactly one top-level directory")
        self.root = next(iter(roots))
        self._names = {member.name for member in self.tf.getmembers() if member.isfile()}

    def close(self) -> None:
        self.tf.close()

    def has(self, rel: str) -> bool:
        return f"{self.root}/{rel}" in self._names

    def text(self, rel: str, required: bool = True) -> str:
        name = f"{self.root}/{rel}"
        try:
            member = self.tf.getmember(name)
        except KeyError:
            if required:
                raise ValueError(f"archive member missing: {rel}")
            return ""
        fh = self.tf.extractfile(member)
        if fh is None:
            if required:
                raise ValueError(f"archive member is not readable: {rel}")
            return ""
        return fh.read().decode("utf-8", errors="replace")

    def members(self, prefix: str) -> list[str]:
        wanted = f"{self.root}/{prefix.rstrip('/')}/"
        out: list[str] = []
        for member in self.tf.getmembers():
            if member.isfile() and member.name.startswith(wanted):
                out.append(member.name[len(self.root) + 1 :])
        return out


@dataclass(frozen=True)
class CommandOutcome:
    mode: str
    evidence_ref: str
    error: str | None
    process_rc: int | None
    empty_result: bool = False


@dataclass(frozen=True)
class SampleRecord:
    qmgr: str
    object_name: str
    semantic_type: str
    sample_id: str
    observed_at: str
    evidence_ref: str
    values: dict[str, str]


def read_rc(archive: RawArchive, base: str) -> int | None:
    raw = archive.text(base + ".rc", False).strip()
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def command_outcome(archive: RawArchive, base: str, success_mode: str = "point_in_time") -> CommandOutcome:
    evidence_ref = base + ".out"
    if not archive.has(evidence_ref) and not archive.has(base + ".rc"):
        return CommandOutcome("not_collected", evidence_ref, "command evidence missing", None)
    rc = read_rc(archive, base)
    out = archive.text(evidence_ref, False)
    err = archive.text(base + ".err", False)
    messages = [(code.upper(), text.strip()) for code, text in MQ_MESSAGE_RE.findall(out + "\n" + err)]
    command = archive.text(base + ".mqsc", False).strip()
    codes = {code for code, _ in messages}
    wildcard = command.upper().startswith("DISPLAY ") and "(*)" in command.upper()
    known_empty = (
        rc == 10
        and wildcard
        and bool(messages)
        and codes.issubset(EMPTY_ENUMERATION_CODES)
        and all("not found" in text.lower() for _, text in messages)
    )
    if known_empty:
        return CommandOutcome(success_mode, evidence_ref, None, rc, True)
    error_codes = sorted(code for code in codes if code.endswith("E"))
    if rc not in (None, 0) or error_codes:
        parts = []
        if rc not in (None, 0):
            parts.append(f"process rc={rc}")
        if error_codes:
            parts.append("MQ errors=" + ",".join(error_codes))
        return CommandOutcome("failed", evidence_ref, "; ".join(parts) or "command failed", rc)
    return CommandOutcome(success_mode, evidence_ref, None, rc)


def qmgr_rows(archive: RawArchive) -> list[tuple[str, str]]:
    rows: list[tuple[str, str]] = []
    for line in archive.text("qmgrs.tsv").splitlines()[1:]:
        if "\t" not in line:
            continue
        qdir, qname = [part.strip() for part in line.split("\t", 1)]
        if qdir and qname:
            rows.append((qdir, qname))
    return rows


def runtime_samples(archive: RawArchive, qdir: str) -> list[str]:
    found = set()
    for rel in archive.members(f"qmgr/{qdir}/runtime"):
        parts = PurePosixPath(rel).parts
        if len(parts) >= 4 and parts[0] == "qmgr" and parts[1] == qdir and parts[2] == "runtime":
            found.add(parts[3])
    return sorted(found)


def sample_time(archive: RawArchive, qdir: str, sample: str, fallback: str) -> str:
    value = archive.text(f"qmgr/{qdir}/runtime/{sample}/captured-at-utc.txt", False).strip()
    return value or fallback


def manifest(archive: RawArchive) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in archive.text("manifest.properties").splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            result[key.strip()] = value.strip()
    return result


def qmgr_config(archive: RawArchive, qdir: str) -> dict[str, str]:
    base = f"qmgr/{qdir}/config/qmgr"
    if command_outcome(archive, base, "complete").mode != "complete":
        return {}
    blocks = parse_blocks(archive.text(base + ".out", False))
    return blocks[0] if blocks else {}


def sample_records(
    archive: RawArchive,
    qdir: str,
    qmgr: str,
    sample: str,
    label: str,
    semantic_type: str,
    object_field: str,
    fallback_time: str,
) -> tuple[CommandOutcome, list[SampleRecord]]:
    base = f"qmgr/{qdir}/runtime/{sample}/{label}"
    outcome = command_outcome(archive, base)
    if outcome.mode != "point_in_time":
        return outcome, []
    observed_at = sample_time(archive, qdir, sample, fallback_time)
    records: list[SampleRecord] = []
    for values in parse_blocks(archive.text(base + ".out", False)):
        name = values.get(object_field, "").strip()
        if not name:
            if semantic_type == "mq.queue_manager":
                name = qmgr
            else:
                continue
        records.append(SampleRecord(qmgr, name, semantic_type, sample, observed_at, outcome.evidence_ref, values))
    return outcome, records


def series_by_object(records: Iterable[SampleRecord]) -> dict[str, list[SampleRecord]]:
    result: dict[str, list[SampleRecord]] = {}
    for record in records:
        result.setdefault(record.object_name, []).append(record)
    for items in result.values():
        items.sort(key=lambda item: item.observed_at)
    return result


def linear_slope(values: list[int | float]) -> float:
    n = len(values)
    if n < 2:
        return 0.0
    xs = list(range(n))
    xbar = sum(xs) / n
    ybar = sum(values) / n
    denom = sum((x - xbar) ** 2 for x in xs)
    if denom == 0:
        return 0.0
    return sum((x - xbar) * (y - ybar) for x, y in zip(xs, values)) / denom


def queue_backlog_increasing(samples: list[SampleRecord]) -> bool:
    if len(samples) < 3:
        return False
    depths = [parse_int(item.values.get("CURDEPTH")) for item in samples]
    if any(value is None for value in depths):
        return False
    values = [int(value) for value in depths if value is not None]
    if values[-1] <= values[0] or values[-1] <= 0:
        return False
    if linear_slope(values) <= 0:
        return False
    tail = values[-3:]
    if any(right < left for left, right in zip(tail, tail[1:])):
        return False
    positive_steps = sum(1 for left, right in zip(values, values[1:]) if right > left)
    return positive_steps >= max(2, math.ceil((len(values) - 1) * 0.5))


def queue_oldest_message_aging(samples: list[SampleRecord]) -> bool:
    if len(samples) < 3:
        return False
    ages = [parse_int(item.values.get("MSGAGE")) for item in samples]
    depths = [parse_int(item.values.get("CURDEPTH")) for item in samples]
    if any(value is None for value in ages) or any(value is None for value in depths):
        return False
    a = [int(value) for value in ages if value is not None]
    d = [int(value) for value in depths if value is not None]
    if min(d[-3:]) <= 0 or a[-1] <= a[0] or a[-1] <= 0:
        return False
    if any(right < left for left, right in zip(a[-3:], a[-2:])):
        return False
    elapsed = elapsed_seconds(samples)
    growth = a[-1] - a[0]
    return elapsed > 0 and growth >= elapsed * 0.55


def all_zero_input_processes(samples: list[SampleRecord]) -> bool:
    values = [parse_int(item.values.get("IPPROCS")) for item in samples]
    return bool(values) and all(value == 0 for value in values if value is not None) and all(value is not None for value in values)


def any_output_process(samples: list[SampleRecord]) -> bool:
    values = [parse_int(item.values.get("OPPROCS")) for item in samples]
    return any(value is not None and value > 0 for value in values)


def is_system_queue(name: str) -> bool:
    upper = name.upper()
    return upper.startswith("SYSTEM.") or upper.startswith("AMQ.") or upper.startswith("KMQ.")


def observation(
    *, entity_id: str, semantic_type: str, display_name: str, observation_type: str,
    observed_at: str, value: Any, unit: str, source_id: str, source_host: str,
    qmgr: str, sample_id: str, evidence_ref: str, collection_method: str,
    quality: str = "sampled",
) -> dict[str, Any]:
    return {
        "observation_id": observation_id(entity_id, observation_type, sample_id, evidence_ref),
        "entity_id": entity_id,
        "semantic_type": semantic_type,
        "display_name": display_name,
        "observation_type": observation_type,
        "observed_at": observed_at,
        "value": value,
        "unit": unit,
        "source": {
            "source_id": source_id,
            "source_host": source_host,
            "queue_manager": qmgr,
            "collection_method": collection_method,
            "evidence_class": "observed",
            "evidence_ref": evidence_ref,
            "sample_id": sample_id,
        },
        "quality": {"coverage": "point_in_time", "freshness": quality},
    }


def evidence_ref(record: SampleRecord, observation_types: list[str]) -> dict[str, Any]:
    return {
        "sample_id": record.sample_id,
        "observed_at": record.observed_at,
        "evidence_ref": record.evidence_ref,
        "observation_types": observation_types,
    }


def finding(
    *, rule_id: str, entity_id: str, semantic_type: str, display_name: str,
    severity: str, summary: str, diagnosis: str, confidence: str,
    confidence_score: float, first_seen: str, last_seen: str,
    evidence: list[dict[str, Any]], coverage_state: str = "sufficient",
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "finding_id": finding_id(rule_id, entity_id),
        "rule_id": rule_id,
        "entity_id": entity_id,
        "semantic_type": semantic_type,
        "display_name": display_name,
        "severity": severity,
        "status": "OPEN",
        "summary": summary,
        "diagnosis": diagnosis,
        "confidence": {"level": confidence, "score": confidence_score},
        "first_seen": first_seen,
        "last_seen": last_seen,
        "coverage_state": coverage_state,
        "evidence": evidence,
        "related_entities": [],
        "details": details or {},
    }


def coverage_item(qmgr: str, family: str, sample_id: str, outcome: CommandOutcome, observed_at: str) -> dict[str, Any]:
    return {
        "scope_type": "queue_manager",
        "scope_key": qmgr,
        "observation_family": family,
        "sample_id": sample_id,
        "observed_at": observed_at,
        "state": outcome.mode,
        "evidence_ref": outcome.evidence_ref,
        "error": outcome.error,
    }


def evaluate_archive(filename: str) -> dict[str, Any]:
    archive = RawArchive(filename)
    try:
        mf = manifest(archive)
        if mf.get("format") != "osi-mq-topology-raw" or mf.get("format_version") != "1":
            raise ValueError("unsupported IBM MQ raw evidence format")
        completed_at = mf.get("completed_at_utc") or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        source_host = archive.text("host/hostname.out", False).strip() or mf.get("host", "unknown")
        source_id = (archive.text("host/hostname-fqdn.out", False).strip() or source_host).lower()

        observations: list[dict[str, Any]] = []
        coverage: list[dict[str, Any]] = []
        findings: list[dict[str, Any]] = []
        qmgr_summaries: list[dict[str, Any]] = []

        for qdir, qmgr in qmgr_rows(archive):
            cfg = qmgr_config(archive, qdir)
            qmid = cfg.get("QMID") or None
            qm_id = qmgr_entity_id(qmgr, qmid)
            samples = runtime_samples(archive, qdir)
            family_records: dict[str, list[SampleRecord]] = {
                "qmgr-status": [], "listener-status": [], "channel-status": [], "queue-status": []
            }
            family_outcomes: dict[str, list[tuple[str, str, CommandOutcome]]] = {key: [] for key in family_records}
            specs = (
                ("qmgr-status", "mq.queue_manager", "QMNAME"),
                ("listener-status", "mq.listener", "LISTENER"),
                ("channel-status", "mq.channel", "CHANNEL"),
                ("queue-status", "mq.queue", "QUEUE"),
            )
            for sample in samples:
                observed_at = sample_time(archive, qdir, sample, completed_at)
                for label, semantic_type, object_field in specs:
                    outcome, records = sample_records(
                        archive, qdir, qmgr, sample, label, semantic_type, object_field, completed_at
                    )
                    family_outcomes[label].append((sample, observed_at, outcome))
                    coverage.append(coverage_item(qmgr, label, sample, outcome, observed_at))
                    family_records[label].extend(records)

            for record in family_records["qmgr-status"]:
                observations.append(observation(
                    entity_id=qm_id, semantic_type="mq.queue_manager", display_name=qmgr,
                    observation_type="mq.queue_manager.status", observed_at=record.observed_at,
                    value=record.values.get("STATUS") or "UNKNOWN", unit="state",
                    source_id=source_id, source_host=source_host, qmgr=qmgr, sample_id=record.sample_id,
                    evidence_ref=record.evidence_ref, collection_method="mqsc:DISPLAY QMSTATUS ALL",
                ))

            for record in family_records["listener-status"]:
                eid = scoped_entity_id("mq.listener", qmgr, record.object_name)
                observations.append(observation(
                    entity_id=eid, semantic_type="mq.listener", display_name=record.object_name,
                    observation_type="mq.listener.status", observed_at=record.observed_at,
                    value=record.values.get("STATUS") or "UNKNOWN", unit="state",
                    source_id=source_id, source_host=source_host, qmgr=qmgr, sample_id=record.sample_id,
                    evidence_ref=record.evidence_ref, collection_method="mqsc:DISPLAY LSSTATUS(*) ALL",
                ))

            for record in family_records["channel-status"]:
                eid = scoped_entity_id("mq.channel", qmgr, record.object_name)
                observations.append(observation(
                    entity_id=eid, semantic_type="mq.channel", display_name=record.object_name,
                    observation_type="mq.channel.status", observed_at=record.observed_at,
                    value=record.values.get("STATUS") or "UNKNOWN", unit="state",
                    source_id=source_id, source_host=source_host, qmgr=qmgr, sample_id=record.sample_id,
                    evidence_ref=record.evidence_ref, collection_method="mqsc:DISPLAY CHSTATUS(*) ALL",
                ))
                if record.values.get("MONCHL"):
                    observations.append(observation(
                        entity_id=eid, semantic_type="mq.channel", display_name=record.object_name,
                        observation_type="mq.channel.monitoring_level", observed_at=record.observed_at,
                        value=record.values.get("MONCHL"), unit="state",
                        source_id=source_id, source_host=source_host, qmgr=qmgr, sample_id=record.sample_id,
                        evidence_ref=record.evidence_ref, collection_method="mqsc:DISPLAY CHSTATUS(*) ALL",
                    ))

            for record in family_records["queue-status"]:
                eid = scoped_entity_id("mq.queue", qmgr, record.object_name)
                for attr, observation_type, unit in (
                    ("CURDEPTH", "mq.queue.depth.current", "messages"),
                    ("IPPROCS", "mq.queue.process.input_count", "processes"),
                    ("OPPROCS", "mq.queue.process.output_count", "processes"),
                    ("MSGAGE", "mq.queue.message.age.oldest_seconds", "seconds"),
                ):
                    value = parse_int(record.values.get(attr))
                    if value is None:
                        continue
                    observations.append(observation(
                        entity_id=eid, semantic_type="mq.queue", display_name=record.object_name,
                        observation_type=observation_type, observed_at=record.observed_at,
                        value=value, unit=unit, source_id=source_id, source_host=source_host,
                        qmgr=qmgr, sample_id=record.sample_id, evidence_ref=record.evidence_ref,
                        collection_method="mqsc:DISPLAY QSTATUS(*) TYPE(QUEUE) ALL",
                    ))

            qm_series = series_by_object(family_records["qmgr-status"]).get(qmgr, [])
            if qm_series:
                last = qm_series[-1]
                state = (last.values.get("STATUS") or "UNKNOWN").upper()
                if state not in NORMAL_QMGR_STATES:
                    findings.append(finding(
                        rule_id="mq.qmgr.unavailable.v1", entity_id=qm_id,
                        semantic_type="mq.queue_manager", display_name=qmgr, severity="critical",
                        summary=f"Queue manager is {state.lower()}",
                        diagnosis="The latest successful queue-manager status observation is not RUNNING.",
                        confidence="confirmed", confidence_score=0.99,
                        first_seen=last.observed_at, last_seen=last.observed_at,
                        evidence=[evidence_ref(last, ["mq.queue_manager.status"])],
                        details={"status": state},
                    ))

            for name, items in series_by_object(family_records["listener-status"]).items():
                last = items[-1]
                state = (last.values.get("STATUS") or "UNKNOWN").upper()
                if state not in NORMAL_LISTENER_STATES:
                    eid = scoped_entity_id("mq.listener", qmgr, name)
                    findings.append(finding(
                        rule_id="mq.listener.unavailable.v1", entity_id=eid,
                        semantic_type="mq.listener", display_name=name, severity="warning",
                        summary=f"Listener is {state.lower()}",
                        diagnosis="The latest successful listener-status observation is not RUNNING.",
                        confidence="confirmed", confidence_score=0.99,
                        first_seen=last.observed_at, last_seen=last.observed_at,
                        evidence=[evidence_ref(last, ["mq.listener.status"])],
                        details={"queue_manager": qmgr, "status": state},
                    ))

            for name, items in series_by_object(family_records["channel-status"]).items():
                last = items[-1]
                state = (last.values.get("STATUS") or "UNKNOWN").upper()
                if state not in NORMAL_CHANNEL_STATES:
                    eid = scoped_entity_id("mq.channel", qmgr, name)
                    findings.append(finding(
                        rule_id="mq.channel.abnormal.v1", entity_id=eid,
                        semantic_type="mq.channel", display_name=name, severity="warning",
                        summary=f"Observed channel state is {state.lower()}",
                        diagnosis="An observed channel instance is present in the latest successful status sample but is not RUNNING. Impact is not asserted without route/workload evidence.",
                        confidence="confirmed", confidence_score=0.98,
                        first_seen=last.observed_at, last_seen=last.observed_at,
                        evidence=[evidence_ref(last, ["mq.channel.status"])],
                        details={"queue_manager": qmgr, "status": state, "impact": "not_established"},
                    ))

            for name, items in series_by_object(family_records["queue-status"]).items():
                if is_system_queue(name):
                    continue
                backlog = queue_backlog_increasing(items)
                no_input = all_zero_input_processes(items)
                producer_present = any_output_process(items)
                aging = queue_oldest_message_aging(items)
                eid = scoped_entity_id("mq.queue", qmgr, name)
                first, last = items[0], items[-1]
                depths = [parse_int(item.values.get("CURDEPTH")) for item in items]
                ages = [parse_int(item.values.get("MSGAGE")) for item in items]

                if backlog and no_input:
                    findings.append(finding(
                        rule_id="mq.queue.backlog_no_input_process.v1", entity_id=eid,
                        semantic_type="mq.queue", display_name=name, severity="warning",
                        summary="Backlog increasing with no input process observed",
                        diagnosis=(
                            "Queue depth increased across the sampled window while every successful queue-status sample reported IPPROCS=0. "
                            + ("An output process was observed, strengthening evidence that work is arriving. " if producer_present else "")
                            + "This does not by itself prove an application outage."
                        ),
                        confidence="probable", confidence_score=0.92 if producer_present else 0.86,
                        first_seen=first.observed_at, last_seen=last.observed_at,
                        evidence=[evidence_ref(item, ["mq.queue.depth.current", "mq.queue.process.input_count", "mq.queue.process.output_count"]) for item in items],
                        details={
                            "queue_manager": qmgr,
                            "depth_series": depths,
                            "input_processes_all_zero": True,
                            "output_process_observed": producer_present,
                            "policy_scope": "non_system_queue_generic_v1",
                            "impact": "not_established",
                        },
                    ))
                elif backlog:
                    findings.append(finding(
                        rule_id="mq.queue.backlog_increasing.v1", entity_id=eid,
                        semantic_type="mq.queue", display_name=name, severity="warning",
                        summary="Queue backlog increasing across observations",
                        diagnosis="Queue depth shows a sustained positive trend across the sampled window. No business threshold or outage cause is inferred.",
                        confidence="probable", confidence_score=0.84,
                        first_seen=first.observed_at, last_seen=last.observed_at,
                        evidence=[evidence_ref(item, ["mq.queue.depth.current"]) for item in items],
                        details={"queue_manager": qmgr, "depth_series": depths, "policy_scope": "non_system_queue_generic_v1", "impact": "not_established"},
                    ))

                if aging:
                    findings.append(finding(
                        rule_id="mq.queue.oldest_message_aging.v1", entity_id=eid,
                        semantic_type="mq.queue", display_name=name, severity="warning",
                        summary="Oldest queued message is aging across observations",
                        diagnosis="The oldest-message age increased with wall time while the queue remained non-empty. This is persistence evidence, not a business-SLA breach claim.",
                        confidence="probable", confidence_score=0.86,
                        first_seen=first.observed_at, last_seen=last.observed_at,
                        evidence=[evidence_ref(item, ["mq.queue.message.age.oldest_seconds", "mq.queue.depth.current"]) for item in items],
                        details={"queue_manager": qmgr, "message_age_series_seconds": ages, "depth_series": depths, "policy_scope": "non_system_queue_generic_v1", "sla_breach": "not_asserted"},
                    ))

            monchl = str(cfg.get("MONCHL") or "").upper()
            if monchl == "OFF":
                config_ref = f"qmgr/{qdir}/config/qmgr.out"
                findings.append(finding(
                    rule_id="mq.observability.channel_timing_unavailable.v1", entity_id=qm_id,
                    semantic_type="mq.queue_manager", display_name=qmgr, severity="info",
                    summary="Channel performance timing is not observable",
                    diagnosis="Queue-manager configuration reports MONCHL(OFF). Channel state remains observable, but NETTIME/XQTIME-style timing diagnosis is unavailable from this evidence source.",
                    confidence="confirmed", confidence_score=0.99,
                    first_seen=completed_at, last_seen=completed_at,
                    evidence=[{
                        "sample_id": "configuration",
                        "observed_at": completed_at,
                        "evidence_ref": config_ref,
                        "observation_types": ["mq.channel.monitoring_coverage"],
                    }],
                    coverage_state="limited",
                    details={"queue_manager": qmgr, "MONCHL": "OFF", "health_implication": "none"},
                ))

            for family, outcomes in family_outcomes.items():
                bad = [(sample, ts, outcome) for sample, ts, outcome in outcomes if outcome.mode in {"failed", "not_collected"}]
                good = [item for item in outcomes if item[2].mode == "point_in_time"]
                if not bad:
                    continue
                _, latest_ts, _ = bad[-1]
                coverage_state = "partial" if good else "failed"
                findings.append(finding(
                    rule_id=f"mq.observability.collection_gap.{family}.v1", entity_id=qm_id,
                    semantic_type="mq.queue_manager", display_name=qmgr, severity="warning",
                    summary=f"{family.replace('-', ' ').title()} evidence is incomplete",
                    diagnosis="One or more required runtime collection attempts failed or were not collected. Health conclusions that depend on this observation family must be treated as incomplete.",
                    confidence="confirmed", confidence_score=0.99,
                    first_seen=bad[0][1], last_seen=latest_ts,
                    evidence=[{
                        "sample_id": sample,
                        "observed_at": ts,
                        "evidence_ref": outcome.evidence_ref,
                        "observation_types": [f"coverage.{family}"],
                        "error": outcome.error,
                    } for sample, ts, outcome in bad],
                    coverage_state=coverage_state,
                    details={"queue_manager": qmgr, "observation_family": family, "successful_samples": len(good), "failed_or_missing_samples": len(bad)},
                ))

            qmgr_summaries.append({
                "queue_manager": qmgr,
                "entity_id": qm_id,
                "qmid": qmid,
                "runtime_samples": len(samples),
            })

        findings.sort(key=lambda item: (
            {"critical": 0, "warning": 1, "info": 2}.get(item["severity"], 9),
            item["semantic_type"], item["display_name"], item["rule_id"],
        ))
        observations.sort(key=lambda item: (item["entity_id"], item["observation_type"], item["observed_at"]))
        coverage.sort(key=lambda item: (item["scope_key"], item["observation_family"], item["observed_at"]))
        counts = {
            "critical": sum(1 for item in findings if item["severity"] == "critical"),
            "warning": sum(1 for item in findings if item["severity"] == "warning"),
            "info": sum(1 for item in findings if item["severity"] == "info"),
            "total": len(findings),
        }
        return {
            "schema_version": SCHEMA_VERSION,
            "evaluation": {
                "evaluator": "evaluate_findings_v1.py",
                "evaluator_version": EVALUATOR_VERSION,
                "evaluated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "source_archive": PurePosixPath(filename).name,
                "source_archive_sha256": sha256_file(filename),
                "source_id": source_id,
                "source_host": source_host,
                "collector_version": mf.get("collector_version"),
                "sample_count_declared": parse_int(mf.get("samples")),
                "sample_interval_seconds_declared": parse_int(mf.get("interval_seconds")),
                "policy": {
                    "system_queue_generic_rules": "excluded",
                    "absolute_queue_depth_thresholds": "not_used",
                    "business_sla_thresholds": "not_invented",
                    "external_monitoring_dependencies": "none",
                },
            },
            "queue_managers": qmgr_summaries,
            "coverage": coverage,
            "operational_observations": observations,
            "findings": findings,
            "summary": counts,
        }
    finally:
        archive.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate OSI Phase 2 Findings v1 from an IBM MQ raw collector archive")
    parser.add_argument("archive", help="mq-topology-*.tar.gz raw collector evidence")
    parser.add_argument("-o", "--output", default="osi-findings-v1.json", help="output JSON path")
    args = parser.parse_args()
    result = evaluate_archive(args.archive)
    with open(args.output, "w", encoding="utf-8") as fh:
        json.dump(result, fh, indent=2, sort_keys=False)
        fh.write("\n")
    print(json.dumps({
        "output": args.output,
        "schema_version": result["schema_version"],
        "observations": len(result["operational_observations"]),
        "coverage_records": len(result["coverage"]),
        "findings": result["summary"],
    }, indent=2))


if __name__ == "__main__":
    main()
