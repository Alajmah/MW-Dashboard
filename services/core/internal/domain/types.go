package domain

import "time"

const ObservationBundleSchema = "osi.observation.bundle/v2"

type EvidenceClass string

const (
	EvidenceObserved   EvidenceClass = "observed"
	EvidenceConfigured EvidenceClass = "configured"
	EvidenceDeclared   EvidenceClass = "declared"
	EvidenceInferred   EvidenceClass = "inferred"
)

type ArtifactRef struct {
	URI       string `json:"uri,omitempty"`
	SHA256    string `json:"sha256,omitempty"`
	MediaType string `json:"media_type,omitempty"`
	SizeBytes int64  `json:"size_bytes,omitempty"`
}

type SourceRef struct {
	Kind        string `json:"kind"`
	ID          string `json:"id"`
	DisplayName string `json:"display_name,omitempty"`
}

type Run struct {
	RunID             string                 `json:"run_id"`
	Environment       string                 `json:"environment"`
	Collector         string                 `json:"collector"`
	CollectorVersion  string                 `json:"collector_version,omitempty"`
	NormalizerVersion string                 `json:"normalizer_version,omitempty"`
	StartedAt         *time.Time             `json:"started_at,omitempty"`
	CompletedAt       time.Time              `json:"completed_at"`
	Source            SourceRef              `json:"source"`
	Artifact          *ArtifactRef           `json:"artifact,omitempty"`
	Metadata          map[string]interface{} `json:"metadata,omitempty"`
}

type Coverage struct {
	ScopeType   string                 `json:"scope_type"`
	ScopeKey    string                 `json:"scope_key"`
	ObjectClass string                 `json:"object_class"`
	Mode        string                 `json:"mode"`
	EvidenceRef string                 `json:"evidence_ref,omitempty"`
	Error       string                 `json:"error,omitempty"`
	Properties  map[string]interface{} `json:"properties,omitempty"`
}

type Identity struct {
	Hints map[string]interface{} `json:"hints"`
}

type EntityObservation struct {
	Ref           string                 `json:"ref"`
	SemanticType  string                 `json:"semantic_type"`
	Identity      Identity               `json:"identity"`
	DisplayName   string                 `json:"display_name"`
	Status        string                 `json:"status,omitempty"`
	ObservedAt    time.Time              `json:"observed_at"`
	EvidenceClass EvidenceClass          `json:"evidence_class"`
	EvidenceRef   string                 `json:"evidence_ref,omitempty"`
	Properties    map[string]interface{} `json:"properties"`
}

type RelationObservation struct {
	Ref              string                 `json:"ref"`
	SemanticType     string                 `json:"semantic_type"`
	SourceRef        string                 `json:"source_ref"`
	TargetRef        string                 `json:"target_ref"`
	ObservedAt       time.Time              `json:"observed_at"`
	EvidenceClass    EvidenceClass          `json:"evidence_class"`
	EvidenceRef      string                 `json:"evidence_ref,omitempty"`
	DerivationMethod string                 `json:"derivation_method,omitempty"`
	Deterministic    *bool                  `json:"deterministic,omitempty"`
	Confidence       *float64               `json:"confidence,omitempty"`
	Properties       map[string]interface{} `json:"properties"`
}

type UnresolvedReference struct {
	Ref                string                 `json:"ref"`
	SourceRef          string                 `json:"source_ref"`
	SemanticType       string                 `json:"semantic_type"`
	ExpectedTargetType string                 `json:"expected_target_type"`
	VendorValue        string                 `json:"vendor_value"`
	State              string                 `json:"state"`
	Reason             string                 `json:"reason"`
	CandidateRefs      []string               `json:"candidate_refs,omitempty"`
	ObservedAt         time.Time              `json:"observed_at"`
	EvidenceClass      EvidenceClass          `json:"evidence_class"`
	EvidenceRef        string                 `json:"evidence_ref,omitempty"`
	Properties         map[string]interface{} `json:"properties"`
}

type ObservationBundle struct {
	SchemaVersion        string                `json:"schema_version"`
	Run                  Run                   `json:"run"`
	Coverage             []Coverage            `json:"coverage"`
	Entities             []EntityObservation   `json:"entities"`
	Relations            []RelationObservation `json:"relations"`
	UnresolvedReferences []UnresolvedReference `json:"unresolved_references"`
}

type IngestResult struct {
	RunID                 string `json:"run_id"`
	EntityObservations    int    `json:"entity_observations"`
	RelationObservations  int    `json:"relation_observations"`
	UnresolvedReferences int    `json:"unresolved_references"`
	CanonicalEntities     int    `json:"canonical_entities_touched"`
	CanonicalRelations    int    `json:"canonical_relations_touched"`
	IdempotentReplay      bool   `json:"idempotent_replay"`
}

type EntitySummary struct {
	ID          string                 `json:"id"`
	Type        string                 `json:"type"`
	Environment string                 `json:"environment"`
	LogicalKey  string                 `json:"logical_key"`
	DisplayName string                 `json:"display_name"`
	Status      string                 `json:"status,omitempty"`
	Attributes  map[string]interface{} `json:"attributes"`
	FirstSeenAt time.Time              `json:"first_seen_at"`
	LastSeenAt  time.Time              `json:"last_seen_at"`
}
