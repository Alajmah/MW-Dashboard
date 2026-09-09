import { importAuthorizationDenial } from "./import-auth";

export interface SemanticEstateEnv {
  DB: D1Database;
  ADMIN_IMPORT_TOKEN?: string;
}

type JsonMap = Record<string, unknown>;
type EstateCollection = "entities" | "relations" | "unresolved";

class EstateHttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const SHA256_RE = /^[0-9a-f]{64}$/i;
const MAX_CHUNK_ITEMS = 75;
const MAX_ITEMS = 100_000;
const IDENTITY_STATES = new Set(["resolved", "ambiguous", "conflicted"]);

function reply(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS });
}

function asObject(value: unknown, label: string): JsonMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EstateHttpError(400, `${label} must be an object`);
  }
  return value as JsonMap;
}

function asArray(value: unknown, label: string, max = MAX_ITEMS): unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new EstateHttpError(400, `${label} must be an array with at most ${max} items`);
  }
  return value;
}

function requiredString(value: unknown, label: string, max = 1500): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new EstateHttpError(400, `${label} must be a non-empty string`);
  }
  const result = value.trim();
  if (result.length > max) throw new EstateHttpError(400, `${label} exceeds ${max} characters`);
  return result;
}

function optionalString(value: unknown, max = 1500): string | null {
  if (value == null || value === "") return null;
  return requiredString(value, "value", max);
}

function integer(value: unknown, label: string, max = MAX_ITEMS): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > max) {
    throw new EstateHttpError(400, `${label} must be an integer between 0 and ${max}`);
  }
  return Number(value);
}

function stringArray(value: unknown, label: string, max = MAX_ITEMS): string[] {
  return asArray(value, label, max).map((item, index) => requiredString(item, `${label}[${index}]`, 1500));
}

async function jsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new EstateHttpError(415, "Content-Type must be application/json");
  }
  try {
    return await request.json();
  } catch {
    throw new EstateHttpError(400, "Request body must contain valid JSON");
  }
}

