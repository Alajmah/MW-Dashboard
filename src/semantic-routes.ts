export interface SemanticRoutesEnv {
  DB: D1Database;
}

type Row = Record<string, unknown>;

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const SEARCH_TYPES = [
  "app.application_instance",
  "mq.runtime_process",
  "mq.queue",
  "ace.message_flow",
  "datapower.service",
  "filetransfer.flow",
] as const;

const FORWARD_DELIVERY = [
  "activity.put_observed",
  "runtime.opens_for_output",
  "integration.produces_to",
  "routing.resolves_to",
] as const;

const REVERSE_DELIVERY = [
  "activity.get_observed",
  "runtime.opens_for_input",
  "integration.consumes_from",
] as const;

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

function entityFromRow(row: Row | null) {
  if (!row) return null;
  return {
    entity_id: row.entity_id,
    semantic_type: row.semantic_type,
    display_name: row.display_name,
    identity_key: row.identity_key,
    identity_state: row.identity_state,
    properties: parseJson(row.properties_json, {}),
    evidence_classes: parseJson(row.evidence_classes_json, []),
    source_count: Number(row.source_count ?? 0),
  };
}

async function entityById(db: D1Database, estateId: string, entityId: string): Promise<Row | null> {
  return await db.prepare(
    `SELECT entity_id, semantic_type, display_name, identity_key, identity_state,
            properties_json, evidence_classes_json, source_count
       FROM semantic_estate_entity
      WHERE estate_revision_id = ? AND entity_id = ?
      LIMIT 1`
  ).bind(estateId, entityId).first<Row>();
}

async function searchRoutes(request: Request, env: SemanticRoutesEnv, estate: Row): Promise<Response> {
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, 200);
  if (!query) return reply({ detail: "q is required" }, 400);
  const requested = Number(url.searchParams.get("limit") ?? 20);
  const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 50) : 20;
  const estateId = String(estate.estate_revision_id);
  const placeholders = SEARCH_TYPES.map(() => "?").join(",");
  const result = await env.DB.prepare(
    `SELECT entity_id, semantic_type, display_name, identity_key, identity_state,
            properties_json, evidence_classes_json, source_count
       FROM semantic_estate_entity
      WHERE estate_revision_id = ?
        AND semantic_type IN (${placeholders})
        AND (lower(COALESCE(display_name,'')) LIKE '%' || ? || '%' OR lower(identity_key) LIKE '%' || ? || '%')
      ORDER BY CASE
        WHEN lower(COALESCE(display_name,'')) = ? THEN 0
        WHEN lower(COALESCE(display_name,'')) LIKE ? || '%' THEN 1
        ELSE 2
      END,
      semantic_type, lower(COALESCE(display_name,'')), entity_id
      LIMIT ?`
  ).bind(estateId, ...SEARCH_TYPES, query, query, query, query, limit).all<Row>();

  return reply({
    schema_version: "osi.route.query/v1",
    estate: estateMetadata(estate),
    query,
    results: result.results.map((row) => entityFromRow(row)),
  });
}

function routeMode(types: string[]): string {
  if (types.some((type) => type.startsWith("activity."))) return "observed_activity";
  if (types.some((type) => type === "runtime.opens_for_output" || type === "runtime.opens_for_input")) return "runtime_access";
  return "configured_semantic_path";
}

function routeEdgeLabel(type: string, reversed: boolean): string {
  const labels: Record<string, string> = {
    "activity.put_observed": "Observed PUT activity",
    "activity.get_observed": "Observed GET activity",
    "runtime.opens_for_output": "Open for output access",
    "runtime.opens_for_input": "Open for input access",
    "integration.produces_to": "Produces to",
    "integration.consumes_from": "Consumed by",
    "routing.resolves_to": "Resolves to",
  };
  if (type === "runtime.opens_for_input" && reversed) return "Consumed through input access";
  if (type === "activity.get_observed" && reversed) return "Observed consumer activity";
  if (type === "integration.consumes_from" && reversed) return "Consumed by integration flow";
  return labels[type] ?? type;
}

