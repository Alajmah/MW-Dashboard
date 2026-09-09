const EVIDENCE_RANK = { inferred: 1, declared: 2, configured: 3, observed: 4 };

function scalar(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    const text = value.trim();
    return text ? text.toLowerCase() : null;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value).toLowerCase();
  const text = String(value).trim();
  return text ? text.toLowerCase() : null;
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableObject(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableObject(value));
}

async function sha256(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function stableId(prefix, ...parts) {
  const digest = await sha256(parts.join("|"));
  return `${prefix}_${digest.slice(0, 24)}`;
}

function uniqueSorted(values) {
  return [...new Set(values.filter((value) => value != null && value !== ""))].sort();
}

function mergeValue(left, right) {
  if (right == null || right === "" || (Array.isArray(right) && !right.length)) return left;
  if (left == null || left === "" || (Array.isArray(left) && !left.length)) return right;
  if (stableJson(left) === stableJson(right)) return left;
  const leftItems = Array.isArray(left) ? left : [left];
  const rightItems = Array.isArray(right) ? right : [right];
  const seen = new Map();
  for (const item of [...leftItems, ...rightItems]) seen.set(stableJson(item), item);
  return [...seen.values()];
}

function mergeProperties(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    target[key] = mergeValue(target[key], value);
  }
  return target;
}

function observationScore(item) {
  const evidence = EVIDENCE_RANK[item.evidence_class] || 0;
  const observed = item.observed_at ? Date.parse(item.observed_at) || 0 : 0;
  return [evidence, observed];
}

function betterObservation(candidate, current) {
  if (!current) return true;
  const a = observationScore(candidate);
  const b = observationScore(current);
  return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
}

function hintsFor(item) {
  const identity = item.identity && typeof item.identity === "object" ? item.identity : {};
  const hints = identity.hints && typeof identity.hints === "object" && !Array.isArray(identity.hints)
    ? identity.hints
    : {};
  return hints;
}

function registryRules(registry) {
  const map = new Map();
  for (const entity of registry?.entities || []) {
    map.set(entity.type, entity.identity?.rules || []);
  }
  return map;
}

function qmgrQmidsByName(entities) {
  const map = new Map();
  for (const item of entities) {
    if (item.semantic_type !== "mq.queue_manager") continue;
    const hints = hintsFor(item);
    const name = scalar(hints.name);
    const qmid = scalar(hints.qmid);
    if (!name || !qmid) continue;
    if (!map.has(name)) map.set(name, new Set());
    map.get(name).add(qmid);
  }
  return map;
}

function identityDescriptor(item, rulesByType, qmgrQmids) {
  const type = String(item.semantic_type || "");
  const hints = hintsFor(item);

  if (type === "mq.queue_manager") {
    const canonicalKey = scalar(hints.canonical_key);
    if (canonicalKey) return { rule: "canonical_key", key: canonicalKey, state: "resolved" };
    const name = scalar(hints.name);
    const qmid = scalar(hints.qmid);
    if (qmid) return { rule: "qmid", key: qmid, state: "resolved" };
    const known = name ? qmgrQmids.get(name) : null;
    if (name && known?.size === 1) {
      return { rule: "qmid", key: [...known][0], state: "resolved" };
    }
    if (name && known && known.size > 1) {
      return { rule: "name", key: name, state: "conflicted" };
    }
    if (name) return { rule: "name", key: name, state: "resolved" };
  }

  for (const rule of rulesByType.get(type) || []) {
    const fields = Array.isArray(rule.fields) ? rule.fields : [];
    const values = fields.map((field) => scalar(hints[field]));
    if (fields.length && values.every(Boolean)) {
      return {
        rule: String(rule.name || fields.join("+")),
        key: fields.map((field, index) => `${field}=${values[index]}`).join("|"),
        state: "resolved",
      };
    }
  }

  return {
    rule: "fallback",
    key: stableJson(stableObject(hints)).toLowerCase(),
    state: "ambiguous",
  };
}

