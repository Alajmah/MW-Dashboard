#!/usr/bin/env python3
import importlib.util
import pathlib
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("findings", HERE / "evaluate_findings_v1.py")
findings = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = findings
assert SPEC.loader
SPEC.loader.exec_module(findings)


def sample(name, depth, age, ipprocs, opprocs, second, status=None):
    values = {
        "CURDEPTH": str(depth),
        "MSGAGE": str(age),
        "IPPROCS": str(ipprocs),
        "OPPROCS": str(opprocs),
    }
    if status is not None:
        values["STATUS"] = status
    return findings.SampleRecord(
        qmgr="QM1",
        object_name=name,
        semantic_type="mq.queue",
        sample_id=f"sample_{second:03d}",
        observed_at=f"2026-09-10T10:{second:02d}:00Z",
        evidence_ref=f"qmgr/QM1/runtime/sample_{second:03d}/queue-status.out",
        values=values,
    )


class FindingsV1RuleTests(unittest.TestCase):
    def test_backlog_positive(self):
        series = [
            sample("APP.OUT", 1, 1, 0, 1, 0),
            sample("APP.OUT", 5, 61, 0, 1, 1),
            sample("APP.OUT", 9, 121, 0, 1, 2),
            sample("APP.OUT", 14, 181, 0, 1, 3),
        ]
        self.assertTrue(findings.queue_backlog_increasing(series))
        self.assertTrue(findings.all_zero_input_processes(series))
        self.assertTrue(findings.any_output_process(series))

    def test_backlog_recovery_is_not_positive(self):
        series = [
            sample("APP.OUT", 68, 100, 0, 1, 0),
            sample("APP.OUT", 70, 160, 0, 1, 1),
            sample("APP.OUT", 70, 220, 0, 1, 2),
            sample("APP.OUT", 0, 0, 1, 1, 3),
            sample("APP.OUT", 2, 10, 1, 1, 4),
        ]
        self.assertFalse(findings.queue_backlog_increasing(series))

    def test_insufficient_samples_do_not_create_trend(self):
        series = [sample("APP.OUT", 1, 1, 0, 1, 0), sample("APP.OUT", 8, 61, 0, 1, 1)]
        self.assertFalse(findings.queue_backlog_increasing(series))
        self.assertFalse(findings.queue_oldest_message_aging(series))

    def test_oldest_message_aging_tracks_wall_time(self):
        series = [
            sample("APP.OUT", 8, 100, 1, 1, 0),
            sample("APP.OUT", 8, 160, 1, 1, 1),
            sample("APP.OUT", 8, 220, 1, 1, 2),
            sample("APP.OUT", 8, 280, 1, 1, 3),
        ]
        self.assertTrue(findings.queue_oldest_message_aging(series))

    def test_message_age_reset_is_not_aging(self):
        series = [
            sample("APP.OUT", 8, 100, 1, 1, 0),
            sample("APP.OUT", 8, 160, 1, 1, 1),
            sample("APP.OUT", 2, 10, 1, 1, 2),
            sample("APP.OUT", 3, 60, 1, 1, 3),
        ]
        self.assertFalse(findings.queue_oldest_message_aging(series))

    def test_system_queues_are_separate_policy_scope(self):
        self.assertTrue(findings.is_system_queue("SYSTEM.ADMIN.STATISTICS.QUEUE"))
        self.assertTrue(findings.is_system_queue("AMQ.MQEXPLORER.X"))
        self.assertTrue(findings.is_system_queue("KMQ.IRA.AGENT.QUEUE.X"))
        self.assertFalse(findings.is_system_queue("SVHUB.APP.REQUEST.OUT"))

    def test_canonical_ids_match_estate_builder_rules(self):
        qmid = "SVHUB01P_2020-03-04_13.57.51"
        expected_qm = "cent_" + findings.sha256_text(f"mq.queue_manager|qmid|{qmid.lower()}")[:24]
        self.assertEqual(findings.qmgr_entity_id("SVHUB01P", qmid), expected_qm)
        key = "queue_manager_key=svhub01p|name=app.out"
        expected_queue = "cent_" + findings.sha256_text(f"mq.queue|rule_2|{key}")[:24]
        self.assertEqual(findings.scoped_entity_id("mq.queue", "SVHUB01P", "APP.OUT"), expected_queue)

    def test_parse_display_blocks(self):
        text = """Starting MQSC.\nAMQ8450I: Display queue status details.\n   QUEUE(A) TYPE(QUEUE) CURDEPTH(2) IPPROCS(0)\n   MSGAGE(44)\nAMQ8450I: Display queue status details.\n   QUEUE(B) TYPE(QUEUE) CURDEPTH(0) IPPROCS(1)\n"""
        records = findings.parse_blocks(text)
        self.assertEqual([r["QUEUE"] for r in records], ["A", "B"])
        self.assertEqual(records[0]["MSGAGE"], "44")


if __name__ == "__main__":
    unittest.main()
