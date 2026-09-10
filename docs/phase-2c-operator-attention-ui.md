# OSI Phase 2.0C — Operator Attention and Object Operational Intelligence

**Status:** IMPLEMENTED  
**Scope:** Browser projection of the Phase 2B operational persistence/API contract.

## Governing rule

The browser presents operational intelligence; it does not create it.

```text
qualified collector evidence
        ↓
offline evaluator
        ↓
OperationalObservation + Finding + CoverageState
        ↓
Phase 2B persistence/lifecycle/API
        ↓
Phase 2C operator UI
```

No queue threshold, health rule, causality rule, or recovery rule is evaluated in JavaScript. The UI reads only persisted OSI operational observations/findings/coverage and preserves the distinction between severity, confidence, lifecycle status, and evidence coverage.

## Overview — Requires attention

Overview now begins with **What requires attention?** rather than inventory counts. The section reads:

- `/api/v2/operations/status`
- `/api/v2/findings/current`

It prioritizes unresolved `OPEN` and `ACKNOWLEDGED` findings by severity and recency. Acknowledged findings remain visible because acknowledgement is not resolution.

If no current operational evaluation exists, the UI explicitly reports **Operational status is unknown**. Zero imported findings are not rendered as a green health state.

Coverage gaps are displayed separately from health findings. `partial`, `failed`, and `not_collected` evidence remain collection-quality facts and are never translated into object failure or object health.

Finding cards retain canonical `entity_id` linkage. Selecting a finding opens the existing Universal Object Detail workspace for that canonical entity.

## Universal Object Detail

Canonical Object Detail receives an **Operational intelligence** section with three projections.

### Findings

Reads `/api/v2/findings/current?entity_id=...` and shows:

- severity;
- durable lifecycle status;
- rule ID;
- summary and diagnosis;
- confidence;
- coverage state;
- first/last seen;
- exact evidence references.

No browser-side rule evaluation is performed.

### Monitor

Reads `/api/v2/operations/current/observations?entity_id=...` and groups stored observations by OSI `observation_type`.

The projection shows the latest value, sample count, recent sequence, source queue manager/host, and numerical range where the stored values are numeric. These are direct observation summaries, not thresholds, alerts, or diagnoses.

### Evidence

Combines exact evidence references already attached to findings and observations with the matching queue-manager coverage records from `/api/v2/operations/current/coverage` when the queue-manager scope can be established from the persisted operational data.

This makes the operational claim inspectable without copying raw collector archives into the browser contract.

## Refresh behavior

The view refreshes on navigation, object selection, Object Detail state changes, and once per minute while the page is visible. In-flight reads are aborted when superseded so stale responses do not overwrite a newer object selection.

## Explicit boundaries

Phase 2C does not add Prometheus, Grafana, OpenTelemetry, Instana, Dynatrace, Zabbix, an exporter, an agent, a scraper, a third-party metric namespace, direct MQ connectivity, MQ mutation, event-queue consumption, state resets, browser-side alert rules, arbitrary queue-depth thresholds, business SLAs, automatic remediation, or route/blast-radius health inference.

The next product step should use this entity-level operational foundation to enrich Queue Managers and Routes only after sufficient current evidence has been published for the relevant sources.
