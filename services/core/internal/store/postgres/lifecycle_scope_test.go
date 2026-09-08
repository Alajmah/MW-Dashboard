package postgres

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/alajmah/mw-dashboard-core/internal/domain"
)

func TestQueueManagerScopedCoverageDoesNotRetireSiblingQueueManagerObjects(t *testing.T) {
	repo, reg := openReconciliationTestRepository(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	env := "ci-qmgr-scope-" + now.Format("150405.000000000")
	source := domain.SourceRef{Kind: "ibm_mq_host", ID: "host-shared"}

	first := qmgrScopedQueueBundle(env, "qscope-1-"+now.Format("150405.000000000"), source, now, map[string][]string{
		"QM_A": {"A.ONE", "A.TWO"},
		"QM_B": {"B.ONE"},
	}, nil)
	if _, err := repo.IngestBundle(ctx, first, reg); err != nil {
		t.Fatal(err)
	}

	second := qmgrScopedQueueBundle(env, "qscope-2-"+now.Format("150405.000000000"), source, now.Add(time.Minute), map[string][]string{
		"QM_A": {"A.ONE"},
	}, []domain.Coverage{{ScopeType: "queue_manager", ScopeKey: "QM_A", ObjectClass: "mq.queue", Mode: "complete"}})
	result, err := repo.IngestBundle(ctx, second, reg)
	if err != nil {
		t.Fatal(err)
	}
	if result.AssertionsClosed < 2 {
		t.Fatalf("expected A.ONE supersession and A.TWO absence closure, got %#v", result)
	}

	active := map[string]int{}
	rows, err := repo.pool.Query(ctx, `
		SELECT e.display_name, count(*)
		FROM semantic_assertion a
		JOIN canonical_entity e ON e.entity_id=a.entity_id
		WHERE e.environment=$1 AND e.entity_type='mq.queue' AND a.valid_to IS NULL
		GROUP BY e.display_name`, env)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		var count int
		if err := rows.Scan(&name, &count); err != nil {
			t.Fatal(err)
		}
		active[name] = count
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}

	if active["A.ONE"] != 1 || active["A.TWO"] != 0 || active["B.ONE"] != 1 {
		t.Fatalf("queue-manager coverage leaked across scopes: %#v", active)
	}
}

