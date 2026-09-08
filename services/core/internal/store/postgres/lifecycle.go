package postgres

import (
	"context"
	"fmt"
	"strings"

	"github.com/alajmah/mw-dashboard-core/internal/domain"
	"github.com/jackc/pgx/v5"
)

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
		if coverage.Mode != "complete" || coverage.ScopeType != "source" {
			continue
		}
		if coverage.ScopeKey != "" && coverage.ScopeKey != bundle.Run.Source.ID && coverage.ScopeKey != bundle.Run.Source.DisplayName {
			continue
		}
		if strings.HasPrefix(coverage.ObjectClass, "relation:") {
			relationType := strings.TrimPrefix(coverage.ObjectClass, "relation:")
			result, err = tx.Exec(ctx, `
				UPDATE semantic_assertion previous
				SET valid_to=$1,
				    properties=previous.properties || jsonb_build_object('closed_reason','absent_from_complete_coverage','closed_by_run_id',$2,'coverage_object_class',$6)
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
				  AND relation.relationship_type=$7`,
				bundle.Run.CompletedAt, bundle.Run.RunID, bundle.Run.Environment, bundle.Run.Source.Kind, bundle.Run.Source.ID, coverage.ObjectClass, relationType)
		} else {
			result, err = tx.Exec(ctx, `
				UPDATE semantic_assertion previous
				SET valid_to=$1,
				    properties=previous.properties || jsonb_build_object('closed_reason','absent_from_complete_coverage','closed_by_run_id',$2,'coverage_object_class',$6)
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
				  AND entity.entity_type=$6`,
				bundle.Run.CompletedAt, bundle.Run.RunID, bundle.Run.Environment, bundle.Run.Source.Kind, bundle.Run.Source.ID, coverage.ObjectClass)
		}
		if err != nil {
			return closed, fmt.Errorf("apply complete coverage %s: %w", coverage.ObjectClass, err)
		}
		closed += int(result.RowsAffected())
	}
	return closed, nil
}
