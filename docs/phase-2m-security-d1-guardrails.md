# Phase 2M — Security and D1 cost guardrails

## Goal

Land the dependency-security and D1 cost-shape guardrails now that production recovery, Phase 2I read-efficiency work, and the Phase 2J–2L telemetry trust chain are on `main`.

Phase 2M remains a non-ingesting hardening slice. It adds no Worker telemetry route, no D1 migration, no Wrangler binding, no scheduler, no production credential, and no MQ authority. The purpose is to make the first production-facing ingestion slice measurable and bounded rather than speculative.

## 1. Dependency security gate

CI runs `npm audit --json` after dependency installation and passes the report through `scripts/check-npm-audit.mjs`.

The policy is intentionally simple:

- critical: blocking;
- high: blocking;
- moderate/low/info: reported but not automatically blocking in this phase.

The initial audit identified three high-severity package entries: direct `wrangler` plus transitive `miniflare` and `sharp`. npm identified Wrangler 4.131.0 as the non-major remediation. The repository therefore upgrades Wrangler from 4.129.0 to 4.131.0 and aligns `@cloudflare/workers-types` with the Wrangler peer requirement. CI must report zero high/critical vulnerabilities before merge.

We do not use `npm audit fix --force` automatically because forced major-version changes may alter Wrangler/Workers behavior and must be verified deliberately.

## 2. Candidate telemetry persistence schema

`design/telemetry/phase2m-telemetry-persistence.sql` is a design artifact, not a deployable migration.

It models four responsibilities that Phase 2N may need:

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

Current local Wrangler/Miniflare execution may return zero for `rows_read` and `rows_written` metadata. Phase 2M does **not** treat those zero counters as evidence of zero Cloudflare billable cost. This is a query-shape and logical-cardinality regression guardrail, not a billing forecast.

Phase 2N must measure accepted and authenticated-duplicate request paths against a non-production remote D1, including canonical-estate identity lookup cost, before continuous ingestion is enabled.

## 4. Representative telemetry-chain load regression

`test_phase2m_telemetry_load.py` exercises the Phase 2J/2K identity-and-delivery chain with:

- 20 telemetry batches;
- 250 observations per batch;
- 5,000 observations total;
- a bounded identity snapshot;
- deliberate unresolved objects so quarantine semantics are exercised;
- durable local spooling;
- duplicate re-spooling of the first batch to prove content idempotency.

The representative fixture resolves 4,800 observations and quarantines 200. Timing is reported for visibility only; CI does not encode a wall-clock SLA because shared runners are too variable for a meaningful performance threshold.

## Production boundary

Phase 2M must not modify:

- `src/index.ts`;
- `wrangler.jsonc`;
- `migrations/**`.

CI enforces that boundary.

## What remains for Phase 2N

The first production-facing telemetry-ingestion slice may now be built from the proven Phase 2J–2M contracts. Before continuous ingestion is enabled it must:

1. persist key/source binding outside source code;
2. persist the delivery ledger atomically with accepted latest-state changes;
3. generate canonical identity input from the active estate on the trusted side;
4. resolve or quarantine every observation without guessing;
5. skip resolution and latest-state writes for authenticated duplicates;
6. measure canonical-estate identity lookup and persistence row reads/writes against non-production remote D1;
7. demonstrate that one failed/quarantined observation cannot invalidate other valid observations in the same delivery;
8. retain high-cardinality history outside D1 unless measured evidence justifies otherwise;
9. keep the production route disabled until key material, source binding, replay semantics, quotas, and rollback behavior have all been verified.
