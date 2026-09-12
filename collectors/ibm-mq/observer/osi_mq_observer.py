#!/usr/bin/env python3
"""Read-only IBM MQ telemetry observer.

Emits ``osi.telemetry.batch/v1`` JSON using only an explicit MQSC DISPLAY
allowlist plus optional ``dspmq`` discovery. The observer never consumes
messages, mutates queue-manager state, or publishes over the network.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import socket
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "osi.telemetry.batch/v1"
OBSERVER_VERSION = "0.2.0"
OBSERVER_NAME = "osi-mq-observer"
PROFILE = "baseline"

DISPLAY_RE = re.compile(r"^AMQ\d+[A-Z]:.*Display .* details\.$", re.I)
ATTR_START_RE = re.compile(r"([A-Z][A-Z0-9_]*)\(")
MQ_ERROR_RE = re.compile(r"\b(AMQ\d{4}E):\s*([^\r\n]*)", re.I)
DSPMQ_QM_RE = re.compile(r"QMNAME\(([^)]+)\)", re.I)

# Safety boundary: only these MQSC commands may be executed by this program.
COMMANDS = {
    "qmgr_identity": "DISPLAY QMGR QMID",
    "qmgr_status": "DISPLAY QMSTATUS ALL",
    "queue_status": "DISPLAY QSTATUS(*) TYPE(QUEUE) ALL",
    "channel_status": "DISPLAY CHSTATUS(*) ALL",
    "listener_status": "DISPLAY LSSTATUS(*) ALL",
}
RUNTIME_FAMILIES = ("qmgr_status", "queue_status", "channel_status", "listener_status")
QUEUE_METRICS = (
    ("CURDEPTH", "mq.queue.depth.current", "messages"),
    ("IPPROCS", "mq.queue.process.input_count", "processes"),
    ("OPPROCS", "mq.queue.process.output_count", "processes"),
    ("MSGAGE", "mq.queue.message.age.oldest_seconds", "seconds"),
)


@dataclass(frozen=True)
class CommandResult:
    run_id: str
    family: str
    command: str
    qmgr: str
    sample_id: str
    observed_at: str
    returncode: int
    stdout: str
    stderr: str

    @property
    def evidence_ref(self) -> str:
        return f"telemetry://{self.run_id}/{self.sample_id}/{self.qmgr}/{self.family}"

    @property
    def errors(self) -> list[str]:
        text = f"{self.stdout}\n{self.stderr}"
        return [f"{code.upper()}: {message.strip()}" for code, message in MQ_ERROR_RE.findall(text)]

    @property
    def state(self) -> str:
        return "point_in_time" if self.returncode == 0 and not self.errors else "failed"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def scalar_int(value: Any) -> int | None:
    try:
        text = str(value).strip()
        if not text or text in {"-", "N/A", "None"}:
            return None
        return int(text)
    except (TypeError, ValueError):
        return None


def parse_attrs_line(line: str) -> list[tuple[str, str]]:
    """Parse MQSC KEY(value) pairs, including values containing parentheses."""
    out: list[tuple[str, str]] = []
    i = 0
    while i < len(line):
        match = ATTR_START_RE.search(line, i)
        if not match:
            break
        key = match.group(1)
        start = match.end() - 1
        depth = 0
        cursor = start
        while cursor < len(line):
            char = line[cursor]
            if char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
                if depth == 0:
                    out.append((key, line[start + 1:cursor].strip()))
                    i = cursor + 1
                    break
            cursor += 1
        else:
            break
    return out


def parse_blocks(text: str) -> list[dict[str, str]]:
    blocks: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("AMQ"):
            if DISPLAY_RE.match(line):
                if current:
                    blocks.append(current)
                current = {}
            continue
        if current is not None:
            for key, value in parse_attrs_line(raw):
                current[key] = value
    if current:
        blocks.append(current)
    return blocks


def safe_display_command(command: str) -> str:
    normalized = " ".join(command.strip().split())
    if not normalized.upper().startswith("DISPLAY "):
        raise ValueError(f"non-DISPLAY MQSC command rejected: {command!r}")
    if normalized not in COMMANDS.values():
        raise ValueError(f"MQSC command is outside the observer allowlist: {command!r}")
    return normalized


def discover_qmgrs(dspmq: str) -> list[str]:
    completed = subprocess.run([dspmq], capture_output=True, text=True, timeout=30, check=False)
    if completed.returncode != 0:
        raise RuntimeError(f"dspmq failed with rc={completed.returncode}: {completed.stderr.strip()}")
    names: list[str] = []
    for line in completed.stdout.splitlines():
        match = DSPMQ_QM_RE.search(line)
        if match:
            name = match.group(1).strip()
            if name and name not in names:
                names.append(name)
    if not names:
        raise RuntimeError("dspmq returned no queue managers")
    return names


def _timeout_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return str(value)


def run_mqsc(runmqsc: str, run_id: str, qmgr: str, family: str, sample_id: str, timeout: int) -> CommandResult:
    command = safe_display_command(COMMANDS[family])
    try:
        completed = subprocess.run(
            [runmqsc, qmgr],
            input=command + "\n",
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        return CommandResult(
            run_id=run_id,
            family=family,
            command=command,
            qmgr=qmgr,
            sample_id=sample_id,
            observed_at=utc_now(),
            returncode=completed.returncode,
            stdout=completed.stdout,
            stderr=completed.stderr,
        )
    except subprocess.TimeoutExpired as exc:
        stderr = _timeout_text(exc.stderr)
        suffix = f"observer timeout after {timeout}s"
        return CommandResult(
            run_id=run_id,
            family=family,
            command=command,
            qmgr=qmgr,
            sample_id=sample_id,
            observed_at=utc_now(),
            returncode=124,
            stdout=_timeout_text(exc.stdout),
            stderr=f"{stderr}\n{suffix}".strip(),
        )
    except OSError as exc:
        return CommandResult(
            run_id=run_id,
            family=family,
            command=command,
            qmgr=qmgr,
            sample_id=sample_id,
            observed_at=utc_now(),
            returncode=127,
            stdout="",
            stderr=f"observer execution error: {exc}",
        )


def identity_hints(qmgr: str, qmid: str | None, object_name: str | None = None) -> dict[str, str]:
    hints = {"queue_manager_name": qmgr}
    if qmid:
        hints["queue_manager_qmid"] = qmid
    if object_name:
        hints["name"] = object_name
    return hints


def observation_id(
    source_id: str,
    run_id: str,
    semantic_type: str,
    hints: dict[str, str],
    metric: str,
    sample_id: str,
    discriminator: str = "",
) -> str:
    stable_hints = json.dumps(hints, sort_keys=True, separators=(",", ":"))
    raw = "|".join([source_id, run_id, semantic_type, stable_hints, metric, sample_id, discriminator])
    return "tobs_" + hashlib.sha256(raw.encode()).hexdigest()[:24]


def source_block(source_id: str, source_host: str, result: CommandResult) -> dict[str, str]:
    return {
        "source_id": source_id,
        "source_host": source_host,
        "queue_manager": result.qmgr,
        "collection_method": f"mqsc:{result.command}",
        "command": result.command,
        "evidence_class": "observed",
        "evidence_ref": result.evidence_ref,
        "sample_id": result.sample_id,
    }


def make_observation(
    source_id: str,
    source_host: str,
    result: CommandResult,
    semantic_type: str,
    display_name: str,
    hints: dict[str, str],
    metric: str,
    value: str | int | float | bool,
    unit: str,
    *,
    discriminator: str = "",
    dimensions: dict[str, Any] | None = None,
) -> dict[str, Any]:
    item: dict[str, Any] = {
        "observation_id": observation_id(
            source_id, result.run_id, semantic_type, hints, metric, result.sample_id, discriminator
        ),
        "entity": {
            "semantic_type": semantic_type,
            "display_name": display_name,
            "identity_hints": hints,
        },
        "observation_type": metric,
        "observed_at": result.observed_at,
        "value": value,
        "unit": unit,
        "source": source_block(source_id, source_host, result),
        "quality": {"coverage": "point_in_time", "freshness": "sampled"},
    }
    if dimensions:
        item["dimensions"] = dimensions
    return item


def channel_dimensions(values: dict[str, str]) -> tuple[str, dict[str, Any]]:
    parts = [values.get(key, "").strip() for key in ("JOBNAME", "CONNAME", "RAPPLTAG")]
    discriminator = "|".join(part for part in parts if part) or "default"
    dims: dict[str, Any] = {
        "channel_instance_key": discriminator,
        "job_name": values.get("JOBNAME") or None,
        "connection_name": values.get("CONNAME") or None,
        "remote_application": values.get("RAPPLTAG") or None,
        "remote_queue_manager": values.get("RQMNAME") or None,
        "channel_type": values.get("CHLTYPE") or None,
    }
    return discriminator, dims


def observations_from_result(
    source_id: str,
    source_host: str,
    qmid: str | None,
    result: CommandResult,
) -> list[dict[str, Any]]:
    if result.state != "point_in_time":
        return []
    rows = parse_blocks(result.stdout)
    out: list[dict[str, Any]] = []

    if result.family == "qmgr_status":
        for values in rows:
            status = values.get("STATUS") or "UNKNOWN"
            hints = identity_hints(result.qmgr, qmid)
            out.append(
                make_observation(
                    source_id, source_host, result, "mq.queue_manager", result.qmgr,
                    hints, "mq.queue_manager.status", status, "state"
                )
            )
        return out

    if result.family == "queue_status":
        for values in rows:
            name = (values.get("QUEUE") or "").strip()
            if not name:
                continue
            hints = identity_hints(result.qmgr, qmid, name)
            for attr, metric, unit in QUEUE_METRICS:
                value = scalar_int(values.get(attr))
                if value is not None:
                    out.append(
                        make_observation(
                            source_id, source_host, result, "mq.queue", name,
                            hints, metric, value, unit
                        )
                    )
        return out

    if result.family == "channel_status":
        for values in rows:
            name = (values.get("CHANNEL") or "").strip()
            if not name:
                continue
            status = values.get("STATUS") or "UNKNOWN"
            hints = identity_hints(result.qmgr, qmid, name)
            discriminator, dimensions = channel_dimensions(values)
            out.append(
                make_observation(
                    source_id, source_host, result, "mq.channel", name, hints,
                    "mq.channel.status", status, "state",
                    discriminator=discriminator, dimensions=dimensions,
                )
            )
            if values.get("MONCHL"):
                out.append(
                    make_observation(
                        source_id, source_host, result, "mq.channel", name, hints,
                        "mq.channel.monitoring_level", values["MONCHL"], "state",
                        discriminator=discriminator, dimensions=dimensions,
                    )
                )
        return out

    if result.family == "listener_status":
        for values in rows:
            name = (values.get("LISTENER") or "").strip()
            if not name:
                continue
            status = values.get("STATUS") or "UNKNOWN"
            hints = identity_hints(result.qmgr, qmid, name)
            out.append(
                make_observation(
                    source_id, source_host, result, "mq.listener", name, hints,
                    "mq.listener.status", status, "state"
                )
            )
        return out

    return out


def coverage_from_result(result: CommandResult) -> dict[str, Any]:
    error = None
    if result.state != "point_in_time":
        bits: list[str] = []
        if result.returncode != 0:
            bits.append(f"runmqsc rc={result.returncode}")
        bits.extend(result.errors[:3])
        if result.stderr and not result.errors:
            bits.append(result.stderr.strip().splitlines()[-1])
        error = "; ".join(bit for bit in bits if bit) or "MQSC collection failed"
    return {
        "scope_type": "queue_manager",
        "scope_key": result.qmgr,
        "observation_family": result.family,
        "sample_id": result.sample_id,
        "observed_at": result.observed_at,
        "state": result.state,
        "collection_method": f"mqsc:{result.command}",
        "command": result.command,
        "evidence_ref": result.evidence_ref,
        "error": error,
    }


def qmid_from_identity_result(result: CommandResult) -> str | None:
    if result.state != "point_in_time":
        return None
    rows = parse_blocks(result.stdout)
    if not rows:
        return None
    qmid = (rows[0].get("QMID") or "").strip()
    return qmid or None


def collect(args: argparse.Namespace) -> dict[str, Any]:
    source_host = args.source_host or socket.gethostname()
    source_id = (args.source_id or socket.getfqdn() or source_host).strip().lower()
    qmgrs = args.qmgr or discover_qmgrs(args.dspmq)
    run_id = f"telemetry_{uuid.uuid4().hex}"
    started_at = utc_now()

    coverage: list[dict[str, Any]] = []
    observations: list[dict[str, Any]] = []
    qmids: dict[str, str | None] = {}

    for qmgr in qmgrs:
        result = run_mqsc(args.runmqsc, run_id, qmgr, "qmgr_identity", "identity", args.timeout)
        coverage.append(coverage_from_result(result))
        qmids[qmgr] = qmid_from_identity_result(result)

    for sample_index in range(1, args.samples + 1):
        sample_id = f"sample-{sample_index:04d}"
        for qmgr in qmgrs:
            for family in RUNTIME_FAMILIES:
                result = run_mqsc(args.runmqsc, run_id, qmgr, family, sample_id, args.timeout)
                coverage.append(coverage_from_result(result))
                observations.extend(observations_from_result(source_id, source_host, qmids.get(qmgr), result))
        if sample_index < args.samples and args.interval > 0:
            time.sleep(args.interval)

    return {
        "schema_version": SCHEMA_VERSION,
        "run": {
            "run_id": run_id,
            "observer": OBSERVER_NAME,
            "observer_version": OBSERVER_VERSION,
            "profile": PROFILE,
            "started_at": started_at,
            "completed_at": utc_now(),
            "sample_count": args.samples,
            "sample_interval_seconds": args.interval,
            "source": {
                "kind": "ibm_mq_host",
                "source_id": source_id,
                "source_host": source_host,
            },
        },
        "coverage": coverage,
        "observations": observations,
    }


def command_plan(qmgrs: list[str]) -> dict[str, Any]:
    return {
        "observer": OBSERVER_NAME,
        "observer_version": OBSERVER_VERSION,
        "profile": PROFILE,
        "queue_managers": qmgrs,
        "discovery_command": "dspmq" if not qmgrs else None,
        "mqsc_commands": [{"family": family, "command": command} for family, command in COMMANDS.items()],
        "safety": {
            "mqsc_verbs": ["DISPLAY"],
            "message_consumption": False,
            "mq_state_mutation": False,
            "network_publish": False,
        },
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Read-only IBM MQ telemetry observer")
    parser.add_argument("--qmgr", action="append", default=[], help="Queue manager to observe; repeatable. Defaults to dspmq discovery.")
    parser.add_argument("--samples", type=int, default=1, help="Number of samples to collect (default: 1).")
    parser.add_argument("--interval", type=int, default=60, help="Seconds between samples (default: 60; ignored for one sample).")
    parser.add_argument("--timeout", type=int, default=30, help="Timeout per runmqsc command in seconds (default: 30).")
    parser.add_argument("--runmqsc", default="runmqsc", help="runmqsc executable path.")
    parser.add_argument("--dspmq", default="dspmq", help="dspmq executable path.")
    parser.add_argument("--source-id", help="Override source identity. Default: host FQDN.")
    parser.add_argument("--source-host", help="Override source host display value. Default: hostname.")
    parser.add_argument("--output", help="Write JSON batch to this path instead of stdout.")
    parser.add_argument("--dry-run", action="store_true", help="Print the read-only command plan and execute nothing.")
    return parser


def validate_args(parser: argparse.ArgumentParser, args: argparse.Namespace) -> None:
    if args.samples < 1 or args.samples > 1440:
        parser.error("--samples must be between 1 and 1440")
    if args.interval < 0 or args.interval > 86400:
        parser.error("--interval must be between 0 and 86400")
    if args.samples > 1 and args.interval < 10:
        parser.error("--interval must be at least 10 seconds when collecting multiple samples")
    if args.timeout < 1 or args.timeout > 600:
        parser.error("--timeout must be between 1 and 600")
    if not args.dry_run:
        if not shutil.which(args.runmqsc) and not Path(args.runmqsc).exists():
            parser.error(f"runmqsc executable not found: {args.runmqsc}")
        if not args.qmgr and not shutil.which(args.dspmq) and not Path(args.dspmq).exists():
            parser.error(f"dspmq executable not found: {args.dspmq}")


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    validate_args(parser, args)

    if args.dry_run:
        json.dump(command_plan(args.qmgr), sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write("\n")
        return 0

    try:
        batch = collect(args)
    except (RuntimeError, OSError, ValueError) as exc:
        print(f"osi-mq-observer: {exc}", file=sys.stderr)
        return 2

    payload = json.dumps(batch, indent=2, sort_keys=True) + "\n"
    if args.output:
        Path(args.output).write_text(payload, encoding="utf-8")
    else:
        sys.stdout.write(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
