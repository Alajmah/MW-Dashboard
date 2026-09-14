# Phase FTP — Visualization and operator experience

## Objective

Present the accepted FTP production evidence as a first-class peer of MQ, ACE, and DataPower without introducing a second topology model or overstating transaction evidence.

The operator experience is a projection over the current canonical estate. It does not create new route truth.

## Accepted production state

The production FTP publication accepted on 2026-09-14 establishes the following product boundary:

- four `filetransfer.flow -> filetransfer.endpoint` relations qualify as inferred topology routes;
- Site-access evidence for those routes is historical;
- gateway listener evidence is current;
- Peer Notification Channel runtime connectivity is independently corroborated by current sources;
- `runtime_transfer_completion=false` remains explicit;
- `External FTPS` and `Internal User` retain unresolved Site-to-listener/gateway mappings;
- local transfer paths remain local NTFS references unless independent evidence proves an NFS relationship;
- MQ MFT agents and their queue-manager associations remain canonical application/dependency evidence and do not prove completed file transfer.

## Product semantics

### Route qualification is not transfer outcome

The Routes workspace exposes an FTP route only when the canonical `integration.routes_to` relation is already qualified by the evidence-normalization boundary.

The UI shows separately:

1. route epistemic class (`inferred` for the accepted FTP topology routes);
2. historical Site-access evidence;
3. current listener evidence;
4. current PNC runtime corroboration;
5. transfer completion state.

`runtime_transfer_completion=false` renders as **No completed transfer observed**. It is not converted to failed or successful transfer.

### Mapping gaps are topology gaps, not incidents

Unresolved `filetransfer.endpoint` references are surfaced under **Needs mapping**. They remain explicit unknowns and are not promoted into Findings solely because mapping evidence is absent.

### No synthetic liveness

The FTP workspace contains no animated traffic indicator and no inferred health badge. Current runtime corroboration is shown only where it is present in the canonical route properties.

## Operator experience

The Routes experience follows a three-stage investigation model.

### 1. Orient

The operator first receives a compact service-path summary instead of a wall of estate metrics:

- number of qualified FTP paths;
- current runtime-boundary coverage;
- explicit mapping gaps requiring attention;
- transfer-completion evidence state;
- file-transfer server count as secondary estate context.

The summary uses operator language first while preserving exact epistemic terminology in route details.

### 2. Understand

Each qualified FTP route is rendered as an evidence-backed path lane:

`Access context -> DMZ listener -> PNC boundary -> EFT Site`

Each path component carries its own evidence state. The lane is explicitly a topology projection, not a live transaction timeline.

For the accepted production routes:

- Access context is historical observed evidence;
- the DMZ listener is current observed evidence;
- the PNC boundary is current and independently corroborated;
- the EFT Site is the canonical topology destination;
- the overall route remains qualified but inferred;
- completed file transfer remains unobserved.

The browser may resolve the canonical DMZ gateway display name from the route's `gateway_server_key`, but it does not infer downstream MFT-agent membership, storage dependencies, or transfer success from naming or geometry.

### 3. Prove

Every route retains **Inspect route evidence**. Selecting it focuses the existing canonical route workbench on the exact source and destination entities, where the operator can inspect the evidence-backed route claim without creating a second source of truth.

A secondary disclosure, **Why is this path qualified?**, exposes the precise Site activity window, listener endpoint, PNC endpoint, runtime source kinds, and transfer-outcome state.

## Readability contract

The FTP service-path projection is an operations workspace, not a dense telemetry table. Primary route labels, evidence states, explanatory copy, and actions use normal readable UI sizes; evidence badges are no longer rendered at 7–8 px. Horizontal path lanes may scroll on constrained screens rather than shrinking evidence text below readable size.

## Implementation

### Route API

`src/integrated-routes.ts` handles explicitly qualified FTP direct routes in addition to the existing qualified DataPower-to-MQ projection.

FTP trace responses expose:

- `route_domain = file_transfer`;
- `qualified_route = true`;
- `configured_route_is_runtime_traversal = false`;
- `derived_epistemic`;
- Site-access evidence;
- current listener evidence;
- runtime corroboration;
- `runtime_transfer_completion`;
- a derived presentation state `transfer_completion = observed | not_observed | unknown`.

The derived presentation state never upgrades the underlying evidence.

### Route search

`filetransfer.endpoint` is included in canonical route search so Sites and storage/listener endpoints can participate in search-to-focus alongside `filetransfer.flow`.

### Routes workspace

`public/ftp-operator.js` adds the FTP service-path projection above the existing canonical route workbench. It reads only the canonical estate APIs and derives no topology from screen geometry or display-name heuristics.

`public/ftp-operator.css` provides responsive service-path lanes and readable evidence presentation while retaining the existing OSI visual system.

All values are computed from the current estate; no production cardinality is hard-coded into the browser.

## Regression contract

Canonical-route CI verifies:

- MQ route semantics remain unchanged;
- qualified DataPower route semantics remain unchanged;
- `filetransfer.endpoint` is searchable;
- the FTP qualified route remains `inferred`;
- historical Site access remains historical;
- listener evidence remains current;
- PNC runtime corroboration remains present and independent;
- `runtime_transfer_completion=false` returns `transfer_completion=not_observed`;
- unresolved FTP Site mapping remains visible through the canonical unresolved API.

UI checks additionally continue to parse the FTP operator JavaScript and preserve canonical Routes shell invariants.

## Deferred product detail

The service-path projection does not infer MFT-agent membership from display names and does not treat filesystem endpoints as NFS dependencies. A later route extension may expose MFT agents, storage paths, and queue-manager dependency chains only when those segments can be driven by canonical typed relations rather than UI-side heuristics.
