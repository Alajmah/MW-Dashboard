export interface IntegratedRoutesEnv { DB: D1Database; }

type JsonMap = Record<string, unknown>;
type Row = Record<string, unknown>;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
function reply(data: unknown, status = 200): Response { return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS }); }
function parseJson(value: unknown, fallback: unknown) { try { return JSON.parse(String(value ?? "")); } catch { return fallback; } }
function boundedInteger(value: string | null, fallback: number, maximum: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, maximum);
}

async function sourceSetHash(values: string[]): Promise<string> {
  const stable = [...new Set(values)].sort().join("\n");
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function freshEstate(db: D1Database): Promise<Record<string, unknown> | Response | null> {
  const estate = await db.prepare(`SELECT estate_revision_id,source_set_hash,source_revision_ids_json,built_at,activated_at,quality_json
                                   FROM semantic_estate_revision WHERE is_current=1 LIMIT 1`).first<Record<string, unknown>>();
  if (!estate) return null;
  const current = await db.prepare("SELECT revision_id FROM semantic_source_revision WHERE is_current=1 ORDER BY revision_id").all<{revision_id:string}>();
  const sourceIds = (current.results ?? []).map((row) => String(row.revision_id));
  if (String(estate.source_set_hash) !== await sourceSetHash(sourceIds)) {
    return reply({ detail: "Canonical estate is stale because the current source set has changed", code: "ESTATE_STALE", current_estate_revision_id: estate.estate_revision_id, current_sources: sourceIds.length }, 409);
  }
  return estate;
}

async function entity(db: D1Database, estateId: string, id: string): Promise<Record<string, unknown> | null> {
  const row = await db.prepare(`SELECT entity_id,semantic_type,identity_key,identity_state,display_name,observed_at,properties_json,evidence_classes_json,source_ids_json,evidence_count,source_count
                                FROM semantic_estate_entity WHERE estate_revision_id=? AND entity_id=? LIMIT 1`).bind(estateId, id).first<Record<string, unknown>>();
  if (!row) return null;
  return { ...row, properties: parseJson(row.properties_json, {}), evidence_classes: parseJson(row.evidence_classes_json, []), source_ids: parseJson(row.source_ids_json, []), properties_json: undefined, evidence_classes_json: undefined, source_ids_json: undefined };
}

async function directIntegratedRoute(db: D1Database, estateId: string, from: string, to: string): Promise<Record<string, unknown> | null> {
  const row = await db.prepare(`SELECT relation_id,semantic_type,source_entity_id,target_entity_id,observed_at,properties_json,evidence_classes_json,source_ids_json,evidence_count,source_count
                                FROM semantic_estate_relation
                                WHERE estate_revision_id=? AND source_entity_id=? AND target_entity_id=? AND semantic_type='integration.routes_to' LIMIT 1`).bind(estateId, from, to).first<Record<string, unknown>>();
  if (!row) return null;
  return { ...row, properties: parseJson(row.properties_json, {}), evidence_classes: parseJson(row.evidence_classes_json, []), source_ids: parseJson(row.source_ids_json, []), properties_json: undefined, evidence_classes_json: undefined, source_ids_json: undefined };
}

async function unresolvedFor(db: D1Database, estateId: string, ids: string[]): Promise<Record<string, unknown>[]> {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (!uniqueIds.length) return [];
  const placeholders = uniqueIds.map(() => "?").join(",");
  const result = await db.prepare(`SELECT unresolved_id,source_entity_id,semantic_type,expected_target_type,vendor_value,state,reason,candidate_entity_ids_json,source_ids_json,evidence_count
                                   FROM semantic_estate_unresolved
                                   WHERE estate_revision_id=? AND source_entity_id IN (${placeholders}) ORDER BY unresolved_id`).bind(estateId, ...uniqueIds).all<Record<string, unknown>>();
  return (result.results ?? []).map((row) => ({ ...row, candidate_entity_ids: parseJson(row.candidate_entity_ids_json, []), source_ids: parseJson(row.source_ids_json, []), candidate_entity_ids_json: undefined, source_ids_json: undefined }));
}

function transferCompletion(properties: JsonMap): "observed" | "not_observed" | "unknown" {
  if (properties.runtime_transfer_completion === true) return "observed";
  if (properties.runtime_transfer_completion === false) return "not_observed";
  return "unknown";
}

function estateMetadata(estate: Record<string, unknown>, estateId: string) {
  return {
    estate_revision_id: estateId,
    source_set_hash: estate.source_set_hash,
    source_revision_ids: parseJson(estate.source_revision_ids_json, []),
    built_at: estate.built_at,
    activated_at: estate.activated_at,
    quality: parseJson(estate.quality_json, {}),
  };
}

function buildQualifiedRoute(relation: Record<string, unknown>, source: Record<string, unknown>, target: Record<string, unknown>, unresolved: Record<string, unknown>[], estate: Record<string, unknown>, estateId: string) {
  const properties = (relation.properties ?? {}) as JsonMap;
  const evidenceClasses = Array.isArray(relation.evidence_classes) ? relation.evidence_classes : [];
  const isFileTransfer = source.semantic_type === "filetransfer.flow" && target.semantic_type === "filetransfer.endpoint" && properties.qualified_route === true && properties.route_kind === "eft_inbound_site_path";
  const semanticWarning = typeof properties.semantic_warning === "string"
    ? properties.semantic_warning
    : isFileTransfer
      ? "This is an inferred topology route composed from historical Site-access evidence plus current listener and independently corroborated PNC observations. It is not current Site traversal or completed file transfer proof."
      : "Configured integration route evidence does not prove a specific runtime message traversal.";

  if (isFileTransfer) {
    const completion = transferCompletion(properties);
    return {
      found: true,
      mode: "configured_semantic_path",
      source,
      target,
      nodes: [source, target],
      steps: [{
        relation_id: relation.relation_id,
        semantic_type: "integration.routes_to",
        label: "Qualified topology path",
        reversed: false,
        from: source,
        to: target,
        evidence_classes: evidenceClasses,
        properties,
        semantic_warning: semanticWarning,
      }],
      transport: [],
      unresolved,
      estate: estateMetadata(estate, estateId),
      semantics: {
        runtime_access_is_activity: false,
        configured_route_is_runtime_traversal: false,
        qualified_route: true,
        route_domain: "file_transfer",
        derived_epistemic: properties.epistemic ?? null,
        site_access_evidence: properties.site_access_evidence ?? null,
        current_listener_evidence: properties.current_listener_evidence ?? null,
        runtime_corroboration: properties.runtime_corroboration ?? [],
        runtime_transfer_completion: typeof properties.runtime_transfer_completion === "boolean" ? properties.runtime_transfer_completion : null,
        transfer_completion: completion,
      },
      explanation: "An evidence-qualified FTP topology path is supported by the current canonical estate. Historical Site access, current listener evidence, and independently corroborated PNC runtime connectivity remain separate evidence components. Transfer completion is not claimed unless explicitly observed.",
    };
  }

  return {
    found: true,
    mode: "configured_semantic_path",
    source,
    target,
    nodes: [source, target],
    steps: [{ relation_id: relation.relation_id, semantic_type: "integration.routes_to", label: "Routes to", reversed: false, from: source, to: target, evidence_classes: evidenceClasses, properties, semantic_warning: semanticWarning }],
    transport: [],
    unresolved,
    estate: estateMetadata(estate, estateId),
    semantics: { runtime_access_is_activity: false, configured_route_is_runtime_traversal: false, qualified_route: true, route_domain: "messaging", derived_epistemic: properties.epistemic ?? null, runtime_corroboration: properties.runtime_corroboration ?? [] },
    explanation: "A deterministic configured DataPower route is supported by the current canonical estate. Static route evidence remains distinct from runtime MQ connectivity evidence.",
  };
}

async function listQualifiedFileTransferRoutes(url: URL, env: IntegratedRoutesEnv, estate: Record<string, unknown>, estateId: string): Promise<Response> {
  const limit = Math.max(1, boundedInteger(url.searchParams.get("limit"), 25, 100));
  const offset = boundedInteger(url.searchParams.get("offset"), 0, 100000);
  const [rows, count] = await env.DB.batch([
    env.DB.prepare(`SELECT r.relation_id,r.semantic_type,r.source_entity_id,r.target_entity_id,r.observed_at,r.properties_json,r.evidence_classes_json,r.source_ids_json,r.evidence_count,r.source_count,
                           s.entity_id AS s_entity_id,s.semantic_type AS s_semantic_type,s.identity_key AS s_identity_key,s.identity_state AS s_identity_state,s.display_name AS s_display_name,s.observed_at AS s_observed_at,s.properties_json AS s_properties_json,s.evidence_classes_json AS s_evidence_classes_json,s.source_ids_json AS s_source_ids_json,s.evidence_count AS s_evidence_count,s.source_count AS s_source_count,
                           t.entity_id AS t_entity_id,t.semantic_type AS t_semantic_type,t.identity_key AS t_identity_key,t.identity_state AS t_identity_state,t.display_name AS t_display_name,t.observed_at AS t_observed_at,t.properties_json AS t_properties_json,t.evidence_classes_json AS t_evidence_classes_json,t.source_ids_json AS t_source_ids_json,t.evidence_count AS t_evidence_count,t.source_count AS t_source_count
                      FROM semantic_estate_relation r
                      JOIN semantic_estate_entity s ON s.estate_revision_id=r.estate_revision_id AND s.entity_id=r.source_entity_id
                      JOIN semantic_estate_entity t ON t.estate_revision_id=r.estate_revision_id AND t.entity_id=r.target_entity_id
                     WHERE r.estate_revision_id=?
                       AND r.semantic_type='integration.routes_to'
                       AND s.semantic_type='filetransfer.flow'
                       AND t.semantic_type='filetransfer.endpoint'
                       AND json_extract(r.properties_json,'$.qualified_route')=1
                       AND json_extract(r.properties_json,'$.route_kind')='eft_inbound_site_path'
                     ORDER BY lower(COALESCE(s.display_name,'')), lower(COALESCE(t.display_name,'')), r.relation_id
                     LIMIT ? OFFSET ?`).bind(estateId, limit, offset),
    env.DB.prepare(`SELECT COUNT(*) AS count
                      FROM semantic_estate_relation r
                      JOIN semantic_estate_entity s ON s.estate_revision_id=r.estate_revision_id AND s.entity_id=r.source_entity_id
                      JOIN semantic_estate_entity t ON t.estate_revision_id=r.estate_revision_id AND t.entity_id=r.target_entity_id
                     WHERE r.estate_revision_id=?
                       AND r.semantic_type='integration.routes_to'
                       AND s.semantic_type='filetransfer.flow'
                       AND t.semantic_type='filetransfer.endpoint'
                       AND json_extract(r.properties_json,'$.qualified_route')=1
                       AND json_extract(r.properties_json,'$.route_kind')='eft_inbound_site_path'`).bind(estateId),
  ]);

  const rawRows = (rows.results ?? []) as Row[];
  const allIds = rawRows.flatMap((row) => [String(row.source_entity_id ?? ""), String(row.target_entity_id ?? "")]);
  const unresolved = await unresolvedFor(env.DB, estateId, allIds);
  const unresolvedBySource = new Map<string, Record<string, unknown>[]>();
  for (const item of unresolved) {
    const key = String(item.source_entity_id ?? "");
    const bucket = unresolvedBySource.get(key) ?? [];
    bucket.push(item);
    unresolvedBySource.set(key, bucket);
  }

  const routes = rawRows.map((row) => {
    const relation = {
      relation_id: row.relation_id,
      semantic_type: row.semantic_type,
      source_entity_id: row.source_entity_id,
      target_entity_id: row.target_entity_id,
      observed_at: row.observed_at,
      properties: parseJson(row.properties_json, {}),
      evidence_classes: parseJson(row.evidence_classes_json, []),
      source_ids: parseJson(row.source_ids_json, []),
      evidence_count: Number(row.evidence_count ?? 0),
      source_count: Number(row.source_count ?? 0),
    };
    const source = {
      entity_id: row.s_entity_id,
      semantic_type: row.s_semantic_type,
      identity_key: row.s_identity_key,
      identity_state: row.s_identity_state,
      display_name: row.s_display_name,
      observed_at: row.s_observed_at,
      properties: parseJson(row.s_properties_json, {}),
      evidence_classes: parseJson(row.s_evidence_classes_json, []),
      source_ids: parseJson(row.s_source_ids_json, []),
      evidence_count: Number(row.s_evidence_count ?? 0),
      source_count: Number(row.s_source_count ?? 0),
    };
    const target = {
      entity_id: row.t_entity_id,
      semantic_type: row.t_semantic_type,
      identity_key: row.t_identity_key,
      identity_state: row.t_identity_state,
      display_name: row.t_display_name,
      observed_at: row.t_observed_at,
      properties: parseJson(row.t_properties_json, {}),
      evidence_classes: parseJson(row.t_evidence_classes_json, []),
      source_ids: parseJson(row.t_source_ids_json, []),
      evidence_count: Number(row.t_evidence_count ?? 0),
      source_count: Number(row.t_source_count ?? 0),
    };
    const routeUnresolved = [
      ...(unresolvedBySource.get(String(row.source_entity_id ?? "")) ?? []),
      ...(unresolvedBySource.get(String(row.target_entity_id ?? "")) ?? []),
    ];
    return buildQualifiedRoute(relation, source, target, routeUnresolved, estate, estateId);
  });

  const total = Number(((count.results ?? [])[0] as Row | undefined)?.count ?? 0);
  return reply({
    schema_version: "osi.routes.qualified/v1",
    estate: estateMetadata(estate, estateId),
    page: { total, limit, offset, next_offset: offset + routes.length < total ? offset + routes.length : null },
    routes,
  });
}

export async function handleIntegratedRoutes(request: Request, env: IntegratedRoutesEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== "GET") return null;
  if (url.pathname !== "/api/v2/routes/trace" && url.pathname !== "/api/v2/routes/qualified") return null;

  try {
    const estate = await freshEstate(env.DB);
    if (!estate) return null;
    if (estate instanceof Response) return estate;
    const estateId = String(estate.estate_revision_id);

    if (url.pathname === "/api/v2/routes/qualified") {
      const domain = url.searchParams.get("domain")?.trim() || "file_transfer";
      if (domain !== "file_transfer") return reply({ detail: "Unsupported qualified-route domain", code: "UNSUPPORTED_ROUTE_DOMAIN" }, 400);
      return await listQualifiedFileTransferRoutes(url, env, estate, estateId);
    }

    const from = url.searchParams.get("from")?.trim();
    const to = url.searchParams.get("to")?.trim();
    if (!from || !to) return null;
    const relation = await directIntegratedRoute(env.DB, estateId, from, to);
    if (!relation) return null;
    const [source, target] = await Promise.all([entity(env.DB, estateId, from), entity(env.DB, estateId, to)]);
    if (!source || !target) return null;
    const properties = (relation.properties ?? {}) as JsonMap;
    const isDataPower = source.semantic_type === "datapower.service" && target.semantic_type === "mq.queue" && properties.qualified_route === true;
    const isFileTransfer = source.semantic_type === "filetransfer.flow" && target.semantic_type === "filetransfer.endpoint" && properties.qualified_route === true && properties.route_kind === "eft_inbound_site_path";
    // Only explicitly qualified cross-technology projections are owned here.
    // Generic integration relations continue through the semantic route engine.
    if (!isDataPower && !isFileTransfer) return null;
    const unresolved = await unresolvedFor(env.DB, estateId, [from, to]);
    return reply(buildQualifiedRoute(relation, source, target, unresolved, estate, estateId));
  } catch (error) {
    console.error("integrated route query failed", error);
    return reply({ detail: "Integrated route query failed", code: "INTEGRATED_ROUTE_QUERY_FAILED" }, 500);
  }
}
