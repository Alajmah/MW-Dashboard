export interface SemanticImportEnv {
  DB: D1Database;
  ADMIN_IMPORT_TOKEN?: string;
}

type JsonMap = Record<string, unknown>;
type ImportCollection = "coverage" | "entities" | "relations" | "unresolved";

interface RevisionManifest {
  schema_version: string;
  run_id: string;
  environment: string;
  collector: string;
  collector_version?: string | null;
  normalizer_version: string;
  completed_at: string;
  source: { kind: string; id: string; display_name?: string | null };
  archive: { filename: string; sha256: string; size_bytes: number };
  bundle_sha256: string;
  counts: { coverage: number; entities: number; relations: number; unresolved: number };
  quality?: JsonMap;
}

class ImportHttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const SHA256_RE = /^[0-9a-f]{64}$/i;
const MAX_CHUNK_ITEMS = 75;
const MAX_COLLECTION_ITEMS = 100_000;
const ALLOWED_EVIDENCE = new Set(["observed", "configured", "declared", "inferred"]);
const ALLOWED_COVERAGE = new Set(["complete", "point_in_time", "partial", "failed", "not_collected"]);
const ALLOWED_UNRESOLVED = new Set(["unresolved", "ambiguous", "dynamic", "stale", "conflicted", "resolved"]);

function reply(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS });
}

function asObject(value: unknown, label: string): JsonMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ImportHttpError(400, `${label} must be an object`);
  }
  return value as JsonMap;
}

function requiredString(value: unknown, label: string, max = 1000): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ImportHttpError(400, `${label} must be a non-empty string`);
  }
  const result = value.trim();
  if (result.length > max) throw new ImportHttpError(400, `${label} exceeds ${max} characters`);
  return result;
}

function optionalString(value: unknown, max = 1000): string | null {
  if (value == null || value === "") return null;
  return requiredString(value, "value", max);
}

function integer(value: unknown, label: string, max = MAX_COLLECTION_ITEMS): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > max) {
    throw new ImportHttpError(400, `${label} must be an integer between 0 and ${max}`);
  }
  return Number(value);
}

function jsonObject(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : {};
}

function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function jsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new ImportHttpError(415, "Content-Type must be application/json");
  }
  try {
    return await request.json();
  } catch {
    throw new ImportHttpError(400, "Request body must contain valid JSON");
  }
}

