CREATE TABLE IF NOT EXISTS topology_evidence_chunk (
  evidence_key TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content_text TEXT NOT NULL,
  PRIMARY KEY (evidence_key, chunk_index),
  FOREIGN KEY (evidence_key) REFERENCES topology_evidence(evidence_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_topology_evidence_chunk_key
  ON topology_evidence_chunk(evidence_key, chunk_index);
