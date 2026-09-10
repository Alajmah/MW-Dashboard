import { importAuthorizationDenial } from "./import-auth";

export interface OperationalFindingsEnv {
  DB: D1Database;
  ADMIN_IMPORT_TOKEN?: string;
}

type JsonMap = Record<string, unknown>;
type ImportCollection = "observations" | "coverage" | "findings";
type Row = Record<string, unknown>;

class OperationalHttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const MAX_CHUNK_ITEMS = 75;
const MAX_COLLECTION_ITEMS = 250_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_OFFSET = 500_000;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const ENTITY_ID_RE = /^cent_[0-9a-f]{24}$/;
const FINDING_ID_RE = /^find_[0-9a-f]{24}$/;
const EVIDENCE_CLASSES = new Set(["observed", "configured", "declared", "inferred"]);
const RAW_COVERAGE = new Set(["complete", "point_in_time", "partial", "failed", "not_collected"]);
const FRESHNESS = new Set(["sampled", "stale", "unknown"]);
const FINDING_COVERAGE = new Set(["sufficient", "limited", "partial", "failed", "unknown"]);
const SEVERITIES = new Set(["critical", "warning", "info"]);
const FINDING_STATUSES = new Set(["OPEN", "ACKNOWLEDGED", "RESOLVED"]);
const CONFIDENCE_LEVELS = new Set(["confirmed", "probable", "possible", "insufficient"]);

function reply(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS });
}

function asObject(value: unknown, label: string): JsonMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OperationalHttpError(400, `${label} must be an object`);
  }
  return value as JsonMap;
}

function asArray(value: unknown, label: string, max = MAX_COLLECTION_ITEMS): unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new OperationalHttpError(400, `${label} must be an array with at most ${max} items`);
  }
  return value;
}

function requiredString(value: unknown, label: string, max = 2000): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new OperationalHttpError(400, `${label} must be a non-empty string`);
  }
  const result = value.trim();
  if (result.length > max) throw new OperationalHttpError(400, `${label} exceeds ${max} characters`);
  return result;
}

function optionalString(value: unknown, max = 4000): string | null {
  if (value == null || value === "") return null;
  return requiredString(value, "value", max);
}

function isoDate(value: unknown, label: string): string {
  const text = requiredString(value, label, 100);
  const millis = Date.parse(text);
  if (Number.isNaN(millis)) throw new OperationalHttpError(400, `${label} must be an ISO date/time`);
  return new Date(millis).toISOString();
}

function integer(value: unknown, label: string, max = MAX_COLLECTION_ITEMS): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > max) {
    throw new OperationalHttpError(400, `${label} must be an integer between 0 and ${max}`);
  }
  return Number(value);
}

function finiteNumber(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new OperationalHttpError(400, `${label} must be a number between ${min} and ${max}`);
  }
  return value;
}

function enumString(value: unknown, label: string, allowed: Set<string>): string {
  const text = requiredString(value, label, 100);
  if (!allowed.has(text)) throw new OperationalHttpError(400, `Unsupported ${label}: ${text}`);
  return text;
}

function canonicalEntityId(value: unknown, label = "entity_id"): string {
  const id = requiredString(value, label, 100);
  if (!ENTITY_ID_RE.test(id)) throw new OperationalHttpError(400, `${label} must be a canonical cent_ identifier`);
  return id;
}

function canonicalFindingId(value: unknown, label = "finding_id"): string {
  const id = requiredString(value, label, 100);
  if (!FINDING_ID_RE.test(id)) throw new OperationalHttpError(400, `${label} must be a canonical find_ identifier`);
  return id;
}

function jsonObject(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : {};
}

function stringArray(value: unknown, label: string, max = 5000): string[] {
  return asArray(value, label, max).map((item, index) => requiredString(item, `${label}[${index}]`, 2000));
}

