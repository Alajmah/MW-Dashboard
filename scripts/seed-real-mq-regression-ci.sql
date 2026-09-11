PRAGMA foreign_keys = ON;

-- Sanitized CI fixture derived from a real read-only IBM MQ five-sample capture.
-- Production identifiers are intentionally not present in this file.

INSERT INTO semantic_source_revision (
  revision_id, run_id, source_kind, source_id, source_display_name, environment,
  collector, collector_version, normalizer_version, completed_at, imported_at, activated_at,
  archive_filename, archive_sha256, archive_size_bytes, bundle_sha256,
  expected_coverage_count, expected_entity_count, expected_relation_count, expected_unresolved_count,
  status, is_current, quality_json
) VALUES (
  'rev_regression_mq_realshape_001', 'ci:mq-real-shape:001', 'ibm_mq_host',
  'regression-host-a', 'regression-host-a', 'ci',
  'mq-topology-collector', '1.0.0', '3.1.0',
  '2026-09-08T05:14:32Z', '2026-09-08T06:00:00Z', '2026-09-08T06:00:00Z',
  'sanitized-mq-regression.tar.gz',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1,
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  5, 6, 5, 1, 'ACTIVE', 1,
  '{"valid":true,"sanitized":true,"derived_from_real_capture":true}'
);

INSERT INTO semantic_estate_revision (
  estate_revision_id, source_set_hash, source_revision_ids_json, built_at, activated_at,
  status, is_current, expected_entity_count, expected_relation_count, expected_unresolved_count, quality_json
) VALUES (
  'estate-regression-realshape-001',
  '55c7cce6a1cfc87864bcb0404a838f3e0b143af1cedd8d4cd381d2036078260e',
  '["rev_regression_mq_realshape_001"]',
  '2026-09-08T06:01:00Z', '2026-09-08T06:01:00Z',
  'ACTIVE', 1, 6, 5, 1,
  '{"valid":true,"source_count":1,"sanitized":true}'
);

INSERT INTO semantic_estate_entity
(estate_revision_id, entity_id, semantic_type, identity_rule, identity_key, identity_state,
 display_name, observed_at, properties_json, evidence_classes_json, source_ids_json,
 source_observations_json, evidence_count, source_count)
VALUES
('estate-regression-realshape-001','cent_111111111111111111111111','mq.queue','rule_2','queue_manager_key=QM_HUB_A|name=Q.REGRESSION.OUT','resolved','Q.REGRESSION.OUT','2026-09-08T05:14:28Z','{"queue_manager":"QM_HUB_A","queue_type":"QLOCAL","usage":"NORMAL","get":"ENABLED","put":"ENABLED","maxdepth":20000}','["configured","observed"]','["regression-host-a"]','[]',6,1),
('estate-regression-realshape-001','cent_222222222222222222222222','mq.queue_manager','qmid','QM_HUB_A_2026','resolved','QM_HUB_A','2026-09-08T05:14:28Z','{"queue_manager":"QM_HUB_A"}','["configured","observed"]','["regression-host-a"]','[]',2,1),
('estate-regression-realshape-001','cent_333333333333333333333333','mq.runtime_process','rule_2','queue_manager_key=QM_HUB_A|process=mq-runtime-process-a','resolved','mq-runtime-process-a','2026-09-08T05:14:28Z','{"queue_manager":"QM_HUB_A"}','["observed"]','["regression-host-a"]','[]',1,1),
('estate-regression-realshape-001','cent_444444444444444444444444','mq.cluster','rule_2','name=CLUSTER_A','resolved','CLUSTER_A','2026-09-08T05:14:28Z','{}','["configured","observed"]','["regression-host-a"]','[]',2,1),
('estate-regression-realshape-001','cent_555555555555555555555555','mq.queue_manager','qmid','QM_PEER_A_2026','resolved','QM_PEER_A','2026-09-08T05:14:28Z','{"queue_manager":"QM_PEER_A"}','["observed"]','["regression-host-a"]','[]',1,1),
('estate-regression-realshape-001','cent_666666666666666666666666','infra.host','rule_2','hostname=host-a','resolved','host-a','2026-09-08T05:14:28Z','{}','["observed"]','["regression-host-a"]','[]',1,1);

INSERT INTO semantic_estate_relation
(estate_revision_id, relation_id, semantic_type, source_entity_id, target_entity_id, observed_at,
 properties_json, evidence_classes_json, source_ids_json, source_observations_json, evidence_count, source_count)
