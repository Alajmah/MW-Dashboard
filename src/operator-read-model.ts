import { handleIntegratedRoutes } from "./integrated-routes";
import { handleOperationalFindings } from "./operational-findings";
import { activeSituationPage } from "./operator-situations";
import { handleSemanticEstate } from "./semantic-estate";
import { handleSemanticEstateRead } from "./semantic-estate-read";
import { handleSemanticImport } from "./semantic-import";
import { handleTelemetryIngest } from "./telemetry-ingest";

export interface OperatorReadModelEnv {
  DB: D1Database;
  ADMIN_IMPORT_TOKEN?: string;
  TELEMETRY_INGEST_ENABLED?: string;
  TELEMETRY_INGEST_KEYS_JSON?: string;
}

type JsonMap = Record<string, any>;
type Handler = (request: Request, env: any) => Promise<Response | null>;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};
const MAX_OFFSET = 100_000;

function reply(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS });
}

class OperatorReadError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

function integerParam(url: URL, name: string, fallback: number, maximum: number): number {
  const raw = url.searchParams.get(name);
  if (raw == null || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.min(value, maximum);
}

function textParam(url: URL, name: string, maximum = 300): string {
  return (url.searchParams.get(name) ?? "").trim().slice(0, maximum);
}

function subrequest(request: Request, path: string): Request {
  return new Request(new URL(path, request.url).toString(), {
    method: "GET",
    headers: { accept: "application/json" },
  });
}

async function callJson(
  request: Request,
  path: string,
  handler: Handler,
  handlerEnv: unknown,
  label: string,
  acceptedErrors: number[] = [],
): Promise<JsonMap> {
  const response = await handler(subrequest(request, path), handlerEnv);
  if (!response) throw new OperatorReadError(500, `${label} handler did not own the request`);
  let body: JsonMap = {};
  try { body = await response.json() as JsonMap; } catch {}
  if (!response.ok && !acceptedErrors.includes(response.status)) {
    throw new OperatorReadError(response.status, String(body.detail || `${label} failed`), body.code ? String(body.code) : undefined);
  }
  return { ...body, _http_status: response.status };
}

function estateEnv(env: OperatorReadModelEnv) {
  return { DB: env.DB, ADMIN_IMPORT_TOKEN: env.ADMIN_IMPORT_TOKEN };
}

function telemetryEnv(env: OperatorReadModelEnv) {
  return {
    DB: env.DB,
    TELEMETRY_INGEST_ENABLED: env.TELEMETRY_INGEST_ENABLED,
    TELEMETRY_INGEST_KEYS_JSON: env.TELEMETRY_INGEST_KEYS_JSON,
  };
}

function semanticEnv(env: OperatorReadModelEnv) {
  return { DB: env.DB };
}

function severityRank(value: unknown): number {
  const severity = String(value || "").toLowerCase();
  if (severity === "critical") return 0;
  if (severity === "warning") return 1;
  return 2;
}

function lastSeenMillis(value: unknown): number {
  const time = new Date(String(value || "")).getTime();
  return Number.isFinite(time) ? time : 0;
}

function operationalPublished(operations: JsonMap): boolean {
  return Number(operations.current_sources || 0) > 0;
}

function normalizeGap(raw: JsonMap) {
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

function humanizeSourceKind(value: unknown): string {
  return String(value || "").replaceAll("_", " ");
}

function projectQualifiedPath(trace: JsonMap, compact = false) {
  const semantics = trace.semantics && typeof trace.semantics === "object" ? trace.semantics as JsonMap : {};
  const step = Array.isArray(trace.steps) ? (trace.steps[0] as JsonMap | undefined) ?? {} : {};
  const properties = step.properties && typeof step.properties === "object" ? step.properties as JsonMap : {};
  const siteAccess = semantics.site_access_evidence && typeof semantics.site_access_evidence === "object"
    ? semantics.site_access_evidence as JsonMap
    : {};
  const listener = semantics.current_listener_evidence && typeof semantics.current_listener_evidence === "object"
    ? semantics.current_listener_evidence as JsonMap
    : {};
  const corroboration = Array.isArray(semantics.runtime_corroboration) ? semantics.runtime_corroboration as JsonMap[] : [];
  const corroborated = corroboration.find((item) => item?.time_scope === "current" && item?.independently_corroborated === true) ?? corroboration[0] ?? {};
  const listenerCurrent = listener.time_scope === "current";
  const pncCurrent = corroboration.some((item) => item?.time_scope === "current" && item?.independently_corroborated === true);
  const sourceKinds = Array.isArray(corroborated.sources)
    ? [...new Set((corroborated.sources as JsonMap[]).map((item) => item?.source_kind).filter(Boolean).map(humanizeSourceKind))]
    : [];
  const source = trace.source && typeof trace.source === "object" ? trace.source as JsonMap : {};
  const target = trace.target && typeof trace.target === "object" ? trace.target as JsonMap : {};
  const gaps = Array.isArray(trace.unresolved) ? trace.unresolved.map((item: JsonMap) => normalizeGap(item)) : [];
  const completion = String(semantics.transfer_completion || "unknown");
  const gateway = String(properties.gateway_server_key || corroborated.gateway_server_key || "DMZ gateway");
  const sourceName = String(source.display_name || source.identity_key || "Access context");
  const destinationName = String(target.display_name || target.identity_key || "EFT Site");
  const relationId = String(step.relation_id || `${source.entity_id || "source"}:${target.entity_id || "target"}`);

  const base = {
    id: relationId,
    source: { id: source.entity_id ?? null, name: sourceName, semantic_type: source.semantic_type ?? null },
    destination: { id: target.entity_id ?? null, name: destinationName, semantic_type: target.semantic_type ?? null },
    label: `${sourceName} → ${destinationName}`,
    qualification: {
      qualified: semantics.qualified_route === true,
      epistemic: semantics.derived_epistemic ?? "qualified",
      route_domain: semantics.route_domain ?? null,
    },
    runtime_boundary: listenerCurrent && pncCurrent ? "current" : "incomplete",
    transfer_completion: completion,
    gap_count: gaps.length,
    gaps,
  };

  if (compact) return base;

  return {
    ...base,
    explanation: trace.explanation ?? "Evidence-qualified topology path",
    nodes: [
      {
        role: "Access context",
        title: sourceName,
        state: siteAccess.time_scope === "historical" ? "Historical" : siteAccess.time_scope === "current" ? "Current" : "Unknown",
        state_kind: siteAccess.time_scope === "historical" ? "info" : siteAccess.time_scope === "current" ? "good" : "warn",
        note: siteAccess.time_scope === "historical" ? "Observed Site-access window retained" : "Site-access evidence not classified",
      },
      {
        role: "DMZ listener",
        title: String(listener.endpoint || "Listener endpoint"),
        state: listenerCurrent ? "Current" : "Unknown",
        state_kind: listenerCurrent ? "good" : "warn",
        note: gateway,
      },
      {
        role: "PNC boundary",
        title: String(corroborated.endpoint || "PNC boundary"),
        state: pncCurrent ? "Corroborated" : "Unknown",
        state_kind: pncCurrent ? "good" : "warn",
        note: sourceKinds.length ? sourceKinds.join(" + ") : "Runtime source unavailable",
      },
      {
        role: "EFT Site",
        title: destinationName,
        state: "Topology destination",
        state_kind: "info",
        note: "Canonical endpoint; traversal is not implied",
      },
    ],
    details: [
      { label: "Source", value: sourceName },
      { label: "Destination", value: destinationName },
      { label: "Topology", value: String(semantics.derived_epistemic || "qualified") },
      { label: "Runtime boundary", value: listenerCurrent && pncCurrent ? "current" : "incomplete" },
      { label: "Transfer completion", value: completion.replaceAll("_", " ") },
      { label: "Path-scoped gaps", value: String(gaps.length) },
    ],
    evidence: [
      {
        label: "Site activity",
        state: String(siteAccess.time_scope || "unknown"),
        detail: `${String(siteAccess.activity_window_start || "No start")} · ${String(siteAccess.activity_window_end || "No end")}`,
      },
      {
        label: "Listener",
        state: listenerCurrent ? "current observed" : "unknown",
        detail: `${String(listener.endpoint || "No endpoint")} · ${gateway}`,
      },
      {
        label: "PNC boundary",
        state: pncCurrent ? "current corroborated" : "unknown",
        detail: `${String(corroborated.endpoint || "PNC boundary")} · ${sourceKinds.length ? sourceKinds.join(" + ") : "runtime source unavailable"}`,
      },
      {
        label: "Transfer outcome",
        state: completion.replaceAll("_", " "),
        detail: "Independent from route qualification · no transaction success is implied",
      },
    ],
    evidence_classes: Array.isArray(step.evidence_classes) ? step.evidence_classes : [],
    source_ids: Array.isArray(step.source_ids) ? step.source_ids : [],
  };
}

async function overview(request: Request, env: OperatorReadModelEnv): Promise<Response> {
  const [estateStatus, operations, openFindings, acknowledgedFindings, unresolved, paths, situations] = await Promise.all([
    callJson(request, "/api/v2/estate/status", handleSemanticEstate, estateEnv(env), "Estate status"),
    callJson(request, "/api/v2/operations/status", handleOperationalFindings, estateEnv(env), "Operations status"),
    callJson(request, "/api/v2/findings/current?status=OPEN&limit=6&offset=0", handleOperationalFindings, estateEnv(env), "Open findings"),
    callJson(request, "/api/v2/findings/current?status=ACKNOWLEDGED&limit=6&offset=0", handleOperationalFindings, estateEnv(env), "Acknowledged findings"),
    callJson(request, "/api/v2/estate/current/unresolved?limit=4&offset=0", handleSemanticEstateRead, semanticEnv(env), "Unresolved references"),
    callJson(request, "/api/v2/routes/qualified?domain=file_transfer&limit=4&offset=0", handleIntegratedRoutes, semanticEnv(env), "Qualified paths"),
    activeSituationPage(env.DB, 6, 0),
  ]);

  const estate = estateStatus.current_estate ?? {};
  const published = operationalPublished(operations);
  const attention = published
    ? [...(openFindings.findings ?? []), ...(acknowledgedFindings.findings ?? [])]
      .sort((a: JsonMap, b: JsonMap) => severityRank(a.severity) - severityRank(b.severity) || lastSeenMillis(b.last_seen) - lastSeenMillis(a.last_seen))
      .slice(0, 6)
    : [];

  return reply({
    schema_version: "osi.operator.overview/v1",
    estate: {
      revision_id: estate.estate_revision_id ?? null,
      fresh: estateStatus.estate_fresh === true,
      entity_count: Number(estate.entity_count || 0),
      relation_count: Number(estate.relation_count || 0),
      unresolved_count: Number(estate.unresolved_count || 0),
    },
    operations: {
      published,
      open_findings: published ? Number(openFindings.page?.total || 0) : null,
      acknowledged_findings: published ? Number(acknowledgedFindings.page?.total || 0) : null,
      active_situations: published ? situations.total : null,
      observations: published ? Number(operations.current_observations || 0) : null,
      coverage_gaps: published ? Number(operations.current_coverage_gaps || 0) : null,
    },
    attention,
    situations: {
      total: published ? situations.total : null,
      items: published ? situations.items : [],
    },
    paths: {
      total: Number(paths.page?.total || 0),
      items: Array.isArray(paths.routes) ? paths.routes.map((trace: JsonMap) => projectQualifiedPath(trace, true)) : [],
    },
    limitations: {
      total: Number(unresolved.page?.total || 0),
      items: Array.isArray(unresolved.unresolved) ? unresolved.unresolved.map((item: JsonMap) => normalizeGap(item)) : [],
    },
  });
}

async function paths(request: Request, env: OperatorReadModelEnv): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.max(1, integerParam(url, "limit", 25, 50));
  const offset = integerParam(url, "offset", 0, MAX_OFFSET);
  const data = await callJson(
    request,
    `/api/v2/routes/qualified?domain=file_transfer&limit=${limit}&offset=${offset}`,
    handleIntegratedRoutes,
    semanticEnv(env),
    "Qualified paths",
  );
  return reply({
    schema_version: "osi.operator.paths/v1",
    estate: data.estate ?? null,
    page: data.page ?? { total: 0, limit, offset, next_offset: null },
    paths: Array.isArray(data.routes) ? data.routes.map((trace: JsonMap) => projectQualifiedPath(trace, false)) : [],
  });
}

function preferredExploreTypes(summary: JsonMap) {
  const counts = summary.entities_by_type && typeof summary.entities_by_type === "object" ? summary.entities_by_type as JsonMap : {};
  const preferred = [
    "filetransfer.flow",
    "filetransfer.endpoint",
    "mq.listener",
    "mq.queue_manager",
    "mq.queue",
    "mq.channel",
    "infra.host",
    "app.application",
  ];
  return preferred
    .filter((type) => Number(counts[type] || 0) > 0)
    .slice(0, 6)
    .map((type) => ({ semantic_type: type, count: Number(counts[type] || 0) }));
}

async function explore(request: Request, env: OperatorReadModelEnv): Promise<Response> {
  const url = new URL(request.url);
  const q = textParam(url, "q", 200);
  const semanticType = textParam(url, "semantic_type", 200);
  const limit = Math.max(1, integerParam(url, "limit", 25, 50));
  const offset = integerParam(url, "offset", 0, MAX_OFFSET);
  const summary = await callJson(request, "/api/v2/estate/current/summary", handleSemanticEstateRead, semanticEnv(env), "Estate summary");
  const filters = {
    total_entities: Number(summary.counts?.entities || 0),
    semantic_types: preferredExploreTypes(summary),
  };
  if (!q && !semanticType) {
    return reply({
      schema_version: "osi.operator.explore/v1",
      estate: summary.estate ?? null,
      mode: "entry",
      query: { q: "", semantic_type: null },
      page: { total: 0, limit, offset: 0, next_offset: null },
      filters,
      items: [],
    });
  }
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (q) params.set("q", q);
  if (semanticType) params.set("semantic_type", semanticType);
  const entities = await callJson(request, `/api/v2/estate/current/entities?${params.toString()}`, handleSemanticEstateRead, semanticEnv(env), "Estate search");
  return reply({
    schema_version: "osi.operator.explore/v1",
    estate: summary.estate ?? entities.estate ?? null,
    mode: "results",
    query: { q, semantic_type: semanticType || null },
    page: entities.page ?? { total: 0, limit, offset, next_offset: null },
    filters,
    items: entities.entities ?? [],
  });
}

async function exploreDetail(request: Request, env: OperatorReadModelEnv, entityId: string): Promise<Response> {
  const detail = await callJson(
    request,
    `/api/v2/estate/current/entities/${encodeURIComponent(entityId)}?relation_limit=40`,
    handleSemanticEstateRead,
    semanticEnv(env),
    "Entity detail",
  );
  const entity = detail.entity ?? {};
  return reply({
    schema_version: "osi.operator.explore-detail/v1",
    estate: detail.estate ?? null,
    entity,
    relations: detail.relations ?? [],
    presentation: {
      related_count: Array.isArray(detail.relations) ? detail.relations.length : 0,
      evidence_count: Number(entity.evidence_count || 0),
      source_count: Number(entity.source_count || 0),
    },
  });
}

async function activeFindingCounts(db: D1Database): Promise<{ open: number; acknowledged: number }> {
  const result = await db.prepare(
    `WITH current_ids AS (
       SELECT DISTINCT f.finding_id
         FROM operational_finding_occurrence f
         JOIN operational_evaluation_revision r ON r.evaluation_revision_id = f.evaluation_revision_id
        WHERE r.is_current = 1
     )
     SELECT COALESCE(s.status, 'OPEN') AS status, COUNT(*) AS count
       FROM current_ids c
       LEFT JOIN operational_finding_state s ON s.finding_id = c.finding_id
      WHERE COALESCE(s.status, 'OPEN') IN ('OPEN','ACKNOWLEDGED')
      GROUP BY COALESCE(s.status, 'OPEN')`
  ).all<JsonMap>();
  let open = 0;
  let acknowledged = 0;
  for (const row of result.results ?? []) {
    if (row.status === "OPEN") open = Number(row.count || 0);
    if (row.status === "ACKNOWLEDGED") acknowledged = Number(row.count || 0);
  }
  return { open, acknowledged };
}

async function activeFindingPage(db: D1Database, limit: number, offset: number): Promise<JsonMap[]> {
  const result = await db.prepare(
    `WITH ranked AS (
       SELECT f.finding_id, f.rule_id, f.entity_id, f.semantic_type, f.display_name, f.severity,
              f.summary, f.diagnosis, f.first_seen, f.last_seen, f.coverage_state,
              COALESCE(s.status, 'OPEN') AS status,
              ROW_NUMBER() OVER (
                PARTITION BY f.finding_id
                ORDER BY f.last_seen DESC, r.evaluated_at DESC, r.evaluation_revision_id DESC
              ) AS occurrence_rank
         FROM operational_finding_occurrence f
         JOIN operational_evaluation_revision r ON r.evaluation_revision_id = f.evaluation_revision_id
         LEFT JOIN operational_finding_state s ON s.finding_id = f.finding_id
        WHERE r.is_current = 1
          AND COALESCE(s.status, 'OPEN') IN ('OPEN','ACKNOWLEDGED')
     )
     SELECT finding_id, rule_id, entity_id, semantic_type, display_name, severity,
            summary, diagnosis, first_seen, last_seen, coverage_state, status
       FROM ranked
      WHERE occurrence_rank = 1
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
               last_seen DESC, lower(display_name), finding_id
      LIMIT ? OFFSET ?`
  ).bind(limit, offset).all<JsonMap>();
  return result.results ?? [];
}

async function investigations(request: Request, env: OperatorReadModelEnv): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.max(1, integerParam(url, "limit", 20, 50));
  const offset = integerParam(url, "offset", 0, MAX_OFFSET);
  const operations = await callJson(request, "/api/v2/operations/status", handleOperationalFindings, estateEnv(env), "Operations status");
  const published = operationalPublished(operations);
  if (!published) {
    return reply({
      schema_version: "osi.operator.investigations/v1",
      published: false,
      page: { total: null, limit, offset, next_offset: null },
      counts: { open: null, acknowledged: null },
      items: [],
    });
  }
  const [counts, items] = await Promise.all([
    activeFindingCounts(env.DB),
    activeFindingPage(env.DB, limit, offset),
  ]);
  const total = counts.open + counts.acknowledged;
  return reply({
    schema_version: "osi.operator.investigations/v1",
    published: true,
    page: { total, limit, offset, next_offset: offset + items.length < total ? offset + items.length : null },
    counts,
    items,
  });
}

