import importlib.util
import json
import pathlib
import sys
import unittest

MODULE_PATH = pathlib.Path(__file__).with_name("osi_mq_observer.py")
spec = importlib.util.spec_from_file_location("osi_mq_observer", MODULE_PATH)
observer = importlib.util.module_from_spec(spec)
assert spec and spec.loader
sys.modules[spec.name] = observer
spec.loader.exec_module(observer)


class ObserverContractTests(unittest.TestCase):
    def test_allowlist_contains_only_display_commands(self):
        self.assertTrue(observer.COMMANDS)
        for command in observer.COMMANDS.values():
            self.assertEqual(observer.safe_display_command(command), command)
            self.assertTrue(command.startswith("DISPLAY "))
        for forbidden in ("ALTER QMGR", "RESET QSTATS(*)", "CLEAR QLOCAL(X)", "START CHANNEL(X)"):
            with self.assertRaises(ValueError):
                observer.safe_display_command(forbidden)

    def test_queue_status_emits_existing_operational_metric_names(self):
        result = observer.CommandResult(
            family="queue_status",
            command=observer.COMMANDS["queue_status"],
            qmgr="QM.TEST",
            sample_id="sample-0001",
            observed_at="2026-09-11T00:00:00Z",
            returncode=0,
            stdout="""AMQ8450I: Display queue status details.\n   QUEUE(Q.TEST.OUT) TYPE(QUEUE) CURDEPTH(46) IPPROCS(0) OPPROCS(1) MSGAGE(258)\n""",
            stderr="",
        )
        rows = observer.observations_from_result("host.test", "host-test", "QMID.TEST", result)
        metrics = {row["observation_type"]: row for row in rows}
        self.assertEqual(set(metrics), {
            "mq.queue.depth.current",
            "mq.queue.process.input_count",
            "mq.queue.process.output_count",
            "mq.queue.message.age.oldest_seconds",
        })
        self.assertEqual(metrics["mq.queue.depth.current"]["value"], 46)
        self.assertEqual(metrics["mq.queue.message.age.oldest_seconds"]["value"], 258)
        self.assertEqual(metrics["mq.queue.depth.current"]["entity"]["identity_hints"], {
            "queue_manager_name": "QM.TEST",
            "queue_manager_qmid": "QMID.TEST",
            "name": "Q.TEST.OUT",
        })
        self.assertNotIn("canonical_entity_id", metrics["mq.queue.depth.current"]["entity"])

    def test_channel_instance_is_dimensioned_not_folded_into_identity(self):
        result = observer.CommandResult(
            family="channel_status",
            command=observer.COMMANDS["channel_status"],
            qmgr="QM.TEST",
            sample_id="sample-0001",
            observed_at="2026-09-11T00:00:00Z",
            returncode=0,
            stdout="""AMQ8417I: Display Channel Status details.\n   CHANNEL(TO.QM2) STATUS(RUNNING) JOBNAME(00000001) CONNAME(peer.example(1414)) RAPPLTAG(amqrmppa) CHLTYPE(SDR) MONCHL(OFF)\n""",
            stderr="",
        )
        rows = observer.observations_from_result("host.test", "host-test", "QMID.TEST", result)
        self.assertEqual({row["observation_type"] for row in rows}, {"mq.channel.status", "mq.channel.monitoring_level"})
        status = next(row for row in rows if row["observation_type"] == "mq.channel.status")
        self.assertEqual(status["entity"]["identity_hints"]["name"], "TO.QM2")
        self.assertEqual(status["dimensions"]["channel_type"], "SDR")
        self.assertIn("00000001", status["dimensions"]["channel_instance_key"])

    def test_mq_error_is_failed_coverage_and_emits_no_observations(self):
        result = observer.CommandResult(
            family="listener_status",
            command=observer.COMMANDS["listener_status"],
            qmgr="QM.TEST",
            sample_id="sample-0001",
            observed_at="2026-09-11T00:00:00Z",
            returncode=10,
            stdout="AMQ8146E: IBM MQ queue manager not available.\n",
            stderr="",
        )
        coverage = observer.coverage_from_result(result)
        self.assertEqual(coverage["state"], "failed")
        self.assertIn("AMQ8146E", coverage["error"])
        self.assertEqual(observer.observations_from_result("host.test", "host-test", None, result), [])

    def test_command_plan_has_no_mutating_or_consuming_capability(self):
        plan = observer.command_plan(["QM.TEST"])
        self.assertEqual(plan["safety"], {
            "mqsc_verbs": ["DISPLAY"],
            "message_consumption": False,
            "mq_state_mutation": False,
            "network_publish": False,
        })
        encoded = json.dumps(plan).upper()
        for forbidden in ("RESET QSTATS", "CLEAR QLOCAL", "ALTER QMGR", "START CHANNEL", "STOP CHANNEL"):
            self.assertNotIn(forbidden, encoded)


if __name__ == "__main__":
    unittest.main()
