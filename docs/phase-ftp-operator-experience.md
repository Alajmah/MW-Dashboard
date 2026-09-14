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

`runtime_transfer_completion=false` renders as **Not observed**. It is not converted to failed or successful transfer.

### Mapping gaps are topology gaps, not incidents

Unresolved `filetransfer.endpoint` references are surfaced under **Needs mapping**. They remain explicit unknowns and are not promoted into Findings solely because mapping evidence is absent.

### No synthetic liveness

The FTP workspace contains no animated traffic indicator and no inferred health badge. Current runtime corroboration is shown only where it is present in the canonical route properties.

## Implementation

### Route API

`src/integrated-routes.ts` now handles explicitly qualified FTP direct routes in addition to the existing qualified DataPower-to-MQ projection.

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

`public/ftp-operator.js` adds an FTP operator projection above the existing canonical route workbench. It reads only the canonical estate APIs and derives no topology from screen geometry or naming heuristics.

The panel contains:

- qualified-route count;
- file-transfer server count;
- current runtime-corroboration coverage for qualified routes;
- transfer-completion observation state;
- explicit mapping-gap count;
- one card per qualified FTP route;
- one card per unresolved FTP endpoint mapping;
- an **Inspect route evidence** action that focuses the existing canonical route workbench on the exact route entities.

All values are computed from the current estate; no production cardinality is hard-coded into the browser.

## Regression contract

Canonical-route CI now verifies:

- MQ route semantics remain unchanged;
- qualified DataPower route semantics remain unchanged;
- `filetransfer.endpoint` is searchable;
- the FTP qualified route remains `inferred`;
- historical Site access remains historical;
- listener evidence remains current;
- PNC runtime corroboration remains present and independent;
- `runtime_transfer_completion=false` returns `transfer_completion=not_observed`;
- unresolved FTP Site mapping remains visible through the canonical unresolved API.

## Deferred product detail

The first operator slice does not infer MFT-agent membership from display names and does not treat filesystem endpoints as NFS dependencies. A later FTP detail projection may expose MFT agents, storage paths, and queue-manager dependency chains once those views can be driven by canonical typed relations rather than UI-side heuristics.
