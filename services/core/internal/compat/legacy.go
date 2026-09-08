package compat

import (
	"fmt"
	"strings"
	"time"

	"github.com/alajmah/mw-dashboard-core/internal/domain"
)

type LegacyDiscovery struct {
	Collector         string   `json:"collector"`
	CollectorVersion  string   `json:"collector_version,omitempty"`
	NormalizerVersion string   `json:"normalizer_version,omitempty"`
	StartedAt         string   `json:"started_at,omitempty"`
	CompletedAt       string   `json:"completed_at,omitempty"`
	SourceHost        string   `json:"source_host,omitempty"`
	Notes             []string `json:"notes,omitempty"`
}

type LegacyNode struct {
	ID          string                 `json:"id"`
	Type        string                 `json:"type"`
	Name        string                 `json:"name"`
	Environment string                 `json:"environment,omitempty"`
	Scope       string                 `json:"scope,omitempty"`
	Status      string                 `json:"status,omitempty"`
	Metadata    map[string]interface{} `json:"metadata,omitempty"`
}

type LegacyEdge struct {
	ID                 string                 `json:"id"`
	Source             string                 `json:"source"`
	Relationship       string                 `json:"relationship"`
	Target             string                 `json:"target"`
	RelationshipSource domain.EvidenceClass   `json:"relationship_source"`
	Confidence         float64                `json:"confidence,omitempty"`
	Evidence           string                 `json:"evidence,omitempty"`
	Metadata           map[string]interface{} `json:"metadata,omitempty"`
}

type LegacyTopology struct {
	SchemaVersion string          `json:"schema_version"`
	SnapshotID    string          `json:"snapshot_id"`
	CreatedAt     string          `json:"created_at"`
	Environment   string          `json:"environment"`
	Discovery     LegacyDiscovery `json:"discovery"`
	Nodes         []LegacyNode    `json:"nodes"`
	Edges         []LegacyEdge    `json:"edges"`
}

var entityTypeMap = map[string]string{
	"host":        "infra.host",
	"endpoint":    "infra.network_endpoint",
	"qmgr":        "mq.queue_manager",
	"queue":       "mq.queue",
	"channel":     "mq.channel",
	"listener":    "mq.listener",
	"application": "app.application_instance",
	"mq_process":  "mq.runtime_process",
}

var relationshipMap = map[string]string{
	"OWNS":              "contains",
	"CONNECTS_VIA":      "runtime.connects_via",
	"PUTS_TO":           "runtime.opens_for_output",
	"GETS_FROM":         "runtime.opens_for_input",
	"ALIASES_TO":        "routing.resolves_to",
	"ROUTES_TO":         "routing.routes_via",
	"TRANSMITS_VIA":     "routing.transmits_via",
	"CONNECTS_TO":       "network.connects_to",
	"USES_ENDPOINT":     "network.uses_endpoint",
	"ENDPOINT_FOR":      "network.endpoint_for",
	"LISTENS_ON":        "network.listens_on",
	"DRIVES_CHANNEL":    "runtime.drives_channel",
	"RUNS_PROCESS":      "runtime.runs_process",
	"CLUSTER_DISCOVERS": "mq.cluster_discovers",
}

func parseTime(value string, fallback time.Time) time.Time {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	if t, err := time.Parse(time.RFC3339, value); err == nil {
		return t
	}
	return fallback
}

func stringMeta(m map[string]interface{}, key string) string {
	if m == nil {
		return ""
	}
	v, ok := m[key]
	if !ok || v == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(v))
}

func hintsForNode(n LegacyNode) map[string]interface{} {
	hints := map[string]interface{}{
		"legacy_id": n.ID,
		"name":      n.Name,
	}
	switch n.Type {
	case "host":
		if v := stringMeta(n.Metadata, "fqdn"); v != "" {
			hints["fqdn"] = v
		}
		if v := stringMeta(n.Metadata, "ip"); v != "" {
			hints["primary_ip"] = v
		}
	case "endpoint":
		if v := stringMeta(n.Metadata, "host"); v != "" {
			hints["host"] = v
		}
		if v := stringMeta(n.Metadata, "port"); v != "" {
			hints["port"] = v
		}
		if v := stringMeta(n.Metadata, "raw_conname"); v != "" {
			hints["raw"] = v
		}
	case "qmgr":
		if v := stringMeta(n.Metadata, "qmid"); v != "" {
			hints["qmid"] = v
		}
		hints["canonical_key"] = strings.ToLower(n.Name)
	case "queue", "channel", "listener":
		hints["queue_manager_key"] = strings.ToLower(n.Scope)
		hints["canonical_key"] = strings.ToLower(n.Scope + "|" + n.Name)
	case "application":
		hints["canonical_key"] = n.ID
	case "mq_process":
		hints["queue_manager_key"] = strings.ToLower(n.Scope)
		if v := stringMeta(n.Metadata, "pids"); v != "" {
			hints["pid"] = v
		}
		hints["canonical_key"] = n.ID
	}
	return hints
}

