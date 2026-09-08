# MW-Dashboard target product architecture — vNext

Status: target architecture

This document defines the unconstrained target architecture for MW-Dashboard. Existing implementation choices are retained only when they remain the strongest choice for the product.

## 1. Product objective

MW-Dashboard is a middleware operational intelligence platform, not an object-count dashboard and not a generic graph viewer.

It should answer, with evidence:

- What exists?
- Where does it run now, and where can it run after failover?
- What owns it logically?
- Which applications are connected and through what middleware path?
- What route is configured from source to destination?
- Which parts of the route are supported by runtime evidence?
- Which facts are configured, observed, inferred, or operator-declared?
- What is unresolved, ambiguous, stale, or contradictory?
- What changed between two points in time?
- What depends on an object, and what is affected if it fails?
- Why does the system believe an answer?

The product must prefer explicit uncertainty over invented completeness.

## 2. Non-negotiable principles

1. Private infrastructure owns privileged discovery.
2. Collectors remain read-only and do not consume message payloads.
3. Logical identity, runtime instance, physical placement, and network endpoint are separate concepts.
4. Endpoint identity is not physical-host identity.
5. A logical queue manager is not duplicated by HA placement.
6. Application, application instance, MQ connection, and MQ object handle are separate concepts.
7. Runtime access evidence is not the same as proof that a message operation occurred.
8. Every material topology claim must be explainable through one or more evidence assertions.
9. Missing evidence is represented explicitly, not guessed away.
10. Source failures or partial collection must not delete known-good topology.
11. The authoritative model is vendor-neutral but preserves vendor-specific semantics where they matter.
12. Routes are semantic resolutions, not generic shortest paths.
13. AI consumes deterministic semantic tools; it does not infer the estate from a raw graph dump.

## 3. Critical semantic correction to current MQ v2

The current MQ normalizer creates `PUTS_TO` when a queue handle reports `OUTPUT(YES)` and `GETS_FROM` when it reports input access.

Those MQ fields indicate that the application has the queue open with output/input access. They do not prove that an MQPUT or MQGET occurred during the sample.

vNext therefore separates:

- `runtime.opens_for_output`: runtime handle has output access
- `runtime.opens_for_input`: runtime handle has input access
- `activity.put_observed`: a real put operation is supported by an activity/accounting/trace source
- `activity.get_observed`: a real get operation is supported by an activity/accounting/trace source

Queue-level `LPUTDATE/LPUTTIME` or `LGETDATE/LGETTIME` may prove recent queue activity, but they do not by themselves identify the actor that performed it.

The UI must describe the current collector evidence as runtime queue access, not as a proven end-to-end message traversal.

## 4. Target architecture

```text
Private middleware estate
  |
  +-- IBM MQ collector
  +-- ACE collector
  +-- DataPower collector
  +-- File-transfer collector
  |
  v
Immutable collection artifacts / normalized observation bundles
  |
  v
Ingestion API
  |
  +-- schema validation
  +-- source-run validation
  +-- coverage manifest validation
  +-- artifact persistence
  |
  v
Observation store
  |
  v
Identity + correlation engine
  |
  +-- canonical identity resolution
  +-- alias resolution
  +-- conflict detection
  +-- unresolved-reference management
  |
  v
Semantic assertion engine
  |
  +-- canonical entities
  +-- canonical relations
  +-- independent evidence assertions
  +-- temporal validity
  +-- source freshness
  |
  v
Current graph materializer + topology revisions
  |
  +-- entity service
  +-- graph service
  +-- route resolver
  +-- impact engine
  +-- diff/change engine
  +-- search service
  +-- evidence/data-quality service
  |
  v
Operations API
  |
  +-- Web application
  +-- CLI
  +-- MCP / AI tools
```

## 5. Storage architecture

### Authoritative database: PostgreSQL

PostgreSQL becomes the authoritative operational store.

It owns:

- collection/source metadata
- canonical identities
- aliases
- entity observations
- canonical entities
- relation assertions
- canonical relations
- topology revisions
- unresolved references
- data-quality findings
- route cache/materializations where useful
- audit records

Use typed relational columns for keys, timestamps and high-value filters, and JSONB for vendor-specific attributes.

