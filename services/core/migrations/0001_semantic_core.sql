BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS source_run (
  run_id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  collector TEXT NOT NULL,
  collector_version TEXT,
  normalizer_version TEXT,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_display_name TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  artifact_uri TEXT,
  artifact_sha256 TEXT,
  artifact_media_type TEXT,
  artifact_size_bytes BIGINT,
  content_sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'SUCCESS' CHECK (status IN ('SUCCESS','FAILED')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_source_run_completed ON source_run(environment, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_source_run_source ON source_run(environment, source_kind, source_id, completed_at DESC);

CREATE TABLE IF NOT EXISTS source_coverage (
  run_id TEXT NOT NULL REFERENCES source_run(run_id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  object_class TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('complete','point_in_time','partial','failed','not_collected')),
  evidence_ref TEXT,
  error_text TEXT,
  properties JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (run_id, scope_type, scope_key, object_class)
);

CREATE TABLE IF NOT EXISTS canonical_entity (
  entity_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  environment TEXT NOT NULL,
  logical_key TEXT NOT NULL,
  identity_rule TEXT,
  identity_strength INTEGER NOT NULL DEFAULT 0 CHECK (identity_strength >= 0),
  display_name TEXT NOT NULL,
  status TEXT,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entity_type, environment, logical_key)
);

CREATE INDEX IF NOT EXISTS idx_entity_type_env ON canonical_entity(environment, entity_type, display_name);
CREATE INDEX IF NOT EXISTS idx_entity_attributes_gin ON canonical_entity USING gin(attributes);
CREATE INDEX IF NOT EXISTS idx_entity_name_trgm ON canonical_entity USING gin(display_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_entity_identity_rule ON canonical_entity(environment, entity_type, identity_rule, identity_strength DESC);

CREATE TABLE IF NOT EXISTS entity_alias (
  entity_id TEXT NOT NULL REFERENCES canonical_entity(entity_id) ON DELETE CASCADE,
  alias_type TEXT NOT NULL,
  alias_value TEXT NOT NULL,
  source_run_id TEXT REFERENCES source_run(run_id) ON DELETE SET NULL,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  properties JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (entity_id, alias_type, alias_value)
);
CREATE INDEX IF NOT EXISTS idx_entity_alias_lookup ON entity_alias(alias_type, lower(alias_value));

CREATE TABLE IF NOT EXISTS canonical_relation (
  relation_id TEXT PRIMARY KEY,
  relationship_type TEXT NOT NULL,
  source_entity_id TEXT NOT NULL REFERENCES canonical_entity(entity_id) ON DELETE CASCADE,
  target_entity_id TEXT NOT NULL REFERENCES canonical_entity(entity_id) ON DELETE CASCADE,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (relationship_type, source_entity_id, target_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_relation_source ON canonical_relation(source_entity_id, relationship_type);
CREATE INDEX IF NOT EXISTS idx_relation_target ON canonical_relation(target_entity_id, relationship_type);
CREATE INDEX IF NOT EXISTS idx_relation_type ON canonical_relation(relationship_type);

CREATE TABLE IF NOT EXISTS observation_record (
  observation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES source_run(run_id) ON DELETE CASCADE,
  observation_kind TEXT NOT NULL CHECK (observation_kind IN ('entity','relation','unresolved')),
  local_ref TEXT NOT NULL,
  semantic_type TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  evidence_class TEXT NOT NULL CHECK (evidence_class IN ('observed','configured','declared','inferred')),
  evidence_ref TEXT,
  identity_hints JSONB NOT NULL DEFAULT '{}'::jsonb,
  properties JSONB NOT NULL DEFAULT '{}'::jsonb,
  canonical_entity_id TEXT REFERENCES canonical_entity(entity_id) ON DELETE SET NULL,
  canonical_relation_id TEXT REFERENCES canonical_relation(relation_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, observation_kind, local_ref)
);
CREATE INDEX IF NOT EXISTS idx_observation_run ON observation_record(run_id, observation_kind);
CREATE INDEX IF NOT EXISTS idx_observation_entity ON observation_record(canonical_entity_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_observation_relation ON observation_record(canonical_relation_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS semantic_assertion (
  assertion_id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('entity','relation')),
  entity_id TEXT REFERENCES canonical_entity(entity_id) ON DELETE CASCADE,
  relation_id TEXT REFERENCES canonical_relation(relation_id) ON DELETE CASCADE,
  source_run_id TEXT NOT NULL REFERENCES source_run(run_id) ON DELETE CASCADE,
  evidence_class TEXT NOT NULL CHECK (evidence_class IN ('observed','configured','declared','inferred')),
  observed_at TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_from TIMESTAMPTZ NOT NULL,
  valid_to TIMESTAMPTZ,
  evidence_ref TEXT,
  derivation_method TEXT,
  deterministic BOOLEAN,
  confidence DOUBLE PRECISION CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  properties JSONB NOT NULL DEFAULT '{}'::jsonb,
  CHECK (
    (subject_kind = 'entity' AND entity_id IS NOT NULL AND relation_id IS NULL)
    OR
    (subject_kind = 'relation' AND relation_id IS NOT NULL AND entity_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_assertion_entity_active ON semantic_assertion(entity_id, valid_to, observed_at DESC) WHERE subject_kind='entity';
CREATE INDEX IF NOT EXISTS idx_assertion_relation_active ON semantic_assertion(relation_id, valid_to, observed_at DESC) WHERE subject_kind='relation';
CREATE INDEX IF NOT EXISTS idx_assertion_run ON semantic_assertion(source_run_id);
CREATE INDEX IF NOT EXISTS idx_assertion_active_run ON semantic_assertion(source_run_id, subject_kind, valid_to);

CREATE TABLE IF NOT EXISTS unresolved_reference (
  reference_id TEXT PRIMARY KEY,
  source_run_id TEXT NOT NULL REFERENCES source_run(run_id) ON DELETE CASCADE,
  source_entity_id TEXT NOT NULL REFERENCES canonical_entity(entity_id) ON DELETE CASCADE,
  relationship_intent TEXT NOT NULL,
  expected_target_type TEXT NOT NULL,
  vendor_value TEXT NOT NULL,
  resolution_state TEXT NOT NULL CHECK (resolution_state IN ('unresolved','ambiguous','dynamic','stale','conflicted','resolved')),
  resolution_reason TEXT NOT NULL,
  candidate_entity_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL,
  evidence_class TEXT NOT NULL CHECK (evidence_class IN ('observed','configured','declared','inferred')),
  evidence_ref TEXT,
  properties JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolved_entity_id TEXT REFERENCES canonical_entity(entity_id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_unresolved_state ON unresolved_reference(resolution_state, expected_target_type);
CREATE INDEX IF NOT EXISTS idx_unresolved_source ON unresolved_reference(source_entity_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS identity_conflict (
  conflict_id TEXT PRIMARY KEY,
  source_run_id TEXT NOT NULL REFERENCES source_run(run_id) ON DELETE CASCADE,
  local_ref TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  environment TEXT NOT NULL,
  identity_hints JSONB NOT NULL DEFAULT '{}'::jsonb,
  candidate_entity_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  conflict_entity_id TEXT REFERENCES canonical_entity(entity_id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','RESOLVED','DISMISSED')),
  resolution_note TEXT,
  resolved_entity_id TEXT REFERENCES canonical_entity(entity_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  UNIQUE (source_run_id, local_ref)
);
CREATE INDEX IF NOT EXISTS idx_identity_conflict_open ON identity_conflict(environment, entity_type, created_at DESC) WHERE state='OPEN';

CREATE TABLE IF NOT EXISTS topology_revision (
  revision_id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT NOT NULL,
  source_run_id TEXT REFERENCES source_run(run_id) ON DELETE SET NULL,
  graph_hash TEXT NOT NULL,
  entity_count INTEGER NOT NULL,
  relation_count INTEGER NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_revision_env_time ON topology_revision(environment, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topology_revision_graph_per_run ON topology_revision(environment, source_run_id, graph_hash) WHERE source_run_id IS NOT NULL;

COMMIT;
