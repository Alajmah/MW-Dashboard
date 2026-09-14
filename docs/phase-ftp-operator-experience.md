# Phase FTP — Canonical Operator Experience

## Purpose

This phase exposes the production-accepted Globalscape EFT / DMZ Gateway / IBM MQ Managed File Transfer slice as an operator-facing canonical view.

It is a **read-only projection of the current canonical estate**. It does not read private evidence packages, call administrative import APIs, or reconstruct source-observation state in the browser.

## Product boundary

The File Transfer workspace reads only the public canonical-estate endpoints:

- `/api/v2/estate/current/summary`
- `/api/v2/estate/current/entities`
- `/api/v2/estate/current/entities/<id>`
- `/api/v2/estate/current/relations`
- `/api/v2/estate/current/unresolved`

The workspace intentionally does **not** call `/api/v2/observations/current/*`. Source observations remain evidence input; the operator surface is built from reconciled canonical identities and relationships.

## Operator model

The workspace separates the file-transfer fabric into distinct concepts instead of flattening it into one generic route:

1. **EFT Site** — logical file-transfer endpoint on the EFT backend.
2. **Client listener** — DMZ-facing ingress endpoint used for a Site path.
3. **DMZ Gateway** — logical file-transfer gateway, distinct from its physical host.
4. **PNC bridge** — peer-notification/runtime connectivity between EFT and a DMZ Gateway endpoint.
5. **EFT backend** — logical EFT server, distinct from `SJEDITB12909`.
6. **MQ MFT agent** — application instance with configured agent-QM and coordination-QM dependencies.
7. **Filesystem anchor** — observed local transfer path; storage backing is represented only to the level supported by evidence.
8. **Unresolved Site mapping** — an explicit gap when no current listener/gateway mapping is supported.

## Epistemic rules

The UI preserves the FTP normalization contract rather than presenting a visually simpler but stronger claim.

A qualified inbound path is displayed as **inferred topology**, because it is composed from:

- a current explicitly started EFT Site;
- a current observed client listener;
- historical observed DMZ Site-access evidence;
- current PNC runtime connectivity independently corroborated by distinct runtime source kinds.

The UI therefore labels Site access as historical and does not call the path a current file traversal. It also keeps `runtime_transfer_completion=false` conceptually visible as **transfer completion not proven**.

PNC bridges are shown separately from client listeners because they serve different roles and are different canonical endpoints.

MQ MFT queue-manager associations remain configured logical dependencies. The view must not imply that host/port/channel connectivity or a completed MFT transfer has been observed when those facts were not collected.

The four `H:\PROD\...` / `H:\TST\...` filesystem anchors remain observed local NTFS paths. The UI must not infer equivalence to the NFS exports shown in architecture diagrams while the canonical property `nfs_relationship` remains unresolved.

## Current production acceptance represented by this view

At the time this phase was designed, the accepted production FTP source contributes:

- 3 qualified inferred inbound Site paths;
- 2 explicit unresolved Site mappings (`Internal User`, `External FTPS`);
- 2 IBM MQ MFT agents;
- 4 observed transfer-storage anchors;
- 2 separate DMZ Gateway logical servers plus 1 EFT backend.

These numbers are not hard-coded as truth by the UI. They are derived from the active canonical estate at render time.

## UX intent

The screen is organized for operational reading rather than object enumeration:

- top-level counts establish scope and evidence gaps;
- route lanes explain each qualified Site path as listener → gateway → Site → EFT backend;
- Site coverage makes unresolved mappings visible alongside mapped Sites;
- PNC runtime is separated into its own panel;
- MFT dependencies expose the bridge into the MQ estate without fabricating transport detail;
- storage anchors display observed filesystem facts and unresolved NFS status;
- unresolved mappings keep their canonical reasons visible rather than disappearing from a successful-looking diagram.

Operational text in the dedicated stylesheet is kept at 10px or larger and the layout collapses to single-column/operator-readable form at narrower viewport widths.

## Regression guard

`scripts/check-filetransfer-ui.mjs` and `.github/workflows/filetransfer-ui-check.yml` enforce the key product contract:

- canonical-estate APIs only;
- no administrative token dependency;
- no source-observation bypass;
- historical Site-access wording retained;
- transfer-completion boundary retained;
- unresolved evidence visible;
- MFT and NFS uncertainty semantics preserved;
- dynamic DOM IDs declared;
- minimum dedicated operational font size of 10px;
- responsive CSS present.

## Non-goals

This phase does not:

- change FTP canonical identity rules;
- alter the accepted FTP source revision;
- close the two unresolved Site mappings;
- claim completed file transfers;
- add ARM audit data;
- infer the H: volume as NFS;
- alter the generic MQ/ACE/DataPower route walker;
- add write or control actions to EFT, DMZ Gateway, MQ MFT, or MQ.
