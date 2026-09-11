# Phase 2I — D1 efficiency and real-evidence regression hardening

## Purpose

Phase 2I uses the Cloudflare D1 quota interruption as an engineering signal rather than weakening any safety gate. The scope is deliberately local/CI-first so useful work can continue while production D1 is unavailable.

This phase has three goals:

1. reduce avoidable D1 reads in deployment and known hot investigation paths;
2. establish repeatable D1 query-plan guards for selective canonical reads;
3. convert a real five-sample IBM MQ capture shape into a sanitized public regression fixture without publishing production identifiers.

It does **not** change MQ configuration, enable monitoring, consume event/statistics queues, read message payloads, or introduce a new monitoring backend.

## D1 row-read audit

The audit focused on the read paths used by Overview, Objects, operational findings, Queue Investigation, Routes and Phase 2H Impact.

The Cloudflare account screenshot captured during the quota incident showed 6.21M D1 rows read against a 5M daily free-tier limit, while writes and storage were well below their limits. That establishes a row-read exhaustion event, but the account-level screenshot does **not** identify which endpoint or SQL statement caused each read. The rankings below are therefore code-grounded amplification mechanisms and query-plan findings, not an assertion of endpoint-level production causality.

### Confirmed client amplification: Overview compatibility layers

The Overview is currently composed by three operational UI layers that historically refreshed independently:

- `operational-intelligence.js` requested operations status, OPEN findings, ACKNOWLEDGED findings, and four severity-count variants — seven D1-backed requests per refresh;
- `phase2d-evidence-semantics.js` separately requested operations status, latest observation, OPEN informational findings and ACKNOWLEDGED informational findings — four more requests;
- `phase2e-triage-compression.js` separately requested all OPEN findings, all ACKNOWLEDGED findings, latest observation and canonical-estate summary — four more requests.

That is at least 15 D1-backed HTTP requests in an uncoordinated Overview refresh cycle before pagination, navigation-triggered refreshes, or mutation-observer retries are counted. Several requests ask for overlapping current-state facts.

Phase 2I installs `phase2i-overview-read-broker.js` before those compatibility layers. It does not change the API contracts. Instead it:

- coalesces identical operations-status requests for 30 seconds;
- coalesces latest-observation requests for 30 seconds;
- loads one complete current finding snapshot per lifecycle status (`OPEN` / `ACKNOWLEDGED`) for 30 seconds and answers Overview severity/count/page variants from that same snapshot;
- caches canonical-estate summary for five minutes because topology revisions change through explicit imports rather than once per minute;
- invalidates all cached current-state projections on any `/api/v2/` mutation.

With the present finding volume fitting within one 200-item page per lifecycle state, the common Overview refresh shape falls from at least 15 backend reads to approximately five unique backend reads: operations status, OPEN findings, ACKNOWLEDGED findings, latest observation, and (when its five-minute cache expires) canonical-estate summary. This is a request-amplification reduction, not a promise about Cloudflare billable row reads; remote D1 must still be measured after quota recovery.

CI runs `test-phase2i-overview-read-broker.mjs` against a mocked backend and proves concurrent status reads, finding filter/count variants, latest-observation reads and estate-summary reads are coalesced while API mutations invalidate the cache.

### Confirmed backend amplification: canonical-estate summary

`GET /api/v2/estate/current/summary` previously scanned the current `semantic_estate_entity` projection three separate times:

1. counts grouped by `semantic_type`;
2. counts grouped by `identity_state`;
3. `COUNT(*)` for `source_count > 1`.

With the current estate at 924 entities, that SQL shape repeatedly walks the same bounded entity set even though all three results can be derived from one grouped pass. Phase 2I replaces those three entity queries with one rollup grouped by `(semantic_type, identity_state)` and derives the per-type, per-state and multi-source totals in the Worker. The unresolved-state rollup remains a separate query over `semantic_estate_unresolved`.

The response contract is unchanged and the sanitized regression estate verifies exact summary counts.

### Confirmed planner obstruction: optional-filter OR predicates

Canonical list APIs previously encoded every optional filter as expressions such as:

```sql
(? = '' OR semantic_type = ?)
```

That is convenient for one prepared SQL shape but makes selective intent less explicit to SQLite/D1. Phase 2I now builds exact predicates only for filters actually supplied. Examples become:

```sql
WHERE estate_revision_id = ? AND semantic_type = ?
```

or:

```sql
WHERE estate_revision_id = ? AND source_entity_id = ?
```

The same approach is applied to entity, relation and unresolved list readers. The contains-search predicate is added only when `q` is non-empty.

Local `EXPLAIN QUERY PLAN` CI guards require filtered reads to retain the existing selective indexes for:

- entity semantic type;
- relation source entity;
- relation target entity;
- unresolved state;
- Phase 2I unresolved source entity.

### Good existing access paths

The canonical estate already has useful compound indexes for:

- entity lookup by `(estate_revision_id, entity_id)` via the primary key;
- entity type / identity lookups;
- relation traversal from source and target entity IDs;
- unresolved-estate summary by state;
- operational observations by evaluation + entity/type;
- operational findings by evaluation + entity/rule/severity;
- operational coverage by evaluation + scope/state.

Phase 2H transport expansion therefore already follows indexed source-entity relationships rather than scanning the relationship table.

