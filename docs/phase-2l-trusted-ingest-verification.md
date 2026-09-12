# Phase 2L — Trusted telemetry ingress verification

## Goal

Define and prove the cloud-side authentication and replay semantics for `osi.telemetry.batch/v1` without creating a production ingestion endpoint or touching D1.

Phase 2L is based directly on the Phase 2K mainline. The private-side publisher already has a narrow HMAC delivery credential and durable local spool. This slice proves that a future Worker can verify those deliveries using Web Crypto while binding each credential to exactly one telemetry source.

No Worker route, D1 migration/write, scheduler, MQ command, service installation, production key store, or production credential is added.

## Protocol compatibility with Phase 2K

The verifier consumes the exact protocol now emitted by `telemetry_delivery.py`:

```text
X-OSI-Key-Id
X-OSI-Timestamp
X-OSI-Delivery-Id
X-OSI-Content-SHA256
X-OSI-Signature
```

The authenticated message is exactly:

```text
v1\n<TIMESTAMP>\n<KEY_ID>\n<DELIVERY_ID>\n<CONTENT_SHA256>
```

Including `KEY_ID` in the HMAC input is important: changing the credential identifier cannot preserve a valid signature even if another configured key happens to use the same secret material.

The Worker-side default maximum body size is 32 MiB, matching the Phase 2K publisher's maximum canonical batch size. The accepted key-id grammar and 32-byte minimum secret strength also match Phase 2K.

## Verification order

`src/telemetry-ingest-verify.ts` is a pure verifier. Given request bytes, headers and a caller-supplied key registry, it applies this order:

1. validate verifier configuration and enforce the 32 MiB hard maximum;
2. require exact `Content-Type: application/json`;
3. validate delivery headers and replay-window timestamp;
4. resolve the key id and validate the key-registry record;
5. reject disabled or out-of-window credentials;
6. SHA-256 the exact request bytes and validate `X-OSI-Content-SHA256`;
7. derive and validate `tdel_<first 24 hex of SHA-256>`;
8. verify the Phase 2K HMAC message with Web Crypto, including the key id;
9. parse the authenticated body as a minimally valid `osi.telemetry.batch/v1` document;
10. bind `run.source.source_id` exactly to the authenticated key's configured source id.

The verifier authenticates the **exact bytes received**. It does not JSON-recanonicalize at ingress. The Python publisher canonicalizes before sending, so byte-level verification avoids cross-language canonicalization ambiguity.

## Key registry and rotation semantics

A key record contains:

```text
key_id
source_id
secret
status = active | retiring | disabled
not_before_epoch (optional)
not_after_epoch  (optional)
```

The verifier rejects malformed registry entries as server-side configuration failures instead of treating them as bad client credentials. In particular it rejects a map-key / record-key mismatch, weak secrets, unsupported statuses, malformed validity bounds and inverted validity windows.

`active` and `retiring` keys can verify while inside their validity window. `disabled` keys cannot. The future Worker may load records from an appropriate secret/configuration mechanism, but Phase 2L deliberately does not select or implement that production store.

The source binding is exact. A valid signature from a key assigned to source A cannot publish a batch claiming source B.

## Replay and idempotency semantics

The timestamp window rejects stale signed requests at the authentication boundary. That is not sufficient by itself because legitimate retries are expected to re-sign the same content with a current timestamp.

`classifyTelemetryDelivery()` therefore defines persistent-ledger semantics independently of any database:

- no existing delivery id: `new`;
- same delivery id + content hash + source id: `duplicate`;
- same delivery id with a different authenticated tuple: `conflict`.

A future persistence adapter must make the `new` to stored transition atomic. D1 is not used in this phase.

## Acknowledgement contract

`contracts/telemetry/v1/ingest-ack.schema.json` defines the acknowledgement a future endpoint may return only after durable acceptance/idempotency handling:

```json
{
  "schema_version": "osi.telemetry.ingest-ack/v1",
  "delivery_id": "tdel_...",
  "content_sha256": "...",
  "source_id": "mq-host.example",
  "status": "accepted"
}
```

`duplicate` is also a successful acknowledgement because the same authenticated payload was already accepted. Identity quarantine is a later processing outcome and does not turn transport acknowledgement into a failure.

## Cross-language proof

The Phase 2L CI job generates a signed batch using the actual Phase 2K Python publisher, compiles the Worker-side TypeScript verifier, and verifies the Python-produced bytes and headers in Node/Web Crypto.

The test covers body tampering, stale timestamps, unknown/disabled/out-of-window keys, source/key mismatch, signature tampering, key-id rebinding, weak or inconsistent key-registry configuration, exact content type, body-size enforcement, verifier-option validation, replay classification and acknowledgement construction.

This is an interoperability test of the actual signing protocol, not a second independently invented signing implementation.

## Production boundary remains closed

Phase 2L does **not** add `/api/.../telemetry` or any equivalent Worker route. It does not persist a replay ledger, quarantine, source health or latest operational state. It does not expose a key registry in source code and does not import the verifier from `src/index.ts`.

The next production-facing gate may reuse this verifier and add a narrow authenticated ingestion route with measured persistence for delivery idempotency, server-generated canonical identity resolution, quarantine/source-health projection and latest-state storage. That gate should retain the outbound-only/private-site architecture and prove its D1 read/write budget before any continuous MQ-host service is installed.
