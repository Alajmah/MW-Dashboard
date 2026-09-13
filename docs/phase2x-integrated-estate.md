# Phase 2X — Integrate qualified MQ + ACE + DataPower evidence into the canonical estate

Phase 2X moves the already-qualified cross-technology evidence into the existing semantic v2 / canonical-estate architecture. It does **not** add a parallel graph database and does not introduce another direct middleware connection.

## Why this fits the current architecture

The repository already has the required semantic types for ACE, DataPower, MQ, and file transfer. Phase 2X therefore projects the qualified evidence into `osi.observation.bundle/v2` and lets the existing source-revision + canonical-estate reconciliation pipeline do identity merging.

The public repository contains only a sanitized regression fixture generated at test time. Real middleware hostnames, addresses, queue names and evidence artifacts are intentionally not committed.

## Adapter

`scripts/normalize-integrated-evidence.mjs` consumes three local artifacts:

- integrated current estate graph;
- one qualified route document;
- evidence index.

It produces an Observation Bundle v2 with:

- current ACE integration nodes and physical placement;
- two DataPower appliances and the qualified service on each active-active node;
- MQ queue-manager / queue route anchors compatible with native MQ identity hints;
- `integration.routes_to` for the deterministic DataPower service → MQ queue route;
- configured and independently observed `network.connects_to` evidence from the DataPower backend to the MQ queue manager.

Historical episodes and historical claims are deliberately excluded from this current source projection.

## Epistemic preservation

The source database currently accepts the registry evidence classes `observed`, `configured`, `declared`, and `inferred`. A deterministic static-route projection therefore remains:

```text
evidence_class = configured
properties.epistemic = derived
properties.derivation_method = deterministic_static_route_projection
properties.deterministic = true
```

This prevents the route from being mislabeled as runtime-observed message traversal. Independent MQ connection evidence is stored separately as `observed` backend connectivity.

Runtime corroboration IDs are not trusted by reference alone. Each referenced edge must be current, `observed_client_connection`, epistemically `observed`, originate from a physical host with a DataPower runtime, and target the queue manager selected by the qualified route. Invalid corroboration fails normalization rather than creating a weaker or fabricated route.

Channel identity is also evidence-bounded. A canonical MQ channel is attached only when one corroborated channel name exists **and** the integrated graph contains a configured `uses_channel` relationship to that channel. Missing channel evidence remains unset; multiple corroborated names remain ambiguous rather than selecting an arbitrary channel.

## Route query behavior

`src/integrated-routes.ts` handles only a direct canonical `integration.routes_to` relationship. All other route traces fall through to the existing generic semantic route engine unchanged.

A qualified DataPower result returns:

- `mode = configured_semantic_path`;
- configured route evidence class;
- deterministic/derived route metadata;
- the evidence-qualified DataPower internal chain as relation properties;
- independent runtime corroboration metadata;
- an explicit warning that configuration/static analysis does not prove a specific message traversal.

## Publishing a private real bundle

Real integrated evidence stays outside Git. Generate it on a trusted workstation:

```bash
node scripts/normalize-integrated-evidence.mjs \
  --graph /secure/estate-graph.json \
  --route /secure/cm10-qualified-route.json \
  --evidence /secure/evidence-index.json \
  --source-id osi-integrated-mq-ace-datapower-20260913 \
  --environment prod \
  --output /secure/integrated-observation-bundle.json
```

Then publish and reconcile using the existing protected import APIs:

```bash
ADMIN_IMPORT_TOKEN='...' node scripts/publish-observation-bundle.mjs \
  --bundle /secure/integrated-observation-bundle.json \
  --base-url https://<dashboard-worker>/
```

The publish script stages and activates the source revision, reads the current source set, runs the existing canonical `estate-builder.js`, stages the new estate revision, and activates it only after the normal server-side consistency checks pass.

### Recovery if source activation succeeds but estate reconciliation fails

Source activation and canonical-estate activation are deliberately separate operations. A transient failure between them can make the previously active estate stale because the current source set has already changed.

Do **not** re-import or mutate middleware to recover. Reconcile the already-current source set directly:

```bash
ADMIN_IMPORT_TOKEN='...' node scripts/reconcile-current-estate.mjs \
  --base-url https://<dashboard-worker>/
```

The recovery helper reads only the current semantic source revisions and their current observations, rebuilds the canonical estate using the same registry and `estate-builder.js`, stages a fresh estate revision, and activates it through the normal server-side consistency checks. It creates no source revision and therefore does not collide with the deterministic source `run_id`.

## Acceptance criteria

1. Existing MQ canonical route regression remains unchanged.
2. A DataPower service is searchable as `datapower.service`.
3. DataPower service → MQ queue returns one `integration.routes_to` step.
4. The result is a configured semantic path, not observed activity.
5. `properties.epistemic` remains `derived`.
6. Runtime corroboration remains separate from the route evidence class and is validated before projection.
7. Missing channel evidence remains unset; no arbitrary MQ channel is synthesized.
8. No historical item is emitted into the current integrated source projection.
9. Real estate identifiers are not present in the committed CI fixture.
10. A stale canonical estate can be rebuilt from the already-current source set without creating another source revision.

FTP remains a later adapter against the same semantic contracts.
