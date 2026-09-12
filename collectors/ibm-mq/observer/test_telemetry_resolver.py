#!/usr/bin/env python3
from __future__ import annotations

import copy
import unittest

import telemetry_resolver as resolver

QM_ID = "cent_aaaaaaaaaaaaaaaaaaaaaaaa"
Q_ID = "cent_bbbbbbbbbbbbbbbbbbbbbbbb"
ALT_Q_ID = "cent_cccccccccccccccccccccccc"


def snapshot(duplicate_queue: bool = False) -> dict:
    entities = [
        {
            "entity_id": QM_ID,
            "semantic_type": "mq.queue_manager",
            "identity_rule": "qmid",
            "identity_key": "QMID-123",
            "identity_state": "resolved",
            "display_name": "QM1",
            "properties": {"QMID": "QMID-123"},
        },
        {
            "entity_id": Q_ID,
            "semantic_type": "mq.queue",
            "identity_rule": "rule_2",
            "identity_key": "queue_manager_key=qm1|name=q.test.out",
            "identity_state": "resolved",
            "display_name": "Q.TEST.OUT",
            "properties": {"QUEUE_MANAGER": "QM1"},
        },
    ]
    if duplicate_queue:
        entities.append({
            "entity_id": ALT_Q_ID,
            "semantic_type": "mq.queue",
            "identity_rule": "rule_2",
            "identity_key": "queue_manager_key=qm1|name=q.test.out",
            "identity_state": "resolved",
            "display_name": "Q.TEST.OUT",
            "properties": {"QUEUE_MANAGER": "QM1"},
        })
    return {
        "schema_version": "osi.telemetry.identity-snapshot/v1",
        "estate_revision_id": "estate_test",
        "built_at": "2026-09-11T00:00:00Z",
        "entities": entities,
    }


def observation(semantic_type: str, display_name: str, hints: dict, obs_id: str = "tobs_111111111111111111111111") -> dict:
    return {
        "observation_id": obs_id,
        "entity": {
            "semantic_type": semantic_type,
            "display_name": display_name,
            "identity_hints": hints,
        },
        "observation_type": "test.metric",
        "observed_at": "2026-09-11T00:00:01Z",
        "value": 1,
        "unit": "count",
        "source": {
            "source_id": "mq-a.example",
            "source_host": "mq-a",
            "queue_manager": "QM1",
            "collection_method": "mqsc:DISPLAY QSTATUS(*) TYPE(QUEUE) ALL",
            "command": "DISPLAY QSTATUS(*) TYPE(QUEUE) ALL",
            "evidence_class": "observed",
            "evidence_ref": "telemetry://telemetry_test/sample-0001/QM1/queue_status",
            "sample_id": "sample-0001",
        },
        "quality": {"coverage": "point_in_time", "freshness": "sampled"},
    }


def batch(observations: list[dict]) -> dict:
    return {
        "schema_version": "osi.telemetry.batch/v1",
        "run": {
            "run_id": "telemetry_test",
            "observer": "osi-mq-observer",
            "observer_version": "0.2.0",
            "profile": "baseline",
            "started_at": "2026-09-11T00:00:00Z",
            "completed_at": "2026-09-11T00:00:01Z",
            "sample_count": 1,
            "sample_interval_seconds": 60,
            "source": {"kind": "ibm_mq_host", "source_id": "mq-a.example", "source_host": "mq-a"},
        },
        "coverage": [],
        "observations": observations,
    }