VALUES
('estate-regression-realshape-001','rel-reg-contains','contains','cent_222222222222222222222222','cent_111111111111111111111111','2026-09-08T05:14:28Z','{}','["configured","observed"]','["regression-host-a"]','[]',2,1),
('estate-regression-realshape-001','rel-reg-open-output','runtime.opens_for_output','cent_333333333333333333333333','cent_111111111111111111111111','2026-09-08T05:14:28Z','{}','["observed"]','["regression-host-a"]','[]',1,1),
('estate-regression-realshape-001','rel-reg-member','member_of','cent_222222222222222222222222','cent_444444444444444444444444','2026-09-08T05:14:28Z','{}','["configured","observed"]','["regression-host-a"]','[]',2,1),
('estate-regression-realshape-001','rel-reg-discovery','mq.cluster_discovers','cent_111111111111111111111111','cent_555555555555555555555555','2026-09-08T05:14:28Z','{}','["observed"]','["regression-host-a"]','[]',1,1),
('estate-regression-realshape-001','rel-reg-runs-on','runs_on','cent_222222222222222222222222','cent_666666666666666666666666','2026-09-08T05:14:28Z','{}','["observed"]','["regression-host-a"]','[]',1,1);

INSERT INTO semantic_estate_unresolved
(estate_revision_id, unresolved_id, source_entity_id, semantic_type, expected_target_type,
 vendor_value, state, reason, candidate_entity_ids_json, source_ids_json, source_observations_json, evidence_count)
VALUES
('estate-regression-realshape-001','unresolved-reg-destination','cent_111111111111111111111111','routing.resolves_to','mq.queue','REMOTE.UNKNOWN','dynamic','destination_not_observed','[]','["regression-host-a"]','[]',1);

INSERT INTO operational_evaluation_revision (
  evaluation_revision_id, evaluation_key, schema_version, source_id, source_host, environment,
  evaluator, evaluator_version, evaluated_at, imported_at, activated_at,
  source_archive, source_archive_sha256, result_sha256,
  expected_observation_count, expected_coverage_count, expected_finding_count,
  status, is_current, metadata_json
) VALUES (
  'oprev_regression_realshape_001',
  'regression-realshape-key-001', 'osi.findings.evaluation/v1',
  'regression-host-a', 'host-a', 'ci',
  'evaluate_findings_v1.py', '1.0.0',
  '2026-09-08T06:02:00Z', '2026-09-08T06:02:00Z', '2026-09-08T06:02:00Z',
  'sanitized-mq-regression.tar.gz',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  20, 5, 2, 'ACTIVE', 1,
  '{"sanitized":true,"derived_from_real_capture":true}'
);

INSERT INTO operational_observation
(evaluation_revision_id, observation_id, entity_id, semantic_type, display_name,
 observation_type, observed_at, value_json, unit, source_json, quality_json, dimensions_json)
VALUES
('oprev_regression_realshape_001','obs-001-depth','cent_111111111111111111111111','mq.queue','Q.REGRESSION.OUT','mq.queue.depth.current','2026-09-08T05:10:11Z','1','messages','{"source_id":"regression-host-a","source_host":"host-a","queue_manager":"QM_HUB_A","collection_method":"DISPLAY QSTATUS(*) TYPE(QUEUE) ALL","evidence_class":"observed","evidence_ref":"qmgr/001_QM_HUB_A/runtime/sample_001/queue-status.out","sample_id":"sample_001_20260908T051011Z"}','{"coverage":"point_in_time","freshness":"sampled"}','{}'),
('oprev_regression_realshape_001','obs-001-age','cent_111111111111111111111111','mq.queue','Q.REGRESSION.OUT','mq.queue.message.age.oldest_seconds','2026-09-08T05:10:11Z','1','seconds','{"source_id":"regression-host-a","source_host":"host-a","queue_manager":"QM_HUB_A","collection_method":"DISPLAY QSTATUS(*) TYPE(QUEUE) ALL","evidence_class":"observed","evidence_ref":"qmgr/001_QM_HUB_A/runtime/sample_001/queue-status.out","sample_id":"sample_001_20260908T051011Z"}','{"coverage":"point_in_time","freshness":"sampled"}','{}'),
('oprev_regression_realshape_001','obs-001-ip','cent_111111111111111111111111','mq.queue','Q.REGRESSION.OUT','mq.queue.process.input_count','2026-09-08T05:10:11Z','0','processes','{"source_id":"regression-host-a","source_host":"host-a","queue_manager":"QM_HUB_A","collection_method":"DISPLAY QSTATUS(*) TYPE(QUEUE) ALL","evidence_class":"observed","evidence_ref":"qmgr/001_QM_HUB_A/runtime/sample_001/queue-status.out","sample_id":"sample_001_20260908T051011Z"}','{"coverage":"point_in_time","freshness":"sampled"}','{}'),
('oprev_regression_realshape_001','obs-001-op','cent_111111111111111111111111','mq.queue','Q.REGRESSION.OUT','mq.queue.process.output_count','2026-09-08T05:10:11Z','1','processes','{"source_id":"regression-host-a","source_host":"host-a","queue_manager":"QM_HUB_A","collection_method":"DISPLAY QSTATUS(*) TYPE(QUEUE) ALL","evidence_class":"observed","evidence_ref":"qmgr/001_QM_HUB_A/runtime/sample_001/queue-status.out","sample_id":"sample_001_20260908T051011Z"}','{"coverage":"point_in_time","freshness":"sampled"}','{}'),

