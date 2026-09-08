# IBM MQ raw collector contract v1

This document defines the archive produced by `collectors/ibm-mq/mq-topology-collector.sh`.

The raw collector contract is intentionally different from the normalized topology contract. Raw evidence preserves IBM MQ source data. The normalization adapter is responsible for parsing that evidence, correlating objects, assigning stable node/edge IDs, and classifying relationship provenance.

## Archive name

```text
mq-topology-<hostname>-<UTC timestamp>.tar.gz
```

The archive contains one top-level directory with the same basename.

## Top-level layout

```text
mq-topology-<host>-<timestamp>/
├── manifest.properties
├── README.txt
├── checksums.sha256              # when sha256sum is available
├── qmgrs.tsv
├── host/
├── mq/
└── qmgr/
```

## Manifest

`manifest.properties` contains simple `key=value` metadata:

```text
format=osi-mq-topology-raw
format_version=1
collector_version=1.0.0
host=<hostname>
started_at_utc=<ISO-8601 UTC>
completed_at_utc=<ISO-8601 UTC>
samples=<integer>
interval_seconds=<integer>
queue_manager_count=<integer>
run_as_user=<user>
```

The adapter must reject unknown future `format` values and should explicitly version-gate incompatible `format_version` values.

## Queue-manager inventory

`qmgrs.tsv` maps archive directory IDs to real queue-manager names:

```text
index	queue_manager
001_QM_EXT	QM_EXT
002_QM_INT	QM_INT
```

The queue-manager directory ID is a filesystem-safe label only. The actual queue-manager identity is the value in `qmgrs.tsv` / `name.txt`.

## Host evidence

`host/` contains read-only operating-system identity and network evidence when available:

```text
started-at-utc.txt
completed-at-utc.txt
hostname.out
hostname-fqdn.out
uname.out
os-release.txt
ip-addresses.out
ip-routes.out
id.out
```

Commands executed through the generic capture function also receive adjacent `.command`, `.err`, and `.rc` files.

This evidence is intended to support `Host` nodes and host/IP association. It must not, by itself, be used to infer application-to-queue relationships.

## MQ installation evidence

`mq/` contains:

```text
dspmq.out
[dspmqver.out]
[dspmqinst.out]
```

with adjacent command/error/return-code files.

`dspmq.out` is authoritative evidence for queue managers visible on the host and their local runtime disposition, including multi-instance states such as a queue manager running elsewhere.

## Per-queue-manager layout

```text
qmgr/<id>/
├── name.txt
├── config/
│   ├── qmgr.*
│   ├── queues-local.*
│   ├── queues-remote.*
│   ├── queues-alias.*
│   ├── queues-model.*
│   ├── queues-cluster.*
│   ├── channels.*
│   ├── listeners.*
│   ├── processes.*
│   ├── namelists.*
│   ├── services.*
│   ├── topics.*
│   └── subscriptions.*
└── runtime/
    └── sample_<NNN>_<timestamp>/
        ├── captured-at-utc.txt
        ├── qmgr-status.*
        ├── channel-status.*
        ├── listener-status.*
        ├── queue-status.*
        ├── queue-handles.*
        ├── connections.*
        ├── connection-handles.*
        ├── application-status.*
        └── cluster-qmgrs.*
```

For every MQSC request, the base name has four files:

- `.mqsc` — exact MQSC request sent to `runmqsc`
- `.out` — standard output
- `.err` — standard error
- `.rc` — process return code

The adapter must inspect both the process return code and MQSC output. `runmqsc` output can contain command-level MQ errors even when the process itself completed.

## Configuration evidence

The `config/` directory represents **configured** relationships unless stronger runtime evidence exists.

Important expected mappings include:

- `queues-remote.out`: remote queue definition, `RNAME`, `RQMNAME`, `XMITQ`
- `queues-local.out`: local queue definitions, including transmission queues via `USAGE(XMITQ)`
- `channels.out`: channel type, `CONNAME`, `XMITQ`, cluster membership, MCA/user/TLS-related operational attributes returned by MQ
- `listeners.out`: listener transport/address/port definition
- `queues-cluster.out`: cluster queue instances known to the local queue manager
- `processes.out` / `services.out`: configured process/service metadata that may help identify ownership, but must not be treated as an observed application connection

Configuration data can establish edges such as:

```text
QREMOTE -> ROUTES_TO -> XMITQ
XMITQ -> TRANSMITS_VIA -> SDR channel
SDR channel -> CONNECTS_TO -> remote endpoint / queue manager
SVRCONN -> BELONGS_TO -> queue manager
queue -> BELONGS_TO -> queue manager
```

These edges should normally carry `relationship_source=configured`.

## Runtime evidence

Each runtime sample represents an observation at a specific point in time. Important sources are:

- `connections.out`: connected applications and connection attributes
- `connection-handles.out`: objects opened by those connections
- `queue-handles.out`: queue handle state from the queue perspective
- `channel-status.out`: currently active/known channel instances and remote connection/application information
- `queue-status.out`: runtime queue state including depths and open-process counts
- `listener-status.out`: listener runtime state
- `cluster-qmgrs.out`: queue-manager cluster information known at collection time

Where a connection/handle correlation unambiguously identifies an application using a queue, the resulting edge should be `relationship_source=observed`.

A primary normalization target is:

```text
Host
  -> Application
  -> SVRCONN
  -> Queue Manager
  -> Queue
```

and, when configured routing evidence exists:

```text
Queue / QREMOTE
  -> XMITQ
  -> Sender / cluster channel
  -> Remote Queue Manager
  -> Destination Queue
```

## Inference boundary

The collector never emits inferred relationships.

The adapter may infer a relationship only when direct configuration/runtime evidence is insufficient and the inference can be justified from explicit evidence. Every inferred edge must carry:

- `relationship_source=inferred`
- confidence below 1.0
- a human-readable evidence/reason field

Ambiguous endpoint matches must remain unresolved rather than being silently promoted to observed/configured fact.

## Failure handling

The archive is evidence-preserving, not all-or-nothing.

Examples that must remain representable:

- A multi-instance queue manager is `Running elsewhere`, so local `runmqsc` calls fail.
- A particular MQ version does not support a requested status command.
- The collecting user lacks authority for one display command.
- No queue managers are locally visible.

In these cases the archive is still created. The `.rc`, `.err`, and `.out` files explain what was and was not observed.

The normalization adapter must surface collection gaps and must not fabricate missing topology.

## Sensitive-data boundary

The default collector does not intentionally collect:

- message payloads
- environment-variable dumps
- private keys or certificate files
- MQ authority exports
- `AUTHINFO` definitions
- `CHLAUTH` rules

However, operational MQ definitions/status can still contain hostnames, IP addresses, application/user identifiers, certificate labels, paths, and configured arguments. Archives must therefore be handled as operationally sensitive infrastructure data.
