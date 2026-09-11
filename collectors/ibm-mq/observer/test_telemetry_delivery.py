#!/usr/bin/env python3
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import telemetry_delivery as delivery


def sample_batch() -> dict:
    return {
        "schema_version": "osi.telemetry.batch/v1",
        "run": {
            "run_id": "telemetry_test",
            "observer": "osi-mq-observer",
            "observer_version": "0.1.0",
            "profile": "baseline",
            "started_at": "2026-09-11T00:00:00Z",
            "completed_at": "2026-09-11T00:00:01Z",
            "sample_count": 1,
            "sample_interval_seconds": 60,
            "source": {"kind": "ibm_mq_host", "source_id": "mq-a.example", "source_host": "mq-a"},
        },
        "coverage": [],
        "observations": [],
    }


class DeliveryTests(unittest.TestCase):
    def test_spool_is_content_idempotent_across_json_whitespace(self):
        batch = sample_batch()
        raw_a = json.dumps(batch, indent=2).encode()
        raw_b = json.dumps(batch, separators=(",", ":")).encode()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            did_a, created_a = delivery.spool_batch(raw_a, root)
            did_b, created_b = delivery.spool_batch(raw_b, root)
            self.assertEqual(did_a, did_b)
            self.assertTrue(created_a)
            self.assertFalse(created_b)
            self.assertEqual(delivery.spool_status(root), {"pending": 1, "sent": 0, "dead": 0})

    def test_signature_binds_payload_delivery_and_timestamp(self):
        payload = delivery.canonical_json_bytes(sample_batch())
        headers = delivery.signed_headers(payload, "observer-a", "top-secret", "1000")
        ok, reason = delivery.verify_signature(payload, headers, "top-secret", now=1000)
        self.assertTrue(ok, reason)
        tampered = payload + b"\n"
        ok, reason = delivery.verify_signature(tampered, headers, "top-secret", now=1000)
        self.assertFalse(ok)
        self.assertEqual(reason, "content_hash_mismatch")
        ok, reason = delivery.verify_signature(payload, headers, "top-secret", now=1400, max_skew_seconds=300)
        self.assertFalse(ok)
        self.assertEqual(reason, "timestamp_outside_window")

    def test_failed_send_stays_pending_with_backoff(self):
        raw = json.dumps(sample_batch()).encode()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            did, _ = delivery.spool_batch(raw, root)
            with mock.patch.object(delivery, "post_payload", side_effect=delivery.DeliveryError("network down")):
                summary = delivery.publish_pending(root, "https://telemetry.example/ingest", "observer-a", "secret", now_epoch=1000)
            self.assertEqual(summary["failed"], 1)
            self.assertEqual(delivery.spool_status(root)["pending"], 1)
            record = delivery.read_record(root / "pending" / f"{did}.json")
            self.assertEqual(record["attempts"], 1)
            self.assertGreater(record["next_attempt_epoch"], 1000)
            self.assertIn("network down", record["last_error"])

    def test_successful_send_moves_record_to_sent(self):
        raw = json.dumps(sample_batch()).encode()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            did, _ = delivery.spool_batch(raw, root)
            result = delivery.PostResult(202, '{"status":"accepted"}')
            with mock.patch.object(delivery, "post_payload", return_value=result):
                summary = delivery.publish_pending(root, "https://telemetry.example/ingest", "observer-a", "secret", now_epoch=1000)
            self.assertEqual(summary["sent"], 1)
            self.assertFalse((root / "pending" / f"{did}.json").exists())
            sent = delivery.read_record(root / "sent" / f"{did}.json")
            self.assertEqual(sent["last_status"], 202)
            self.assertEqual(sent["attempts"], 1)

    def test_non_https_remote_endpoint_is_rejected(self):
        with self.assertRaises(delivery.DeliveryError):
            delivery.post_payload("http://telemetry.example/ingest", b"{}", {}, 1)


if __name__ == "__main__":
    unittest.main()
