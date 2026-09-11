# Phase 2E — Operational triage compression

Status: implementation slice

## Purpose

Phase 2E changes Overview from a finding-card inventory into an operator triage surface. Multiple findings that affect the same canonical entity are grouped under that object, while observability limitations remain separate from service-health findings.

## Operator model

Overview should answer three questions in one screenful:

1. Which canonical objects need attention?
2. Why do they need attention?
3. What evidence or collection action is needed next?

The implementation preserves all underlying findings and evidence. Compression is a presentation projection only.

## Finding compression

All unresolved OPEN and ACKNOWLEDGED findings are read from the existing Findings API.

- Non-observability findings are grouped by canonical `entity_id`.
- A canonical object appears once in the actionable list.
- Its individual findings remain visible as evidence-backed signal chips.
- The row preserves severity, lifecycle state, entity identity, and latest supporting-evidence time.
- Clicking the row opens the existing Universal Object Detail workflow.

This prevents two findings on one queue from being presented as two independent operator work items.

## Observability limitations

Rules in the `mq.observability.*` namespace are grouped by `rule_id` into a separate **Diagnostic limitations** section. The affected canonical objects remain individually navigable.

Observability limitations do not become health incidents simply because they are unresolved findings.

## Evidence chronology

The evidence strip is phrased as chronology rather than generic freshness:

- canonical topology: current revision;
- latest operational observation: factual age;
- evaluation: publication/evaluation age.

No browser-side current/aging/stale policy is introduced. Age remains factual and no freshness SLA is assumed.

## Canonical Overview compression

The full Queue Manager ledger is replaced on Overview by a compact placement rollup. The dedicated Queue Managers workspace remains the authoritative inventory view.

The Evidence gaps KPI explains its unresolved-reference composition, while physical-placement gaps remain a separate effect of missing host evidence.

When logical queue managers lack physical placement, the unresolved-evidence panel promotes the next evidence action: **Collect peer MQ hosts**, with a direct path to Collection.

## Readability

Phase 2E also removes the accidental visible screen-reader label in global search and raises small operational metadata text to a more readable working size.

## Constraints

Phase 2E adds no MQ collection, thresholds, rule changes, health inference, external monitoring integration, or persistence changes. It is a UI projection over existing OSI canonical and operational APIs.