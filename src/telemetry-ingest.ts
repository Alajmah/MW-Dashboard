import {
  classifyTelemetryDelivery,
  telemetryIngestAck,
  verifyTelemetryDelivery,
  type DeliveryLedgerRecord,
  type TelemetryKeyRecord,
  type VerifiedTelemetryDelivery,
} from "./telemetry-ingest-verify";

export interface TelemetryIngestEnv {
  DB: D1Database;
  TELEMETRY_INGEST_ENABLED?: string;
  TELEMETRY_INGEST_KEYS_JSON?: string;
}

type JsonMap = Record<string, unknown>;
type Meter = { rows_read: number; rows_written: number };

type LedgerRow = DeliveryLedgerRecord & {
  source_host: string;
  key_id: string;
  run_id: string;
  estate_revision_id: string | null;
  status: "PROCESSING" | "ACCEPTED";
  first_received_at: string;
  last_attempt_at: string;
  accepted_at: string | null;
  attempt_token: string | null;
  payload_bytes: number;
  observation_count: number;
  resolved_count: number;
  quarantine_count: number;
};

type CanonicalCandidate = {
  entity_id: string;
  semantic_type: string;
  identity_rule: string;
  identity_key: string;
  identity_state: string;
  display_name: string;
  properties_json: string;
};

type Resolution = {
  observation: JsonMap;
  entity_id?: string;
  reason: string;
  candidate_entity_ids: string[];
};

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const INGEST_PATH = "/api/v2/telemetry/ingest";
const STATUS_PATH = "/api/v2/telemetry/status";
const MAX_OBSERVATIONS = 5000;
const MAX_COVERAGE = 5000;
const PROCESSING_LEASE_SECONDS = 300;
const STATEMENT_CHUNK = 100;
const KEY_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const SOURCE_ID_MAX = 512;
const SUPPORTED_SCOPED = new Set(["mq.queue", "mq.channel", "mq.listener"]);

function reply(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function meterHeaders(meter: Meter): Record<string, string> {
  return {
    "x-osi-d1-rows-read": String(meter.rows_read),
    "x-osi-d1-rows-written": String(meter.rows_written),
  };
}

function addMeta(meter: Meter, result: unknown): void {
  const meta = (result as { meta?: { rows_read?: number; rows_written?: number } })?.meta;
  meter.rows_read += Number(meta?.rows_read ?? 0);
  meter.rows_written += Number(meta?.rows_written ?? 0);
}

async function all<T>(statement: D1PreparedStatement, meter: Meter): Promise<T[]> {
  const result = await statement.all<T>();
  addMeta(meter, result);
  return result.results;
}

async function run(statement: D1PreparedStatement, meter: Meter): Promise<D1Result> {
  const result = await statement.run();
  addMeta(meter, result);
  return result;
}

async function batch(db: D1Database, statements: D1PreparedStatement[], meter: Meter): Promise<D1Result[]> {
  if (!statements.length) return [];
  const result = await db.batch(statements);
  for (const item of result) addMeta(meter, item);
  return result;
}

async function batchChunks(db: D1Database, statements: D1PreparedStatement[], meter: Meter): Promise<void> {
  for (let offset = 0; offset < statements.length; offset += STATEMENT_CHUNK) {
    await batch(db, statements.slice(offset, offset + STATEMENT_CHUNK), meter);
  }
}

function isObject(value: unknown): value is JsonMap {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function scalar(value: unknown): string {
  return value == null || typeof value === "object" ? "" : String(value).trim();
}

function lower(value: unknown): string {
  return scalar(value).toLowerCase();
}

function parseJson(value: unknown): JsonMap {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseIdentityKey(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawPart of value.split("|")) {
    const equals = rawPart.indexOf("=");
    if (equals < 1) continue;
    let key = rawPart.slice(0, equals).trim().toLowerCase();
    const raw = rawPart.slice(equals + 1).trim().toLowerCase();
    if (key.includes(":")) key = key.slice(key.lastIndexOf(":") + 1);
    if (key && raw) result[key] = raw;
  }
  return result;
}

function stableDimensions(value: unknown): { key: string; json: string } {
  if (!isObject(value)) return { key: "{}", json: "{}" };
  const normalized: JsonMap = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item == null || ["string", "number", "boolean"].includes(typeof item)) normalized[key] = item;
  }
  const json = JSON.stringify(normalized);
  if (json.length > 4096) throw new Error("telemetry dimensions exceed 4096 characters");
  return { key: json, json };
}

