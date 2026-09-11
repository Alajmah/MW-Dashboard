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

const ack = telemetryIngestAck(verified, "accepted");
assert.deepEqual(ack, {
  schema_version: "osi.telemetry.ingest-ack/v1",
  delivery_id: verified.delivery_id,
  content_sha256: verified.content_sha256,
  source_id: verified.source_id,
  status: "accepted",
});

const duplicate = classifyTelemetryDelivery({
  delivery_id: verified.delivery_id,
  content_sha256: verified.content_sha256,
  source_id: verified.source_id,
}, verified);
assert.equal(duplicate.state, "duplicate");
assert.equal(classifyTelemetryDelivery(null, verified).state, "new");
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

const wrongType = new Headers(headers);
wrongType.set("Content-Type", "text/plain");
const contentType = await verifyTelemetryDelivery(payload, wrongType, keys, { now_epoch: vector.now_epoch });
assert.equal(contentType.ok, false);
assert.equal(contentType.code, "unsupported_content_type");

console.log(JSON.stringify({
  ok: true,
  delivery_id: verified.delivery_id,
  checks: 12,
  source_id: verified.source_id,
}));
