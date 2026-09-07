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
        |
        v
       D1
  nodes / edges
 snapshot evidence
        |
        v
Current Topology UI
```

The Cloudflare side never needs IBM MQ administrative connectivity in this phase. Server data is exported manually, normalized, and uploaded through the dashboard.

R2 is intentionally optional in the first deployment. The current Cloudflare account has R2 disabled, so validated snapshot evidence is stored in a dedicated D1 table through a small compatibility adapter. When R2 is enabled later, the adapter can be replaced by a native R2 binding without changing the topology engine or normalized input contract.

## Safety invariant

A new upload does **not** replace the active topology until the complete graph has been validated, persisted, and count-checked. Failed/staging snapshots remain inactive.

## Current capabilities

- Cloudflare Worker API and static dashboard in one deployment.
- D1 current/snapshot topology store.
- D1 evidence copy of every validated normalized snapshot for V1.
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

The project uses `wrangler.jsonc`, Workers static assets, and D1. Wrangler automatic provisioning is used for the D1 database named `mw-dashboard-topology`.

```bash
npm install
npm run check
npm run deploy
npm run db:migrate
```

GitHub Actions performs those deployment steps on pushes to `main` using repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

After the D1 migrations are applied, open the Worker URL and upload the sample topology or a real normalized export.

For a controlled production setup, pin the D1 resource ID after provisioning and protect the application with Cloudflare Access.

## Next milestone

Build the IBM MQ normalization adapter from a real collector export and reproduce this path from evidence:

`Host -> Application -> SVRCONN -> Queue -> Consumer or XMITQ/Sender Channel -> Remote Queue Manager -> Destination`