function parseJson(value: unknown, fallback: unknown): unknown {
  if (typeof value !== "string" || !value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

async function jsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new OperationalHttpError(415, "Content-Type must be application/json");
  }
  try {
    return await request.json();
  } catch {
    throw new OperationalHttpError(400, "Request body must contain valid JSON");
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
  throw new OperationalHttpError(denial.status, detail);
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
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

interface EvaluationManifest {
  schemaVersion: string;
  sourceId: string;
  sourceHost: string;
  environment: string;
  evaluator: string;
  evaluatorVersion: string;
  evaluatedAt: string;
  sourceArchive: string;
  sourceArchiveSha256: string;
  resultSha256: string;
  counts: { observations: number; coverage: number; findings: number };
  metadata: JsonMap;
}

function validateEvaluationManifest(raw: unknown): EvaluationManifest {
  const body = asObject(raw, "evaluation manifest");
  const schemaVersion = requiredString(body.schema_version, "schema_version", 100);
  if (schemaVersion !== "osi.findings.evaluation/v1") {
    throw new OperationalHttpError(400, `Unsupported schema_version: ${schemaVersion}`);
  }
  const source = asObject(body.source, "source");
  const artifact = asObject(body.artifact, "artifact");
  const counts = asObject(body.counts, "counts");
  const archiveSha = requiredString(artifact.sha256, "artifact.sha256", 64).toLowerCase();
  const resultSha = requiredString(body.result_sha256, "result_sha256", 64).toLowerCase();
  if (!SHA256_RE.test(archiveSha) || !SHA256_RE.test(resultSha)) {
    throw new OperationalHttpError(400, "artifact.sha256 and result_sha256 must be SHA-256 hex digests");
  }
  return {
    schemaVersion,
    sourceId: requiredString(source.id, "source.id", 500),
    sourceHost: requiredString(source.host, "source.host", 500),
    environment: requiredString(body.environment, "environment", 100),
    evaluator: requiredString(body.evaluator, "evaluator", 200),
    evaluatorVersion: requiredString(body.evaluator_version, "evaluator_version", 100),
    evaluatedAt: isoDate(body.evaluated_at, "evaluated_at"),
    sourceArchive: requiredString(artifact.filename, "artifact.filename", 1000),
    sourceArchiveSha256: archiveSha,
    resultSha256: resultSha,
    counts: {
      observations: integer(counts.observations, "counts.observations"),
      coverage: integer(counts.coverage, "counts.coverage"),
      findings: integer(counts.findings, "counts.findings"),
    },
    metadata: jsonObject(body.metadata),
  };
}

async function stagingEvaluation(db: D1Database, revisionId: string): Promise<Row> {
  const row = await db.prepare(
    "SELECT * FROM operational_evaluation_revision WHERE evaluation_revision_id = ? LIMIT 1"
  ).bind(revisionId).first<Row>();
  if (!row) throw new OperationalHttpError(404, "Operational evaluation revision not found");
  if (row.status !== "STAGING") throw new OperationalHttpError(409, `Evaluation revision is ${row.status}, not STAGING`);
  return row;
}

async function createEvaluation(request: Request, env: OperationalFindingsEnv): Promise<Response> {
  await authorize(request, env.ADMIN_IMPORT_TOKEN);
  const manifest = validateEvaluationManifest(await jsonBody(request));
  const evaluationKey = await sha256Hex([
    manifest.schemaVersion,
    manifest.sourceId,
    manifest.evaluatedAt,
    manifest.sourceArchiveSha256,
    manifest.resultSha256,
  ].join("|"));
  const existing = await env.DB.prepare(
    `SELECT evaluation_revision_id, status, is_current
       FROM operational_evaluation_revision WHERE evaluation_key = ? LIMIT 1`
  ).bind(evaluationKey).first<Row>();
  if (existing) throw new OperationalHttpError(409, "This operational evaluation has already been imported", existing);

  const revisionId = `oprev_${crypto.randomUUID()}`;
  const importedAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO operational_evaluation_revision
      (evaluation_revision_id, evaluation_key, schema_version, source_id, source_host, environment,
       evaluator, evaluator_version, evaluated_at, imported_at, source_archive, source_archive_sha256,
       result_sha256, expected_observation_count, expected_coverage_count, expected_finding_count,
       status, is_current, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'STAGING', 0, ?)`
  ).bind(
    revisionId, evaluationKey, manifest.schemaVersion, manifest.sourceId, manifest.sourceHost,
    manifest.environment, manifest.evaluator, manifest.evaluatorVersion, manifest.evaluatedAt,
    importedAt, manifest.sourceArchive, manifest.sourceArchiveSha256, manifest.resultSha256,
    manifest.counts.observations, manifest.counts.coverage, manifest.counts.findings,
    JSON.stringify(manifest.metadata),
  ).run();

  return reply({
    status: "STAGING",
    evaluation_revision_id: revisionId,
    evaluation_key: evaluationKey,
    source_id: manifest.sourceId,
    chunk_size: MAX_CHUNK_ITEMS,
  }, 201);
}

function validateObservation(raw: unknown, expectedSourceId: string): JsonMap {
  const item = asObject(raw, "observation item");
  requiredString(item.observation_id, "observation.observation_id", 300);
  canonicalEntityId(item.entity_id, "observation.entity_id");
  requiredString(item.semantic_type, "observation.semantic_type", 200);
  requiredString(item.display_name, "observation.display_name", 1000);
  requiredString(item.observation_type, "observation.observation_type", 300);
  isoDate(item.observed_at, "observation.observed_at");
  if (!["string", "number", "boolean"].includes(typeof item.value) || item.value == null) {
    throw new OperationalHttpError(400, "observation.value must be a string, number, or boolean");
  }
  requiredString(item.unit, "observation.unit", 100);
  const source = asObject(item.source, "observation.source");
  const sourceId = requiredString(source.source_id, "observation.source.source_id", 500);
  if (sourceId !== expectedSourceId) {
    throw new OperationalHttpError(409, "Observation source_id does not match the evaluation source", { expected: expectedSourceId, actual: sourceId });
  }
  requiredString(source.source_host, "observation.source.source_host", 500);
  requiredString(source.queue_manager, "observation.source.queue_manager", 500);
  requiredString(source.collection_method, "observation.source.collection_method", 1000);
  enumString(source.evidence_class, "observation.source.evidence_class", EVIDENCE_CLASSES);
  requiredString(source.evidence_ref, "observation.source.evidence_ref", 2000);
  requiredString(source.sample_id, "observation.source.sample_id", 500);
  const quality = asObject(item.quality, "observation.quality");
  enumString(quality.coverage, "observation.quality.coverage", RAW_COVERAGE);
  enumString(quality.freshness, "observation.quality.freshness", FRESHNESS);
  const dimensions = jsonObject(item.dimensions);
  for (const [key, value] of Object.entries(dimensions)) {
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
      throw new OperationalHttpError(400, `observation.dimensions.${key} must be scalar or null`);
    }
  }
  return item;
}

function validateCoverage(raw: unknown): JsonMap {
  const item = asObject(raw, "coverage item");
  requiredString(item.scope_type, "coverage.scope_type", 100);
  requiredString(item.scope_key, "coverage.scope_key", 500);
  requiredString(item.observation_family, "coverage.observation_family", 300);
  requiredString(item.sample_id, "coverage.sample_id", 500);
  isoDate(item.observed_at, "coverage.observed_at");
  enumString(item.state, "coverage.state", RAW_COVERAGE);
  requiredString(item.evidence_ref, "coverage.evidence_ref", 2000);
  optionalString(item.error, 4000);
  return item;
}

function validateFindingEvidence(raw: unknown, index: number): JsonMap {
  const item = asObject(raw, `finding.evidence[${index}]`);
  requiredString(item.sample_id, `finding.evidence[${index}].sample_id`, 500);
  isoDate(item.observed_at, `finding.evidence[${index}].observed_at`);
  requiredString(item.evidence_ref, `finding.evidence[${index}].evidence_ref`, 2000);
  const observationTypes = stringArray(item.observation_types, `finding.evidence[${index}].observation_types`, 100);
  if (!observationTypes.length) throw new OperationalHttpError(400, `finding.evidence[${index}].observation_types must not be empty`);
  optionalString(item.error, 4000);
  return item;
}

function validateFinding(raw: unknown): JsonMap {
  const item = asObject(raw, "finding item");
  canonicalFindingId(item.finding_id);
  requiredString(item.rule_id, "finding.rule_id", 300);
  canonicalEntityId(item.entity_id, "finding.entity_id");
  requiredString(item.semantic_type, "finding.semantic_type", 200);
  requiredString(item.display_name, "finding.display_name", 1000);
  enumString(item.severity, "finding.severity", SEVERITIES);
  const evaluatorStatus = enumString(item.status, "finding.status", FINDING_STATUSES);
  if (evaluatorStatus !== "OPEN") {
    throw new OperationalHttpError(400, "Imported evaluator findings must start OPEN; lifecycle state is managed separately");
  }
  requiredString(item.summary, "finding.summary", 2000);
  requiredString(item.diagnosis, "finding.diagnosis", 8000);
  const confidence = asObject(item.confidence, "finding.confidence");
  enumString(confidence.level, "finding.confidence.level", CONFIDENCE_LEVELS);
  finiteNumber(confidence.score, "finding.confidence.score", 0, 1);
  isoDate(item.first_seen, "finding.first_seen");
  isoDate(item.last_seen, "finding.last_seen");
  enumString(item.coverage_state, "finding.coverage_state", FINDING_COVERAGE);
  const evidence = asArray(item.evidence, "finding.evidence", 5000);
  if (!evidence.length) throw new OperationalHttpError(400, "finding.evidence must not be empty");
  evidence.forEach((entry, index) => validateFindingEvidence(entry, index));
  const related = stringArray(item.related_entities ?? [], "finding.related_entities", 5000);
  for (const id of related) canonicalEntityId(id, "finding.related_entities[]");
  asObject(item.details ?? {}, "finding.details");
  return item;
}

async function appendCollection(
  request: Request,
  env: OperationalFindingsEnv,
  revisionId: string,
  collection: ImportCollection,
): Promise<Response> {
  await authorize(request, env.ADMIN_IMPORT_TOKEN);
  const revision = await stagingEvaluation(env.DB, revisionId);
  const body = asObject(await jsonBody(request), "chunk");
  const start = integer(body.start, "chunk.start");
  const items = asArray(body.items, "chunk.items", MAX_CHUNK_ITEMS);
  if (!items.length) throw new OperationalHttpError(400, `chunk.items must contain 1-${MAX_CHUNK_ITEMS} items`);

  let statements: D1PreparedStatement[];
  if (collection === "observations") {
    statements = items.map((raw) => {
      const item = validateObservation(raw, String(revision.source_id));
      return env.DB.prepare(
        `INSERT OR REPLACE INTO operational_observation
          (evaluation_revision_id, observation_id, entity_id, semantic_type, display_name,
           observation_type, observed_at, value_json, unit, source_json, quality_json, dimensions_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        revisionId,
        requiredString(item.observation_id, "observation.observation_id", 300),
        canonicalEntityId(item.entity_id, "observation.entity_id"),
        requiredString(item.semantic_type, "observation.semantic_type", 200),
        requiredString(item.display_name, "observation.display_name", 1000),
        requiredString(item.observation_type, "observation.observation_type", 300),
        isoDate(item.observed_at, "observation.observed_at"),
        JSON.stringify(item.value),
        requiredString(item.unit, "observation.unit", 100),
        JSON.stringify(asObject(item.source, "observation.source")),
        JSON.stringify(asObject(item.quality, "observation.quality")),
        JSON.stringify(jsonObject(item.dimensions)),
      );
    });
  } else if (collection === "coverage") {
    statements = items.map((raw, index) => {
      const item = validateCoverage(raw);
      return env.DB.prepare(
        `INSERT OR REPLACE INTO operational_coverage
          (evaluation_revision_id, ordinal, scope_type, scope_key, observation_family,
           sample_id, observed_at, state, evidence_ref, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        revisionId, start + index,
        requiredString(item.scope_type, "coverage.scope_type", 100),
        requiredString(item.scope_key, "coverage.scope_key", 500),
        requiredString(item.observation_family, "coverage.observation_family", 300),
        requiredString(item.sample_id, "coverage.sample_id", 500),
        isoDate(item.observed_at, "coverage.observed_at"),
        enumString(item.state, "coverage.state", RAW_COVERAGE),
        requiredString(item.evidence_ref, "coverage.evidence_ref", 2000),
        optionalString(item.error, 4000),
      );
    });
  } else {
    statements = items.map((raw) => {
      const item = validateFinding(raw);
      return env.DB.prepare(
        `INSERT OR REPLACE INTO operational_finding_occurrence
          (evaluation_revision_id, finding_id, rule_id, entity_id, semantic_type, display_name,
           severity, evaluator_status, summary, diagnosis, confidence_json, first_seen, last_seen,
           coverage_state, evidence_json, related_entities_json, details_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        revisionId,
        canonicalFindingId(item.finding_id),
        requiredString(item.rule_id, "finding.rule_id", 300),
        canonicalEntityId(item.entity_id, "finding.entity_id"),
        requiredString(item.semantic_type, "finding.semantic_type", 200),
        requiredString(item.display_name, "finding.display_name", 1000),
        enumString(item.severity, "finding.severity", SEVERITIES),
        "OPEN",
        requiredString(item.summary, "finding.summary", 2000),
        requiredString(item.diagnosis, "finding.diagnosis", 8000),
        JSON.stringify(asObject(item.confidence, "finding.confidence")),
        isoDate(item.first_seen, "finding.first_seen"),
        isoDate(item.last_seen, "finding.last_seen"),
        enumString(item.coverage_state, "finding.coverage_state", FINDING_COVERAGE),
        JSON.stringify(asArray(item.evidence, "finding.evidence", 5000)),
        JSON.stringify(stringArray(item.related_entities ?? [], "finding.related_entities", 5000)),
        JSON.stringify(asObject(item.details ?? {}, "finding.details")),
      );
    });
  }

  await env.DB.batch(statements);
  return reply({ status: "STAGING", evaluation_revision_id: revisionId, collection, start, accepted: items.length });
}