async function deliveryPath(db: D1Database, estateId: string, fromId: string, toId: string, maxDepth: number): Promise<{ relationTokens: string[]; nodeIds: string[] } | null> {
  const forward = FORWARD_DELIVERY.map((value) => `'${value}'`).join(",");
  const reverse = REVERSE_DELIVERY.map((value) => `'${value}'`).join(",");
  const result = await db.prepare(
    `WITH RECURSIVE
       route_edges(relation_id, semantic_type, from_id, to_id, reversed, penalty) AS (
         SELECT relation_id, semantic_type, source_entity_id, target_entity_id, 0,
                CASE semantic_type
                  WHEN 'activity.put_observed' THEN 0
                  WHEN 'integration.produces_to' THEN 2
                  WHEN 'routing.resolves_to' THEN 3
                  WHEN 'runtime.opens_for_output' THEN 20
                  ELSE 10
                END
           FROM semantic_estate_relation
          WHERE estate_revision_id = ? AND semantic_type IN (${forward})
         UNION ALL
         SELECT relation_id, semantic_type, target_entity_id, source_entity_id, 1,
                CASE semantic_type
                  WHEN 'activity.get_observed' THEN 0
                  WHEN 'integration.consumes_from' THEN 2
                  WHEN 'runtime.opens_for_input' THEN 20
                  ELSE 10
                END
           FROM semantic_estate_relation
          WHERE estate_revision_id = ? AND semantic_type IN (${reverse})
       ),
       walk(node_id, depth, node_path, relation_path, penalty) AS (
         SELECT ?, 0, ',' || ? || ',', '', 0
         UNION ALL
         SELECT edge.to_id,
                walk.depth + 1,
                walk.node_path || edge.to_id || ',',
                walk.relation_path || CASE WHEN edge.reversed = 1 THEN '-' ELSE '+' END || edge.relation_id || '|',
                walk.penalty + edge.penalty
           FROM walk
           JOIN route_edges edge ON edge.from_id = walk.node_id
          WHERE walk.depth < ?
            AND instr(walk.node_path, ',' || edge.to_id || ',') = 0
       )
       SELECT node_path, relation_path, depth, penalty
         FROM walk
        WHERE node_id = ? AND depth > 0
        ORDER BY penalty ASC, depth ASC
        LIMIT 1`
  ).bind(estateId, estateId, fromId, fromId, maxDepth, toId).first<Row>();

  if (!result) return null;
  const nodeIds = String(result.node_path ?? "").split(",").filter(Boolean);
  const relationTokens = String(result.relation_path ?? "").split("|").filter(Boolean);
  return { nodeIds, relationTokens };
}

async function pathDetails(db: D1Database, estateId: string, path: { relationTokens: string[]; nodeIds: string[] }) {
  const entityResults = await db.batch(path.nodeIds.map((entityId) => db.prepare(
    `SELECT entity_id, semantic_type, display_name, identity_key, identity_state,
            properties_json, evidence_classes_json, source_count
       FROM semantic_estate_entity
      WHERE estate_revision_id = ? AND entity_id = ? LIMIT 1`
  ).bind(estateId, entityId)));
  const entities = entityResults.map((result) => entityFromRow((result.results?.[0] as Row | undefined) ?? null)).filter(Boolean);
  const byId = new Map(entities.map((entity) => [String(entity!.entity_id), entity!]));

  const relationIds = path.relationTokens.map((token) => token.slice(1));
  const relationResults = await db.batch(relationIds.map((relationId) => db.prepare(
    `SELECT relation_id, semantic_type, source_entity_id, target_entity_id, observed_at,
            properties_json, evidence_classes_json, source_ids_json, evidence_count, source_count
       FROM semantic_estate_relation
      WHERE estate_revision_id = ? AND relation_id = ? LIMIT 1`
  ).bind(estateId, relationId)));

  const steps = relationResults.map((result, index) => {
    const row = (result.results?.[0] as Row | undefined) ?? {};
    const reversed = path.relationTokens[index]?.startsWith("-") ?? false;
    const fromEntity = byId.get(path.nodeIds[index]);
    const toEntity = byId.get(path.nodeIds[index + 1]);
    return {
      relation_id: row.relation_id,
      semantic_type: row.semantic_type,
      label: routeEdgeLabel(String(row.semantic_type ?? ""), reversed),
      reversed,
      from: fromEntity,
      to: toEntity,
      observed_at: row.observed_at,
      properties: parseJson(row.properties_json, {}),
      evidence_classes: parseJson(row.evidence_classes_json, []),
      source_ids: parseJson(row.source_ids_json, []),
      evidence_count: Number(row.evidence_count ?? 0),
      source_count: Number(row.source_count ?? 0),
      semantic_warning: String(row.semantic_type ?? "").startsWith("runtime.opens_for_")
        ? "Runtime queue access proves an open handle, not an MQPUT or MQGET operation."
        : null,
    };
  });
  return { entities, steps };
}

