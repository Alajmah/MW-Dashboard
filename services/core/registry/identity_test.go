package registry

import "testing"

func TestResolveIdentityCandidatesPrefersNativeImmutableID(t *testing.T) {
	reg, err := LoadDefault()
	if err != nil {
		t.Fatal(err)
	}
	candidates, err := reg.ResolveIdentityCandidates("mq.queue_manager", map[string]interface{}{
		"canonical_key": "qm1",
		"qmid":          "QMID-123",
		"name":          "QM1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) < 3 {
		t.Fatalf("expected multiple usable identity candidates, got %#v", candidates)
	}
	if candidates[0].Fields["qmid"] != "qmid-123" {
		t.Fatalf("expected QMID to be preferred, got %#v", candidates[0])
	}
}

func TestResolveIdentityCandidatesKeepsCompositeIdentityAtomic(t *testing.T) {
	reg, err := LoadDefault()
	if err != nil {
		t.Fatal(err)
	}
	candidates, err := reg.ResolveIdentityCandidates("mq.queue", map[string]interface{}{
		"queue_manager_key": "QM1",
		"name":              "APP.REQUEST",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 1 {
		t.Fatalf("expected one composite queue identity, got %#v", candidates)
	}
	if candidates[0].Fields["queue_manager_key"] != "qm1" || candidates[0].Fields["name"] != "app.request" {
		t.Fatalf("unexpected composite identity fields: %#v", candidates[0].Fields)
	}
}