### Confirmed gap: entity-scoped unresolved lookup

`/api/v2/routes/impact?entity_id=...` asks for unresolved references with:

```sql
WHERE estate_revision_id = ? AND source_entity_id = ?
ORDER BY state, semantic_type, unresolved_id
```

Before Phase 2I, the only unresolved index was ordered by:

```text
(estate_revision_id, state, semantic_type)
```

That can narrow to one estate, but not directly to the investigated source entity. As the unresolved set grows with additional hosts and middleware systems, that becomes unnecessary row-read work.

Migration `0007_d1_read_efficiency.sql` adds:

```text
(estate_revision_id, source_entity_id, state, semantic_type, unresolved_id)
```

The Phase 2I CI check uses local D1 `EXPLAIN QUERY PLAN` and fails unless the entity-scoped unresolved lookup uses `idx_semantic_estate_unresolved_source`.

### Remaining high-priority readers to measure remotely

Two operational SQL families deserve measurement after quota reset because code inspection shows they can amplify reads as history and source count grow:

1. `GET /api/v2/operations/status` performs separate counts over current evaluations, current distinct findings, current observations, and current coverage gaps;
2. `GET /api/v2/findings/current` uses a ranked window over current finding occurrences plus a separate distinct-count query. Existing indexes are sensible, but join order and window-work cost need remote evidence before further schema changes are justified.

The Overview broker reduces how often these readers are called. Phase 2I deliberately does not add speculative operational indexes without measured query-plan or remote row-read evidence.

### Intentional bounded scans / future work

Canonical free-text search currently uses a contains match (`LIKE '%query%'`) over the current estate. A normal B-tree cannot efficiently serve a leading-wildcard contains search. With the current estate size this remains bounded, but it is the first candidate for a dedicated search projection / FTS strategy when estate growth makes the row-read budget material.

Current operational readers also join historical child tables to the small set of current evaluation revisions. Existing compound indexes are good, but the SQL shape should be profiled again once multiple hosts are publishing continuous operational revisions; if D1 chooses a history-first join plan, Phase 2I recommends forcing a current-revision-first plan rather than adding speculative indexes.

No index is added merely because a column appears in a filter. Each new index carries write/storage cost and must correspond to a measured or explainable read path.

## Deployment migration gate

The production workflow previously ran:

```text
wrangler d1 migrations apply DB --remote
```

for every push to `main`, including UI-only or JavaScript-only changes. That command must read the remote D1 migration ledger even when the commit contains no migration.

Phase 2I now detects whether `migrations/**` changed between the previous and current `main` commit:

- **migration changed** → the remote D1 migration gate remains mandatory before Worker deployment;
- **no migration changed** → the remote migration-ledger read is skipped;
- **manual workflow dispatch** → the migration gate remains mandatory so an operator can explicitly reconcile schema state.

All post-deployment health, import, canonical-estate and operational-findings smoke tests remain mandatory. This optimization removes an unnecessary read; it does not weaken deployment verification.

## Sanitized real-evidence regression fixture

`fixtures/regression/mq-real-shape-v1.json` is derived from the structure and numerical progression of a real read-only IBM MQ capture. The public repository does **not** contain the original production identifiers.

Preserved evidence shape:

- five queue-status samples;
- approximately one-minute sampling cadence;
- queue depth progression `1 → 11 → 18 → 33 → 46`;
- oldest-message age progression `1 → 65 → 129 → 193 → 258` seconds;
- `IPPROCS=0` in all samples;
- `OPPROCS=1` in all samples;
- evaluator expectations for `mq.queue.oldest_message_aging.v1` and `mq.queue.backlog_no_input_process.v1`.

Replaced before commit:

- physical hostname / FQDN;
- queue-manager names;
- queue names;
- network addresses;
- source IDs and environment-specific identifiers.

The fixture explicitly preserves OSI semantic boundaries: output-open access is not proof of MQPUT activity, cluster visibility is not proof of message traversal, and neither a business-SLA breach nor application/service impact is asserted by the five-sample evidence alone.

## CI regression path

The Phase 2I workflow performs only local/CI operations:

1. validates that the sanitized fixture contains no known production tokens or IPv4 addresses;
2. verifies the Overview read broker coalesces overlapping current-state requests and invalidates on mutation;
3. applies all D1 migrations to local D1;
4. checks entity-source unresolved and selective entity/relation/unresolved query plans;
5. seeds the sanitized canonical estate, operational observations, findings and unresolved destination boundary;
6. starts the Worker locally;
7. verifies the one-pass canonical summary and filtered canonical list response contracts;
8. verifies 20 persisted queue observations (four metrics × five samples);
9. verifies the two current findings for the queue;
10. verifies Phase 2H Impact classifies the runtime process as upstream `runtime_access`, keeps downstream continuation unresolved, and does not assert application/service impact;
11. verifies passive route tracing from the runtime process to the queue while retaining the runtime-access semantic warning.

This gives the project a realistic regression shape without depending on production D1 or publishing sensitive estate data.

## Production status while quota is exhausted

Phase 2I can be developed and validated in CI while the remote D1 quota is exhausted. Because this phase includes a real schema migration (`0007`), it should not be declared production-deployed until the quota is available and the normal production migration + post-deploy smoke gates succeed.
