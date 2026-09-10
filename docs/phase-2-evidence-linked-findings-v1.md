# OSI Phase 2.0 — Evidence-Linked Findings v1

**Document class:** Authorized implementation contract  
**Status:** AUTHORIZED / IN PROGRESS  
**Authorization:** Explicit user instruction, 2026-09-10  
**Phase objective:** Convert existing read-only IBM MQ evidence into conservative, canonical-identity-linked operational observations and evidence-linked findings without introducing a third-party monitoring runtime or changing IBM MQ configuration.

## 1. Governing outcome

Phase 2.0 proves this path against real OSI evidence:

```text
raw IBM MQ collector evidence
        ↓
OSI operational observations
        ↓
coverage / freshness state
        ↓
conservative finding evaluation
        ↓
canonical entity identity
        ↓
exact evidence references
```

The phase exists to establish trustworthy operational claims before persistence and UI treatment become authoritative product behavior.

A finding is a **derived OSI claim**, not a raw metric, chart state, MQSC line, or imported alert. Every emitted finding must identify the canonical entity it concerns, separate severity from confidence/coverage, and carry evidence references sufficient to inspect the facts that caused it.

## 2. Pattern promotion record

The following Architecture Pattern Register entries are explicitly linked to this phase. This is implementation authorization for the bounded scope below; it is not blanket adoption of every possible application of each pattern.

| Pattern | Phase effect | Phase disposition |
|---|---|---|
| APR-007 — Findings as Evidence-Linked Derived Operational Claims | Defines the Finding object and evidence-link requirement. | LINKED |
| APR-010 — Multi-Signal Health Signature over Single-Metric Threshold | Governs queue trend/consumer diagnosis and causal restraint. | LINKED |
| APR-015 — Observability Gaps as First-Class Operational Findings | Missing/disabled/failed diagnostic coverage must not become false green. | LINKED |
| APR-019 — OSI-Owned Operational Observation Contract | Defines source-independent time-stamped runtime facts keyed to canonical identity. | LINKED |
| APR-023 — Evidence Coverage and Finding Confidence Are Separate State | Severity, confidence, and evidence coverage remain independent fields. | LINKED |
| APR-024 — Collection Failures Are First-Class Evidence | Propagates failed/not-collected evidence into coverage findings. | LINKED |
| S-01 — Evidence-to-Finding Operational Intelligence Pipeline | Defines the end-to-end architectural direction for this phase. | LINKED |

The following accepted safety patterns constrain the phase but do not authorize new collection mechanisms:

- **APR-016 — Existing Observer Ownership and Event-Source Coexistence.** No event-queue ingestion is introduced.
- **APR-017 — Observation Must Not Reset or Mutate Monitoring State.** No `RESET QSTATS`, state-changing MQSC, or additional change authority is introduced.

## 3. External-study boundary

Prometheus, Grafana, OpenTelemetry, Instana, Dynatrace, Zabbix, and IBM sample monitoring projects are research/provenance inputs only. Phase 2.0 does **not** integrate, deploy, depend on, scrape, embed, or adopt their runtimes, storage models, protocols, dashboards, agents, exporters, collectors, or metric namespaces.

Any useful mechanism is restated in OSI-owned vocabulary and implemented from OSI evidence.

## 4. Frozen contracts

### 4.1 OperationalObservation

An `OperationalObservation` is an immutable sampled fact about one canonical entity.

Required semantics:

- stable observation identity;
- canonical `entity_id` and semantic type;
- OSI-owned `observation_type`;
- `observed_at` timestamp;
- typed value and unit;
- exact source/evidence/sample provenance;
- collection method;
- evidence class;
- coverage and freshness quality.

Phase 2 observation types are intentionally small:

```text
mq.queue_manager.status
mq.listener.status
mq.channel.status
mq.channel.monitoring_level
mq.queue.depth.current
mq.queue.process.input_count
mq.queue.process.output_count
mq.queue.message.age.oldest_seconds
```

Raw MQ field names remain evidence-source vocabulary. They do not become the general OSI contract.

### 4.2 FindingEvidenceRef

A `FindingEvidenceRef` identifies the evidence location and sample supporting a rule decision. It records observation types but does not copy the entire raw source artifact into a finding.

### 4.3 CoverageState

Coverage is explicit and independent of health:

```text
sufficient | limited | partial | failed | unknown
```

Raw collection outcomes remain:

```text
complete | point_in_time | partial | failed | not_collected
```

Coverage answers whether OSI can support a claim. It is not a health status.

### 4.4 Finding

A `Finding` requires:

```text
finding_id
rule_id
entity_id
semantic_type
display_name
severity
status
summary
diagnosis
confidence
first_seen
last_seen
coverage_state
evidence[]
related_entities[]
details
```

Phase 2 lifecycle starts with `OPEN`. Durable `ACKNOWLEDGED` / `RESOLVED` lifecycle is intentionally deferred until persistence is implemented.

Severity and confidence are not interchangeable. A potentially high-impact condition may remain uncertain; a confirmed observability gap may be informational.

## 5. Findings v1 rules

Rules are deliberately conservative and must not invent business SLAs or causal claims.

