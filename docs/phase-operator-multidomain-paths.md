# OSI Operator Paths — Multi-domain evidence-qualified projection

## Objective

The primary **Paths** workspace must answer one operator question: **how does this operational path get from the supported source context to the supported destination, and where does the evidence boundary change?**

The workspace therefore consumes existing canonical route claims across technologies instead of presenting a technology-specific dashboard. This phase adds qualified messaging paths beside the existing qualified file-transfer paths without introducing a business-service entity, a second graph, or a transaction model.

## Supported route shapes

The operator projection currently recognizes only two explicit canonical shapes:

1. **File transfer** — `filetransfer.flow → integration.routes_to → filetransfer.endpoint`, with `qualified_route=true` and `route_kind=eft_inbound_site_path`.
2. **Messaging** — `datapower.service → integration.routes_to → mq.queue`, with `qualified_route=true`.

Anything else remains outside this projection and continues through the existing forensic route tools. The projection never broadens an arbitrary `integration.routes_to` relation into an operator path.

## Messaging path grammar

A qualified DataPower-to-MQ path is presented as:

**DataPower service → Static route → MQ boundary → MQ queue**

These stages are presentation projections over evidence already retained on the canonical relation:

- **DataPower service** is configured canonical topology.
- **Static route** is a deterministic derivation from configured DataPower route evidence.
- **MQ boundary** is shown as corroborated only when independent runtime corroboration is already attached to the qualified route. The corroboration supports DataPower client connectivity to the selected queue manager; it does not prove a PUT, GET, or application transaction.
- **MQ queue** is the configured canonical route target. Reaching it in topology does not establish that a specific message traversed the path.

The operator-facing outcome is therefore **Message traversal not established**. This is not an error state and it is not converted into healthy, failed, or successful transaction status.

## File-transfer path grammar

The existing FTP path remains:

**Access context → DMZ listener → PNC boundary → EFT Site**

Historical Site-access evidence, current listener evidence, independently corroborated PNC connectivity, and transfer completion remain separate claims. A qualified topology route never upgrades `runtime_transfer_completion=false` into successful transfer evidence.

## Server-side ownership

`src/operator-path-domains.ts` is a bounded presentation adapter over the current canonical estate. It owns the multi-domain operator projection for:

- `GET /api/v2/operator/paths`;
- the `paths` summary embedded in `GET /api/v2/operator/overview`;
- qualified path context attached to an investigation detail when one of the finding's existing canonical references matches a supported path endpoint.

The existing `src/operator-read-model.ts` remains authoritative for all other operator projections. The adapter calls that read model for Operations and investigation detail, then replaces only the path slice with the multi-domain projection. This preserves the existing situation, finding, collection, and Explore contracts while the path model evolves incrementally.

## Epistemic boundary

The adapter does not create canonical state. It reads only the current reconciled estate and refuses to project a stale estate. Route-domain meaning comes from the existing typed endpoints and qualified relation properties.

For messaging:

- configured/static route evidence remains configured;
- deterministic derivation remains `epistemic=derived`;
- runtime MQ connectivity remains corroboration, not message activity;
- channel identity remains whatever the integrated evidence adapter already established, including unavailable or ambiguous states;
- no message outcome is synthesized.

For file transfer:

- historical remains historical;
- current listener and PNC observations remain distinct;
- unresolved mappings remain unknown;
- transfer completion remains orthogonal to route qualification.

## Information-compression rule

The Paths workspace shows one selected path with four evidence stages, a compact fact strip, and proof behind disclosure. Domain labels distinguish **Messaging** from **File transfer** without requiring the operator to understand internal source adapters first.

The projection deliberately avoids a graph of the entire estate. Operators can still use **Advanced trace** when they need forensic route walking or raw canonical relationship detail.

## Acceptance criteria

1. The canonical fixture produces both one messaging path and one file-transfer path through `/api/v2/operator/paths`.
2. Messaging is shown as derived/configured topology with independent MQ connectivity corroboration.
3. Messaging outcome remains **not established**; no message traversal is claimed.
4. FTP retains historical/current/inferred distinctions and transfer completion remains **not observed** when not evidenced.
5. Operations uses the same multi-domain path projection rather than an FTP-only count.
6. Existing canonical route trace behavior remains unchanged.
7. No schema migration or canonical-data mutation is required.
