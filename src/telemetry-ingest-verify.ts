const UTF8 = new TextEncoder();
const HEX64_RE = /^[0-9a-f]{64}$/i;
const DELIVERY_ID_RE = /^tdel_[0-9a-f]{24}$/;
const KEY_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const TIMESTAMP_RE = /^[0-9]{1,12}$/;
const SIGNATURE_RE = /^v1=([0-9a-f]{64})$/i;
const KEY_STATUSES = new Set(["active", "retiring", "disabled"]);

export const TELEMETRY_BATCH_SCHEMA = "osi.telemetry.batch/v1";
export const TELEMETRY_ACK_SCHEMA = "osi.telemetry.ingest-ack/v1";
export const DEFAULT_MAX_SKEW_SECONDS = 300;
export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
export const MIN_SECRET_BYTES = 32;

export type TelemetryKeyStatus = "active" | "retiring" | "disabled";

export interface TelemetryKeyRecord {
  key_id: string;
  source_id: string;
  secret: string;
  status: TelemetryKeyStatus;
  not_before_epoch?: number | null;
  not_after_epoch?: number | null;
}

export interface TelemetryVerificationOptions {
  now_epoch?: number;
  max_skew_seconds?: number;
  max_body_bytes?: number;
}

export interface VerifiedTelemetryDelivery {
  ok: true;
  key_id: string;
  source_id: string;
  timestamp: number;
  delivery_id: string;
  content_sha256: string;
  payload_bytes: number;
  batch: Record<string, unknown>;
}

export interface TelemetryVerificationFailure {
  ok: false;
  status: number;
  code: string;
  detail: string;
}

export type TelemetryVerificationResult = VerifiedTelemetryDelivery | TelemetryVerificationFailure;

export interface DeliveryLedgerRecord {
  delivery_id: string;
  content_sha256: string;
  source_id: string;
}

export type DeliveryReplayDecision =
  | { state: "new" }
  | { state: "duplicate" }
  | { state: "conflict"; detail: string };

function failure(status: number, code: string, detail: string): TelemetryVerificationFailure {
  return { ok: false, status, code, detail };
}

function header(headers: Headers, name: string): string {
  return (headers.get(name) ?? "").trim();
}

function bytesToHex(bytes: Uint8Array): string {
  let output = "";
  for (const value of bytes) output += value.toString(16).padStart(2, "0");
  return output;
}

function ownedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function hexToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  if (value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) return null;
  const out = new Uint8Array(value.length / 2);
  for (let index = 0; index < out.length; index++) {
    out[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

async function sha256Hex(payload: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", ownedBytes(payload))));
}

async function verifyHmac(secret: string, message: string, suppliedHex: string): Promise<boolean> {
  const supplied = hexToBytes(suppliedHex);
  if (!supplied) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    ownedBytes(UTF8.encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, supplied, ownedBytes(UTF8.encode(message)));
}

function parseBatch(payload: Uint8Array): { batch: Record<string, unknown>; source_id: string } | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const batch = value as Record<string, unknown>;
  if (batch.schema_version !== TELEMETRY_BATCH_SCHEMA) return null;
  if (!Array.isArray(batch.coverage) || !Array.isArray(batch.observations)) return null;
  const run = batch.run;
  if (!run || typeof run !== "object" || Array.isArray(run)) return null;
  const runMap = run as Record<string, unknown>;
  if (typeof runMap.run_id !== "string" || !runMap.run_id.trim()) return null;
  const source = runMap.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const sourceId = (source as Record<string, unknown>).source_id;
  if (typeof sourceId !== "string" || !sourceId.trim() || sourceId !== sourceId.trim()) return null;
  return { batch, source_id: sourceId };
}

function validEpoch(value: number | null | undefined): boolean {
  return value == null || (Number.isSafeInteger(value) && value >= 0);
}

function validateVerifierOptions(options: TelemetryVerificationOptions): TelemetryVerificationFailure | null {
  const maxBody = options.max_body_bytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxSkew = options.max_skew_seconds ?? DEFAULT_MAX_SKEW_SECONDS;
  const now = options.now_epoch;
  if (!Number.isSafeInteger(maxBody) || maxBody < 1 || maxBody > DEFAULT_MAX_BODY_BYTES) {
    return failure(503, "invalid_verifier_configuration", `max_body_bytes must be an integer between 1 and ${DEFAULT_MAX_BODY_BYTES}`);
  }
  if (!Number.isSafeInteger(maxSkew) || maxSkew < 0 || maxSkew > 3600) {
    return failure(503, "invalid_verifier_configuration", "max_skew_seconds must be an integer between 0 and 3600");
  }
  if (now != null && (!Number.isSafeInteger(now) || now < 0)) {
    return failure(503, "invalid_verifier_configuration", "now_epoch must be a non-negative safe integer");
  }
  return null;
}

function validateKeyRecord(mapKey: string, record: TelemetryKeyRecord): TelemetryVerificationFailure | null {
  if (!KEY_ID_RE.test(mapKey) || !KEY_ID_RE.test(record.key_id) || record.key_id !== mapKey) {
    return failure(503, "invalid_key_configuration", "Telemetry key registry entry has an invalid or mismatched key id");
  }
  if (typeof record.source_id !== "string" || !record.source_id.trim() || record.source_id !== record.source_id.trim()) {
    return failure(503, "invalid_key_configuration", "Telemetry key registry entry has an invalid source id");
  }
  if (!KEY_STATUSES.has(String(record.status))) {
    return failure(503, "invalid_key_configuration", "Telemetry key registry entry has an unsupported status");
  }
  if (UTF8.encode(record.secret ?? "").byteLength < MIN_SECRET_BYTES) {
    return failure(503, "invalid_key_configuration", `Telemetry delivery secret must be at least ${MIN_SECRET_BYTES} UTF-8 bytes`);
  }
  if (!validEpoch(record.not_before_epoch) || !validEpoch(record.not_after_epoch)) {
    return failure(503, "invalid_key_configuration", "Telemetry key validity bounds must be non-negative safe integer epoch seconds");
  }
  if (
    record.not_before_epoch != null &&
    record.not_after_epoch != null &&
    record.not_before_epoch > record.not_after_epoch
  ) {
    return failure(503, "invalid_key_configuration", "Telemetry key validity window is inverted");
  }
  return null;
}

function keyIsCurrent(record: TelemetryKeyRecord, now: number): boolean {
  if (record.status === "disabled") return false;
  if (record.not_before_epoch != null && now < record.not_before_epoch) return false;
  if (record.not_after_epoch != null && now > record.not_after_epoch) return false;
  return true;
}

/**
 * Verify one private-side publisher delivery without performing persistence.
 *
 * The exact received bytes are authenticated. JSON is parsed only after the
 * content hash, delivery id and HMAC are verified. Persistence, replay-ledger
 * writes and canonical identity resolution remain separate concerns.
 */
export async function verifyTelemetryDelivery(
  payload: Uint8Array,
  headers: Headers,
  keys: ReadonlyMap<string, TelemetryKeyRecord>,
  options: TelemetryVerificationOptions = {},
): Promise<TelemetryVerificationResult> {
  const optionFailure = validateVerifierOptions(options);
  if (optionFailure) return optionFailure;

  const maxBody = options.max_body_bytes ?? DEFAULT_MAX_BODY_BYTES;
  if (payload.byteLength === 0) return failure(400, "empty_body", "Telemetry request body is empty");
  if (payload.byteLength > maxBody) return failure(413, "body_too_large", `Telemetry body exceeds ${maxBody} bytes`);

  if (header(headers, "content-type").toLowerCase() !== "application/json") {
    return failure(415, "unsupported_content_type", "Telemetry delivery must use Content-Type: application/json");
  }

  const keyId = header(headers, "x-osi-key-id");
  const timestampText = header(headers, "x-osi-timestamp");
  const suppliedDelivery = header(headers, "x-osi-delivery-id");
  const suppliedDigest = header(headers, "x-osi-content-sha256").toLowerCase();
  const suppliedSignature = header(headers, "x-osi-signature");

  if (!KEY_ID_RE.test(keyId)) return failure(401, "invalid_key_id", "Missing or invalid telemetry key id");
  if (!TIMESTAMP_RE.test(timestampText)) return failure(401, "invalid_timestamp", "Telemetry timestamp must be an integer epoch second");
  if (!DELIVERY_ID_RE.test(suppliedDelivery)) return failure(401, "invalid_delivery_id", "Missing or invalid telemetry delivery id");
  if (!HEX64_RE.test(suppliedDigest)) return failure(401, "invalid_content_hash", "Missing or invalid telemetry content hash");
  const signatureMatch = suppliedSignature.match(SIGNATURE_RE);
  if (!signatureMatch) return failure(401, "invalid_signature", "Missing or unsupported telemetry signature");

  const now = Math.trunc(options.now_epoch ?? Date.now() / 1000);
  const timestamp = Number(timestampText);
  const maxSkew = options.max_skew_seconds ?? DEFAULT_MAX_SKEW_SECONDS;
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > maxSkew) {
    return failure(401, "timestamp_outside_window", "Telemetry timestamp is outside the accepted replay window");
  }

  const key = keys.get(keyId);
  if (!key) return failure(401, "unknown_key", "Telemetry key is not recognized");
  const keyFailure = validateKeyRecord(keyId, key);
  if (keyFailure) return keyFailure;
  if (key.status === "disabled") return failure(401, "key_disabled", "Telemetry key is disabled");
  if (!keyIsCurrent(key, now)) return failure(401, "key_outside_validity", "Telemetry key is outside its validity window");

  const expectedDigest = await sha256Hex(payload);
  if (expectedDigest !== suppliedDigest) return failure(401, "content_hash_mismatch", "Telemetry content hash does not match the request body");
  const expectedDelivery = `tdel_${expectedDigest.slice(0, 24)}`;
  if (expectedDelivery !== suppliedDelivery) return failure(401, "delivery_id_mismatch", "Telemetry delivery id is not derived from the request body");

  const signingMessage = `v1\n${timestampText}\n${keyId}\n${expectedDelivery}\n${expectedDigest}`;
  if (!(await verifyHmac(key.secret, signingMessage, signatureMatch[1].toLowerCase()))) {
    return failure(401, "signature_mismatch", "Telemetry HMAC verification failed");
  }

  const parsed = parseBatch(payload);
  if (!parsed) return failure(400, "invalid_telemetry_batch", `Request body is not a minimally valid ${TELEMETRY_BATCH_SCHEMA} document`);
  if (parsed.source_id !== key.source_id) {
    return failure(403, "source_not_bound_to_key", "Telemetry source id is not bound to this delivery key");
  }

  return {
    ok: true,
    key_id: keyId,
    source_id: parsed.source_id,
    timestamp,
    delivery_id: expectedDelivery,
    content_sha256: expectedDigest,
    payload_bytes: payload.byteLength,
    batch: parsed.batch,
  };
}

export function classifyTelemetryDelivery(
  existing: DeliveryLedgerRecord | null,
  incoming: Pick<VerifiedTelemetryDelivery, "delivery_id" | "content_sha256" | "source_id">,
): DeliveryReplayDecision {
  if (!existing) return { state: "new" };
  if (
    existing.delivery_id === incoming.delivery_id &&
    existing.content_sha256 === incoming.content_sha256 &&
    existing.source_id === incoming.source_id
  ) {
    return { state: "duplicate" };
  }
  return {
    state: "conflict",
    detail: "Existing delivery ledger entry does not match the authenticated payload/source tuple",
  };
}

export function telemetryIngestAck(
  verified: Pick<VerifiedTelemetryDelivery, "delivery_id" | "content_sha256" | "source_id">,
  status: "accepted" | "duplicate",
): Record<string, string> {
  return {
    schema_version: TELEMETRY_ACK_SCHEMA,
    delivery_id: verified.delivery_id,
    content_sha256: verified.content_sha256,
    source_id: verified.source_id,
    status,
  };
}
