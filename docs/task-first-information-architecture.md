# Task-first information architecture

## Objective

Reduce operational information overload without reducing OSI's evidentiary depth.

The browser should expose the minimum information needed for the operator's current task, while preserving exact canonical identity, relationship provenance, evidence class, time scope, unresolved state, source lineage, and observation detail behind progressive disclosure.

The governing progression is:

**Orient -> Understand -> Investigate -> Prove**

This is a presentation hierarchy only. It does not change canonical state, findings derivation, route qualification, evidence semantics, or collection scope.

## Primary workspaces

The primary navigation is task-oriented:

- **Operations** — What needs my attention?
- **Paths** — How does this service, message, or file get from source to destination?
- **Explore** — What is this object and what is it connected to?
- **Investigations** — Which current evidence-linked problem should I focus on now?
- **Collection** — Can I trust the currency and coverage of the evidence I am using?

Physical servers, middleware-specific inventories, applications, collection history, and administration remain available as drill-down views. They are no longer required as primary wayfinding choices.

## Operations

Operational findings remain the first-class attention layer.

Estate-wide counts, physical placement summaries, queue-manager inventory, reconciliation counts, and unresolved-reference totals are retained under a collapsed **Estate context** disclosure. They remain available for governance and reconciliation work but no longer compete with operational attention on first load.

A compact task launcher directs the user toward a path, object search, or focused investigation.

## Paths

The existing service-path investigation remains the operational route model.

The UI continues to keep topology qualification, runtime evidence, historical activity, unresolved mappings, and transaction outcomes as separate claims. Presentation must not manufacture missing MFT/storage membership, runtime traversal, transfer completion, or health state.

## Explore

Explore remains canonical and search-first.

Specialized Servers, Middleware, and Applications views remain available behind a secondary disclosure rather than occupying primary navigation. Global search routes the user's query into canonical Explore instead of forcing browse-first navigation.

## Investigations

The first implementation is deliberately bounded.

The investigation queue is a projection of current evidence-linked Findings. Selecting a finding creates browser-session focus only; it does not create a persistent case, workflow record, or mutable incident object. The focused panel exposes only the finding context needed to choose the next inspection action and can pivot into the canonical object workspace for proof.

This avoids inventing a new control plane or persistence model while establishing the shared-inspection-context UX pattern.

## Collection

Collection begins with a compact trust summary derived from public status APIs:

- active semantic source count;
- current/stale canonical estate state;
- current operational evaluation count;
- explicit coverage-gap count;
- telemetry ingress mode.

Canonical unresolved references remain explicit in the interpretation note. Current source state and a fresh estate must never be presented as proof that unobserved runtime behavior is healthy.

Collection history and manual evidence import remain available below or through secondary actions.

## Visual salience rules

Operational significance determines visual prominence; data availability does not.

- High-salience color or badges are reserved for attention, uncertainty, contradiction, or actionable state.
- Ordinary current evidence should remain readable but visually quiet.
- Global estate counts are context, not default content.
- Unknown remains unknown, but unrelated unknowns should not occupy the operator's current working set.
- Cards are used for independent units of work; ranked rows, path lanes, grouped summaries, and disclosure are preferred for dense operational information.

## Acceptance boundary

This phase must not:

- change canonical topology or findings truth;
- turn missing evidence into healthy state;
- turn unresolved mapping into an incident automatically;
- infer transaction success from qualified topology;
- create persistent investigations or notes without an approved server-side model;
- infer MFT/storage path membership through display names or screen geometry;
- introduce synthetic traffic animation or liveness.

The success criterion is cognitive: a user should be able to identify what matters, choose one task, retain that context, and reach exact evidence without first interpreting the entire middleware estate.
