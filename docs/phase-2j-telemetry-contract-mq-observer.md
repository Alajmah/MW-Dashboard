# Phase 2J — Telemetry contract and read-only IBM MQ observer

## Goal

Create the contract boundary and a locally testable IBM MQ observer before adding any remote ingestion or database persistence.

This slice is intentionally offline with respect to MW-Dashboard production. It adds no D1 migration, Worker route, scheduler, MQ configuration change, event-queue consumer, or external monitoring dependency.

## Why a separate telemetry plane

The existing IBM MQ topology collector is optimized for immutable forensic evidence and semantic reconstruction. Continuous operational state has a different lifecycle and cardinality. Treating every future sample as another topology revision would mix concerns and create unnecessary D1 churn.

Phase 2J therefore formalizes a separate telemetry plane:

```text
IBM MQ runtime
  -> osi-mq-observer
  -> osi.telemetry.batch/v1
  -> canonical identity resolution        (future)
  -> operational/latest-state projection  (future)
  -> optional time-series backend          (future)
```

D1 remains appropriate for canonical entities, relations, revisions, latest state, findings/history, policy, source health, and bounded rollups. It is not designated as the raw high-cardinality time-series store.

## Contract

`contracts/telemetry/v1/telemetry-batch.schema.json` defines `osi.telemetry.batch/v1`.

A batch contains:

- run metadata and the physical source host;
- explicit command-family coverage;
- runtime observations;
- source-native identity hints;
- command/sample provenance;
- quality state.

The observer deliberately leaves `canonical_entity_id` unset. Canonical identity remains owned by the semantic estate. A future ingestion boundary may populate that field only after resolving the identity hints against the current canonical estate.

## Compatibility with the current operational findings model

The baseline metric names are intentionally the same names already emitted by `evaluate_findings_v1.py` for the five-sample evidence path:

```text
mq.queue_manager.status
mq.queue.depth.current
mq.queue.process.input_count
mq.queue.process.output_count
mq.queue.message.age.oldest_seconds
mq.channel.status
mq.channel.monitoring_level
mq.listener.status
```

This allows a future resolver to convert a resolved telemetry observation into the existing operational observation shape without browser-side reinterpretation.

No finding rule is moved into the observer. Diagnosis remains a separate evaluation concern.

## Read-only collector boundary

The observer has an explicit MQSC allowlist:

```text
DISPLAY QMGR QMID
DISPLAY QMSTATUS ALL
DISPLAY QSTATUS(*) TYPE(QUEUE) ALL
DISPLAY CHSTATUS(*) ALL
DISPLAY LSSTATUS(*) ALL
```

`safe_display_command()` rejects anything outside that exact allowlist. The implementation does not use `RESET QSTATS`, event/statistics queues, active route tracing, authority export, message browsing/GET, or queue-manager mutations.

`DISPLAY QMGR QMID` is collected once so logical queue-manager identity can survive physical-node failover. Physical source host remains separately recorded in the batch run and observation provenance.

## Coverage and evidence semantics

A command family is `point_in_time` only when `runmqsc` succeeds and no MQ error message is present. Failures are explicit coverage records and produce no observations.

The observer does not interpret failed enumeration as object absence. It also does not assert freshness SLAs. `freshness: sampled` means only that the value came from the current observer sampling operation.

## Channel semantics

Multiple running channel instances may share one configured channel identity. `JOBNAME`, `CONNAME`, `RAPPLTAG`, `RQMNAME`, and `CHLTYPE` are therefore dimensions on an observation. They are not appended to canonical identity hints.

The observer emits channel status and `MONCHL` level when present. It does not yet emit NETTIME/XQTIME. Production evidence currently shows channel timing monitoring disabled in the sampled estate, so timing metrics should be introduced only after a controlled MONCHL validation rather than pretending a zero/absent value is meaningful timing evidence.

## Cadence

The CLI defaults to a single foreground sample. No daemon is installed.

The current design target remains:

- approximately 60 seconds for queue-manager, queue, channel, and listener state;
- approximately 5 minutes for future application/connection/handle families;
- approximately 30 minutes for future topology/configuration fingerprint refresh;
- temporary 10–30 second sampling around an active investigation only after adaptive collection is designed.

These are design targets, not an enabled production schedule or freshness SLA.

## What remains before continuous production telemetry

1. Resolve telemetry identity hints to canonical `cent_*` entities at a trusted ingestion boundary.
2. Define authenticated outbound publishing from private middleware hosts without giving Cloudflare MQ administrative access.
3. Define idempotency, backpressure, retry, and local spool behavior.
4. Decide latest-state/rollup retention in D1 versus optional external time-series retention.
5. Load-test the baseline command set on representative production queue managers.
6. Add controlled MONCHL testing before channel timing metrics.
7. Add connection/handle families with strict cardinality controls.

Until those gates are complete, `osi-mq-observer` remains an explicit foreground/local collector.
