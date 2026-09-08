package postgres

import (
	"context"
	"testing"
	"time"

	"github.com/alajmah/mw-dashboard-core/internal/domain"
)

func TestRelationCoverageTargetTypeDoesNotCrossExpire(t *testing.T) {
	repo, reg := openReconciliationTestRepository(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	env := "ci-relation-target-" + now.Format("150405.000000000")
	source := domain.SourceRef{Kind: "ibm_mq_host", ID: "host-cluster"}

	first := clusterDiscoveryTargetBundle(env, "cluster-target-1-"+now.Format("150405.000000000"), source, now)
	if _, err := repo.IngestBundle(ctx, first, reg); err != nil {
		t.Fatal(err)
	}
	if got := activeClusterDiscoveriesByTargetType(t, repo, ctx, env, "mq.queue"); got != 1 {
		t.Fatalf("expected one active queue discovery before coverage, got %d", got)
	}
	if got := activeClusterDiscoveriesByTargetType(t, repo, ctx, env, "mq.queue_manager"); got != 1 {
		t.Fatalf("expected one active queue-manager discovery before coverage, got %d", got)
	}

	second := domain.ObservationBundle{
		SchemaVersion: domain.ObservationBundleSchema,
		Run: domain.Run{
			RunID:       "cluster-target-2-" + now.Format("150405.000000000"),
			Environment: env,
			Collector:   "cluster-target-test",
			CompletedAt: now.Add(time.Minute),
			Source:      source,
		},
		Coverage: []domain.Coverage{{
			ScopeType:   "queue_manager",
			ScopeKey:    "QM_LOCAL",
			ObjectClass: "relation:mq.cluster_discovers:queue",
			Mode:        "point_in_time",
			Properties: map[string]interface{}{
				"absence_closes_assertions": true,
				"relationship_type":        "mq.cluster_discovers",
				"source_type":              "mq.queue_manager",
				"target_type":              "mq.queue",
			},
		}},
		Entities:             []domain.EntityObservation{},
		Relations:            []domain.RelationObservation{},
		UnresolvedReferences: []domain.UnresolvedReference{},
	}
	result, err := repo.IngestBundle(ctx, second, reg)
	if err != nil {
		t.Fatal(err)
	}
	if result.AssertionsClosed != 1 {
		t.Fatalf("expected exactly one queue-target relation to close, got %#v", result)
	}
	if got := activeClusterDiscoveriesByTargetType(t, repo, ctx, env, "mq.queue"); got != 0 {
		t.Fatalf("queue-target discovery should be closed by queue coverage, got %d", got)
	}
	if got := activeClusterDiscoveriesByTargetType(t, repo, ctx, env, "mq.queue_manager"); got != 1 {
		t.Fatalf("queue-manager discovery must survive queue-target coverage, got %d", got)
	}
}

func clusterDiscoveryTargetBundle(environment, runID string, source domain.SourceRef, observedAt time.Time) domain.ObservationBundle {
	return domain.ObservationBundle{
		SchemaVersion: domain.ObservationBundleSchema,
		Run: domain.Run{RunID: runID, Environment: environment, Collector: "cluster-target-test", CompletedAt: observedAt, Source: source},
		Coverage: []domain.Coverage{},
		Entities: []domain.EntityObservation{
			{
				Ref: "local-qm", SemanticType: "mq.queue_manager",
				Identity: domain.Identity{Hints: map[string]interface{}{"name": "QM_LOCAL"}},
				DisplayName: "QM_LOCAL", ObservedAt: observedAt, EvidenceClass: domain.EvidenceObserved,
				Properties: map[string]interface{}{"queue_manager": "QM_LOCAL"},
			},
			{
				Ref: "remote-qm", SemanticType: "mq.queue_manager",
				Identity: domain.Identity{Hints: map[string]interface{}{"name": "QM_REMOTE", "qmid": "QM_REMOTE_001"}},
				DisplayName: "QM_REMOTE", ObservedAt: observedAt, EvidenceClass: domain.EvidenceObserved,
				Properties: map[string]interface{}{"queue_manager": "QM_REMOTE"},
			},
			{
				Ref: "cluster-queue", SemanticType: "mq.queue",
				Identity: domain.Identity{Hints: map[string]interface{}{"queue_manager_key": "QM_REMOTE", "name": "TARGET.Q"}},
				DisplayName: "TARGET.Q", ObservedAt: observedAt, EvidenceClass: domain.EvidenceObserved,
				Properties: map[string]interface{}{"queue_manager": "QM_REMOTE", "queue_type": "QCLUSTER_VISIBLE"},
			},
		},
		Relations: []domain.RelationObservation{
			{
				Ref: "discover-qm", SemanticType: "mq.cluster_discovers", SourceRef: "local-qm", TargetRef: "remote-qm",
				ObservedAt: observedAt, EvidenceClass: domain.EvidenceObserved,
				Properties: map[string]interface{}{"queue_manager": "QM_LOCAL", "cluster": "CL1"},
			},
			{
				Ref: "discover-queue", SemanticType: "mq.cluster_discovers", SourceRef: "local-qm", TargetRef: "cluster-queue",
				ObservedAt: observedAt, EvidenceClass: domain.EvidenceObserved,
				Properties: map[string]interface{}{"queue_manager": "QM_LOCAL", "cluster": "CL1"},
			},
		},
		UnresolvedReferences: []domain.UnresolvedReference{},
	}
}

func activeClusterDiscoveriesByTargetType(t *testing.T, repo *Repository, ctx context.Context, environment, targetType string) int {
	t.Helper()
	var count int
	if err := repo.pool.QueryRow(ctx, `
		SELECT count(*)
		FROM semantic_assertion a
		JOIN canonical_relation r ON r.relation_id=a.relation_id
		JOIN canonical_entity src ON src.entity_id=r.source_entity_id
		JOIN canonical_entity dst ON dst.entity_id=r.target_entity_id
		WHERE src.environment=$1
		  AND r.relationship_type='mq.cluster_discovers'
		  AND dst.entity_type=$2
		  AND a.valid_to IS NULL`, environment, targetType).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}
