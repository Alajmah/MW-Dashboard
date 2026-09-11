# Phase 2M — Security and D1 cost guardrails

## Goal

Use the production D1 quota waiting window to reduce future operational risk before the first continuous telemetry ingestion route exists.

Phase 2M is deliberately stacked on Phase 2L and remains offline. It adds no Worker ingestion route, no D1 migration, no Wrangler binding, no scheduler, no production credential, and no MQ authority.

## 1. Dependency security gate

CI runs `npm audit --json` after dependency installation and passes the report through `scripts/check-npm-audit.mjs`.

The policy is intentionally simple:

- critical: blocking;
- high: blocking;
- moderate/low/info: reported but not automatically blocking in this phase.

The gate prints each vulnerable package, whether it is direct or transitive, the affected range, advisory titles, and npm's available fix metadata. We do not use `npm audit fix --force` automatically because forced major-version changes may alter Wrangler/Workers behavior and must be verified deliberately.

## 2. Candidate telemetry persistence schema

`design/telemetry/phase2m-telemetry-persistence.sql` is a design artifact, not a deployable migration.

It models four responsibilities that a later Phase 2N endpoint may need:

- `telemetry_delivery_ledger` — authenticated delivery idempotency/replay ledger;
- `telemetry_source_state` — latest source/transport health projection;
- `telemetry_latest_observation` — one latest value per canonical entity, observation type and dimension key;
- `telemetry_quarantine` — identity-resolution failures kept separate from middleware health.

The schema intentionally does not store high-cardinality telemetry history. D1 remains the candidate store for latest state, idempotency, source health, quarantine visibility and coarse rollups only.

## 3. Local D1 cost harness

`scripts/phase2m-d1-budget.mjs` creates an isolated local D1 database, applies only the candidate design schema and seeds 5,000 latest-state rows.

It then measures D1-reported `rows_read` and `rows_written` for a representative accepted-delivery path:

1. delivery-ledger miss;
2. ledger insert;
3. delivery-ledger hit/duplicate probe;
4. source-state upsert;
5. 200 latest-observation upserts;
6. 20 quarantine inserts.

Each operation has a deliberately conservative guardrail. The harness also requires the delivery-id lookup to produce an indexed `SEARCH` plan.

These numbers are not a Cloudflare billing forecast. They are a regression budget for the local schema shape. Phase 2N must re-measure the full request path against the active canonical-estate queries before production ingestion is enabled.

## 4. Representative telemetry-chain load regression

`test_phase2m_telemetry_load.py` exercises the Phase 2J/2K identity-and-delivery chain with:

- 20 telemetry batches;
- 250 observations per batch;
- 5,000 observations total;
- a bounded identity snapshot;
- deliberate unresolved objects so quarantine semantics are exercised;
- durable local spooling;
- duplicate re-spooling of the first batch to prove content idempotency.

The test reports payload size, spool size, resolution/quarantine counts and elapsed time. Timing is informational only; CI does not encode a wall-clock SLA because shared runners are too variable for a meaningful performance threshold.

## Production boundary

Phase 2M must not modify:

- `src/index.ts`;
- `wrangler.jsonc`;
- `migrations/**`.

CI enforces that boundary for the stacked PR.

## What remains for Phase 2N

After production recovery and the Phase 2I migration are complete, a production-facing telemetry ingestion slice may be built from the already-proven contracts. Before that route is enabled it must:

1. persist key/source binding outside source code;
2. persist the delivery ledger atomically with accepted latest-state changes;
3. generate the canonical identity snapshot from the active estate;
4. resolve or quarantine every observation without guessing;
5. skip resolution and state writes for authenticated duplicates;
6. measure canonical-estate identity lookup row reads in addition to the Phase 2M persistence budget;
7. demonstrate that one failed/quarantined observation cannot invalidate other valid observations in the same delivery;
8. retain high-cardinality history outside D1 unless measured evidence justifies otherwise.
