package postgres

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/alajmah/mw-dashboard-core/internal/domain"
	"github.com/alajmah/mw-dashboard-core/registry"
)

func TestIngestBundleRoundTrip(t *testing.T) {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not configured")
	}
	ctx := context.Background()
	repo, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	reg, err := registry.LoadDefault()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	runID := "test-ingest-" + now.Format("20060102T150405.000000000")
	bundle := domain.ObservationBundle{
		SchemaVersion: domain.ObservationBundleSchema,
		Run: domain.Run{
			RunID:       runID,
			Environment: "ci",
			Collector:   "unit-test",
			CompletedAt: now,
			Source:      domain.SourceRef{Kind: "test", ID: "source-1"},
		},
		Coverage: []domain.Coverage{{ScopeType: "source", ScopeKey: "source-1", ObjectClass: "mq.queue", Mode: "complete"}},
		Entities: []domain.EntityObservation{
			{Ref: "qm", SemanticType: "mq.queue_manager", Identity: domain.Identity{Hints: map[string]interface{}{"canonical_key": "qm1"}}, DisplayName: "QM1", ObservedAt: now, EvidenceClass: domain.EvidenceConfigured, Properties: map[string]interface{}{}},
			{Ref: "q", SemanticType: "mq.queue", Identity: domain.Identity{Hints: map[string]interface{}{"canonical_key": "qm1|q1"}}, DisplayName: "Q1", ObservedAt: now, EvidenceClass: domain.EvidenceConfigured, Properties: map[string]interface{}{"queue_type": "QLOCAL"}},
		},
		Relations: []domain.RelationObservation{
			{Ref: "owns", SemanticType: "contains", SourceRef: "qm", TargetRef: "q", ObservedAt: now, EvidenceClass: domain.EvidenceConfigured, Properties: map[string]interface{}{}},
		},
		UnresolvedReferences: []domain.UnresolvedReference{},
	}
	result, err := repo.IngestBundle(ctx, bundle, reg)
	if err != nil {
		t.Fatal(err)
	}
	if result.CanonicalEntities != 2 || result.CanonicalRelations != 1 {
		t.Fatalf("unexpected result: %#v", result)
	}
	replay, err := repo.IngestBundle(ctx, bundle, reg)
	if err != nil {
		t.Fatal(err)
	}
	if !replay.IdempotentReplay {
		t.Fatal("expected idempotent replay")
	}
	items, err := repo.ListEntities(ctx, "ci", "mq.queue", "Q1", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) == 0 {
		t.Fatal("expected queue entity")
	}
}
