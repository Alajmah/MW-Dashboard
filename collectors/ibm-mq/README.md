# IBM MQ topology collector

`mq-topology-collector.sh` creates a read-only raw evidence archive for MW-Dashboard. `normalize_mq_topology.py` converts that archive into the normalized topology JSON accepted by the Cloudflare dashboard.

The collector intentionally does **not** construct topology itself. It records IBM MQ configuration and runtime observations in separate files so the normalizer can classify relationships as `configured`, `observed`, or, only when necessary, `inferred`.

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

## Normalize for MW-Dashboard

Run the normalizer on a workstation or controlled middleware host; IBM MQ does not need to be installed on the machine doing the normalization:

```bash
python3 normalize_mq_topology.py \
  mq-topology-sjeditb18604-20260908T050000Z.tar.gz \
  -o normalized-topology.json
```

Override environment classification when needed:

```bash
python3 normalize_mq_topology.py archive.tar.gz \
  --environment prod \
  -o normalized-topology.json
```

The normalizer reads the `.tar.gz` directly and rejects absolute paths, `..` traversal entries, and symbolic/hard links. It does not extract the archive onto disk.

It creates stable node and edge IDs and currently models:

```text
Host
  -> Queue Manager
  -> Queue / Channel / Listener

Client Host
  -> Application
  -> SVRCONN
  -> Queue

QREMOTE
  -> XMITQ
  -> Sender Channel
  -> Remote Queue Manager / endpoint
```

Runtime `DISPLAY CHSTATUS` records are used when available to establish observed remote queue-manager names and endpoint addresses. Queue-handle and connection evidence are used for observed application/SVRCONN/queue relationships. Cluster-advertised queues remain configuration evidence.

The resulting JSON conforms to [`../../docs/topology-contract-v1.md`](../../docs/topology-contract-v1.md) and can be uploaded to the MW-Dashboard manual import endpoint/UI.

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

The connection and handle outputs are especially important for reconstructing:

```text
Host -> Application -> SVRCONN -> Queue
```

Remote queue, XMITQ, sender-channel, cluster, and channel endpoint definitions provide the configured evidence for extending that path toward the destination queue manager.

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

For the current manual workflow, transfer the `.tar.gz` through your approved method, normalize it, then upload the generated `normalized-topology.json` to the dashboard.
