# IBM MQ topology collector

`mq-topology-collector.sh` creates a read-only raw evidence archive for MW-Dashboard. The preferred vNext path is `normalize_mq_observations.py`, which converts that archive directly into the semantic core's `osi.observation.bundle/v2` contract. `normalize_mq_topology.py` remains available only for compatibility with the current Cloudflare dashboard during migration.

The collector intentionally does **not** construct topology itself. It records IBM MQ configuration and runtime observations in separate files so downstream normalization can preserve configured versus observed evidence and represent collection failures explicitly.

## Prerequisites

- Linux/UNIX host running IBM MQ.
- Bash 4+ for collection.
- Python 3.9+ for normalization.
- `dspmq` and `runmqsc` in `PATH`.
- An account with authority to issue the requested MQSC `DISPLAY` commands. Running as the normal IBM MQ administrative account (`mqm` on Linux) is the expected first-use model.
- `tar`, `date`, and `hostname`.

Optional commands are used when present: `dspmqver`, `dspmqinst`, `ip`, and `sha256sum`.

## Install on an MQ server

Copy `mq-topology-collector.sh` to the MQ host and normalize line endings if the transfer mechanism changed them:

```bash
sed -i 's/\r$//' mq-topology-collector.sh
chmod 750 mq-topology-collector.sh
```

No configuration file is required.

## Recommended first collection

For the first real topology build, collect five runtime observations one minute apart:

```bash
./mq-topology-collector.sh 5 60
```

This legacy-compatible positional form is equivalent to:

```bash
./mq-topology-collector.sh --samples 5 --interval 60
```

A single immediate snapshot is:

```bash
./mq-topology-collector.sh
```

To restrict collection to specific queue managers:

```bash
./mq-topology-collector.sh --qmgr QM_EXT --qmgr QM_INT --samples 5 --interval 60
```

To place the resulting archive elsewhere:

```bash
./mq-topology-collector.sh --output-dir /tmp/mw-topology --samples 5 --interval 60
```

## Raw output

The generated file is named:

```text
mq-topology-<hostname>-<UTC timestamp>.tar.gz
```

Example:

```text
mq-topology-sjeditb18604-20260908T050000Z.tar.gz
```

The archive contains host identity, MQ installation/inventory evidence, static queue-manager definitions, and one or more runtime sample directories.

See [`../../docs/mq-raw-collector-contract-v1.md`](../../docs/mq-raw-collector-contract-v1.md) for the stable archive layout.

## Preferred vNext normalization

Normalize directly to the semantic observation contract on a workstation or controlled middleware host; IBM MQ does not need to be installed on the machine doing the normalization:

```bash
python3 normalize_mq_observations.py \
  mq-topology-sjeditb18604-20260908T050000Z.tar.gz \
  -o mq-observation-bundle-v2.json
```

Override environment classification when needed:

```bash
python3 normalize_mq_observations.py archive.tar.gz \
  --environment prod \
  -o mq-observation-bundle-v2.json
```

The adapter reads the `.tar.gz` directly and rejects unsafe archive members through the shared archive reader. It records the raw archive SHA-256 and size in the source run so the semantic import can be traced to immutable evidence.

The direct adapter produces:

```text
Raw MQ evidence
  -> source run + coverage
  -> canonical identity hints
  -> entity observations
  -> relation observations
  -> unresolved references
```

Key semantics include:

```text
Host
  <- runs_on - Queue Manager Instance
  <- has_instance - Queue Manager

Queue Manager
  -> contains -> Queue / Channel / Listener / other MQ definitions

Application Instance
  -> runtime.connects_via -> SVRCONN
  -> runtime.opens_for_output -> Queue
  -> runtime.opens_for_input  -> Queue

QREMOTE
  -> routing.routes_via -> XMITQ
  -> routing.resolves_to -> destination Queue, when actually collected

XMITQ
  -> routing.transmits_via -> sender Channel
```