async function evaluationCounts(db: D1Database, revisionId: string): Promise<Record<ImportCollection, number>> {
  const results = await db.batch([
    db.prepare("SELECT COUNT(*) AS count FROM operational_observation WHERE evaluation_revision_id = ?").bind(revisionId),
    db.prepare("SELECT COUNT(*) AS count FROM operational_coverage WHERE evaluation_revision_id = ?").bind(revisionId),
    db.prepare("SELECT COUNT(*) AS count FROM operational_finding_occurrence WHERE evaluation_revision_id = ?").bind(revisionId),
  ]);
  return {
    observations: countResult(results[0]),
    coverage: countResult(results[1]),
    findings: countResult(results[2]),
  };
}

async function activateEvaluation(request: Request, env: OperationalFindingsEnv, revisionId: string): Promise<Response> {
  await authorize(request, env.ADMIN_IMPORT_TOKEN);
  const revision = await stagingEvaluation(env.DB, revisionId);
  const actual = await evaluationCounts(env.DB, revisionId);
  const expected = {
    observations: Number(revision.expected_observation_count),
    coverage: Number(revision.expected_coverage_count),
    findings: Number(revision.expected_finding_count),
  };
  const mismatches = Object.entries(expected)
    .filter(([key, value]) => actual[key as ImportCollection] !== value)
    .map(([key, value]) => ({ collection: key, expected: value, actual: actual[key as ImportCollection] }));
  if (mismatches.length) throw new OperationalHttpError(409, "Evaluation counts do not match manifest", mismatches);

  const sourceId = String(revision.source_id);
  const current = await env.DB.prepare(
    `SELECT evaluation_revision_id, evaluated_at
       FROM operational_evaluation_revision
      WHERE source_id = ? AND is_current = 1 LIMIT 1`
  ).bind(sourceId).first<{ evaluation_revision_id: string; evaluated_at: string }>();
  if (current && Date.parse(String(current.evaluated_at)) >= Date.parse(String(revision.evaluated_at))) {
    throw new OperationalHttpError(409, "A newer or equal operational evaluation is already current for this source", {
      current_evaluation_revision_id: current.evaluation_revision_id,
      current_evaluated_at: current.evaluated_at,
      supplied_evaluated_at: revision.evaluated_at,
    });
  }

  const activatedAt = new Date().toISOString();
  const initialEventPrefix = `fsev_${crypto.randomUUID().replaceAll("-", "")}_`;
  const reopenEventPrefix = `fsev_${crypto.randomUUID().replaceAll("-", "")}_`;

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE operational_evaluation_revision SET is_current = 0, status = 'SUPERSEDED' WHERE source_id = ? AND is_current = 1"
    ).bind(sourceId),
    env.DB.prepare(
      "UPDATE operational_evaluation_revision SET is_current = 1, status = 'ACTIVE', activated_at = ? WHERE evaluation_revision_id = ?"
    ).bind(activatedAt, revisionId),
    env.DB.prepare(
      `INSERT INTO operational_finding_state_event
        (event_id, finding_id, status, changed_at, note, transition_source)
       SELECT ? || printf('%06d', row_number() OVER (ORDER BY f.finding_id)),
              f.finding_id, 'OPEN', ?, NULL, 'evaluation_activation'
         FROM operational_finding_occurrence f
         LEFT JOIN operational_finding_state s ON s.finding_id = f.finding_id
        WHERE f.evaluation_revision_id = ? AND s.finding_id IS NULL`
    ).bind(initialEventPrefix, activatedAt, revisionId),
    env.DB.prepare(
      `INSERT INTO operational_finding_state_event
        (event_id, finding_id, status, changed_at, note, transition_source)
       SELECT ? || printf('%06d', row_number() OVER (ORDER BY f.finding_id)),
              f.finding_id, 'OPEN', ?, 'Reopened by newer evaluation evidence', 'evaluation_activation'
         FROM operational_finding_occurrence f
         JOIN operational_finding_state s ON s.finding_id = f.finding_id
        WHERE f.evaluation_revision_id = ?
          AND s.status = 'RESOLVED'
          AND f.last_seen > s.changed_at`
    ).bind(reopenEventPrefix, activatedAt, revisionId),
    env.DB.prepare(
      `INSERT INTO operational_finding_state
        (finding_id, status, opened_at, last_seen_at, changed_at, note, transition_source)
       SELECT f.finding_id, 'OPEN', f.first_seen, f.last_seen, ?, NULL, 'evaluation_activation'
         FROM operational_finding_occurrence f
         LEFT JOIN operational_finding_state s ON s.finding_id = f.finding_id
        WHERE f.evaluation_revision_id = ? AND s.finding_id IS NULL`
    ).bind(activatedAt, revisionId),
    env.DB.prepare(
      `UPDATE operational_finding_state
          SET status = 'OPEN',
              opened_at = (SELECT f.first_seen FROM operational_finding_occurrence f
                            WHERE f.evaluation_revision_id = ? AND f.finding_id = operational_finding_state.finding_id),
              last_seen_at = (SELECT f.last_seen FROM operational_finding_occurrence f
                               WHERE f.evaluation_revision_id = ? AND f.finding_id = operational_finding_state.finding_id),
              changed_at = ?,
              note = 'Reopened by newer evaluation evidence',
              transition_source = 'evaluation_activation'
        WHERE status = 'RESOLVED'
          AND EXISTS (
            SELECT 1 FROM operational_finding_occurrence f
             WHERE f.evaluation_revision_id = ?
               AND f.finding_id = operational_finding_state.finding_id
               AND f.last_seen > operational_finding_state.changed_at
          )`
    ).bind(revisionId, revisionId, activatedAt, revisionId),
    env.DB.prepare(
      `UPDATE operational_finding_state
          SET last_seen_at = (
            SELECT CASE
                     WHEN f.last_seen > operational_finding_state.last_seen_at THEN f.last_seen
                     ELSE operational_finding_state.last_seen_at
                   END
              FROM operational_finding_occurrence f
             WHERE f.evaluation_revision_id = ? AND f.finding_id = operational_finding_state.finding_id
          )
        WHERE EXISTS (
          SELECT 1 FROM operational_finding_occurrence f
           WHERE f.evaluation_revision_id = ?
             AND f.finding_id = operational_finding_state.finding_id
        )`
    ).bind(revisionId, revisionId),
  ]);

  return reply({
    status: "ACTIVE",
    evaluation_revision_id: revisionId,
    source_id: sourceId,
    previous_evaluation_revision_id: current?.evaluation_revision_id ?? null,
    counts: actual,
    activated_at: activatedAt,
  });
}