function normalizedIso(value: unknown, label: string): string {
  const text = scalar(value);
  const parsed = new Date(text);
  if (!text || Number.isNaN(parsed.getTime())) throw new Error(`${label} must be a valid date-time`);
  return parsed.toISOString();
}

function ingressEnabled(env: TelemetryIngestEnv): boolean {
  return (env.TELEMETRY_INGEST_ENABLED ?? "").trim().toLowerCase() === "true";
}

function keyRegistry(raw: string | undefined): { keys: Map<string, TelemetryKeyRecord>; valid: boolean } {
  if (!raw?.trim()) return { keys: new Map(), valid: true };
  try {
    const parsed = JSON.parse(raw);
    if (!isObject(parsed) || !Array.isArray(parsed.keys)) return { keys: new Map(), valid: false };
    const keys = new Map<string, TelemetryKeyRecord>();
    for (const item of parsed.keys) {
      if (!isObject(item)) return { keys: new Map(), valid: false };
      const keyId = scalar(item.key_id);
      const sourceId = scalar(item.source_id);
      const secret = typeof item.secret === "string" ? item.secret : "";
      const status = scalar(item.status) as TelemetryKeyRecord["status"];
      if (!KEY_ID_RE.test(keyId) || !sourceId || sourceId.length > SOURCE_ID_MAX || keys.has(keyId)) {
        return { keys: new Map(), valid: false };
      }
      keys.set(keyId, {
        key_id: keyId,
        source_id: sourceId,
        secret,
        status,
        not_before_epoch: item.not_before_epoch == null ? null : Number(item.not_before_epoch),
        not_after_epoch: item.not_after_epoch == null ? null : Number(item.not_after_epoch),
      });
    }
    return { keys, valid: true };
  } catch {
    return { keys: new Map(), valid: false };
  }
}

function validateBatch(batchValue: Record<string, unknown>, verifiedSourceId: string): {
  run: JsonMap;
  source: JsonMap;
  observations: JsonMap[];
  coverage: JsonMap[];
} {
  const runValue = batchValue.run;
  if (!isObject(runValue)) throw new Error("telemetry batch run must be an object");
  const sourceValue = runValue.source;
  if (!isObject(sourceValue)) throw new Error("telemetry batch run.source must be an object");
  const sourceId = scalar(sourceValue.source_id);
  const sourceHost = scalar(sourceValue.source_host);
  const runId = scalar(runValue.run_id);
  if (!runId || !sourceId || !sourceHost) throw new Error("telemetry batch run identity is incomplete");
  if (sourceId !== verifiedSourceId) throw new Error("authenticated source id does not match telemetry run source");

  const observationsValue = batchValue.observations;
  const coverageValue = batchValue.coverage;
  if (!Array.isArray(observationsValue) || observationsValue.length > MAX_OBSERVATIONS) {
    throw new Error(`telemetry observations must contain at most ${MAX_OBSERVATIONS} items`);
  }
  if (!Array.isArray(coverageValue) || coverageValue.length > MAX_COVERAGE) {
    throw new Error(`telemetry coverage must contain at most ${MAX_COVERAGE} items`);
  }

  const observations: JsonMap[] = [];
  const seenIds = new Set<string>();
  for (let index = 0; index < observationsValue.length; index++) {
    const observation = observationsValue[index];
    if (!isObject(observation)) throw new Error(`observations[${index}] must be an object`);
    const observationId = scalar(observation.observation_id);
    if (!/^tobs_[0-9a-f]{24}$/.test(observationId) || seenIds.has(observationId)) {
      throw new Error(`observations[${index}].observation_id is invalid or duplicated`);
    }
    seenIds.add(observationId);
    normalizedIso(observation.observed_at, `observations[${index}].observed_at`);
    if (!scalar(observation.observation_type) || !scalar(observation.unit)) {
      throw new Error(`observations[${index}] requires observation_type and unit`);
    }
    if (!isObject(observation.entity) || !isObject((observation.entity as JsonMap).identity_hints)) {
      throw new Error(`observations[${index}].entity identity hints are required`);
    }
    if (!isObject(observation.source)) throw new Error(`observations[${index}].source is required`);
    const obsSource = observation.source as JsonMap;
    if (scalar(obsSource.source_id) !== sourceId || scalar(obsSource.source_host) !== sourceHost) {
      throw new Error(`observations[${index}] source does not match run source`);
    }
    stableDimensions(observation.dimensions);
    observations.push(observation);
  }

  const coverage: JsonMap[] = [];
  for (let index = 0; index < coverageValue.length; index++) {
    const item = coverageValue[index];
    if (!isObject(item)) throw new Error(`coverage[${index}] must be an object`);
    normalizedIso(item.observed_at, `coverage[${index}].observed_at`);
    coverage.push(item);
  }
  return { run: runValue, source: sourceValue, observations, coverage };
}

