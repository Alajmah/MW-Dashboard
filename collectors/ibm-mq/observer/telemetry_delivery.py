#!/usr/bin/env python3
"""Durable, authenticated outbound delivery for OSI telemetry batches.

This module is intentionally separate from osi_mq_observer.py. The observer only
collects read-only IBM MQ evidence. This publisher accepts an already-produced
osi.telemetry.batch/v1 document, canonicalizes it, writes it durably to a local
spool, and can POST pending deliveries to a configured HTTPS endpoint.

No Cloudflare/D1 credentials or MQ administrative capability are required by
this module. Authentication is a narrow HMAC delivery credential.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "osi.telemetry.batch/v1"
SIGNATURE_VERSION = "v1"
DEFAULT_SECRET_ENV = "OSI_TELEMETRY_SECRET"
USER_AGENT = "osi-telemetry-publisher/0.1"


class DeliveryError(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def load_batch_bytes(raw: bytes) -> tuple[dict[str, Any], bytes]:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise DeliveryError(f"telemetry batch is not valid UTF-8 JSON: {exc}") from exc
    if not isinstance(value, dict) or value.get("schema_version") != SCHEMA_VERSION:
        raise DeliveryError(f"expected {SCHEMA_VERSION}")
    run = value.get("run")
    if not isinstance(run, dict) or not str(run.get("run_id") or "").strip():
        raise DeliveryError("telemetry batch run.run_id is required")
    if not isinstance(value.get("observations"), list) or not isinstance(value.get("coverage"), list):
        raise DeliveryError("telemetry batch coverage and observations must be arrays")
    return value, canonical_json_bytes(value)


def sha256_hex(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def delivery_id(payload: bytes) -> str:
    return "tdel_" + sha256_hex(payload)[:24]


def signing_message(timestamp: str, delivery: str, payload_sha256: str) -> bytes:
    return f"{SIGNATURE_VERSION}\n{timestamp}\n{delivery}\n{payload_sha256}".encode("utf-8")


def signature_hex(secret: str, timestamp: str, delivery: str, payload_sha256: str) -> str:
    if not secret:
        raise DeliveryError("delivery secret must not be empty")
    return hmac.new(secret.encode("utf-8"), signing_message(timestamp, delivery, payload_sha256), hashlib.sha256).hexdigest()


def signed_headers(payload: bytes, key_id: str, secret: str, timestamp: str | None = None) -> dict[str, str]:
    if not key_id.strip():
        raise DeliveryError("key id must not be empty")
    ts = timestamp or str(int(time.time()))
    digest = sha256_hex(payload)
    did = delivery_id(payload)
    sig = signature_hex(secret, ts, did, digest)
    return {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "X-OSI-Key-Id": key_id,
        "X-OSI-Timestamp": ts,
        "X-OSI-Delivery-Id": did,
        "X-OSI-Content-SHA256": digest,
        "X-OSI-Signature": f"{SIGNATURE_VERSION}={sig}",
    }


def verify_signature(payload: bytes, headers: dict[str, str], secret: str, *, now: int | None = None, max_skew_seconds: int = 300) -> tuple[bool, str]:
    normalized = {str(k).lower(): str(v) for k, v in headers.items()}
    required = ["x-osi-key-id", "x-osi-timestamp", "x-osi-delivery-id", "x-osi-content-sha256", "x-osi-signature"]
    missing = [key for key in required if not normalized.get(key)]
    if missing:
        return False, "missing_headers:" + ",".join(missing)
    digest = sha256_hex(payload)
    if not hmac.compare_digest(normalized["x-osi-content-sha256"].lower(), digest):
        return False, "content_hash_mismatch"
    expected_delivery = delivery_id(payload)
    if not hmac.compare_digest(normalized["x-osi-delivery-id"], expected_delivery):
        return False, "delivery_id_mismatch"
    try:
        ts = int(normalized["x-osi-timestamp"])
    except ValueError:
        return False, "invalid_timestamp"
    clock = int(time.time()) if now is None else int(now)
    if abs(clock - ts) > max_skew_seconds:
        return False, "timestamp_outside_window"
    supplied = normalized["x-osi-signature"]
    prefix = SIGNATURE_VERSION + "="
    if not supplied.startswith(prefix):
        return False, "unsupported_signature_version"
    expected = signature_hex(secret, str(ts), expected_delivery, digest)
    if not hmac.compare_digest(supplied[len(prefix):], expected):
        return False, "signature_mismatch"
    return True, "ok"


def ensure_spool(root: Path) -> None:
    for name in ("pending", "sent", "dead"):
        (root / name).mkdir(parents=True, exist_ok=True)


def _fsync_dir(path: Path) -> None:
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    fd, tmp_name = tempfile.mkstemp(prefix=".osi-", suffix=".tmp", dir=path.parent)
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        _fsync_dir(path.parent)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)


def record_for(batch: dict[str, Any], payload: bytes, *, created_at: str | None = None) -> dict[str, Any]:
    now = created_at or utc_now()
    return {
        "record_version": 1,
        "delivery_id": delivery_id(payload),
        "payload_sha256": sha256_hex(payload),
        "created_at": now,
        "updated_at": now,
        "attempts": 0,
        "next_attempt_epoch": 0,
        "last_error": None,
        "last_status": None,
        "batch": batch,
    }


def spool_batch(raw: bytes, root: Path) -> tuple[str, bool]:
    batch, payload = load_batch_bytes(raw)
    ensure_spool(root)
    did = delivery_id(payload)
    for state in ("pending", "sent"):
        if (root / state / f"{did}.json").exists():
            return did, False
    path = root / "pending" / f"{did}.json"
    atomic_write_json(path, record_for(batch, payload))
    return did, True


def backoff_seconds(attempt: int, delivery: str, *, base: int = 5, maximum: int = 900) -> int:
    attempt = max(1, attempt)
    exponential = min(maximum, base * (2 ** min(attempt - 1, 20)))
    jitter_cap = max(1, min(30, exponential // 4 or 1))
    seed = hashlib.sha256(f"{delivery}|{attempt}".encode()).digest()[0]
    return min(maximum, exponential + (seed % (jitter_cap + 1)))


def read_record(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DeliveryError(f"cannot read spool record {path}: {exc}") from exc
    if not isinstance(value, dict) or not isinstance(value.get("batch"), dict):
        raise DeliveryError(f"invalid spool record: {path}")
    payload = canonical_json_bytes(value["batch"])
    expected_id = delivery_id(payload)
    if value.get("delivery_id") != expected_id or value.get("payload_sha256") != sha256_hex(payload):
        raise DeliveryError(f"spool integrity check failed: {path}")
    return value


@dataclass(frozen=True)
class PostResult:
    status: int
    body: str


def post_payload(endpoint: str, payload: bytes, headers: dict[str, str], timeout: int) -> PostResult:
    if not endpoint.lower().startswith("https://") and not endpoint.lower().startswith("http://127.0.0.1") and not endpoint.lower().startswith("http://localhost"):
        raise DeliveryError("telemetry endpoint must use HTTPS; loopback HTTP is allowed only for tests")
    request = urllib.request.Request(endpoint, data=payload, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read(65536).decode("utf-8", errors="replace")
            return PostResult(int(response.status), body)
    except urllib.error.HTTPError as exc:
        body = exc.read(65536).decode("utf-8", errors="replace")
        raise DeliveryError(f"HTTP {exc.code}: {body[:500]}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise DeliveryError(f"delivery request failed: {exc}") from exc


def move_record(path: Path, target_dir: Path, record: dict[str, Any]) -> None:
    target = target_dir / path.name
    atomic_write_json(target, record)
    path.unlink(missing_ok=True)
    _fsync_dir(path.parent)


def publish_pending(root: Path, endpoint: str, key_id: str, secret: str, *, max_items: int = 20, timeout: int = 15, now_epoch: int | None = None) -> dict[str, int]:
    ensure_spool(root)
    clock = int(time.time()) if now_epoch is None else int(now_epoch)
    summary = {"considered": 0, "sent": 0, "failed": 0, "deferred": 0, "dead": 0}
    pending = sorted((root / "pending").glob("tdel_*.json"))
    for path in pending[:max_items]:
        summary["considered"] += 1
        try:
            record = read_record(path)
        except DeliveryError as exc:
            bad = {"record_version": 1, "delivery_id": path.stem, "updated_at": utc_now(), "last_error": str(exc)}
            move_record(path, root / "dead", bad)
            summary["dead"] += 1
            continue
        if int(record.get("next_attempt_epoch") or 0) > clock:
            summary["deferred"] += 1
            continue
        payload = canonical_json_bytes(record["batch"])
        headers = signed_headers(payload, key_id, secret, str(clock))
        try:
            result = post_payload(endpoint, payload, headers, timeout)
            if result.status < 200 or result.status >= 300:
                raise DeliveryError(f"unexpected HTTP status {result.status}")
            record["attempts"] = int(record.get("attempts") or 0) + 1
            record["updated_at"] = utc_now()
            record["last_status"] = result.status
            record["last_error"] = None
            record["ack_body"] = result.body[:2000]
            move_record(path, root / "sent", record)
            summary["sent"] += 1
        except DeliveryError as exc:
            attempts = int(record.get("attempts") or 0) + 1
            record["attempts"] = attempts
            record["updated_at"] = utc_now()
            record["last_error"] = str(exc)[:2000]
            record["last_status"] = None
            record["next_attempt_epoch"] = clock + backoff_seconds(attempts, str(record["delivery_id"]))
            atomic_write_json(path, record)
            summary["failed"] += 1
    return summary


def spool_status(root: Path) -> dict[str, int]:
    ensure_spool(root)
    return {name: len(list((root / name).glob("*.json"))) for name in ("pending", "sent", "dead")}


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Durable authenticated OSI telemetry delivery")
    sub = p.add_subparsers(dest="command", required=True)

    s = sub.add_parser("spool", help="Canonicalize and durably enqueue a telemetry batch")
    s.add_argument("--input", default="-", help="Batch JSON path or - for stdin")
    s.add_argument("--spool-dir", required=True)

    send = sub.add_parser("send", help="Send eligible pending spool records")
    send.add_argument("--spool-dir", required=True)
    send.add_argument("--endpoint", required=True)
    send.add_argument("--key-id", required=True)
    send.add_argument("--secret-env", default=DEFAULT_SECRET_ENV)
    send.add_argument("--max-items", type=int, default=20)
    send.add_argument("--timeout", type=int, default=15)

    st = sub.add_parser("status", help="Show spool counts")
    st.add_argument("--spool-dir", required=True)
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    root = Path(args.spool_dir)
    if args.command == "spool":
        raw = sys.stdin.buffer.read() if args.input == "-" else Path(args.input).read_bytes()
        try:
            did, created = spool_batch(raw, root)
        except (DeliveryError, OSError) as exc:
            print(f"osi-telemetry-publisher: {exc}", file=sys.stderr)
            return 2
        print(json.dumps({"delivery_id": did, "created": created, "spool": spool_status(root)}, sort_keys=True))
        return 0
    if args.command == "status":
        print(json.dumps(spool_status(root), sort_keys=True))
        return 0
    secret = os.environ.get(args.secret_env, "")
    if not secret:
        print(f"osi-telemetry-publisher: secret environment variable {args.secret_env} is required", file=sys.stderr)
        return 2
    if args.max_items < 1 or args.max_items > 1000 or args.timeout < 1 or args.timeout > 120:
        print("osi-telemetry-publisher: invalid max-items or timeout", file=sys.stderr)
        return 2
    try:
        result = publish_pending(root, args.endpoint, args.key_id, secret, max_items=args.max_items, timeout=args.timeout)
    except (DeliveryError, OSError) as exc:
        print(f"osi-telemetry-publisher: {exc}", file=sys.stderr)
        return 2
    print(json.dumps({"result": result, "spool": spool_status(root)}, sort_keys=True))
    return 0 if result["failed"] == 0 and result["dead"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
