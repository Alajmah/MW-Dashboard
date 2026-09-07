# MW-Dashboard

Cloudflare-hosted middleware topology dashboard. Product v1 is intentionally limited to **current topology + manual topology updates**.

## V1 architecture

```text
Private middleware servers
        |
        | manual export / transfer (initially)
        v
Normalized topology JSON
        |
        v
Cloudflare Worker
   |             |
   v             v
  D1             R2
searchable       snapshot evidence
nodes/edges
        |
        v
Current Topology UI
```

The Cloudflare side never needs IBM MQ administrative connectivity in this phase. Server data is exported manually, normalized, and uploaded through the dashboard.

## Safety invariant

A new upload does **not** replace the active topology until the complete graph has been validated, persisted, and count-checked. Failed/staging snapshots remain inactive.

## Current capabilities

- Cloudflare Worker API and static dashboard in one deployment.
- D1 current/snapshot topology store.
- R2 evidence copy of every validated normalized snapshot.
- Manual JSON upload and activation.
- Current topology endpoint.
- Search across topology names and metadata.
- Local subgraph endpoint.
- Snapshot inventory.
- Relationship provenance: `observed`, `configured`, `inferred`.
- Basic topology graph and object table in the browser.

## API

- `GET /health`
- `GET /api/v1/topology/current`
- `GET /api/v1/topology/search?q=PAYMENT`
- `GET /api/v1/topology/subgraph/{node_id}?depth=2`
- `GET /api/v1/snapshots`
- `POST /api/v1/topology/import` (`application/json`)

See [`docs/topology-contract-v1.md`](docs/topology-contract-v1.md) for the normalized input contract.

## Local development

```bash
npm install
npm run db:migrate:local
npm run dev
```

Then upload [`examples/sample-topology.json`](examples/sample-topology.json) from the dashboard.

## Cloudflare deployment

The project uses `wrangler.jsonc`, Workers static assets, D1, and R2 bindings. The initial configuration intentionally uses Wrangler automatic resource provisioning: D1 omits `database_id` and R2 omits `bucket_name`. On the first production deployment Wrangler can provision those resources.

```bash
npm install
npm run check
npm run deploy
npm run db:migrate
```

After the D1 migration is applied, open the Worker URL and upload the sample topology or a real normalized export.

For a controlled production setup, replace automatic provisioning with explicit resource IDs/names after the Cloudflare resources exist and protect the application with Cloudflare Access.

## Next milestone

Build the IBM MQ normalization adapter from a real collector export and reproduce this path from evidence:

`Host -> Application -> SVRCONN -> Queue -> Consumer or XMITQ/Sender Channel -> Remote Queue Manager -> Destination`