Use explicit indexes for:

- entity type / environment / logical key
- relation source / target / type
- active assertion windows
- source run / observation time
- JSONB attributes required by inventory/search
- full-text/trigram search fields

Graph traversals use indexed adjacency queries and recursive SQL for bounded topology operations. The application route engine remains domain-aware rather than delegating middleware semantics to a generic shortest-path query.

### Optional GraphStore provider

Define a graph-query provider interface, but keep PostgreSQL as the initial and authoritative implementation.

A Neo4j projection/provider can be added later only if representative benchmarks show a meaningful operational advantage for large impact-analysis or exploratory graph workloads. A projection must remain rebuildable from the authoritative assertion store.

### Evidence store

Raw archives and large immutable evidence documents belong in S3-compatible object storage:

- Cloudflare R2 when available
- S3-compatible managed storage
- MinIO for private/self-hosted deployment

The existing D1 chunk adapter remains a compatibility path only, not the target evidence architecture.

### Cloudflare

Cloudflare can remain the edge delivery/authentication layer:

- static application hosting
- Access / OIDC enforcement
- Worker BFF/API gateway
- request shaping and caching
- Hyperdrive to PostgreSQL when appropriate

Business topology logic moves out of one monolithic Worker.

## 6. Canonical model layers

vNext deliberately separates four layers.

### Layer A — Artifact

Immutable raw evidence from one collection run.

Examples:

- MQ archive
- ACE export
- DataPower configuration/status bundle
- FTP inventory bundle

### Layer B — Observation

A source-scoped typed fact extracted from an artifact.

An observation says what one source reported at one time. It does not itself decide global identity.

Examples:

- queue manager `SVHUB01P` with QMID X was observed RUNNING on host Y
- queue `A.B.C` is defined on QMID X
- application tag `DataFlowEngine` has a queue handle open with output access
- sender channel `TO.SVESB01P` has CONNAME Z

### Layer C — Canonical entity/relation

The reconciled operational identity used by the product.

Examples:

- one canonical queue manager independent of local/remote observation
- one canonical host with multiple hostname/IP aliases
- one canonical queue scoped to its owning QM
- one semantic relation supported by one or more assertions

### Layer D — Projection

Derived read models:

- current estate
- historical topology revision
- host view
- middleware view
- route plan
- impact graph
- inventory page
- data-quality queue

UI-specific projections never become the canonical truth model.

## 7. Evidence assertion model

A canonical relation and the evidence supporting it are not the same record.

Conceptually:

```text
Canonical relation
  source = entity A
  type   = relationship R
  target = entity B

  <- assertion 1: configured, source run X, evidence file A
  <- assertion 2: runtime observed, source run Y, evidence file B
  <- assertion 3: deterministic derivation, rule Z
```

Recommended evidence fields:

```text
assertion_id
entity_or_relation_id
source_run_id
evidence_class
observed_at
ingested_at
valid_from
valid_to
evidence_ref
derivation_method
confidence
properties
```

Evidence classes:

- `observed` — direct runtime evidence
- `configured` — authoritative platform configuration
- `declared` — operator/CMDB/manual authoritative mapping
- `inferred` — a derived relationship

For inferred assertions, distinguish:

- deterministic inference
- heuristic inference

Confidence is meaningful primarily for heuristic inference; direct authoritative observations should not be reduced to arbitrary confidence percentages.

## 8. Source coverage and absence semantics

Every source run declares its coverage.

Example:

```text
source: sjeditb18703
queue-manager: SVHUB01P
coverage:
  queue definitions: complete
  channel definitions: complete
  listener definitions: complete
  connection status: point-in-time sampled
  queue handles: point-in-time sampled
```

This is required to distinguish:

- object is absent
- object was not collected
- command failed
- runtime object was simply not active during the sample

A missing object may only close an existing assertion when the source explicitly claims complete coverage for that object class.

## 9. Canonical entity catalogue

### Core / infrastructure

- `infra.host`
- `infra.network_endpoint`
- `infra.availability_group`
- `app.application`
- `app.application_instance`

### IBM MQ

