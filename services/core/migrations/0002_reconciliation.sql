BEGIN;

ALTER TABLE canonical_entity
  ADD COLUMN IF NOT EXISTS identity_rule TEXT,
  ADD COLUMN IF NOT EXISTS identity_strength INTEGER NOT NULL DEFAULT 0 CHECK (identity_strength >= 0);

CREATE INDEX IF NOT EXISTS idx_entity_identity_rule
  ON canonical_entity(environment, entity_type, identity_rule, identity_strength DESC);

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

CREATE INDEX IF NOT EXISTS idx_identity_conflict_open
  ON identity_conflict(environment, entity_type, created_at DESC)
  WHERE state='OPEN';

CREATE INDEX IF NOT EXISTS idx_assertion_active_run
  ON semantic_assertion(source_run_id, subject_kind, valid_to);

CREATE UNIQUE INDEX IF NOT EXISTS idx_topology_revision_graph_per_run
  ON topology_revision(environment, source_run_id, graph_hash)
  WHERE source_run_id IS NOT NULL;

COMMIT;