function sourceObservation(item) {
  return {
    revision_id: item.revision_id,
    source_id: item.source_id,
    ref: item.ref,
    evidence_class: item.evidence_class || null,
    evidence_ref: item.evidence_ref || null,
  };
}

function relationObservation(item) {
  return {
    revision_id: item.revision_id,
    source_id: item.source_id,
    ref: item.ref,
    evidence_class: item.evidence_class || null,
    evidence_ref: item.evidence_ref || null,
  };
}

export async function sourceSetHash(sourceRevisionIds) {
  return sha256(uniqueSorted(sourceRevisionIds).join("\n"));
}

export async function buildCanonicalEstate({ sources, entities, relations, unresolved, registry }) {
  const sourceRevisionIds = uniqueSorted((sources || []).map((item) => item.revision_id));
  if (!sourceRevisionIds.length) throw new Error("Cannot build canonical estate without current source revisions");

  const rulesByType = registryRules(registry);
  const qmgrQmids = qmgrQmidsByName(entities || []);
  const entityMap = new Map();
  const observationToEntity = new Map();
  let fallbackIdentities = 0;
  let conflictedIdentities = 0;

  for (const item of entities || []) {
    const descriptor = identityDescriptor(item, rulesByType, qmgrQmids);
    const entityId = await stableId("cent", item.semantic_type, descriptor.rule, descriptor.key);
    const observationKey = `${item.revision_id}|${item.ref}`;
    observationToEntity.set(observationKey, entityId);
    if (descriptor.rule === "fallback") fallbackIdentities += 1;

    let entity = entityMap.get(entityId);
    if (!entity) {
      entity = {
        entity_id: entityId,
        semantic_type: item.semantic_type,
        identity_rule: descriptor.rule,
        identity_key: descriptor.key,
        identity_state: descriptor.state,
        display_name: item.display_name || null,
        observed_at: item.observed_at || null,
        properties: {},
        evidence_classes: [],
        source_ids: [],
        source_observations: [],
        evidence_count: 0,
        source_count: 0,
        _representative: null,
      };
      entityMap.set(entityId, entity);
    }
    if (descriptor.state === "conflicted") entity.identity_state = "conflicted";
    else if (descriptor.state === "ambiguous" && entity.identity_state === "resolved") entity.identity_state = "ambiguous";
    if (betterObservation(item, entity._representative)) {
      entity._representative = item;
      entity.display_name = item.display_name || entity.display_name;
      entity.observed_at = item.observed_at || entity.observed_at;
    }
    mergeProperties(entity.properties, item.properties || {});
    entity.evidence_classes.push(item.evidence_class);
    entity.source_ids.push(item.source_id);
    entity.source_observations.push(sourceObservation(item));
    entity.evidence_count += 1;
  }

  const canonicalEntities = [];
  for (const entity of entityMap.values()) {
    entity.evidence_classes = uniqueSorted(entity.evidence_classes);
    entity.source_ids = uniqueSorted(entity.source_ids);
    entity.source_count = entity.source_ids.length;
    if (entity.identity_state === "conflicted") conflictedIdentities += 1;
    delete entity._representative;
    canonicalEntities.push(entity);
  }
  canonicalEntities.sort((a, b) => a.semantic_type.localeCompare(b.semantic_type) || a.entity_id.localeCompare(b.entity_id));

  const relationMap = new Map();
  const danglingRelations = [];
  for (const item of relations || []) {
    const sourceEntityId = observationToEntity.get(`${item.revision_id}|${item.source_ref}`);
    const targetEntityId = observationToEntity.get(`${item.revision_id}|${item.target_ref}`);
    if (!sourceEntityId || !targetEntityId) {
      danglingRelations.push({ revision_id: item.revision_id, ref: item.ref, source_ref: item.source_ref, target_ref: item.target_ref });
      continue;
    }
    const relationId = await stableId("crel", item.semantic_type, sourceEntityId, targetEntityId);
    let relation = relationMap.get(relationId);
    if (!relation) {
      relation = {
        relation_id: relationId,
        semantic_type: item.semantic_type,
        source_entity_id: sourceEntityId,
        target_entity_id: targetEntityId,
        observed_at: item.observed_at || null,
        properties: {},
        evidence_classes: [],
        source_ids: [],
        source_observations: [],
        evidence_count: 0,
        source_count: 0,
        _representative: null,
      };
      relationMap.set(relationId, relation);
    }
    if (betterObservation(item, relation._representative)) {
      relation._representative = item;
      relation.observed_at = item.observed_at || relation.observed_at;
    }
    mergeProperties(relation.properties, item.properties || {});
    relation.evidence_classes.push(item.evidence_class);
    relation.source_ids.push(item.source_id);
    relation.source_observations.push(relationObservation(item));
    relation.evidence_count += 1;
  }
  if (danglingRelations.length) {
    throw new Error(`Canonical reconciliation found ${danglingRelations.length} relation observation(s) with missing endpoints`);
  }

  const canonicalRelations = [];
  for (const relation of relationMap.values()) {
    relation.evidence_classes = uniqueSorted(relation.evidence_classes);
    relation.source_ids = uniqueSorted(relation.source_ids);
    relation.source_count = relation.source_ids.length;
    delete relation._representative;
    canonicalRelations.push(relation);
  }
  canonicalRelations.sort((a, b) => a.semantic_type.localeCompare(b.semantic_type) || a.relation_id.localeCompare(b.relation_id));

  const unresolvedMap = new Map();
  for (const item of unresolved || []) {
    const sourceEntityId = observationToEntity.get(`${item.revision_id}|${item.source_ref}`);
    if (!sourceEntityId) throw new Error(`Unresolved reference ${item.ref} has no canonical source entity`);
    const candidateEntityIds = uniqueSorted((item.candidate_refs || [])
      .map((ref) => observationToEntity.get(`${item.revision_id}|${ref}`))
      .filter(Boolean));
    const unresolvedId = await stableId(
      "cunr",
      item.semantic_type,
      sourceEntityId,
      item.expected_target_type || "",
      scalar(item.vendor_value) || "",
      item.state || "unresolved",
    );
    let record = unresolvedMap.get(unresolvedId);
    if (!record) {
      record = {
        unresolved_id: unresolvedId,
        source_entity_id: sourceEntityId,
        semantic_type: item.semantic_type,
        expected_target_type: item.expected_target_type || null,
        vendor_value: item.vendor_value || null,
        state: item.state || "unresolved",
        reason: item.reason || null,
        candidate_entity_ids: [],
        source_ids: [],
        source_observations: [],
        evidence_count: 0,
      };
      unresolvedMap.set(unresolvedId, record);
    }
    record.candidate_entity_ids.push(...candidateEntityIds);
    record.source_ids.push(item.source_id);
    record.source_observations.push({ revision_id: item.revision_id, source_id: item.source_id, ref: item.ref, evidence_ref: item.evidence_ref || null });
    record.evidence_count += 1;
  }

  const canonicalUnresolved = [];
  for (const record of unresolvedMap.values()) {
    record.candidate_entity_ids = uniqueSorted(record.candidate_entity_ids);
    record.source_ids = uniqueSorted(record.source_ids);
    canonicalUnresolved.push(record);
  }
  canonicalUnresolved.sort((a, b) => a.semantic_type.localeCompare(b.semantic_type) || a.unresolved_id.localeCompare(b.unresolved_id));

  const sourceHash = await sourceSetHash(sourceRevisionIds);
  return {
    source_revision_ids: sourceRevisionIds,
    source_set_hash: sourceHash,
    entities: canonicalEntities,
    relations: canonicalRelations,
    unresolved: canonicalUnresolved,
    quality: {
      valid: conflictedIdentities === 0,
      fallback_identity_observations: fallbackIdentities,
      conflicted_entities: conflictedIdentities,
      source_count: sourceRevisionIds.length,
      observation_counts: {
        entities: (entities || []).length,
        relations: (relations || []).length,
        unresolved: (unresolved || []).length,
      },
      canonical_counts: {
        entities: canonicalEntities.length,
        relations: canonicalRelations.length,
        unresolved: canonicalUnresolved.length,
      },
    },
  };
}
