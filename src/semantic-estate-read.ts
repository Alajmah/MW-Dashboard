export interface SemanticEstateReadEnv {
  DB: D1Database;
}

type Row = Record<string, unknown>;

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_OFFSET = 100_000;

function reply(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS });
}

function textParam(url: URL, name: string, max = 500): string {
  return (url.searchParams.get(name) ?? "").trim().slice(0, max);
}

function integerParam(url: URL, name: string, fallback: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > max) return fallback;
  return value;
}

function countResult(result: D1Result<unknown>): number {
  return Number((result.results?.[0] as { count?: number } | undefined)?.count ?? 0);
}

async function currentEstate(db: D1Database): Promise<Row | null> {
  return await db.prepare(
    `SELECT estate_revision_id, source_set_hash, source_revision_ids_json, built_at, activated_at,
            expected_entity_count AS entity_count, expected_relation_count AS relation_count,
            expected_unresolved_count AS unresolved_count, quality_json
       FROM semantic_estate_revision
      WHERE is_current = 1
      LIMIT 1`
  ).first<Row>();
}

async function currentSourceRevisionIds(db: D1Database): Promise<string[]> {
  const result = await db.prepare(
    "SELECT revision_id FROM semantic_source_revision WHERE is_current = 1 ORDER BY revision_id"
  ).all<{ revision_id: string }>();
  return result.results.map((row) => String(row.revision_id));
}

