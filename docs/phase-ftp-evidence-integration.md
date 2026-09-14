# Phase FTP — EFT + DMZ Gateway + MQ MFT evidence integration

## Purpose

This phase adds an evidence-preserving FTP/file-transfer projection without changing the canonical identity principles established for MQ, ACE, and DataPower.

The first implementation deliberately reuses the existing semantic registry primitives:

- `filetransfer.server`
- `filetransfer.endpoint`
- `filetransfer.flow`
- `infra.host`
- `infra.network_endpoint`
- `app.application_instance`
- `mq.queue_manager`

No new registry type is required for the first slice.

## Source boundary

The private production evidence stays outside Git. The repository contains only the normalizer, a sanitized RFC 5737 fixture, regression tests, and this design note.

The normalizer consumes `osi.ftp.projection/v1` and emits `osi.observation.bundle/v2` for the existing semantic import/reconciliation path.

The output uses only import-supported coverage modes: `complete`, `point_in_time`, `partial`, `failed`, and `not_collected`.

## Epistemic rules

### Historical Site access is not current traversal

The retained DMZ activity logs prove that a Site used a specific gateway listener during the recorded activity window. They do not prove that the Site is traversing that listener at the exact current instant.

A qualified inbound topology route may therefore be emitted only when all of the following are present:

1. the EFT Site is current/started;
2. the gateway listener is currently observed;
3. historical DMZ activity evidence ties that Site to the listener;
4. the EFT/DMZ Peer Notification Channel is independently corroborated by current observed runtime evidence.

That composition is emitted as:

- `integration.routes_to.evidence_class = inferred`;
- `properties.epistemic = inferred`;
- `properties.site_access_evidence.time_scope = historical`;
- `properties.current_listener_evidence.time_scope = current`;
- `properties.runtime_corroboration[0].time_scope = current`;
- `properties.runtime_transfer_completion = false`.

The relation therefore means **an evidence-qualified topology path**, not current Site traversal and not completed file transfer.

Historical Site-access evidence is never relabeled as a current observed route.

### Unresolved Sites remain unresolved

A Site discovered as started/current is emitted as a `filetransfer.endpoint`, but the normalizer does not create a qualified topology route unless the evidence composition above is complete.

`External FTPS` and `Internal User` remain explicit unresolved Site-to-listener references in the initial slice.

Historical Event Rule activity is contextual only and cannot resolve those mappings.

### Client listener and PNC are distinct

Client-facing listeners and PNC endpoints are separate canonical objects. A client listener must never be reused as the PNC endpoint merely because both belong to the same DMZ Gateway.

The normalizer fails closed unless PNC corroboration contains at least two current observed `pnc_runtime_connectivity` records with distinct `source_kind` values and evidence references for the same PNC endpoint. Opaque evidence-ref counts alone are insufficient.

### MQ Managed File Transfer

Each IBM MQ Managed File Transfer agent is represented as an `app.application_instance` running on the EFT host.

Agent and coordination queue-manager identities are emitted as `mq.queue_manager` anchors so canonical reconciliation can resolve them against the existing MQ estate.

The MFT relations are `configured` logical dependencies. They explicitly state that host/port/channel connectivity and completed file transfer have not been proven by the MFT service/configuration evidence alone.

### Storage

Local EFT paths are represented as `filetransfer.endpoint` objects with `endpoint_kind = filesystem_path`.

A local NTFS path is not promoted to an NFS dependency unless an independent source proves that relationship.

## Determinism and retry safety

The source `run_id` fingerprints the complete normalized input contract, environment, adapter version, and normalizer version—not only object keys. A semantic correction with the same object keys therefore produces a different run ID, while harmless reordering of top-level keyed arrays does not.

This avoids the recovery problem where changed evidence could collide with a previously imported deterministic run ID.

## Sensitive-data boundary

The input contract forbids secret-bearing keys such as passwords, credentials, tokens, private keys, certificate contents, service accounts, and command lines.

The resulting Observation Bundle does not contain MFT service command lines or credential files.

## Production gate

This branch does **not** publish the real FTP bundle.

Before production publication:

1. generate a private `osi.ftp.projection/v1` from the validated evidence packages;
2. run the repository normalizer locally;
3. inspect the resulting Observation Bundle;
4. publish through the existing protected semantic-import path;
5. rebuild/activate the canonical estate;
6. verify estate freshness, unresolved mappings, MQ identity reconciliation, and route semantics.

The initial accepted slice may contain three **inferred qualified topology paths** while keeping the other two Site-listener relationships explicitly unresolved.
