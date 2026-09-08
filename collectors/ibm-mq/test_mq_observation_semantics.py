#!/usr/bin/env python3
import os
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import normalize_mq_observations as norm


class MQObservationSemanticTest(unittest.TestCase):
    def test_cluster_qmgr_identity_and_alias_resolution(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            root = td / "mq-topology-fixture"
            self._write(root / "manifest.properties", "\n".join([
                "format=osi-mq-topology-raw",
                "format_version=1",
                "collector_version=test",
                "host=mqhost1",
                "started_at_utc=2026-09-08T00:00:00Z",
                "completed_at_utc=2026-09-08T00:01:00Z",
                "samples=1",
                "interval_seconds=0",
                "queue_manager_count=1",
                "run_as_user=mqm",
                "",
            ]))
            self._write(root / "host/hostname.out", "mqhost1\n")
            self._write(root / "host/hostname-fqdn.out", "mqhost1.example.internal\n")
            self._write(root / "host/ip-addresses.out", "1: eth0    inet 10.0.0.1/24 scope global eth0\n")
            self._command(root, "mq/dspmq", "QMNAME(QM_LOCAL) STATUS(Running)\n", rc=0)
            self._write(root / "qmgrs.tsv", "index\tqueue_manager\n001_QM_LOCAL\tQM_LOCAL\n")

            qbase = "qmgr/001_QM_LOCAL/config"
            self._command(
                root,
                f"{qbase}/qmgr",
                "AMQ8408I: Display Queue Manager details.\n   QMNAME(QM_LOCAL) QMID(QM_LOCAL_001) PLATFORM(UNIX)\n",
                rc=0,
                mqsc="DISPLAY QMGR ALL",
            )
            aliases = """AMQ8409I: Display Queue details.
   QUEUE(ALIAS.SINGLE) TYPE(QALIAS) TARGET(TARGET.SINGLE)
AMQ8409I: Display Queue details.
   QUEUE(ALIAS.MULTI) TYPE(QALIAS) TARGET(TARGET.MULTI)
AMQ8409I: Display Queue details.
   QUEUE(ALIAS.MISSING) TYPE(QALIAS) TARGET(TARGET.MISSING)
"""
            self._command(root, f"{qbase}/queues-alias", aliases, rc=0, mqsc="DISPLAY QALIAS(*) ALL")
            qcluster = """AMQ8409I: Display Queue details.
   QUEUE(TARGET.SINGLE) TYPE(QLOCAL) CLUSQMGR(QM_ONE) CLUSTER(CL1) CLUSQT(QLOCAL)
AMQ8409I: Display Queue details.
   QUEUE(TARGET.MULTI) TYPE(QLOCAL) CLUSQMGR(QM_ONE) CLUSTER(CL1) CLUSQT(QLOCAL)
AMQ8409I: Display Queue details.
   QUEUE(TARGET.MULTI) TYPE(QLOCAL) CLUSQMGR(QM_TWO) CLUSTER(CL1) CLUSQT(QLOCAL)
"""
            self._command(root, f"{qbase}/queues-cluster", qcluster, rc=0, mqsc="DISPLAY QCLUSTER(*) ALL")

            sample = "qmgr/001_QM_LOCAL/runtime/sample_001_20260908T000100Z"
            self._write(root / f"{sample}/captured-at-utc.txt", "2026-09-08T00:01:00Z\n")
            clusqm = """AMQ8441I: Display Cluster Queue Manager details.
   CLUSQMGR(QM_ONE) QMID(QM_ONE_001) CHANNEL(AUTO.QM_ONE) CLUSTER(CL1) QMTYPE(REPOS) DEFTYPE(CLUSSDRA) CONNAME(qm-one.example(1414)) STATUS(RUNNING)
AMQ8441I: Display Cluster Queue Manager details.
   CLUSQMGR(QM_TWO) QMID(QM_TWO_002) CHANNEL(AUTO.QM_TWO) CLUSTER(CL1) QMTYPE(NORMAL) DEFTYPE(CLUSSDRB) CONNAME(qm-two.example(1414)) STATUS(INACTIVE)
"""
            self._command(root, f"{sample}/cluster-qmgrs", clusqm, rc=0, mqsc="DISPLAY CLUSQMGR(*) ALL")

            archive = td / "fixture.tar.gz"
            with tarfile.open(archive, "w:gz") as tf:
                tf.add(root, arcname=root.name)

            data = norm.normalize(str(archive), "prod")
            entities = {e["ref"]: e for e in data["entities"]}

            qmid_by_name = {}
            for e in data["entities"]:
                if e["semantic_type"] != "mq.queue_manager":
                    continue
                qmid = e["identity"]["hints"].get("qmid")
                if qmid:
                    qmid_by_name.setdefault(e["display_name"], set()).add(qmid)
            self.assertEqual(qmid_by_name["QM_ONE"], {"QM_ONE_001"})
            self.assertEqual(qmid_by_name["QM_TWO"], {"QM_TWO_002"})

            channel_ids = {
                (e["identity"]["hints"].get("queue_manager_key"), e["identity"]["hints"].get("name"))
                for e in data["entities"]
                if e["semantic_type"] == "mq.channel"
            }
            self.assertIn(("QM_LOCAL", "AUTO.QM_ONE"), channel_ids)
            self.assertIn(("QM_LOCAL", "AUTO.QM_TWO"), channel_ids)

            coverage = {(c["scope_key"], c["object_class"]): c for c in data["coverage"]}
            queue_cov = coverage[("QM_LOCAL", "relation:mq.cluster_discovers:queue")]
            qmgr_cov = coverage[("QM_LOCAL", "relation:mq.cluster_discovers:queue_manager")]
            self.assertEqual(queue_cov["properties"]["target_type"], "mq.queue")
            self.assertEqual(qmgr_cov["properties"]["target_type"], "mq.queue_manager")
            self.assertEqual(queue_cov["properties"]["relationship_type"], "mq.cluster_discovers")
            self.assertEqual(qmgr_cov["properties"]["relationship_type"], "mq.cluster_discovers")

            aliases_by_name = {
                e["display_name"]: e["ref"]
                for e in data["entities"]
                if e["semantic_type"] == "mq.queue" and e["display_name"].startswith("ALIAS.")
            }
            inferred = [
                r for r in data["relations"]
                if r["semantic_type"] == "routing.resolves_to" and r["evidence_class"] == "inferred"
            ]
            single = [r for r in inferred if r["source_ref"] == aliases_by_name["ALIAS.SINGLE"]]
            self.assertEqual(len(single), 1)
            self.assertTrue(single[0].get("deterministic"))
            self.assertEqual(entities[single[0]["target_ref"]]["display_name"], "TARGET.SINGLE")
            self.assertEqual(entities[single[0]["target_ref"]]["properties"]["queue_manager"], "QM_ONE")

            unresolved = {u["source_ref"]: u for u in data["unresolved_references"]}
            multi = unresolved[aliases_by_name["ALIAS.MULTI"]]
            self.assertEqual(multi["state"], "dynamic")
            self.assertEqual(multi["reason"], "cluster_alias_multiple_candidates")
            self.assertEqual(len(multi["candidate_refs"]), 2)
            missing = unresolved[aliases_by_name["ALIAS.MISSING"]]
            self.assertEqual(missing["state"], "unresolved")
            self.assertEqual(missing["reason"], "alias_target_not_collected")
            self.assertNotIn(aliases_by_name["ALIAS.SINGLE"], unresolved)

            self.assertFalse(any(r["semantic_type"].startswith("activity.") for r in data["relations"]))

    @staticmethod
    def _write(path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def _command(self, root, base, out, rc=0, mqsc=None):
        self._write(root / f"{base}.out", out)
        self._write(root / f"{base}.err", "")
        self._write(root / f"{base}.rc", f"{rc}\n")
        if mqsc is not None:
            self._write(root / f"{base}.mqsc", mqsc + "\n")


if __name__ == "__main__":
    unittest.main()
