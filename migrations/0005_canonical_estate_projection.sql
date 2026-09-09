PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS semantic_estate_revision (
  estate_revision_id TEXT PRIMARY KEY,
  source_set_hash TEXT NOT NULL,
  source_revision_ids_json TEXT NOT NULL,
  built_at TEXT NOT NULL,
  activated_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('STAGING', 'ACTIVE', 'SUPERSEDED', 'FAILED')),
  is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
  expected_entity_count INTEGER NOT NULL,
  expected_relation_count INTEGER NOT NULL,
  expected_unresolved_count INTEGER NOT NULL,
  quality_json TEXT NOT NULL DEFAULT '{}'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_semantic_estate_current
  ON semantic_estate_revision(is_current)
  WHERE is_current = 1;
CREATE INDEX IF NOT EXISTS idx_semantic_estate_built
  ON semantic_estate_revision(built_at DESC);

CREATE TABLE IF NOT EXISTS semantic_estate_entity (
  estate_revision_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  semantic_type TEXT NOT NULL,
  identity_rule TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  identity_state TEXT NOT NULL DEFAULT 'resolved' CHECK (identity_state IN ('resolved', 'ambiguous', 'conflicted')),
  display_name TEXT,
  observed_at TEXT,
  properties_json TEXT NOT NULL DEFAULT '{}',
  evidence_classes_json TEXT NOT NULL DEFAULT '[]',
  source_ids_json TEXT NOT NULL DEFAULT '[]',
  source_observations_json TEXT NOT NULL DEFAULT '[]',
  evidence_count INTEGER NOT NULL DEFAULT 0,
  source_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (estate_revision_id, entity_id),
  FOREIGN KEY (estate_revision_id) REFERENCES semantic_estate_revision(estate_revision_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_semantic_estate_entity_type
  ON semantic_estate_entity(estate_revision_id, semantic_type, display_name);
CREATE INDEX IF NOT EXISTS idx_semantic_estate_entity_identity
  ON semantic_estate_entity(estate_revision_id, semantic_type, identity_key);

CREATE TABLE IF NOT EXISTS semantic_estate_relation (
  estate_revision_id TEXT NOT NULL,
  relation_id TEXT NOT NULL,
  semantic_type TEXT NOT NULL,
  source_entity_id TEXT NOT NULL,
  target_entity_id TEXT NOT NULL,
  observed_at TEXT,
  properties_json TEXT NOT NULL DEFAULT '{}',
  evidence_classes_json TEXT NOT NULL DEFAULT '[]',
  source_ids_json TEXT NOT NULL DEFAULT '[]',
  source_observations_json TEXT NOT NULL DEFAULT '[]',
  evidence_count INTEGER NOT NULL DEFAULT 0,
  source_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (estate_revision_id, relation_id),
  FOREIGN KEY (estate_revision_id) REFERENCES semantic_estate_revision(estate_revision_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_semantic_estate_relation_source
  ON semantic_estate_relation(estate_revision_id, source_entity_id, semantic_type);
CREATE INDEX IF NOT EXISTS idx_semantic_estate_relation_target
  ON semantic_estate_relation(estate_revision_id, target_entity_id, semantic_type);

CREATE TABLE IF NOT EXISTS semantic_estate_unresolved (
  estate_revision_id TEXT NOT NULL,
  unresolved_id TEXT NOT NULL,
  source_entity_id TEXT NOT NULL,
  semantic_type TEXT NOT NULL,
  expected_target_type TEXT,
  vendor_value TEXT,
  state TEXT NOT NULL,
  reason TEXT,
  candidate_entity_ids_json TEXT NOT NULL DEFAULT '[]',
  source_ids_json TEXT NOT NULL DEFAULT '[]',
  source_observations_json TEXT NOT NULL DEFAULT '[]',
  evidence_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (estate_revision_id, unresolved_id),
  FOREIGN KEY (estate_revision_id) REFERENCES semantic_estate_revision(estate_revision_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_semantic_estate_unresolved_state
  ON semantic_estate_unresolved(estate_revision_id, state, semantic_type);