('oprev_regression_realshape_001','obs-002-depth','cent_111111111111111111111111','mq.queue','Q.REGRESSION.OUT','mq.queue.depth.current','2026-09-08T05:11:15Z','11','messages','{"source_id":"regression-host-a","source_host":"host-a","queue_manager":"QM_HUB_A","collection_method":"DISPLAY QSTATUS(*) TYPE(QUEUE) ALL","evidence_class":"observed","evidence_ref":"qmgr/001_QM_HUB_A/runtime/sample_002/queue-status.out","sample_id":"sample_002_20260908T051115Z"}','{"coverage":"point_in_time","freshness":"sampled"}','{}'),
('oprev_regression_realshape_001','obs-002-age','cent_111111111111111111111111','mq.queue','Q.REGRESSION.OUT','mq.queue.message.age.oldest_seconds','2026-09-08T05:11:15Z','65','seconds','{"source_id":"regression-host-a","source_host":"host-a","queue_manager":"QM_HUB_A","collection_method":"DISPLAY QSTATUS(*) TYPE(QUEUE) ALL","evidence_class":"observed","evidence_ref":"qmgr/001_QM_HUB_A/runtime/sample_002/queue-status.out","sample_id":"sample_002_20260908T051115Z"}','{"coverage":"point_in_time","freshness":"sampled"}','{}'),
('oprev_regression_realshape_001','obs-002-ip','cent_111111111111111111111111','mq.queue','Q.REGRESSION.OUT','mq.queue.process.input_count','2026-09-08T05:11:15Z','0','processes','{"source_id":"regression-host-a","source_host":"host-a","queue_manager":"QM_HUB_A","collection_method":"DISPLAY QSTATUS(*) TYPE(QUEUE) ALL","evidence_class":"observed","evidence_ref":"qmgr/001_QM_HUB_A/runtime/sample_002/queue-status.out","sample_id":"sample_002_20260908T051115Z"}','{"coverage":"point_in_time","freshness":"sampled"}','{}'),
('oprev_regression_realshape_001','obs-002-op','cent_111111111111111111111111','mq.queue','Q.REGRESSION.OUT','mq.queue.process.output_count','2026-09-08T05:11:15Z','1','processes','{"source_id":"regression-host-a","source_host":"host-a","queue_manager":"QM_HUB_A","collection_method":"DISPLAY QSTATUS(*) TYPE(QUEUE) ALL","evidence_class":"observed","evidence_ref":"qmgr/001_QM_HUB_A/runtime/sample_002/queue-status.out","sample_id":"sample_002_20260908T051115Z"}','{"coverage":"point_in_time","freshness":"sampled"}','{}'),

