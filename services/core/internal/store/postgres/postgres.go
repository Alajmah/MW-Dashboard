package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/alajmah/mw-dashboard-core/internal/domain"
	"github.com/alajmah/mw-dashboard-core/registry"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Repository struct {
	pool *pgxpool.Pool
}

func Open(ctx context.Context, databaseURL string) (*Repository, error) {
	if strings.TrimSpace(databaseURL) == "" {
		return nil, errors.New("DATABASE_URL is required")
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, fmt.Errorf("open postgres pool: %w", err)
	}
	r := &Repository{pool: pool}
	if err := r.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return r, nil
}

func (r *Repository) Close() { r.pool.Close() }

func (r *Repository) Ping(ctx context.Context) error {
	if err := r.pool.Ping(ctx); err != nil {
		return fmt.Errorf("postgres ping: %w", err)
	}
	return nil
}

func hashID(prefix string, parts ...string) string {
	h := sha256.Sum256([]byte(strings.Join(parts, "|")))
	return prefix + hex.EncodeToString(h[:])[:24]
}

func contentHash(bundle domain.ObservationBundle) (string, error) {
	b, err := json.Marshal(bundle)
	if err != nil {
		return "", err
	}
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:]), nil
}

func jsonString(v interface{}) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "{}"
	}
	return string(b)
}

func artifactFields(a *domain.ArtifactRef) (uri, sum, media string, size *int64) {
	if a == nil {
		return "", "", "", nil
	}
	if a.SizeBytes != 0 {
		s := a.SizeBytes
		size = &s
	}
	return a.URI, a.SHA256, a.MediaType, size
}

