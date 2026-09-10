PRAGMA foreign_keys = ON;

-- Phase 2B keeps operational history separate from the semantic topology estate.
-- Each evidence source has at most one current evaluation revision; readers union
-- those current per-source revisions into the current operational view.
CREATE TABLE IF NOT EXISTS operational_evaluation_revision (
  evaluation_revision_id TEXT PRIMARY KEY,
  evaluation_key TEXT NOT NULL UNIQUE,
  schema_version TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_host TEXT NOT NULL,
  environment TEXT NOT NULL,
  evaluator TEXT NOT NULL,
  evaluator_version TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  activated_at TEXT,
  source_archive TEXT NOT NULL,
  source_archive_sha256 TEXT NOT NULL,
  result_sha256 TEXT NOT NULL,
  expected_observation_count INTEGER NOT NULL,
  expected_coverage_count INTEGER NOT NULL,
  expected_finding_count INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('STAGING', 'ACTIVE', 'SUPERSEDED', 'FAILED')),
  is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_operational_current_source
  ON operational_evaluation_revision(source_id)
  WHERE is_current = 1;
CREATE INDEX IF NOT EXISTS idx_operational_revision_history
  ON operational_evaluation_revision(source_id, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_operational_revision_status
  ON operational_evaluation_revision(status, imported_at DESC);

CREATE TABLE IF NOT EXISTS operational_observation (
  evaluation_revision_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  semantic_type TEXT NOT NULL,
  display_name TEXT NOT NULL,
  observation_type TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  value_json TEXT NOT NULL,
  unit TEXT NOT NULL,
  source_json TEXT NOT NULL,
  quality_json TEXT NOT NULL,
  dimensions_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (evaluation_revision_id, observation_id),
  FOREIGN KEY (evaluation_revision_id) REFERENCES operational_evaluation_revision(evaluation_revision_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_operational_observation_entity
  ON operational_observation(evaluation_revision_id, entity_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_operational_observation_type
  ON operational_observation(evaluation_revision_id, observation_type, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_operational_observation_entity_type
  ON operational_observation(evaluation_revision_id, entity_id, observation_type, observed_at DESC);

CREATE TABLE IF NOT EXISTS operational_coverage (
  evaluation_revision_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  scope_type TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  observation_family TEXT NOT NULL,
  sample_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('complete', 'point_in_time', 'partial', 'failed', 'not_collected')),
  evidence_ref TEXT NOT NULL,
  error TEXT,
  PRIMARY KEY (evaluation_revision_id, ordinal),
  FOREIGN KEY (evaluation_revision_id) REFERENCES operational_evaluation_revision(evaluation_revision_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_operational_coverage_scope
  ON operational_coverage(evaluation_revision_id, scope_type, scope_key, observation_family, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_operational_coverage_state
  ON operational_coverage(evaluation_revision_id, state, observed_at DESC);

CREATE TABLE IF NOT EXISTS operational_finding_occurrence (
  evaluation_revision_id TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  semantic_type TEXT NOT NULL,
  display_name TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  evaluator_status TEXT NOT NULL CHECK (evaluator_status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
  summary TEXT NOT NULL,
  diagnosis TEXT NOT NULL,
  confidence_json TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  coverage_state TEXT NOT NULL CHECK (coverage_state IN ('sufficient', 'limited', 'partial', 'failed', 'unknown')),
  evidence_json TEXT NOT NULL,
  related_entities_json TEXT NOT NULL DEFAULT '[]',
  details_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (evaluation_revision_id, finding_id),
  FOREIGN KEY (evaluation_revision_id) REFERENCES operational_evaluation_revision(evaluation_revision_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_operational_finding_entity
  ON operational_finding_occurrence(evaluation_revision_id, entity_id, severity, last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_operational_finding_rule
  ON operational_finding_occurrence(evaluation_revision_id, rule_id, last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_operational_finding_severity
  ON operational_finding_occurrence(evaluation_revision_id, severity, last_seen DESC);

-- Operator lifecycle is intentionally independent from evaluator revisions. A
-- later evaluation therefore cannot erase an acknowledgement merely by being
-- imported. RESOLVED may be reopened only by newer evidence during activation.
CREATE TABLE IF NOT EXISTS operational_finding_state (
  finding_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
  opened_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  note TEXT,
  transition_source TEXT NOT NULL CHECK (transition_source IN ('evaluation_activation', 'operator_api'))
);

CREATE INDEX IF NOT EXISTS idx_operational_finding_state_status
  ON operational_finding_state(status, changed_at DESC);

CREATE TABLE IF NOT EXISTS operational_finding_state_event (
  event_id TEXT PRIMARY KEY,
  finding_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
  changed_at TEXT NOT NULL,
  note TEXT,
  transition_source TEXT NOT NULL CHECK (transition_source IN ('evaluation_activation', 'operator_api'))
);

CREATE INDEX IF NOT EXISTS idx_operational_finding_state_event_history
  ON operational_finding_state_event(finding_id, changed_at DESC);