function candidateIds(candidates: CanonicalCandidate[]): string[] {
  return candidates.map((item) => item.entity_id).filter(Boolean).sort();
}

function uniqueResolved(
  candidates: CanonicalCandidate[],
  resolvedReason: string,
  ambiguousReason: string,
  notFoundReason: string,
): { entity_id?: string; reason: string; candidates: string[] } {
  const ids = candidateIds(candidates);
  if (!candidates.length) return { reason: notFoundReason, candidates: ids };
  const unresolved = candidates.filter((item) => item.identity_state !== "resolved");
  const resolved = candidates.filter((item) => item.identity_state === "resolved");
  if (unresolved.length) {
    return { reason: resolved.length ? "canonical_identity_conflict" : "canonical_identity_not_resolved", candidates: ids };
  }
  if (resolved.length === 1) return { entity_id: resolved[0].entity_id, reason: resolvedReason, candidates: ids };
  return { reason: ambiguousReason, candidates: ids };
}

function qmidFor(candidate: CanonicalCandidate): string {
  const properties = parseJson(candidate.properties_json);
  const fromProperties = lower(properties.QMID ?? properties.qmid);
  if (fromProperties) return fromProperties;
  const parsed = parseIdentityKey(candidate.identity_key);
  if (parsed.qmid) return lower(parsed.qmid);
  if (lower(candidate.identity_rule) === "qmid" && !candidate.identity_key.includes("=")) return lower(candidate.identity_key);
  return "";
}

function resolveQmgr(
  hints: JsonMap,
  qmgrs: CanonicalCandidate[],
): { entity_id?: string; reason: string; candidates: string[] } {
  const qmid = lower(hints.queue_manager_qmid);
  const name = lower(hints.queue_manager_name);
  if (qmid) {
    const match = uniqueResolved(
      qmgrs.filter((item) => qmidFor(item) === qmid),
      "resolved_by_qmid",
      "ambiguous_qmid",
      "qmid_not_found",
    );
    if (!match.entity_id) return match;
    const candidate = qmgrs.find((item) => item.entity_id === match.entity_id);
    if (name && candidate && lower(candidate.display_name) !== name) {
      return { reason: "queue_manager_identity_mismatch", candidates: match.candidates };
    }
    return match;
  }
  if (!name) return { reason: "missing_queue_manager_identity", candidates: [] };
  return uniqueResolved(
    qmgrs.filter((item) => lower(item.display_name) === name),
    "resolved_by_name",
    "ambiguous_queue_manager_name",
    "queue_manager_name_not_found",
  );
}

async function currentEstate(db: D1Database, meter: Meter): Promise<{ revision_id: string; qmgrs: CanonicalCandidate[] }> {
  const revisions = await all<{ estate_revision_id: string }>(
    db.prepare("SELECT estate_revision_id FROM semantic_estate_revision WHERE is_current = 1 LIMIT 1"),
    meter,
  );
  const revision = revisions[0]?.estate_revision_id;
  if (!revision) throw new Error("no current canonical estate revision");
  const qmgrs = await all<CanonicalCandidate>(
    db.prepare(
      `SELECT entity_id, semantic_type, identity_rule, identity_key, identity_state,
              display_name, properties_json
         FROM semantic_estate_entity
        WHERE estate_revision_id = ? AND semantic_type = 'mq.queue_manager'`
    ).bind(revision),
    meter,
  );
  return { revision_id: revision, qmgrs };
}

