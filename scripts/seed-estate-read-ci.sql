PRAGMA foreign_keys = ON;

INSERT INTO semantic_source_revision (
  revision_id, run_id, source_kind, source_id, source_display_name, environment,
  collector, collector_version, normalizer_version, completed_at, imported_at, activated_at,
  archive_filename, archive_sha256, archive_size_bytes, bundle_sha256,
  expected_coverage_count, expected_entity_count, expected_relation_count, expected_unresolved_count,
  status, is_current, quality_json
) VALUES (
  'src-read-a', 'ci:estate-read:a1', 'ibm_mq_host', 'host-a', 'Host A', 'ci',
  'synthetic', '1', '3.1.0', '2026-09-09T00:00:00Z', '2026-09-09T00:01:00Z', '2026-09-09T00:02:00Z',
  'ci.tar.gz', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 100,
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  0, 2, 1, 1, 'ACTIVE', 1, '{"valid":true}'
);

INSERT INTO semantic_estate_revision (
  estate_revision_id, source_set_hash, source_revision_ids_json, built_at, activated_at,
  status, is_current, expected_entity_count, expected_relation_count, expected_unresolved_count, quality_json
) VALUES (
  'estate-read-1', '9fa350d5bcf267e008f14e828400304193a31e829d6ddc6f1c8932222f2b4a1a', '["src-read-a"]',
  '2026-09-09T00:03:00Z', '2026-09-09T00:04:00Z', 'ACTIVE', 1, 2, 1, 1,
  '{"valid":true,"conflicted_entities":0,"source_count":1}'
);

INSERT INTO semantic_estate_entity (
  estate_revision_id, entity_id, semantic_type, identity_rule, identity_key, identity_state,
  display_name, observed_at, properties_json, evidence_classes_json, source_ids_json,
  source_observations_json, evidence_count, source_count
) VALUES
  ('estate-read-1', 'ce-qm', 'mq.queue_manager', 'qmid', 'qmid=qm1_2026', 'resolved',
   'QM1', '2026-09-09T00:00:00Z', '{"qmid":"QM1_2026"}', '["observed"]', '["host-a"]',
   '[{"revision_id":"src-read-a","entity_ref":"qm-a"}]', 1, 1),
  ('estate-read-1', 'ce-q', 'mq.queue', 'rule_2', 'queue_manager_key=qm1|name=q.shared', 'resolved',
   'Q.SHARED', '2026-09-09T00:00:00Z', '{"queue_type":"QLOCAL"}', '["configured"]', '["host-a"]',
   '[{"revision_id":"src-read-a","entity_ref":"q-a"}]', 1, 1);

INSERT INTO semantic_estate_relation (
  estate_revision_id, relation_id, semantic_type, source_entity_id, target_entity_id, observed_at,
  properties_json, evidence_classes_json, source_ids_json, source_observations_json, evidence_count, source_count
) VALUES (
  'estate-read-1', 'cr-contains', 'contains', 'ce-qm', 'ce-q', '2026-09-09T00:00:00Z',
  '{}', '["configured"]', '["host-a"]', '[{"revision_id":"src-read-a","relation_ref":"r-a"}]', 1, 1
);

INSERT INTO semantic_estate_unresolved (
  estate_revision_id, unresolved_id, source_entity_id, semantic_type, expected_target_type,
  vendor_value, state, reason, candidate_entity_ids_json, source_ids_json, source_observations_json, evidence_count
) VALUES (
  'estate-read-1', 'cu-dynamic', 'ce-q', 'routing.resolves_to', 'mq.queue',
  'Q.REMOTE', 'dynamic', 'multiple cluster candidates', '["ce-q"]', '["host-a"]',
  '[{"revision_id":"src-read-a","unresolved_ref":"u-a"}]', 1
);
