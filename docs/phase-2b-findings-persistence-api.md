# OSI Phase 2.0B — Findings Persistence and API

**Document class:** Authorized implementation contract  
**Status:** IMPLEMENTED / QUALIFYING  
**Authorization:** Explicit continuation of Phase 2.0, 2026-09-10  
**Phase objective:** Persist qualified Phase 2A operational observations, coverage records, and evidence-linked findings in D1 with revision-safe activation, durable finding lifecycle, and read APIs suitable for the Phase 2C product UI.

## 1. Governing outcome

Phase 2B turns the Phase 2A evaluation artifact into durable OSI operational state without changing the semantic topology contract:

```text
qualified Phase 2A evaluation JSON
        ↓
staged operational evaluation revision
        ↓
observations + coverage + finding occurrences
        ↓
count validation
        ↓
atomic per-source activation
        ↓
current operational view
        ↓
durable finding lifecycle + read APIs
```

The existing `osi.observation.bundle/v2` topology import remains unchanged. Operational observations and findings are a separate persistence domain because they have different temporal and lifecycle semantics.

## 2. Architectural invariants

1. **Evidence first.** Every operational observation retains source, sample, collection method, and exact `evidence_ref`. Every finding occurrence retains its Phase 2A evidence references.
2. **Canonical identity.** Operational records attach to canonical `cent_...` entity IDs produced by the same identity rules used by the canonical estate.
3. **Per-source current revision.** Each `source_id` has at most one current operational evaluation. The current estate-wide operational view is the union of current source evaluations.
4. **No partial current state.** Evaluation data is staged, chunked, count-checked, and only then activated. Readers never consume a half-imported evaluation.
5. **No stale replacement.** A current source evaluation cannot be replaced by an equal or older `evaluated_at` revision.
6. **Finding occurrence is not lifecycle state.** The evaluator emits a claim occurrence. Operator `ACKNOWLEDGED` / `RESOLVED` state is durable and stored separately.
7. **Absence is not recovery.** A finding disappearing from a later evaluation does not automatically resolve it. Missing or reduced coverage can also cause absence.
8. **Reopen requires newer positive evidence.** A resolved finding is reopened only when a newer activated occurrence has `last_seen` later than the lifecycle transition that resolved it.
9. **Acknowledgement survives reevaluation.** A newer occurrence does not erase an operator acknowledgement.
10. **External monitoring systems remain study-only.** No Prometheus, Grafana, OpenTelemetry, Instana, Dynatrace, or other external monitoring runtime is introduced.

## 3. Persistence model

### 3.1 `operational_evaluation_revision`

Immutable import revision metadata and activation state. The server computes `evaluation_key` from schema version, source identity, evaluation time, source artifact digest, and result digest. Reimporting the same evaluation is rejected.

Status lifecycle:

```text
STAGING → ACTIVE → SUPERSEDED
```

`FAILED` is reserved for future explicit failed-import bookkeeping. Only one `ACTIVE`/`is_current=1` revision is permitted per `source_id`.

### 3.2 `operational_observation`

Persists Phase 2A `OperationalObservation` records. Typed values are stored as JSON so numeric, boolean, and string observations retain their type. Source, quality, and dimensions remain structured JSON.

### 3.3 `operational_coverage`

Persists collection-family/sample coverage records independently from health. Raw states remain:

```text
complete | point_in_time | partial | failed | not_collected
```

A collection gap is not converted to an object-health state.

### 3.4 `operational_finding_occurrence`

Stores the evaluator's immutable finding snapshot for one operational evaluation revision. Imported evaluator status must be `OPEN`; operator lifecycle cannot be supplied or overwritten by evaluation import.

### 3.5 `operational_finding_state`

Stores durable operator-facing lifecycle by stable `finding_id`:

```text
OPEN | ACKNOWLEDGED | RESOLVED
```

It is deliberately independent of a specific evaluation revision.

### 3.6 `operational_finding_state_event`

Append-only lifecycle transition audit records. Transitions record whether they came from evaluation activation or the operator API.

## 4. Import protocol

All writes use the existing administrative bearer-token boundary (`ADMIN_IMPORT_TOKEN`). Read APIs are public in the same manner as existing canonical estate read APIs.

### 4.1 Create evaluation revision

`POST /api/v2/operations/evaluations`

Manifest shape:

```json
{
  "schema_version": "osi.findings.evaluation/v1",
  "source": { "id": "host.example", "host": "host" },
  "environment": "prod",
  "evaluator": "evaluate_findings_v1.py",
  "evaluator_version": "1.0.0",
  "evaluated_at": "2026-09-10T18:00:00Z",
  "artifact": {
    "filename": "mq-topology-host-....tar.gz",
    "sha256": "<64 hex>"
  },
  "result_sha256": "<64 hex>",
  "counts": {
    "observations": 8698,
    "coverage": 80,
    "findings": 14
  },
  "metadata": {}
}
```