async function resolveObservations(
  db: D1Database,
  meter: Meter,
  observations: JsonMap[],
  estate: { revision_id: string; qmgrs: CanonicalCandidate[] },
): Promise<Resolution[]> {
  const scopedLookup = new Map<string, CanonicalCandidate[]>();
  const lookupKeys: { key: string; semantic_type: string; identity_key: string }[] = [];
  const seenLookup = new Set<string>();

  for (const observation of observations) {
    const entity = isObject(observation.entity) ? observation.entity : {};
    const semanticType = scalar(entity.semantic_type);
    const hints = isObject(entity.identity_hints) ? entity.identity_hints : {};
    if (!SUPPORTED_SCOPED.has(semanticType)) continue;
    const qmgr = lower(hints.queue_manager_name);
    const name = lower(hints.name);
    if (!qmgr || !name) continue;
    const identityKey = `queue_manager_key=${qmgr}|name=${name}`;
    const key = `${semanticType}|${identityKey}`;
    if (!seenLookup.has(key)) {
      seenLookup.add(key);
      lookupKeys.push({ key, semantic_type: semanticType, identity_key: identityKey });
    }
  }

  for (let offset = 0; offset < lookupKeys.length; offset += STATEMENT_CHUNK) {
    const group = lookupKeys.slice(offset, offset + STATEMENT_CHUNK);
    const results = await batch(
      db,
      group.map((lookup) => db.prepare(
        `SELECT entity_id, semantic_type, identity_rule, identity_key, identity_state,
                display_name, properties_json
           FROM semantic_estate_entity
          WHERE estate_revision_id = ? AND semantic_type = ? AND identity_key = ?
          LIMIT 3`
      ).bind(estate.revision_id, lookup.semantic_type, lookup.identity_key)),
      meter,
    );
    results.forEach((result, index) => {
      scopedLookup.set(group[index].key, (result.results ?? []) as unknown as CanonicalCandidate[]);
    });
  }

  return observations.map((observation) => {
    const entity = isObject(observation.entity) ? observation.entity : {};
    const supplied = entity.canonical_entity_id;
    if (supplied != null && scalar(supplied)) {
      return { observation, reason: "untrusted_canonical_id_supplied", candidate_entity_ids: [] };
    }
    const semanticType = scalar(entity.semantic_type);
    const hints = isObject(entity.identity_hints) ? entity.identity_hints : {};
    const source = isObject(observation.source) ? observation.source : {};
    const sourceQmgr = lower(source.queue_manager);
    const hintQmgr = lower(hints.queue_manager_name);
    if (sourceQmgr && hintQmgr && sourceQmgr !== hintQmgr) {
      return { observation, reason: "source_identity_mismatch", candidate_entity_ids: [] };
    }
    if (semanticType === "mq.queue_manager") {
      const resolved = resolveQmgr(hints, estate.qmgrs);
      return { observation, entity_id: resolved.entity_id, reason: resolved.reason, candidate_entity_ids: resolved.candidates };
    }
    if (!SUPPORTED_SCOPED.has(semanticType)) {
      return { observation, reason: "unsupported_semantic_type", candidate_entity_ids: [] };
    }
    const objectName = lower(hints.name);
    if (!hintQmgr || !objectName) {
      return { observation, reason: "missing_scoped_identity", candidate_entity_ids: [] };
    }
    if (lower(hints.queue_manager_qmid)) {
      const owner = resolveQmgr(hints, estate.qmgrs);
      if (!owner.entity_id) {
        return { observation, reason: owner.reason, candidate_entity_ids: owner.candidates };
      }
    }
    const identityKey = `queue_manager_key=${hintQmgr}|name=${objectName}`;
    const lookup = `${semanticType}|${identityKey}`;
    const resolved = uniqueResolved(
      scopedLookup.get(lookup) ?? [],
      "resolved_by_scoped_identity",
      "ambiguous_scoped_identity",
      "scoped_identity_not_found",
    );
    return { observation, entity_id: resolved.entity_id, reason: resolved.reason, candidate_entity_ids: resolved.candidates };
  });
}