- `mq.installation`
- `mq.queue_manager`
- `mq.queue_manager_instance`
- `mq.cluster`
- `mq.queue`
- `mq.channel`
- `mq.listener`
- `mq.connection`
- `mq.object_handle`
- `mq.topic`
- `mq.subscription`
- `mq.process_definition`
- `mq.runtime_process`
- `mq.namelist`
- `mq.service`

Not every entity type needs to be shown by default. First-class modeling and default UX visibility are separate decisions.

### IBM ACE

- `ace.integration_node`
- `ace.integration_server`
- `ace.message_flow`
- `ace.flow_endpoint`

A flow endpoint represents operationally relevant inputs/outputs such as MQInput, MQOutput, HTTP, file, and related connectivity without forcing the dashboard to model every internal flow node initially.

### IBM DataPower

- `datapower.appliance`
- `datapower.domain`
- `datapower.service`
- `datapower.frontend_endpoint`
- `datapower.backend_endpoint`

### File transfer

- `filetransfer.server`
- `filetransfer.endpoint`
- `filetransfer.flow`

## 10. HA / placement model

Logical ownership and runtime placement are separate.

For IBM MQ Multi-Instance:

```text
mq.queue_manager
  -> has_instance -> mq.queue_manager_instance @ host A (active)
  -> has_instance -> mq.queue_manager_instance @ host B (standby)
```

Queues, channels and listeners belong to the logical queue manager.

A failover changes the active instance/placement assertion. It does not duplicate or relocate the logical queue definitions.

For active-active architectures composed of distinct logical components, model the components separately and relate them through `infra.availability_group` rather than pretending they are two instances of one object.

The same availability-group mechanism can describe ACE/DataPower active-active service groups.

## 11. Identity strategy

Identity is type-specific and resolved centrally.

The generic formula `type + environment + scope + name` must not be the authoritative production identity rule for every entity type.

Examples of stronger identity hints:

- host: machine identity + alias set; hostname/IP are aliases when evidence supports it
- queue manager: QMID when available, with name as a scoped operational alias
- queue: canonical owning QM + queue name
- channel: canonical owning QM + channel name
- listener: canonical owning QM + listener name
- runtime connection: full MQ connection identifier + owning QM
- application instance: canonical host/workload identity + application identity
- logical application: explicit mapping/correlation rules across instances

The reconciliation layer keeps aliases and identity evidence so merges and splits are explainable and reversible.

## 12. Semantic registry

The allowed entity and relationship vocabulary is machine-readable and versioned.

A registry definition includes:

```text
entity type
namespace/domain
identity strategy
required properties
search/display properties
sensitive properties
allowed source/target relationship types
route significance
lifecycle policy
```

A relationship definition includes:

```text
relationship type
allowed source kinds
allowed target kinds
direction
semantic class
allowed evidence classes
inverse display label
route role
```

The registry generates validation contracts and TypeScript/Go API types where practical.

## 13. Relationship semantics

Prefer exact relationships over visually convenient relationships.

Core classes include:

- ownership / containment
- instance-of
- runtime placement
- network endpoint binding
- runtime connection
- runtime object access
- configuration resolution
- transport routing
- integration consumption/production
- service dependency
- availability-group membership

Examples:

```text
mq.queue_manager -> contains -> mq.queue
mq.queue_manager -> has_instance -> mq.queue_manager_instance
mq.queue_manager_instance -> runs_on -> infra.host
mq.listener -> listens_on -> infra.network_endpoint
app.application_instance -> connects_via -> mq.channel
app.application_instance -> runtime.opens_for_output -> mq.queue
app.application_instance -> runtime.opens_for_input -> mq.queue
mq.queue(QREMOTE) -> routing.resolves_to -> mq.queue/reference
mq.queue(QREMOTE) -> routing.routes_via -> mq.queue(XMITQ)
mq.queue(XMITQ) -> routing.transmits_via -> mq.channel
mq.channel -> network.connects_to -> mq.queue_manager / endpoint
ace.message_flow -> integration.consumes_from -> mq.queue
ace.message_flow -> integration.produces_to -> mq.queue
datapower.service -> integration.routes_to -> mq.queue / ace endpoint
```

## 14. Unresolved references are first-class

Do not create fake entities merely to satisfy a non-dangling-edge constraint.

