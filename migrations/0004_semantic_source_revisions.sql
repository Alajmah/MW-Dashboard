PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS semantic_source_revision (
  revision_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_display_name TEXT,
  environment TEXT NOT NULL,
  collector TEXT NOT NULL,
  collector_version TEXT,
  normalizer_version TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  activated_at TEXT,
  archive_filename TEXT NOT NULL,
  archive_sha256 TEXT NOT NULL,
  archive_size_bytes INTEGER NOT NULL,
  bundle_sha256 TEXT NOT NULL,
  expected_coverage_count INTEGER NOT NULL,
  expected_entity_count INTEGER NOT NULL,
  expected_relation_count INTEGER NOT NULL,
  expected_unresolved_count INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('STAGING', 'ACTIVE', 'SUPERSEDED', 'FAILED')),
  is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
  quality_json TEXT NOT NULL DEFAULT '{}'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_semantic_current_source
  ON semantic_source_revision(source_id)
  WHERE is_current = 1;
CREATE INDEX IF NOT EXISTS idx_semantic_source_history
  ON semantic_source_revision(source_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_semantic_revision_status
  ON semantic_source_revision(status, imported_at DESC);

CREATE TABLE IF NOT EXISTS semantic_coverage (
  revision_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  scope_type TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  object_class TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('complete', 'point_in_time', 'partial', 'failed', 'not_collected')),
  properties_json TEXT NOT NULL,
  evidence_ref TEXT,
  error TEXT,
  PRIMARY KEY (revision_id, ordinal),
  FOREIGN KEY (revision_id) REFERENCES semantic_source_revision(revision_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_semantic_coverage_scope
  ON semantic_coverage(revision_id, scope_type, scope_key, object_class);

CREATE TABLE IF NOT EXISTS semantic_entity_observation (
  revision_id TEXT NOT NULL,
  entity_ref TEXT NOT NULL,
  semantic_type TEXT NOT NULL,
  display_name TEXT,
  observed_at TEXT,
  evidence_class TEXT NOT NULL CHECK (evidence_class IN ('observed', 'configured', 'declared', 'inferred')),
  identity_json TEXT NOT NULL,
  properties_json TEXT NOT NULL,
  evidence_ref TEXT,
  PRIMARY KEY (revision_id, entity_ref),
  FOREIGN KEY (revision_id) REFERENCES semantic_source_revision(revision_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_semantic_entity_type
  ON semantic_entity_observation(revision_id, semantic_type, display_name);

CREATE TABLE IF NOT EXISTS semantic_relation_observation (
  revision_id TEXT NOT NULL,
  relation_ref TEXT NOT NULL,
  semantic_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  observed_at TEXT,
  evidence_class TEXT NOT NULL CHECK (evidence_class IN ('observed', 'configured', 'declared', 'inferred')),
  properties_json TEXT NOT NULL,
  evidence_ref TEXT,
  PRIMARY KEY (revision_id, relation_ref),
  FOREIGN KEY (revision_id) REFERENCES semantic_source_revision(revision_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_semantic_relation_source
  ON semantic_relation_observation(revision_id, source_ref, semantic_type);
CREATE INDEX IF NOT EXISTS idx_semantic_relation_target
  ON semantic_relation_observation(revision_id, target_ref, semantic_type);

CREATE TABLE IF NOT EXISTS semantic_unresolved_reference (
  revision_id TEXT NOT NULL,
  unresolved_ref TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  semantic_type TEXT NOT NULL,
  expected_target_type TEXT,
  vendor_value TEXT,
  state TEXT NOT NULL,
  reason TEXT,
  observed_at TEXT,
  evidence_class TEXT,
  candidate_refs_json TEXT NOT NULL DEFAULT '[]',
  properties_json TEXT NOT NULL DEFAULT '{}',
  evidence_ref TEXT,
  PRIMARY KEY (revision_id, unresolved_ref),
  FOREIGN KEY (revision_id) REFERENCES semantic_source_revision(revision_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_semantic_unresolved_state
  ON semantic_unresolved_reference(revision_id, state, semantic_type);
