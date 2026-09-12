PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS telemetry_delivery_ledger (
  delivery_id TEXT PRIMARY KEY,
  content_sha256 TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_host TEXT NOT NULL,
  key_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  estate_revision_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('PROCESSING', 'ACCEPTED')),
  first_received_at TEXT NOT NULL,
  last_attempt_at TEXT NOT NULL,
  accepted_at TEXT,
  attempt_token TEXT,
  payload_bytes INTEGER NOT NULL,
  observation_count INTEGER NOT NULL,
  resolved_count INTEGER NOT NULL DEFAULT 0,
  quarantine_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_telemetry_delivery_source
  ON telemetry_delivery_ledger(source_id, first_received_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_delivery_status
  ON telemetry_delivery_ledger(status, last_attempt_at);

CREATE TABLE IF NOT EXISTS telemetry_source_state (
  source_id TEXT PRIMARY KEY,
  source_host TEXT NOT NULL,
  last_delivery_id TEXT NOT NULL,
  last_received_at TEXT NOT NULL,
  last_observed_at TEXT,
  estate_revision_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('healthy', 'degraded', 'unknown')),
  accepted_delivery_count INTEGER NOT NULL DEFAULT 0,
  resolved_observation_count INTEGER NOT NULL DEFAULT 0,
  quarantined_observation_count INTEGER NOT NULL DEFAULT 0,
  observed_keys_json TEXT NOT NULL DEFAULT '[]',
  coverage_json TEXT NOT NULL DEFAULT '[]',
  current_quarantine_json TEXT NOT NULL DEFAULT '[]',
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_telemetry_source_state_observed
  ON telemetry_source_state(last_observed_at DESC);

CREATE TABLE IF NOT EXISTS telemetry_latest_observation (
  entity_id TEXT NOT NULL,
  observation_type TEXT NOT NULL,
  dimensions_key TEXT NOT NULL,
  dimensions_json TEXT NOT NULL DEFAULT '{}',
  value_json TEXT NOT NULL,
  unit TEXT NOT NULL,
  value_observed_at TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_host TEXT NOT NULL,
  source_json TEXT NOT NULL DEFAULT '{}',
  quality_json TEXT NOT NULL DEFAULT '{}',
  evidence_ref TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  estate_revision_id TEXT NOT NULL,
  PRIMARY KEY (entity_id, observation_type, dimensions_key)
);
CREATE INDEX IF NOT EXISTS idx_telemetry_latest_source
  ON telemetry_latest_observation(source_id, entity_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_latest_type
  ON telemetry_latest_observation(observation_type, entity_id);

CREATE TABLE IF NOT EXISTS telemetry_quarantine (
  quarantine_key TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  semantic_type TEXT,
  display_name TEXT,
  reason TEXT NOT NULL,
  candidate_entity_ids_json TEXT NOT NULL DEFAULT '[]',
  first_delivery_id TEXT NOT NULL,
  first_observation_id TEXT,
  first_observed_at TEXT,
  first_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_telemetry_quarantine_source
  ON telemetry_quarantine(source_id, first_seen_at DESC);