async function transportExpansions(db: D1Database, estateId: string, queueIds: string[]) {
  if (!queueIds.length) return [];
  const statements = queueIds.map((queueId) => db.prepare(
    `SELECT
       rv.source_entity_id AS route_queue_id,
       rv.relation_id AS routes_via_relation_id,
       rv.evidence_classes_json AS routes_via_evidence_json,
       xq.entity_id AS xmitq_id,
       xq.display_name AS xmitq_name,
       tv.relation_id AS transmits_via_relation_id,
       tv.evidence_classes_json AS transmits_via_evidence_json,
       ch.entity_id AS channel_id,
       ch.display_name AS channel_name,
       nc.relation_id AS connects_to_relation_id,
       nc.evidence_classes_json AS connects_to_evidence_json,
       peer.entity_id AS peer_qmgr_id,
       peer.display_name AS peer_qmgr_name
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
  ).bind(estateId, queueId));
  const results = await db.batch(statements);
  const expansions: unknown[] = [];
  results.forEach((result) => {
    (result.results ?? []).forEach((raw) => {
      const row = raw as Row;
      expansions.push({
        route_queue_id: row.route_queue_id,
        routes_via: {
          relation_id: row.routes_via_relation_id,
          evidence_classes: parseJson(row.routes_via_evidence_json, []),
        },
        xmitq: row.xmitq_id ? { entity_id: row.xmitq_id, display_name: row.xmitq_name } : null,
        transmits_via: row.transmits_via_relation_id ? {
          relation_id: row.transmits_via_relation_id,
          evidence_classes: parseJson(row.transmits_via_evidence_json, []),
        } : null,
        channel: row.channel_id ? { entity_id: row.channel_id, display_name: row.channel_name } : null,
        connects_to: row.connects_to_relation_id ? {
          relation_id: row.connects_to_relation_id,
          evidence_classes: parseJson(row.connects_to_evidence_json, []),
        } : null,
        peer_queue_manager: row.peer_qmgr_id ? { entity_id: row.peer_qmgr_id, display_name: row.peer_qmgr_name } : null,
      });
    });
  });
  return expansions;
}

async function unresolvedForPath(db: D1Database, estateId: string, entityIds: string[]) {
  if (!entityIds.length) return [];
  const results = await db.batch(entityIds.map((entityId) => db.prepare(
    `SELECT unresolved_id, source_entity_id, semantic_type, expected_target_type,
            vendor_value, state, reason, candidate_entity_ids_json, source_ids_json, evidence_count
       FROM semantic_estate_unresolved
      WHERE estate_revision_id = ? AND source_entity_id = ?
      ORDER BY state, semantic_type, unresolved_id`
  ).bind(estateId, entityId)));
  const rows: unknown[] = [];
  for (const result of results) {
    for (const raw of result.results ?? []) {
      const row = raw as Row;
      rows.push({
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
      });
    }
  }
  return rows;
}

async function traceRoute(request: Request, env: SemanticRoutesEnv, estate: Row): Promise<Response> {
  const url = new URL(request.url);
  const fromId = (url.searchParams.get("from") ?? "").trim().slice(0, 300);
  const toId = (url.searchParams.get("to") ?? "").trim().slice(0, 300);
  if (!fromId || !toId) return reply({ detail: "from and to are required" }, 400);
  if (fromId === toId) return reply({ detail: "from and to must be different entities" }, 400);
  const depthValue = Number(url.searchParams.get("max_depth") ?? 12);
  const maxDepth = Number.isInteger(depthValue) ? Math.min(Math.max(depthValue, 1), 16) : 12;
  const estateId = String(estate.estate_revision_id);
  const [sourceRow, targetRow] = await Promise.all([
    entityById(env.DB, estateId, fromId),
    entityById(env.DB, estateId, toId),
  ]);
  if (!sourceRow || !targetRow) return reply({ detail: "Route endpoint entity not found in the current canonical estate" }, 404);

  const source = entityFromRow(sourceRow);
  const target = entityFromRow(targetRow);
  const path = await deliveryPath(env.DB, estateId, fromId, toId, maxDepth);
  if (!path) {
    const unresolved = await unresolvedForPath(env.DB, estateId, [fromId]);
    return reply({
      schema_version: "osi.route.query/v1",
      estate: estateMetadata(estate),
      found: false,
      source,
      target,
      unresolved,
      explanation: "No directed semantic delivery path is supported by the current canonical evidence. This does not prove the systems are disconnected.",
    });
  }

  const details = await pathDetails(env.DB, estateId, path);
  const queueIds = details.entities
    .filter((entity) => entity?.semantic_type === "mq.queue")
    .map((entity) => String(entity!.entity_id));
  const [transport, unresolved] = await Promise.all([
    transportExpansions(env.DB, estateId, queueIds),
    unresolvedForPath(env.DB, estateId, path.nodeIds),
  ]);
  const types = details.steps.map((step) => String(step.semantic_type ?? ""));

  return reply({
    schema_version: "osi.route.query/v1",
    estate: estateMetadata(estate),
    found: true,
    mode: routeMode(types),
    source,
    target,
    nodes: details.entities,
    steps: details.steps,
    transport,
    unresolved,
    semantics: {
      runtime_access_is_activity: false,
      note: "runtime.opens_for_output/input means an MQ object was open for that access mode; it is not proof that a PUT or GET occurred.",
    },
  });
}

export async function handleSemanticRoutes(request: Request, env: SemanticRoutesEnv): Promise<Response | null> {
  if (request.method !== "GET") return null;
  const path = new URL(request.url).pathname;
  if (path !== "/api/v2/routes/search" && path !== "/api/v2/routes/trace") return null;
  try {
    const estateOrResponse = await requireFreshEstate(env.DB);
    if (estateOrResponse instanceof Response) return estateOrResponse;
    if (path === "/api/v2/routes/search") return await searchRoutes(request, env, estateOrResponse);
    return await traceRoute(request, env, estateOrResponse);
  } catch (error) {
    console.error("semantic route query error", error);
    return reply({ detail: "Canonical route query failed" }, 500);
  }
}
