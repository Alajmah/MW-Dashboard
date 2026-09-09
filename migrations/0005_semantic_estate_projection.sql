DROP VIEW IF EXISTS semantic_estate_relation_v1;
DROP VIEW IF EXISTS semantic_estate_entity_v1;
DROP VIEW IF EXISTS semantic_current_entity_identity_v1;

-- Read-optimized canonical estate projection over the current revision of every
-- imported source. The raw observation tables remain the provenance layer.
-- Identity conflicts are surfaced instead of silently merging reused MQ names.
CREATE VIEW semantic_current_entity_identity_v1 AS
WITH base AS (
  SELECT sr.environment, sr.source_id, sr.source_display_name,
         eo.revision_id, eo.entity_ref, eo.semantic_type, eo.display_name,
         eo.observed_at, eo.evidence_class, eo.identity_json, eo.properties_json, eo.evidence_ref,
         lower(trim(COALESCE(json_extract(eo.identity_json, '$.hints.canonical_key'), ''))) AS canonical_hint,
         lower(trim(COALESCE(json_extract(eo.identity_json, '$.hints.machine_id'), ''))) AS machine_id,
         lower(trim(COALESCE(json_extract(eo.identity_json, '$.hints.qmid'), ''))) AS qmid,
         lower(trim(COALESCE(json_extract(eo.identity_json, '$.hints.legacy_id'), ''))) AS legacy_id,
         lower(trim(COALESCE(json_extract(eo.identity_json, '$.hints.fqdn'), ''))) AS fqdn,
         lower(trim(COALESCE(json_extract(eo.identity_json, '$.hints.primary_ip'), ''))) AS primary_ip,
         lower(trim(COALESCE(json_extract(eo.identity_json, '$.hints.name'), ''))) AS name,
         lower(trim(COALESCE(json_extract(eo.identity_json, '$.hints.host'), ''))) AS endpoint_host,
         lower(trim(COALESCE(json_extract(eo.identity_json, '$.hints.port'), ''))) AS endpoint_port,
         lower(trim(COALESCE(json_extract(eo.identity_json, '$.hints.raw'), ''))) AS endpoint_raw,
         lower(trim(COALESCE(json_extract(eo.identity_json, '$.hints.host_key'), ''))) AS host_key,
         lower(trim(COALESCE(json_extract(eo.identity_json, '$.hints.queue_manager_key'), ''))) AS queue_manager_key,
         lower(trim(COALESCE(json_extract(eo.identity_json, '$.hints.connection_id'), ''))) AS connection_id,
         lower(trim(COALESCE(json_extract(eo.identity_json, '$.hints.object_handle'), ''))) AS object_handle,
         lower(trim(COALESCE(json_extract(eo.identity_json, '$.hints.pid'), ''))) AS pid
    FROM semantic_entity_observation eo
    JOIN semantic_source_revision sr ON sr.revision_id = eo.revision_id
   WHERE sr.is_current = 1
),
qmgr_stats AS (
  SELECT environment, name,
         COUNT(DISTINCT NULLIF(qmid, '')) AS qmid_count,
         MIN(NULLIF(qmid, '')) AS only_qmid
    FROM base
   WHERE semantic_type = 'mq.queue_manager' AND name <> ''
   GROUP BY environment, name
),
resolved AS (
  SELECT b.*,
         COALESCE(parent.qmid_count, 0) AS parent_qmid_count,
         CASE
           WHEN b.queue_manager_key = '' THEN ''
           WHEN COALESCE(parent.qmid_count, 0) = 1 THEN 'qmid:' || parent.only_qmid
           WHEN COALESCE(parent.qmid_count, 0) > 1 THEN 'conflict:name:' || b.queue_manager_key
           ELSE 'name:' || b.queue_manager_key
         END AS parent_qmgr_key,
         COALESCE(selfq.qmid_count, 0) AS self_qmid_count,
         selfq.only_qmid AS self_only_qmid
    FROM base b
    LEFT JOIN qmgr_stats parent
      ON parent.environment = b.environment AND parent.name = b.queue_manager_key
    LEFT JOIN qmgr_stats selfq
      ON selfq.environment = b.environment AND selfq.name = b.name AND b.semantic_type = 'mq.queue_manager'
)
SELECT o.*,
       CASE
         WHEN o.semantic_type = 'mq.queue_manager' THEN
           CASE WHEN o.canonical_hint <> '' THEN 'canonical:' || o.canonical_hint
                WHEN o.qmid <> '' THEN 'qmid:' || o.qmid
                WHEN o.name <> '' AND o.self_qmid_count = 1 THEN 'qmid:' || o.self_only_qmid
                WHEN o.name <> '' AND o.self_qmid_count > 1 THEN 'conflict:name:' || o.name
                WHEN o.name <> '' THEN 'name:' || o.name
                WHEN o.legacy_id <> '' THEN 'legacy:' || o.legacy_id
                ELSE 'source:' || o.source_id || '|ref:' || o.entity_ref END
         WHEN o.semantic_type = 'infra.host' THEN
           CASE WHEN o.machine_id <> '' THEN 'machine_id:' || o.machine_id
                WHEN o.legacy_id <> '' THEN 'legacy:' || o.legacy_id
                WHEN o.fqdn <> '' THEN 'fqdn:' || o.fqdn
                WHEN o.primary_ip <> '' THEN 'primary_ip:' || o.primary_ip
                WHEN o.name <> '' THEN 'name:' || o.name
                ELSE 'source:' || o.source_id || '|ref:' || o.entity_ref END
         WHEN o.semantic_type = 'infra.network_endpoint' THEN
           CASE WHEN o.endpoint_host <> '' AND o.endpoint_port <> '' THEN 'host:' || o.endpoint_host || '|port:' || o.endpoint_port
                WHEN o.endpoint_raw <> '' THEN 'raw:' || o.endpoint_raw
                WHEN o.legacy_id <> '' THEN 'legacy:' || o.legacy_id
                ELSE 'source:' || o.source_id || '|ref:' || o.entity_ref END
         WHEN o.canonical_hint <> '' THEN 'canonical:' || o.canonical_hint
         WHEN o.semantic_type = 'mq.queue_manager_instance' AND o.queue_manager_key <> '' AND o.host_key <> ''
           THEN 'queue_manager:' || o.parent_qmgr_key || '|host:' || o.host_key
         WHEN o.semantic_type IN ('mq.queue','mq.channel','mq.listener','mq.topic','mq.subscription','mq.process_definition','mq.namelist','mq.service')
              AND o.queue_manager_key <> '' AND o.name <> ''
           THEN 'queue_manager:' || o.parent_qmgr_key || '|name:' || o.name
         WHEN o.semantic_type = 'mq.runtime_process' AND o.queue_manager_key <> '' AND o.pid <> ''
           THEN 'queue_manager:' || o.parent_qmgr_key || '|pid:' || o.pid
         WHEN o.semantic_type = 'mq.connection' AND o.queue_manager_key <> '' AND o.connection_id <> ''
           THEN 'queue_manager:' || o.parent_qmgr_key || '|connection_id:' || o.connection_id
         WHEN o.semantic_type = 'mq.object_handle' AND o.queue_manager_key <> '' AND o.connection_id <> '' AND o.object_handle <> ''
           THEN 'queue_manager:' || o.parent_qmgr_key || '|connection_id:' || o.connection_id || '|handle:' || o.object_handle
         WHEN o.semantic_type = 'app.application_instance' AND o.host_key <> '' AND o.name <> ''
           THEN 'host:' || o.host_key || '|name:' || o.name
         WHEN o.name <> '' THEN 'name:' || o.name
         WHEN o.legacy_id <> '' THEN 'legacy:' || o.legacy_id
         ELSE 'source:' || o.source_id || '|ref:' || o.entity_ref
       END AS canonical_key,
       CASE
         WHEN o.semantic_type = 'mq.queue_manager' AND o.name <> '' AND o.qmid = '' AND o.self_qmid_count > 1 THEN 'conflicted'
         WHEN o.queue_manager_key <> '' AND o.parent_qmid_count > 1 THEN 'conflicted'
         WHEN o.canonical_hint = '' AND o.machine_id = '' AND o.qmid = '' AND o.legacy_id = '' AND o.fqdn = '' AND o.primary_ip = ''
              AND o.name = '' AND o.endpoint_raw = '' AND NOT (o.endpoint_host <> '' AND o.endpoint_port <> '')
              AND NOT (o.queue_manager_key <> '' AND (o.host_key <> '' OR o.pid <> '' OR o.connection_id <> ''))
           THEN 'fallback'
         ELSE 'resolved'
       END AS identity_state
  FROM resolved o;

