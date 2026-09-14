# Phase FTP — EFT + DMZ Gateway + MQ MFT evidence integration

## Purpose

This phase adds a current, evidence-preserving FTP/file-transfer projection without changing the canonical identity principles established for MQ, ACE, and DataPower.

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

The private production evidence stays outside Git. The repository contains only:

- the normalizer;
- a sanitized RFC 5737 fixture;
- regression tests;
- this design note.

The normalizer consumes `osi.ftp.projection/v1` and emits `osi.observation.bundle/v2` for the existing semantic import/reconciliation path.

## Epistemic rules

### Site access is not file-transfer completion

A qualified inbound EFT route may be emitted only when all of the following are present:

1. the EFT Site is current;
2. DMZ activity evidence observes that Site on a specific gateway listener;
3. the EFT/DMZ Peer Notification Channel is independently corroborated by current runtime evidence.

The resulting `integration.routes_to` relation remains:

- `evidence_class = observed`;
- `properties.epistemic = observed`;
- `properties.runtime_transfer_completion = false`.

A route therefore means **observed Site access through a currently connected gateway path**. It does not mean that a file completed transfer.

### Unresolved Sites remain unresolved

A Site discovered as started/current is emitted as a `filetransfer.endpoint`, but the normalizer does not create a qualified route unless the Site-to-listener evidence exists.

Historical Event Rule activity is allowed only as contextual Site metadata. Historical-only activity cannot promote a current route.

### PNC is transport corroboration

Client listeners and PNC endpoints are separate canonical objects. A client-facing listener must never be reused as the PNC endpoint merely because both belong to the same DMZ Gateway.

The normalizer fails closed if a route does not include an independently corroborated PNC endpoint.

### MQ Managed File Transfer

Each IBM MQ Managed File Transfer agent is represented as an `app.application_instance` running on the EFT host.

Agent and coordination queue-manager identities are emitted as `mq.queue_manager` anchors so canonical reconciliation can resolve them against the existing MQ estate.

The MFT relations are `configured` logical dependencies. They explicitly state that host/port/channel connectivity and completed file transfer have not been proven by the MFT service/configuration evidence alone.

### Storage

Local EFT paths are represented as `filetransfer.endpoint` objects with `endpoint_kind = filesystem_path`.

A local NTFS path is not promoted to an NFS dependency unless an independent source proves that relationship.

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
6. verify estate freshness and route/source identity semantics.

The initial accepted production slice may contain three qualified inbound Site routes while keeping other Site-listener relationships explicitly unresolved.