func copyMap(src map[string]interface{}) map[string]interface{} {
	out := make(map[string]interface{}, len(src)+2)
	for k, v := range src {
		out[k] = v
	}
	return out
}

func evidenceClass(v domain.EvidenceClass) domain.EvidenceClass {
	switch v {
	case domain.EvidenceObserved, domain.EvidenceConfigured, domain.EvidenceDeclared, domain.EvidenceInferred:
		return v
	default:
		return domain.EvidenceInferred
	}
}

func ConvertLegacyTopology(input LegacyTopology, now time.Time) (domain.ObservationBundle, error) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	createdAt := parseTime(input.CreatedAt, now)
	completedAt := parseTime(input.Discovery.CompletedAt, createdAt)
	startedAt := parseTime(input.Discovery.StartedAt, time.Time{})
	env := strings.TrimSpace(input.Environment)
	if env == "" {
		env = "default"
	}
	runID := strings.TrimSpace(input.SnapshotID)
	if runID == "" {
		return domain.ObservationBundle{}, fmt.Errorf("legacy topology requires snapshot_id")
	}
	collector := strings.TrimSpace(input.Discovery.Collector)
	if collector == "" {
		collector = "legacy-topology-v1"
	}
	bundle := domain.ObservationBundle{
		SchemaVersion: domain.ObservationBundleSchema,
		Run: domain.Run{
			RunID:             "legacy:" + runID,
			Environment:       env,
			Collector:         collector,
			CollectorVersion:  input.Discovery.CollectorVersion,
			NormalizerVersion: input.Discovery.NormalizerVersion,
			CompletedAt:       completedAt,
			Source:            domain.SourceRef{Kind: "legacy_snapshot", ID: runID, DisplayName: input.Discovery.SourceHost},
			Metadata: map[string]interface{}{
				"legacy_schema_version": input.SchemaVersion,
				"legacy_snapshot_id":    runID,
				"compatibility_adapter": "topology-v1-to-observation-v2",
			},
		},
		Coverage:             []domain.Coverage{},
		Entities:             []domain.EntityObservation{},
		Relations:            []domain.RelationObservation{},
		UnresolvedReferences: []domain.UnresolvedReference{},
	}
	if !startedAt.IsZero() {
		bundle.Run.StartedAt = &startedAt
	}

	legacyByID := make(map[string]LegacyNode, len(input.Nodes))
	semanticTypeByRef := make(map[string]string, len(input.Nodes))
	logicalAppRefByName := map[string]string{}
	for _, n := range input.Nodes {
		semanticType, ok := entityTypeMap[n.Type]
		if !ok {
			return domain.ObservationBundle{}, fmt.Errorf("unsupported legacy node type %q", n.Type)
		}
		legacyByID[n.ID] = n
		semanticTypeByRef[n.ID] = semanticType
		props := copyMap(n.Metadata)
		props["legacy_type"] = n.Type
		props["legacy_scope"] = n.Scope
		bundle.Entities = append(bundle.Entities, domain.EntityObservation{
			Ref:           n.ID,
			SemanticType:  semanticType,
			Identity:      domain.Identity{Hints: hintsForNode(n)},
			DisplayName:   n.Name,
			Status:        n.Status,
			ObservedAt:    createdAt,
			EvidenceClass: domain.EvidenceConfigured,
			EvidenceRef:   "legacy-node:" + n.ID,
			Properties:    props,
		})
		if n.Type == "application" {
			key := strings.ToLower(strings.TrimSpace(n.Name))
			logicalRef, exists := logicalAppRefByName[key]
			if !exists {
				logicalRef = "logical-app:" + key
				logicalAppRefByName[key] = logicalRef
				semanticTypeByRef[logicalRef] = "app.application"
				bundle.Entities = append(bundle.Entities, domain.EntityObservation{
					Ref:          logicalRef,
					SemanticType: "app.application",
					Identity: domain.Identity{Hints: map[string]interface{}{
						"canonical_key": key,
						"name":          n.Name,
					}},
					DisplayName:   n.Name,
					ObservedAt:    createdAt,
					EvidenceClass: domain.EvidenceInferred,
					EvidenceRef:   "legacy-logical-application-grouping",
					Properties: map[string]interface{}{
						"derivation_method": "group_legacy_application_instances_by_name",
					},
				})
			}
			deterministic := true
			bundle.Relations = append(bundle.Relations, domain.RelationObservation{
				Ref:              "logical-app-instance:" + n.ID,
				SemanticType:     "has_instance",
				SourceRef:        logicalRef,
				TargetRef:        n.ID,
				ObservedAt:       createdAt,
				EvidenceClass:    domain.EvidenceInferred,
				EvidenceRef:      "legacy-logical-application-grouping",
				DerivationMethod: "group_legacy_application_instances_by_name",
				Deterministic:    &deterministic,
				Properties:       map[string]interface{}{},
			})
		}
	}

	bundle.Coverage = append(bundle.Coverage,
		domain.Coverage{ScopeType: "source", ScopeKey: input.Discovery.SourceHost, ObjectClass: "legacy.normalized_topology", Mode: "complete"},
		domain.Coverage{ScopeType: "source", ScopeKey: input.Discovery.SourceHost, ObjectClass: "mq.runtime", Mode: "point_in_time"},
	)

	seenInputAccess := map[string]struct{}{}
	for _, e := range input.Edges {
		src, srcOK := legacyByID[e.Source]
		dst, dstOK := legacyByID[e.Target]
		if !srcOK || !dstOK {
			return domain.ObservationBundle{}, fmt.Errorf("legacy edge %q is dangling", e.ID)
		}
		ev := evidenceClass(e.RelationshipSource)
		props := copyMap(e.Metadata)
		props["legacy_relationship"] = e.Relationship
		if e.Confidence != 0 {
			props["legacy_confidence"] = e.Confidence
		}

		if e.Relationship == "HOSTS" {
			switch dst.Type {
			case "qmgr":
				instanceRef := "qmgr-instance:" + dst.ID + ":" + src.ID
				if _, exists := semanticTypeByRef[instanceRef]; !exists {
					role := "unknown"
					status := strings.ToUpper(strings.TrimSpace(dst.Status))
					if status == "RUNNING" || status == "ACTIVE" {
						role = "active"
					} else if strings.Contains(status, "ELSEWHERE") || status == "STANDBY" {
						role = "standby"
					}
					semanticTypeByRef[instanceRef] = "mq.queue_manager_instance"
					bundle.Entities = append(bundle.Entities, domain.EntityObservation{
						Ref:          instanceRef,
						SemanticType: "mq.queue_manager_instance",
						Identity: domain.Identity{Hints: map[string]interface{}{
							"canonical_key":     strings.ToLower(dst.Name + "|" + src.ID),
							"queue_manager_key": strings.ToLower(dst.Name),
							"host_key":          src.ID,
						}},
						DisplayName:   dst.Name + " @ " + src.Name,
						Status:        dst.Status,
						ObservedAt:    createdAt,
						EvidenceClass: ev,
						EvidenceRef:   e.Evidence,
						Properties: map[string]interface{}{
							"runtime_role":       role,
							"legacy_synthesized": true,
						},
					})
				}
				bundle.Relations = append(bundle.Relations,
					domain.RelationObservation{Ref: e.ID + ":instance", SemanticType: "has_instance", SourceRef: dst.ID, TargetRef: instanceRef, ObservedAt: createdAt, EvidenceClass: ev, EvidenceRef: e.Evidence, Properties: props},
					domain.RelationObservation{Ref: e.ID + ":placement", SemanticType: "runs_on", SourceRef: instanceRef, TargetRef: src.ID, ObservedAt: createdAt, EvidenceClass: ev, EvidenceRef: e.Evidence, Properties: props},
				)
			case "application", "mq_process":
				bundle.Relations = append(bundle.Relations, domain.RelationObservation{Ref: e.ID, SemanticType: "runs_on", SourceRef: dst.ID, TargetRef: src.ID, ObservedAt: createdAt, EvidenceClass: ev, EvidenceRef: e.Evidence, Properties: props})
			}
			continue
		}

		if e.Relationship == "CONSUMED_BY" {
			key := e.Target + "|" + e.Source
			if _, exists := seenInputAccess[key]; exists {
				continue
			}
			seenInputAccess[key] = struct{}{}
			bundle.Relations = append(bundle.Relations, domain.RelationObservation{Ref: e.ID, SemanticType: "runtime.opens_for_input", SourceRef: e.Target, TargetRef: e.Source, ObservedAt: createdAt, EvidenceClass: ev, EvidenceRef: e.Evidence, Properties: props})
			continue
		}

		mapped, ok := relationshipMap[e.Relationship]
		if !ok {
			return domain.ObservationBundle{}, fmt.Errorf("unsupported legacy relationship %q", e.Relationship)
		}
		if mapped == "runtime.opens_for_input" {
			key := e.Source + "|" + e.Target
			if _, exists := seenInputAccess[key]; exists {
				continue
			}
			seenInputAccess[key] = struct{}{}
		}
		bundle.Relations = append(bundle.Relations, domain.RelationObservation{
			Ref:           e.ID,
			SemanticType:  mapped,
			SourceRef:     e.Source,
			TargetRef:     e.Target,
			ObservedAt:    createdAt,
			EvidenceClass: ev,
			EvidenceRef:   e.Evidence,
			Properties:    props,
		})
	}
	return bundle, nil
}