async function evaluationProgress(request: Request, env: OperationalFindingsEnv, revisionId: string): Promise<Response> {
  await authorize(request, env.ADMIN_IMPORT_TOKEN);
  const revision = await env.DB.prepare(
    `SELECT evaluation_revision_id, source_id, source_host, environment, evaluator, evaluator_version,
            evaluated_at, imported_at, activated_at, status, is_current,
            expected_observation_count, expected_coverage_count, expected_finding_count
       FROM operational_evaluation_revision WHERE evaluation_revision_id = ? LIMIT 1`
  ).bind(revisionId).first<Row>();
  if (!revision) throw new OperationalHttpError(404, "Operational evaluation revision not found");
  return reply({ revision, actual: await evaluationCounts(env.DB, revisionId) });
}

async function operationsStatus(env: OperationalFindingsEnv): Promise<Response> {
  try {
    const [sources, findings, observations, gaps] = await env.DB.batch([
      env.DB.prepare("SELECT COUNT(*) AS count FROM operational_evaluation_revision WHERE is_current = 1"),
      env.DB.prepare(
        `SELECT COUNT(DISTINCT f.finding_id) AS count
           FROM operational_finding_occurrence f
           JOIN operational_evaluation_revision r ON r.evaluation_revision_id = f.evaluation_revision_id
          WHERE r.is_current = 1`
      ),
      env.DB.prepare(
        `SELECT COUNT(*) AS count
           FROM operational_observation o
           JOIN operational_evaluation_revision r ON r.evaluation_revision_id = o.evaluation_revision_id
          WHERE r.is_current = 1`
      ),
      env.DB.prepare(
        `SELECT COUNT(*) AS count
           FROM operational_coverage c
           JOIN operational_evaluation_revision r ON r.evaluation_revision_id = c.evaluation_revision_id
          WHERE r.is_current = 1 AND c.state IN ('partial', 'failed', 'not_collected')`
      ),
    ]);
    return reply({
      schema_version: "osi.operations.read/v1",
      database_ready: true,
      import_enabled: Boolean(env.ADMIN_IMPORT_TOKEN?.trim()),
      current_sources: countResult(sources),
      current_findings: countResult(findings),
      current_observations: countResult(observations),
      current_coverage_gaps: countResult(gaps),
    });
  } catch {
    return reply({
      schema_version: "osi.operations.read/v1",
      database_ready: false,
      import_enabled: Boolean(env.ADMIN_IMPORT_TOKEN?.trim()),
      current_sources: 0,
      current_findings: 0,
      current_observations: 0,
      current_coverage_gaps: 0,
    });
  }
}

