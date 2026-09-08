package registry

import (
	"fmt"
	"strings"
)

// IdentityCandidate is one fully satisfied identity rule for an observation.
// Strength is used only to select the preferred canonical key; all candidates
// remain useful for matching an observation to an existing canonical entity.
type IdentityCandidate struct {
	RuleName   string
	LogicalKey string
	Strength   int
	Fields     map[string]string
}

func identityRuleStrength(rule IdentityRule) int {
	strength := 50
	for _, field := range rule.Fields {
		switch field {
		case "machine_id", "qmid", "serial", "connection_id", "object_handle":
			if strength < 100 {
				strength = 100
			}
		case "canonical_key":
			if strength < 85 {
				strength = 85
			}
		case "fqdn", "primary_ip":
			if strength < 80 {
				strength = 80
			}
		case "queue_manager_key", "host_key", "integration_node_key", "integration_server_key", "message_flow_key", "appliance_key", "domain_key", "service_key", "server_key":
			if strength < 75 {
				strength = 75
			}
		case "name":
			if strength < 60 {
				strength = 60
			}
		case "legacy_id":
			if strength < 30 {
				strength = 30
			}
		}
	}
	if len(rule.Fields) > 1 && strength < 90 {
		strength += 10
	}
	return strength
}

// ResolveIdentityCandidates returns every identity rule that can be satisfied
// by the provided hints, ordered by strength (strongest first) and then by
// registry order. Central reconciliation needs weaker aliases too, so a later
// observation containing a stronger ID (for example QMID) can still match an
// entity first seen by name.
func (r *Registry) ResolveIdentityCandidates(entityType string, hints map[string]interface{}) ([]IdentityCandidate, error) {
	def, ok := r.entityByType[entityType]
	if !ok {
		return nil, fmt.Errorf("unknown entity type %q", entityType)
	}
	out := make([]IdentityCandidate, 0, len(def.Identity.Rules))
	for _, rule := range def.Identity.Rules {
		parts := make([]string, 0, len(rule.Fields))
		fields := make(map[string]string, len(rule.Fields))
		complete := true
		for _, field := range rule.Fields {
			value, ok := hintString(hints, field)
			if !ok {
				complete = false
				break
			}
			value = strings.ToLower(strings.TrimSpace(value))
			fields[field] = value
			parts = append(parts, field+"="+value)
		}
		if complete {
			out = append(out, IdentityCandidate{
				RuleName:   rule.Name,
				LogicalKey: rule.Name + ":" + strings.Join(parts, "|"),
				Strength:   identityRuleStrength(rule),
				Fields:     fields,
			})
		}
	}
	if len(out) == 0 {
		_, err := r.ResolveLogicalKey(entityType, hints)
		return nil, err
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].Strength > out[j-1].Strength; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out, nil
}