CREATE VIEW semantic_estate_entity_v1 AS
SELECT environment,
       semantic_type || ':' || canonical_key AS entity_id,
       semantic_type,
       canonical_key,
       MIN(COALESCE(NULLIF(display_name, ''), canonical_key)) AS display_name,
       CASE WHEN SUM(CASE WHEN identity_state = 'conflicted' THEN 1 ELSE 0 END) > 0 THEN 'conflicted'
            WHEN SUM(CASE WHEN identity_state = 'fallback' THEN 1 ELSE 0 END) > 0 THEN 'fallback'
            ELSE 'resolved' END AS identity_state,
       COUNT(*) AS observation_count,
       COUNT(DISTINCT source_id) AS source_count,
       COUNT(DISTINCT revision_id) AS revision_count,
       SUM(CASE WHEN COALESCE(json_extract(properties_json, '$.reference_only'), 0) IN (1, 'true') THEN 1 ELSE 0 END) AS reference_only_observations,
       SUM(CASE WHEN COALESCE(json_extract(properties_json, '$.reference_only'), 0) IN (1, 'true') THEN 0 ELSE 1 END) AS substantive_observations,
       GROUP_CONCAT(DISTINCT evidence_class) AS evidence_classes,
       MIN(observed_at) AS first_observed_at,
       MAX(observed_at) AS last_observed_at
  FROM semantic_current_entity_identity_v1
 GROUP BY environment, semantic_type, canonical_key;

CREATE VIEW semantic_estate_relation_v1 AS
SELECT sr.environment,
       ro.semantic_type || ':' || s.semantic_type || ':' || s.canonical_key || '->' || t.semantic_type || ':' || t.canonical_key AS relation_id,
       ro.semantic_type,
       s.semantic_type || ':' || s.canonical_key AS source_entity_id,
       t.semantic_type || ':' || t.canonical_key AS target_entity_id,
       COUNT(*) AS observation_count,
       COUNT(DISTINCT sr.source_id) AS source_count,
       GROUP_CONCAT(DISTINCT ro.evidence_class) AS evidence_classes,
       MIN(ro.observed_at) AS first_observed_at,
       MAX(ro.observed_at) AS last_observed_at
  FROM semantic_relation_observation ro
  JOIN semantic_source_revision sr ON sr.revision_id = ro.revision_id AND sr.is_current = 1
  JOIN semantic_current_entity_identity_v1 s ON s.revision_id = ro.revision_id AND s.entity_ref = ro.source_ref
  JOIN semantic_current_entity_identity_v1 t ON t.revision_id = ro.revision_id AND t.entity_ref = ro.target_ref
 GROUP BY sr.environment, ro.semantic_type, s.semantic_type, s.canonical_key, t.semantic_type, t.canonical_key;
