# Phase 2L — Trusted telemetry ingress verification

## Goal

Define and test the cloud-side authentication/replay semantics for `osi.telemetry.batch/v1` without creating a production endpoint or touching D1.

Phase 2L is stacked on Phase 2K. The private-side publisher already has a narrow HMAC delivery credential and durable local spool. This slice proves that a future Worker can verify those deliveries using Web Crypto while binding each credential to exactly one telemetry source.

No Worker route, D1 migration, D1 write, scheduler, service installation, MQ command, or production secret is added.

## Verification order

`src/telemetry-ingest-verify.ts` is a pure verifier. Given request bytes, headers and a caller-supplied key registry, it applies this order:

1. enforce a bounded request body and `application/json` content type;
2. validate the delivery headers and replay-window timestamp;
3. resolve the key id and reject disabled/out-of-window keys;
4. SHA-256 the exact request bytes and validate `X-OSI-Content-SHA256`;
5. derive and validate `tdel_<first 24 hex of SHA-256>`;
6. verify the Phase 2K HMAC message with Web Crypto;
7. parse the authenticated body as a minimally valid `osi.telemetry.batch/v1` document;
8. bind `run.source.source_id` to the authenticated key's configured source id.

The verifier intentionally authenticates the **exact bytes received**. It does not JSON-recanonicalize at ingress. The Python publisher canonicalizes before sending, so byte-level verification avoids cross-language JSON-number/string canonicalization ambiguity.

## Key rotation model

A key record contains:

```text
key_id
source_id
secret
status = active | retiring | disabled
not_before_epoch (optional)
not_after_epoch  (optional)
```

`active` and `retiring` keys can verify while inside their validity window. `disabled` keys cannot. The future Worker may load these records from an appropriate secret/configuration mechanism, but Phase 2L does not choose or implement that production store.

The source binding is exact. A valid signature from a key assigned to source A cannot publish a batch claiming source B.

## Replay and idempotency semantics

The timestamp window rejects old/replayed signed requests at the authentication boundary. This is not sufficient by itself because legitimate retries are expected to re-sign the same content with a current timestamp.

Therefore `classifyTelemetryDelivery()` defines the persistent-ledger semantics independently of any database:

- no existing delivery id: `new`;
- same delivery id + content hash + source id: `duplicate`;
- same delivery id with a different authenticated tuple: `conflict`.

A future persistence adapter must make the `new` -> stored transition atomic. D1 is not used in this phase.

## Acknowledgement contract

`contracts/telemetry/v1/ingest-ack.schema.json` defines the acknowledgement the future endpoint will return only after durable acceptance/idempotency handling:

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

The Phase 2L CI job generates a signed batch with the Python Phase 2K publisher, compiles the Worker-side TypeScript verifier, and verifies the Python-produced bytes/headers in Node/Web Crypto. The test also covers:

- body tampering;
- stale timestamp;
- unknown key;
- disabled/out-of-validity key;
- key/source mismatch;
- signature tampering;
- wrong content type;
- new/duplicate/conflict idempotency decisions;
- acknowledgement construction.

This is an interoperability test of the actual signing protocol, not a second independently invented test signature.

## Production boundary remains closed

Phase 2L does **not** add `/api/.../telemetry` or any equivalent route. It does not persist a replay ledger or latest state. It does not expose a key registry in source code. It does not import the verifier from `src/index.ts`.

The production-facing ingestion route should be implemented only after Phase 2H is deployed and Phase 2I's D1 efficiency migration has passed the normal remote migration gate. At that point the route can reuse this verifier and add measured persistence for delivery ledger, source health, quarantine and latest-state projection.