async function situations(request: Request, env: OperatorReadModelEnv): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.max(1, integerParam(url, "limit", 20, 50));
  const offset = integerParam(url, "offset", 0, MAX_OFFSET);
  const operations = await callJson(request, "/api/v2/operations/status", handleOperationalFindings, estateEnv(env), "Operations status");
  const published = operationalPublished(operations);
  if (!published) {
    return reply({
      schema_version: "osi.operator.situations/v1",
      published: false,
      page: { total: null, limit, offset, next_offset: null },
      counts: { situations: null, open_findings: null, acknowledged_findings: null },
      items: [],
    });
  }
  const [findingCounts, situationPage] = await Promise.all([
    activeFindingCounts(env.DB),
    activeSituationPage(env.DB, limit, offset),
  ]);
  return reply({
    schema_version: "osi.operator.situations/v1",
    published: true,
    page: {
      total: situationPage.total,
      limit,
      offset,
      next_offset: offset + situationPage.items.length < situationPage.total ? offset + situationPage.items.length : null,
    },
    counts: {
      situations: situationPage.total,
      open_findings: findingCounts.open,
      acknowledged_findings: findingCounts.acknowledged,
    },
    items: situationPage.items,
  });
}

async function investigationDetail(request: Request, env: OperatorReadModelEnv, findingId: string): Promise<Response> {
  const detail = await callJson(
    request,
    `/api/v2/findings/current/${encodeURIComponent(findingId)}`,
    handleOperationalFindings,
    estateEnv(env),
    "Finding detail",
    [404],
  );
  if (detail._http_status === 404) return reply({ detail: "Current finding not found" }, 404);
  const finding = detail.finding ?? {};
  const entityId = String(finding.entity_id || "");
  const related = entityId
    ? await callJson(
      request,
      `/api/v2/findings/current?entity_id=${encodeURIComponent(entityId)}&limit=20&offset=0`,
      handleOperationalFindings,
      estateEnv(env),
      "Related findings",
    )
    : { findings: [] };
  const refs = new Set([entityId, ...(Array.isArray(finding.related_entities) ? finding.related_entities.map(String) : [])].filter(Boolean));
  let pathContext: JsonMap | null = null;
  if (refs.size) {
    const pathData = await callJson(
      request,
      "/api/v2/routes/qualified?domain=file_transfer&limit=25&offset=0",
      handleIntegratedRoutes,
      semanticEnv(env),
      "Qualified paths",
    );
    const matching = (pathData.routes ?? []).find((trace: JsonMap) => refs.has(String(trace.source?.entity_id || "")) || refs.has(String(trace.target?.entity_id || "")));
    if (matching) pathContext = projectQualifiedPath(matching, true);
  }
  return reply({
    schema_version: "osi.operator.investigation-detail/v1",
    finding,
    occurrences: detail.occurrences ?? [],
    lifecycle_history: detail.lifecycle_history ?? [],
    related_findings: (related.findings ?? []).filter((item: JsonMap) => item.finding_id !== findingId),
    path_context: pathContext,
  });
}

