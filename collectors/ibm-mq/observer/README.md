# OSI IBM MQ observer

`osi_mq_observer.py` is the first continuous-telemetry building block for IBM MQ. It is deliberately separate from `mq-topology-collector.sh`:

- the topology collector is a forensic/configuration evidence capture intended to be transferred and normalized later;
- the observer is a small read-only runtime sampler intended to produce `osi.telemetry.batch/v1` batches.

The observer does **not** publish to Cloudflare, write to D1, consume MQ messages, or change queue-manager state. A later publisher/ingestion component may transport its output after canonical identity resolution and retention policy are defined.

## Safety boundary

The MQSC allowlist is hard-coded to:

```text
DISPLAY QMGR QMID
DISPLAY QMSTATUS ALL
DISPLAY QSTATUS(*) TYPE(QUEUE) ALL
DISPLAY CHSTATUS(*) ALL
DISPLAY LSSTATUS(*) ALL
```

Only `DISPLAY` is accepted by the command guard. The program never issues `ALTER`, `DEFINE`, `DELETE`, `START`, `STOP`, `CLEAR`, `RESET`, `REFRESH`, or a message-consuming command.

When queue managers are not supplied, `dspmq` is used only to discover their names.

## Dry run

Show exactly what would be executed without invoking IBM MQ:

```bash
python3 osi_mq_observer.py --dry-run --qmgr QM1
```

## One sample

```bash
python3 osi_mq_observer.py --qmgr QM1 --output telemetry.json
```

If `--qmgr` is omitted, the observer uses `dspmq` discovery.

## Multiple samples

```bash
python3 osi_mq_observer.py --qmgr QM1 --samples 5 --interval 60 --output telemetry.json
```

This is an explicit foreground command. The repository does not install a daemon, cron entry, systemd service, or remote publisher.

## Baseline metrics

The first profile intentionally mirrors the observation names already used by the operational findings pipeline:

- `mq.queue_manager.status`
- `mq.queue.depth.current`
- `mq.queue.process.input_count`
- `mq.queue.process.output_count`
- `mq.queue.message.age.oldest_seconds`
- `mq.channel.status`
- `mq.channel.monitoring_level` when present
- `mq.listener.status`

Channel-instance fields such as `JOBNAME`, `CONNAME`, and `RAPPLTAG` are dimensions. They do not redefine the canonical channel identity.

## Canonical identity rule

The observer does **not** mint `cent_*` identifiers. Each observation carries source-native identity hints such as queue-manager name, QMID when available, and object name. A future resolver/publisher must match those hints to the canonical estate before setting `canonical_entity_id` or converting the telemetry item into the existing operational-observation persistence shape.

This prevents a telemetry label or transient channel instance from becoming the system of record for identity.

## Coverage semantics

Every command produces a coverage record. A successful enumeration is `point_in_time`; an MQSC process/error failure is `failed`. Failed families emit no observations, so absence is never inferred from a collection failure.

## Production cadence

No cadence is activated by this slice. A 60-second baseline is the current design target for queue-manager, queue, channel, and listener runtime state, but it must be validated against representative production load before service installation. Higher-cardinality connection/handle sampling and adaptive faster polling remain future work.