function findingFilters(url: URL) {
  const severity = textParam(url, "severity", 50);
  const status = textParam(url, "status", 50);
  const semanticType = textParam(url, "semantic_type", 200);
  const entityId = textParam(url, "entity_id", 100);
  const ruleId = textParam(url, "rule_id", 300);
  const query = textParam(url, "q", 200).toLowerCase();
  if (severity && !SEVERITIES.has(severity)) throw new OperationalHttpError(400, `Unsupported severity: ${severity}`);
  if (status && !FINDING_STATUSES.has(status)) throw new OperationalHttpError(400, `Unsupported status: ${status}`);
  if (entityId) canonicalEntityId(entityId);
  return { severity, status, semanticType, entityId, ruleId, query };
}

function findingFromRow(row: Row) {
  return {
    finding_id: row.finding_id,
    rule_id: row.rule_id,
    entity_id: row.entity_id,
    semantic_type: row.semantic_type,
    display_name: row.display_name,
    severity: row.severity,
    status: row.lifecycle_status ?? "OPEN",
    summary: row.summary,
    diagnosis: row.diagnosis,
    confidence: parseJson(row.confidence_json, {}),
    first_seen: row.lifecycle_opened_at ?? row.first_seen,
    last_seen: row.lifecycle_last_seen_at ?? row.last_seen,
    coverage_state: row.coverage_state,
    evidence: parseJson(row.evidence_json, []),
    related_entities: parseJson(row.related_entities_json, []),
    details: parseJson(row.details_json, {}),
    lifecycle: {
      changed_at: row.lifecycle_changed_at ?? null,
      note: row.lifecycle_note ?? null,
      transition_source: row.lifecycle_transition_source ?? null,
    },
    current_occurrence_count: Number(row.current_occurrence_count ?? 1),
    representative_source: {
      source_id: row.source_id,
      source_host: row.source_host,
      evaluation_revision_id: row.evaluation_revision_id,
      evaluated_at: row.evaluated_at,
    },
  };
}

