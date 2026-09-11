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

The initial Phase 2M audit identified three high-severity package entries: direct `wrangler` plus transitive `miniflare` and `sharp`. npm identified Wrangler 4.131.0 as the non-major remediation. The repository therefore upgrades Wrangler from 4.129.0 to 4.131.0 and aligns `@cloudflare/workers-types` with the Wrangler peer requirement. CI then reports zero npm vulnerabilities.

We do not use `npm audit fix --force` automatically because forced major-version changes may alter Wrangler/Workers behavior and must be verified deliberately.

## 2. Candidate telemetry persistence schema

`design/telemetry/phase2m-telemetry-persistence.sql` is a design artifact, not a deployable migration.

It models four responsibilities that a later Phase 2N endpoint may need:

- `telemetry_delivery_ledger` — authenticated delivery idempotency/replay ledger;
- `telemetry_source_state` — latest source/transport health projection;
- `telemetry_latest_observation` — one latest value per canonical entity, observation type and dimension key;
- `telemetry_quarantine` — identity-resolution failures kept separate from middleware health.

The schema intentionally does not store high-cardinality telemetry history. D1 remains the candidate store for latest state, idempotency, source health, quarantine visibility and coarse rollups only.

## 3. Local D1 cost-shape harness

`scripts/phase2m-d1-budget.mjs` creates an isolated local D1 database, applies only the candidate design schema and seeds 5,000 latest-state rows.

It exercises a representative accepted-delivery persistence path:

1. delivery-ledger miss;
2. ledger insert;
3. delivery-ledger hit/duplicate probe;
4. source-state upsert;
5. 200 latest-observation upserts;
6. 20 quarantine inserts.

The harness enforces an indexed `SEARCH` plan for the delivery-id lookup and verifies logical write cardinality: one ledger row, one source-state row, 200 latest-observation rows touched, and 20 quarantine rows.

Current local Wrangler/Miniflare execution returns zero for `rows_read` and `rows_written` metadata for these operations. Phase 2M therefore does **not** claim that local execution measured Cloudflare billable row reads/writes. The zero counters are recorded explicitly as unavailable local billing evidence rather than treated as a free query path.

This is a schema/query-shape regression guardrail, not a Cloudflare billing forecast. Phase 2N must measure both accepted and authenticated-duplicate request paths against a non-production remote D1, including canonical-estate identity lookup cost, before continuous ingestion is enabled.

## 4. Representative telemetry-chain load regression

`test_phase2m_telemetry_load.py` exercises the Phase 2J/2K identity-and-delivery chain with:

- 20 telemetry batches;
- 250 observations per batch;
- 5,000 observations total;
- a bounded identity snapshot;
- deliberate unresolved objects so quarantine semantics are exercised;
- durable local spooling;
- duplicate re-spooling of the first batch to prove content idempotency.

The current CI fixture resolves 4,800 observations and quarantines 200, processes about 3.55 MB of canonical payload, and produces about 5.21 MB of durable spool records. Timing is reported for visibility only; CI does not encode a wall-clock SLA because shared runners are too variable for a meaningful performance threshold.

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
6. measure canonical-estate identity lookup and persistence row reads/writes against non-production remote D1;
7. demonstrate that one failed/quarantined observation cannot invalidate other valid observations in the same delivery;
8. retain high-cardinality history outside D1 unless measured evidence justifies otherwise.
