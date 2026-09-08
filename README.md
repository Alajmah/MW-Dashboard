# MW-Dashboard

Cloudflare-hosted middleware topology dashboard. Product v1 is intentionally limited to **current topology + manual topology updates**.

## V1 architecture

```text
Private middleware servers
        |
        | manual export / transfer (initially)
        v
Raw collector archives
        |
        v
Normalization adapter
        |
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
- Read-only IBM MQ raw topology collector with repeatable runtime sampling.

## IBM MQ collection

The supported server-side collector is:

[`collectors/ibm-mq/mq-topology-collector.sh`](collectors/ibm-mq/mq-topology-collector.sh)

For the first real collection on an MQ host:

```bash
chmod 750 mq-topology-collector.sh
./mq-topology-collector.sh 5 60
```

That records static queue-manager configuration once and five runtime observations one minute apart, then creates:

```text
mq-topology-<hostname>-<UTC timestamp>.tar.gz
```

The collector is read-only and does not read message payloads. Configuration and runtime evidence are kept separate so the normalization adapter can distinguish configured relationships from observed application activity.

See:

- [`collectors/ibm-mq/README.md`](collectors/ibm-mq/README.md) for installation and usage.
- [`docs/mq-raw-collector-contract-v1.md`](docs/mq-raw-collector-contract-v1.md) for the archive/evidence contract.
- [`docs/topology-contract-v1.md`](docs/topology-contract-v1.md) for the normalized dashboard input contract.

## API

- `GET /health`
- `GET /api/v1/topology/current`
- `GET /api/v1/topology/search?q=PAYMENT`
- `GET /api/v1/topology/subgraph/{node_id}?depth=2`
- `GET /api/v1/snapshots`
- `POST /api/v1/topology/import` (`application/json`)

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

GitHub Actions performs those deployment steps on pushes to `main` using repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` and runs a post-deploy `/health` smoke test.

After the D1 migrations are applied, open the Worker URL and upload the sample topology or a real normalized export.

For a controlled production setup, pin the D1 resource ID after provisioning and protect the application with Cloudflare Access.

## Next milestone

Run the new IBM MQ collector on a real MQ host, inspect the resulting raw archive, and build the normalization adapter to reproduce this path from evidence:

`Host -> Application -> SVRCONN -> Queue -> Consumer or XMITQ/Sender Channel -> Remote Queue Manager -> Destination`