The response returns an `evaluation_revision_id` and server chunk size.

### 4.2 Append collections

```text
POST /api/v2/operations/evaluations/{id}/observations
POST /api/v2/operations/evaluations/{id}/coverage
POST /api/v2/operations/evaluations/{id}/findings
```

Each request is:

```json
{
  "start": 0,
  "items": []
}
```

The API validates the frozen Phase 2A semantics, including canonical IDs, confidence, evidence references, coverage states, and observation source identity.

### 4.3 Activate

`POST /api/v2/operations/evaluations/{id}/activate`

Activation requires exact collection counts. It atomically supersedes the prior current revision for that source and activates the staged revision. Out-of-order activation is rejected.

### 4.4 Publisher

`scripts/publish-findings-evaluation.mjs` publishes a local Phase 2A evaluator JSON. It computes the result SHA-256 from the exact JSON bytes, requires an explicit environment, uploads bounded chunks, and activates only after all collections have been accepted.

It does not connect to IBM MQ and does not introduce an external monitoring dependency.

## 5. Read API

### 5.1 Operational status

`GET /api/v2/operations/status`

Returns database readiness plus counts of current sources, observations, findings, and raw coverage gaps.

### 5.2 Current observations

`GET /api/v2/operations/current/observations`

Filters:

```text
entity_id
observation_type
source_id
limit
offset
```

This endpoint is the Phase 2C basis for Object Detail `Monitor` views.

### 5.3 Current coverage

`GET /api/v2/operations/current/coverage`

Filters:

```text
scope_type
scope_key
observation_family
state
source_id
limit
offset
```

This endpoint is the Phase 2C basis for explicit evidence/observability-gap treatment.

### 5.4 Current findings

`GET /api/v2/findings/current`

Filters:

```text
severity
status
semantic_type
entity_id
rule_id
q
limit
offset
```

Stable duplicate occurrences from multiple current sources are presented as one finding keyed by `finding_id`, with `current_occurrence_count` and representative-source context. This avoids turning multi-source evidence into duplicate operator work.

### 5.5 Finding detail

`GET /api/v2/findings/current/{finding_id}`

Returns the representative current finding, current per-source occurrences/evidence, and lifecycle history.

### 5.6 Lifecycle transition

`POST /api/v2/findings/{finding_id}/lifecycle`

Example:

```json
{
  "status": "ACKNOWLEDGED",
  "note": "Investigating consumer deployment"
}
```

Lifecycle mutations require administrative authorization and only apply to a finding that is present in the current operational view.

## 6. Lifecycle semantics

The evaluator does not decide operator workflow state. Phase 2B therefore overlays durable state on current evaluator occurrences.

```text
new positive evidence                 → OPEN
operator acknowledgement              → ACKNOWLEDGED
operator resolution                   → RESOLVED
finding absent in later evaluation    → no automatic transition
newer positive evidence after resolve → OPEN (reopened)
newer positive evidence after ack     → remains ACKNOWLEDGED
```

This protects APR-015/APR-024 semantics: absence caused by a collection failure must not look like recovery.

## 7. Failure and trust boundaries

Phase 2B explicitly rejects or isolates:

- duplicate evaluation imports;
- mismatched expected/actual collection counts;
- observation source IDs that do not match the evaluation source;
- malformed canonical entity/finding IDs;
- invalid severity, confidence, freshness, or coverage values;
- evaluator-supplied ACKNOWLEDGED/RESOLVED lifecycle state;
- stale/equal operational evaluations replacing a newer current source revision.

A staged revision is not visible through current read APIs until successful activation.

## 8. Phase 2B acceptance criteria

The slice is accepted when:

- additive migration applies to an empty/local D1 database;
- Worker type-check passes;
- staged observations, coverage, and findings can be imported in chunks;
- count mismatch prevents activation;
- activation exposes one coherent current revision per source;
- a newer current evaluation supersedes the old source revision;
- stale/equal evaluation activation is rejected;
- current finding/observation/coverage reads work with filters and pagination;
- acknowledgement and resolution survive evaluation replacement;
- a resolved finding reopens only on newer positive evidence;
- finding absence does not auto-resolve state;
- exact evidence refs remain readable from finding occurrences;
- no external monitoring runtime or MQ mutation is introduced;
- automated CI passes.

## 9. Successor boundary

Once Phase 2B is proven, Phase 2C may project this state into:

```text
Overview → Requires attention
Object Detail → Findings
Object Detail → Monitor
Object Detail → Evidence / coverage
```

Phase 2C must consume these APIs rather than rebuilding health logic in the browser. Presentation remains downstream of evidence and derived claims.
