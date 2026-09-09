# Cloudflare semantic source import

This phase replaces the proposed always-on OSI Processing Node with a browser-local normalization pipeline and Cloudflare Free persistence.

## Boundary

Internal MQ/Linux hosts remain collector-only. The operator manually transfers `mq-topology-*.tar.gz` and selects it in `/admin-import.html`.

The browser:

1. fingerprints the archive with SHA-256;
2. loads the pinned Pyodide runtime;
3. executes the repository's IBM MQ ObservationBundle v2 normalizer locally in a Web Worker;
4. validates entity and relationship contracts against `services/core/registry/v1.json`;
5. uploads only validated semantic records in small chunks.

The raw archive is **not uploaded** in this phase.

Cloudflare D1 stores source revisions independently. Activation is per `source_id`, so importing one MQ host cannot erase another host's current source revision. This is intentionally separate from the legacy topology snapshot and from the future canonical estate projection.

## Runtime preparation

`npm run prepare:import-runtime` copies the exact normalizer, semantic registry, and ObservationBundle schema into generated static assets under `public/import-runtime/`. The generated directory is ignored by Git and is rebuilt for development, CI, and production deployment.

Pyodide is pinned to `314.0.6` and loaded from jsDelivr by the browser. Normalization runs in a Web Worker so the UI remains responsive.

## API

Public status:

```text
GET /api/v2/import/status
```

Authenticated administration:

```text
POST /api/v2/import/revisions
POST /api/v2/import/revisions/:revision/coverage
POST /api/v2/import/revisions/:revision/entities
POST /api/v2/import/revisions/:revision/relations
POST /api/v2/import/revisions/:revision/unresolved
POST /api/v2/import/revisions/:revision/activate
GET  /api/v2/import/revisions/:revision
GET  /api/v2/import/sources
```

Authenticated endpoints require:

```text
Authorization: Bearer <ADMIN_IMPORT_TOKEN>
```

If `ADMIN_IMPORT_TOKEN` is absent, analysis remains available but publishing is disabled.

## Atomicity and multi-host safety

A revision starts as `STAGING`. Activation is refused unless persisted counts exactly match the manifest and every relation source/target exists in the same source revision.

When activation succeeds, D1 atomically marks the previous revision for the same `source_id` as `SUPERSEDED` and the new revision as `ACTIVE`. Other source IDs are untouched.

This phase deliberately does not switch the current dashboard to semantic source revisions. The next step is canonical multi-source reconciliation and a read-optimized estate projection.

## Production setup

The existing Cloudflare deployment secrets remain unchanged. To enable publishing, add one Worker secret:

```text
ADMIN_IMPORT_TOKEN
```

Use a high-entropy random value. Do not reuse `CLOUDFLARE_API_TOKEN`.