('oprev_regression_realshape_001','obs-003-depth','cent_111111111111111111111111','mq.queue','Q.REGRESSION.OUT','mq.queue.depth.current','2026-09-08T05:12:19Z','18','messages','{"source_id":"regression-host-a","source_host":"host-a","queue_manager":"QM_HUB_A","collection_method":"DISPLAY QSTATUS(*) TYPE(QUEUE) ALL","evidence_class":"observed","evidence_ref":"qmgr/001_QM_HUB_A/runtime/sample_003/queue-status.out","sample_id":"sample_003_20260908T051219Z"}','{"coverage":"point_in_time","freshness":"sampled"}','{}'),
('oprev_regression_realshape_001','obs-003-age','cent_111111111111111111111111','mq.queue','Q.REGRESSION.OUT','mq.queue.message.age.oldest_seconds','2026-09-08T05:12:19Z','129','seconds','{"source_id":"regression-host-a","source_host":"host-a","queue_manager":"QM_HUB_A","collection_method":"DISPLAY QSTATUS(*) TYPE(QUEUE) ALL","evidence_class":"observed","evidence_ref":"qmgr/001_QM_HUB_A/runtime/sample_003/queue-status.out","sample_id":"sample_003_20260908T051219Z"}','{"coverage":"point_in_time","freshness":"sampled"}','{}'),
('oprev_regression_realshape_001','obs-003-ip','cent_111111111111111111111111','mq.queue','Q.REGRESSION.OUT','mq.queue.process.input_count','2026-09-08T05:12:19Z','0','processes','{"source_id":"regression-host-a","source_host":"host-a","queue_manager":"QM_HUB_A","collection_method":"DISPLAY QSTATUS(*) TYPE(QUEUE) ALL","evidence_class":"observed","evidence_ref":"qmgr/001_QM_HUB_A/runtime/sample_003/queue-status.out","sample_id":"sample_003_20260908T051219Z"}','{"coverage":"point_in_time","freshness":"sampled"}','{}'),
('oprev_regression_realshape_001','obs-003-op','cent_111111111111111111111111','mq.queue','Q.REGRESSION.OUT','mq.queue.process.output_count','2026-09-08T05:12:19Z','1','processes','{"source_id":"regression-host-a","source_host":"host-a","queue_manager":"QM_HUB_A","collection_method":"DISPLAY QSTATUS(*) TYPE(QUEUE) ALL","evidence_class":"observed","evidence_ref":"qmgr/001_QM_HUB_A/runtime/sample_003/queue-status.out","sample_id":"sample_003_20260908T051219Z"}','{"coverage":"point_in_time","freshness":"sampled"}','{}'),

('oprev_regression_realshape_001','obs-004-depth','cent_111111111111111111111111','mq.queue','Q.REGRESSION.OUT','mq.queue.depth.current','2026-09-08T05:13:23Z','33','messages','{"source_id":"regression-host-a","source_host":"host-a","queue_manager":"QM_HUB_A","collection_method":"DISPLAY QSTATUS(*) TYPE(QUEUE) ALL","evidence_class":"observed","evidence_ref":"qmgr/001_QM_HUB_A/runtime/sample_004/queue-status.out","sample_id":"sample_004_20260908T051323Z"}','{"coverage":"point_in_time","freshness":"sampled"}','{}'),
('oprev_regression_realshape_001','obs-004-age','cent_111111111111111111111111','mq.queue','Q.REGRESSION.OUT','mq.queue.message.age.oldest_seconds','2026-09-08T05:13:23Z','193','seconds','{"source_id":"regression-host-a","source_host":"host-a","queue_manager":"QM_HUB_A","collection_method":"DISPLAY QSTATUS(*) TYPE(QUEUE) ALL","evidence_class":"observed","evidence_ref":"qmgr/001_QM_HUB_A/runtime/sample_004/queue-status.out","sample_id":"sample_004_20260908T051323Z"}','{"coverage":"point_in_time","freshness":"sampled"}','{}'),
('oprev_regression_realshape_001','obs-004-ip','cent_111111111111111111111111','mq.queue','Q.REGRESSION.OUT','mq.queue.process.input_count','2026-09-08T05:13:23Z','0','processes','{"source_id":"regression-host-a","source_host":"host-a","queue_manager":"QM_HUB_A","collection_method":"DISPLAY QSTATUS(*) TYPE(QUEUE) ALL","evidence_class":"observed","evidence_ref":"qmgr/001_QM_HUB_A/runtime/sample_004/queue-status.out","sample_id":"sample_004_20260908T051323Z"}','{"coverage":"point_in_time","freshness":"sampled"}','{}'),
('oprev_regression_realshape_001','obs-004-op','cent_111111111111111111111111','mq.queue','Q.REGRESSION.OUT','mq.queue.process.output_count','2026-09-08T05:13:23Z','1','processes','{"source_id":"regression-host-a","source_host":"host-a","queue_manager":"QM_HUB_A","collection_method":"DISPLAY QSTATUS(*) TYPE(QUEUE) ALL","evidence_class":"observed","evidence_ref":"qmgr/001_QM_HUB_A/runtime/sample_004/queue-status.out","sample_id":"sample_004_20260908T051323Z"}','{"coverage":"point_in_time","freshness":"sampled"}','{}'),

