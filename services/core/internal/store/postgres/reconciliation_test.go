package postgres

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/alajmah/mw-dashboard-core/internal/domain"
	"github.com/alajmah/mw-dashboard-core/registry"
)

func openReconciliationTestRepository(t *testing.T) (*Repository, *registry.Registry) {
	t.Helper()
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not configured")
	}
	repo, err := Open(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(repo.Close)
	reg, err := registry.LoadDefault()
	if err != nil {
		t.Fatal(err)
	}
	return repo, reg
}

func TestMultiSourceQueueManagerReconciliationAndHAPlacement(t *testing.T) {
	repo, reg := openReconciliationTestRepository(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	env := "ci-reconcile-" + now.Format("150405.000000000")

	bundleA := mqPlacementBundle(env, "run-a-"+now.Format("150405.000000000"), "host-a", "QM_SHARED", map[string]interface{}{
		"canonical_key": "qm_shared",
		"name":          "QM_SHARED",
	}, now)
	if _, err := repo.IngestBundle(ctx, bundleA, reg); err != nil {
		t.Fatal(err)
	}

	bundleB := mqPlacementBundle(env, "run-b-"+now.Format("150405.000000000"), "host-b", "QM_SHARED", map[string]interface{}{
		"qmid": "QMID-1234567890",
		"name": "QM_SHARED",
	}, now.Add(time.Second))
	result, err := repo.IngestBundle(ctx, bundleB, reg)
	if err != nil {
		t.Fatal(err)
	}
	if result.IdentityConflicts != 0 {
		t.Fatalf("unexpected identity conflicts: %#v", result)
	}

	var qmgrCount, instanceCount, placementCount int
	if err := repo.pool.QueryRow(ctx, `SELECT count(*) FROM canonical_entity WHERE environment=$1 AND entity_type='mq.queue_manager'`, env).Scan(&qmgrCount); err != nil {
		t.Fatal(err)
	}
	if err := repo.pool.QueryRow(ctx, `SELECT count(*) FROM canonical_entity WHERE environment=$1 AND entity_type='mq.queue_manager_instance'`, env).Scan(&instanceCount); err != nil {
		t.Fatal(err)
	}
	if err := repo.pool.QueryRow(ctx, `
		SELECT count(*) FROM canonical_relation r
		JOIN canonical_entity src ON src.entity_id=r.source_entity_id
		WHERE src.environment=$1 AND r.relationship_type='has_instance'`, env).Scan(&placementCount); err != nil {
		t.Fatal(err)
	}
	if qmgrCount != 1 || instanceCount != 2 || placementCount != 2 {
		t.Fatalf("expected one logical QM with two instances; qmgr=%d instances=%d has_instance=%d", qmgrCount, instanceCount, placementCount)
	}

	var logicalKey string
	if err := repo.pool.QueryRow(ctx, `SELECT logical_key FROM canonical_entity WHERE environment=$1 AND entity_type='mq.queue_manager'`, env).Scan(&logicalKey); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(logicalKey, "qmid=qmid-1234567890") {
		t.Fatalf("expected preferred identity to upgrade to QMID, got %q", logicalKey)
	}
}

func TestStrongIdentityMismatchDoesNotSilentlyMerge(t *testing.T) {
	repo, reg := openReconciliationTestRepository(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	env := "ci-identity-mismatch-" + now.Format("150405.000000000")

	first := mqPlacementBundle(env, "mismatch-a-"+now.Format("150405.000000000"), "host-a", "QM_REUSED", map[string]interface{}{
		"qmid": "QMID-OLD",
		"name": "QM_REUSED",
	}, now)
	if _, err := repo.IngestBundle(ctx, first, reg); err != nil {
		t.Fatal(err)
	}
	second := mqPlacementBundle(env, "mismatch-b-"+now.Format("150405.000000000"), "host-b", "QM_REUSED", map[string]interface{}{
		"qmid": "QMID-NEW",
		"name": "QM_REUSED",
	}, now.Add(time.Second))
	if _, err := repo.IngestBundle(ctx, second, reg); err != nil {
		t.Fatal(err)
	}

	var qmgrCount int
	if err := repo.pool.QueryRow(ctx, `SELECT count(*) FROM canonical_entity WHERE environment=$1 AND entity_type='mq.queue_manager'`, env).Scan(&qmgrCount); err != nil {
		t.Fatal(err)
	}
	if qmgrCount != 2 {
		t.Fatalf("different QMIDs sharing a display name must remain distinct; got %d queue managers", qmgrCount)
	}

	third := domain.ObservationBundle{
		SchemaVersion: domain.ObservationBundleSchema,
		Run: domain.Run{RunID: "mismatch-c-" + now.Format("150405.000000000"), Environment: env, Collector: "mq-test", CompletedAt: now.Add(2 * time.Second), Source: domain.SourceRef{Kind: "mq_peer", ID: "peer-c"}},
		Entities: []domain.EntityObservation{{
			Ref: "qm", SemanticType: "mq.queue_manager", Identity: domain.Identity{Hints: map[string]interface{}{"name": "QM_REUSED"}}, DisplayName: "QM_REUSED",
			ObservedAt: now.Add(2 * time.Second), EvidenceClass: domain.EvidenceConfigured, Properties: map[string]interface{}{},
		}},
		Coverage: []domain.Coverage{}, Relations: []domain.RelationObservation{}, UnresolvedReferences: []domain.UnresolvedReference{},
	}
	result, err := repo.IngestBundle(ctx, third, reg)
	if err != nil {
		t.Fatal(err)
	}
	if result.IdentityConflicts != 1 {
		t.Fatalf("expected name-only observation to become an explicit identity conflict, got %#v", result)
	}
	var openConflicts int
	if err := repo.pool.QueryRow(ctx, `SELECT count(*) FROM identity_conflict WHERE environment=$1 AND state='OPEN'`, env).Scan(&openConflicts); err != nil {
		t.Fatal(err)
	}
	if openConflicts != 1 {
		t.Fatalf("expected one open identity conflict, got %d", openConflicts)
	}
}

func TestCompleteCoverageClosesAbsentAssertions(t *testing.T) {
	repo, reg := openReconciliationTestRepository(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	env := "ci-coverage-" + now.Format("150405.000000000")
	source := domain.SourceRef{Kind: "mq_host", ID: "host-coverage"}

	first := queueCoverageBundle(env, "coverage-1-"+now.Format("150405.000000000"), source, now, []string{"Q1", "Q2"})
	firstResult, err := repo.IngestBundle(ctx, first, reg)
	if err != nil {
		t.Fatal(err)
	}
	second := queueCoverageBundle(env, "coverage-2-"+now.Format("150405.000000000"), source, now.Add(time.Minute), []string{"Q1"})
	secondResult, err := repo.IngestBundle(ctx, second, reg)
	if err != nil {
		t.Fatal(err)
	}
	if firstResult.TopologyRevisionID == secondResult.TopologyRevisionID || !secondResult.TopologyChanged {
		t.Fatalf("expected topology revision after complete-coverage removal: first=%#v second=%#v", firstResult, secondResult)
	}
	if secondResult.AssertionsClosed < 2 {
		t.Fatalf("expected prior Q1 assertion to be superseded and absent Q2 assertion to close, got %#v", secondResult)
	}

	var activeQ1, activeQ2 int
	if err := repo.pool.QueryRow(ctx, `
		SELECT count(*) FROM semantic_assertion a
		JOIN canonical_entity e ON e.entity_id=a.entity_id
		WHERE e.environment=$1 AND e.entity_type='mq.queue' AND e.display_name='Q1' AND a.valid_to IS NULL`, env).Scan(&activeQ1); err != nil {
		t.Fatal(err)
	}
	if err := repo.pool.QueryRow(ctx, `
		SELECT count(*) FROM semantic_assertion a
		JOIN canonical_entity e ON e.entity_id=a.entity_id
		WHERE e.environment=$1 AND e.entity_type='mq.queue' AND e.display_name='Q2' AND a.valid_to IS NULL`, env).Scan(&activeQ2); err != nil {
		t.Fatal(err)
	}
	if activeQ1 != 1 || activeQ2 != 0 {
		t.Fatalf("unexpected active assertions: Q1=%d Q2=%d", activeQ1, activeQ2)
	}

	items, err := repo.ListEntities(ctx, env, "mq.queue", "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].DisplayName != "Q1" {
		t.Fatalf("current entity projection must exclude closed Q2, got %#v", items)
	}
}

func mqPlacementBundle(environment, runID, hostName, qmgrName string, qmgrHints map[string]interface{}, observedAt time.Time) domain.ObservationBundle {
	hostRef := "host:" + hostName
	qmgrRef := "qmgr:" + qmgrName
	instanceRef := "qmi:" + hostName
	return domain.ObservationBundle{
		SchemaVersion: domain.ObservationBundleSchema,
		Run: domain.Run{RunID: runID, Environment: environment, Collector: "mq-test", CompletedAt: observedAt, Source: domain.SourceRef{Kind: "mq_host", ID: hostName}},
		Coverage: []domain.Coverage{{ScopeType: "source", ScopeKey: hostName, ObjectClass: "mq.queue_manager_instance", Mode: "complete"}},
		Entities: []domain.EntityObservation{
			{Ref: hostRef, SemanticType: "infra.host", Identity: domain.Identity{Hints: map[string]interface{}{"name": hostName}}, DisplayName: hostName, ObservedAt: observedAt, EvidenceClass: domain.EvidenceObserved, Properties: map[string]interface{}{}},
			{Ref: qmgrRef, SemanticType: "mq.queue_manager", Identity: domain.Identity{Hints: qmgrHints}, DisplayName: qmgrName, Status: "RUNNING", ObservedAt: observedAt, EvidenceClass: domain.EvidenceObserved, Properties: map[string]interface{}{}},
			{Ref: instanceRef, SemanticType: "mq.queue_manager_instance", Identity: domain.Identity{Hints: map[string]interface{}{"queue_manager_key": strings.ToLower(qmgrName), "host_key": hostName}}, DisplayName: qmgrName + " @ " + hostName, Status: "RUNNING", ObservedAt: observedAt, EvidenceClass: domain.EvidenceObserved, Properties: map[string]interface{}{"runtime_role": "active"}},
		},
		Relations: []domain.RelationObservation{
			{Ref: "has-instance:" + hostName, SemanticType: "has_instance", SourceRef: qmgrRef, TargetRef: instanceRef, ObservedAt: observedAt, EvidenceClass: domain.EvidenceObserved, Properties: map[string]interface{}{}},
			{Ref: "runs-on:" + hostName, SemanticType: "runs_on", SourceRef: instanceRef, TargetRef: hostRef, ObservedAt: observedAt, EvidenceClass: domain.EvidenceObserved, Properties: map[string]interface{}{}},
		},
		UnresolvedReferences: []domain.UnresolvedReference{},
	}
}

func queueCoverageBundle(environment, runID string, source domain.SourceRef, observedAt time.Time, queues []string) domain.ObservationBundle {
	bundle := domain.ObservationBundle{
		SchemaVersion: domain.ObservationBundleSchema,
		Run:           domain.Run{RunID: runID, Environment: environment, Collector: "coverage-test", CompletedAt: observedAt, Source: source},
		Coverage:      []domain.Coverage{{ScopeType: "source", ScopeKey: source.ID, ObjectClass: "mq.queue", Mode: "complete"}},
		Entities:      []domain.EntityObservation{},
		Relations:     []domain.RelationObservation{},
	}
	for _, q := range queues {
		bundle.Entities = append(bundle.Entities, domain.EntityObservation{
			Ref: q, SemanticType: "mq.queue", Identity: domain.Identity{Hints: map[string]interface{}{"canonical_key": "qm|" + strings.ToLower(q)}},
			DisplayName: q, ObservedAt: observedAt, EvidenceClass: domain.EvidenceConfigured, Properties: map[string]interface{}{"queue_type": "QLOCAL"},
		})
	}
	return bundle
}
