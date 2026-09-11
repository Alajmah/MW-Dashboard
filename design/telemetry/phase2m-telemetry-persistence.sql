-- Phase 2M candidate only. This file is NOT a production migration.
-- It exists to measure D1 read/write behavior before Phase 2N introduces persistence.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS telemetry_delivery_ledger (
  delivery_id TEXT PRIMARY KEY,
  content_sha256 TEXT NOT NULL,
  source_id TEXT NOT NULL,
  first_received_at TEXT NOT NULL,
  last_received_at TEXT NOT NULL,
  receipt_count INTEGER NOT NULL DEFAULT 1 CHECK (receipt_count >= 1),
  status TEXT NOT NULL CHECK (status IN ('accepted', 'duplicate', 'quarantined'))
);

CREATE INDEX IF NOT EXISTS idx_telemetry_delivery_source_received
  ON telemetry_delivery_ledger(source_id, last_received_at DESC);

CREATE TABLE IF NOT EXISTS telemetry_source_state (
  source_id TEXT PRIMARY KEY,
  last_delivery_id TEXT,
  last_received_at TEXT NOT NULL,
  last_observed_at TEXT,
  state TEXT NOT NULL CHECK (state IN ('healthy', 'degraded', 'unknown')),
  accepted_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  quarantine_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS telemetry_latest_observation (
  entity_id TEXT NOT NULL,
  observation_type TEXT NOT NULL,
  dimensions_key TEXT NOT NULL DEFAULT '',
  observed_at TEXT NOT NULL,
  value_json TEXT NOT NULL,
  unit TEXT NOT NULL,
  source_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  quality_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (entity_id, observation_type, dimensions_key)
);

CREATE INDEX IF NOT EXISTS idx_telemetry_latest_source_observed
  ON telemetry_latest_observation(source_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_latest_type_observed
  ON telemetry_latest_observation(observation_type, observed_at DESC);

CREATE TABLE IF NOT EXISTS telemetry_quarantine (
  quarantine_id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  observation_id TEXT,
  source_id TEXT NOT NULL,
  semantic_type TEXT,
  display_name TEXT,
  reason TEXT NOT NULL,
  candidate_entity_ids_json TEXT NOT NULL DEFAULT '[]',
  observed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telemetry_quarantine_delivery
  ON telemetry_quarantine(delivery_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_quarantine_source_created
  ON telemetry_quarantine(source_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_quarantine_reason_created
  ON telemetry_quarantine(reason, created_at DESC);