('oprev_regression_realshape_001','obs-005-depth','cent_111111111111111111111111','mq.queue','Q.REGRESSION.OUT','mq.queue.depth.current','2026-09-08T05:14:28Z','46','messages','{"source_id":"regression-host-a","source_host":"host-a","queue_manager":"QM_HUB_A","collection_method":"DISPLAY QSTATUS(*) TYPE(QUEUE) ALL","evidence_class":"observed","evidence_ref":"qmgr/001_QM_HUB_A/runtime/sample_005/queue-status.out","sample_id":"sample_005_20260908T051428Z"}','{"coverage":"point_in_time","freshness":"sampled"}','{}'),
('oprev_regression_realshape_001','obs-005-age','cent_111111111111111111111111','mq.queue','Q.REGRESSION.OUT','mq.queue.message.age.oldest_seconds','2026-09-08T05:14:28Z','258','seconds','{"source_id":"regression-host-a","source_host":"host-a","queue_manager":"QM_HUB_A","collection_method":"DISPLAY QSTATUS(*) TYPE(QUEUE) ALL","evidence_class":"observed","evidence_ref":"qmgr/001_QM_HUB_A/runtime/sample_005/queue-status.out","sample_id":"sample_005_20260908T051428Z"}','{"coverage":"point_in_time","freshness":"sampled"}','{}'),
('oprev_regression_realshape_001','obs-005-ip','cent_111111111111111111111111','mq.queue','Q.REGRESSION.OUT','mq.queue.process.input_count','2026-09-08T05:14:28Z','0','processes','{"source_id":"regression-host-a","source_host":"host-a","queue_manager":"QM_HUB_A","collection_method":"DISPLAY QSTATUS(*) TYPE(QUEUE) ALL","evidence_class":"observed","evidence_ref":"qmgr/001_QM_HUB_A/runtime/sample_005/queue-status.out","sample_id":"sample_005_20260908T051428Z"}','{"coverage":"point_in_time","freshness":"sampled"}','{}'),
('oprev_regression_realshape_001','obs-005-op','cent_111111111111111111111111','mq.queue','Q.REGRESSION.OUT','mq.queue.process.output_count','2026-09-08T05:14:28Z','1','processes','{"source_id":"regression-host-a","source_host":"host-a","queue_manager":"QM_HUB_A","collection_method":"DISPLAY QSTATUS(*) TYPE(QUEUE) ALL","evidence_class":"observed","evidence_ref":"qmgr/001_QM_HUB_A/runtime/sample_005/queue-status.out","sample_id":"sample_005_20260908T051428Z"}','{"coverage":"point_in_time","freshness":"sampled"}','{}');

INSERT INTO operational_coverage
(evaluation_revision_id, ordinal, scope_type, scope_key, observation_family, sample_id, observed_at, state, evidence_ref, error)
VALUES
('oprev_regression_realshape_001',1,'entity','cent_111111111111111111111111','queue-status','sample_001_20260908T051011Z','2026-09-08T05:10:11Z','point_in_time','qmgr/001_QM_HUB_A/runtime/sample_001/queue-status.out',NULL),
('oprev_regression_realshape_001',2,'entity','cent_111111111111111111111111','queue-status','sample_002_20260908T051115Z','2026-09-08T05:11:15Z','point_in_time','qmgr/001_QM_HUB_A/runtime/sample_002/queue-status.out',NULL),
('oprev_regression_realshape_001',3,'entity','cent_111111111111111111111111','queue-status','sample_003_20260908T051219Z','2026-09-08T05:12:19Z','point_in_time','qmgr/001_QM_HUB_A/runtime/sample_003/queue-status.out',NULL),
('oprev_regression_realshape_001',4,'entity','cent_111111111111111111111111','queue-status','sample_004_20260908T051323Z','2026-09-08T05:13:23Z','point_in_time','qmgr/001_QM_HUB_A/runtime/sample_004/queue-status.out',NULL),
('oprev_regression_realshape_001',5,'entity','cent_111111111111111111111111','queue-status','sample_005_20260908T051428Z','2026-09-08T05:14:28Z','point_in_time','qmgr/001_QM_HUB_A/runtime/sample_005/queue-status.out',NULL);

