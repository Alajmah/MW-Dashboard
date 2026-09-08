package postgres

import (
	"context"
	"fmt"
	"strings"

	"github.com/alajmah/mw-dashboard-core/internal/domain"
	"github.com/jackc/pgx/v5"
)

func coverageClosesAbsence(coverage domain.Coverage) (bool, string) {
	if coverage.Mode == "complete" {
		return true, "absent_from_complete_coverage"
	}
	if coverage.Mode == "point_in_time" {
		if value, ok := coverage.Properties["absence_closes_assertions"].(bool); ok && value {
			return true, "absent_from_point_in_time_enumeration"
		}
	}
	return false, ""
}

func coverageScopeSQL(scopeType string, subject string) (string, bool) {
	switch scopeType {
	case "source":
		return "", true
	case "queue_manager":
		if subject == "entity" {
			return " AND lower(COALESCE(entity.attributes->>'queue_manager',''))=lower($8)", true
		}
		return " AND lower(COALESCE(relation.attributes->>'queue_manager',''))=lower($8)", true
	default:
		return "", false
	}
}

func reconcileAssertionLifecycle(ctx context.Context, tx pgx.Tx, bundle domain.ObservationBundle) (int, error) {
	closed := 0

	result, err := tx.Exec(ctx, `
		UPDATE semantic_assertion previous
		SET valid_to=$1,
		    properties=previous.properties || jsonb_build_object('closed_reason','superseded_by_newer_observation','closed_by_run_id',$2)
		FROM source_run previous_run
		WHERE previous.source_run_id=previous_run.run_id
		  AND previous.valid_to IS NULL
		  AND previous.source_run_id<>$2
		  AND previous_run.environment=$3
		  AND previous_run.source_kind=$4
		  AND previous_run.source_id=$5
		  AND previous_run.completed_at <= $1
		  AND EXISTS (
		    SELECT 1 FROM semantic_assertion current
		    WHERE current.source_run_id=$2
		      AND current.subject_kind=previous.subject_kind
		      AND current.entity_id IS NOT DISTINCT FROM previous.entity_id
		      AND current.relation_id IS NOT DISTINCT FROM previous.relation_id
		  )`,
		bundle.Run.CompletedAt, bundle.Run.RunID, bundle.Run.Environment, bundle.Run.Source.Kind, bundle.Run.Source.ID)
	if err != nil {
		return 0, fmt.Errorf("supersede prior assertions: %w", err)
	}
	closed += int(result.RowsAffected())

	for _, coverage := range bundle.Coverage {
		closes, closeReason := coverageClosesAbsence(coverage)
		if !closes {
			continue
		}
		if coverage.ScopeType == "source" && coverage.ScopeKey != "" && coverage.ScopeKey != bundle.Run.Source.ID && coverage.ScopeKey != bundle.Run.Source.DisplayName {
			continue
		}
		if strings.HasPrefix(coverage.ObjectClass, "relation:") {
			scopeSQL, supported := coverageScopeSQL(coverage.ScopeType, "relation")
			if !supported {
				continue
			}
			relationType := strings.TrimPrefix(coverage.ObjectClass, "relation:")
			query := `
				UPDATE semantic_assertion previous
				SET valid_to=$1,
				    properties=previous.properties || jsonb_build_object('closed_reason',$9,'closed_by_run_id',$2,'coverage_object_class',$6,'coverage_scope_type',$7,'coverage_scope_key',$8)
				FROM source_run previous_run, canonical_relation relation
				WHERE previous.source_run_id=previous_run.run_id
				  AND previous.relation_id=relation.relation_id
				  AND previous.subject_kind='relation'
				  AND previous.valid_to IS NULL
				  AND previous.source_run_id<>$2
				  AND previous_run.environment=$3
				  AND previous_run.source_kind=$4
				  AND previous_run.source_id=$5
				  AND previous_run.completed_at <= $1
				  AND relation.relationship_type=$10` + scopeSQL
			result, err = tx.Exec(ctx, query,
				bundle.Run.CompletedAt, bundle.Run.RunID, bundle.Run.Environment, bundle.Run.Source.Kind, bundle.Run.Source.ID,
				coverage.ObjectClass, coverage.ScopeType, coverage.ScopeKey, closeReason, relationType)
		} else {
			scopeSQL, supported := coverageScopeSQL(coverage.ScopeType, "entity")
			if !supported {
				continue
			}
			query := `
				UPDATE semantic_assertion previous
				SET valid_to=$1,
				    properties=previous.properties || jsonb_build_object('closed_reason',$9,'closed_by_run_id',$2,'coverage_object_class',$6,'coverage_scope_type',$7,'coverage_scope_key',$8)
				FROM source_run previous_run, canonical_entity entity
				WHERE previous.source_run_id=previous_run.run_id
				  AND previous.entity_id=entity.entity_id
				  AND previous.subject_kind='entity'
				  AND previous.valid_to IS NULL
				  AND previous.source_run_id<>$2
				  AND previous_run.environment=$3
				  AND previous_run.source_kind=$4
				  AND previous_run.source_id=$5
				  AND previous_run.completed_at <= $1
				  AND entity.entity_type=$6` + scopeSQL
			result, err = tx.Exec(ctx, query,
				bundle.Run.CompletedAt, bundle.Run.RunID, bundle.Run.Environment, bundle.Run.Source.Kind, bundle.Run.Source.ID,
				coverage.ObjectClass, coverage.ScopeType, coverage.ScopeKey, closeReason)
		}
		if err != nil {
			return closed, fmt.Errorf("apply coverage %s/%s/%s: %w", coverage.ScopeType, coverage.ScopeKey, coverage.ObjectClass, err)
		}
		closed += int(result.RowsAffected())
	}
	return closed, nil
}
