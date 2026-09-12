# Phase 2P — Historical Log Corpus for Demo Discovery

## Goal

Collect a large, read-only historical corpus of IBM MQ diagnostic evidence from each relevant MQ host, analyze it offline, and use the results to discover real operational stories that strengthen the OSI demo.

This corpus is not a new database plane. Raw logs and derived analysis artifacts remain outside D1. Only evidence deliberately promoted later through an approved product contract would become part of the dashboard.

## Why this exists

Topology and sampled runtime state show what exists and what was observed at collection time. Historical diagnostic logs can reveal longer-lived patterns that short runtime windows may miss, including recurring channel/network failures, queue-manager lifecycle and recovery events, TLS/certificate failures, authorization failures, cluster disturbances, storage or resource pressure, client connection churn, repeated IBM MQ message IDs, and recurring FDC probe signatures.

The objective is discovery, not automatic diagnosis. The offline analyzer ranks candidate stories; an operator validates them against topology and runtime evidence before they are used in the demo.

## Evidence planes

The demo campaign keeps these planes separate:

1. Canonical topology — `mq-topology-*.tar.gz` normalized into the canonical estate.
2. Runtime observations — repeated queue/channel/listener/connection/application status samples.
3. Findings — `osi.findings.evaluation/v1` derived from runtime evidence.
4. Historical logs — `mq-log-history-*.tar.gz`, retained outside the database and analyzed offline.
5. Derived log analysis — summaries, catalogs, extracted events and candidate rankings, also outside D1.

A historical log event is not current runtime state, and a heuristic log candidate is not an OSI finding.

## Collector

`collectors/ibm-mq/mq-log-history-collector.sh`

The collector is read-only. It does not run MQSC, browse or get queue messages, enable trace, modify MQ configuration, start or stop services, send network traffic, or write to D1.

### First pass: inventory only

Run this on every MQ host first:

```bash
./mq-log-history-collector.sh --inventory-only --include-journal --output-dir ./osi-log-corpus
```

This discovers retained MQ diagnostic evidence and estimates file count and bytes without copying source log files. Review `manifest.tsv` and `manifest.properties` for volume, access gaps, discovered MQ data roots and the presence of FDC evidence.

### Full historical collection

After reviewing volume:

```bash
./mq-log-history-collector.sh --include-journal --output-dir ./osi-log-corpus
```

By default this collects all retained readable IBM MQ diagnostic files matching the collector contract under discovered MQ data roots, including FDC/FFST evidence, plus a filtered IBM MQ systemd journal when requested.

There is deliberately no arbitrary historical cutoff by default. The historical boundary is whatever the source host retained. Optional `--since`, `--until`, and `--max-bytes` controls exist for hosts where a bounded transfer is required.

### Broad system context

For a deeper incident-discovery pass:

```bash
./mq-log-history-collector.sh --include-journal --include-system-files --output-dir ./osi-log-corpus
```

`--include-system-files` copies broad rotated `messages`, `syslog`, `daemon` and `kern` files. These can contain unrelated host activity and are intentionally opt-in.

### Existing trace files

Trace is excluded by default because it can be very large and substantially more detailed. If a pre-existing trace is specifically approved:

```bash
./mq-log-history-collector.sh --include-trace --output-dir ./osi-log-corpus
```

The collector never enables MQ trace.

## Permissions

Run the normal MQ pass as an IBM MQ administrative account with read access to the MQ data tree. Some systemd journal or broad system-log evidence may require additional OS permissions. Record access gaps instead of inferring missing content.

## Package structure

```text
mq-log-history-<host>-<utc>/
  manifest.properties
  manifest.tsv
  package-checksums.sha256
  README.txt
  meta/
    hostname.*
    date-local.*
    date-utc.*
    timedatectl.*
    dspmq.*
    dspmqver.*
    search-roots.txt
  raw/
    files/
      var/mqm/.../errors/AMQERR01.LOG
      var/mqm/.../errors/...
    system/
      journal-mq.log
      journal-boots.out
```

`manifest.tsv` preserves evidence class, original source path, size, source mtime, archive path, SHA-256 and copy/access status.

## Offline analyzer

`collectors/ibm-mq/analyze_mq_log_history.py`

Example:

```bash
python3 analyze_mq_log_history.py mq-log-history-host-20260912T120000Z.tar.gz --output-dir ./analysis-host
```

It produces:

- `summary.json` — corpus scale, time bounds, severity/category counts and limitations;
- `events.ndjson.gz` — extracted IBM MQ message occurrences with source file and best-effort timestamp;
- `mq-message-catalog.csv` — counts, first/last seen, severities, categories and examples by AMQ message ID;
- `fdc-signatures.csv` — recurring FDC probe/component/program signatures;
- `demo-candidates.json` — heuristic ranking of recurring or error-heavy patterns worth operator review.

The analyzer does not convert a message ID into a causal conclusion. Its first job is to show what is actually present in the historical corpus and where the strongest evidence clusters are.

## What we want to discover

The strongest demo candidates are patterns that recur, span multiple files or hosts, have explicit MQ warning/error identifiers, align with canonical objects or routes, overlap runtime state changes, show failure-to-recovery progression, expose an operational limitation OSI can explain, or support a before/after development-change story.

For each candidate story, build an evidence dossier containing source host and queue manager, AMQ message IDs and/or FDC probes, first/last timestamps and recurrence count, related canonical objects/routes, matching runtime observations/findings when available, recovery evidence, and explicit limitations.

## Transfer boundary

Historical diagnostic corpora can contain detailed operational metadata. Review raw packages before moving excerpts into another environment. Keep the raw corpus in the approved offline analysis workflow and transfer only the material needed for the analysis task.

During the demo phase there is no direct middleware connection. OSI data arrives manually. Historical-log collection follows the same model: collect on the source host, transfer the archive manually, analyze it offline, and selectively use verified discoveries to improve the demo narrative.

No raw log ingestion into D1 is planned for this phase.
