# Phase 2D — Evidence freshness and observability semantics

Status: implementation slice

## Purpose

Phase 2D prevents the UI from conflating the latest published operational evaluation with live middleware state. OSI must expose the age and provenance of persisted operational evidence while keeping collection failure, diagnostic capability limitations, finding severity, and canonical topology gaps as separate dimensions.

## Semantics

### Canonical current state

The canonical estate remains the latest accepted/reconciled topology revision. Its `current` label refers to revision activation, not to live runtime health.

### Latest published operational evaluation

Operational findings are projections from the latest activated evaluation for each operational source. `Current` in the persistence model means selected/active revision. UI copy uses **latest published operational source/evaluation** so that revision selection is not mistaken for real-time freshness.

### Evidence age

The Overview reports the age of the newest persisted operational observation and the evaluator timestamp when available. Age is calculated from stored evidence timestamps only.

Phase 2D intentionally does **not** classify evidence as current, aging, or stale because no estate freshness SLA has been authorized yet. The UI states this explicitly: **Age is factual; no freshness SLA is assumed.** A future observer cadence or an explicitly configured operational policy may add such classification.

### Collection gaps

Collection gaps are persisted coverage records whose state is `partial`, `failed`, or `not_collected`. They describe evidence acquisition quality and are not health findings.

### Observability limitations

Observability limitations are current unresolved informational findings in the `mq.observability.*` rule namespace. They describe diagnostic dimensions that are unavailable even though collection itself may have succeeded. `mq.observability.channel_timing_unavailable.v1` is the first such rule.

Collection gaps and observability limitations therefore remain separate. A successful sample can have zero collection gaps while still proving that channel timing is unavailable because MQ channel monitoring is disabled.

### Canonical evidence gaps

The canonical Overview KPI previously labelled `Unresolved` is presented as **Evidence gaps**. It represents unresolved references or missing evidence and must not be read as unresolved canonical identity. Identity ambiguity/conflict remains reported separately by canonical reconciliation.

## UI projection

The Operational Findings section keeps severity/lifecycle summary cards separate from an evidence-state strip containing:

- Latest evidence age and evaluation timestamp
- Collection gaps
- Observability limitations

Visible observability findings receive a distinct `Observability limitation` badge while preserving their original severity, confidence, lifecycle state, rule ID, and evidence references.

## Constraints

Phase 2D introduces no MQ configuration changes, polling, thresholds, external monitoring systems, or browser-side diagnostic rules. It consumes existing OSI read APIs only. The `mq.observability.*` namespace is treated as evaluator-owned semantics, not inferred from text in the browser.
