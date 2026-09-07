# Cloudflare deployment

MW-Dashboard deploys as a Cloudflare Worker with static assets, D1, and R2 bindings.

## Required GitHub repository secrets

Create these repository/environment secrets before the production workflow runs:

- `CLOUDFLARE_API_TOKEN` — a scoped Cloudflare API token that can deploy Workers and manage D1/R2 resources.
- `CLOUDFLARE_ACCOUNT_ID` — the target Cloudflare account ID.

Do not commit API tokens, R2 access keys, or secret access keys to this repository.

## Deployment workflow

`.github/workflows/deploy-cloudflare.yml` runs on pushes to `main` and can also be started manually.

The job performs:

1. Checkout.
2. Install dependencies.
3. TypeScript type check.
4. `wrangler deploy` through `cloudflare/wrangler-action@v4`.
5. Apply remote D1 migrations with `wrangler d1 migrations apply DB --remote`.

The initial Wrangler configuration uses automatic resource provisioning. If the D1/R2 resources do not exist yet, Wrangler can provision and link them during the first deployment.

## Production hardening after first deployment

After the first successful deployment:

1. Record the provisioned D1 database and R2 bucket names/IDs.
2. Replace draft/automatic bindings with explicit production bindings if desired.
3. Put Cloudflare Access in front of the dashboard before real topology data is uploaded.
4. Keep the R2 bucket private.
5. Use the dashboard's manual upload path for server exports during V1.

## V1 data flow

```text
Middleware server export
        |
        | manual transfer
        v
Normalized topology JSON
        |
        v
MW-Dashboard upload
        |
        +--> validate
        +--> R2 evidence copy
        +--> D1 staging snapshot
        +--> count-check
        '--> activate only after success
```

A failed upload must never replace the active topology snapshot.
