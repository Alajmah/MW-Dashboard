# Phase 2P — Middleware Historical Log Corpus for Demo Discovery

## Goal

Collect a large, read-only historical corpus of middleware diagnostic evidence, analyze it offline, and use the results to discover real operational stories for the OSI demo. The corpus is deliberately **outside D1**. Raw logs and derived analysis artifacts remain offline unless a later, explicit product contract promotes a small verified excerpt.

The demo phase has **no direct middleware connection**. Collection happens at the source, evidence is transferred manually, and analysis happens offline.

## Evidence families

### IBM MQ

Collect retained system error logs, queue-manager error logs, FDC/FFST evidence, optional filtered systemd journal context, optional rotated OS logs, and approved pre-existing trace files. The existing `mq-log-history-collector.sh` never enables trace and never reads queue payloads.

IBM MQ transaction/recovery logs are intentionally **not** copied or dumped in the first historical-diagnostic pass. They are recovery data rather than ordinary diagnostic text, can be very large, and may contain sensitive transactional content. If later analysis demonstrates a specific need, treat recovery-log examination as a separate, explicitly approved evidence procedure rather than silently adding it to the corpus.

Useful MQ discovery targets include recurring AMQ message IDs, channel/network failures, TLS/certificate problems, authorization failures, queue-manager lifecycle and HA/recovery events, cluster disturbances, storage/resource pressure, application connection churn, and recurring FDC probe signatures.

### IBM App Connect Enterprise (ACE)

The ACE corpus is based on the supplied ACE logging model:

- STDOUT / STDERR from integration-server processes;
- Linux/UNIX local error/system events routed through syslog;
- Activity Logs;
- Admin Log evidence when it has been explicitly exported or otherwise retained;
- existing Service/User Trace files that were already produced for diagnosis;
- Eclipse/Toolkit error logs when Toolkit-side behavior is relevant to the demo.

`collectors/ibm-ace/ace-log-history-collector.sh` inventories or copies retained filesystem evidence and can optionally add syslog and filtered journal context. It never enables ACE trace or changes an integration node/server.

The Admin Log is described as an in-memory operational/admin history. Therefore the collector does not claim historical Admin Log coverage unless a retained/exported artifact is actually supplied. Likewise, Toolkit Eclipse logs are workstation evidence and should be collected from the Toolkit workstation, not inferred from an ACE runtime host.

Typical first pass on an ACE host:

```bash
./ace-log-history-collector.sh \
  --inventory-only \
  --include-syslog \
  --include-journal \
  --output-dir ./osi-log-corpus
```

After reviewing volume and access gaps:

```bash
./ace-log-history-collector.sh \
  --include-syslog \
  --include-journal \
  --output-dir ./osi-log-corpus
```

If the ACE work directory is non-standard, supply it explicitly and repeat `--root` as required:

```bash
./ace-log-history-collector.sh --root /path/to/ace-work --root /another/retained-log-root --output-dir ./osi-log-corpus
```

### IBM DataPower Gateway

For the demo, DataPower remains a **manual export** source. We do not introduce appliance credentials or a direct collector connection. Export the retained artifacts approved for analysis and place them in a directory or archive before transfer to OSI.

The primary evidence classes from the supplied DataPower logging model are:

- System Log — operational messages from the default and application domains at configured priority levels;
- Audit Log — configuration/system-file changes;
- Traces — low-level component diagnostics when trace was already captured for a real troubleshooting event.

Do not enable additional DataPower tracing merely to enrich the demo. Use retained/exported traces only.

## Offline analysis

### MQ-specific analysis

```bash
python3 collectors/ibm-mq/analyze_mq_log_history.py \
  mq-log-history-<host>-<timestamp>.tar.gz \
  --output-dir ./analysis-mq-<host>
```

This produces corpus summary, compressed extracted events, AMQ message catalog, FDC signatures and ranked demo candidates.

### ACE analysis

```bash
python3 collectors/analyze_enterprise_log_history.py \
  ace-log-history-<host>-<timestamp>.tar.gz \
  --product ace \
  --output-dir ./analysis-ace-<host>
```

ACE analysis extracts BIP message identifiers when present, severity, source evidence class, recurring normalized patterns, source-file locations and ranked candidate stories.

### DataPower analysis

After manually exporting System/Audit/Trace files into a directory or `.tar.gz`/`.zip`:

```bash
python3 collectors/analyze_enterprise_log_history.py \
  ./datapower-export \
  --product datapower \
  --output-dir ./analysis-datapower
```

Because the supplied DataPower material does not define a stable product message-ID convention, the analyzer does not invent one. It ranks recurring normalized patterns, severity and evidence class and preserves the source file/line for operator review.

## Evidence integrity and boundaries

Historical-log packages should preserve source host/device, source path or export origin, source modification time where available, size, SHA-256, collection/export time, collector/analyzer version and access/copy status. Missing or unreadable evidence is a coverage limitation, not proof that an event did not occur.

The discovery analyzers are heuristic. A high-ranked log pattern is **not** automatically an OSI finding and is not proof of causality. Before a candidate appears in the demo, correlate it with canonical topology, runtime observations, routes/impact, existing findings, recovery evidence and—where relevant—change history.

## Demo story selection

Prefer real stories that show several evidence planes agreeing, for example:

```text
historical diagnostic event
  -> affected middleware object / integration flow / domain
  -> topology or route context
  -> runtime symptom or finding
  -> operator action / administrative change
  -> recovery evidence
```

Especially valuable candidates are cross-product sequences such as ACE application/flow failure followed by MQ channel/queue symptoms, or DataPower gateway/TLS errors aligning with external MQ transport evidence. Cross-product correlation must be based on timestamps, identifiers and topology evidence; temporal proximity alone is not enough to claim causality.

## Campaign procedure

Run an inventory-first pass on every relevant MQ and ACE host, export the approved retained DataPower logs, then transfer all packages manually to the OSI analysis workstation. Analyze each source independently first, then build a cross-source candidate index keyed by time window, host/device, queue manager, application/integration server, flow/domain, channel/endpoint and message/error identifier where available.

No raw log ingestion into D1 is planned for Phase 2P.
