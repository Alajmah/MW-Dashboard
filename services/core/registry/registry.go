package registry

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/alajmah/mw-dashboard-core/internal/domain"
)

//go:embed v1.json
var registryFS embed.FS

type IdentityRule struct {
	Name   string   `json:"name"`
	Fields []string `json:"fields"`
}

type IdentityDefinition struct {
	Rules []IdentityRule `json:"rules"`
}

type DisplayDefinition struct {
	Label   string `json:"label"`
	Primary string `json:"primary"`
}

type EntityDefinition struct {
	Type      string             `json:"type"`
	Domain    string             `json:"domain"`
	Identity  IdentityDefinition `json:"identity"`
	Display   DisplayDefinition  `json:"display"`
	Lifecycle string             `json:"lifecycle"`
}

type RelationshipDefinition struct {
	Type                string   `json:"type"`
	SourceTypes         []string `json:"source_types"`
	TargetTypes         []string `json:"target_types"`
	SemanticClass       string   `json:"semantic_class"`
	EvidenceClasses     []string `json:"evidence_classes"`
	RouteRole           string   `json:"route_role"`
	InverseDisplayLabel string   `json:"inverse_display_label"`
}

type Registry struct {
	SchemaVersion   string                   `json:"schema_version"`
	EvidenceClasses []string                 `json:"evidence_classes"`
	Entities        []EntityDefinition       `json:"entities"`
	Relationships   []RelationshipDefinition `json:"relationships"`

	entityByType       map[string]EntityDefinition
	relationshipByType map[string]RelationshipDefinition
	evidenceSet        map[string]struct{}
}

func LoadDefault() (*Registry, error) {
	b, err := registryFS.ReadFile("v1.json")
	if err != nil {
		return nil, err
	}
	var r Registry
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, err
	}
	if err := r.buildIndexes(); err != nil {
		return nil, err
	}
	return &r, nil
}

func (r *Registry) buildIndexes() error {
	r.entityByType = make(map[string]EntityDefinition, len(r.Entities))
	r.relationshipByType = make(map[string]RelationshipDefinition, len(r.Relationships))
	r.evidenceSet = make(map[string]struct{}, len(r.EvidenceClasses))
	for _, e := range r.Entities {
		if e.Type == "" {
			return errors.New("registry contains entity with empty type")
		}
		if _, exists := r.entityByType[e.Type]; exists {
			return fmt.Errorf("duplicate entity type %q", e.Type)
		}
		if len(e.Identity.Rules) == 0 {
			return fmt.Errorf("entity %q has no identity rules", e.Type)
		}
		r.entityByType[e.Type] = e
	}
	for _, rel := range r.Relationships {
		if rel.Type == "" {
			return errors.New("registry contains relationship with empty type")
		}
		if _, exists := r.relationshipByType[rel.Type]; exists {
			return fmt.Errorf("duplicate relationship type %q", rel.Type)
		}
		for _, t := range append(append([]string{}, rel.SourceTypes...), rel.TargetTypes...) {
			if _, ok := r.entityByType[t]; !ok {
				return fmt.Errorf("relationship %q references unknown entity type %q", rel.Type, t)
			}
		}
		r.relationshipByType[rel.Type] = rel
	}
	for _, e := range r.EvidenceClasses {
		r.evidenceSet[e] = struct{}{}
	}
	return nil
}

func (r *Registry) EntityDefinition(entityType string) (EntityDefinition, bool) {
	e, ok := r.entityByType[entityType]
	return e, ok
}

func (r *Registry) RelationshipDefinition(relType string) (RelationshipDefinition, bool) {
	d, ok := r.relationshipByType[relType]
	return d, ok
}

func (r *Registry) ValidEvidenceClass(e domain.EvidenceClass) bool {
	_, ok := r.evidenceSet[string(e)]
	return ok
}

func contains(values []string, wanted string) bool {
	for _, v := range values {
		if v == wanted {
			return true
		}
	}
	return false
}

func (r *Registry) ValidateRelation(relType, sourceType, targetType string, evidence domain.EvidenceClass) error {
	rel, ok := r.relationshipByType[relType]
	if !ok {
		return fmt.Errorf("unknown relationship type %q", relType)
	}
	if !contains(rel.SourceTypes, sourceType) {
		return fmt.Errorf("relationship %q does not allow source type %q", relType, sourceType)
	}
	if !contains(rel.TargetTypes, targetType) {
		return fmt.Errorf("relationship %q does not allow target type %q", relType, targetType)
	}
	if !contains(rel.EvidenceClasses, string(evidence)) {
		return fmt.Errorf("relationship %q does not allow evidence class %q", relType, evidence)
	}
	return nil
}

func hintString(hints map[string]interface{}, key string) (string, bool) {
	v, ok := hints[key]
	if !ok || v == nil {
		return "", false
	}
	s := strings.TrimSpace(fmt.Sprint(v))
	if s == "" {
		return "", false
	}
	return s, true
}