func (r *Repository) IngestBundle(ctx context.Context, bundle domain.ObservationBundle, reg *registry.Registry) (domain.IngestResult, error) {
	if err := reg.ValidateBundle(bundle); err != nil {
		return domain.IngestResult{}, err
	}
	hash, err := contentHash(bundle)
	if err != nil {
		return domain.IngestResult{}, err
	}
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return domain.IngestResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var existingHash string
	err = tx.QueryRow(ctx, `SELECT content_sha256 FROM source_run WHERE run_id=$1`, bundle.Run.RunID).Scan(&existingHash)
	replay := false
	switch {
	case err == nil:
		if existingHash != hash {
			return domain.IngestResult{}, fmt.Errorf("run_id %q already exists with different content", bundle.Run.RunID)
		}
		replay = true
	case errors.Is(err, pgx.ErrNoRows):
		uri, sum, media, size := artifactFields(bundle.Run.Artifact)
		_, err = tx.Exec(ctx, `
			INSERT INTO source_run
			(run_id, environment, collector, collector_version, normalizer_version, source_kind, source_id, source_display_name,
			 started_at, completed_at, artifact_uri, artifact_sha256, artifact_media_type, artifact_size_bytes, content_sha256, metadata)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)`,
			bundle.Run.RunID, bundle.Run.Environment, bundle.Run.Collector, nullIfEmpty(bundle.Run.CollectorVersion), nullIfEmpty(bundle.Run.NormalizerVersion),
			bundle.Run.Source.Kind, bundle.Run.Source.ID, nullIfEmpty(bundle.Run.Source.DisplayName), bundle.Run.StartedAt, bundle.Run.CompletedAt,
			nullIfEmpty(uri), nullIfEmpty(sum), nullIfEmpty(media), size, hash, jsonString(bundle.Run.Metadata))
		if err != nil {
			return domain.IngestResult{}, fmt.Errorf("insert source run: %w", err)
		}
	default:
		return domain.IngestResult{}, err
	}

	for _, c := range bundle.Coverage {
		_, err = tx.Exec(ctx, `
			INSERT INTO source_coverage(run_id, scope_type, scope_key, object_class, mode, evidence_ref, error_text, properties)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
			ON CONFLICT (run_id, scope_type, scope_key, object_class) DO UPDATE SET
			mode=EXCLUDED.mode, evidence_ref=EXCLUDED.evidence_ref, error_text=EXCLUDED.error_text, properties=EXCLUDED.properties`,
			bundle.Run.RunID, c.ScopeType, c.ScopeKey, c.ObjectClass, c.Mode, nullIfEmpty(c.EvidenceRef), nullIfEmpty(c.Error), jsonString(c.Properties))
		if err != nil {
			return domain.IngestResult{}, fmt.Errorf("upsert coverage: %w", err)
		}
	}

	refToEntityID := make(map[string]string, len(bundle.Entities))
	entityTypeByRef := make(map[string]string, len(bundle.Entities))
	entityIDs := map[string]struct{}{}
	for _, e := range bundle.Entities {
		logicalKey, err := reg.ResolveLogicalKey(e.SemanticType, e.Identity.Hints)
		if err != nil {
			return domain.IngestResult{}, err
		}
		entityID := hashID("ent_", e.SemanticType, bundle.Run.Environment, logicalKey)
		refToEntityID[e.Ref] = entityID
		entityTypeByRef[e.Ref] = e.SemanticType
		entityIDs[entityID] = struct{}{}
		_, err = tx.Exec(ctx, `
			INSERT INTO canonical_entity(entity_id, entity_type, environment, logical_key, display_name, status, attributes, first_seen_at, last_seen_at)
			VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$8)
			ON CONFLICT(entity_id) DO UPDATE SET
			 display_name=EXCLUDED.display_name,
			 status=COALESCE(NULLIF(EXCLUDED.status,''), canonical_entity.status),
			 attributes=canonical_entity.attributes || EXCLUDED.attributes,
			 first_seen_at=LEAST(canonical_entity.first_seen_at, EXCLUDED.first_seen_at),
			 last_seen_at=GREATEST(canonical_entity.last_seen_at, EXCLUDED.last_seen_at),
			 updated_at=now()`,
			entityID, e.SemanticType, bundle.Run.Environment, logicalKey, e.DisplayName, nullIfEmpty(e.Status), jsonString(e.Properties), e.ObservedAt)
		if err != nil {
			return domain.IngestResult{}, fmt.Errorf("upsert entity %s: %w", e.Ref, err)
		}

		obsID := hashID("obs_", bundle.Run.RunID, "entity", e.Ref)
		_, err = tx.Exec(ctx, `
			INSERT INTO observation_record(observation_id, run_id, observation_kind, local_ref, semantic_type, observed_at, evidence_class, evidence_ref, identity_hints, properties, canonical_entity_id)
			VALUES($1,$2,'entity',$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)
			ON CONFLICT(observation_id) DO NOTHING`,
			obsID, bundle.Run.RunID, e.Ref, e.SemanticType, e.ObservedAt, string(e.EvidenceClass), nullIfEmpty(e.EvidenceRef), jsonString(e.Identity.Hints), jsonString(e.Properties), entityID)
		if err != nil {
			return domain.IngestResult{}, fmt.Errorf("insert entity observation %s: %w", e.Ref, err)
		}
		assertID := hashID("ast_", bundle.Run.RunID, "entity", e.Ref)
		_, err = tx.Exec(ctx, `
			INSERT INTO semantic_assertion(assertion_id, subject_kind, entity_id, source_run_id, evidence_class, observed_at, valid_from, evidence_ref, properties)
			VALUES($1,'entity',$2,$3,$4,$5,$5,$6,$7::jsonb)
			ON CONFLICT(assertion_id) DO NOTHING`, assertID, entityID, bundle.Run.RunID, string(e.EvidenceClass), e.ObservedAt, nullIfEmpty(e.EvidenceRef), jsonString(e.Properties))
		if err != nil {
			return domain.IngestResult{}, fmt.Errorf("insert entity assertion %s: %w", e.Ref, err)
		}
		for aliasType, raw := range e.Identity.Hints {
			if aliasType == "canonical_key" || raw == nil {
				continue
			}
			aliasValue := strings.TrimSpace(fmt.Sprint(raw))
			if aliasValue == "" {
				continue
			}
			_, err = tx.Exec(ctx, `
				INSERT INTO entity_alias(entity_id, alias_type, alias_value, source_run_id, first_seen_at, last_seen_at)
				VALUES($1,$2,$3,$4,$5,$5)
				ON CONFLICT(entity_id, alias_type, alias_value) DO UPDATE SET
				 last_seen_at=GREATEST(entity_alias.last_seen_at, EXCLUDED.last_seen_at), source_run_id=EXCLUDED.source_run_id`,
				entityID, aliasType, aliasValue, bundle.Run.RunID, e.ObservedAt)
			if err != nil {
				return domain.IngestResult{}, fmt.Errorf("upsert alias for %s: %w", e.Ref, err)
			}
		}
	}

	relationIDs := map[string]struct{}{}
	for _, rel := range bundle.Relations {
		sourceID := refToEntityID[rel.SourceRef]
		targetID := refToEntityID[rel.TargetRef]
		if err := reg.ValidateRelation(rel.SemanticType, entityTypeByRef[rel.SourceRef], entityTypeByRef[rel.TargetRef], rel.EvidenceClass); err != nil {
			return domain.IngestResult{}, err
		}
		relationID := hashID("rel_", sourceID, rel.SemanticType, targetID)
		relationIDs[relationID] = struct{}{}
		_, err = tx.Exec(ctx, `
			INSERT INTO canonical_relation(relation_id, relationship_type, source_entity_id, target_entity_id, attributes, first_seen_at, last_seen_at)
			VALUES($1,$2,$3,$4,$5::jsonb,$6,$6)
			ON CONFLICT(relation_id) DO UPDATE SET
			 attributes=canonical_relation.attributes || EXCLUDED.attributes,
			 first_seen_at=LEAST(canonical_relation.first_seen_at, EXCLUDED.first_seen_at),
			 last_seen_at=GREATEST(canonical_relation.last_seen_at, EXCLUDED.last_seen_at),
			 updated_at=now()`, relationID, rel.SemanticType, sourceID, targetID, jsonString(rel.Properties), rel.ObservedAt)
		if err != nil {
			return domain.IngestResult{}, fmt.Errorf("upsert relation %s: %w", rel.Ref, err)
		}
		obsID := hashID("obs_", bundle.Run.RunID, "relation", rel.Ref)
		_, err = tx.Exec(ctx, `
			INSERT INTO observation_record(observation_id, run_id, observation_kind, local_ref, semantic_type, observed_at, evidence_class, evidence_ref, properties, canonical_relation_id)
			VALUES($1,$2,'relation',$3,$4,$5,$6,$7,$8::jsonb,$9)
			ON CONFLICT(observation_id) DO NOTHING`, obsID, bundle.Run.RunID, rel.Ref, rel.SemanticType, rel.ObservedAt, string(rel.EvidenceClass), nullIfEmpty(rel.EvidenceRef), jsonString(rel.Properties), relationID)
		if err != nil {
			return domain.IngestResult{}, fmt.Errorf("insert relation observation %s: %w", rel.Ref, err)
		}
		assertID := hashID("ast_", bundle.Run.RunID, "relation", rel.Ref)
		_, err = tx.Exec(ctx, `
			INSERT INTO semantic_assertion(assertion_id, subject_kind, relation_id, source_run_id, evidence_class, observed_at, valid_from, evidence_ref, derivation_method, deterministic, confidence, properties)
			VALUES($1,'relation',$2,$3,$4,$5,$5,$6,$7,$8,$9,$10::jsonb)
			ON CONFLICT(assertion_id) DO NOTHING`, assertID, relationID, bundle.Run.RunID, string(rel.EvidenceClass), rel.ObservedAt, nullIfEmpty(rel.EvidenceRef), nullIfEmpty(rel.DerivationMethod), rel.Deterministic, rel.Confidence, jsonString(rel.Properties))
		if err != nil {
			return domain.IngestResult{}, fmt.Errorf("insert relation assertion %s: %w", rel.Ref, err)
		}
	}

	for _, unresolved := range bundle.UnresolvedReferences {
		sourceID := refToEntityID[unresolved.SourceRef]
		referenceID := hashID("urf_", bundle.Run.RunID, unresolved.Ref)
		candidateIDs := make([]string, 0, len(unresolved.CandidateRefs))
		for _, ref := range unresolved.CandidateRefs {
			if id, ok := refToEntityID[ref]; ok {
				candidateIDs = append(candidateIDs, id)
			}
		}
		_, err = tx.Exec(ctx, `
			INSERT INTO unresolved_reference(reference_id, source_run_id, source_entity_id, relationship_intent, expected_target_type, vendor_value,
			 resolution_state, resolution_reason, candidate_entity_ids, observed_at, evidence_class, evidence_ref, properties)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13::jsonb)
			ON CONFLICT(reference_id) DO UPDATE SET
			 resolution_state=EXCLUDED.resolution_state, resolution_reason=EXCLUDED.resolution_reason,
			 candidate_entity_ids=EXCLUDED.candidate_entity_ids, properties=EXCLUDED.properties`,
			referenceID, bundle.Run.RunID, sourceID, unresolved.SemanticType, unresolved.ExpectedTargetType, unresolved.VendorValue,
			unresolved.State, unresolved.Reason, jsonString(candidateIDs), unresolved.ObservedAt, string(unresolved.EvidenceClass), nullIfEmpty(unresolved.EvidenceRef), jsonString(unresolved.Properties))
		if err != nil {
			return domain.IngestResult{}, fmt.Errorf("upsert unresolved reference %s: %w", unresolved.Ref, err)
		}
		obsID := hashID("obs_", bundle.Run.RunID, "unresolved", unresolved.Ref)
		_, _ = tx.Exec(ctx, `
			INSERT INTO observation_record(observation_id, run_id, observation_kind, local_ref, semantic_type, observed_at, evidence_class, evidence_ref, properties, canonical_entity_id)
			VALUES($1,$2,'unresolved',$3,$4,$5,$6,$7,$8::jsonb,$9)
			ON CONFLICT(observation_id) DO NOTHING`, obsID, bundle.Run.RunID, unresolved.Ref, unresolved.SemanticType, unresolved.ObservedAt, string(unresolved.EvidenceClass), nullIfEmpty(unresolved.EvidenceRef), jsonString(unresolved.Properties), sourceID)
	}

	if err := tx.Commit(ctx); err != nil {
		return domain.IngestResult{}, err
	}
	return domain.IngestResult{
		RunID:                 bundle.Run.RunID,
		EntityObservations:    len(bundle.Entities),
		RelationObservations:  len(bundle.Relations),
		UnresolvedReferences: len(bundle.UnresolvedReferences),
		CanonicalEntities:     len(entityIDs),
		CanonicalRelations:    len(relationIDs),
		IdempotentReplay:      replay,
	}, nil
}