func TestPointInTimeCoverageRequiresExplicitAbsenceClosure(t *testing.T) {
	repo, reg := openReconciliationTestRepository(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	env := "ci-point-scope-" + now.Format("150405.000000000")
	source := domain.SourceRef{Kind: "ibm_mq_host", ID: "host-runtime"}

	first := runtimeAccessBundle(env, "runtime-1-"+now.Format("150405.000000000"), source, now, true, nil)
	if _, err := repo.IngestBundle(ctx, first, reg); err != nil {
		t.Fatal(err)
	}

	// A generic point-in-time marker is informational and must not close truth.
	second := runtimeAccessBundle(env, "runtime-2-"+now.Format("150405.000000000"), source, now.Add(time.Minute), false,
		[]domain.Coverage{{ScopeType: "queue_manager", ScopeKey: "QM_RUNTIME", ObjectClass: "relation:runtime.opens_for_output", Mode: "point_in_time"}})
	if _, err := repo.IngestBundle(ctx, second, reg); err != nil {
		t.Fatal(err)
	}
	if got := activeRelationAssertions(t, repo, ctx, env, "runtime.opens_for_output"); got != 1 {
		t.Fatalf("point-in-time coverage without explicit closure must retain prior assertion, got %d", got)
	}

	// An exhaustive point-in-time enumeration may explicitly establish absence.
	third := runtimeAccessBundle(env, "runtime-3-"+now.Format("150405.000000000"), source, now.Add(2*time.Minute), false,
		[]domain.Coverage{{ScopeType: "queue_manager", ScopeKey: "QM_RUNTIME", ObjectClass: "relation:runtime.opens_for_output", Mode: "point_in_time", Properties: map[string]interface{}{"absence_closes_assertions": true}}})
	result, err := repo.IngestBundle(ctx, third, reg)
	if err != nil {
		t.Fatal(err)
	}
	if result.AssertionsClosed == 0 {
		t.Fatalf("expected exhaustive point-in-time absence to close assertion: %#v", result)
	}
	if got := activeRelationAssertions(t, repo, ctx, env, "runtime.opens_for_output"); got != 0 {
		t.Fatalf("exhaustive point-in-time absence should close prior assertion, got %d", got)
	}
}

func qmgrScopedQueueBundle(environment, runID string, source domain.SourceRef, observedAt time.Time, queues map[string][]string, coverage []domain.Coverage) domain.ObservationBundle {
	bundle := domain.ObservationBundle{
		SchemaVersion: domain.ObservationBundleSchema,
		Run: domain.Run{RunID: runID, Environment: environment, Collector: "scope-test", CompletedAt: observedAt, Source: source},
		Coverage: coverage,
		Entities: []domain.EntityObservation{},
		Relations: []domain.RelationObservation{},
		UnresolvedReferences: []domain.UnresolvedReference{},
	}
	if coverage == nil {
		for qmgr := range queues {
			bundle.Coverage = append(bundle.Coverage, domain.Coverage{ScopeType: "queue_manager", ScopeKey: qmgr, ObjectClass: "mq.queue", Mode: "complete"})
		}
	}
	for qmgr, names := range queues {
		for _, name := range names {
			bundle.Entities = append(bundle.Entities, domain.EntityObservation{
				Ref: qmgr + ":" + name,
				SemanticType: "mq.queue",
				Identity: domain.Identity{Hints: map[string]interface{}{"queue_manager_key": qmgr, "name": name}},
				DisplayName: name,
				ObservedAt: observedAt,
				EvidenceClass: domain.EvidenceConfigured,
				Properties: map[string]interface{}{"queue_manager": qmgr, "queue_type": "QLOCAL"},
			})
		}
	}
	return bundle
}

func runtimeAccessBundle(environment, runID string, source domain.SourceRef, observedAt time.Time, includeAccess bool, coverage []domain.Coverage) domain.ObservationBundle {
	bundle := domain.ObservationBundle{
		SchemaVersion: domain.ObservationBundleSchema,
		Run: domain.Run{RunID: runID, Environment: environment, Collector: "runtime-scope-test", CompletedAt: observedAt, Source: source},
		Coverage: coverage,
		Entities: []domain.EntityObservation{
			{Ref: "app", SemanticType: "app.application_instance", Identity: domain.Identity{Hints: map[string]interface{}{"canonical_key": "mockapp@client"}}, DisplayName: "MockApp", ObservedAt: observedAt, EvidenceClass: domain.EvidenceObserved, Properties: map[string]interface{}{"queue_manager": "QM_RUNTIME"}},
			{Ref: "queue", SemanticType: "mq.queue", Identity: domain.Identity{Hints: map[string]interface{}{"queue_manager_key": "QM_RUNTIME", "name": "APP.Q"}}, DisplayName: "APP.Q", ObservedAt: observedAt, EvidenceClass: domain.EvidenceObserved, Properties: map[string]interface{}{"queue_manager": "QM_RUNTIME", "queue_type": "OBSERVED_ONLY"}},
		},
		Relations: []domain.RelationObservation{},
		UnresolvedReferences: []domain.UnresolvedReference{},
	}
	if includeAccess {
		bundle.Relations = append(bundle.Relations, domain.RelationObservation{
			Ref: "open-output", SemanticType: "runtime.opens_for_output", SourceRef: "app", TargetRef: "queue", ObservedAt: observedAt,
			EvidenceClass: domain.EvidenceObserved, Properties: map[string]interface{}{"queue_manager": "QM_RUNTIME"},
		})
	}
	return bundle
}

func activeRelationAssertions(t *testing.T, repo *Repository, ctx context.Context, environment, relationshipType string) int {
	t.Helper()
	var count int
	if err := repo.pool.QueryRow(ctx, `
		SELECT count(*)
		FROM semantic_assertion a
		JOIN canonical_relation r ON r.relation_id=a.relation_id
		JOIN canonical_entity src ON src.entity_id=r.source_entity_id
		WHERE src.environment=$1 AND r.relationship_type=$2 AND a.valid_to IS NULL`, environment, relationshipType).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

var _ = strings.TrimSpace
