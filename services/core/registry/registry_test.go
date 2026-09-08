package registry

import (
	"testing"
	"time"

	"github.com/alajmah/mw-dashboard-core/internal/domain"
)

func TestDefaultRegistryLoadsAndResolvesIdentity(t *testing.T) {
	r, err := LoadDefault()
	if err != nil {
		t.Fatal(err)
	}
	key, err := r.ResolveLogicalKey("mq.queue", map[string]interface{}{
		"queue_manager_key": "QM1",
		"name":              "APP.REQUEST",
	})
	if err != nil {
		t.Fatal(err)
	}
	if key == "" {
		t.Fatal("expected non-empty logical key")
	}
	if err := r.ValidateRelation("runtime.opens_for_output", "app.application_instance", "mq.queue", domain.EvidenceObserved); err != nil {
		t.Fatalf("expected relation to validate: %v", err)
	}
}

func TestBundleRejectsActivityWithoutObservedEvidence(t *testing.T) {
	r, err := LoadDefault()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	b := domain.ObservationBundle{
		SchemaVersion: domain.ObservationBundleSchema,
		Run: domain.Run{RunID: "r1", Environment: "prod", Collector: "test", CompletedAt: now, Source: domain.SourceRef{Kind: "test", ID: "x"}},
		Entities: []domain.EntityObservation{
			{Ref: "a", SemanticType: "app.application_instance", Identity: domain.Identity{Hints: map[string]interface{}{"canonical_key": "a"}}, DisplayName: "A", ObservedAt: now, EvidenceClass: domain.EvidenceObserved, Properties: map[string]interface{}{}},
			{Ref: "q", SemanticType: "mq.queue", Identity: domain.Identity{Hints: map[string]interface{}{"canonical_key": "qm|q"}}, DisplayName: "Q", ObservedAt: now, EvidenceClass: domain.EvidenceConfigured, Properties: map[string]interface{}{}},
		},
		Relations: []domain.RelationObservation{
			{Ref: "r", SemanticType: "activity.put_observed", SourceRef: "a", TargetRef: "q", ObservedAt: now, EvidenceClass: domain.EvidenceConfigured, Properties: map[string]interface{}{}},
		},
		Coverage:             []domain.Coverage{},
		UnresolvedReferences: []domain.UnresolvedReference{},
	}
	if err := r.ValidateBundle(b); err == nil {
		t.Fatal("expected configured activity evidence to be rejected")
	}
}
