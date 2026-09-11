# Phase 2H — Topology-Aware Impact & Route Correlation

## Purpose

Phase 2H connects the operational investigation workspace to the canonical delivery graph without turning adjacency, runtime access, cluster visibility, or configured routing into stronger claims than the evidence supports.

The operator question is:

> This object has an operational finding. What delivery context is established around it, what continuation can OSI support, and where does the evidence stop?

## Semantic boundaries

Phase 2H preserves the following distinctions:

- `activity.put_observed` / `activity.get_observed` are observed message activity.
- `runtime.opens_for_output` / `runtime.opens_for_input` prove queue access mode, not an MQPUT or MQGET operation.
- `integration.produces_to` / `integration.consumes_from` and `routing.resolves_to` are configured/integration delivery semantics.
- `routing.routes_via`, `routing.transmits_via`, and `network.connects_to` describe MQ transport context.
- structural relations such as ownership, containment, cluster membership, and cluster discovery are context only; they are not message-path proof.
- cluster discovery does not prove that a message traversed a discovered queue manager.
- absence of a downstream relation does not prove disconnection.
- application/service impact is not established merely because a queue has a finding.

## API

`GET /api/v2/routes/impact?entity_id=<canonical-id>` returns `osi.route.impact/v1` for the current canonical estate.

The response separates:

- `upstream`: delivery-facing entities supported on the incoming side of the investigated object;
- `downstream`: delivery-facing entities supported on the outgoing side;
- `transport`: explicit MQ transport expansion, where configured;
- `context`: structural/ownership/cluster relations;
- `unresolved`: unresolved canonical evidence attached to the object;
- `trace_candidates`: endpoint pairs that may be submitted to the existing canonical route tracer. A candidate is not itself a proven route.

## Investigation workspace

Phase 2H adds an **Impact** tab after Monitor. The view is evidence-bounded and shows:

1. a route-coverage statement;
2. upstream access/producer context;
3. the investigated canonical object;
4. downstream consumer/resolution context;
5. transport expansion when available;
6. structural context separately from delivery semantics;
7. unresolved evidence and explicit semantic cautions;
8. on-demand trace verification for eligible upstream/downstream pairs using the existing `/api/v2/routes/trace` contract.

## Non-goals

Phase 2H does not add:

- business impact inference;
- blast-radius scoring;
- active route tracing or diagnostic messages;
- new MQ collection;
- Prometheus, Grafana, OpenTelemetry, or another monitoring backend;
- browser-side health rules;
- queue-depth thresholds;
- application-outage claims;
- cluster-path inference.

Future phases may add stronger impact analysis only when additional canonical and runtime evidence supports it.
