# OSI Operator Read Model — Thin Public Application Layer

## Objective

The primary operator experience must be a projection of server-side operational meaning, not a browser-side semantic engine. The public application layer is responsible for rendering, navigation, progressive disclosure, light interaction state, and browser-session working notes. Canonical identity, route qualification, evidence classification, unknown-state preservation, finding aggregation, and collection interpretation remain server-side concerns.

The target flow is:

**Evidence → Canonical estate → Derived operational model → Operator read API → Thin public UI**

This replaces the previous pattern in which the browser fetched several generic APIs and then reconstructed operator meaning itself.

## Operator read endpoints

The read-only operator contract is exposed under `/api/v2/operator/`:

- `GET /api/v2/operator/overview`
- `GET /api/v2/operator/paths`
- `GET /api/v2/operator/explore`
- `GET /api/v2/operator/explore/{entity_id}`
- `GET /api/v2/operator/investigations`
- `GET /api/v2/operator/investigations/{finding_id}`
- `GET /api/v2/operator/collection`

These endpoints compose existing canonical/domain handlers where possible. They do not introduce another source of truth and they do not add mutation capability.

## Semantic ownership

The server-side operator read model owns the task-specific projection needed by the five operator workspaces:

- **Operations**: operational publication state, ranked attention, qualified affected paths, and bounded knowledge limitations.
- **Paths**: route qualification, current runtime-boundary assessment, transfer outcome as an orthogonal claim, path-scoped unresolved mappings, and evidence-stage presentation data.
- **Explore**: bounded canonical search, semantic-type facets, canonical entity detail, relationship counts, and evidence/source counts.
- **Investigations**: a correctly paginated combined OPEN + ACKNOWLEDGED current-finding queue, focused finding detail, related findings, and bounded qualified-path context.
- **Collection**: source count, canonical freshness, operational publication boundary, telemetry mode, domain volume rollup, and interpretation boundaries.

The browser no longer decides whether an unobserved estate is healthy, derives route qualification from generic relations, merges independently paginated finding-status lists, computes evidence-domain rollups, or matches investigation path context from a client-side route cache.

## Public layer responsibilities

`public/operator-experience.js` is limited to presentation concerns:

- DOM rendering and responsive disclosure;
- navigation and selected item/filter/tab state;
- escaping and human-readable formatting;
- browser-session-only investigation checklist and notes;
- explicit requests for bounded operator read models;
- optional progressive disclosure into retained forensic/engineering views.

`public/task-first-shell.js` is structural only. It owns the five-item primary navigation, canonical-search affordance, and the investigation panel container. It does not fetch operational data or derive operator meaning.

`public/shell.js` keeps the primary operator path small. Only the product shell, task-first structural shell, and operator renderer are eager modules. Older forensic, route-trace, collection-history, and administration modules are lazy-loaded only after an explicit operator action requests those deeper tools.

Session-local notes and checklist state are not persisted as incident/case data and do not mutate canonical or operational state.

## Evidence and epistemic boundaries

This architecture does not change OSI's evidence contract.

- Missing operational sources produce **Unknown**, not zero/healthy.
- A qualified route is a topology claim, not proof of a message or file transaction.
- Historical Site activity, current listener evidence, independently corroborated runtime connectivity, and transfer completion remain separate claims.
- Unresolved mappings remain unresolved and are scoped to the path when presented in a path workspace.
- Collection freshness means the current source set has been reconciled; it does not mean the middleware estate is healthy.
- Existing canonical IDs, source observations, evidence classes, and finding provenance remain authoritative.

## Compatibility boundary

Existing canonical, route, findings, collection, and administration APIs remain available for forensic and administrative workflows. Existing advanced route and collection-history views remain behind explicit progressive disclosure. The operator read model is additive and read-only.

The public-layer reduction is therefore both semantic and runtime: primary task screens consume bounded operator projections, while engineering-oriented modules are deferred until the operator deliberately asks for them. This keeps the everyday application path small without deleting the deeper forensic capabilities required for proof and administration.
