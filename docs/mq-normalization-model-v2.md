# IBM MQ normalization model v2

This document defines the identity and evidence rules used by the IBM MQ raw-archive normalizer.

## Core rule

Topology identity is based on the identity of the object, not on the role through which the object happened to be observed.

A client address and a channel endpoint can have the same text value without being the same topology concept. Likewise, a queue-manager name is not a different queue manager merely because one archive sees it locally and another sees it remotely.

## Node identity

### Host

A `host` represents an actual system known from collector identity or an MQ client address.

- Collector hostname, FQDN, and local IP aliases are one host identity.
- A client IP is one host identity even when it is observed through multiple queue managers.
- Roles such as `mq_host` and `mq_client` are metadata, not identity dimensions.

`CONNAME` values are **not** treated as physical hosts. They can be DNS aliases, VIPs, load-balanced names, multi-instance endpoints, or raw IP addresses.

### Endpoint

An `endpoint` represents a network address used by MQ configuration/runtime evidence.

Examples:

- sender/cluster sender `CONNAME`
- observed channel peer address
- listener address/port

Endpoints connect to queue managers with `ENDPOINT_FOR` and channels with `USES_ENDPOINT`. This avoids falsely asserting that a network endpoint physically hosts a queue manager.

### Queue manager

A queue manager is canonical by queue-manager identity within the environment, independent of whether it was discovered locally, through channel status, through cluster status, or as a QREMOTE target.

- Local/remote is metadata/evidence, not node identity.
- `QMID` enriches the identity record when available.
- Physical placement is represented separately with `HOSTS` evidence from collector hosts.

This model is required for multi-instance queue managers and future multi-server archive aggregation.

### Queue

A queue is scoped by owning queue manager and queue name. Repeated queue names on different queue managers are legitimate distinct objects.

The normalizer preserves the base definition type (`QLOCAL`, `QREMOTE`, `QALIAS`, `QMODEL`) and treats `DISPLAY QCLUSTER` as cluster visibility/ownership evidence rather than overwriting the base definition type.

Remote QREMOTE targets that are only referenced by configuration are marked `reference_only` / `unverified` until stronger evidence is available.

### Channel

A channel is scoped by queue manager and channel name. The same channel name on two queue managers is not a duplicate.

Static definitions and runtime status are merged into the same channel identity. Automatically discovered cluster sender channels may exist without a corresponding static definition.

### Listener

A listener is scoped by queue manager and listener name. Runtime `LSSTATUS` enriches status, port, PID, backlog, and related evidence.

System default listener definitions remain available but are marked as system objects.

### Application

A client application is canonical by host identity plus observed application tag. Queue-manager name is not part of application identity, so one client program connecting to multiple queue managers remains one application node with multiple relationships.

`APSTATUS` and SVRCONN channel type are used to distinguish actual applications from IBM MQ internal processes.

### MQ process

IBM MQ internal processes such as channel agents and queue-manager workers are represented as `mq_process`, not as remote applications. They run on the MQ collector host and may drive a channel whose `CONNAME` identifies a remote peer.

This prevents `amqrmppa`, `runmqchl`, and similar processes from creating false remote host/application relationships.

## Relationship attribution

Queue handle evidence is attributed directly to the actor that opened the queue.

For applications:

- `Application -> CONNECTS_VIA -> SVRCONN`
- `Application -> PUTS_TO -> Queue` with `via_channel` metadata
- `Application -> GETS_FROM -> Queue` with `via_channel` metadata
- `Queue -> CONSUMED_BY -> Application` for input handles

The normalizer deliberately does not use a shared SVRCONN as the source of an application-specific `PUTS_TO` or `GETS_FROM` edge. Multiple applications can share the same SVRCONN, and doing so would create false cross-product paths.

For MQ-internal processes, queue access remains attributable to the `mq_process` and channel-driving relationships are represented separately.

## Routing

The following configured route evidence is normalized:

- `QREMOTE -> ALIASES_TO -> remote target reference`
- `QREMOTE -> ROUTES_TO -> XMITQ`
- `XMITQ -> TRANSMITS_VIA -> sender channel`
- `QALIAS -> ALIASES_TO -> local or cluster-visible targets`

Runtime channel and cluster status can then extend the route toward remote queue managers and endpoints.

## Evidence discipline

- `observed`: runtime connection/status/handle evidence
- `configured`: static MQ definitions or configured cluster knowledge
- `inferred`: reserved for relationships that cannot be directly established; v2 avoids adding inferred edges merely to complete a visually attractive path

## Collector data not yet promoted to first-class topology nodes

The raw collector also captures process definitions, namelists, services, topics, subscriptions, and additional handle/status evidence. These remain available in the raw archive for later normalization work. They are not silently discarded as evidence, but v2 keeps the operational topology focused on hosts, endpoints, queue managers, queues, channels, listeners, client applications, and MQ runtime processes.