An unresolved reference records:

```text
reference_id
source_entity
relationship_intent
vendor reference value
expected target type
resolution_state
resolution_reason
candidate targets
source evidence
```

Resolution states:

- resolved
- unresolved
- ambiguous
- dynamic
- stale
- conflicted

This lets the product explain exactly what is missing.

## 15. Topology revisions and time

The global topology is no longer a single whole-document snapshot uploaded by one collector.

Each collection run is independently immutable and atomic.

The current estate is a materialized view composed from the latest valid assertions from all sources.

The system also emits immutable topology revisions when the canonical graph changes materially.

This supports:

- current state
- time travel
- topology diff
- object creation/deletion
- route change detection
- host/HA placement changes
- evidence changes
- conflict history

Important timestamps remain distinct:

- event/observation time
- ingestion time
- assertion valid-from / valid-to

## 16. Route engine

Routes are resolved on the server by a domain-aware route engine.

The route engine does not use generic shortest path as the definition of message routing.

A route result contains:

```text
source
destination
semantic delivery segments
nested transport segments
alternatives/candidates
resolution status
evidence assertions per segment
runtime-support status
configured-reachability status
unresolved references
staleness
explanation
```

### MQ resolution

MQ rules include:

- application-instance connection through SVRCONN
- queue-handle output/input access
- QALIAS resolution
- QREMOTE RNAME/RQMNAME resolution
- explicit/default XMITQ resolution
- queue-manager aliases and multi-hop routing
- XMITQ to SDR/CLUSSDR relationship
- sender/receiver/peer resolution
- cluster candidate/dynamic routing
- topics/subscriptions
- destination queue ownership

### Cross-platform resolution

ACE and DataPower extend the same route plan:

```text
External client
 -> DataPower service
 -> MQ external queue
 -> ACE flow
 -> MQ internal queue
 -> destination application
```

### Route statuses

Avoid calling a route "observed" merely because queue handles exist.

Use explicit dimensions such as:

- configured reachability: yes/no/partial/dynamic
- runtime connectivity support: yes/no/partial/stale
- message activity evidence: yes/no/unknown
- physical placement resolution: complete/partial

The UI can derive a concise status from those dimensions without losing the underlying evidence.

## 17. Query/API surface

The browser no longer downloads the complete graph as its normal operating model.

Representative API:

```text
GET /v2/entities
GET /v2/entities/{id}
GET /v2/entities/{id}/neighbors
GET /v2/entities/{id}/evidence
GET /v2/entities/{id}/changes
GET /v2/search
GET /v2/hosts/{id}/estate
GET /v2/routes/resolve
GET /v2/impact/{id}
GET /v2/changes
GET /v2/data-quality
GET /v2/topology/subgraph
GET /v2/collection-runs
POST /v2/ingest
```

Every list endpoint is server-filtered, cursor-paginated and bounded.

## 18. Backend services

Use a modular core service, preferably Go, with explicit packages/modules for:

- ingest
- artifacts
- registry
- identity
- observations
- assertions
- graph
- routes
- impact
- diff
- search
- data quality
- API

These can initially deploy as one service. Module boundaries matter; microservices do not.

The Cloudflare Worker becomes a small edge/BFF layer rather than the semantic engine.

## 19. Frontend architecture

Move to a typed component application rather than continuing to layer increasingly large global browser modules over the original explorer.

Recommended stack:

- React + TypeScript
- Vite
- TanStack Router
- TanStack Query
- TanStack Table + virtualization for inventory
- React Flow for curated route/journey diagrams
- Sigma.js + Graphology for large exploratory topology views
- accessible headless UI primitives and a tokenized design system

Use different visualization engines for different jobs:

- tables for high-density inventory
- compact cards for summary/health
- React Flow for deterministic route explanations
- WebGL graph rendering only for broad topology exploration

Never render the full estate graph by default.

## 20. Product information architecture

Primary operator surfaces:

### Overview
Estate health, coverage, unresolved placement, recent changes, collection freshness.

### Explore
Universal inventory/search with lenses for hosts, middleware, applications and platform-specific objects.

### Routes
Source-to-destination route resolver with logical-delivery and technical-transport expansion.