async function authorize(request: Request, configuredToken?: string): Promise<void> {
  const denial = await importAuthorizationDenial(request, configuredToken, false);
  if (!denial) return;
  let detail = "Invalid or missing import authorization";
  try {
    const body = await denial.json() as { detail?: string };
    if (body.detail) detail = body.detail;
  } catch {}
  throw new EstateHttpError(denial.status, detail);
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizedSourceIds(values: string[]): string[] {
  return [...new Set(values)].sort();
}

async function sourceSetHash(values: string[]): Promise<string> {
  return sha256Hex(normalizedSourceIds(values).join("\n"));
}

async function currentSourceRevisionIds(db: D1Database): Promise<string[]> {
  const result = await db.prepare(
    "SELECT revision_id FROM semantic_source_revision WHERE is_current = 1 ORDER BY revision_id"
  ).all<{ revision_id: string }>();
  return result.results.map((row) => String(row.revision_id));
}

function sameStringSet(left: string[], right: string[]): boolean {
  const a = normalizedSourceIds(left);
  const b = normalizedSourceIds(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function stagingEstate(db: D1Database, estateRevisionId: string): Promise<Record<string, unknown>> {
  const row = await db.prepare(
    "SELECT * FROM semantic_estate_revision WHERE estate_revision_id = ? LIMIT 1"
  ).bind(estateRevisionId).first<Record<string, unknown>>();
  if (!row) throw new EstateHttpError(404, "Canonical estate revision not found");
  if (row.status !== "STAGING") throw new EstateHttpError(409, `Estate revision is ${row.status}, not STAGING`);
  return row;
}

async function createEstateRevision(request: Request, env: SemanticEstateEnv): Promise<Response> {
  await authorize(request, env.ADMIN_IMPORT_TOKEN);
  const body = asObject(await jsonBody(request), "manifest");
  const sourceRevisionIds = normalizedSourceIds(stringArray(body.source_revision_ids, "source_revision_ids", 1000));
  if (!sourceRevisionIds.length) throw new EstateHttpError(400, "source_revision_ids must not be empty");
  const currentIds = await currentSourceRevisionIds(env.DB);
  if (!sameStringSet(sourceRevisionIds, currentIds)) {
    throw new EstateHttpError(409, "Canonical estate source set is not the current source set", {
      supplied: sourceRevisionIds,
      current: currentIds,
    });
  }

  const suppliedHash = requiredString(body.source_set_hash, "source_set_hash", 64).toLowerCase();
  if (!SHA256_RE.test(suppliedHash)) throw new EstateHttpError(400, "source_set_hash must be a SHA-256 hex digest");
  const expectedHash = await sourceSetHash(sourceRevisionIds);
  if (suppliedHash !== expectedHash) {
    throw new EstateHttpError(400, "source_set_hash does not match source_revision_ids", { expected: expectedHash });
  }

  const counts = asObject(body.counts, "counts");
  const estateRevisionId = `estate_${crypto.randomUUID()}`;
  const builtAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO semantic_estate_revision
      (estate_revision_id, source_set_hash, source_revision_ids_json, built_at, status, is_current,
       expected_entity_count, expected_relation_count, expected_unresolved_count, quality_json)
     VALUES (?, ?, ?, ?, 'STAGING', 0, ?, ?, ?, ?)`
  ).bind(
    estateRevisionId,
    suppliedHash,
    JSON.stringify(sourceRevisionIds),
    builtAt,
    integer(counts.entities, "counts.entities"),
    integer(counts.relations, "counts.relations"),
    integer(counts.unresolved, "counts.unresolved"),
    JSON.stringify(body.quality && typeof body.quality === "object" && !Array.isArray(body.quality) ? body.quality : {}),
  ).run();

  return reply({
    status: "STAGING",
    estate_revision_id: estateRevisionId,
    source_revision_ids: sourceRevisionIds,
    source_set_hash: suppliedHash,
    chunk_size: MAX_CHUNK_ITEMS,
  }, 201);
}

function validateEntity(raw: unknown): JsonMap {
  const item = asObject(raw, "entity item");
  requiredString(item.entity_id, "entity.entity_id", 300);
  requiredString(item.semantic_type, "entity.semantic_type", 200);
  requiredString(item.identity_rule, "entity.identity_rule", 200);
  requiredString(item.identity_key, "entity.identity_key", 2000);
  const state = optionalString(item.identity_state, 50) ?? "resolved";
  if (!IDENTITY_STATES.has(state)) throw new EstateHttpError(400, `Unsupported identity_state: ${state}`);
  stringArray(item.evidence_classes ?? [], "entity.evidence_classes", 20);
  stringArray(item.source_ids ?? [], "entity.source_ids", 1000);
  asArray(item.source_observations ?? [], "entity.source_observations", 5000);
  return item;
}

function validateRelation(raw: unknown): JsonMap {
  const item = asObject(raw, "relation item");
  requiredString(item.relation_id, "relation.relation_id", 300);
  requiredString(item.semantic_type, "relation.semantic_type", 200);
  requiredString(item.source_entity_id, "relation.source_entity_id", 300);
  requiredString(item.target_entity_id, "relation.target_entity_id", 300);
  stringArray(item.evidence_classes ?? [], "relation.evidence_classes", 20);
  stringArray(item.source_ids ?? [], "relation.source_ids", 1000);
  asArray(item.source_observations ?? [], "relation.source_observations", 5000);
  return item;
}

function validateUnresolved(raw: unknown): JsonMap {
  const item = asObject(raw, "unresolved item");
  requiredString(item.unresolved_id, "unresolved.unresolved_id", 300);
  requiredString(item.source_entity_id, "unresolved.source_entity_id", 300);
  requiredString(item.semantic_type, "unresolved.semantic_type", 200);
  requiredString(item.state, "unresolved.state", 100);
  stringArray(item.candidate_entity_ids ?? [], "unresolved.candidate_entity_ids", 5000);
  stringArray(item.source_ids ?? [], "unresolved.source_ids", 1000);
  asArray(item.source_observations ?? [], "unresolved.source_observations", 5000);
  return item;
}

async function appendEstateCollection(
  request: Request,
  env: SemanticEstateEnv,
  estateRevisionId: string,
  collection: EstateCollection,
): Promise<Response> {
  await authorize(request, env.ADMIN_IMPORT_TOKEN);
  await stagingEstate(env.DB, estateRevisionId);
  const body = asObject(await jsonBody(request), "chunk");
  const items = asArray(body.items, "chunk.items", MAX_CHUNK_ITEMS);
  if (!items.length) throw new EstateHttpError(400, `chunk.items must contain 1-${MAX_CHUNK_ITEMS} items`);

  let statements: D1PreparedStatement[];
  if (collection === "entities") {
    statements = items.map((raw) => {
      const item = validateEntity(raw);
      const identityState = optionalString(item.identity_state, 50) ?? "resolved";
      return env.DB.prepare(
        `INSERT OR REPLACE INTO semantic_estate_entity
          (estate_revision_id, entity_id, semantic_type, identity_rule, identity_key, identity_state,
           display_name, observed_at, properties_json, evidence_classes_json, source_ids_json,
           source_observations_json, evidence_count, source_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        estateRevisionId,
        requiredString(item.entity_id, "entity.entity_id", 300),
        requiredString(item.semantic_type, "entity.semantic_type", 200),
        requiredString(item.identity_rule, "entity.identity_rule", 200),
        requiredString(item.identity_key, "entity.identity_key", 2000),
        identityState,
        optionalString(item.display_name, 1000),
        optionalString(item.observed_at, 100),
        JSON.stringify(item.properties && typeof item.properties === "object" && !Array.isArray(item.properties) ? item.properties : {}),
        JSON.stringify(stringArray(item.evidence_classes ?? [], "entity.evidence_classes", 20)),
        JSON.stringify(stringArray(item.source_ids ?? [], "entity.source_ids", 1000)),
        JSON.stringify(asArray(item.source_observations ?? [], "entity.source_observations", 5000)),
        integer(item.evidence_count ?? 0, "entity.evidence_count", 100_000),
        integer(item.source_count ?? 0, "entity.source_count", 10_000),
      );
    });
  } else if (collection === "relations") {
    statements = items.map((raw) => {
      const item = validateRelation(raw);
      return env.DB.prepare(
        `INSERT OR REPLACE INTO semantic_estate_relation
          (estate_revision_id, relation_id, semantic_type, source_entity_id, target_entity_id,
           observed_at, properties_json, evidence_classes_json, source_ids_json, source_observations_json,
           evidence_count, source_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        estateRevisionId,
        requiredString(item.relation_id, "relation.relation_id", 300),
        requiredString(item.semantic_type, "relation.semantic_type", 200),
        requiredString(item.source_entity_id, "relation.source_entity_id", 300),
        requiredString(item.target_entity_id, "relation.target_entity_id", 300),
        optionalString(item.observed_at, 100),
        JSON.stringify(item.properties && typeof item.properties === "object" && !Array.isArray(item.properties) ? item.properties : {}),
        JSON.stringify(stringArray(item.evidence_classes ?? [], "relation.evidence_classes", 20)),
        JSON.stringify(stringArray(item.source_ids ?? [], "relation.source_ids", 1000)),
        JSON.stringify(asArray(item.source_observations ?? [], "relation.source_observations", 5000)),
        integer(item.evidence_count ?? 0, "relation.evidence_count", 100_000),
        integer(item.source_count ?? 0, "relation.source_count", 10_000),
      );
    });
  } else {
    statements = items.map((raw) => {
      const item = validateUnresolved(raw);
      return env.DB.prepare(
        `INSERT OR REPLACE INTO semantic_estate_unresolved
          (estate_revision_id, unresolved_id, source_entity_id, semantic_type, expected_target_type,
           vendor_value, state, reason, candidate_entity_ids_json, source_ids_json,
           source_observations_json, evidence_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        estateRevisionId,
        requiredString(item.unresolved_id, "unresolved.unresolved_id", 300),
        requiredString(item.source_entity_id, "unresolved.source_entity_id", 300),
        requiredString(item.semantic_type, "unresolved.semantic_type", 200),
        optionalString(item.expected_target_type, 200),
        optionalString(item.vendor_value, 1500),
        requiredString(item.state, "unresolved.state", 100),
        optionalString(item.reason, 1000),
        JSON.stringify(stringArray(item.candidate_entity_ids ?? [], "unresolved.candidate_entity_ids", 5000)),
        JSON.stringify(stringArray(item.source_ids ?? [], "unresolved.source_ids", 1000)),
        JSON.stringify(asArray(item.source_observations ?? [], "unresolved.source_observations", 5000)),
        integer(item.evidence_count ?? 0, "unresolved.evidence_count", 100_000),
      );
    });
  }

  await env.DB.batch(statements);
  return reply({ status: "STAGING", estate_revision_id: estateRevisionId, collection, accepted: items.length });
}

async function estateCounts(db: D1Database, estateRevisionId: string): Promise<Record<EstateCollection, number>> {
  const results = await db.batch([
    db.prepare("SELECT COUNT(*) AS count FROM semantic_estate_entity WHERE estate_revision_id = ?").bind(estateRevisionId),
    db.prepare("SELECT COUNT(*) AS count FROM semantic_estate_relation WHERE estate_revision_id = ?").bind(estateRevisionId),
    db.prepare("SELECT COUNT(*) AS count FROM semantic_estate_unresolved WHERE estate_revision_id = ?").bind(estateRevisionId),
  ]);
  const count = (index: number) => Number((results[index].results?.[0] as { count?: number } | undefined)?.count ?? 0);
  return { entities: count(0), relations: count(1), unresolved: count(2) };
}

async function activateEstate(request: Request, env: SemanticEstateEnv, estateRevisionId: string): Promise<Response> {
  await authorize(request, env.ADMIN_IMPORT_TOKEN);
  const revision = await stagingEstate(env.DB, estateRevisionId);
  const sourceRevisionIds = JSON.parse(String(revision.source_revision_ids_json ?? "[]")) as string[];
  const currentIds = await currentSourceRevisionIds(env.DB);
  if (!sameStringSet(sourceRevisionIds, currentIds)) {
    throw new EstateHttpError(409, "Current source set changed while canonical estate was being built", {
      built_from: normalizedSourceIds(sourceRevisionIds),
      current: currentIds,
    });
  }
  const expectedHash = await sourceSetHash(currentIds);
  if (String(revision.source_set_hash) !== expectedHash) {
    throw new EstateHttpError(409, "Canonical estate source-set hash is stale", { expected: expectedHash });
  }

  const actual = await estateCounts(env.DB, estateRevisionId);
  const expected = {
    entities: Number(revision.expected_entity_count),
    relations: Number(revision.expected_relation_count),
    unresolved: Number(revision.expected_unresolved_count),
  };
  const mismatches = Object.entries(expected)
    .filter(([key, value]) => actual[key as EstateCollection] !== value)
    .map(([key, value]) => ({ collection: key, expected: value, actual: actual[key as EstateCollection] }));
  if (mismatches.length) throw new EstateHttpError(409, "Canonical estate counts do not match manifest", mismatches);

  const dangling = await env.DB.prepare(
    `SELECT COUNT(*) AS count
       FROM semantic_estate_relation r
       LEFT JOIN semantic_estate_entity s
         ON s.estate_revision_id = r.estate_revision_id AND s.entity_id = r.source_entity_id
       LEFT JOIN semantic_estate_entity t
         ON t.estate_revision_id = r.estate_revision_id AND t.entity_id = r.target_entity_id
      WHERE r.estate_revision_id = ? AND (s.entity_id IS NULL OR t.entity_id IS NULL)`
  ).bind(estateRevisionId).first<{ count: number }>();
  if (Number(dangling?.count ?? 0) !== 0) {
    throw new EstateHttpError(409, "Canonical estate contains dangling relations", { count: Number(dangling?.count ?? 0) });
  }

  const unresolvedDangling = await env.DB.prepare(
    `SELECT COUNT(*) AS count
       FROM semantic_estate_unresolved u
       LEFT JOIN semantic_estate_entity s
         ON s.estate_revision_id = u.estate_revision_id AND s.entity_id = u.source_entity_id
      WHERE u.estate_revision_id = ? AND s.entity_id IS NULL`
  ).bind(estateRevisionId).first<{ count: number }>();
  if (Number(unresolvedDangling?.count ?? 0) !== 0) {
    throw new EstateHttpError(409, "Canonical unresolved references contain missing source entities", {
      count: Number(unresolvedDangling?.count ?? 0),
    });
  }

  const previous = await env.DB.prepare(
    "SELECT estate_revision_id FROM semantic_estate_revision WHERE is_current = 1 LIMIT 1"
  ).first<{ estate_revision_id: string }>();
  const activatedAt = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE semantic_estate_revision SET is_current = 0, status = 'SUPERSEDED' WHERE is_current = 1"),
    env.DB.prepare(
      "UPDATE semantic_estate_revision SET is_current = 1, status = 'ACTIVE', activated_at = ? WHERE estate_revision_id = ?"
    ).bind(activatedAt, estateRevisionId),
  ]);

  return reply({
    status: "ACTIVE",
    estate_revision_id: estateRevisionId,
    previous_estate_revision_id: previous?.estate_revision_id ?? null,
    source_revision_ids: currentIds,
    source_set_hash: expectedHash,
    counts: actual,
    activated_at: activatedAt,
  });
}

