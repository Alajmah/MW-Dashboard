import fs from "node:fs";
import assert from "node:assert/strict";
import {
  classifyTelemetryDelivery,
  telemetryIngestAck,
  verifyTelemetryDelivery,
} from "../.phase2l-build/telemetry-ingest-verify.js";

const vectorPath = process.argv[2];
if (!vectorPath) throw new Error("usage: node scripts/test-telemetry-ingest-verify.mjs <vector.json>");
const vector = JSON.parse(fs.readFileSync(vectorPath, "utf8"));
const payload = new TextEncoder().encode(vector.payload_utf8);
const headers = new Headers(vector.headers);
const key = {
  key_id: vector.key_id,
  source_id: vector.source_id,
  secret: vector.secret,
  status: "active",
};
const keys = new Map([[key.key_id, key]]);

const verified = await verifyTelemetryDelivery(payload, headers, keys, { now_epoch: vector.now_epoch });
assert.equal(verified.ok, true, JSON.stringify(verified));
if (!verified.ok) process.exit(1);
assert.equal(verified.delivery_id, vector.headers["X-OSI-Delivery-Id"]);
assert.equal(verified.content_sha256, vector.headers["X-OSI-Content-SHA256"]);
assert.equal(verified.source_id, vector.source_id);
assert.equal(verified.key_id, vector.key_id);

const ack = telemetryIngestAck(verified, "accepted");
assert.deepEqual(ack, {
  schema_version: "osi.telemetry.ingest-ack/v1",
  delivery_id: verified.delivery_id,
  content_sha256: verified.content_sha256,
  source_id: verified.source_id,
  status: "accepted",
});

assert.equal(classifyTelemetryDelivery(null, verified).state, "new");
assert.equal(classifyTelemetryDelivery({
  delivery_id: verified.delivery_id,
  content_sha256: verified.content_sha256,
  source_id: verified.source_id,
}, verified).state, "duplicate");
assert.equal(classifyTelemetryDelivery({
  delivery_id: verified.delivery_id,
  content_sha256: "0".repeat(64),
  source_id: verified.source_id,
}, verified).state, "conflict");

const tampered = new Uint8Array(payload.length + 1);
tampered.set(payload);
tampered[tampered.length - 1] = 0x20;
const badHash = await verifyTelemetryDelivery(tampered, headers, keys, { now_epoch: vector.now_epoch });
assert.equal(badHash.ok, false);
assert.equal(badHash.code, "content_hash_mismatch");

const stale = await verifyTelemetryDelivery(payload, headers, keys, { now_epoch: vector.now_epoch + 301 });
assert.equal(stale.ok, false);
assert.equal(stale.code, "timestamp_outside_window");

const unknown = await verifyTelemetryDelivery(payload, headers, new Map(), { now_epoch: vector.now_epoch });
assert.equal(unknown.ok, false);
assert.equal(unknown.code, "unknown_key");

const disabledKeys = new Map([[key.key_id, { ...key, status: "disabled" }]]);
const disabled = await verifyTelemetryDelivery(payload, headers, disabledKeys, { now_epoch: vector.now_epoch });
assert.equal(disabled.ok, false);
assert.equal(disabled.code, "key_disabled");

const wrongSourceKeys = new Map([[key.key_id, { ...key, source_id: "different-source.example" }]]);
const wrongSource = await verifyTelemetryDelivery(payload, headers, wrongSourceKeys, { now_epoch: vector.now_epoch });
assert.equal(wrongSource.ok, false);
assert.equal(wrongSource.code, "source_not_bound_to_key");

const badSignatureHeaders = new Headers(headers);
badSignatureHeaders.set("X-OSI-Signature", "v1=" + "0".repeat(64));
const badSignature = await verifyTelemetryDelivery(payload, badSignatureHeaders, keys, { now_epoch: vector.now_epoch });
assert.equal(badSignature.ok, false);
assert.equal(badSignature.code, "signature_mismatch");

const retiredWindowKeys = new Map([[key.key_id, { ...key, status: "retiring", not_after_epoch: vector.now_epoch - 1 }]]);
const retired = await verifyTelemetryDelivery(payload, headers, retiredWindowKeys, { now_epoch: vector.now_epoch });
assert.equal(retired.ok, false);
assert.equal(retired.code, "key_outside_validity");

const parameterizedType = new Headers(headers);
parameterizedType.set("Content-Type", "application/json; charset=utf-8");
const contentType = await verifyTelemetryDelivery(payload, parameterizedType, keys, { now_epoch: vector.now_epoch });
assert.equal(contentType.ok, false);
assert.equal(contentType.code, "unsupported_content_type");

const alternateKeyId = "mq-phase2l-key-alt";
const reboundHeaders = new Headers(headers);
reboundHeaders.set("X-OSI-Key-Id", alternateKeyId);
const reboundKeys = new Map([[alternateKeyId, { ...key, key_id: alternateKeyId }]]);
const rebound = await verifyTelemetryDelivery(payload, reboundHeaders, reboundKeys, { now_epoch: vector.now_epoch });
assert.equal(rebound.ok, false);
assert.equal(rebound.code, "signature_mismatch");

const weakSecretKeys = new Map([[key.key_id, { ...key, secret: "too-short" }]]);
const weakSecret = await verifyTelemetryDelivery(payload, headers, weakSecretKeys, { now_epoch: vector.now_epoch });
assert.equal(weakSecret.ok, false);
assert.equal(weakSecret.code, "invalid_key_configuration");

const mismatchedRegistry = new Map([[key.key_id, { ...key, key_id: "different-key-id" }]]);
const mismatchedKey = await verifyTelemetryDelivery(payload, headers, mismatchedRegistry, { now_epoch: vector.now_epoch });
assert.equal(mismatchedKey.ok, false);
assert.equal(mismatchedKey.code, "invalid_key_configuration");

const tinyLimit = await verifyTelemetryDelivery(payload, headers, keys, {
  now_epoch: vector.now_epoch,
  max_body_bytes: payload.byteLength - 1,
});
assert.equal(tinyLimit.ok, false);
assert.equal(tinyLimit.code, "body_too_large");

const invalidOptions = await verifyTelemetryDelivery(payload, headers, keys, {
  now_epoch: vector.now_epoch,
  max_skew_seconds: -1,
});
assert.equal(invalidOptions.ok, false);
assert.equal(invalidOptions.code, "invalid_verifier_configuration");

console.log(JSON.stringify({
  ok: true,
  delivery_id: verified.delivery_id,
  checks: 16,
  source_id: verified.source_id,
}));
