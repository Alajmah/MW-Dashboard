# Phase 2Q — Demo Evidence Qualification

## Goal

Turn the Phase 2P historical-log corpus and the existing MQ topology/runtime evidence into a reproducible, offline demo-qualification campaign.

Phase 2Q does **not** add middleware connectivity, a D1 ingestion path, or a new findings engine. The demonstration operating mode remains `manual_osi_handoff`.

The sequence is:

```text
source collection / manual export
  -> approved transfer
  -> immutable offline corpus
  -> product-specific analysis
  -> campaign index
  -> operator review and corroboration
  -> qualified demo episode
```

Analyzer rank is discovery evidence only. It never auto-promotes a pattern to an OSI Finding or a causal incident narrative.

## Portable evidence kit

Build a portable collection/analysis kit from the repository:

```bash
./scripts/build-phase2q-demo-evidence-kit.sh ./dist
```

The resulting archive contains:

- MQ topology/runtime collector;
- MQ historical diagnostic-log collector;
- ACE historical diagnostic-log collector;
- MQ historical-log analyzer;
- common ACE/DataPower analyzer;
- Phase 2Q campaign indexer;
- Phase 2P and Phase 2Q runbooks;
- SHA-256 checksums.

DataPower remains manual-export only during the demo. The kit contains no DataPower credentials or direct appliance collector.

## Collection campaign

### 1. Inventory first

Run inventory-only collection on every relevant MQ and ACE host before copying a large historical corpus.

MQ:

```bash
./mq-log-history-collector.sh \
  --inventory-only \
  --include-journal \
  --output-dir ./osi-log-corpus
```

ACE:

```bash
./ace-log-history-collector.sh \
  --inventory-only \
  --include-syslog \
  --include-journal \
  --output-dir ./osi-log-corpus
```

Record unreadable paths and missing retention as coverage limitations. Do not infer that an event did not occur because a source was inaccessible.

### 2. Full diagnostic collection

After volume/access review, collect the retained approved MQ and ACE diagnostic history and export approved DataPower System/Audit/retained Trace evidence.

MQ transaction/recovery logs remain outside the default diagnostic corpus. Pre-existing trace files are opt-in where the Phase 2P collector supports them; the tooling never enables trace.

### 3. Current operational evidence

Collect a fresh MQ topology/runtime archive from every physical MQ host with a meaningful repeated sample window. The historical corpus answers "what happened before"; the current operational evidence provides canonical placement, runtime state, access evidence, routes and findings for corroboration.

### 4. Offline analysis

Analyze each source independently before attempting cross-product correlation.

MQ:

```bash
python3 analyze_mq_log_history.py \
  mq-log-history-<host>-<timestamp>.tar.gz \
  --output-dir ./analysis-mq-<host>
```

ACE:

```bash
python3 analyze_enterprise_log_history.py \
  ace-log-history-<host>-<timestamp>.tar.gz \
  --product ace \
  --output-dir ./analysis-ace-<host>
```

DataPower:

```bash
python3 analyze_enterprise_log_history.py \
  ./datapower-export-<device> \
  --product datapower \
  --output-dir ./analysis-datapower-<device>
```

## Campaign index

Place transferred evidence packages and analysis outputs beneath one campaign root, then run:

```bash
python3 scripts/phase2q_campaign_index.py ./demo-campaign \
  --output ./demo-campaign/campaign-index.json
```

`osi.demo.evidence-campaign/v1` records:

- artifact paths, sizes and deterministic SHA-256 identifiers;
- available product/evidence classes;
- source manifest metadata when present;
- recognized offline analysis outputs;
- analyzer candidates, all forced to `unreviewed`;
- explicit evidence/analysis gaps;
- qualified episode dossiers if present.

A DataPower directory whose name contains `datapower` is treated as one manual-export evidence unit and receives a deterministic tree fingerprint.

## Qualified episode dossier

A reviewed story can be stored as `*.demo-episode.json` with `schema_version: osi.demo.episode/v1`.

The dossier should contain an explicit state (`draft`, `qualified`, or `rejected`), involved products and time window, immutable evidence references from the campaign index, optional analyzer candidate references, claim-by-claim support, known limitations, and an explicit operator review record.

A `qualified` episode is therefore an operator decision supported by evidence. It is not the result of an analyzer score.

Recommended evidence chain:

```text
source diagnostic event
  -> canonical identity or explicit unresolved identity
  -> topology / route context
  -> runtime observation or Finding when available
  -> operator/change/recovery evidence when claimed
  -> bounded statement with limitations
```

Temporal proximity alone does not establish causality.

## Demo coverage target

Do not select stories only because they are dramatic. A balanced demo corpus should aim to prove:

1. healthy estate / evidence freshness;
2. queue backlog or missing-consumer investigation;
3. channel/network failure and recovery;
4. ACE application/flow operational issue;
5. TLS/security/connectivity evidence;
6. queue-manager lifecycle, restart or HA/failover when real evidence exists;
7. cross-product route/impact reasoning, ideally DataPower -> MQ -> ACE;
8. a development/change story with before/after evidence.

FTP is inventory-first until the actual product and retained evidence format are known. Phase 2Q does not invent an FTP parser.

## Acceptance gate

Phase 2Q is complete when the campaign contains enough real evidence to demonstrate monitoring, investigation, route/impact reasoning, operations, recovery and one development/change scenario without synthetic incident claims.

A practical target is 5-10 qualified episodes spanning the capability classes above.

The raw historical corpus and derived analysis remain outside D1 throughout this phase. Only existing approved topology/findings product contracts are published to the dashboard.
