PRAGMA foreign_keys = ON;

INSERT INTO semantic_source_revision (
  revision_id, run_id, source_kind, source_id, source_display_name, environment,
  collector, collector_version, normalizer_version, completed_at, imported_at, activated_at,
  archive_filename, archive_sha256, archive_size_bytes, bundle_sha256,
  expected_coverage_count, expected_entity_count, expected_relation_count, expected_unresolved_count,
  status, is_current, quality_json
) VALUES (
  'route-source-revision', 'ci:route:source', 'ibm_mq_host', 'host-route', 'host-route', 'ci',
  'synthetic', '1', '3.1.0', '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z',
  'route.tar.gz', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1,
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  0, 0, 0, 0, 'ACTIVE', 1, '{"valid":true}'
);

INSERT INTO semantic_estate_revision (
  estate_revision_id, source_set_hash, source_revision_ids_json, built_at, activated_at,
  status, is_current, expected_entity_count, expected_relation_count, expected_unresolved_count, quality_json
) VALUES (
  'estate-route-ci',
  'e41d40e45fb8da4fb01b9f67b81732e321a5f8cc23843d7ce1b16e75c3e26073',
  '["route-source-revision"]', '2026-09-09T00:01:00Z', '2026-09-09T00:01:00Z',
  'ACTIVE', 1, 7, 6, 1, '{"valid":true,"source_count":1}'
);

INSERT INTO semantic_estate_entity
(estate_revision_id, entity_id, semantic_type, identity_rule, identity_key, identity_state, display_name, observed_at, properties_json, evidence_classes_json, source_ids_json, source_observations_json, evidence_count, source_count)
VALUES
('estate-route-ci','app-producer','app.application_instance','rule_2','host_key=client-a|name=PRODUCER','resolved','PRODUCER','2026-09-09T00:00:00Z','{"host":"client-a"}','["observed"]','["host-route"]','[]',1,1),
('estate-route-ci','q-remote','mq.queue','rule_2','queue_manager_key=QM1|name=OUT.REMOTE','resolved','OUT.REMOTE','2026-09-09T00:00:00Z','{"queue_manager":"QM1","queue_type":"QREMOTE"}','["configured"]','["host-route"]','[]',1,1),
('estate-route-ci','q-target','mq.queue','rule_2','queue_manager_key=QM2|name=IN.LOCAL','resolved','IN.LOCAL','2026-09-09T00:00:00Z','{"queue_manager":"QM2","queue_type":"QLOCAL"}','["configured"]','["host-route"]','[]',1,1),
('estate-route-ci','app-consumer','app.application_instance','rule_2','host_key=client-b|name=CONSUMER','resolved','CONSUMER','2026-09-09T00:00:00Z','{"host":"client-b"}','["observed"]','["host-route"]','[]',1,1),
('estate-route-ci','q-xmit','mq.queue','rule_2','queue_manager_key=QM1|name=QM2.XMIT','resolved','QM2.XMIT','2026-09-09T00:00:00Z','{"queue_manager":"QM1","queue_type":"QLOCAL","usage":"XMITQ"}','["configured"]','["host-route"]','[]',1,1),
('estate-route-ci','ch-sender','mq.channel','rule_2','queue_manager_key=QM1|name=TO.QM2','resolved','TO.QM2','2026-09-09T00:00:00Z','{"queue_manager":"QM1","channel_type":"SDR"}','["configured","observed"]','["host-route"]','[]',2,1),
('estate-route-ci','qm-peer','mq.queue_manager','qmid','QM2_2026','resolved','QM2','2026-09-09T00:00:00Z','{"queue_manager":"QM2"}','["observed"]','["host-route"]','[]',1,1);

INSERT INTO semantic_estate_relation
(estate_revision_id, relation_id, semantic_type, source_entity_id, target_entity_id, observed_at, properties_json, evidence_classes_json, source_ids_json, source_observations_json, evidence_count, source_count)
VALUES
('estate-route-ci','r-open-output','runtime.opens_for_output','app-producer','q-remote','2026-09-09T00:00:00Z','{}','["observed"]','["host-route"]','[]',1,1),
('estate-route-ci','r-resolve','routing.resolves_to','q-remote','q-target','2026-09-09T00:00:00Z','{}','["configured"]','["host-route"]','[]',1,1),
('estate-route-ci','r-open-input','runtime.opens_for_input','app-consumer','q-target','2026-09-09T00:00:00Z','{}','["observed"]','["host-route"]','[]',1,1),
('estate-route-ci','r-route-via','routing.routes_via','q-remote','q-xmit','2026-09-09T00:00:00Z','{}','["configured"]','["host-route"]','[]',1,1),
('estate-route-ci','r-transmit','routing.transmits_via','q-xmit','ch-sender','2026-09-09T00:00:00Z','{}','["configured"]','["host-route"]','[]',1,1),
('estate-route-ci','r-connect','network.connects_to','ch-sender','qm-peer','2026-09-09T00:00:00Z','{}','["observed"]','["host-route"]','[]',1,1);

INSERT INTO semantic_estate_unresolved
(estate_revision_id, unresolved_id, source_entity_id, semantic_type, expected_target_type, vendor_value, state, reason, candidate_entity_ids_json, source_ids_json, source_observations_json, evidence_count)
VALUES
('estate-route-ci','u-route','q-remote','routing.resolves_to','mq.queue','QM2:ALT.DYNAMIC','dynamic','multiple_cluster_candidates','[]','["host-route"]','[]',1);