INSERT INTO operational_finding_occurrence
(evaluation_revision_id, finding_id, rule_id, entity_id, semantic_type, display_name,
 severity, evaluator_status, summary, diagnosis, confidence_json, first_seen, last_seen,
 coverage_state, evidence_json, related_entities_json, details_json)
VALUES
('oprev_regression_realshape_001','find_aaaaaaaaaaaaaaaaaaaaaaaa','mq.queue.oldest_message_aging.v1','cent_111111111111111111111111','mq.queue','Q.REGRESSION.OUT','warning','OPEN','Oldest queued message is aging across observations','The oldest-message age increased with wall time while the queue remained non-empty. This is persistence evidence, not a business-SLA breach claim.','{"level":"probable","score":0.86}','2026-09-08T05:10:11Z','2026-09-08T05:14:28Z','sufficient','[{"sample_id":"sample_001_20260908T051011Z","observed_at":"2026-09-08T05:10:11Z","evidence_ref":"qmgr/001_QM_HUB_A/runtime/sample_001/queue-status.out","observation_types":["mq.queue.message.age.oldest_seconds","mq.queue.depth.current"]},{"sample_id":"sample_002_20260908T051115Z","observed_at":"2026-09-08T05:11:15Z","evidence_ref":"qmgr/001_QM_HUB_A/runtime/sample_002/queue-status.out","observation_types":["mq.queue.message.age.oldest_seconds","mq.queue.depth.current"]},{"sample_id":"sample_003_20260908T051219Z","observed_at":"2026-09-08T05:12:19Z","evidence_ref":"qmgr/001_QM_HUB_A/runtime/sample_003/queue-status.out","observation_types":["mq.queue.message.age.oldest_seconds","mq.queue.depth.current"]},{"sample_id":"sample_004_20260908T051323Z","observed_at":"2026-09-08T05:13:23Z","evidence_ref":"qmgr/001_QM_HUB_A/runtime/sample_004/queue-status.out","observation_types":["mq.queue.message.age.oldest_seconds","mq.queue.depth.current"]},{"sample_id":"sample_005_20260908T051428Z","observed_at":"2026-09-08T05:14:28Z","evidence_ref":"qmgr/001_QM_HUB_A/runtime/sample_005/queue-status.out","observation_types":["mq.queue.message.age.oldest_seconds","mq.queue.depth.current"]}]','[]','{}'),
('oprev_regression_realshape_001','find_bbbbbbbbbbbbbbbbbbbbbbbb','mq.queue.backlog_no_input_process.v1','cent_111111111111111111111111','mq.queue','Q.REGRESSION.OUT','warning','OPEN','Backlog increasing with no input process observed','Queue depth increased across the sampled window while every queue-status sample reported IPPROCS=0. An output process was observed, strengthening evidence that work is arriving. This does not by itself prove an application outage.','{"level":"probable","score":0.92}','2026-09-08T05:10:11Z','2026-09-08T05:14:28Z','sufficient','[{"sample_id":"sample_001_20260908T051011Z","observed_at":"2026-09-08T05:10:11Z","evidence_ref":"qmgr/001_QM_HUB_A/runtime/sample_001/queue-status.out","observation_types":["mq.queue.depth.current","mq.queue.process.input_count","mq.queue.process.output_count"]},{"sample_id":"sample_002_20260908T051115Z","observed_at":"2026-09-08T05:11:15Z","evidence_ref":"qmgr/001_QM_HUB_A/runtime/sample_002/queue-status.out","observation_types":["mq.queue.depth.current","mq.queue.process.input_count","mq.queue.process.output_count"]},{"sample_id":"sample_003_20260908T051219Z","observed_at":"2026-09-08T05:12:19Z","evidence_ref":"qmgr/001_QM_HUB_A/runtime/sample_003/queue-status.out","observation_types":["mq.queue.depth.current","mq.queue.process.input_count","mq.queue.process.output_count"]},{"sample_id":"sample_004_20260908T051323Z","observed_at":"2026-09-08T05:13:23Z","evidence_ref":"qmgr/001_QM_HUB_A/runtime/sample_004/queue-status.out","observation_types":["mq.queue.depth.current","mq.queue.process.input_count","mq.queue.process.output_count"]},{"sample_id":"sample_005_20260908T051428Z","observed_at":"2026-09-08T05:14:28Z","evidence_ref":"qmgr/001_QM_HUB_A/runtime/sample_005/queue-status.out","observation_types":["mq.queue.depth.current","mq.queue.process.input_count","mq.queue.process.output_count"]}]','[]','{}');