async function ledgerRow(db: D1Database, meter: Meter, deliveryId: string): Promise<LedgerRow | null> {
  const rows = await all<LedgerRow>(
    db.prepare("SELECT * FROM telemetry_delivery_ledger WHERE delivery_id = ? LIMIT 1").bind(deliveryId),
    meter,
  );
  return rows[0] ?? null;
}

function sameDelivery(existing: LedgerRow, verified: VerifiedTelemetryDelivery): boolean {
  return classifyTelemetryDelivery(existing, verified).state === "duplicate";
}

async function claimDelivery(
  env: TelemetryIngestEnv,
  meter: Meter,
  verified: VerifiedTelemetryDelivery,
  sourceHost: string,
  runId: string,
  observationCount: number,
): Promise<{ state: "owned"; token: string } | { state: "duplicate" } | { state: "busy" } | { state: "conflict" }> {
  const now = new Date().toISOString();
  const token = crypto.randomUUID();
  let existing = await ledgerRow(env.DB, meter, verified.delivery_id);
  if (existing?.status === "ACCEPTED") return sameDelivery(existing, verified) ? { state: "duplicate" } : { state: "conflict" };
  if (!existing) {
    await run(env.DB.prepare(
      `INSERT OR IGNORE INTO telemetry_delivery_ledger
       (delivery_id, content_sha256, source_id, source_host, key_id, run_id, status,
        first_received_at, last_attempt_at, attempt_token, payload_bytes, observation_count)
       VALUES (?, ?, ?, ?, ?, ?, 'PROCESSING', ?, ?, ?, ?, ?)`
    ).bind(
      verified.delivery_id, verified.content_sha256, verified.source_id, sourceHost, verified.key_id, runId,
      now, now, token, verified.payload_bytes, observationCount,
    ), meter);
    existing = await ledgerRow(env.DB, meter, verified.delivery_id);
    if (!existing) throw new Error("delivery ledger claim was not persisted");
    if (!sameDelivery(existing, verified)) return { state: "conflict" };
    if (existing.attempt_token === token) return { state: "owned", token };
  }
  if (!existing || !sameDelivery(existing, verified)) return { state: "conflict" };
  if (existing.status === "ACCEPTED") return { state: "duplicate" };
  const ageSeconds = (Date.now() - new Date(existing.last_attempt_at).getTime()) / 1000;
  if (Number.isFinite(ageSeconds) && ageSeconds < PROCESSING_LEASE_SECONDS) return { state: "busy" };
  const result = await run(env.DB.prepare(
    `UPDATE telemetry_delivery_ledger
        SET attempt_token = ?, last_attempt_at = ?
      WHERE delivery_id = ? AND status = 'PROCESSING' AND last_attempt_at = ?`
  ).bind(token, now, verified.delivery_id, existing.last_attempt_at), meter);
  const changes = Number((result.meta as { changes?: number } | undefined)?.changes ?? 0);
  return changes === 1 ? { state: "owned", token } : { state: "busy" };
}

async function sha256Text(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((item) => item.toString(16).padStart(2, "0")).join("");
}

function stableSourceJson(source: JsonMap): string {
  return JSON.stringify({
    source_host: scalar(source.source_host),
    queue_manager: scalar(source.queue_manager),
    collection_method: scalar(source.collection_method),
    command: scalar(source.command),
    evidence_class: scalar(source.evidence_class),
  });
}

