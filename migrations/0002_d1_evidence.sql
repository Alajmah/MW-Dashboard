CREATE TABLE IF NOT EXISTS topology_evidence (
  evidence_key TEXT PRIMARY KEY,
  content_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_topology_evidence_created_at
  ON topology_evidence(created_at);
