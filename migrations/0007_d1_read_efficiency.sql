PRAGMA foreign_keys = ON;

-- Phase 2I: the impact/read APIs resolve unresolved references by their
-- canonical source entity. The previous estate index was ordered by state and
-- semantic type, so an entity-scoped lookup could only narrow to an estate and
-- then scan that estate's unresolved rows. Keep the existing state-oriented
-- index for estate summaries and add the source-oriented access path used by
-- investigation and impact reads.
CREATE INDEX IF NOT EXISTS idx_semantic_estate_unresolved_source
  ON semantic_estate_unresolved(
    estate_revision_id,
    source_entity_id,
    state,
    semantic_type,
    unresolved_id
  );
