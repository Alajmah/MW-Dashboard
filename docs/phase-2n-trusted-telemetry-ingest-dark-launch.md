# Phase 2N — Trusted telemetry ingest dark launch

## Purpose

Phase 2N introduces the first deployable continuous-telemetry ingestion path for OSI while keeping production ingestion disabled by default. The goal is to prove the authenticated publisher → Cloudflare Worker → canonical identity → D1 latest-state chain without turning D1 into a high-cardinality time-series database or granting Cloudflare any MQ administrative access.

The private-side `osi-mq-observer` remains read-only and outbound-only. It publishes `osi.telemetry.batch/v1` through the durable authenticated delivery mechanism from Phases 2K/2L. The Worker authenticates the exact received bytes, binds each key to one source identity, resolves source-native MQ identity hints against the current canonical estate, persists bounded latest state, and quarantines observations whose identity cannot be resolved safely.

## Production posture

Phase 2N is a dark launch.

- `GET /api/v2/telemetry/status` is available after migration and reports schema/readiness state.
- `POST /api/v2/telemetry/ingest` returns `503 telemetry_ingest_disabled` unless `TELEMETRY_INGEST_ENABLED=true` is explicitly configured.
- No production telemetry key registry is added by this change.
- `TELEMETRY_INGEST_KEYS_JSON` is runtime configuration only. Secrets are not stored in the repository.
- The Cloudflare deployment workflow explicitly verifies that the Phase 2N production deployment remains in `dark_launch_disabled` mode.

Continuous publication from MQ hosts must not be enabled until the non-production remote-D1 cost gate described below has been completed.

## Ingress contract

The endpoint reuses `verifyTelemetryDelivery` from Phase 2L. A request is accepted only after all of the existing controls pass, including body-size bounds, exact `application/json`, delivery-id/content-hash agreement, replay-window validation, HMAC verification, key validity, and key-to-source binding.

After authentication, Phase 2N applies additional bounded validation:

- at most 5,000 observations per delivery;
- at most 5,000 coverage records per delivery;
- unique `tobs_*` observation IDs;
- valid observation/coverage timestamps;
- observation source ID and physical source host must match the authenticated run source;
- dimensions are normalized and bounded before becoming a latest-state key.

The browser does not diagnose or mint canonical IDs. Canonical identity is resolved on the trusted Worker side against the current `semantic_estate_revision`.

## MQ identity semantics

Queue-manager identity is QMID-authoritative when `queue_manager_qmid` is present. A supplied queue-manager name must agree with the uniquely resolved QMID candidate. Name-only resolution is retained only when QMID is unavailable.

Queues, channels, and listeners resolve by canonical scoped identity:

`semantic_type + queue_manager_name + object_name`

When QMID is supplied for a scoped object, the owning queue manager must first resolve successfully. Ambiguous, conflicted, missing, mismatched, unsupported, or caller-supplied canonical identities are quarantined rather than guessed.

A single unresolved observation does not reject otherwise valid observations in the same authenticated batch.

## Persistence model

Migration `0008_telemetry_ingest.sql` adds four bounded operational tables:

- `telemetry_delivery_ledger` — content-addressed replay/idempotency ledger and processing lease;
- `telemetry_source_state` — current source health, evidence time, coverage and current quarantine summary;
- `telemetry_latest_observation` — one latest value per canonical entity / observation type / normalized dimensions key;
- `telemetry_quarantine` — first-seen durable identity-resolution failures.

D1 is deliberately not used as a raw time-series store. `telemetry_latest_observation` updates only when the value, unit, stable source semantics, or quality changes. A new sample timestamp or evidence reference alone does not force a D1 latest-state write. Current source freshness is carried separately in `telemetry_source_state.last_observed_at`.

This distinction is important: an unchanged queue depth sampled every 60 seconds remains observed by the source, but it does not generate a new D1 latest-value write every minute.

## Replay and ownership semantics

A verified delivery ID is claimed as `PROCESSING` with an attempt token. A completed delivery becomes `ACCEPTED`.

- A matching `ACCEPTED` delivery returns an authenticated `duplicate` acknowledgement before canonical resolution or latest-state writes.
- A delivery ID bound to different authenticated content/source returns `409 delivery_conflict`.
- A concurrent active processing lease returns `409 delivery_processing` with `Retry-After`.
- A stale processing lease can be reclaimed after five minutes.
- Final source-state and ledger acceptance writes are conditional on the current attempt token.

Latest-state writes and quarantine inserts are idempotent so a retry after an interrupted processing lease does not create an unbounded history stream.

## Source health semantics

`telemetry_source_state` is evidence-oriented, not a health guess.

- coverage with `failed`, `partial`, or `not_collected` makes the source state `degraded`;
- any identity quarantine in the current delivery also makes the source state `degraded`;
- successful collected coverage with no quarantine is `healthy`;
- absent coverage is `unknown`.

This does not turn an observability limitation into an MQ health failure. Existing `mq.observability.*` findings remain a separate concern.

## Cost instrumentation and enablement gate

Each ingest response exposes D1 metadata accumulated from the request path as:

- `X-OSI-D1-Rows-Read`
- `X-OSI-D1-Rows-Written`

Local Wrangler has previously returned zero row counters, so those headers are not treated as a billing forecast during local CI. Before continuous production ingestion is enabled, run the full accepted and duplicate request paths against a non-production remote D1 database using representative estate-scale batches and record the real Cloudflare row-read/write metadata.

The Phase 2N enablement gate is therefore:

1. local type check and end-to-end ingest smoke pass;
2. production deploy succeeds with migration applied and `ingress_enabled=false`;
3. non-production remote D1 measurement is performed for representative accepted, unchanged-value, changed-value, quarantine, and duplicate deliveries;
4. polling cadence / batch sizing is adjusted if required by measured D1 cost;
5. only then provision the production telemetry key registry and explicitly enable ingress.

## Local acceptance test

`scripts/phase2n-local-ingest-smoke.sh` applies all migrations to a local D1, seeds a two-entity canonical MQ estate, starts Wrangler with a temporary test key, and publishes an authenticated batch using the Python Phase 2K delivery code.

The fixture contains one resolvable queue and one unknown queue. The test proves:

- first delivery returns `202 accepted`;
- the identical authenticated delivery returns `200 duplicate`;
- the delivery ledger records one accepted delivery with one resolved and one quarantined observation;
- source counters increment only once;
- the resolved queue is persisted in latest state;
- the unknown queue is durably quarantined as `scoped_identity_not_found`.

## Out of scope

Phase 2N does not enable continuous production collection, store raw telemetry history, consume MQ event/statistics queues, mutate MQ configuration, introduce browser-side diagnostic rules, run the findings evaluator continuously, or add Cloudflare-to-MQ connectivity.
