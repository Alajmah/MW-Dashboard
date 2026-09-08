package postgres

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/alajmah/mw-dashboard-core/internal/domain"
	"github.com/alajmah/mw-dashboard-core/registry"
	"github.com/jackc/pgx/v5"
)

type identityRecord struct {
	EntityID         string
	EntityType       string
	LogicalKey       string
	IdentityRule     string
	IdentityStrength int
}

type identityIndex struct {
	byLogical   map[string]string
	byAlias     map[string]map[string]struct{}
	records     map[string]identityRecord
	aliasValues map[string]map[string]map[string]struct{}
}

func identityMapKey(entityType, value string) string {
	return entityType + "\x00" + strings.ToLower(strings.TrimSpace(value))
}

func aliasMapKey(entityType, aliasType, value string) string {
	return entityType + "\x00" + aliasType + "\x00" + strings.ToLower(strings.TrimSpace(value))
}

func loadIdentityIndex(ctx context.Context, tx pgx.Tx, environment string) (*identityIndex, error) {
	idx := &identityIndex{
		byLogical:   map[string]string{},
		byAlias:     map[string]map[string]struct{}{},
		records:     map[string]identityRecord{},
		aliasValues: map[string]map[string]map[string]struct{}{},
	}
	rows, err := tx.Query(ctx, `
		SELECT e.entity_id, e.entity_type, e.logical_key, COALESCE(e.identity_rule,''), COALESCE(e.identity_strength,0),
		       COALESCE(a.alias_type,''), COALESCE(a.alias_value,'')
		FROM canonical_entity e
		LEFT JOIN entity_alias a ON a.entity_id=e.entity_id
		WHERE e.environment=$1`, environment)
	if err != nil {
		return nil, fmt.Errorf("load identity index: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var rec identityRecord
		var aliasType, aliasValue string
		if err := rows.Scan(&rec.EntityID, &rec.EntityType, &rec.LogicalKey, &rec.IdentityRule, &rec.IdentityStrength, &aliasType, &aliasValue); err != nil {
			return nil, err
		}
		idx.records[rec.EntityID] = rec
		idx.byLogical[identityMapKey(rec.EntityType, rec.LogicalKey)] = rec.EntityID
		if aliasType != "" && aliasValue != "" {
			idx.addAlias(rec.EntityType, aliasType, aliasValue, rec.EntityID)
		}
	}
	return idx, rows.Err()
}

func (i *identityIndex) addAlias(entityType, aliasType, aliasValue, entityID string) {
	key := aliasMapKey(entityType, aliasType, aliasValue)
	set := i.byAlias[key]
	if set == nil {
		set = map[string]struct{}{}
		i.byAlias[key] = set
	}
	set[entityID] = struct{}{}
	byType := i.aliasValues[entityID]
	if byType == nil {
		byType = map[string]map[string]struct{}{}
		i.aliasValues[entityID] = byType
	}
	values := byType[aliasType]
	if values == nil {
		values = map[string]struct{}{}
		byType[aliasType] = values
	}
	values[strings.ToLower(strings.TrimSpace(aliasValue))] = struct{}{}
}

func strongIdentityField(field string) bool {
	switch field {
	case "machine_id", "qmid", "serial", "connection_id":
		return true
	default:
		return false
	}
}

func (i *identityIndex) compatibleWithStrongIDs(entityID string, candidates []registry.IdentityCandidate) bool {
	aliases := i.aliasValues[entityID]
	for _, candidate := range candidates {
		if len(candidate.Fields) != 1 {
			continue
		}
		for field, incoming := range candidate.Fields {
			if !strongIdentityField(field) {
				continue
			}
			existing := aliases[field]
			if len(existing) == 0 {
				continue
			}
			if _, ok := existing[strings.ToLower(incoming)]; !ok {
				return false
			}
		}
	}
	return true
}

func (i *identityIndex) addRecord(rec identityRecord, hints map[string]interface{}, candidates []registry.IdentityCandidate) {
	i.records[rec.EntityID] = rec
	i.byLogical[identityMapKey(rec.EntityType, rec.LogicalKey)] = rec.EntityID
	for key, raw := range hints {
		if raw == nil {
			continue
		}
		value := strings.TrimSpace(fmt.Sprint(raw))
		if value != "" {
			i.addAlias(rec.EntityType, key, value, rec.EntityID)
		}
	}
	for _, candidate := range candidates {
		i.byLogical[identityMapKey(rec.EntityType, candidate.LogicalKey)] = rec.EntityID
		i.addAlias(rec.EntityType, "identity_rule:"+candidate.RuleName, candidate.LogicalKey, rec.EntityID)
	}
}

type identityResolution struct {
	EntityID     string
	LogicalKey   string
	RuleName     string
	Strength     int
	Existing     bool
	Conflicted   bool
	CandidateIDs []string
}

func resolveIdentity(idx *identityIndex, environment, localRef string, e domain.EntityObservation, reg *registry.Registry) (identityResolution, []registry.IdentityCandidate, error) {
	candidates, err := reg.ResolveIdentityCandidates(e.SemanticType, e.Identity.Hints)
	if err != nil {
		return identityResolution{}, nil, err
	}
	matches := map[string]struct{}{}
	for _, candidate := range candidates {
		if id := idx.byLogical[identityMapKey(e.SemanticType, candidate.LogicalKey)]; id != "" {
			matches[id] = struct{}{}
		}
		if set := idx.byAlias[aliasMapKey(e.SemanticType, "identity_rule:"+candidate.RuleName, candidate.LogicalKey)]; set != nil {
			for id := range set {
				matches[id] = struct{}{}
			}
		}
		if len(candidate.Fields) == 1 {
			for field, value := range candidate.Fields {
				if set := idx.byAlias[aliasMapKey(e.SemanticType, field, value)]; set != nil {
					for id := range set {
						matches[id] = struct{}{}
					}
				}
			}
		}
	}

	for id := range matches {
		if !idx.compatibleWithStrongIDs(id, candidates) {
			delete(matches, id)
		}
	}

	best := candidates[0]
	if len(matches) == 0 {
		id := hashID("ent_", e.SemanticType, environment, best.LogicalKey)
		return identityResolution{EntityID: id, LogicalKey: best.LogicalKey, RuleName: best.RuleName, Strength: best.Strength}, candidates, nil
	}
	ids := make([]string, 0, len(matches))
	for id := range matches {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	if len(ids) > 1 {
		conflictKey := "conflict:" + strings.Join(ids, ",")
		id := hashID("ent_", e.SemanticType, environment, conflictKey)
		return identityResolution{
			EntityID:     id,
			LogicalKey:   conflictKey,
			RuleName:     "identity_conflict",
			Strength:     0,
			Conflicted:   true,
			CandidateIDs: ids,
		}, candidates, nil
	}
	id := ids[0]
	rec := idx.records[id]
	resolved := identityResolution{
		EntityID:   id,
		LogicalKey: rec.LogicalKey,
		RuleName:   rec.IdentityRule,
		Strength:   rec.IdentityStrength,
		Existing:   true,
	}
	if best.Strength > rec.IdentityStrength {
		resolved.LogicalKey = best.LogicalKey
		resolved.RuleName = best.RuleName
		resolved.Strength = best.Strength
	}
	return resolved, candidates, nil
}
