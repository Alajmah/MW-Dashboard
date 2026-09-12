#!/usr/bin/env python3
from __future__ import annotations

import json
import tempfile
import time
import unittest
from pathlib import Path

import telemetry_delivery as delivery
import telemetry_resolver as resolver


def cent(index: int) -> str:
    return f"cent_{index:024x}"


def tobs(index: int) -> str:
    return f"tobs_{index:024x}"


def identity_snapshot(queue_count: int) -> dict:
    entities = [
        {
            "entity_id": cent(1),
            "semantic_type": "mq.queue_manager",
            "identity_rule": "qmid",
            "identity_key": "QMID-LOAD-1",
            "identity_state": "resolved",
            "display_name": "QMLOAD",
            "properties": {"QMID": "QMID-LOAD-1"},
        }
    ]
    for i in range(1, queue_count + 1):
        entities.append({
            "entity_id": cent(1000 + i),
            "semantic_type": "mq.queue",
            "identity_rule": "rule_2",
            "identity_key": f"queue_manager_key=qmload|name=q.load.{i:04d}",
            "identity_state": "resolved",
            "display_name": f"Q.LOAD.{i:04d}",
            "properties": {},
        })
    return {
        "schema_version": "osi.telemetry.identity-snapshot/v1",
        "estate_revision_id": "estate_phase2m_load",
        "built_at": "2026-09-12T08:00:00Z",
        "entities": entities,
    }


def batch(batch_index: int, observation_count: int, known_queue_count: int) -> dict:
    observations = []
    for i in range(1, observation_count + 1):
        queue_index = ((batch_index * observation_count + i - 1) % (known_queue_count + 10)) + 1
        name = f"Q.LOAD.{queue_index:04d}"
        observations.append({
            "observation_id": tobs(batch_index * 100000 + i),
            "entity": {
                "semantic_type": "mq.queue",
                "display_name": name,
                "identity_hints": {
                    "queue_manager_name": "QMLOAD",
                    "queue_manager_qmid": "QMID-LOAD-1",
                    "name": name,
                },
            },
            "observation_type": "mq.queue.depth.current",
            "observed_at": f"2026-09-12T08:{batch_index % 60:02d}:00Z",
            "value": i,
            "unit": "messages",
            "source": {
                "source_id": "mq-load.example",
                "source_host": "mq-load",
                "queue_manager": "QMLOAD",
                "collection_method": "mqsc:DISPLAY QSTATUS(*) TYPE(QUEUE) ALL",
                "command": "DISPLAY QSTATUS(*) TYPE(QUEUE) ALL",
                "evidence_class": "observed",
                "evidence_ref": f"telemetry://sample-{batch_index:04d}/QMLOAD/queue_status",
                "sample_id": f"sample-{batch_index:04d}",
            },
            "quality": {"coverage": "point_in_time", "freshness": "sampled"},
        })
    return {
        "schema_version": "osi.telemetry.batch/v1",
        "run": {
            "run_id": f"telemetry_phase2m_{batch_index:04d}",
            "observer": "osi-mq-observer",
            "observer_version": "0.2.0",
            "profile": "baseline",
            "started_at": "2026-09-12T08:00:00Z",
            "completed_at": "2026-09-12T08:00:01Z",
            "sample_count": 1,
            "sample_interval_seconds": 60,
            "source": {"kind": "ibm_mq_host", "source_id": "mq-load.example", "source_host": "mq-load"},
        },
        "coverage": [],
        "observations": observations,
    }


class Phase2MLoadTests(unittest.TestCase):
    def test_offline_chain_handles_representative_batch_volume(self):
        batch_count = 20
        observations_per_batch = 250
        known_queue_count = 240
        snapshot = identity_snapshot(known_queue_count)

        resolved_total = 0
        quarantined_total = 0
        payload_bytes = 0
        started = time.perf_counter()

        with tempfile.TemporaryDirectory() as tmp:
            spool = Path(tmp)
            first_raw = None
            first_delivery = None
            for batch_index in range(batch_count):
                item = batch(batch_index, observations_per_batch, known_queue_count)
                raw = delivery.canonical_json_bytes(item)
                payload_bytes += len(raw)
                did, created = delivery.spool_batch(raw, spool)
                self.assertTrue(created)
                if first_raw is None:
                    first_raw = raw
                    first_delivery = did

                result = resolver.resolve_batch(item, snapshot)
                resolved_total += result["summary"]["resolved"]
                quarantined_total += result["summary"]["quarantined"]
                self.assertEqual(result["summary"]["input_observations"], observations_per_batch)

            duplicate_id, duplicate_created = delivery.spool_batch(first_raw, spool)
            self.assertEqual(duplicate_id, first_delivery)
            self.assertFalse(duplicate_created)
            self.assertEqual(delivery.spool_status(spool), {"pending": batch_count, "sent": 0, "dead": 0})

            spool_bytes = sum(path.stat().st_size for path in (spool / "pending").glob("*.json"))

        elapsed = time.perf_counter() - started
        total = batch_count * observations_per_batch
        self.assertEqual(resolved_total + quarantined_total, total)
        self.assertGreater(resolved_total, quarantined_total)
        self.assertGreater(quarantined_total, 0, "load fixture must exercise quarantine semantics")
        self.assertLess(payload_bytes, 16 * 1024 * 1024, "representative fixture unexpectedly exceeds 16 MiB total")

        print(json.dumps({
            "harness": "phase2m-telemetry-load/v1",
            "batches": batch_count,
            "observations": total,
            "resolved": resolved_total,
            "quarantined": quarantined_total,
            "payload_bytes": payload_bytes,
            "spool_bytes": spool_bytes,
            "elapsed_seconds": round(elapsed, 4),
            "note": "Timing is reported for visibility only; CI does not impose a wall-clock SLA.",
        }, sort_keys=True))


if __name__ == "__main__":
    unittest.main()