function domainRollup(summary: JsonMap) {
  const counts = summary.entities_by_type && typeof summary.entities_by_type === "object" ? summary.entities_by_type as JsonMap : {};
  const definitions: Array<[string, (type: string) => boolean]> = [
    ["IBM MQ", (type) => type.startsWith("mq.")],
    ["File transfer", (type) => type.startsWith("filetransfer.")],
    ["Applications", (type) => type.startsWith("app.")],
    ["Infrastructure", (type) => type.startsWith("infra.")],
    ["Integration", (type) => type.startsWith("ace.") || type.startsWith("datapower.") || type.startsWith("integration.")],
  ];
  return definitions.map(([name, matches]) => ({
    name,
    count: Object.entries(counts)
      .filter(([type]) => matches(type))
      .reduce((sum, [, count]) => sum + Number(count || 0), 0),
  })).filter((item) => item.count > 0);
}

async function collection(request: Request, env: OperatorReadModelEnv): Promise<Response> {
  const [estateStatus, summary, operations, importStatus, telemetry] = await Promise.all([
    callJson(request, "/api/v2/estate/status", handleSemanticEstate, estateEnv(env), "Estate status"),
    callJson(request, "/api/v2/estate/current/summary", handleSemanticEstateRead, semanticEnv(env), "Estate summary"),
    callJson(request, "/api/v2/operations/status", handleOperationalFindings, estateEnv(env), "Operations status"),
    callJson(request, "/api/v2/import/status", handleSemanticImport, estateEnv(env), "Import status"),
    callJson(request, "/api/v2/telemetry/status", handleTelemetryIngest, telemetryEnv(env), "Telemetry status", [503]),
  ]);
  const estate = estateStatus.current_estate ?? {};
  const published = operationalPublished(operations);
  return reply({
    schema_version: "osi.operator.collection/v1",
    sources: {
      current: Number(importStatus.current_sources || 0),
      database_ready: importStatus.database_ready === true,
      import_enabled: importStatus.enabled === true,
    },
    estate: {
      revision_id: estate.estate_revision_id ?? null,
      fresh: estateStatus.estate_fresh === true,
      entities: Number(estate.entity_count || 0),
      relations: Number(estate.relation_count || 0),
      unresolved: Number(estate.unresolved_count || 0),
    },
    operations: {
      published,
      findings: published ? Number(operations.current_findings || 0) : null,
      observations: published ? Number(operations.current_observations || 0) : null,
      coverage_gaps: published ? Number(operations.current_coverage_gaps || 0) : null,
    },
    telemetry: {
      database_ready: telemetry.database_ready === true,
      ingress_enabled: telemetry.ingress_enabled === true,
      mode: telemetry.mode ?? "unknown",
    },
    domains: domainRollup(summary),
    boundaries: [
      {
        state: estateStatus.estate_fresh ? "Current estate" : "Stale estate",
        kind: estateStatus.estate_fresh ? "good" : "danger",
        detail: "Canonical estate freshness means the current source set has been reconciled; it does not prove runtime health.",
      },
      {
        state: published ? `${Number(operations.current_findings || 0)} current findings` : "Operational evaluation unavailable",
        kind: published ? "neutral" : "warn",
        detail: published
          ? `${Number(operations.current_observations || 0)} observations support the currently published operational evaluation; these counts are secondary evidence volume, not collection health.`
          : "No current operational evaluation is published, so operational attention and coverage cannot be treated as evaluated.",
      },
      {
        state: published ? `${Number(operations.current_coverage_gaps || 0)} published coverage gaps` : "Coverage unknown",
        kind: published ? (Number(operations.current_coverage_gaps || 0) ? "warn" : "good") : "warn",
        detail: published
          ? "Published gap count is bounded by the operational evaluation sources that exist."
          : "No current operational evaluation is published; zero gaps would not mean complete coverage.",
      },
      {
        state: `${Number(estate.unresolved_count || 0)} unresolved`,
        kind: Number(estate.unresolved_count || 0) ? "warn" : "good",
        detail: "Unknown canonical relationships remain unknown rather than being converted into outages or healthy state.",
      },
      {
        state: telemetry.ingress_enabled ? "Telemetry enabled" : "Telemetry disabled",
        kind: telemetry.ingress_enabled ? "good" : "neutral",
        detail: `${String(telemetry.mode || "Telemetry mode unknown")}.`,
      },
    ],
  });
}