| Rule | Evidence required | Initial output semantics |
|---|---|---|
| `mq.qmgr.unavailable.v1` | Successful QMSTATUS sample with explicit non-RUNNING latest state | Critical; direct state claim |
| `mq.listener.unavailable.v1` | Successful LSSTATUS sample with explicit non-RUNNING latest state | Warning; direct state claim |
| `mq.channel.abnormal.v1` | Channel appears in successful CHSTATUS sample with explicit non-RUNNING latest state | Warning; impact explicitly not established |
| `mq.queue.backlog_increasing.v1` | >=3 queue-status samples with sustained positive depth trend | Warning; trend only, no arbitrary depth threshold |
| `mq.queue.oldest_message_aging.v1` | >=3 samples, queue stays non-empty, oldest-message age grows approximately with wall time | Warning; persistence evidence, not SLA breach |
| `mq.queue.backlog_no_input_process.v1` | Backlog trend + IPPROCS=0 across sampled window; OPPROCS>0 strengthens confidence | Warning; “no input process observed,” not “application outage” |
| `mq.observability.*.v1` | Disabled diagnostic coverage or failed/not-collected required command evidence | Info/Warning; health must not be inferred from missing evidence |

### 5.1 Queue policy boundary

Generic v1 queue rules **exclude IBM/system queues** (`SYSTEM.*`, `AMQ.*`, `KMQ.*`). Their operational semantics differ from application queues and require a separate policy class. A large or old system queue is not automatically an incident.

### 5.2 No absolute queue-depth threshold

Phase 2.0 does not declare a universal `CURDEPTH > N` incident rule. Queue role and business policy are not yet rich enough to support that claim safely.

### 5.3 No causality inflation

The following translations are prohibited in v1 unless stronger evidence is added:

```text
IPPROCS=0                 != consumer application is down
channel STOPPED           != business route is broken
MSGAGE growing            != SLA breach
MONCHL=OFF                != channel is unhealthy
failed collection command != observed object absence
```

## 6. Canonical identity compatibility

The offline evaluator must generate entity identifiers using the same rules as the canonical estate builder for the supported MQ entities:

- queue manager: `qmid` when available, otherwise name;
- queue/channel/listener: queue-manager key + object name;
- canonical ID prefix and SHA-256 truncation must match the existing `cent_...` algorithm.

This ensures a finding evaluated from a raw archive can later be attached to the same canonical entity after semantic reconciliation.

## 7. Foundation implementation slice

The first authorized slice consists of:

1. versioned JSON contracts for OperationalObservation, FindingEvidenceRef, CoverageState, and Finding;
2. an offline/read-only IBM MQ evaluator, `collectors/ibm-mq/evaluate_findings_v1.py`;
3. rule-level tests including positive, negative/recovery, insufficient-sample, semantic-scope, and canonical-identity cases;
4. evaluation of the existing `sjeditb18703` five-sample archive outside the public repository;
5. CI that syntax-checks and runs the rule tests.

This slice intentionally leaves the existing `osi.observation.bundle/v2` import contract unchanged. The current semantic import accepts four collections only; operational observations/findings will receive their own persistence/API contract in the next slice rather than being silently inserted into ObservationBundle v2.

## 8. Acceptance criteria — foundation slice

The slice is accepted when all of the following are true:

- evaluator is read-only and takes an existing `.tar.gz` evidence artifact as input;
- no network or MQ connection is made by the evaluator;
- observation and finding contracts are versioned and machine-readable;
- emitted entity IDs match canonical estate identity rules for Queue Manager, Queue, Channel, and Listener;
- each finding contains exact evidence references;
- collection failure is distinguished from a valid empty wildcard enumeration;
- application-queue trend rules exclude system queues;
- queue trend logic does not flag a series that drains/recovers inside the sampled window as sustained backlog;
- fewer than three samples cannot create a trend finding;
- disabled channel monitoring creates an observability/coverage finding, not a channel-health failure;
- no external monitoring runtime/dependency is introduced;
- automated tests pass.

## 9. Real-evidence qualification target

The existing five-sample `sjeditb18703` archive is the first qualification artifact. Expected qualitative properties, not hard-coded queue names/counts, are the acceptance basis:

- running Queue Managers/listeners/channels must not be falsely reported unavailable;
- genuine application-queue depth growth with no input process should be surfaced conservatively;
- queues that drain/recover during the window should not be classified as sustained backlog;
- persistent oldest-message aging may be surfaced without claiming a business SLA breach;
- current `MONCHL(OFF)` evidence should become a queue-manager-scoped diagnostic coverage gap, not hundreds of per-channel warnings;
- raw system/event/statistics queues remain outside the generic application-queue policy.

Real estate-derived result files are not committed to the public repository by default.

## 10. Explicitly out of scope

Phase 2.0 does not authorize:

- Prometheus/Grafana/OpenTelemetry integration;
- any third-party monitoring agent/exporter/runtime;
- a new continuous MQ agent;
- active route tracing or tracer messages;
- `RESET QSTATS` or other state-changing measurement;
- MQ configuration changes, including global `MONCHL`/`STATMQI` changes;
- consuming/browsing administrative event queues;
- log aggregation;
- AI/LLM diagnosis;
- automatic remediation;
- generic alert/incident-management functionality;
- business-specific queue SLA policy;
- route/blast-radius health conclusions before entity findings are trustworthy.

## 11. Successor slices

Successful completion of this foundation slice does not automatically authorize successors. The intended sequence, subject to explicit continuation, is:

```text
2.0A  contracts + evaluator + real-evidence qualification
2.0B  D1 persistence + finding lifecycle + API
2.0C  Overview “Requires attention” + Object Detail Findings/Monitor/Evidence
2.0D  route-context enrichment after per-entity findings are proven
```

The governing rule remains: **evidence first, derived claim second, presentation last**.
