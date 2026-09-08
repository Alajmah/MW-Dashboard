package compat

import (
	"testing"
	"time"

	"github.com/alajmah/mw-dashboard-core/internal/domain"
	"github.com/alajmah/mw-dashboard-core/registry"
)

func TestLegacyQueueHandlesBecomeRuntimeAccessNotMessageActivity(t *testing.T) {
	now := time.Date(2026, 9, 8, 10, 0, 0, 0, time.UTC)
	legacy := LegacyTopology{
		SchemaVersion: "1.0",
		SnapshotID:    "snap1",
		CreatedAt:     now.Format(time.RFC3339),
		Environment:   "prod",
		Discovery:     LegacyDiscovery{Collector: "mq", SourceHost: "host1", CompletedAt: now.Format(time.RFC3339)},
		Nodes: []LegacyNode{
			{ID: "h", Type: "host", Name: "host1", Metadata: map[string]interface{}{"ip": "10.0.0.1"}},
			{ID: "qm", Type: "qmgr", Name: "QM1", Status: "RUNNING", Metadata: map[string]interface{}{"qmid": "QMID1"}},
			{ID: "a", Type: "application", Name: "AppA", Scope: "host:h"},
			{ID: "q", Type: "queue", Name: "Q1", Scope: "QM1"},
		},
		Edges: []LegacyEdge{
			{ID: "hostqm", Source: "h", Relationship: "HOSTS", Target: "qm", RelationshipSource: domain.EvidenceConfigured},
			{ID: "put", Source: "a", Relationship: "PUTS_TO", Target: "q", RelationshipSource: domain.EvidenceObserved},
			{ID: "get", Source: "a", Relationship: "GETS_FROM", Target: "q", RelationshipSource: domain.EvidenceObserved},
			{ID: "consumed", Source: "q", Relationship: "CONSUMED_BY", Target: "a", RelationshipSource: domain.EvidenceObserved},
		},
	}
	bundle, err := ConvertLegacyTopology(legacy, now)
	if err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, rel := range bundle.Relations {
		counts[rel.SemanticType]++
		if rel.SemanticType == "activity.put_observed" || rel.SemanticType == "activity.get_observed" {
			t.Fatalf("legacy handle evidence must not become message activity: %#v", rel)
		}
	}
	if counts["runtime.opens_for_output"] != 1 {
		t.Fatalf("expected one output-access relation, got %d", counts["runtime.opens_for_output"])
	}
	if counts["runtime.opens_for_input"] != 1 {
		t.Fatalf("expected one deduplicated input-access relation, got %d", counts["runtime.opens_for_input"])
	}
	if counts["has_instance"] < 2 {
		t.Fatalf("expected synthesized instance relations, got %#v", counts)
	}
	if counts["runs_on"] != 1 {
		t.Fatalf("expected qmgr instance placement relation, got %d", counts["runs_on"])
	}
	reg, err := registry.LoadDefault()
	if err != nil {
		t.Fatal(err)
	}
	if err := reg.ValidateBundle(bundle); err != nil {
		t.Fatalf("converted bundle must validate: %v", err)
	}
}
