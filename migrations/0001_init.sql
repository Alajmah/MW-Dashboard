PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS topology_snapshot (
  snapshot_id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  environment TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('STAGING', 'SUCCESS', 'FAILED')),
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  node_count INTEGER NOT NULL DEFAULT 0,
  edge_count INTEGER NOT NULL DEFAULT 0,
  discovery_json TEXT NOT NULL,
  evidence_key TEXT
);

CREATE TABLE IF NOT EXISTS topology_node (
  snapshot_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  name TEXT NOT NULL,
  environment TEXT NOT NULL,
  scope TEXT NOT NULL,
  status TEXT,
  metadata_json TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, node_id),
  FOREIGN KEY (snapshot_id) REFERENCES topology_snapshot(snapshot_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS topology_edge (
  snapshot_id TEXT NOT NULL,
  edge_id TEXT NOT NULL,
  source_node_id TEXT NOT NULL,
  relationship_type TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  relationship_source TEXT NOT NULL CHECK (relationship_source IN ('observed', 'configured', 'inferred')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence TEXT,
  metadata_json TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, edge_id),
  FOREIGN KEY (snapshot_id) REFERENCES topology_snapshot(snapshot_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_snapshot_active ON topology_snapshot(is_active, created_at);
CREATE INDEX IF NOT EXISTS idx_node_name ON topology_node(snapshot_id, name);
CREATE INDEX IF NOT EXISTS idx_node_type ON topology_node(snapshot_id, node_type);
CREATE INDEX IF NOT EXISTS idx_edge_source ON topology_edge(snapshot_id, source_node_id);
CREATE INDEX IF NOT EXISTS idx_edge_target ON topology_edge(snapshot_id, target_node_id);
