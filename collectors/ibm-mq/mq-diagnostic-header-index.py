#!/usr/bin/env python3
"""Read-only IBM MQ diagnostic header indexer for OSI demo discovery.

The tool inventories FDC/FFST files and extracts only First Failure Symptom Report
header fields. It never copies diagnostic bodies, connects to MQ, or writes to D1.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import shutil
import tarfile
import tempfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

VERSION = "1.0.0"
SCHEMA = "osi.mq-diagnostic-header-index/v1"
REPORT_SCHEMA = "osi.mq-diagnostic-header/v1"
DEFAULT_FIRST_SCAN_BYTES = 512 * 1024

REPORT_MARKER = "IBM MQ First Failure Symptom Report"
FIELD_RE = re.compile(r"^\|\s*([^:|]+?)\s*:-\s*(.*?)\s*\|\s*$")
BORDER_RE = re.compile(r"^\+-{10,}\+\s*$")
CONTINUATION_RE = re.compile(r"^\|\s{2,}([^|].*?)\s*\|\s*$")

FIELD_MAP = {
    "date/time": "date_time",
    "utc time": "utc_time",
    "utc time offset": "utc_time_offset",
    "host name": "host_name",
    "operating system": "operating_system",
    "pids": "pids",
    "lvls": "mq_level",
    "product long name": "product_long_name",
    "vendor": "vendor",
    "data path": "data_path",
    "installation path": "installation_path",
    "installation name": "installation_name",
    "license type": "license_type",
    "probe id": "probe_id",
    "application name": "application_name",
    "component": "component",
    "sccs info": "sccs_info",
    "line number": "line_number",
    "build date": "build_date",
    "build level": "build_level",
    "build type": "build_type",
    "effective userid": "effective_user_id",
    "real userid": "real_user_id",
    "program name": "program_name",
    "arguments": "arguments",
    "addressing mode": "addressing_mode",
    "lang": "lang",
    "process": "process",
    "process(thread)": "process_thread",
    "thread": "thread",
    "queuemanager": "queue_manager",
    "subpoolname": "subpool_name",
    "userapp": "user_app",
    "last objectname": "last_object_name",
    "major errorcode": "major_error_code",
    "minor errorcode": "minor_error_code",
    "probe type": "probe_type",
    "probe severity": "probe_severity",
    "probe description": "probe_description",
    "fdcsequencenumber": "fdc_sequence_number",
    "comment1": "comment1",
    "comment2": "comment2",
    "comment3": "comment3",
}

SELECTED_COLUMNS = [
    "report_id",
    "source_path",
    "source_file_size",
    "source_mtime_utc",
    "report_index",
    "date_time",
    "utc_time",
    "host_name",
    "mq_level",
    "queue_manager",
    "probe_id",
    "component",
    "program_name",
    "major_error_code",
    "minor_error_code",
    "probe_type",
    "probe_severity",
    "probe_description",
    "last_object_name",
    "comment1",
]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def utc_from_epoch(value: float) -> str:
    return datetime.fromtimestamp(value, timezone.utc).isoformat()


def safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("_") or "unknown"


def parse_mqs_ini(path: Path) -> list[Path]:
    roots: list[Path] = []
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return roots
    for raw in text.splitlines():
        if "=" not in raw:
            continue
        key, value = raw.split("=", 1)
        if key.strip().lower() == "datapath" and value.strip():
            roots.append(Path(value.strip()))
    return roots


def dedupe_roots(values: Iterable[Path]) -> list[Path]:
    seen: set[str] = set()
    result: list[Path] = []
    for value in values:
        try:
            resolved = value.expanduser().resolve(strict=False)
        except OSError:
            resolved = value.expanduser().absolute()
        key = str(resolved)
        if key in seen or not resolved.is_dir():
            continue
        seen.add(key)
        result.append(resolved)
    return result


def discover_files(roots: list[Path]) -> list[Path]:
    found: dict[str, Path] = {}
    for root in roots:
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            dirnames[:] = [d for d in dirnames if not Path(dirpath, d).is_symlink()]
            for filename in filenames:
                lower = filename.lower()
                if not (lower.endswith(".fdc") or ".fdc." in lower or lower.endswith(".ffst") or ".ffst." in lower):
                    continue
                path = Path(dirpath, filename)
                if path.is_symlink():
                    continue
                try:
                    key = str(path.resolve(strict=False))
                except OSError:
                    key = str(path.absolute())
                found.setdefault(key, path)
    return [found[key] for key in sorted(found)]


def normalize_label(label: str) -> str:
    compact = " ".join(label.strip().lower().split())
    mapped = FIELD_MAP.get(compact)
    if mapped:
        return mapped
    return re.sub(r"[^a-z0-9]+", "_", compact).strip("_")


def report_identity(path: Path, report_index: int, fields: dict[str, str]) -> str:
    material = json.dumps(
        {
            "path": str(path),
            "report_index": report_index,
            "utc_time": fields.get("utc_time"),
            "probe_id": fields.get("probe_id"),
            "queue_manager": fields.get("queue_manager"),
            "component": fields.get("component"),
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return "fdch_" + hashlib.sha256(material).hexdigest()[:24]


def finalize_report(
    reports: list[dict[str, Any]],
    path: Path,
    size: int,
    mtime_utc: str,
    report_index: int,
    fields: dict[str, str],
) -> None:
    if not fields:
        return
    reports.append(
        {
            "schema_version": REPORT_SCHEMA,
            "report_id": report_identity(path, report_index, fields),
            "source_path": str(path),
            "source_file_size": size,
            "source_mtime_utc": mtime_utc,
            "report_index": report_index,
            "fields": fields,
        }
    )


def scan_file(path: Path, all_reports: bool, first_scan_bytes: int) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    try:
        st = path.stat()
    except OSError as exc:
        return [], {
            "source_path": str(path),
            "status": "stat_failed",
            "error": str(exc),
            "source_file_size": None,
            "source_mtime_utc": None,
            "reports_found": 0,
            "bytes_read": 0,
            "sha256": None,
        }

    size = int(st.st_size)
    mtime_utc = utc_from_epoch(st.st_mtime)
    reports: list[dict[str, Any]] = []
    hasher = hashlib.sha256() if all_reports else None
    bytes_read = 0
    in_header = False
    fields: dict[str, str] = {}
    last_key: str | None = None
    report_index = 0
    seen_field = False

    try:
        with path.open("rb") as fh:
            while True:
                raw = fh.readline()
                if not raw:
                    break
                bytes_read += len(raw)
                if hasher is not None:
                    hasher.update(raw)
                if not all_reports and bytes_read > first_scan_bytes:
                    break

                line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                if not in_header:
                    if REPORT_MARKER in line:
                        in_header = True
                        fields = {}
                        last_key = None
                        seen_field = False
                        report_index += 1
                    continue

                match = FIELD_RE.match(line)
                if match:
                    key = normalize_label(match.group(1))
                    value = match.group(2).strip()
                    if key:
                        if key in fields and value:
                            fields[key] = f"{fields[key]} {value}".strip()
                        else:
                            fields[key] = value
                        last_key = key
                        seen_field = True
                    continue

                if seen_field and BORDER_RE.match(line.strip()):
                    finalize_report(reports, path, size, mtime_utc, report_index, fields)
                    in_header = False
                    fields = {}
                    last_key = None
                    seen_field = False
                    if not all_reports:
                        break
                    continue

                continuation = CONTINUATION_RE.match(line)
                if continuation and last_key and seen_field:
                    value = continuation.group(1).strip()
                    if value and ":-" not in value and not set(value) <= {"-", "=", " ", "+"}:
                        fields[last_key] = f"{fields.get(last_key, '')} {value}".strip()

        if in_header and fields:
            finalize_report(reports, path, size, mtime_utc, report_index, fields)

        return reports, {
            "source_path": str(path),
            "status": "ok" if reports else "no_report_header_found",
            "error": None,
            "source_file_size": size,
            "source_mtime_utc": mtime_utc,
            "reports_found": len(reports),
            "bytes_read": bytes_read,
            "sha256": hasher.hexdigest() if hasher is not None and bytes_read == size else None,
        }
    except OSError as exc:
        return reports, {
            "source_path": str(path),
            "status": "read_failed",
            "error": str(exc),
            "source_file_size": size,
            "source_mtime_utc": mtime_utc,
            "reports_found": len(reports),
            "bytes_read": bytes_read,
            "sha256": None,
        }


def signature_tuple(fields: dict[str, str]) -> tuple[str, ...]:
    return tuple(
        fields.get(key, "")
        for key in (
            "probe_id",
            "component",
            "program_name",
            "queue_manager",
            "major_error_code",
            "minor_error_code",
            "probe_type",
            "probe_severity",
            "last_object_name",
            "comment1",
        )
    )


def write_outputs(
    package_root: Path,
    roots: list[Path],
    files: list[dict[str, Any]],
    reports: list[dict[str, Any]],
    mode: str,
    first_scan_bytes: int,
    host: str,
) -> dict[str, Any]:
    package_root.mkdir(parents=True, exist_ok=True)

    with (package_root / "reports.ndjson").open("w", encoding="utf-8") as fh:
        for report in reports:
            fh.write(json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n")

    with (package_root / "reports.csv").open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=SELECTED_COLUMNS)
        writer.writeheader()
        for report in reports:
            fields = report["fields"]
            row = {column: report.get(column, fields.get(column, "")) for column in SELECTED_COLUMNS}
            writer.writerow(row)

    sig_counter: Counter[tuple[str, ...]] = Counter()
    sig_first: dict[tuple[str, ...], str] = {}
    sig_last: dict[tuple[str, ...], str] = {}
    sig_files: dict[tuple[str, ...], set[str]] = defaultdict(set)
    for report in reports:
        fields = report["fields"]
        sig = signature_tuple(fields)
        sig_counter[sig] += 1
        sig_files[sig].add(report["source_path"])
        observed = fields.get("utc_time") or fields.get("date_time") or ""
        if observed:
            if sig not in sig_first or observed < sig_first[sig]:
                sig_first[sig] = observed
            if sig not in sig_last or observed > sig_last[sig]:
                sig_last[sig] = observed

    with (package_root / "signature-summary.csv").open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(
            [
                "count",
                "file_count",
                "first_seen",
                "last_seen",
                "probe_id",
                "component",
                "program_name",
                "queue_manager",
                "major_error_code",
                "minor_error_code",
                "probe_type",
                "probe_severity",
                "last_object_name",
                "comment1",
            ]
        )
        for sig, count in sorted(sig_counter.items(), key=lambda item: (-item[1], item[0])):
            writer.writerow([count, len(sig_files[sig]), sig_first.get(sig, ""), sig_last.get(sig, ""), *sig])

    file_columns = [
        "source_path",
        "status",
        "source_file_size",
        "source_mtime_utc",
        "reports_found",
        "bytes_read",
        "sha256",
        "error",
    ]
    with (package_root / "files.csv").open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=file_columns)
        writer.writeheader()
        for item in files:
            writer.writerow({key: item.get(key) for key in file_columns})

    qmgr_counts = Counter(report["fields"].get("queue_manager", "unknown") or "unknown" for report in reports)
    probe_counts = Counter(report["fields"].get("probe_id", "unknown") or "unknown" for report in reports)
    summary = {
        "schema_version": SCHEMA,
        "tool_version": VERSION,
        "generated_at": utc_now(),
        "host": host,
        "mode": mode,
        "first_scan_bytes": first_scan_bytes if mode == "first_report" else None,
        "search_roots": [str(root) for root in roots],
        "files_discovered": len(files),
        "files_with_reports": sum(1 for item in files if int(item.get("reports_found") or 0) > 0),
        "files_read_failed": sum(1 for item in files if item.get("status") in {"read_failed", "stat_failed"}),
        "source_bytes_total": sum(int(item.get("source_file_size") or 0) for item in files),
        "bytes_read_total": sum(int(item.get("bytes_read") or 0) for item in files),
        "reports_indexed": len(reports),
        "unique_signatures": len(sig_counter),
        "queue_manager_counts": dict(qmgr_counts),
        "top_probe_ids": [{"probe_id": key, "count": count} for key, count in probe_counts.most_common(50)],
        "database_written": False,
        "raw_diagnostic_bodies_copied": False,
        "limitations": [
            "first_report mode is a bounded per-file survey and does not enumerate later reports appended to a large FDC file.",
            "all_reports mode performs a sequential read of each source file and can create significant storage I/O for very large FDC files.",
            "Extracted header fields are diagnostic evidence and require operator correlation before causal or current-health claims.",
            "No MQ recovery/transaction log is read by this tool.",
        ],
    }
    (package_root / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    with (package_root / "manifest.properties").open("w", encoding="utf-8") as fh:
        fh.write("format=osi-mq-diagnostic-header-index\n")
        fh.write("format_version=1\n")
        fh.write(f"collector_version={VERSION}\n")
        fh.write(f"host={host}\n")
        fh.write(f"generated_at_utc={summary['generated_at']}\n")
        fh.write(f"mode={mode}\n")
        fh.write(f"files_discovered={len(files)}\n")
        fh.write(f"reports_indexed={len(reports)}\n")
        fh.write("raw_diagnostic_bodies_copied=0\n")
        fh.write("database_written=0\n")

    (package_root / "README.txt").write_text(
        "OSI IBM MQ diagnostic header index\n\n"
        "This package contains only extracted First Failure Symptom Report header metadata,\n"
        "source-file inventory/provenance, and aggregate signatures. It does not contain raw\n"
        "FDC/FFST bodies, queue data, or database output.\n\n"
        "Mode semantics:\n"
        "- first_report: bounded survey; reads only enough of each file to capture its first report.\n"
        "- all_reports: sequentially scans each file and extracts every report header found.\n\n"
        "Use all_reports during an approved low-impact window when very large FDC files exist.\n",
        encoding="utf-8",
    )

    checksums: list[str] = []
    for path in sorted(package_root.iterdir()):
        if path.is_file() and path.name != "package-checksums.sha256":
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            checksums.append(f"{digest}  {path.name}")
    (package_root / "package-checksums.sha256").write_text("\n".join(checksums) + "\n", encoding="ascii")

    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description="Index IBM MQ FDC/FFST report headers without copying diagnostic bodies")
    parser.add_argument("--root", action="append", default=[], help="MQ data/log root to scan; may be repeated")
    parser.add_argument("--output-dir", default=".", help="Directory for generated index archive")
    parser.add_argument("--all-reports", action="store_true", help="Sequentially scan entire files and index every report header")
    parser.add_argument("--first-scan-bytes", type=int, default=DEFAULT_FIRST_SCAN_BYTES, help="Per-file byte ceiling in first-report mode")
    parser.add_argument("--limit-files", type=int, default=0, help="Optional test/sampling limit; 0 means all discovered files")
    args = parser.parse_args()

    if args.first_scan_bytes < 16384:
        parser.error("--first-scan-bytes must be at least 16384")
    if args.limit_files < 0:
        parser.error("--limit-files must be >= 0")

    roots = [Path(value) for value in args.root]
    roots.insert(0, Path("/var/mqm"))
    roots.extend(parse_mqs_ini(Path("/var/mqm/mqs.ini")))
    active_roots = dedupe_roots(roots)
    if not active_roots:
        parser.error("no existing MQ search roots were found")

    discovered = discover_files(active_roots)
    if args.limit_files:
        discovered = discovered[: args.limit_files]

    host = os.uname().nodename.split(".", 1)[0] if hasattr(os, "uname") else "unknown"
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    mode = "all_reports" if args.all_reports else "first_report"
    name = f"mq-diagnostic-header-index-{safe_name(host)}-{stamp}"
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    temp_root = Path(tempfile.mkdtemp(prefix="osi-mq-diagnostic-index."))
    package_root = temp_root / name

    files: list[dict[str, Any]] = []
    reports: list[dict[str, Any]] = []
    try:
        for path in discovered:
            file_reports, file_record = scan_file(path, args.all_reports, args.first_scan_bytes)
            reports.extend(file_reports)
            files.append(file_record)

        summary = write_outputs(package_root, active_roots, files, reports, mode, args.first_scan_bytes, host)
        archive = output_dir / f"{name}.tar.gz"
        with tarfile.open(archive, "w:gz") as tf:
            tf.add(package_root, arcname=name)
        print(
            json.dumps(
                {
                    "archive": str(archive),
                    "mode": mode,
                    "files_discovered": summary["files_discovered"],
                    "reports_indexed": summary["reports_indexed"],
                    "unique_signatures": summary["unique_signatures"],
                    "bytes_read_total": summary["bytes_read_total"],
                },
                indent=2,
            )
        )
        return 0
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
