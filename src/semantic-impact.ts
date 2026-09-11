export interface SemanticImpactEnv {
  DB: D1Database;
}

type Row = Record<string, unknown>;

type ImpactDirection = "upstream" | "downstream" | "transport" | "context";
type ImpactKind = "observed_activity" | "runtime_access" | "configured_delivery" | "transport" | "structural_context";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const FORWARD_DELIVERY = new Set([
  "activity.put_observed",
  "runtime.opens_for_output",
  "integration.produces_to",
  "routing.resolves_to",
]);
const REVERSE_DELIVERY = new Set([
  "activity.get_observed",
  "runtime.opens_for_input",
  "integration.consumes_from",
]);
const TRANSPORT = new Set([
  "routing.routes_via",
  "routing.transmits_via",
  "network.connects_to",
]);

function reply(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS });
}

function parseJson(value: unknown, fallback: unknown): unknown {
  if (typeof value !== "string" || !value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

async function sourceSetHash(values: string[]): Promise<string> {
  const stable = [...new Set(values)].sort().join("\n");
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function requireFreshEstate(db: D1Database): Promise<Row | Response> {
  const estate = await db.prepare(
    `SELECT estate_revision_id, source_set_hash, source_revision_ids_json, activated_at
       FROM semantic_estate_revision
      WHERE is_current = 1
      LIMIT 1`
  ).first<Row>();
  if (!estate) return reply({ detail: "Canonical estate is not available yet", code: "ESTATE_PENDING" }, 409);

  const current = await db.prepare(
    "SELECT revision_id FROM semantic_source_revision WHERE is_current = 1 ORDER BY revision_id"
  ).all<{ revision_id: string }>();
  const sourceIds = current.results.map((row) => String(row.revision_id));
  if (String(estate.source_set_hash) !== await sourceSetHash(sourceIds)) {
    return reply({
      detail: "Canonical estate is stale because the current source set has changed",
      code: "ESTATE_STALE",
      current_estate_revision_id: estate.estate_revision_id,
      current_sources: sourceIds.length,
    }, 409);
  }
  return estate;
}

function estateMetadata(estate: Row) {
  return {
    estate_revision_id: String(estate.estate_revision_id),
    source_set_hash: String(estate.source_set_hash),
    source_revision_ids: parseJson(estate.source_revision_ids_json, []),
    activated_at: estate.activated_at,
  };
}

function entityFromRow(row: Row | null, prefix = "") {
  if (!row) return null;
  const read = (key: string) => row[`${prefix}${key}`];
  return {
    entity_id: read("entity_id"),
    semantic_type: read("semantic_type"),
    display_name: read("display_name"),
    identity_key: read("identity_key"),
    identity_state: read("identity_state"),
    properties: parseJson(read("properties_json"), {}),
    evidence_classes: parseJson(read("evidence_classes_json"), []),
    source_count: Number(read("source_count") ?? 0),
  };
}

function classifyRelation(entityId: string, row: Row): { direction: ImpactDirection; kind: ImpactKind; warning: string | null } {
  const semanticType = String(row.semantic_type ?? "");
  const sourceId = String(row.source_entity_id ?? "");
  const currentIsSource = sourceId === entityId;

  if (FORWARD_DELIVERY.has(semanticType)) {
    const kind: ImpactKind = semanticType.startsWith("activity.")
      ? "observed_activity"
      : semanticType.startsWith("runtime.")
        ? "runtime_access"
        : "configured_delivery";
    return {
      direction: currentIsSource ? "downstream" : "upstream",
      kind,
      warning: kind === "runtime_access" ? "Runtime open access is not proof of MQPUT or MQGET activity." : null,
    };
  }

  if (REVERSE_DELIVERY.has(semanticType)) {
    const kind: ImpactKind = semanticType.startsWith("activity.")
      ? "observed_activity"
      : semanticType.startsWith("runtime.")
        ? "runtime_access"
        : "configured_delivery";
    return {
      direction: currentIsSource ? "upstream" : "downstream",
      kind,
      warning: kind === "runtime_access" ? "Runtime open access is not proof of MQPUT or MQGET activity." : null,
    };
  }

  if (TRANSPORT.has(semanticType)) {
    return { direction: "transport", kind: "transport", warning: null };
  }

  return {
    direction: "context",
    kind: "structural_context",
    warning: semanticType === "mq.cluster_discovers" ? "Cluster discovery is visibility evidence; it does not prove message traversal." : null,
  };
}

function relationLabel(type: string, direction: ImpactDirection): string {
  const labels: Record<string, string> = {
    "activity.put_observed": "Observed PUT activity",
    "activity.get_observed": "Observed GET activity",
    "runtime.opens_for_output": "Open for output access",
    "runtime.opens_for_input": "Open for input access",
    "integration.produces_to": "Produces to",
    "integration.consumes_from": "Consumes from",
    "routing.resolves_to": "Queue resolution",
    "routing.routes_via": "Routes via transmission queue",
    "routing.transmits_via": "Transmits via channel",
    "network.connects_to": "Connects to peer",
    "mq.cluster_discovers": "Cluster discovery",
    "member_of": "Cluster membership",
    "contains": "Ownership / containment",
    "runs_on": "Runs on",
    "has_instance": "Has instance",
  };
  if (type === "runtime.opens_for_input" && direction === "downstream") return "Consumer input access";
  if (type === "activity.get_observed" && direction === "downstream") return "Observed consumer activity";
  if (type === "integration.consumes_from" && direction === "downstream") return "Integration consumer";
  return labels[type] ?? type;
}

async function loadEntity(db: D1Database, estateId: string, entityId: string): Promise<Row | null> {
  return await db.prepare(
    `SELECT entity_id, semantic_type, display_name, identity_key, identity_state,
            properties_json, evidence_classes_json, source_count
       FROM semantic_estate_entity
      WHERE estate_revision_id = ? AND entity_id = ?
      LIMIT 1`
  ).bind(estateId, entityId).first<Row>();
}

async function loadRelations(db: D1Database, estateId: string, entityId: string) {
  const result = await db.prepare(
    `SELECT
       r.relation_id,
       r.semantic_type,
       r.source_entity_id,
       r.target_entity_id,
       r.observed_at,
       r.properties_json,
       r.evidence_classes_json,
       r.source_ids_json,
       r.evidence_count,
       r.source_count,
       n.entity_id AS n_entity_id,
       n.semantic_type AS n_semantic_type,
       n.display_name AS n_display_name,
       n.identity_key AS n_identity_key,
       n.identity_state AS n_identity_state,
       n.properties_json AS n_properties_json,
       n.evidence_classes_json AS n_evidence_classes_json,
       n.source_count AS n_source_count
     FROM semantic_estate_relation r
     JOIN semantic_estate_entity n
       ON n.estate_revision_id = r.estate_revision_id
      AND n.entity_id = CASE WHEN r.source_entity_id = ? THEN r.target_entity_id ELSE r.source_entity_id END
    WHERE r.estate_revision_id = ?
      AND (r.source_entity_id = ? OR r.target_entity_id = ?)
    ORDER BY r.semantic_type, n.display_name, r.relation_id`
  ).bind(entityId, estateId, entityId, entityId).all<Row>();

  return result.results.map((row) => {
    const classification = classifyRelation(entityId, row);
    return {
      relation_id: row.relation_id,
      semantic_type: row.semantic_type,
      label: relationLabel(String(row.semantic_type ?? ""), classification.direction),
      direction: classification.direction,
      kind: classification.kind,
      source_entity_id: row.source_entity_id,
      target_entity_id: row.target_entity_id,
      observed_at: row.observed_at,
      properties: parseJson(row.properties_json, {}),
      evidence_classes: parseJson(row.evidence_classes_json, []),
      source_ids: parseJson(row.source_ids_json, []),
      evidence_count: Number(row.evidence_count ?? 0),
      source_count: Number(row.source_count ?? 0),
      neighbor: entityFromRow(row, "n_"),
      semantic_warning: classification.warning,
    };
  });
}

async function loadUnresolved(db: D1Database, estateId: string, entityId: string) {
  const result = await db.prepare(
    `SELECT unresolved_id, source_entity_id, semantic_type, expected_target_type,
            vendor_value, state, reason, candidate_entity_ids_json, source_ids_json, evidence_count
       FROM semantic_estate_unresolved
      WHERE estate_revision_id = ? AND source_entity_id = ?
      ORDER BY state, semantic_type, unresolved_id`
  ).bind(estateId, entityId).all<Row>();
  return result.results.map((row) => ({
    unresolved_id: row.unresolved_id,
    source_entity_id: row.source_entity_id,
    semantic_type: row.semantic_type,
    expected_target_type: row.expected_target_type,
    vendor_value: row.vendor_value,
    state: row.state,
    reason: row.reason,
    candidate_entity_ids: parseJson(row.candidate_entity_ids_json, []),
    source_ids: parseJson(row.source_ids_json, []),
    evidence_count: Number(row.evidence_count ?? 0),
  }));
}

async function loadTransport(db: D1Database, estateId: string, entityId: string) {
  const result = await db.prepare(
    `SELECT
       rv.source_entity_id AS route_queue_id,
       rv.relation_id AS routes_via_relation_id,
       rv.evidence_classes_json AS routes_via_evidence_json,
       xq.entity_id AS xmitq_id,
       xq.display_name AS xmitq_name,
       xq.semantic_type AS xmitq_type,
       tv.relation_id AS transmits_via_relation_id,
       tv.evidence_classes_json AS transmits_via_evidence_json,
       ch.entity_id AS channel_id,
       ch.display_name AS channel_name,
       ch.semantic_type AS channel_type,
       nc.relation_id AS connects_to_relation_id,
       nc.evidence_classes_json AS connects_to_evidence_json,
       peer.entity_id AS peer_qmgr_id,
       peer.display_name AS peer_qmgr_name,
       peer.semantic_type AS peer_qmgr_type
     FROM semantic_estate_relation rv
     JOIN semantic_estate_entity xq
       ON xq.estate_revision_id = rv.estate_revision_id AND xq.entity_id = rv.target_entity_id
     LEFT JOIN semantic_estate_relation tv
       ON tv.estate_revision_id = rv.estate_revision_id
      AND tv.source_entity_id = xq.entity_id
      AND tv.semantic_type = 'routing.transmits_via'
     LEFT JOIN semantic_estate_entity ch
       ON ch.estate_revision_id = rv.estate_revision_id AND ch.entity_id = tv.target_entity_id
     LEFT JOIN semantic_estate_relation nc
       ON nc.estate_revision_id = rv.estate_revision_id
      AND nc.source_entity_id = ch.entity_id
      AND nc.semantic_type = 'network.connects_to'
     LEFT JOIN semantic_estate_entity peer
       ON peer.estate_revision_id = rv.estate_revision_id AND peer.entity_id = nc.target_entity_id
    WHERE rv.estate_revision_id = ?
      AND rv.source_entity_id = ?
      AND rv.semantic_type = 'routing.routes_via'
    ORDER BY xq.display_name, ch.display_name, peer.display_name`
  ).bind(estateId, entityId).all<Row>();

  return result.results.map((row) => ({
    route_queue_id: row.route_queue_id,
    routes_via: {
      relation_id: row.routes_via_relation_id,
      evidence_classes: parseJson(row.routes_via_evidence_json, []),
    },
    xmitq: row.xmitq_id ? { entity_id: row.xmitq_id, display_name: row.xmitq_name, semantic_type: row.xmitq_type } : null,
    transmits_via: row.transmits_via_relation_id ? {
      relation_id: row.transmits_via_relation_id,
      evidence_classes: parseJson(row.transmits_via_evidence_json, []),
    } : null,
    channel: row.channel_id ? { entity_id: row.channel_id, display_name: row.channel_name, semantic_type: row.channel_type } : null,
    connects_to: row.connects_to_relation_id ? {
      relation_id: row.connects_to_relation_id,
      evidence_classes: parseJson(row.connects_to_evidence_json, []),
    } : null,
    peer_queue_manager: row.peer_qmgr_id ? { entity_id: row.peer_qmgr_id, display_name: row.peer_qmgr_name, semantic_type: row.peer_qmgr_type } : null,
  }));
}

function traceCandidates(upstream: any[], downstream: any[]) {
  const candidates: unknown[] = [];
  const seen = new Set<string>();
  for (const left of upstream) {
    const from = left?.neighbor;
    if (!from?.entity_id) continue;
    for (const right of downstream) {
      const to = right?.neighbor;
      if (!to?.entity_id || from.entity_id === to.entity_id) continue;
      const key = `${from.entity_id}|${to.entity_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        from,
        to,
        reason: "Both endpoints are directly connected to the investigated object by delivery-facing canonical semantics. Submit this pair to the route tracer to verify whether the current estate supports the full directed path.",
        proven: false,
      });
      if (candidates.length >= 8) return candidates;
    }
  }
  return candidates;
}

function coverageState(upstream: any[], downstream: any[], transport: any[]) {
  if (upstream.length && downstream.length) return "bounded_segment";
  if (upstream.length && (transport.length || downstream.length)) return "upstream_with_transport";
  if (upstream.length) return "upstream_only";
  if (downstream.length) return "downstream_only";
  if (transport.length) return "transport_only";
  return "no_delivery_adjacency";
}

async function impact(request: Request, env: SemanticImpactEnv, estate: Row): Promise<Response> {
  const url = new URL(request.url);
  const entityId = (url.searchParams.get("entity_id") ?? "").trim().slice(0, 300);
  if (!entityId) return reply({ detail: "entity_id is required" }, 400);

  const estateId = String(estate.estate_revision_id);
  const entityRow = await loadEntity(env.DB, estateId, entityId);
  if (!entityRow) return reply({ detail: "Entity not found in the current canonical estate" }, 404);

  const [relations, unresolved, transport] = await Promise.all([
    loadRelations(env.DB, estateId, entityId),
    loadUnresolved(env.DB, estateId, entityId),
    loadTransport(env.DB, estateId, entityId),
  ]);

  const upstream = relations.filter((item) => item.direction === "upstream");
  const downstream = relations.filter((item) => item.direction === "downstream");
  const transportRelations = relations.filter((item) => item.direction === "transport");
  const context = relations.filter((item) => item.direction === "context");
  const candidates = traceCandidates(upstream, downstream);

  return reply({
    schema_version: "osi.route.impact/v1",
    estate: estateMetadata(estate),
    entity: entityFromRow(entityRow),
    coverage_state: coverageState(upstream, downstream, transport),
    upstream,
    downstream,
    transport_relations: transportRelations,
    transport,
    context,
    unresolved,
    trace_candidates: candidates,
    semantics: {
      application_or_service_impact: "not_established",
      runtime_access_is_activity: false,
      structural_context_is_delivery: false,
      cluster_discovery_is_message_path: false,
      absence_of_downstream_is_disconnection: false,
      trace_candidate_is_proven_route: false,
      note: "Phase 2H reports canonical delivery adjacency and explicit MQ transport only. Stronger route or impact claims require route-trace support or additional evidence.",
    },
  });
}

export async function handleSemanticImpact(request: Request, env: SemanticImpactEnv): Promise<Response | null> {
  if (request.method !== "GET") return null;
  const path = new URL(request.url).pathname;
  if (path !== "/api/v2/routes/impact") return null;
  try {
    const estateOrResponse = await requireFreshEstate(env.DB);
    if (estateOrResponse instanceof Response) return estateOrResponse;
    return await impact(request, env, estateOrResponse);
  } catch (error) {
    console.error("semantic impact query error", error);
    return reply({ detail: "Canonical impact query failed" }, 500);
  }
}
