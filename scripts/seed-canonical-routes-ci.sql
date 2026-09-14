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
  'ACTIVE', 1, 12, 8, 2, '{"valid":true,"source_count":1}'
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
('estate-route-ci','qm-peer','mq.queue_manager','qmid','QM2_2026','resolved','QM2','2026-09-09T00:00:00Z','{"queue_manager":"QM2"}','["observed"]','["host-route"]','[]',1,1),
('estate-route-ci','dp-service','datapower.service','rule_2','domain_key=dp-a|name=DP_GATEWAY','resolved','DP_GATEWAY','2026-09-09T00:00:00Z','{"domain":"APP_DOMAIN","physical_host":"dp-a"}','["configured"]','["host-route"]','[]',1,1),
('estate-route-ci','dp-q-target','mq.queue','rule_2','queue_manager_key=QM2|name=DP.REQUEST.IN','resolved','DP.REQUEST.IN','2026-09-09T00:00:00Z','{"queue_manager":"QM2","queue_type":"QLOCAL"}','["configured"]','["host-route"]','[]',1,1),
('estate-route-ci','ftp-flow','filetransfer.flow','rule_2','canonical_key=ftp-route-ci|name=External User inbound','resolved','External User inbound','2026-09-09T00:00:00Z','{"flow_kind":"eft_inbound_site_path","site_name":"External User","gateway_server_key":"dmzgateway:DMZ01","listener":"192.0.2.20:22","site_access_time_scope":"historical","runtime_transfer_completion":false}','["inferred"]','["host-route"]','[]',4,1),
('estate-route-ci','ftp-site','filetransfer.endpoint','rule_2','server_key=eft:EFT01|name=External User','resolved','External User','2026-09-09T00:00:00Z','{"endpoint_kind":"eft_site","server_key":"eft:EFT01","site_name":"External User","site_started":true,"listener_resolution":"qualified-inferred"}','["observed"]','["host-route"]','[]',1,1),
('estate-route-ci','ftp-unresolved-site','filetransfer.endpoint','rule_2','server_key=eft:EFT01|name=Internal User','resolved','Internal User','2026-09-09T00:00:00Z','{"endpoint_kind":"eft_site","server_key":"eft:EFT01","site_name":"Internal User","site_started":true,"listener_resolution":"unresolved"}','["observed"]','["host-route"]','[]',1,1);

