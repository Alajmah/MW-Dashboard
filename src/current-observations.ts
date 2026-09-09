import { importAuthorizationDenial } from "./import-auth";

export interface CurrentObservationsEnv {
  DB: D1Database;
  ADMIN_IMPORT_TOKEN?: string;
}

type ObservationCollection = "entities" | "relations" | "unresolved";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const MAX_PAGE = 250;

function reply(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS });
}

function pageParams(request: Request): { limit: number; offset: number } {
  const url = new URL(request.url);
  const rawLimit = Number(url.searchParams.get("limit") ?? 200);
  const rawOffset = Number(url.searchParams.get("offset") ?? 0);
  const limit = Number.isInteger(rawLimit) ? Math.max(1, Math.min(MAX_PAGE, rawLimit)) : 200;
  const offset = Number.isInteger(rawOffset) ? Math.max(0, rawOffset) : 0;
  return { limit, offset };
}

function parseJson(value: unknown, fallback: unknown): unknown {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

async function authorize(request: Request, token?: string): Promise<Response | null> {
  return importAuthorizationDenial(request, token, false);
}

async function currentEntities(request: Request, env: CurrentObservationsEnv): Promise<Response> {
  const denial = await authorize(request, env.ADMIN_IMPORT_TOKEN);
  if (denial) return denial;
  const { limit, offset } = pageParams(request);
  const result = await env.DB.prepare(
    `SELECT r.revision_id, r.source_id, r.source_display_name,
            e.entity_ref, e.semantic_type, e.display_name, e.observed_at, e.evidence_class,
            e.identity_json, e.properties_json, e.evidence_ref
       FROM semantic_source_revision r
       JOIN semantic_entity_observation e ON e.revision_id = r.revision_id
      WHERE r.is_current = 1
      ORDER BY r.revision_id, e.entity_ref
      LIMIT ? OFFSET ?`
  ).bind(limit + 1, offset).all<Record<string, unknown>>();
  const rows = result.results;
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((row) => ({
    revision_id: row.revision_id,
    source_id: row.source_id,
    source_display_name: row.source_display_name,
    ref: row.entity_ref,
    semantic_type: row.semantic_type,
    display_name: row.display_name,
    observed_at: row.observed_at,
    evidence_class: row.evidence_class,
    identity: parseJson(row.identity_json, {}),
    properties: parseJson(row.properties_json, {}),
    evidence_ref: row.evidence_ref,
  }));
  return reply({ collection: "entities", offset, limit, next_offset: hasMore ? offset + limit : null, items });
}

async function currentRelations(request: Request, env: CurrentObservationsEnv): Promise<Response> {
  const denial = await authorize(request, env.ADMIN_IMPORT_TOKEN);
  if (denial) return denial;
  const { limit, offset } = pageParams(request);
  const result = await env.DB.prepare(
    `SELECT r.revision_id, r.source_id, r.source_display_name,
            x.relation_ref, x.semantic_type, x.source_ref, x.target_ref, x.observed_at,
            x.evidence_class, x.properties_json, x.evidence_ref
       FROM semantic_source_revision r
       JOIN semantic_relation_observation x ON x.revision_id = r.revision_id
      WHERE r.is_current = 1
      ORDER BY r.revision_id, x.relation_ref
      LIMIT ? OFFSET ?`
  ).bind(limit + 1, offset).all<Record<string, unknown>>();
  const rows = result.results;
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((row) => ({
    revision_id: row.revision_id,
    source_id: row.source_id,
    source_display_name: row.source_display_name,
    ref: row.relation_ref,
    semantic_type: row.semantic_type,
    source_ref: row.source_ref,
    target_ref: row.target_ref,
    observed_at: row.observed_at,
    evidence_class: row.evidence_class,
    properties: parseJson(row.properties_json, {}),
    evidence_ref: row.evidence_ref,
  }));
  return reply({ collection: "relations", offset, limit, next_offset: hasMore ? offset + limit : null, items });
}

async function currentUnresolved(request: Request, env: CurrentObservationsEnv): Promise<Response> {
  const denial = await authorize(request, env.ADMIN_IMPORT_TOKEN);
  if (denial) return denial;
  const { limit, offset } = pageParams(request);
  const result = await env.DB.prepare(
    `SELECT r.revision_id, r.source_id, r.source_display_name,
            u.unresolved_ref, u.source_ref, u.semantic_type, u.expected_target_type, u.vendor_value,
            u.state, u.reason, u.observed_at, u.evidence_class, u.candidate_refs_json,
            u.properties_json, u.evidence_ref
       FROM semantic_source_revision r
       JOIN semantic_unresolved_reference u ON u.revision_id = r.revision_id
      WHERE r.is_current = 1
      ORDER BY r.revision_id, u.unresolved_ref
      LIMIT ? OFFSET ?`
  ).bind(limit + 1, offset).all<Record<string, unknown>>();
  const rows = result.results;
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((row) => ({
    revision_id: row.revision_id,
    source_id: row.source_id,
    source_display_name: row.source_display_name,
    ref: row.unresolved_ref,
    source_ref: row.source_ref,
    semantic_type: row.semantic_type,
    expected_target_type: row.expected_target_type,
    vendor_value: row.vendor_value,
    state: row.state,
    reason: row.reason,
    observed_at: row.observed_at,
    evidence_class: row.evidence_class,
    candidate_refs: parseJson(row.candidate_refs_json, []),
    properties: parseJson(row.properties_json, {}),
    evidence_ref: row.evidence_ref,
  }));
  return reply({ collection: "unresolved", offset, limit, next_offset: hasMore ? offset + limit : null, items });
}

export async function handleCurrentObservations(request: Request, env: CurrentObservationsEnv): Promise<Response | null> {
  if (request.method !== "GET") return null;
  const match = new URL(request.url).pathname.match(/^\/api\/v2\/observations\/current\/(entities|relations|unresolved)$/);
  if (!match) return null;
  const collection = match[1] as ObservationCollection;
  if (collection === "entities") return currentEntities(request, env);
  if (collection === "relations") return currentRelations(request, env);
  return currentUnresolved(request, env);
}