async function tokenDigest(value: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(value);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

async function tokensEqual(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([tokenDigest(left), tokenDigest(right)]);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function requireAdminImport(request: Request, configuredToken?: string): Promise<void> {
  const expected = configuredToken?.trim();
  if (!expected) {
    throw new ImportHttpError(503, "Semantic import is disabled until ADMIN_IMPORT_TOKEN is configured");
  }
  const auth = request.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match || !(await tokensEqual(match[1].trim(), expected))) {
    throw new ImportHttpError(401, "Invalid or missing import authorization", null);
  }
}

function validateManifest(raw: unknown): RevisionManifest {
  const body = asObject(raw, "manifest");
  const source = asObject(body.source, "source");
  const archive = asObject(body.archive, "archive");
  const counts = asObject(body.counts, "counts");
  const schemaVersion = requiredString(body.schema_version, "schema_version", 100);
  if (schemaVersion !== "osi.observation.bundle/v2") {
    throw new ImportHttpError(400, `Unsupported schema_version: ${schemaVersion}`);
  }
  const normalizerVersion = requiredString(body.normalizer_version, "normalizer_version", 100);
  if (normalizerVersion !== "3.1.0") {
    throw new ImportHttpError(400, `Unsupported MQ normalizer_version: ${normalizerVersion}`);
  }
  const archiveSha = requiredString(archive.sha256, "archive.sha256", 64).toLowerCase();
  const bundleSha = requiredString(body.bundle_sha256, "bundle_sha256", 64).toLowerCase();
  if (!SHA256_RE.test(archiveSha) || !SHA256_RE.test(bundleSha)) {
    throw new ImportHttpError(400, "archive.sha256 and bundle_sha256 must be SHA-256 hex digests");
  }
  const completedAt = requiredString(body.completed_at, "completed_at", 100);
  if (Number.isNaN(Date.parse(completedAt))) throw new ImportHttpError(400, "completed_at must be an ISO date/time");

  return {
    schema_version: schemaVersion,
    run_id: requiredString(body.run_id, "run_id", 300),
    environment: requiredString(body.environment, "environment", 100),
    collector: requiredString(body.collector, "collector", 200),
    collector_version: optionalString(body.collector_version, 100),
    normalizer_version: normalizerVersion,
    completed_at: new Date(completedAt).toISOString(),
    source: {
      kind: requiredString(source.kind, "source.kind", 100),
      id: requiredString(source.id, "source.id", 500),
      display_name: optionalString(source.display_name, 500),
    },
    archive: {
      filename: requiredString(archive.filename, "archive.filename", 500),
      sha256: archiveSha,
      size_bytes: integer(archive.size_bytes, "archive.size_bytes", 100_000_000),
    },
    bundle_sha256: bundleSha,
    counts: {
      coverage: integer(counts.coverage, "counts.coverage"),
      entities: integer(counts.entities, "counts.entities"),
      relations: integer(counts.relations, "counts.relations"),
      unresolved: integer(counts.unresolved, "counts.unresolved"),
    },
    quality: jsonObject(body.quality),
  };
}

async function stagingRevision(db: D1Database, revisionId: string): Promise<Record<string, unknown>> {
  const row = await db.prepare("SELECT * FROM semantic_source_revision WHERE revision_id = ? LIMIT 1")
    .bind(revisionId).first<Record<string, unknown>>();
  if (!row) throw new ImportHttpError(404, "Semantic source revision not found");
  if (row.status !== "STAGING") throw new ImportHttpError(409, `Revision is ${row.status}, not STAGING`);
  return row;
}

async function createRevision(request: Request, env: SemanticImportEnv): Promise<Response> {
  await requireAdminImport(request, env.ADMIN_IMPORT_TOKEN);
  const manifest = validateManifest(await jsonBody(request));
  const existing = await env.DB.prepare(
    "SELECT revision_id, status, is_current FROM semantic_source_revision WHERE run_id = ? LIMIT 1"
  ).bind(manifest.run_id).first<Record<string, unknown>>();
  if (existing) throw new ImportHttpError(409, "This source run has already been imported", existing);

  const revisionId = `src_${crypto.randomUUID()}`;
  const importedAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO semantic_source_revision
      (revision_id, run_id, source_kind, source_id, source_display_name, environment,
       collector, collector_version, normalizer_version, completed_at, imported_at,
       archive_filename, archive_sha256, archive_size_bytes, bundle_sha256,
       expected_coverage_count, expected_entity_count, expected_relation_count, expected_unresolved_count,
       status, is_current, quality_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'STAGING', 0, ?)`
  ).bind(
    revisionId, manifest.run_id, manifest.source.kind, manifest.source.id, manifest.source.display_name,
    manifest.environment, manifest.collector, manifest.collector_version, manifest.normalizer_version,
    manifest.completed_at, importedAt, manifest.archive.filename, manifest.archive.sha256,
    manifest.archive.size_bytes, manifest.bundle_sha256, manifest.counts.coverage, manifest.counts.entities,
    manifest.counts.relations, manifest.counts.unresolved, JSON.stringify(manifest.quality ?? {}),
  ).run();

  return reply({ status: "STAGING", revision_id: revisionId, source_id: manifest.source.id, run_id: manifest.run_id, chunk_size: MAX_CHUNK_ITEMS }, 201);
}

function validateCoverage(value: unknown): JsonMap {
  const item = asObject(value, "coverage item");
  const mode = requiredString(item.mode, "coverage.mode", 50);
  if (!ALLOWED_COVERAGE.has(mode)) throw new ImportHttpError(400, `Unsupported coverage mode: ${mode}`);
  return item;
}

function validateEntity(value: unknown): JsonMap {
  const item = asObject(value, "entity item");
  requiredString(item.ref, "entity.ref", 300);
  requiredString(item.semantic_type, "entity.semantic_type", 200);
  const evidence = requiredString(item.evidence_class, "entity.evidence_class", 50);
  if (!ALLOWED_EVIDENCE.has(evidence)) throw new ImportHttpError(400, `Unsupported entity evidence_class: ${evidence}`);
  asObject(item.identity, "entity.identity");
  return item;
}

function validateRelation(value: unknown): JsonMap {
  const item = asObject(value, "relation item");
  requiredString(item.ref, "relation.ref", 300);
  requiredString(item.semantic_type, "relation.semantic_type", 200);
  requiredString(item.source_ref, "relation.source_ref", 300);
  requiredString(item.target_ref, "relation.target_ref", 300);
  const evidence = requiredString(item.evidence_class, "relation.evidence_class", 50);
  if (!ALLOWED_EVIDENCE.has(evidence)) throw new ImportHttpError(400, `Unsupported relation evidence_class: ${evidence}`);
  return item;
}

function validateUnresolved(value: unknown): JsonMap {
  const item = asObject(value, "unresolved item");
  requiredString(item.ref, "unresolved.ref", 300);
  requiredString(item.source_ref, "unresolved.source_ref", 300);
  requiredString(item.semantic_type, "unresolved.semantic_type", 200);
  const state = requiredString(item.state, "unresolved.state", 50);
  if (!ALLOWED_UNRESOLVED.has(state)) throw new ImportHttpError(400, `Unsupported unresolved state: ${state}`);
  if (item.evidence_class != null) {
    const evidence = requiredString(item.evidence_class, "unresolved.evidence_class", 50);
    if (!ALLOWED_EVIDENCE.has(evidence)) throw new ImportHttpError(400, `Unsupported unresolved evidence_class: ${evidence}`);
  }
  return item;
}

async function appendCollection(request: Request, env: SemanticImportEnv, revisionId: string, collection: ImportCollection): Promise<Response> {
  await requireAdminImport(request, env.ADMIN_IMPORT_TOKEN);
  await stagingRevision(env.DB, revisionId);
  const body = asObject(await jsonBody(request), "chunk");
  const start = integer(body.start, "chunk.start");
  const rawItems = jsonArray(body.items);
  if (!rawItems.length || rawItems.length > MAX_CHUNK_ITEMS) {
    throw new ImportHttpError(400, `chunk.items must contain 1-${MAX_CHUNK_ITEMS} items`);
  }

  let statements: D1PreparedStatement[];
  if (collection === "coverage") {
    statements = rawItems.map((raw, index) => {
      const item = validateCoverage(raw);
      return env.DB.prepare(
        `INSERT OR REPLACE INTO semantic_coverage
          (revision_id, ordinal, scope_type, scope_key, object_class, mode, properties_json, evidence_ref, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        revisionId, start + index, requiredString(item.scope_type, "coverage.scope_type", 100),
        requiredString(item.scope_key, "coverage.scope_key", 500), requiredString(item.object_class, "coverage.object_class", 300),
        requiredString(item.mode, "coverage.mode", 50), JSON.stringify(jsonObject(item.properties)),
        optionalString(item.evidence_ref, 1500), optionalString(item.error, 2000),
      );
    });
  } else if (collection === "entities") {
    statements = rawItems.map((raw) => {
      const item = validateEntity(raw);
      return env.DB.prepare(
        `INSERT OR REPLACE INTO semantic_entity_observation
          (revision_id, entity_ref, semantic_type, display_name, observed_at, evidence_class, identity_json, properties_json, evidence_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        revisionId, requiredString(item.ref, "entity.ref", 300), requiredString(item.semantic_type, "entity.semantic_type", 200),
        optionalString(item.display_name, 1000), optionalString(item.observed_at, 100), requiredString(item.evidence_class, "entity.evidence_class", 50),
        JSON.stringify(asObject(item.identity, "entity.identity")), JSON.stringify(jsonObject(item.properties)), optionalString(item.evidence_ref, 1500),
      );
    });
  } else if (collection === "relations") {
    statements = rawItems.map((raw) => {
      const item = validateRelation(raw);
      return env.DB.prepare(
        `INSERT OR REPLACE INTO semantic_relation_observation
          (revision_id, relation_ref, semantic_type, source_ref, target_ref, observed_at, evidence_class, properties_json, evidence_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        revisionId, requiredString(item.ref, "relation.ref", 300), requiredString(item.semantic_type, "relation.semantic_type", 200),
        requiredString(item.source_ref, "relation.source_ref", 300), requiredString(item.target_ref, "relation.target_ref", 300),
        optionalString(item.observed_at, 100), requiredString(item.evidence_class, "relation.evidence_class", 50),
        JSON.stringify(jsonObject(item.properties)), optionalString(item.evidence_ref, 1500),
      );
    });
  } else {
    statements = rawItems.map((raw) => {
      const item = validateUnresolved(raw);
      return env.DB.prepare(
        `INSERT OR REPLACE INTO semantic_unresolved_reference
          (revision_id, unresolved_ref, source_ref, semantic_type, expected_target_type, vendor_value, state, reason,
           observed_at, evidence_class, candidate_refs_json, properties_json, evidence_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        revisionId, requiredString(item.ref, "unresolved.ref", 300), requiredString(item.source_ref, "unresolved.source_ref", 300),
        requiredString(item.semantic_type, "unresolved.semantic_type", 200), optionalString(item.expected_target_type, 200),
        optionalString(item.vendor_value, 1500), requiredString(item.state, "unresolved.state", 50), optionalString(item.reason, 500),
        optionalString(item.observed_at, 100), optionalString(item.evidence_class, 50), JSON.stringify(jsonArray(item.candidate_refs)),
        JSON.stringify(jsonObject(item.properties)), optionalString(item.evidence_ref, 1500),
      );
    });
  }

  await env.DB.batch(statements);
  return reply({ status: "STAGING", revision_id: revisionId, collection, start, accepted: rawItems.length });
}

async function countRevision(db: D1Database, revisionId: string): Promise<Record<ImportCollection, number>> {
  const results = await db.batch([
    db.prepare("SELECT COUNT(*) AS count FROM semantic_coverage WHERE revision_id = ?").bind(revisionId),
    db.prepare("SELECT COUNT(*) AS count FROM semantic_entity_observation WHERE revision_id = ?").bind(revisionId),
    db.prepare("SELECT COUNT(*) AS count FROM semantic_relation_observation WHERE revision_id = ?").bind(revisionId),
    db.prepare("SELECT COUNT(*) AS count FROM semantic_unresolved_reference WHERE revision_id = ?").bind(revisionId),
  ]);
  const count = (index: number) => Number((results[index].results?.[0] as { count?: number } | undefined)?.count ?? 0);
  return { coverage: count(0), entities: count(1), relations: count(2), unresolved: count(3) };
}

async function activateRevision(request: Request, env: SemanticImportEnv, revisionId: string): Promise<Response> {
  await requireAdminImport(request, env.ADMIN_IMPORT_TOKEN);
  const revision = await stagingRevision(env.DB, revisionId);
  const actual = await countRevision(env.DB, revisionId);
  const expected = {
    coverage: Number(revision.expected_coverage_count), entities: Number(revision.expected_entity_count),
    relations: Number(revision.expected_relation_count), unresolved: Number(revision.expected_unresolved_count),
  };
  const mismatches = Object.entries(expected)
    .filter(([key, value]) => actual[key as ImportCollection] !== value)
    .map(([key, value]) => ({ collection: key, expected: value, actual: actual[key as ImportCollection] }));
  if (mismatches.length) throw new ImportHttpError(409, "Revision counts do not match manifest", mismatches);

  const dangling = await env.DB.prepare(
    `SELECT COUNT(*) AS count
       FROM semantic_relation_observation r
       LEFT JOIN semantic_entity_observation s ON s.revision_id = r.revision_id AND s.entity_ref = r.source_ref
       LEFT JOIN semantic_entity_observation t ON t.revision_id = r.revision_id AND t.entity_ref = r.target_ref
      WHERE r.revision_id = ? AND (s.entity_ref IS NULL OR t.entity_ref IS NULL)`
  ).bind(revisionId).first<{ count: number }>();
  if (Number(dangling?.count ?? 0) !== 0) {
    throw new ImportHttpError(409, "Revision contains dangling semantic relations", { count: Number(dangling?.count ?? 0) });
  }

  const sourceId = String(revision.source_id);
  const previous = await env.DB.prepare(
    "SELECT revision_id FROM semantic_source_revision WHERE source_id = ? AND is_current = 1 LIMIT 1"
  ).bind(sourceId).first<{ revision_id: string }>();
  const activatedAt = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE semantic_source_revision SET is_current = 0, status = 'SUPERSEDED' WHERE source_id = ? AND is_current = 1").bind(sourceId),
    env.DB.prepare("UPDATE semantic_source_revision SET is_current = 1, status = 'ACTIVE', activated_at = ? WHERE revision_id = ?").bind(activatedAt, revisionId),
  ]);

  return reply({
    status: "ACTIVE", revision_id: revisionId, source_id: sourceId,
    previous_revision_id: previous?.revision_id ?? null, counts: actual, activated_at: activatedAt,
  });
}

async function importStatus(env: SemanticImportEnv): Promise<Response> {
  try {
    const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM semantic_source_revision WHERE is_current = 1")
      .first<{ count: number }>();
    return reply({ enabled: Boolean(env.ADMIN_IMPORT_TOKEN?.trim()), database_ready: true, current_sources: Number(row?.count ?? 0) });
  } catch {
    return reply({ enabled: Boolean(env.ADMIN_IMPORT_TOKEN?.trim()), database_ready: false, current_sources: 0 });
  }
}

async function listSources(request: Request, env: SemanticImportEnv): Promise<Response> {
  await requireAdminImport(request, env.ADMIN_IMPORT_TOKEN);
  const result = await env.DB.prepare(
    `SELECT revision_id, run_id, source_kind, source_id, source_display_name, environment,
            collector, collector_version, normalizer_version, completed_at, imported_at, activated_at,
            archive_filename, archive_sha256, archive_size_bytes, bundle_sha256,
            expected_coverage_count AS coverage_count, expected_entity_count AS entity_count,
            expected_relation_count AS relation_count, expected_unresolved_count AS unresolved_count, quality_json
       FROM semantic_source_revision WHERE is_current = 1 ORDER BY source_display_name, source_id`
  ).all<Record<string, unknown>>();
  return reply({ sources: result.results.map((row) => ({ ...row, quality: JSON.parse(String(row.quality_json ?? "{}")), quality_json: undefined })) });
}

async function revisionProgress(request: Request, env: SemanticImportEnv, revisionId: string): Promise<Response> {
  await requireAdminImport(request, env.ADMIN_IMPORT_TOKEN);
  const revision = await env.DB.prepare(
    `SELECT revision_id, run_id, source_id, source_display_name, environment, status, is_current,
            expected_coverage_count, expected_entity_count, expected_relation_count, expected_unresolved_count
       FROM semantic_source_revision WHERE revision_id = ? LIMIT 1`
  ).bind(revisionId).first<Record<string, unknown>>();
  if (!revision) throw new ImportHttpError(404, "Semantic source revision not found");
  return reply({ revision, actual: await countRevision(env.DB, revisionId) });
}

export async function handleSemanticImport(request: Request, env: SemanticImportEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  try {
    if (request.method === "GET" && path === "/api/v2/import/status") return await importStatus(env);
    if (request.method === "GET" && path === "/api/v2/import/sources") return await listSources(request, env);
    if (request.method === "POST" && path === "/api/v2/import/revisions") return await createRevision(request, env);

    const match = path.match(/^\/api\/v2\/import\/revisions\/([^/]+)(?:\/(coverage|entities|relations|unresolved|activate))?$/);
    if (!match) return null;
    const revisionId = decodeURIComponent(match[1]);
    const action = match[2];
    if (request.method === "GET" && !action) return await revisionProgress(request, env, revisionId);
    if (request.method === "POST" && action === "activate") return await activateRevision(request, env, revisionId);
    if (request.method === "POST" && action && action !== "activate") {
      return await appendCollection(request, env, revisionId, action as ImportCollection);
    }
    return reply({ detail: "Method not allowed" }, 405);
  } catch (error) {
    if (error instanceof ImportHttpError) return reply({ detail: error.message, errors: error.details ?? null }, error.status);
    console.error("semantic import error", error);
    return reply({ detail: "Semantic import failed" }, 500);
  }
}