### Impact
Reverse dependency / blast-radius analysis.

### Changes
Topology timeline and semantic diffs between revisions.

### Data Quality
Unresolved references, ambiguous identities, stale sources, conflicts and incomplete coverage.

### Collection / Administration
Collectors, source runs, evidence, import/push status and identity overrides.

Global search is available everywhere.

## 21. AI architecture

AI is a consumer of deterministic tools.

Expose tools such as:

- search_entities
- get_entity
- get_neighbors
- resolve_route
- explain_route
- get_impact
- diff_topology
- get_evidence
- get_unresolved
- get_collection_status

A question such as "Why can application A no longer reach B?" should execute deterministic resolution/diff/evidence operations first, then use the language model to explain the result.

Do not send the entire topology to the model and ask it to infer infrastructure truth.

## 22. Security

Production requirements:

- Cloudflare Access or equivalent OIDC authentication
- RBAC for viewer/operator/admin roles
- authenticated import/collector endpoints
- source registration
- signed collection bundles or mutually authenticated push
- immutable audit trail for imports, identity overrides and manual declarations
- sensitive-property classification in the semantic registry
- no secret/private-key collection
- configurable retention for evidence artifacts

## 23. Existing components — keep / replace

Keep because the concepts are strong:

- read-only private MQ collector
- archive safety checks
- logical-QM versus physical-placement separation
- endpoint-versus-host distinction
- application/process separation
- queue/channel QM scoping
- immutable evidence artifacts
- provenance discipline
- failed-import safety
- runtime sampling

Replace or substantially evolve:

- D1 as primary topology store -> PostgreSQL
- D1 evidence chunking as target -> S3-compatible object storage
- whole active topology document -> source-scoped observations + materialized current graph
- one canonical edge carrying merged evidence -> relation + assertion records
- generic fallback identity -> schema/type-specific central identity resolution
- `PUTS_TO`/`GETS_FROM` from handle access -> `opens_for_output`/`opens_for_input`
- client-side full graph indexes -> server-side semantic query APIs
- client-side BFS route resolution -> server-side route engine
- monolithic Worker topology logic -> edge/BFF + modular core service
- layered vanilla-JS UX architecture -> typed component application
- snapshot list as traceability only -> topology revision/change engine
- substring search over serialized metadata -> indexed semantic search

## 24. Implementation sequence

### Phase 0 — semantic correctness

- introduce vNext relationship semantics
- stop describing handle access as proven PUT/GET activity
- define semantic registry
- define observation/assertion contracts

### Phase 1 — authoritative core

- PostgreSQL schema
- Go core service
- object-storage evidence provider
- source-run ingestion
- compatibility adapter that accepts current normalized topology documents

### Phase 2 — MQ multi-source reconciliation

- ingest remaining MQ archives independently
- centralize canonical identity
- resolve duplicate local/remote QMs
- model queue-manager instances and HA placement
- expose unresolved/ambiguous identity findings

### Phase 3 — route engine

- implement MQ resolution rules server-side
- return evidence-rich route plans
- validate known routes against real estate data

### Phase 4 — new operations UI

- React/TypeScript application
- server-side Explore/Inventory
- Routes workbench
- Impact
- Changes
- Data Quality

### Phase 5 — additional middleware

- ACE collector/normalizer + flow endpoint correlation
- DataPower collector/normalizer + frontend/backend route correlation
- file-transfer collector/normalizer

### Phase 6 — AI operations

- semantic tool gateway / MCP
- evidence-backed natural-language investigation

## 25. Success criteria

The architecture is successful when the product can answer these without client-side graph reconstruction or topology guessing:

- Which logical object owns this queue/channel/service?
- Which physical instance is active now and what are its failover alternatives?
- Which application instances currently have this queue open for output/input?
- Is there evidence of actual message activity, or only runtime access/configuration?
- What exact configured route connects source and destination?
- Which route segments are runtime-supported right now?
- Where does resolution become ambiguous or incomplete, and why?
- What changed since the last healthy topology revision?
- What is the blast radius of a host/QM/channel/queue/ACE-flow failure?
- Which source file/run supports every important statement shown to the operator?

That is the target product quality bar.