async function estateStatus(env: SemanticEstateEnv): Promise<Response> {
  try {
    const current = await env.DB.prepare(
      `SELECT estate_revision_id, source_set_hash, source_revision_ids_json, built_at, activated_at,
              expected_entity_count AS entity_count, expected_relation_count AS relation_count,
              expected_unresolved_count AS unresolved_count, quality_json
         FROM semantic_estate_revision WHERE is_current = 1 LIMIT 1`
    ).first<Record<string, unknown>>();
    const sourceIds = await currentSourceRevisionIds(env.DB);
    return reply({
      database_ready: true,
      current_sources: sourceIds.length,
      current_estate: current ? {
        ...current,
        source_revision_ids: JSON.parse(String(current.source_revision_ids_json ?? "[]")),
        source_revision_ids_json: undefined,
        quality: JSON.parse(String(current.quality_json ?? "{}")),
        quality_json: undefined,
      } : null,
      estate_fresh: current ? String(current.source_set_hash) === await sourceSetHash(sourceIds) : false,
    });
  } catch {
    return reply({ database_ready: false, current_sources: 0, current_estate: null, estate_fresh: false });
  }
}

async function estateProgress(request: Request, env: SemanticEstateEnv, estateRevisionId: string): Promise<Response> {
  await authorize(request, env.ADMIN_IMPORT_TOKEN);
  const revision = await env.DB.prepare(
    `SELECT estate_revision_id, source_set_hash, source_revision_ids_json, built_at, activated_at, status, is_current,
            expected_entity_count, expected_relation_count, expected_unresolved_count, quality_json
       FROM semantic_estate_revision WHERE estate_revision_id = ? LIMIT 1`
  ).bind(estateRevisionId).first<Record<string, unknown>>();
  if (!revision) throw new EstateHttpError(404, "Canonical estate revision not found");
  return reply({ revision, actual: await estateCounts(env.DB, estateRevisionId) });
}

export async function handleSemanticEstate(request: Request, env: SemanticEstateEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  try {
    if (request.method === "GET" && path === "/api/v2/estate/status") return await estateStatus(env);
    if (request.method === "POST" && path === "/api/v2/estate/revisions") return await createEstateRevision(request, env);

    const match = path.match(/^\/api\/v2\/estate\/revisions\/([^/]+)(?:\/(entities|relations|unresolved|activate))?$/);
    if (!match) return null;
    const estateRevisionId = decodeURIComponent(match[1]);
    const action = match[2];
    if (request.method === "GET" && !action) return await estateProgress(request, env, estateRevisionId);
    if (request.method === "POST" && action === "activate") return await activateEstate(request, env, estateRevisionId);
    if (request.method === "POST" && action && action !== "activate") {
      return await appendEstateCollection(request, env, estateRevisionId, action as EstateCollection);
    }
    return reply({ detail: "Method not allowed" }, 405);
  } catch (error) {
    if (error instanceof EstateHttpError) return reply({ detail: error.message, errors: error.details ?? null }, error.status);
    console.error("semantic estate error", error);
    return reply({ detail: "Canonical estate operation failed" }, 500);
  }
}
