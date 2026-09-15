# OSI Operator Read Model — Thin Public Application Layer

## Objective

The primary operator experience must be a projection of server-side operational meaning, not a browser-side semantic engine. The public application layer is responsible for rendering, navigation, progressive disclosure, light interaction state, and browser-session working notes. Canonical identity, route qualification, evidence classification, unknown-state preservation, finding aggregation, operational-situation projection, and collection interpretation remain server-side concerns.

The target flow is:

**Evidence → Canonical estate → Derived operational model → Operator read API → Thin public UI**

This replaces the previous pattern in which the browser fetched several generic APIs and then reconstructed operator meaning itself.

## Operator read endpoints

The read-only operator contract is exposed under `/api/v2/operator/`:

- `GET /api/v2/operator/overview`
- `GET /api/v2/operator/paths`
- `GET /api/v2/operator/explore`
- `GET /api/v2/operator/explore/{entity_id}`
- `GET /api/v2/operator/situations`
- `GET /api/v2/operator/investigations`
- `GET /api/v2/operator/investigations/{finding_id}`
- `GET /api/v2/operator/collection`

These endpoints compose existing canonical/domain handlers where possible. They do not introduce another source of truth and they do not add mutation capability.

`/api/v2/operator/situations` is the primary operator queue. `/api/v2/operator/investigations` remains a finding-level compatibility/forensic projection so existing investigation and evidence workflows retain their exact finding identifiers.

## Semantic ownership

The server-side operator read model owns the task-specific projection needed by the five operator workspaces:

- **Operations**: operational publication state, ranked operational situations, qualified affected paths, and bounded knowledge limitations.
- **Paths**: route qualification, current runtime-boundary assessment, transfer outcome as an orthogonal claim, path-scoped unresolved mappings, and evidence-stage presentation data.
- **Explore**: search-first canonical discovery, semantic-type entry points, bounded search results, canonical entity detail, relationship counts, and evidence/source counts.
- **Investigations**: a correctly paginated operational-situation queue, focused finding detail, related findings on the same canonical object, and bounded qualified-path context.
- **Collection**: source count, canonical freshness, unresolved mappings, telemetry mode, domain volume rollup, and interpretation boundaries. Finding and observation volume remain secondary evidence context rather than primary trust indicators.

The browser no longer decides whether an unobserved estate is healthy, derives route qualification from generic relations, groups findings into operator situations, merges independently paginated finding-status lists, computes evidence-domain rollups, or matches investigation path context from a client-side route cache.

## Operational situation compression

An **Operational situation** is a derived presentation grouping used to reduce repeated operator rows. It is not a new canonical entity, incident, case, temporal episode, causal diagnosis, or service identity.

The current projection is deliberately conservative:

- active OPEN and ACKNOWLEDGED findings are first reduced to their latest current occurrence;
- findings are grouped by the existing canonical `entity_id` they are already anchored to;
- the situation severity is represented by the strongest current finding on that object;
- exact finding `rule_id` values are retained as mechanism buckets inside the situation rather than being collapsed into invented semantic categories;
- all individual `finding_id` values remain available and independently evidence-backed;
- a representative `focus_finding_id` is only a navigation anchor into the existing finding-detail workflow;
- grouping two findings on the same canonical object does not assert that they share a root cause, causal mechanism, episode, or transaction.

This means that two findings such as queue-depth growth and oldest-message aging may appear as one operator situation for the same queue while remaining two distinct operational claims underneath. The compression changes presentation and triage ergonomics; it does not change the evidence supporting either finding.

Situation ordering is severity first and then recency. Pagination operates on situations, not individual findings, so one noisy object cannot consume several adjacent rows in the primary operator queue.

## Explore entry mode

Explore is search-first rather than a default inventory browser. When no search term or semantic-type filter is supplied, the operator endpoint returns an entry projection containing estate size and preferred semantic-type entry points but no arbitrary first page of canonical entities.

The entity list is requested only after the operator narrows the task through search or a semantic type. This preserves the full canonical estate without forcing the operator to scan an essentially random slice of hundreds of objects.

## Public layer responsibilities

`public/operator-experience.js` is limited to presentation concerns:

- DOM rendering and responsive disclosure;
- navigation and selected item/filter/tab state;
- escaping and human-readable formatting;
- browser-session-only investigation checklist and notes;
- explicit requests for bounded operator read models;
- optional progressive disclosure into retained forensic/engineering views.

It renders server-projected situations and does not group raw findings itself.

`public/task-first-shell.js` owns the structural operator shell plus the shared inspection navigation context. Its responsibilities are limited to the five-item primary navigation, canonical-search affordance, investigation panel container, and session-scoped anchors for the finding, canonical entity, or path the operator is following. It does not fetch operational data, infer relationships, qualify routes, or derive operator meaning.

`public/shell.js` keeps the primary operator path small. Only the product shell, task-first structural shell, and operator renderer are eager modules. Older forensic, route-trace, collection-history, and administration modules are lazy-loaded only after an explicit operator action requests those deeper tools.

Session-local notes, checklist state, and shared inspection context are not persisted as incident/case data and do not mutate canonical or operational state.

## Shared inspection context

Operators should not have to reconstruct their mental context after every pivot. The task-first shell therefore carries a bounded browser-session inspection context across **Operations → Paths → Explore → Investigations → proof/evidence**.

The shared context may retain only navigation anchors already exposed by the rendered operator experience:

- current `finding_id` and its display label;
- current canonical `entity_id` and its display label;
- current path selection index/display label for restoring the path workspace within the same browser session.

Multiple anchors may coexist so that, for example, an operator can move from a finding to its canonical object and still return to the investigation. The most recently selected anchor is the primary focus shown in the shell.

This context is intentionally **not evidence**. It does not create a relationship between anchors, does not assert that a finding belongs to a path, does not convert a selected path into a transaction claim, and does not survive beyond browser-session storage. When an anchor is reopened, the destination workspace revalidates it against its normal read model.

The context bar therefore communicates: *what the operator is following*, not *what OSI has proven*.

## Evidence and epistemic boundaries

This architecture does not change OSI's evidence contract.

- Missing operational sources produce **Unknown**, not zero/healthy.
- An operational situation is only a grouped view of existing findings; it is not additional evidence.
- A qualified route is a topology claim, not proof of a message or file transaction.
- Historical Site activity, current listener evidence, independently corroborated runtime connectivity, and transfer completion remain separate claims.
- Unresolved mappings remain unresolved and are scoped to the path when presented in a path workspace.
- Collection freshness means the current source set has been reconciled; it does not mean the middleware estate is healthy.
- Existing canonical IDs, source observations, evidence classes, findings, and finding provenance remain authoritative.

## Compatibility boundary

Existing canonical, route, findings, collection, and administration APIs remain available for forensic and administrative workflows. Existing advanced route and collection-history views remain behind explicit progressive disclosure. The operator read model is additive and read-only.

The public-layer reduction is therefore both semantic and runtime: primary task screens consume bounded operator projections, while engineering-oriented modules are deferred until the operator deliberately asks for them. This keeps the everyday application path small without deleting the deeper forensic capabilities required for proof and administration.