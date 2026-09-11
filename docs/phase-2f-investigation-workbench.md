# Phase 2F — Investigation Workbench

## Goal

Make an operational finding navigable from Overview directly into a full object investigation workspace, without routing the operator through Objects search or a narrow side inspector.

The canonical object workspace remains the single detail surface. Phase 2F promotes it into the operational investigation destination instead of creating a second detail system.

## Investigation contract

The primary path is:

`Overview affected object → Object Investigation Workspace → Findings → Monitor → Evidence`

For an IBM MQ queue with current findings, the workspace presents:

- canonical identity, queue manager and evidence-backed source host context;
- unresolved evidence-linked findings attached to the canonical `entity_id`;
- persisted OSI operational observations, grouped by collector sample;
- queue depth, oldest-message age, input-process and output-process sequences when those observation types exist;
- exact evidence references and collection methods that support the observations/findings;
- canonical relationships, configuration and provenance as separate tabs.

## Queue monitor semantics

For queue observations produced by Findings v1, Monitor renders these existing observation types only:

- `mq.queue.depth.current`
- `mq.queue.message.age.oldest_seconds`
- `mq.queue.process.input_count`
- `mq.queue.process.output_count`

The five-sample table is ordered oldest to newest and keeps `sample_id`, `observed_at`, `evidence_ref`, and `collection_method` visible. The small trend projections are visualizations of persisted numeric observations; they do not add thresholds, SLAs, health states or causal claims.

## Findings semantics

Finding text, severity, lifecycle state, confidence, coverage state and evidence references remain evaluator-owned. The browser does not recompute Findings v1 rules.

When multiple findings affect one object, the Summary can present their existing summaries together and each Findings card links the other current findings on the same object as related context. This is correlation by canonical object identity, not a new causal rule.

## Evidence semantics

Evidence is grouped by collector sample before raw references are shown. Operational observation references, finding evidence references and matching queue-manager coverage records are projected together where available.

Canonical provenance remains separately visible so an operator can distinguish:

1. why the object exists canonically;
2. what runtime observations were persisted;
3. what evaluator findings were derived from those observations.

## Navigation

`window.osiOpenObjectWorkspace` remains the canonical launcher. Phase 2F wraps it after product-shell initialization so Overview findings and existing workspace launchers converge on the same full-screen investigation surface. A workspace observer also enhances launches performed by product-shell's internal handlers.

The legacy Objects side inspector remains available for browse-oriented inspection, but it is no longer the required hop from an operational finding.

## Boundaries

Phase 2F introduces no:

- MQ configuration changes;
- collector changes;
- new evaluator rules;
- alert thresholds or business SLA assumptions;
- external monitoring integrations;
- automatic remediation.

It is a read-only UI projection over the existing canonical estate and Phase 2B operational APIs.