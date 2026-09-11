# Phase 2K — Trusted telemetry delivery and canonical identity resolution

## Goal

Harden the private-to-cloud telemetry path without touching production D1 and without coupling the IBM MQ observer to Cloudflare administration.

This phase is deliberately stacked on Phase 2J. It adds a delivery boundary and a strict identity resolver, but it still does **not** add a production Worker ingestion route, D1 persistence, scheduler, MQ mutation, or continuous service installation.

## Separation of responsibilities

```text
IBM MQ runtime
  -> osi-mq-observer
       read-only DISPLAY collection only
       no network publishing
       no canonical cent_* minting
  -> local durable telemetry spool
       canonical JSON
       content-derived delivery id
       bounded retry/backoff state
  -> authenticated outbound HTTPS
       HMAC delivery credential only
       no D1/admin credential
  -> trusted ingestion boundary                (future Worker route)
       verify signature/replay/idempotency
       obtain current identity snapshot
       resolve or quarantine each observation
  -> latest operational state / rollups        (future)
```

The observer and publisher are intentionally separate programs. A failure in delivery therefore cannot expand the observer's MQ authority.

## Durable local spool

`collectors/ibm-mq/observer/telemetry_delivery.py` canonicalizes an `osi.telemetry.batch/v1` document using sorted compact JSON and derives:

```text
payload_sha256 = SHA256(canonical_batch_bytes)
delivery_id    = "tdel_" + payload_sha256[0:24]
```

The same logical batch therefore maps to the same delivery ID even if the original JSON used different whitespace or key ordering. Re-spooling an already pending or sent payload does not create a second delivery record.

Spool state is stored in three directories:

- `pending/` — eligible or deferred deliveries;
- `sent/` — locally retained acknowledgements for successful deliveries;
- `dead/` — malformed/corrupt spool records that fail their local integrity check.

Writes use a temporary file, `fsync`, and atomic rename. A pending record carries attempt count, next eligible attempt, and the last bounded error string. Failed sends remain pending and use exponential backoff with deterministic bounded jitter.

No daemon is installed in Phase 2K. The CLI supports explicit `spool`, `send`, and `status` operations so service-management policy can be designed separately.

## Outbound authentication

The publisher requires HTTPS for non-loopback endpoints. It sends the canonical telemetry batch as the request body with these headers:

```text
X-OSI-Key-Id
X-OSI-Timestamp
X-OSI-Delivery-Id
X-OSI-Content-SHA256
X-OSI-Signature
```

The signature input is:

```text
v1\n<TIMESTAMP>\n<DELIVERY_ID>\n<CONTENT_SHA256>
```

and the signature is HMAC-SHA256 with a narrow telemetry delivery secret.

This credential is intentionally **not** a Cloudflare API token, D1 credential, dashboard administration token, or MQ credential. Compromise of the publisher credential must not confer database administration or MQ administration.

The companion verification function checks content hash, deterministic delivery ID, timestamp window, signature version, and HMAC in constant time. A future Worker ingestion route should additionally enforce key/source binding, replay protection, delivery-id idempotency and credential rotation.

## Trusted canonical identity resolution

`telemetry_resolver.py` represents the server-side identity boundary as a pure offline function. It accepts:

1. one untrusted `osi.telemetry.batch/v1` document;
2. one bounded `osi.telemetry.identity-snapshot/v1` document exported from the current canonical estate.

The observer is not trusted to assert canonical identity. If an incoming observation already contains a non-null `canonical_entity_id`, the resolver quarantines it as `untrusted_canonical_id_supplied` rather than trusting or silently overwriting it.

### Queue-manager identity

When `queue_manager_qmid` is available, QMID is authoritative for the lookup. If that QMID does not exist in the current snapshot, the resolver does **not** fall back to queue-manager name. This prevents a rebuilt/replaced queue manager that reused a familiar name from being silently attached to the wrong canonical identity.

If QMID resolves uniquely but its canonical display name conflicts with the supplied queue-manager name, the observation is quarantined as `queue_manager_identity_mismatch`.

Name-only resolution is permitted only when the observer did not obtain QMID and the current canonical snapshot contains exactly one resolved queue-manager entity with that name.

### Scoped MQ objects

Queue, channel, and listener observations require:

```text
semantic_type
queue_manager_name
name
```

and resolve against the canonical scoped identity key:

```text
queue_manager_key=<qmgr>|name=<object>
```

If a QMID hint is also present, the owner QMID/name pair must first resolve consistently. Ambiguous, conflicted, absent, or unsupported identities are quarantined rather than guessed.

## Quarantine is normal evidence, not a transport failure

Resolution is per observation. One unresolved object does not invalidate other observations in the same signed batch.

`osi.telemetry.resolution/v1` therefore contains:

- `resolved_observations` with server-populated `canonical_entity_id`;
- `quarantine` entries with the exact reason and candidate IDs, when any;
- original collection coverage;
- source batch hash and run ID;
- counts for input, resolved, and quarantined observations.

The future ingestion layer should persist source health and quarantine visibility separately from middleware health. An identity-resolution gap is not itself an MQ outage.

## Identity snapshot contract

`contracts/telemetry/v1/identity-snapshot.schema.json` is intentionally small. It contains only the current estate revision plus the entity fields required for deterministic identity resolution:

- entity ID;
- semantic type;
- identity rule/key/state;
- display name;
- canonical properties needed by identity rules such as QMID.

The current canonical estate remains the authority. The snapshot is a bounded projection, not a second identity database.

## Security and failure semantics established in Phase 2K

- MQ observer remains DISPLAY-only and has no network client.
- Publisher has no `runmqsc`, `dspmq`, D1, Wrangler, or admin-token dependency.
- Publisher sends only outbound HTTPS and holds only a telemetry HMAC credential.
- Batch identity is content-derived and idempotent before network delivery.
- Local spool survives network failure and records retry/backoff state.
- Canonical IDs supplied by the private observer are rejected.
- QMID mismatch cannot silently fall back to a familiar queue-manager name.
- Ambiguous canonical identity is quarantined, not guessed.
- Conflicted canonical entities are excluded from the resolver index.
- No freshness SLA, business SLA, outage state, or causal finding is inferred at this layer.

## What Phase 2K does not do

Phase 2K does not create the production ingestion endpoint and does not write telemetry to D1. It also does not decide the final high-cardinality time-series backend.

Those are intentionally held for the next gate so production recovery and the D1 efficiency work can complete first.

## Next production-facing gate

After Phase 2H is deployed and Phase 2I is safely applied, the next slice can implement the Worker-side trusted ingestion route with:

1. HMAC key/source binding and rotation;
2. replay-window enforcement;
3. delivery-id idempotency;
4. server-generated canonical identity snapshot from the active estate;
5. quarantine persistence and source-health projection;
6. latest-state upsert with a measured D1 read/write budget;
7. explicit retention split between D1 latest state/coarse rollups and optional high-cardinality history;
8. end-to-end tests proving duplicate deliveries and ambiguous identities cannot corrupt current operational state.
