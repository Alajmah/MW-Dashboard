import { handleOperatorReadModel, type OperatorReadModelEnv } from "./operator-read-model";

type JsonMap = Record<string, any>;
type Row = Record<string, any>;

type PathList = {
  estate: JsonMap;
  page: { total: number; limit: number; offset: number; next_offset: number | null };
  paths: JsonMap[];
};
type PathListResult = { response: Response } | { data: PathList };

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};
const MAX_OFFSET = 100_000;

function reply(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS });
}

function parseJson(value: unknown, fallback: unknown) {
  try { return JSON.parse(String(value ?? "")); } catch { return fallback; }
}

function integerParam(url: URL, name: string, fallback: number, maximum: number): number {
  const value = Number.parseInt(url.searchParams.get(name) ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? Math.min(value, maximum) : fallback;
}

async function sourceSetHash(values: string[]): Promise<string> {
  const stable = [...new Set(values)].sort().join("\n");
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function freshEstate(db: D1Database): Promise<Row | Response | null> {
  const estate = await db.prepare(
    `SELECT estate_revision_id,source_set_hash,source_revision_ids_json,built_at,activated_at,quality_json
       FROM semantic_estate_revision WHERE is_current=1 LIMIT 1`
  ).first<Row>();
  if (!estate) return null;
  const current = await db.prepare(
    "SELECT revision_id FROM semantic_source_revision WHERE is_current=1 ORDER BY revision_id"
  ).all<{ revision_id: string }>();
  const sourceIds = (current.results ?? []).map((row) => String(row.revision_id));
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

function estateMetadata(estate: Row, estateId: string): JsonMap {
  return {
    estate_revision_id: estateId,
    source_set_hash: estate.source_set_hash,
    source_revision_ids: parseJson(estate.source_revision_ids_json, []),
    built_at: estate.built_at,
    activated_at: estate.activated_at,
    quality: parseJson(estate.quality_json, {}),
  };
}

function entityFromRow(row: Row, prefix: "s" | "t"): JsonMap {
  return {
    entity_id: row[`${prefix}_entity_id`],
    semantic_type: row[`${prefix}_semantic_type`],
    identity_key: row[`${prefix}_identity_key`],
    identity_state: row[`${prefix}_identity_state`],
    display_name: row[`${prefix}_display_name`],
    observed_at: row[`${prefix}_observed_at`],
    properties: parseJson(row[`${prefix}_properties_json`], {}),
    evidence_classes: parseJson(row[`${prefix}_evidence_classes_json`], []),
    source_ids: parseJson(row[`${prefix}_source_ids_json`], []),
    evidence_count: Number(row[`${prefix}_evidence_count`] || 0),
    source_count: Number(row[`${prefix}_source_count`] || 0),
  };
}

function normalizeGap(raw: Row): JsonMap {
  return {
    unresolved_id: raw.unresolved_id ?? null,
    source_entity_id: raw.source_entity_id ?? null,
    semantic_type: raw.semantic_type ?? null,
    expected_target_type: raw.expected_target_type ?? null,
    vendor_value: raw.vendor_value ?? null,
    state: raw.state ?? "unknown",
    reason: raw.reason ?? "Evidence-backed mapping is incomplete",
    evidence_count: Number(raw.evidence_count || 0),
  };
}

async function unresolvedFor(db: D1Database, estateId: string, ids: string[]): Promise<JsonMap[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return [];
  const placeholders = unique.map(() => "?").join(",");
  const result = await db.prepare(
    `SELECT unresolved_id,source_entity_id,semantic_type,expected_target_type,vendor_value,state,reason,evidence_count
       FROM semantic_estate_unresolved
      WHERE estate_revision_id=? AND source_entity_id IN (${placeholders})
      ORDER BY unresolved_id`
  ).bind(estateId, ...unique).all<Row>();
  return (result.results ?? []).map(normalizeGap);
}

function humanize(value: unknown): string {
  return String(value ?? "unknown").replaceAll("_", " ");
}

function humanizeSourceKind(value: unknown): string {
  return String(value || "").replaceAll("_", " ");
}

function fileTransferPath(row: Row, source: JsonMap, target: JsonMap, gaps: JsonMap[]): JsonMap {
  const properties = parseJson(row.properties_json, {}) as JsonMap;
  const siteAccess = properties.site_access_evidence && typeof properties.site_access_evidence === "object" ? properties.site_access_evidence as JsonMap : {};
  const listener = properties.current_listener_evidence && typeof properties.current_listener_evidence === "object" ? properties.current_listener_evidence as JsonMap : {};
  const corroboration = Array.isArray(properties.runtime_corroboration) ? properties.runtime_corroboration as JsonMap[] : [];
  const corroborated = corroboration.find((item) => item?.time_scope === "current" && item?.independently_corroborated === true) ?? corroboration[0] ?? {};
  const listenerCurrent = listener.time_scope === "current";
  const pncCurrent = corroboration.some((item) => item?.time_scope === "current" && item?.independently_corroborated === true);
  const sourceKinds = Array.isArray(corroborated.sources)
    ? [...new Set((corroborated.sources as JsonMap[]).map((item) => item?.source_kind).filter(Boolean).map(humanizeSourceKind))]
    : [];
  const sourceName = String(source.display_name || source.identity_key || "Access context");
  const targetName = String(target.display_name || target.identity_key || "EFT Site");
  const gateway = String(properties.gateway_server_key || corroborated.gateway_server_key || "DMZ gateway");
  const completion = properties.runtime_transfer_completion === true ? "observed" : properties.runtime_transfer_completion === false ? "not_observed" : "unknown";

  return {
    id: String(row.relation_id),
    domain: "file_transfer",
    domain_label: "File transfer",
    source: { id: source.entity_id, name: sourceName, semantic_type: source.semantic_type },
    destination: { id: target.entity_id, name: targetName, semantic_type: target.semantic_type },
    label: `File transfer · ${sourceName} → ${targetName}`,
    qualification: { qualified: true, epistemic: properties.epistemic ?? "inferred", route_domain: "file_transfer" },
    runtime_boundary: listenerCurrent && pncCurrent ? "current" : "incomplete",
    runtime_boundary_label: listenerCurrent && pncCurrent ? "Current runtime boundary supported" : "Runtime boundary incomplete",
    outcome: completion,
    outcome_label: completion === "observed" ? "Completed transfer observed" : completion === "not_observed" ? "Completed transfer not observed" : "Transfer outcome unknown",
    gap_count: gaps.length,
    gaps,
    explanation: "An evidence-qualified FTP topology path is supported by the canonical estate. Historical Site access, current listener evidence, and independently corroborated PNC connectivity remain separate claims; transfer completion is independent.",
    nodes: [
      { role: "Access context", title: sourceName, state: siteAccess.time_scope === "historical" ? "Historical" : siteAccess.time_scope === "current" ? "Current" : "Unknown", state_kind: siteAccess.time_scope === "historical" ? "info" : siteAccess.time_scope === "current" ? "good" : "warn", note: siteAccess.time_scope === "historical" ? "Observed Site-access window retained" : "Site-access evidence not classified" },
      { role: "DMZ listener", title: String(listener.endpoint || "Listener endpoint"), state: listenerCurrent ? "Current" : "Unknown", state_kind: listenerCurrent ? "good" : "warn", note: gateway },
      { role: "PNC boundary", title: String(corroborated.endpoint || "PNC boundary"), state: pncCurrent ? "Corroborated" : "Unknown", state_kind: pncCurrent ? "good" : "warn", note: sourceKinds.length ? sourceKinds.join(" + ") : "Runtime source unavailable" },
      { role: "EFT Site", title: targetName, state: "Topology destination", state_kind: "info", note: "Canonical endpoint; traversal is not implied" },
    ],
    details: [
      { label: "Source", value: sourceName },
      { label: "Destination", value: targetName },
      { label: "Topology", value: String(properties.epistemic || "inferred") },
      { label: "Runtime boundary", value: listenerCurrent && pncCurrent ? "current" : "incomplete" },
      { label: "Transfer completion", value: humanize(completion) },
      { label: "Path-scoped gaps", value: String(gaps.length) },
    ],
    evidence: [
      { label: "Site activity", state: String(siteAccess.time_scope || "unknown"), detail: `${String(siteAccess.activity_window_start || "No start")} · ${String(siteAccess.activity_window_end || "No end")}` },
      { label: "Listener", state: listenerCurrent ? "current observed" : "unknown", detail: `${String(listener.endpoint || "No endpoint")} · ${gateway}` },
      { label: "PNC boundary", state: pncCurrent ? "current corroborated" : "unknown", detail: `${String(corroborated.endpoint || "PNC boundary")} · ${sourceKinds.length ? sourceKinds.join(" + ") : "runtime source unavailable"}` },
      { label: "Transfer outcome", state: humanize(completion), detail: "Independent from route qualification · no completed transfer is implied" },
    ],
    evidence_classes: parseJson(row.evidence_classes_json, []),
    source_ids: parseJson(row.source_ids_json, []),
  };
}

function messagingPath(row: Row, source: JsonMap, target: JsonMap, gaps: JsonMap[]): JsonMap {
  const properties = parseJson(row.properties_json, {}) as JsonMap;
  const corroboration = Array.isArray(properties.runtime_corroboration) ? properties.runtime_corroboration as JsonMap[] : [];
  const sourceName = String(source.display_name || source.identity_key || "DataPower service");
  const targetName = String(target.display_name || target.identity_key || "MQ queue");
  const queueManager = String(properties.queue_manager || target.properties?.queue_manager || "MQ queue manager");
  const channel = properties.channel ? String(properties.channel) : null;
  const channelResolution = String(properties.channel_resolution || (channel ? "configured" : "unavailable"));
  const backendGroup = String(properties.backend_group || "DataPower backend");
  const staticResource = String(properties.static_resource || "Static route resource");
  const runtimeHosts = [...new Set(corroboration.map((item) => item?.physical_host).filter(Boolean).map(String))];
  const sampleConnections = corroboration.reduce((sum, item) => sum + (Number.isFinite(Number(item?.sample_connection_count)) ? Number(item.sample_connection_count) : 0), 0);
  const runtimeSupported = corroboration.length > 0;
  const runtimeDetail = runtimeSupported
    ? `${runtimeHosts.length ? runtimeHosts.join(" + ") : "DataPower runtime"}${sampleConnections ? ` · ${sampleConnections} sampled connection${sampleConnections === 1 ? "" : "s"}` : ""}`
    : "No independent MQ connectivity corroboration attached";

  return {
    id: String(row.relation_id),
    domain: "messaging",
    domain_label: "Messaging",
    source: { id: source.entity_id, name: sourceName, semantic_type: source.semantic_type },
    destination: { id: target.entity_id, name: targetName, semantic_type: target.semantic_type },
    label: `Messaging · ${sourceName} → ${targetName}`,
    qualification: { qualified: true, epistemic: properties.epistemic ?? "derived", route_domain: "messaging" },
    runtime_boundary: runtimeSupported ? "current" : "incomplete",
    runtime_boundary_label: runtimeSupported ? "MQ connectivity independently corroborated" : "MQ connectivity corroboration unavailable",
    outcome: "not_established",
    outcome_label: "Message traversal not established",
    gap_count: gaps.length,
    gaps,
    explanation: "A deterministic DataPower configuration route reaches the MQ queue in the canonical estate. Independent MQ connectivity corroboration supports the runtime boundary only; it does not prove a specific message traversal.",
    nodes: [
      { role: "DataPower service", title: sourceName, state: "Configured", state_kind: "info", note: String(source.properties?.domain || source.properties?.physical_host || "Canonical DataPower service") },
      { role: "Static route", title: backendGroup, state: "Derived from config", state_kind: "info", note: staticResource },
      { role: "MQ boundary", title: channel ? `${queueManager} · ${channel}` : queueManager, state: runtimeSupported ? "Corroborated" : "Unknown", state_kind: runtimeSupported ? "good" : "warn", note: runtimeDetail },
      { role: "MQ queue", title: targetName, state: "Configured target", state_kind: "info", note: "Canonical queue target; message traversal is not implied" },
    ],
    details: [
      { label: "Source", value: sourceName },
      { label: "Destination", value: targetName },
      { label: "Topology", value: String(properties.epistemic || "derived") },
      { label: "Queue manager", value: queueManager },
      { label: "Channel", value: channel ? `${channel} · ${humanize(channelResolution)}` : humanize(channelResolution) },
      { label: "Message outcome", value: "not established" },
    ],
    evidence: [
      { label: "Route configuration", state: "configured + derived", detail: `${String(properties.route_uri_literal || "Route URI retained in canonical relation")} · ${staticResource}` },
      { label: "Backend mapping", state: "configured", detail: `${backendGroup} · channel ${channel ? `${channel} (${humanize(channelResolution)})` : humanize(channelResolution)}` },
      { label: "MQ connectivity", state: runtimeSupported ? "observed corroboration" : "unknown", detail: runtimeDetail },
      { label: "Message outcome", state: "not established", detail: "Qualified configuration and runtime connectivity do not prove PUT, GET, or end-to-end message traversal" },
    ],
    evidence_classes: parseJson(row.evidence_classes_json, []),
    source_ids: parseJson(row.source_ids_json, []),
  };
}

async function listOperationalPaths(db: D1Database, limit: number, offset: number): Promise<PathListResult> {
  const estate = await freshEstate(db);
  if (!estate) return { response: reply({ detail: "No current canonical estate" }, 404) };
  if (estate instanceof Response) return { response: estate };
  const estateId = String(estate.estate_revision_id);
  const predicate = `r.semantic_type='integration.routes_to'
    AND json_extract(r.properties_json,'$.qualified_route')=1
    AND ((s.semantic_type='filetransfer.flow' AND t.semantic_type='filetransfer.endpoint' AND json_extract(r.properties_json,'$.route_kind')='eft_inbound_site_path')
      OR (s.semantic_type='datapower.service' AND t.semantic_type='mq.queue'))`;

  const [rows, count] = await db.batch([
    db.prepare(`SELECT r.relation_id,r.observed_at,r.properties_json,r.evidence_classes_json,r.source_ids_json,
                       s.entity_id AS s_entity_id,s.semantic_type AS s_semantic_type,s.identity_key AS s_identity_key,s.identity_state AS s_identity_state,s.display_name AS s_display_name,s.observed_at AS s_observed_at,s.properties_json AS s_properties_json,s.evidence_classes_json AS s_evidence_classes_json,s.source_ids_json AS s_source_ids_json,s.evidence_count AS s_evidence_count,s.source_count AS s_source_count,
                       t.entity_id AS t_entity_id,t.semantic_type AS t_semantic_type,t.identity_key AS t_identity_key,t.identity_state AS t_identity_state,t.display_name AS t_display_name,t.observed_at AS t_observed_at,t.properties_json AS t_properties_json,t.evidence_classes_json AS t_evidence_classes_json,t.source_ids_json AS t_source_ids_json,t.evidence_count AS t_evidence_count,t.source_count AS t_source_count
                  FROM semantic_estate_relation r
                  JOIN semantic_estate_entity s ON s.estate_revision_id=r.estate_revision_id AND s.entity_id=r.source_entity_id
                  JOIN semantic_estate_entity t ON t.estate_revision_id=r.estate_revision_id AND t.entity_id=r.target_entity_id
                 WHERE r.estate_revision_id=? AND ${predicate}
                 ORDER BY CASE WHEN s.semantic_type='datapower.service' THEN 0 ELSE 1 END,
                          lower(COALESCE(s.display_name,'')),lower(COALESCE(t.display_name,'')),r.relation_id
                 LIMIT ? OFFSET ?`).bind(estateId, limit, offset),
    db.prepare(`SELECT COUNT(*) AS count
                  FROM semantic_estate_relation r
                  JOIN semantic_estate_entity s ON s.estate_revision_id=r.estate_revision_id AND s.entity_id=r.source_entity_id
                  JOIN semantic_estate_entity t ON t.estate_revision_id=r.estate_revision_id AND t.entity_id=r.target_entity_id
                 WHERE r.estate_revision_id=? AND ${predicate}`).bind(estateId),
  ]);

  const rawRows = (rows.results ?? []) as Row[];
  const ids = rawRows.flatMap((row) => [String(row.s_entity_id || ""), String(row.t_entity_id || "")]);
  const unresolved = await unresolvedFor(db, estateId, ids);
  const gapsBySource = new Map<string, JsonMap[]>();
  for (const gap of unresolved) {
    const key = String(gap.source_entity_id || "");
    const bucket = gapsBySource.get(key) ?? [];
    bucket.push(gap);
    gapsBySource.set(key, bucket);
  }

  const paths = rawRows.map((row) => {
    const source = entityFromRow(row, "s");
    const target = entityFromRow(row, "t");
    const gaps = [
      ...(gapsBySource.get(String(source.entity_id || "")) ?? []),
      ...(gapsBySource.get(String(target.entity_id || "")) ?? []),
    ];
    return source.semantic_type === "filetransfer.flow"
      ? fileTransferPath(row, source, target, gaps)
      : messagingPath(row, source, target, gaps);
  });
  const total = Number(((count.results ?? [])[0] as Row | undefined)?.count || 0);
  return {
    data: {
      estate: estateMetadata(estate, estateId),
      page: { total, limit, offset, next_offset: offset + paths.length < total ? offset + paths.length : null },
      paths,
    },
  };
}

async function originalJson(request: Request, env: OperatorReadModelEnv): Promise<{ response: Response; body: JsonMap | null }> {
  const response = await handleOperatorReadModel(request, env);
  if (!response) return { response: reply({ detail: "Operator read model did not own request" }, 500), body: null };
  let body: JsonMap | null = null;
  try { body = await response.clone().json() as JsonMap; } catch {}
  return { response, body };
}

function compactPath(path: JsonMap): JsonMap {
  return {
    id: path.id,
    domain: path.domain,
    domain_label: path.domain_label,
    source: path.source,
    destination: path.destination,
    label: path.label,
    qualification: path.qualification,
    runtime_boundary: path.runtime_boundary,
    runtime_boundary_label: path.runtime_boundary_label,
    outcome: path.outcome,
    outcome_label: path.outcome_label,
    gap_count: path.gap_count,
    gaps: path.gaps,
  };
}

export async function handleMultiDomainOperatorPaths(request: Request, env: OperatorReadModelEnv): Promise<Response | null> {
  if (request.method !== "GET") return null;
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/v2/operator/paths") {
    const result = await listOperationalPaths(env.DB, Math.max(1, integerParam(url, "limit", 25, 50)), integerParam(url, "offset", 0, MAX_OFFSET));
    if ("response" in result) return result.response;
    return reply({ schema_version: "osi.operator.paths/v2", ...result.data });
  }

  if (path === "/api/v2/operator/overview") {
    const original = await originalJson(request, env);
    if (!original.response.ok || !original.body) return original.response;
    const result = await listOperationalPaths(env.DB, 4, 0);
    if ("response" in result) return result.response;
    return reply({
      ...original.body,
      schema_version: "osi.operator.overview/v2",
      paths: { total: result.data.page.total, items: result.data.paths.map(compactPath) },
    });
  }

  if (/^\/api\/v2\/operator\/investigations\/find_[0-9a-f]{24}$/.test(path)) {
    const original = await originalJson(request, env);
    if (!original.response.ok || !original.body) return original.response;
    const finding = original.body.finding ?? {};
    const refs = new Set([
      String(finding.entity_id || ""),
      ...(Array.isArray(finding.related_entities) ? finding.related_entities.map(String) : []),
    ].filter(Boolean));
    if (!refs.size) return original.response;
    const result = await listOperationalPaths(env.DB, 50, 0);
    if ("response" in result) return result.response;
    const matched = result.data.paths.find((item) => refs.has(String(item.source?.id || "")) || refs.has(String(item.destination?.id || "")));
    return reply({
      ...original.body,
      schema_version: "osi.operator.investigation-detail/v2",
      path_context: matched ? compactPath(matched) : null,
    });
  }

  return null;
}
