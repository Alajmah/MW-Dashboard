# Phase 2O — Demo Manual OSI Evidence Mode

## Decision

During the demonstration phase, MW Dashboard does not require or assume a direct network connection to IBM MQ or other middleware platforms. Evidence arrives from OSI through controlled manual transfer and is published by an operator through Administration.

The demo delivery model is therefore:

`middleware environment → OSI collection/evaluation → transferred artifact → protected Administration import → canonical/operational D1 projections → investigation UI`

This is an intentional operating mode, not a degraded substitute for a missing live connection.

## Accepted demo artifacts

### Topology

The IBM MQ collector archive is selected in the topology ingestion workspace. Normalization remains browser-local. The raw `.tar.gz` archive is not uploaded; validated semantic source observations are published and then reconciled into the canonical estate.

### Operational intelligence

The Administration workspace accepts `osi.findings.evaluation/v1` JSON produced by the OSI evaluator. This artifact contains persisted runtime observations, collection coverage, and evidence-linked findings. Activating a new evaluation replaces the current operational revision for that source without replacing topology.

## Demo semantics

- "Current" topology means the latest activated canonical estate, not live middleware state.
- "Latest" operational evidence means the latest manually published OSI evaluation.
- Evidence age is always derived from stored evidence timestamps.
- No UI is allowed to infer connectivity, health, or freshness solely because an import occurred recently.
- Missing or old evidence remains visible as an evidence/freshness condition rather than being rewritten as a middleware failure.

## Direct telemetry

The authenticated continuous telemetry endpoint introduced in Phase 2N remains disabled for the demo. `TELEMETRY_INGEST_ENABLED` is not set and no production telemetry key registry is required for the demonstration.

Phase 2N is retained as future infrastructure. The demo does not depend on installing the observer as a service, outbound publishing, remote D1 cost qualification, or any Cloudflare-to-MQ connectivity.

## Administration UX

Phase 2O adds a Demo Delivery Policy panel to Administration. It shows:

- canonical estate readiness;
- current operational observation/finding counts;
- the selected delivery policy (`Manual OSI handoff`);
- direct telemetry ingress state;
- the evidence path from source environment through OSI transfer to investigation.

The status projection is read only and refreshes on demand or at most once per minute while the Administration view is used, avoiding unnecessary D1 read amplification.

## Demo runbook

1. Run the approved OSI collectors/evaluator in the source environment.
2. Transfer the generated artifacts through the approved manual mechanism.
3. Import the MQ topology archive and activate the source revision.
4. Reconcile the canonical estate when topology/source membership changed.
5. Publish the matching `osi.findings.evaluation/v1` operational evaluation.
6. Use Overview, Object Investigation, Findings, Monitor, Evidence, Relationships, Impact, and Routes against the stored evidence.
7. When evidence changes, repeat the relevant import. Do not represent the dashboard as continuously connected.

## Boundary

Phase 2O does not add a new ingestion API, D1 migration, MQ authority, monitoring consumer, telemetry service, or middleware connection. It changes the product operating contract for the demo and makes that contract explicit in the operator UI.
