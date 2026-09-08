package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/alajmah/mw-dashboard-core/internal/domain"
	"github.com/alajmah/mw-dashboard-core/registry"
)

type fakeRepo struct {
	bundle domain.ObservationBundle
}

func (f *fakeRepo) Ping(context.Context) error { return nil }
func (f *fakeRepo) IngestBundle(_ context.Context, b domain.ObservationBundle, _ *registry.Registry) (domain.IngestResult, error) {
	f.bundle = b
	return domain.IngestResult{RunID: b.Run.RunID, EntityObservations: len(b.Entities), RelationObservations: len(b.Relations)}, nil
}
func (f *fakeRepo) ListEntities(context.Context, string, string, string, int) ([]domain.EntitySummary, error) {
	return []domain.EntitySummary{}, nil
}

func TestLegacyEndpointRequiresTokenAndCorrectsPUTSemantics(t *testing.T) {
	reg, err := registry.LoadDefault()
	if err != nil {
		t.Fatal(err)
	}
	repo := &fakeRepo{}
	s := New(repo, reg, "secret")
	payload := `{
	  "schema_version":"1.0",
	  "snapshot_id":"snap-test",
	  "created_at":"2026-09-08T10:00:00Z",
	  "environment":"prod",
	  "discovery":{"collector":"mq","completed_at":"2026-09-08T10:00:00Z","source_host":"h1"},
	  "nodes":[
	    {"id":"a","type":"application","name":"App","scope":"host:h"},
	    {"id":"q","type":"queue","name":"Q1","scope":"QM1"}
	  ],
	  "edges":[{"id":"e","source":"a","relationship":"PUTS_TO","target":"q","relationship_source":"observed","confidence":1}]
	}`

	req := httptest.NewRequest(http.MethodPost, "/v2/compat/topology", strings.NewReader(payload))
	res := httptest.NewRecorder()
	s.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", res.Code)
	}

	req = httptest.NewRequest(http.MethodPost, "/v2/compat/topology", strings.NewReader(payload))
	req.Header.Set("Authorization", "Bearer secret")
	res = httptest.NewRecorder()
	s.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", res.Code, res.Body.String())
	}
	if len(repo.bundle.Relations) == 0 || repo.bundle.Relations[len(repo.bundle.Relations)-1].SemanticType != "runtime.opens_for_output" {
		b, _ := json.Marshal(repo.bundle.Relations)
		t.Fatalf("expected runtime.opens_for_output conversion, got %s", b)
	}
}
