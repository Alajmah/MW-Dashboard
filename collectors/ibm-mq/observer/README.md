# OSI IBM MQ observer

`osi_mq_observer.py` is the first continuous-telemetry building block for IBM MQ. It is deliberately separate from `mq-topology-collector.sh`:

- the topology collector is a forensic/configuration evidence capture intended to be transferred and normalized later;
- the observer is a small read-only runtime sampler intended to produce `osi.telemetry.batch/v1` batches.

The observer does **not** publish to Cloudflare, write to D1, consume MQ messages, or change queue-manager state. Phase 2K keeps outbound delivery in a separate `telemetry_delivery.py` process so network failure or publisher credentials cannot expand the observer's MQ authority.

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

This is an explicit foreground command. For multi-sample runs the observer enforces a 10-second minimum interval to prevent accidental hot-loop polling. The repository does not install a daemon, cron entry, systemd service, or automatic remote publisher.

## Durable outbound spool

Phase 2K adds a separate local spool. Enqueue an observer batch with:

```bash
python3 telemetry_delivery.py spool \
  --input telemetry.json \
  --spool-dir /var/spool/osi-telemetry
```

The delivery ID is derived from canonical JSON, so re-spooling the same logical batch is idempotent even when whitespace or input key ordering differs. Pending, sent, and corrupt/dead records are retained separately; writes are fsync-backed and atomically renamed. A local exclusive lock prevents two publisher invocations from concurrently sending the same pending record.

Inspect local state without any network request:

```bash
python3 telemetry_delivery.py status --spool-dir /var/spool/osi-telemetry
```

A future private-side service can invoke `send` periodically. The publisher requires an HMAC-SHA256 secret of at least 32 UTF-8 bytes and an explicit key ID. It has no MQSC, D1, Wrangler, or dashboard-administration capability:

```bash
export OSI_TELEMETRY_SECRET='replace-with-a-random-secret-of-at-least-32-bytes'
python3 telemetry_delivery.py send \
  --spool-dir /var/spool/osi-telemetry \
  --endpoint https://example.invalid/api/v2/telemetry/ingest \
  --key-id mq-host-a
```

Remote endpoints must use HTTPS. Exact loopback HTTP (`localhost`, `127.0.0.1`, or `::1`) is accepted only for local tests. Redirects are not followed, URL credentials/fragments are rejected, and the key ID is included in the signature input. No production telemetry endpoint is enabled by this repository slice.

## Trusted canonical identity resolution

The observer does **not** mint `cent_*` identifiers. Each observation carries source-native identity hints such as queue-manager name, QMID when available, and object name.

At the trusted ingestion side, `telemetry_resolver.py` can resolve those hints against an explicit `osi.telemetry.identity-snapshot/v1` projection:

```bash
python3 telemetry_resolver.py \
  --batch telemetry.json \
  --identity-snapshot canonical-identity-snapshot.json \
  --output resolution.json
```

Incoming non-null `canonical_entity_id` values are treated as untrusted and quarantined. QMID is authoritative when present; a missing QMID match does not silently fall back to queue-manager name. Ambiguous, conflicted, or unresolved canonical identities are quarantined rather than guessed. The resolver also rejects duplicate observation IDs, duplicate canonical entity IDs, and batch/source inconsistencies before resolution.

This prevents a telemetry label, replaced queue manager, transient channel instance, or malformed batch from becoming the system of record for identity.

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

Canonical identity remains owned by the semantic estate. The observer emits only source-native hints, and the resolver fills `canonical_entity_id` only after one unique resolved canonical entity matches those hints. The current estate's QMID identity for queue managers and queue-manager-scoped identity for queues/channels/listeners remain authoritative.

## Coverage semantics

Every command produces a coverage record. A successful enumeration is `point_in_time`; an MQSC process/error failure is `failed`. Failed families emit no observations, so absence is never inferred from a collection failure.

## Production cadence

No cadence is activated by this slice. A 60-second baseline is the current design target for queue-manager, queue, channel, and listener runtime state, but it must be validated against representative production load before service installation. Higher-cardinality connection/handle sampling and adaptive faster polling remain future work.