async function listCurrentFindings(request: Request, env: OperationalFindingsEnv): Promise<Response> {
  const url = new URL(request.url);
  const { severity, status, semanticType, entityId, ruleId, query } = findingFilters(url);
  const limit = Math.max(1, integerParam(url, "limit", DEFAULT_LIMIT, MAX_LIMIT));
  const offset = integerParam(url, "offset", 0, MAX_OFFSET);
  const where = `r.is_current = 1
    AND (? = '' OR f.severity = ?)
    AND (? = '' OR COALESCE(s.status, 'OPEN') = ?)
    AND (? = '' OR f.semantic_type = ?)
    AND (? = '' OR f.entity_id = ?)
    AND (? = '' OR f.rule_id = ?)
    AND (? = '' OR lower(f.display_name) LIKE '%' || ? || '%' OR lower(f.summary) LIKE '%' || ? || '%' OR lower(f.diagnosis) LIKE '%' || ? || '%')`;
  const bindings = [
    severity, severity,
    status, status,
    semanticType, semanticType,
    entityId, entityId,
    ruleId, ruleId,
    query, query, query, query,
  ] as const;

  const [rows, total] = await env.DB.batch([
    env.DB.prepare(
      `WITH ranked AS (
         SELECT f.*, r.source_id, r.source_host, r.evaluation_revision_id, r.evaluated_at,
                COALESCE(s.status, 'OPEN') AS lifecycle_status,
                COALESCE(s.opened_at, f.first_seen) AS lifecycle_opened_at,
                COALESCE(s.last_seen_at, f.last_seen) AS lifecycle_last_seen_at,
                s.changed_at AS lifecycle_changed_at,
                s.note AS lifecycle_note,
                s.transition_source AS lifecycle_transition_source,
                ROW_NUMBER() OVER (
                  PARTITION BY f.finding_id
                  ORDER BY f.last_seen DESC, r.evaluated_at DESC, r.evaluation_revision_id DESC
                ) AS occurrence_rank,
                COUNT(*) OVER (PARTITION BY f.finding_id) AS current_occurrence_count
           FROM operational_finding_occurrence f
           JOIN operational_evaluation_revision r ON r.evaluation_revision_id = f.evaluation_revision_id
           LEFT JOIN operational_finding_state s ON s.finding_id = f.finding_id
          WHERE ${where}
       )
       SELECT * FROM ranked
        WHERE occurrence_rank = 1
        ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                 last_seen DESC, lower(display_name), finding_id
        LIMIT ? OFFSET ?`
    ).bind(...bindings, limit, offset),
    env.DB.prepare(
      `SELECT COUNT(DISTINCT f.finding_id) AS count
         FROM operational_finding_occurrence f
         JOIN operational_evaluation_revision r ON r.evaluation_revision_id = f.evaluation_revision_id
         LEFT JOIN operational_finding_state s ON s.finding_id = f.finding_id
        WHERE ${where}`
    ).bind(...bindings),
  ]);

  const findings = (rows.results ?? []).map((row) => findingFromRow(row as Row));
  const totalCount = countResult(total);
  return reply({
    schema_version: "osi.findings.read/v1",
    page: { total: totalCount, limit, offset, next_offset: offset + findings.length < totalCount ? offset + findings.length : null },
    findings,
  });
}

async function currentFindingDetail(env: OperationalFindingsEnv, findingId: string): Promise<Response> {
  canonicalFindingId(findingId);
  const state = await env.DB.prepare(
    `SELECT finding_id, status, opened_at, last_seen_at, changed_at, note, transition_source
       FROM operational_finding_state WHERE finding_id = ? LIMIT 1`
  ).bind(findingId).first<Row>();
  const occurrences = await env.DB.prepare(
    `SELECT f.*, r.source_id, r.source_host, r.environment, r.evaluation_revision_id, r.evaluated_at
       FROM operational_finding_occurrence f
       JOIN operational_evaluation_revision r ON r.evaluation_revision_id = f.evaluation_revision_id
      WHERE r.is_current = 1 AND f.finding_id = ?
      ORDER BY f.last_seen DESC, r.evaluated_at DESC`
  ).bind(findingId).all<Row>();
  if (!occurrences.results.length) return reply({ detail: "Current finding not found" }, 404);

  const first = occurrences.results[0] as Row;
  const representative = findingFromRow({
    ...first,
    lifecycle_status: state?.status ?? "OPEN",
    lifecycle_opened_at: state?.opened_at ?? first.first_seen,
    lifecycle_last_seen_at: state?.last_seen_at ?? first.last_seen,
    lifecycle_changed_at: state?.changed_at ?? null,
    lifecycle_note: state?.note ?? null,
    lifecycle_transition_source: state?.transition_source ?? null,
    current_occurrence_count: occurrences.results.length,
  });
  const history = await env.DB.prepare(
    `SELECT event_id, status, changed_at, note, transition_source
       FROM operational_finding_state_event
      WHERE finding_id = ? ORDER BY changed_at DESC, event_id DESC LIMIT 100`
  ).bind(findingId).all<Row>();

  return reply({
    schema_version: "osi.findings.read/v1",
    finding: representative,
    occurrences: occurrences.results.map((row) => ({
      source_id: (row as Row).source_id,
      source_host: (row as Row).source_host,
      environment: (row as Row).environment,
      evaluation_revision_id: (row as Row).evaluation_revision_id,
      evaluated_at: (row as Row).evaluated_at,
      first_seen: (row as Row).first_seen,
      last_seen: (row as Row).last_seen,
      evidence: parseJson((row as Row).evidence_json, []),
      details: parseJson((row as Row).details_json, {}),
    })),
    lifecycle_history: history.results,
  });
}