class ResolverTests(unittest.TestCase):
    def test_qmgr_resolves_by_qmid_and_queue_by_scoped_identity(self):
        qmgr = observation("mq.queue_manager", "QM1", {"queue_manager_name": "QM1", "queue_manager_qmid": "QMID-123"})
        queue = observation(
            "mq.queue",
            "Q.TEST.OUT",
            {"queue_manager_name": "QM1", "queue_manager_qmid": "QMID-123", "name": "Q.TEST.OUT"},
            "tobs_222222222222222222222222",
        )
        result = resolver.resolve_batch(batch([qmgr, queue]), snapshot())
        self.assertEqual(result["summary"], {"input_observations": 2, "resolved": 2, "quarantined": 0})
        self.assertEqual(result["resolved_observations"][0]["entity"]["canonical_entity_id"], QM_ID)
        self.assertEqual(result["resolved_observations"][0]["resolution"]["method"], "resolved_by_qmid")
        self.assertEqual(result["resolved_observations"][1]["entity"]["canonical_entity_id"], Q_ID)
        self.assertEqual(result["resolved_observations"][1]["resolution"]["method"], "resolved_by_scoped_identity")

    def test_registry_logical_key_prefix_is_understood(self):
        snap = snapshot()
        snap["entities"][0]["identity_rule"] = "rule_2"
        snap["entities"][0]["identity_key"] = "rule_2:qmid=qmid-123"
        snap["entities"][0]["properties"] = {}
        snap["entities"][1]["identity_key"] = "rule_2:queue_manager_key=qm1|name=q.test.out"
        queue = observation(
            "mq.queue", "Q.TEST.OUT",
            {"queue_manager_name": "QM1", "queue_manager_qmid": "QMID-123", "name": "Q.TEST.OUT"},
        )
        result = resolver.resolve_batch(batch([queue]), snap)
        self.assertEqual(result["summary"]["resolved"], 1)
        self.assertEqual(result["resolved_observations"][0]["entity"]["canonical_entity_id"], Q_ID)

    def test_untrusted_prepopulated_canonical_id_is_quarantined(self):
        item = observation("mq.queue", "Q.TEST.OUT", {"queue_manager_name": "QM1", "name": "Q.TEST.OUT"})
        item["entity"]["canonical_entity_id"] = Q_ID
        result = resolver.resolve_batch(batch([item]), snapshot())
        self.assertEqual(result["summary"]["resolved"], 0)
        self.assertEqual(result["quarantine"][0]["reason"], "untrusted_canonical_id_supplied")
        self.assertEqual(result["quarantine"][0]["candidate_entity_ids"], [])

    def test_qmid_name_mismatch_is_not_allowed_to_fallback_by_name(self):
        item = observation("mq.queue_manager", "QM2", {"queue_manager_name": "QM2", "queue_manager_qmid": "QMID-123"})
        item["source"]["queue_manager"] = "QM2"
        result = resolver.resolve_batch(batch([item]), snapshot())
        self.assertEqual(result["summary"]["quarantined"], 1)
        self.assertEqual(result["quarantine"][0]["reason"], "queue_manager_identity_mismatch")

    def test_missing_qmid_match_is_quarantined_even_when_name_exists(self):
        item = observation("mq.queue_manager", "QM1", {"queue_manager_name": "QM1", "queue_manager_qmid": "QMID-NEW"})
        result = resolver.resolve_batch(batch([item]), snapshot())
        self.assertEqual(result["quarantine"][0]["reason"], "qmid_not_found")

    def test_ambiguous_scoped_identity_is_quarantined_with_candidates(self):
        item = observation("mq.queue", "Q.TEST.OUT", {"queue_manager_name": "QM1", "name": "Q.TEST.OUT"})
        result = resolver.resolve_batch(batch([item]), snapshot(duplicate_queue=True))
        self.assertEqual(result["quarantine"][0]["reason"], "ambiguous_scoped_identity")
        self.assertEqual(set(result["quarantine"][0]["candidate_entity_ids"]), {Q_ID, ALT_Q_ID})

    def test_conflicted_canonical_entity_is_explicitly_quarantined(self):
        snap = snapshot()
        snap["entities"][1]["identity_state"] = "conflicted"
        item = observation("mq.queue", "Q.TEST.OUT", {"queue_manager_name": "QM1", "name": "Q.TEST.OUT"})
        result = resolver.resolve_batch(batch([item]), snap)
        self.assertEqual(result["quarantine"][0]["reason"], "canonical_identity_not_resolved")
        self.assertEqual(result["quarantine"][0]["candidate_entity_ids"], [Q_ID])

    def test_resolved_and_conflicted_same_identity_is_not_silently_resolved(self):
        snap = snapshot()
        conflicted = copy.deepcopy(snap["entities"][1])
        conflicted["entity_id"] = ALT_Q_ID
        conflicted["identity_state"] = "conflicted"
        snap["entities"].append(conflicted)
        item = observation("mq.queue", "Q.TEST.OUT", {"queue_manager_name": "QM1", "name": "Q.TEST.OUT"})
        result = resolver.resolve_batch(batch([item]), snap)
        self.assertEqual(result["quarantine"][0]["reason"], "canonical_identity_conflict")
        self.assertEqual(set(result["quarantine"][0]["candidate_entity_ids"]), {Q_ID, ALT_Q_ID})

    def test_source_queue_manager_must_match_identity_hint(self):
        item = observation("mq.queue", "Q.TEST.OUT", {"queue_manager_name": "QM2", "name": "Q.TEST.OUT"})
        result = resolver.resolve_batch(batch([item]), snapshot())
        self.assertEqual(result["quarantine"][0]["reason"], "source_identity_mismatch")

    def test_batch_source_mismatch_is_structural_error(self):
        item = observation("mq.queue", "Q.TEST.OUT", {"queue_manager_name": "QM1", "name": "Q.TEST.OUT"})
        item["source"]["source_id"] = "other.example"
        with self.assertRaises(resolver.ResolutionError):
            resolver.resolve_batch(batch([item]), snapshot())

    def test_duplicate_observation_id_is_structural_error(self):
        first = observation("mq.queue", "Q.TEST.OUT", {"queue_manager_name": "QM1", "name": "Q.TEST.OUT"})
        second = copy.deepcopy(first)
        with self.assertRaises(resolver.ResolutionError):
            resolver.resolve_batch(batch([first, second]), snapshot())

    def test_invalid_or_duplicate_snapshot_entity_id_is_rejected(self):
        snap = snapshot()
        snap["entities"].append(copy.deepcopy(snap["entities"][1]))
        with self.assertRaises(resolver.ResolutionError):
            resolver.resolve_batch(batch([]), snap)

    def test_unsupported_semantic_type_is_quarantined(self):
        item = observation("mq.process", "P.TEST", {"queue_manager_name": "QM1", "name": "P.TEST"})
        result = resolver.resolve_batch(batch([item]), snapshot())
        self.assertEqual(result["quarantine"][0]["reason"], "unsupported_semantic_type")


if __name__ == "__main__":
    unittest.main()