INSERT INTO semantic_estate_relation
(estate_revision_id, relation_id, semantic_type, source_entity_id, target_entity_id, observed_at, properties_json, evidence_classes_json, source_ids_json, source_observations_json, evidence_count, source_count)
VALUES
('estate-route-ci','r-open-output','runtime.opens_for_output','app-producer','q-remote','2026-09-09T00:00:00Z','{}','["observed"]','["host-route"]','[]',1,1),
('estate-route-ci','r-resolve','routing.resolves_to','q-remote','q-target','2026-09-09T00:00:00Z','{}','["configured"]','["host-route"]','[]',1,1),
('estate-route-ci','r-open-input','runtime.opens_for_input','app-consumer','q-target','2026-09-09T00:00:00Z','{}','["observed"]','["host-route"]','[]',1,1),
('estate-route-ci','r-route-via','routing.routes_via','q-remote','q-xmit','2026-09-09T00:00:00Z','{}','["configured"]','["host-route"]','[]',1,1),
('estate-route-ci','r-transmit','routing.transmits_via','q-xmit','ch-sender','2026-09-09T00:00:00Z','{}','["configured"]','["host-route"]','[]',1,1),
('estate-route-ci','r-connect','network.connects_to','ch-sender','qm-peer','2026-09-09T00:00:00Z','{}','["observed"]','["host-route"]','[]',1,1),
('estate-route-ci','r-dp-route','integration.routes_to','dp-service','dp-q-target','2026-09-09T00:00:00Z','{"qualified_route":true,"epistemic":"derived","derivation_method":"deterministic_static_route_projection","deterministic":true,"route_uri_literal":"dpmq://GWQM/?RequestQueue=DP.REQUEST.IN","queue_manager":"QM2","backend_group":"GWQM","channel":"SVRCON_DP","qualified_route_chain":[{"label":"APP_DOMAIN","epistemic":"observed"},{"label":"HTTP handler 127.0.0.1:6027","epistemic":"configured"},{"label":"DP_GATEWAY","epistemic":"configured"},{"label":"StylePolicy","epistemic":"configured"},{"label":"XSLT route resource","epistemic":"derived"},{"label":"GWQM","epistemic":"derived+configured"},{"label":"QM2","epistemic":"configured+observed"},{"label":"DP.REQUEST.IN","epistemic":"derived"}],"runtime_corroboration":[{"physical_host":"dp-a","client_ip":"192.0.2.10","channels":["SVRCON_DP"],"sample_connection_count":2}],"semantic_warning":"Configured/static DataPower route evidence does not prove a specific message traversal. MQ runtime evidence independently corroborates DataPower client connectivity to the target queue manager."}','["configured"]','["host-route"]','[]',1,1),
('estate-route-ci','r-ftp-route','integration.routes_to','ftp-flow','ftp-site','2026-09-09T00:00:00Z','{"qualified_route":true,"epistemic":"inferred","route_kind":"eft_inbound_site_path","deterministic":true,"site_access_evidence":{"time_scope":"historical","evidence_class":"observed","evidence_ref":"ev:site-access-ci","activity_window_start":"2026-09-09T00:00:00Z","activity_window_end":"2026-09-09T00:05:00Z"},"runtime_corroboration":[{"kind":"eft_dmz_pnc","time_scope":"current","evidence_class":"observed","gateway_server_key":"dmzgateway:DMZ01","endpoint":"192.0.2.20:44500","independently_corroborated":true,"evidence_ref":"ev:pnc-ci-dmz","evidence_refs":["ev:pnc-ci-dmz","ev:pnc-ci-eft"],"sources":[{"kind":"pnc_runtime_connectivity","source_kind":"dmz_gateway_runtime","time_scope":"current","evidence_class":"observed","evidence_ref":"ev:pnc-ci-dmz","endpoint_host":"192.0.2.20","endpoint_port":44500},{"kind":"pnc_runtime_connectivity","source_kind":"eft_runtime","time_scope":"current","evidence_class":"observed","evidence_ref":"ev:pnc-ci-eft","endpoint_host":"192.0.2.20","endpoint_port":44500}]}],"current_listener_evidence":{"time_scope":"current","evidence_class":"observed","endpoint":"192.0.2.20:22","evidence_ref":"ev:listener-ci"},"evidence_refs":["ev:listener-ci","ev:pnc-ci-dmz","ev:pnc-ci-eft","ev:site-access-ci","ev:site-ci"],"runtime_transfer_completion":false,"semantic_warning":"This is an inferred topology route composed from historical Site-access evidence plus current listener and independently corroborated PNC observations. It is not current Site traversal or completed file transfer proof."}','["inferred"]','["host-route"]','[]',5,1);

INSERT INTO semantic_estate_unresolved
(estate_revision_id, unresolved_id, source_entity_id, semantic_type, expected_target_type, vendor_value, state, reason, candidate_entity_ids_json, source_ids_json, source_observations_json, evidence_count)
VALUES
('estate-route-ci','u-route','q-remote','routing.resolves_to','mq.queue','QM2:ALT.DYNAMIC','dynamic','multiple_cluster_candidates','[]','["host-route"]','[]',1),
('estate-route-ci','u-ftp-internal','ftp-unresolved-site','filetransfer.endpoint','filetransfer.endpoint','Internal User listener','unresolved','current Site exists but no listener mapping is supported by the supplied evidence','[]','["host-route"]','[]',1);