async function mutateFindingLifecycle(request: Request, env: OperationalFindingsEnv, findingId: string): Promise<Response> {
  await authorize(request, env.ADMIN_IMPORT_TOKEN);
  canonicalFindingId(findingId);
  const body = asObject(await jsonBody(request), "lifecycle change");
  const status = enumString(body.status, "status", FINDING_STATUSES);
  const note = optionalString(body.note, 4000);

  const occurrence = await env.DB.prepare(
    `SELECT MIN(f.first_seen) AS first_seen, MAX(f.last_seen) AS last_seen
       FROM operational_finding_occurrence f
       JOIN operational_evaluation_revision r ON r.evaluation_revision_id = f.evaluation_revision_id
      WHERE r.is_current = 1 AND f.finding_id = ?`
  ).bind(findingId).first<Row>();
  if (!occurrence?.first_seen || !occurrence?.last_seen) {
    throw new OperationalHttpError(404, "Lifecycle can only be changed for a current finding");
  }

  const existing = await env.DB.prepare(
    "SELECT * FROM operational_finding_state WHERE finding_id = ? LIMIT 1"
  ).bind(findingId).first<Row>();
  if (existing && existing.status === status && String(existing.note ?? "") === String(note ?? "")) {
    return reply({
      finding_id: findingId,
      status,
      changed_at: existing.changed_at,
      note: existing.note ?? null,
      transition_source: existing.transition_source,
      changed: false,
    });
  }

  const changedAt = new Date().toISOString();
  const openedAt = status === "OPEN" && existing?.status !== "OPEN"
    ? changedAt
    : String(existing?.opened_at ?? occurrence.first_seen);
  const eventId = `fsev_${crypto.randomUUID().replaceAll("-", "")}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO operational_finding_state
        (finding_id, status, opened_at, last_seen_at, changed_at, note, transition_source)
       VALUES (?, ?, ?, ?, ?, ?, 'operator_api')
       ON CONFLICT(finding_id) DO UPDATE SET
         status = excluded.status,
         opened_at = CASE WHEN excluded.status = 'OPEN' THEN excluded.opened_at ELSE operational_finding_state.opened_at END,
         last_seen_at = CASE WHEN excluded.last_seen_at > operational_finding_state.last_seen_at THEN excluded.last_seen_at ELSE operational_finding_state.last_seen_at END,
         changed_at = excluded.changed_at,
         note = excluded.note,
         transition_source = 'operator_api'`
    ).bind(findingId, status, openedAt, String(occurrence.last_seen), changedAt, note),
    env.DB.prepare(
      `INSERT INTO operational_finding_state_event
        (event_id, finding_id, status, changed_at, note, transition_source)
       VALUES (?, ?, ?, ?, ?, 'operator_api')`
    ).bind(eventId, findingId, status, changedAt, note),
  ]);

  return reply({ finding_id: findingId, status, changed_at: changedAt, note, transition_source: "operator_api", changed: true });
}