export async function handleOperatorReadModel(request: Request, env: OperatorReadModelEnv): Promise<Response | null> {
  if (request.method !== "GET") return null;
  const url = new URL(request.url);
  const path = url.pathname;
  try {
    if (path === "/api/v2/operator/overview") return await overview(request, env);
    if (path === "/api/v2/operator/paths") return await paths(request, env);
    if (path === "/api/v2/operator/explore") return await explore(request, env);
    if (path === "/api/v2/operator/investigations") return await investigations(request, env);
    if (path === "/api/v2/operator/situations") return await situations(request, env);
    if (path === "/api/v2/operator/collection") return await collection(request, env);

    const exploreMatch = path.match(/^\/api\/v2\/operator\/explore\/([^/]+)$/);
    if (exploreMatch) return await exploreDetail(request, env, decodeURIComponent(exploreMatch[1]));
    const investigationMatch = path.match(/^\/api\/v2\/operator\/investigations\/(find_[0-9a-f]{24})$/);
    if (investigationMatch) return await investigationDetail(request, env, investigationMatch[1]);
    return null;
  } catch (error) {
    if (error instanceof OperatorReadError) {
      return reply({ detail: error.message, code: error.code ?? "OPERATOR_READ_FAILED" }, error.status);
    }
    console.error("operator read model error", error);
    return reply({ detail: "Operator read model failed", code: "OPERATOR_READ_FAILED" }, 500);
  }
}