func nullIfEmpty(v string) interface{} {
	if strings.TrimSpace(v) == "" {
		return nil
	}
	return v
}

func (r *Repository) ListEntities(ctx context.Context, environment, entityType, query string, limit int) ([]domain.EntitySummary, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	args := []interface{}{environment}
	where := []string{"environment=$1"}
	if entityType != "" {
		args = append(args, entityType)
		where = append(where, fmt.Sprintf("entity_type=$%d", len(args)))
	}
	if query != "" {
		args = append(args, "%"+query+"%")
		where = append(where, fmt.Sprintf("(display_name ILIKE $%d OR attributes::text ILIKE $%d)", len(args), len(args)))
	}
	args = append(args, limit)
	q := fmt.Sprintf(`SELECT entity_id, entity_type, environment, logical_key, display_name, COALESCE(status,''), attributes, first_seen_at, last_seen_at
		FROM canonical_entity WHERE %s ORDER BY entity_type, display_name LIMIT $%d`, strings.Join(where, " AND "), len(args))
	rows, err := r.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.EntitySummary{}
	for rows.Next() {
		var item domain.EntitySummary
		var attrs []byte
		if err := rows.Scan(&item.ID, &item.Type, &item.Environment, &item.LogicalKey, &item.DisplayName, &item.Status, &attrs, &item.FirstSeenAt, &item.LastSeenAt); err != nil {
			return nil, err
		}
		if len(attrs) > 0 {
			_ = json.Unmarshal(attrs, &item.Attributes)
		}
		if item.Attributes == nil {
			item.Attributes = map[string]interface{}{}
		}
		out = append(out, item)
	}
	return out, rows.Err()
}
