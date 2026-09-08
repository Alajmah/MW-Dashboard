# MW-Dashboard semantic core

This directory contains the additive vNext semantic core described in `docs/target-product-architecture-vnext.md`.

The current Cloudflare Worker/D1 application remains operational while this service is validated. The vNext core is intended to become the authoritative topology, identity, evidence, and query layer.

## Current responsibilities

The first implementation slice provides:

- a machine-readable, versioned semantic registry
- the `osi.observation.bundle/v2` observation contract
- semantic validation of entity and relationship types
- a compatibility adapter for existing topology-v1 normalized JSON
- central initial canonical-key resolution
- PostgreSQL persistence for source runs, coverage, observations, canonical entities/relations, assertions, unresolved references, and topology revisions
- immutable/idempotent source-run ingestion semantics
- authenticated ingest endpoints
- bounded entity reads

The following are deliberately not claimed complete yet:

- cross-source identity reconciliation and merge/split decisions
- assertion expiry/closure from coverage semantics
- topology revision generation/diffing
- the domain-aware route resolver
- impact analysis
- object-storage evidence provider
- ACE/DataPower/file-transfer ingestion

## Important MQ semantic correction

Legacy topology-v1 data used `PUTS_TO` / `GETS_FROM` for queue-handle access. A queue handle that permits output or input does not prove that a message operation occurred during the sample.

The compatibility adapter therefore maps:

```text
PUTS_TO      -> runtime.opens_for_output
GETS_FROM    -> runtime.opens_for_input
CONSUMED_BY  -> runtime.opens_for_input (inverse legacy duplicate, deduplicated)
```

Actual message-operation evidence is reserved for:

```text
activity.put_observed
activity.get_observed
```

and the semantic registry permits those only with `observed` evidence.

## Requirements

- Go 1.27+
- PostgreSQL 14+; CI validates against PostgreSQL 18

## Database initialization

From `services/core`:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0001_semantic_core.sql
```

## Run

```bash
export DATABASE_URL='postgres://user:password@localhost:5432/mw_dashboard?sslmode=disable'
export INGEST_TOKEN='replace-with-a-secret'
export LISTEN_ADDR=':8080'

go run ./cmd/server
```

If `INGEST_TOKEN` is unset, read endpoints remain available but ingestion is disabled.

## API

```text
GET  /health
GET  /v2/registry
GET  /v2/entities?environment=prod&type=mq.queue&q=REQUEST&limit=100
POST /v2/ingest
POST /v2/compat/topology
```

`POST` endpoints require:

```text
Authorization: Bearer <INGEST_TOKEN>
```

`/v2/ingest` accepts the new observation bundle contract.

`/v2/compat/topology` accepts the existing normalized topology-v1 document and converts it to vNext semantics before persistence.

The JSON Schema for direct observation ingestion lives at:

```text
contracts/v2/observation-bundle.schema.json
```

## Design boundary

Vendor collectors and parsers should eventually emit source observations, not global topology truth. Canonical identity and cross-source reconciliation belong in this core service. This prevents each IBM MQ, ACE, DataPower, or file-transfer normalizer from independently inventing global identity and lifecycle behavior.