async function persistResolvedAndQuarantine(
  env: TelemetryIngestEnv,
  meter: Meter,
  verified: VerifiedTelemetryDelivery,
  estateRevisionId: string,
  resolutions: Resolution[],
): Promise<{ resolved: number; quarantined: number; observedKeys: string[]; currentQuarantine: unknown[]; lastObservedAt: string | null }> {
  const latestStatements: D1PreparedStatement[] = [];
  const quarantineStatements: D1PreparedStatement[] = [];
  const observedKeys: string[] = [];
  const currentQuarantine: unknown[] = [];
  let lastObservedAt: string | null = null;
  let resolved = 0;
  let quarantined = 0;

  for (const resolution of resolutions) {
    const observation = resolution.observation;
    const observedAt = normalizedIso(observation.observed_at, "observation.observed_at");
    if (!lastObservedAt || observedAt > lastObservedAt) lastObservedAt = observedAt;
    const entity = isObject(observation.entity) ? observation.entity : {};
    const source = isObject(observation.source) ? observation.source : {};
    const observationType = scalar(observation.observation_type);
    const unit = scalar(observation.unit);
    const dimensions = stableDimensions(observation.dimensions);

    if (resolution.entity_id) {
      resolved += 1;
      observedKeys.push(`${resolution.entity_id}|${observationType}|${dimensions.key}`);
      const quality = isObject(observation.quality) ? observation.quality : {};
      const valueJson = JSON.stringify(observation.value);
      const evidenceRef = scalar(source.evidence_ref);
      latestStatements.push(env.DB.prepare(
        `INSERT INTO telemetry_latest_observation
         (entity_id, observation_type, dimensions_key, dimensions_json, value_json, unit,
          value_observed_at, source_id, source_host, source_json, quality_json, evidence_ref,
          delivery_id, estate_revision_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(entity_id, observation_type, dimensions_key) DO UPDATE SET
           value_json = excluded.value_json,
           unit = excluded.unit,
           value_observed_at = excluded.value_observed_at,
           source_id = excluded.source_id,
           source_host = excluded.source_host,
           source_json = excluded.source_json,
           quality_json = excluded.quality_json,
           evidence_ref = excluded.evidence_ref,
           delivery_id = excluded.delivery_id,
           estate_revision_id = excluded.estate_revision_id
         WHERE excluded.value_json <> telemetry_latest_observation.value_json
            OR excluded.unit <> telemetry_latest_observation.unit
            OR excluded.quality_json <> telemetry_latest_observation.quality_json
            OR excluded.source_json <> telemetry_latest_observation.source_json`
      ).bind(
        resolution.entity_id, observationType, dimensions.key, dimensions.json, valueJson, unit,
        observedAt, verified.source_id, scalar(source.source_host), stableSourceJson(source), JSON.stringify(quality), evidenceRef,
        verified.delivery_id, estateRevisionId,
      ));
      continue;
    }

    quarantined += 1;
    const summary = {
      observation_id: scalar(observation.observation_id) || null,
      semantic_type: scalar(entity.semantic_type) || null,
      display_name: scalar(entity.display_name) || null,
      reason: resolution.reason,
      candidate_entity_ids: resolution.candidate_entity_ids,
    };
    currentQuarantine.push(summary);
    const fingerprint = await sha256Text(JSON.stringify({
      source_id: verified.source_id,
      semantic_type: summary.semantic_type,
      display_name: summary.display_name,
      reason: summary.reason,
      candidates: summary.candidate_entity_ids,
    }));
    const quarantineKey = `tq_${fingerprint.slice(0, 24)}`;
    quarantineStatements.push(env.DB.prepare(
      `INSERT OR IGNORE INTO telemetry_quarantine
       (quarantine_key, source_id, semantic_type, display_name, reason,
        candidate_entity_ids_json, first_delivery_id, first_observation_id, first_observed_at, first_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      quarantineKey, verified.source_id, summary.semantic_type, summary.display_name, summary.reason,
      JSON.stringify(summary.candidate_entity_ids), verified.delivery_id, summary.observation_id, observedAt, new Date().toISOString(),
    ));
  }

  await batchChunks(env.DB, latestStatements, meter);
  await batchChunks(env.DB, quarantineStatements, meter);
  observedKeys.sort();
  return { resolved, quarantined, observedKeys, currentQuarantine, lastObservedAt };
}

function coverageState(coverage: JsonMap[]): { state: "healthy" | "degraded" | "unknown"; lastObservedAt: string | null; error: string | null } {
  if (!coverage.length) return { state: "unknown", lastObservedAt: null, error: null };
  let lastObservedAt: string | null = null;
  const failures: string[] = [];
  for (const item of coverage) {
    const observedAt = normalizedIso(item.observed_at, "coverage.observed_at");
    if (!lastObservedAt || observedAt > lastObservedAt) lastObservedAt = observedAt;
    const state = scalar(item.state);
    if (state === "failed" || state === "not_collected" || state === "partial") {
      failures.push(`${scalar(item.scope_key)}:${scalar(item.observation_family)}:${state}`);
    }
  }
  return {
    state: failures.length ? "degraded" : "healthy",
    lastObservedAt,
    error: failures.length ? failures.slice(0, 10).join(", ") : null,
  };
}

async function finalizeDelivery(
  env: TelemetryIngestEnv,
  meter: Meter,
  verified: VerifiedTelemetryDelivery,
  token: string,
  sourceHost: string,
  estateRevisionId: string,
  persisted: { resolved: number; quarantined: number; observedKeys: string[]; currentQuarantine: unknown[]; lastObservedAt: string | null },
  coverage: JsonMap[],
): Promise<boolean> {
  const now = new Date().toISOString();
  const coverageSummary = coverageState(coverage);
  const lastObservedAt = [persisted.lastObservedAt, coverageSummary.lastObservedAt].filter(Boolean).sort().at(-1) ?? null;
  const state = persisted.quarantined > 0 || coverageSummary.state === "degraded" ? "degraded" : coverageSummary.state;
  const lastError = persisted.quarantined > 0
    ? `${persisted.quarantined} observation(s) quarantined${coverageSummary.error ? `; ${coverageSummary.error}` : ""}`
    : coverageSummary.error;

  const statements = [
    env.DB.prepare(
      `INSERT INTO telemetry_source_state
       (source_id, source_host, last_delivery_id, last_received_at, last_observed_at,
        estate_revision_id, state, accepted_delivery_count, resolved_observation_count,
        quarantined_observation_count, observed_keys_json, coverage_json, current_quarantine_json, last_error)
       SELECT ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM telemetry_delivery_ledger
           WHERE delivery_id = ? AND status = 'PROCESSING' AND attempt_token = ?
        )
       ON CONFLICT(source_id) DO UPDATE SET
         source_host = excluded.source_host,
         last_delivery_id = excluded.last_delivery_id,
         last_received_at = excluded.last_received_at,
         last_observed_at = excluded.last_observed_at,
         estate_revision_id = excluded.estate_revision_id,
         state = excluded.state,
         accepted_delivery_count = telemetry_source_state.accepted_delivery_count + 1,
         resolved_observation_count = telemetry_source_state.resolved_observation_count + excluded.resolved_observation_count,
         quarantined_observation_count = telemetry_source_state.quarantined_observation_count + excluded.quarantined_observation_count,
         observed_keys_json = excluded.observed_keys_json,
         coverage_json = excluded.coverage_json,
         current_quarantine_json = excluded.current_quarantine_json,
         last_error = excluded.last_error`
    ).bind(
      verified.source_id, sourceHost, verified.delivery_id, now, lastObservedAt, estateRevisionId, state,
      persisted.resolved, persisted.quarantined, JSON.stringify(persisted.observedKeys), JSON.stringify(coverage),
      JSON.stringify(persisted.currentQuarantine), lastError, verified.delivery_id, token,
    ),
    env.DB.prepare(
      `UPDATE telemetry_delivery_ledger
          SET status = 'ACCEPTED', accepted_at = ?, estate_revision_id = ?, attempt_token = NULL,
              resolved_count = ?, quarantine_count = ?
        WHERE delivery_id = ? AND status = 'PROCESSING' AND attempt_token = ?`
    ).bind(now, estateRevisionId, persisted.resolved, persisted.quarantined, verified.delivery_id, token),
  ];
  const results = await batch(env.DB, statements, meter);
  const ledgerChanges = Number((results[1]?.meta as { changes?: number } | undefined)?.changes ?? 0);
  return ledgerChanges === 1;
}

async function statusResponse(env: TelemetryIngestEnv): Promise<Response> {
  const registry = keyRegistry(env.TELEMETRY_INGEST_KEYS_JSON);
  try {
    await env.DB.prepare("SELECT delivery_id FROM telemetry_delivery_ledger LIMIT 1").all();
    return reply({
      schema_version: "osi.telemetry.ingress-status/v1",
      database_ready: true,
      ingress_enabled: ingressEnabled(env),
      key_registry_configured: registry.valid && registry.keys.size > 0,
      configured_source_count: registry.valid ? new Set([...registry.keys.values()].map((item) => item.source_id)).size : 0,
      mode: ingressEnabled(env) ? "authenticated_ingress" : "dark_launch_disabled",
    });
  } catch {
    return reply({
      schema_version: "osi.telemetry.ingress-status/v1",
      database_ready: false,
      ingress_enabled: ingressEnabled(env),
      key_registry_configured: registry.valid && registry.keys.size > 0,
      configured_source_count: 0,
      mode: "schema_unavailable",
    }, 503);
  }
}

async function ingest(request: Request, env: TelemetryIngestEnv): Promise<Response> {
  if (!ingressEnabled(env)) {
    return reply({ code: "telemetry_ingest_disabled", detail: "Continuous telemetry ingestion is not enabled" }, 503);
  }
  const registry = keyRegistry(env.TELEMETRY_INGEST_KEYS_JSON);
  if (!registry.valid || registry.keys.size === 0) {
    return reply({ code: "telemetry_key_registry_unavailable", detail: "Telemetry key registry is not configured" }, 503);
  }
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > 32 * 1024 * 1024) {
    return reply({ code: "body_too_large", detail: "Telemetry body exceeds 32 MiB" }, 413);
  }
  const payload = new Uint8Array(await request.arrayBuffer());
  const verified = await verifyTelemetryDelivery(payload, request.headers, registry.keys);
  if (!verified.ok) return reply({ code: verified.code, detail: verified.detail }, verified.status);

  const meter: Meter = { rows_read: 0, rows_written: 0 };
  let validated: ReturnType<typeof validateBatch>;
  try {
    validated = validateBatch(verified.batch, verified.source_id);
  } catch (error) {
    return reply({ code: "invalid_telemetry_batch", detail: String(error instanceof Error ? error.message : error) }, 400, meterHeaders(meter));
  }
  const runId = scalar(validated.run.run_id);
  const sourceHost = scalar(validated.source.source_host);

  try {
    const claim = await claimDelivery(env, meter, verified, sourceHost, runId, validated.observations.length);
    if (claim.state === "duplicate") {
      return reply(telemetryIngestAck(verified, "duplicate"), 200, meterHeaders(meter));
    }
    if (claim.state === "conflict") {
      return reply({ code: "delivery_conflict", detail: "Delivery id is already bound to different authenticated content" }, 409, meterHeaders(meter));
    }
    if (claim.state === "busy") {
      return reply({ code: "delivery_processing", detail: "Delivery is already being processed; retry later" }, 409, {
        ...meterHeaders(meter),
        "retry-after": "30",
      });
    }

    const estate = await currentEstate(env.DB, meter);
    const resolutions = await resolveObservations(env.DB, meter, validated.observations, estate);
    const persisted = await persistResolvedAndQuarantine(env, meter, verified, estate.revision_id, resolutions);
    const finalized = await finalizeDelivery(
      env, meter, verified, claim.token, sourceHost, estate.revision_id, persisted, validated.coverage,
    );
    if (!finalized) {
      const existing = await ledgerRow(env.DB, meter, verified.delivery_id);
      if (existing?.status === "ACCEPTED" && sameDelivery(existing, verified)) {
        return reply(telemetryIngestAck(verified, "duplicate"), 200, meterHeaders(meter));
      }
      return reply({ code: "delivery_processing", detail: "Delivery ownership changed before finalization; retry later" }, 409, {
        ...meterHeaders(meter),
        "retry-after": "30",
      });
    }
    return reply(telemetryIngestAck(verified, "accepted"), 202, meterHeaders(meter));
  } catch (error) {
    console.error("telemetry ingest failure", error instanceof Error ? error.message : String(error));
    return reply({ code: "telemetry_ingest_unavailable", detail: "Telemetry delivery could not be durably accepted" }, 503, meterHeaders(meter));
  }
}

export async function handleTelemetryIngest(request: Request, env: TelemetryIngestEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && path === STATUS_PATH) return statusResponse(env);
  if (request.method === "POST" && path === INGEST_PATH) return ingest(request, env);
  return null;
}