async function listCurrentObservations(request: Request, env: OperationalFindingsEnv): Promise<Response> {
  const url = new URL(request.url);
  const entityId = textParam(url, "entity_id", 100);
  const observationType = textParam(url, "observation_type", 300);
  const sourceId = textParam(url, "source_id", 500);
  if (entityId) canonicalEntityId(entityId);
  const limit = Math.max(1, integerParam(url, "limit", 100, MAX_LIMIT));
  const offset = integerParam(url, "offset", 0, MAX_OFFSET);
  const where = `r.is_current = 1
    AND (? = '' OR o.entity_id = ?)
    AND (? = '' OR o.observation_type = ?)
    AND (? = '' OR r.source_id = ?)`;
  const bindings = [entityId, entityId, observationType, observationType, sourceId, sourceId] as const;
  const [rows, total] = await env.DB.batch([
    env.DB.prepare(
      `SELECT o.*, r.source_id AS evaluation_source_id, r.source_host AS evaluation_source_host,
              r.evaluation_revision_id, r.evaluated_at
         FROM operational_observation o
         JOIN operational_evaluation_revision r ON r.evaluation_revision_id = o.evaluation_revision_id
        WHERE ${where}
        ORDER BY o.observed_at DESC, o.entity_id, o.observation_type, o.observation_id
        LIMIT ? OFFSET ?`
    ).bind(...bindings, limit, offset),
    env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM operational_observation o
         JOIN operational_evaluation_revision r ON r.evaluation_revision_id = o.evaluation_revision_id
        WHERE ${where}`
    ).bind(...bindings),
  ]);
  const observations = (rows.results ?? []).map((raw) => {
    const row = raw as Row;
    return {
      observation_id: row.observation_id,
      entity_id: row.entity_id,
      semantic_type: row.semantic_type,
      display_name: row.display_name,
      observation_type: row.observation_type,
      observed_at: row.observed_at,
      value: parseJson(row.value_json, null),
      unit: row.unit,
      source: parseJson(row.source_json, {}),
      quality: parseJson(row.quality_json, {}),
      dimensions: parseJson(row.dimensions_json, {}),
      evaluation: {
        source_id: row.evaluation_source_id,
        source_host: row.evaluation_source_host,
        evaluation_revision_id: row.evaluation_revision_id,
        evaluated_at: row.evaluated_at,
      },
    };
  });
  const totalCount = countResult(total);
  return reply({
    schema_version: "osi.operations.read/v1",
    page: { total: totalCount, limit, offset, next_offset: offset + observations.length < totalCount ? offset + observations.length : null },
    observations,
  });
}

async function listCurrentCoverage(request: Request, env: OperationalFindingsEnv): Promise<Response> {
  const url = new URL(request.url);
  const scopeType = textParam(url, "scope_type", 100);
  const scopeKey = textParam(url, "scope_key", 500);
  const family = textParam(url, "observation_family", 300);
  const state = textParam(url, "state", 50);
  const sourceId = textParam(url, "source_id", 500);
  if (state && !RAW_COVERAGE.has(state)) throw new OperationalHttpError(400, `Unsupported coverage state: ${state}`);
  const limit = Math.max(1, integerParam(url, "limit", 100, MAX_LIMIT));
  const offset = integerParam(url, "offset", 0, MAX_OFFSET);
  const where = `r.is_current = 1
    AND (? = '' OR c.scope_type = ?)
    AND (? = '' OR c.scope_key = ?)
    AND (? = '' OR c.observation_family = ?)
    AND (? = '' OR c.state = ?)
    AND (? = '' OR r.source_id = ?)`;
  const bindings = [scopeType, scopeType, scopeKey, scopeKey, family, family, state, state, sourceId, sourceId] as const;
  const [rows, total] = await env.DB.batch([
    env.DB.prepare(
      `SELECT c.*, r.source_id, r.source_host, r.evaluation_revision_id, r.evaluated_at
         FROM operational_coverage c
         JOIN operational_evaluation_revision r ON r.evaluation_revision_id = c.evaluation_revision_id
        WHERE ${where}
        ORDER BY c.observed_at DESC, c.scope_key, c.observation_family, c.sample_id
        LIMIT ? OFFSET ?`
    ).bind(...bindings, limit, offset),
    env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM operational_coverage c
         JOIN operational_evaluation_revision r ON r.evaluation_revision_id = c.evaluation_revision_id
        WHERE ${where}`
    ).bind(...bindings),
  ]);
  const totalCount = countResult(total);
  return reply({
    schema_version: "osi.operations.read/v1",
    page: { total: totalCount, limit, offset, next_offset: offset + (rows.results?.length ?? 0) < totalCount ? offset + (rows.results?.length ?? 0) : null },
    coverage: (rows.results ?? []).map((raw) => {
      const row = raw as Row;
      return {
        scope_type: row.scope_type,
        scope_key: row.scope_key,
        observation_family: row.observation_family,
        sample_id: row.sample_id,
        observed_at: row.observed_at,
        state: row.state,
        evidence_ref: row.evidence_ref,
        error: row.error ?? null,
        evaluation: {
          source_id: row.source_id,
          source_host: row.source_host,
          evaluation_revision_id: row.evaluation_revision_id,
          evaluated_at: row.evaluated_at,
        },
      };
    }),
  });
}

export async function handleOperationalFindings(request: Request, env: OperationalFindingsEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  try {
    if (request.method === "GET" && path === "/api/v2/operations/status") return await operationsStatus(env);
    if (request.method === "GET" && path === "/api/v2/operations/current/observations") return await listCurrentObservations(request, env);
    if (request.method === "GET" && path === "/api/v2/operations/current/coverage") return await listCurrentCoverage(request, env);
    if (request.method === "POST" && path === "/api/v2/operations/evaluations") return await createEvaluation(request, env);
    if (request.method === "GET" && path === "/api/v2/findings/current") return await listCurrentFindings(request, env);

    const findingCurrent = path.match(/^\/api\/v2\/findings\/current\/(find_[0-9a-f]{24})$/);
    if (request.method === "GET" && findingCurrent) return await currentFindingDetail(env, findingCurrent[1]);

    const findingLifecycle = path.match(/^\/api\/v2\/findings\/(find_[0-9a-f]{24})\/lifecycle$/);
    if (request.method === "POST" && findingLifecycle) return await mutateFindingLifecycle(request, env, findingLifecycle[1]);

    const evaluation = path.match(/^\/api\/v2\/operations\/evaluations\/([^/]+)(?:\/(observations|coverage|findings|activate))?$/);
    if (!evaluation) return null;
    const revisionId = decodeURIComponent(evaluation[1]);
    const action = evaluation[2];
    if (request.method === "GET" && !action) return await evaluationProgress(request, env, revisionId);
    if (request.method === "POST" && action === "activate") return await activateEvaluation(request, env, revisionId);
    if (request.method === "POST" && action && action !== "activate") {
      return await appendCollection(request, env, revisionId, action as ImportCollection);
    }
    return reply({ detail: "Method not allowed" }, 405);
  } catch (error) {
    if (error instanceof OperationalHttpError) return reply({ detail: error.message, errors: error.details ?? null }, error.status);
    console.error("operational findings error", error);
    return reply({ detail: "Operational findings request failed" }, 500);
  }
}