An uncollected QREMOTE destination is emitted as an explicit unresolved reference. The adapter does not create a fictitious destination queue merely to complete the path.

### Runtime-sample policy

The raw archive can contain multiple samples. For the **current-state** observation bundle, the adapter selects the latest successful sample independently for each runtime command family. Earlier samples remain in the immutable raw archive for future history/time-series processing.

This prevents a handle or connection seen in an earlier sample but absent from the latest successful enumeration from being presented as current merely because it existed somewhere in the archive.

### Queue-handle semantics

`DISPLAY QSTATUS(*) TYPE(HANDLE)` establishes handle access. Therefore:

- `OUTPUT(YES)` becomes `runtime.opens_for_output`
- input access becomes `runtime.opens_for_input`

These observations do **not** become `activity.put_observed` or `activity.get_observed`. The current collector does not contain evidence proving that a particular MQPUT or MQGET occurred during the sample.

### Coverage and failures

Every relevant MQSC family has explicit coverage. The adapter inspects both the process `.rc` and MQSC output/error text because a `runmqsc` process can complete while individual MQ commands report `AMQ...E` failures.

Coverage is queue-manager scoped where appropriate. For example, if a multi-instance queue manager is reported by `dspmq` as running elsewhere and its MQSC commands fail, another queue manager's successful collection on the same host cannot establish absence for the unavailable queue manager.

Exhaustive configuration enumeration can use `complete` coverage. Runtime enumerations are `point_in_time` and may close earlier runtime assertions only when the adapter explicitly marks that enumeration as absence-authoritative.

## Compatibility normalization

During migration, the existing dashboard can still consume the legacy normalized topology document:

```bash
python3 normalize_mq_topology.py \
  mq-topology-sjeditb18604-20260908T050000Z.tar.gz \
  -o normalized-topology.json
```

That document conforms to [`../../docs/topology-contract-v1.md`](../../docs/topology-contract-v1.md). New semantic-core work should use `normalize_mq_observations.py` instead of adding semantics to the legacy graph format.

## What is captured

Static configuration is captured once per queue manager with MQSC `DISPLAY` commands for:

- Queue manager
- Local, remote, alias, model, and cluster queues
- Channels
- Listeners
- Process definitions
- Namelists
- Services
- Topics
- Subscriptions

Runtime evidence is captured for every requested sample:

- Queue-manager status
- Channel status
- Listener status
- Queue status
- Queue handles
- Application connections
- Connection handles
- Application status when supported by the installed MQ version
- Cluster queue-manager information

Remote queue, XMITQ, sender-channel, cluster, channel-status, connection, and handle evidence can then be correlated centrally without treating configured reachability as proof of message traffic.

## Safety properties

The collector is read-only. It does not issue `ALTER`, `DEFINE`, `DELETE`, `START`, `STOP`, `CLEAR`, `RESET`, `REFRESH`, or message-consuming commands.

It does **not** read message payloads. It also deliberately avoids environment-variable dumps, private key/certificate files, MQ authority exports, `AUTHINFO`, and `CHLAUTH` exports.

MQSC command failures do not abort the archive. Every command has its own `.mqsc`, `.out`, `.err`, and `.rc` files so unsupported commands, inactive multi-instance queue managers, or authority limitations remain explicit evidence rather than being silently discarded.

Before transferring an archive outside the server environment, review its contents according to your organization's data-handling policy. Queue/channel definitions and connection status can contain hostnames, IP addresses, application names, user identifiers, certificate labels, and other operational metadata.

## After collection

Verify the archive exists:

```bash
ls -lh mq-topology-*.tar.gz
```

Optionally inspect the file list without extracting it:

```bash
tar -tzf mq-topology-*.tar.gz | less
```

For the vNext semantic-core workflow, transfer the raw `.tar.gz` through the approved method and normalize it directly to `mq-observation-bundle-v2.json`. Use the legacy normalized topology only while the current Cloudflare UI remains on its compatibility path.