async function sourceSetHash(values: string[]): Promise<string> {
  const stable = [...new Set(values)].sort().join("\n");
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function requireFreshEstate(db: D1Database): Promise<Row | Response> {
  const estate = await currentEstate(db);
  if (!estate) {
    return reply({
      detail: "Canonical estate is not available yet",
      code: "ESTATE_PENDING",
    }, 409);
  }
  const sourceIds = await currentSourceRevisionIds(db);
  const fresh = String(estate.source_set_hash) === await sourceSetHash(sourceIds);
  if (!fresh) {
    return reply({
      detail: "Canonical estate is stale because the current source set has changed",
      code: "ESTATE_STALE",
      current_estate_revision_id: estate.estate_revision_id,
      current_sources: sourceIds.length,
    }, 409);
  }
  return estate;
}

function parseJson(value: unknown, fallback: unknown): unknown {
  if (typeof value !== "string" || !value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function estateMetadata(estate: Row) {
  return {
    estate_revision_id: String(estate.estate_revision_id),
    source_set_hash: String(estate.source_set_hash),
    source_revision_ids: parseJson(estate.source_revision_ids_json, []),
    built_at: estate.built_at,
    activated_at: estate.activated_at,
  };
}

async function summary(env: SemanticEstateReadEnv): Promise<Response> {
  const estateOrResponse = await requireFreshEstate(env.DB);
  if (estateOrResponse instanceof Response) return estateOrResponse;
  const estate = estateOrResponse;
  const estateId = String(estate.estate_revision_id);
  const results = await env.DB.batch([
    env.DB.prepare(
      `SELECT semantic_type, COUNT(*) AS count
         FROM semantic_estate_entity
        WHERE estate_revision_id = ?
        GROUP BY semantic_type
        ORDER BY semantic_type`
    ).bind(estateId),
    env.DB.prepare(
      `SELECT identity_state, COUNT(*) AS count
         FROM semantic_estate_entity
        WHERE estate_revision_id = ?
        GROUP BY identity_state
        ORDER BY identity_state`
    ).bind(estateId),
    env.DB.prepare(
      `SELECT state, COUNT(*) AS count
         FROM semantic_estate_unresolved
        WHERE estate_revision_id = ?
        GROUP BY state
        ORDER BY state`
    ).bind(estateId),
    env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM semantic_estate_entity
        WHERE estate_revision_id = ? AND source_count > 1`
    ).bind(estateId),
  ]);

  const byType = Object.fromEntries((results[0].results ?? []).map((row) => [
    String((row as Row).semantic_type), Number((row as Row).count ?? 0),
  ]));
  const identityStates = Object.fromEntries((results[1].results ?? []).map((row) => [
    String((row as Row).identity_state), Number((row as Row).count ?? 0),
  ]));
  const unresolvedStates = Object.fromEntries((results[2].results ?? []).map((row) => [
    String((row as Row).state), Number((row as Row).count ?? 0),
  ]));

  return reply({
    schema_version: "osi.estate.read/v1",
    estate: estateMetadata(estate),
    counts: {
      entities: Number(estate.entity_count ?? 0),
      relations: Number(estate.relation_count ?? 0),
      unresolved: Number(estate.unresolved_count ?? 0),
      multi_source_entities: countResult(results[3]),
    },
    entities_by_type: byType,
    identity_states: identityStates,
    unresolved_by_state: unresolvedStates,
    quality: parseJson(estate.quality_json, {}),
  });
}

async function listEntities(request: Request, env: SemanticEstateReadEnv): Promise<Response> {
  const estateOrResponse = await requireFreshEstate(env.DB);
  if (estateOrResponse instanceof Response) return estateOrResponse;
  const estate = estateOrResponse;
  const estateId = String(estate.estate_revision_id);
  const url = new URL(request.url);
  const semanticType = textParam(url, "semantic_type", 200);
  const identityState = textParam(url, "identity_state", 50);
  const query = textParam(url, "q", 200).toLowerCase();
  const limit = Math.max(1, integerParam(url, "limit", DEFAULT_LIMIT, MAX_LIMIT));
  const offset = integerParam(url, "offset", 0, MAX_OFFSET);

  const where = `estate_revision_id = ?
             AND (? = '' OR semantic_type = ?)
             AND (? = '' OR identity_state = ?)
             AND (? = '' OR lower(COALESCE(display_name,'')) LIKE '%' || ? || '%' OR lower(identity_key) LIKE '%' || ? || '%')`;
  const bindings = [estateId, semanticType, semanticType, identityState, identityState, query, query, query] as const;
  const [rows, total] = await env.DB.batch([
    env.DB.prepare(
      `SELECT entity_id, semantic_type, identity_rule, identity_key, identity_state, display_name,
              observed_at, evidence_classes_json, source_ids_json, evidence_count, source_count
         FROM semantic_estate_entity
        WHERE ${where}
        ORDER BY semantic_type, lower(COALESCE(display_name,'')), entity_id
        LIMIT ? OFFSET ?`
    ).bind(...bindings, limit, offset),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM semantic_estate_entity WHERE ${where}`)
      .bind(...bindings),
  ]);

  const entities = (rows.results ?? []).map((row) => {
    const value = row as Row;
    return {
      entity_id: value.entity_id,
      semantic_type: value.semantic_type,
      identity_rule: value.identity_rule,
      identity_key: value.identity_key,
      identity_state: value.identity_state,
      display_name: value.display_name,
      observed_at: value.observed_at,
      evidence_classes: parseJson(value.evidence_classes_json, []),
      source_ids: parseJson(value.source_ids_json, []),
      evidence_count: Number(value.evidence_count ?? 0),
      source_count: Number(value.source_count ?? 0),
    };
  });
  const totalCount = countResult(total);

  return reply({
    schema_version: "osi.estate.read/v1",
    estate: estateMetadata(estate),
    page: { total: totalCount, limit, offset, next_offset: offset + entities.length < totalCount ? offset + entities.length : null },
    entities,
  });
}

async function entityDetail(request: Request, env: SemanticEstateReadEnv, entityId: string): Promise<Response> {
  const estateOrResponse = await requireFreshEstate(env.DB);
  if (estateOrResponse instanceof Response) return estateOrResponse;
  const estate = estateOrResponse;
  const estateId = String(estate.estate_revision_id);
  const entity = await env.DB.prepare(
    `SELECT entity_id, semantic_type, identity_rule, identity_key, identity_state, display_name, observed_at,
            properties_json, evidence_classes_json, source_ids_json, source_observations_json,
            evidence_count, source_count
       FROM semantic_estate_entity
      WHERE estate_revision_id = ? AND entity_id = ? LIMIT 1`
  ).bind(estateId, entityId).first<Row>();
  if (!entity) return reply({ detail: "Canonical entity not found" }, 404);

  const relationLimit = Math.max(1, integerParam(new URL(request.url), "relation_limit", 50, MAX_LIMIT));
  const relations = await env.DB.prepare(
    `SELECT relation_id, semantic_type, source_entity_id, target_entity_id, observed_at,
            evidence_classes_json, source_ids_json, evidence_count, source_count
       FROM semantic_estate_relation
      WHERE estate_revision_id = ? AND (source_entity_id = ? OR target_entity_id = ?)
      ORDER BY semantic_type, source_entity_id, target_entity_id
      LIMIT ?`
  ).bind(estateId, entityId, entityId, relationLimit).all<Row>();

  return reply({
    schema_version: "osi.estate.read/v1",
    estate: estateMetadata(estate),
    entity: {
      entity_id: entity.entity_id,
      semantic_type: entity.semantic_type,
      identity_rule: entity.identity_rule,
      identity_key: entity.identity_key,
      identity_state: entity.identity_state,
      display_name: entity.display_name,
      observed_at: entity.observed_at,
      properties: parseJson(entity.properties_json, {}),
      evidence_classes: parseJson(entity.evidence_classes_json, []),
      source_ids: parseJson(entity.source_ids_json, []),
      source_observations: parseJson(entity.source_observations_json, []),
      evidence_count: Number(entity.evidence_count ?? 0),
      source_count: Number(entity.source_count ?? 0),
    },
    relations: (relations.results ?? []).map((row) => ({
      ...row,
      evidence_classes: parseJson((row as Row).evidence_classes_json, []),
      source_ids: parseJson((row as Row).source_ids_json, []),
      evidence_classes_json: undefined,
      source_ids_json: undefined,
    })),
  });
}

async function listRelations(request: Request, env: SemanticEstateReadEnv): Promise<Response> {
  const estateOrResponse = await requireFreshEstate(env.DB);
  if (estateOrResponse instanceof Response) return estateOrResponse;
  const estate = estateOrResponse;
  const estateId = String(estate.estate_revision_id);
  const url = new URL(request.url);
  const semanticType = textParam(url, "semantic_type", 200);
  const sourceEntityId = textParam(url, "source_entity_id", 300);
  const targetEntityId = textParam(url, "target_entity_id", 300);
  const limit = Math.max(1, integerParam(url, "limit", DEFAULT_LIMIT, MAX_LIMIT));
  const offset = integerParam(url, "offset", 0, MAX_OFFSET);

  const where = `estate_revision_id = ?
             AND (? = '' OR semantic_type = ?)
             AND (? = '' OR source_entity_id = ?)
             AND (? = '' OR target_entity_id = ?)`;
  const bindings = [estateId, semanticType, semanticType, sourceEntityId, sourceEntityId, targetEntityId, targetEntityId] as const;
  const [rows, total] = await env.DB.batch([
    env.DB.prepare(
      `SELECT relation_id, semantic_type, source_entity_id, target_entity_id, observed_at,
              evidence_classes_json, source_ids_json, evidence_count, source_count
         FROM semantic_estate_relation
        WHERE ${where}
        ORDER BY semantic_type, source_entity_id, target_entity_id, relation_id
        LIMIT ? OFFSET ?`
    ).bind(...bindings, limit, offset),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM semantic_estate_relation WHERE ${where}`)
      .bind(...bindings),
  ]);
  const relations = (rows.results ?? []).map((row) => {
    const value = row as Row;
    return {
      relation_id: value.relation_id,
      semantic_type: value.semantic_type,
      source_entity_id: value.source_entity_id,
      target_entity_id: value.target_entity_id,
      observed_at: value.observed_at,
      evidence_classes: parseJson(value.evidence_classes_json, []),
      source_ids: parseJson(value.source_ids_json, []),
      evidence_count: Number(value.evidence_count ?? 0),
      source_count: Number(value.source_count ?? 0),
    };
  });
  const totalCount = countResult(total);
  return reply({
    schema_version: "osi.estate.read/v1",
    estate: estateMetadata(estate),
    page: { total: totalCount, limit, offset, next_offset: offset + relations.length < totalCount ? offset + relations.length : null },
    relations,
  });
}

async function listUnresolved(request: Request, env: SemanticEstateReadEnv): Promise<Response> {
  const estateOrResponse = await requireFreshEstate(env.DB);
  if (estateOrResponse instanceof Response) return estateOrResponse;
  const estate = estateOrResponse;
  const estateId = String(estate.estate_revision_id);
  const url = new URL(request.url);
  const state = textParam(url, "state", 100);
  const semanticType = textParam(url, "semantic_type", 200);
  const limit = Math.max(1, integerParam(url, "limit", DEFAULT_LIMIT, MAX_LIMIT));
  const offset = integerParam(url, "offset", 0, MAX_OFFSET);
  const where = `estate_revision_id = ? AND (? = '' OR state = ?) AND (? = '' OR semantic_type = ?)`;
  const bindings = [estateId, state, state, semanticType, semanticType] as const;
  const [rows, total] = await env.DB.batch([
    env.DB.prepare(
      `SELECT unresolved_id, source_entity_id, semantic_type, expected_target_type, vendor_value, state, reason,
              candidate_entity_ids_json, source_ids_json, evidence_count
         FROM semantic_estate_unresolved
        WHERE ${where}
        ORDER BY state, semantic_type, source_entity_id, unresolved_id
        LIMIT ? OFFSET ?`
    ).bind(...bindings, limit, offset),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM semantic_estate_unresolved WHERE ${where}`)
      .bind(...bindings),
  ]);
  const unresolved = (rows.results ?? []).map((row) => {
    const value = row as Row;
    return {
      unresolved_id: value.unresolved_id,
      source_entity_id: value.source_entity_id,
      semantic_type: value.semantic_type,
      expected_target_type: value.expected_target_type,
      vendor_value: value.vendor_value,
      state: value.state,
      reason: value.reason,
      candidate_entity_ids: parseJson(value.candidate_entity_ids_json, []),
      source_ids: parseJson(value.source_ids_json, []),
      evidence_count: Number(value.evidence_count ?? 0),
    };
  });
  const totalCount = countResult(total);
  return reply({
    schema_version: "osi.estate.read/v1",
    estate: estateMetadata(estate),
    page: { total: totalCount, limit, offset, next_offset: offset + unresolved.length < totalCount ? offset + unresolved.length : null },
    unresolved,
  });
}

export async function handleSemanticEstateRead(request: Request, env: SemanticEstateReadEnv): Promise<Response | null> {
  if (request.method !== "GET") return null;
  const path = new URL(request.url).pathname;
  try {
    if (path === "/api/v2/estate/current/summary") return await summary(env);
    if (path === "/api/v2/estate/current/entities") return await listEntities(request, env);
    if (path === "/api/v2/estate/current/relations") return await listRelations(request, env);
    if (path === "/api/v2/estate/current/unresolved") return await listUnresolved(request, env);
    const match = path.match(/^\/api\/v2\/estate\/current\/entities\/([^/]+)$/);
    if (match) return await entityDetail(request, env, decodeURIComponent(match[1]));
    return null;
  } catch (error) {
    console.error("semantic estate read error", error);
    return reply({ detail: "Canonical estate query failed" }, 500);
  }
}