// ResolveLogicalKey selects the first complete identity rule in registry order.
// The selected rule name is included so future identity strategies can coexist
// without accidental key collisions.
func (r *Registry) ResolveLogicalKey(entityType string, hints map[string]interface{}) (string, error) {
	def, ok := r.entityByType[entityType]
	if !ok {
		return "", fmt.Errorf("unknown entity type %q", entityType)
	}
	for _, rule := range def.Identity.Rules {
		parts := make([]string, 0, len(rule.Fields))
		complete := true
		for _, field := range rule.Fields {
			value, ok := hintString(hints, field)
			if !ok {
				complete = false
				break
			}
			parts = append(parts, field+"="+strings.ToLower(value))
		}
		if complete {
			return rule.Name + ":" + strings.Join(parts, "|"), nil
		}
	}
	keys := make([]string, 0, len(hints))
	for k := range hints {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return "", fmt.Errorf("no identity rule for %q can be satisfied by hints %v", entityType, keys)
}

func (r *Registry) ValidateBundle(bundle domain.ObservationBundle) error {
	if bundle.SchemaVersion != domain.ObservationBundleSchema {
		return fmt.Errorf("schema_version must be %q", domain.ObservationBundleSchema)
	}
	if strings.TrimSpace(bundle.Run.RunID) == "" || strings.TrimSpace(bundle.Run.Environment) == "" || strings.TrimSpace(bundle.Run.Collector) == "" {
		return errors.New("run requires run_id, environment, and collector")
	}
	if bundle.Run.CompletedAt.IsZero() {
		return errors.New("run.completed_at is required")
	}
	refs := make(map[string]domain.EntityObservation, len(bundle.Entities))
	for i, e := range bundle.Entities {
		if strings.TrimSpace(e.Ref) == "" || strings.TrimSpace(e.DisplayName) == "" {
			return fmt.Errorf("entities[%d] requires ref and display_name", i)
		}
		if _, exists := refs[e.Ref]; exists {
			return fmt.Errorf("duplicate entity ref %q", e.Ref)
		}
		if _, ok := r.entityByType[e.SemanticType]; !ok {
			return fmt.Errorf("entities[%d] has unknown semantic_type %q", i, e.SemanticType)
		}
		if !r.ValidEvidenceClass(e.EvidenceClass) {
			return fmt.Errorf("entities[%d] has invalid evidence_class %q", i, e.EvidenceClass)
		}
		if e.ObservedAt.IsZero() {
			return fmt.Errorf("entities[%d].observed_at is required", i)
		}
		if _, err := r.ResolveLogicalKey(e.SemanticType, e.Identity.Hints); err != nil {
			return fmt.Errorf("entities[%d]: %w", i, err)
		}
		refs[e.Ref] = e
	}
	seenRelations := map[string]struct{}{}
	for i, rel := range bundle.Relations {
		if rel.Ref == "" {
			return fmt.Errorf("relations[%d].ref is required", i)
		}
		if _, exists := seenRelations[rel.Ref]; exists {
			return fmt.Errorf("duplicate relation ref %q", rel.Ref)
		}
		seenRelations[rel.Ref] = struct{}{}
		src, ok := refs[rel.SourceRef]
		if !ok {
			return fmt.Errorf("relations[%d] references unknown source_ref %q", i, rel.SourceRef)
		}
		dst, ok := refs[rel.TargetRef]
		if !ok {
			return fmt.Errorf("relations[%d] references unknown target_ref %q", i, rel.TargetRef)
		}
		if rel.ObservedAt.IsZero() {
			return fmt.Errorf("relations[%d].observed_at is required", i)
		}
		if err := r.ValidateRelation(rel.SemanticType, src.SemanticType, dst.SemanticType, rel.EvidenceClass); err != nil {
			return fmt.Errorf("relations[%d]: %w", i, err)
		}
		if rel.Confidence != nil && (*rel.Confidence < 0 || *rel.Confidence > 1) {
			return fmt.Errorf("relations[%d].confidence must be between 0 and 1", i)
		}
	}
	for i, ref := range bundle.UnresolvedReferences {
		if _, ok := refs[ref.SourceRef]; !ok {
			return fmt.Errorf("unresolved_references[%d] references unknown source_ref %q", i, ref.SourceRef)
		}
		if _, ok := r.entityByType[ref.ExpectedTargetType]; !ok {
			return fmt.Errorf("unresolved_references[%d] has unknown expected_target_type %q", i, ref.ExpectedTargetType)
		}
		if !r.ValidEvidenceClass(ref.EvidenceClass) {
			return fmt.Errorf("unresolved_references[%d] has invalid evidence_class %q", i, ref.EvidenceClass)
		}
	}
	return nil
}
