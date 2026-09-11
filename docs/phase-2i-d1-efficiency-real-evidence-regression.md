# Phase 2I — D1 efficiency and real-evidence regression hardening

## Purpose

Phase 2I uses the Cloudflare D1 quota interruption as an engineering signal rather than weakening any safety gate. The scope is deliberately local/CI-first so useful work can continue while production D1 is unavailable.

This phase has three goals:

1. reduce avoidable D1 reads in deployment and known hot investigation paths;
2. establish a repeatable D1 query-plan guard for the new entity-scoped impact lookup;
3. convert a real five-sample IBM MQ capture shape into a sanitized public regression fixture without publishing production identifiers.

It does **not** change MQ configuration, enable monitoring, consume event/statistics queues, read message payloads, or introduce a new monitoring backend.

## D1 row-read audit

The audit focused on the read paths used by Overview, Objects, operational findings, Queue Investigation, Routes and Phase 2H Impact.

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
2. applies all D1 migrations to local D1;
3. checks the entity-scoped unresolved query plan;
4. seeds the sanitized canonical estate, operational observations, findings and unresolved destination boundary;
5. starts the Worker locally;
6. verifies 20 persisted queue observations (four metrics × five samples);
7. verifies the two current findings for the queue;
8. verifies Phase 2H Impact classifies the runtime process as upstream `runtime_access`, keeps downstream continuation unresolved, and does not assert application/service impact;
9. verifies passive route tracing from the runtime process to the queue while retaining the runtime-access semantic warning.

This gives the project a realistic regression shape without depending on production D1 or publishing sensitive estate data.

## Production status while quota is exhausted

Phase 2I can be developed and validated in CI while the remote D1 quota is exhausted. Because this phase includes a real schema migration (`0007`), it should not be declared production-deployed until the quota is available and the normal production migration + post-deploy smoke gates succeed.
