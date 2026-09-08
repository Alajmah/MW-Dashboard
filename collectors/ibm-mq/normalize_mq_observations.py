#!/usr/bin/env python3
"""Normalize an IBM MQ raw collector archive directly to ObservationBundle v2.

This adapter intentionally does not build the legacy nodes/edges topology first.
It preserves configured versus observed evidence, emits queue-handle access as
runtime.open_* semantics, and records incomplete remote resolution explicitly.
"""

import argparse
import hashlib
import json
import os
import re
from pathlib import PurePosixPath

from normalize_mq_topology import Archive, conname_host, infer_env, parse_blocks, parse_conname_endpoints

SCHEMA_VERSION = "osi.observation.bundle/v2"
NORMALIZER_VERSION = "3.0.0"
MQ_ERROR_RE = re.compile(r"\b(AMQ\d{4}E):", re.IGNORECASE)
DSPMQ_RE = re.compile(r"QMNAME\(([^)]+)\).*STATUS\(([^)]+)\)", re.IGNORECASE)


def sha256_text(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def stable_ref(prefix, *parts):
    raw = "|".join(str(p) for p in parts)
    return f"{prefix}_{sha256_text(raw)[:20]}"


def scalar_hints(values):
    out = {}
    for key, value in (values or {}).items():
        if value is None:
            continue
        if isinstance(value, (str, int, float, bool)):
            if isinstance(value, str):
                value = value.strip()
                if not value:
                    continue
            out[key] = value
        else:
            rendered = str(value).strip()
            if rendered:
                out[key] = rendered
    return out


def merge_properties(dst, src):
    for key, value in (src or {}).items():
        if value in (None, "", []):
            continue
        if key not in dst or dst[key] in (None, "", []):
            dst[key] = value
            continue
        if dst[key] == value:
            continue
        old = dst[key] if isinstance(dst[key], list) else [dst[key]]
        new = value if isinstance(value, list) else [value]
        merged = []
        for item in old + new:
            if item not in merged:
                merged.append(item)
        dst[key] = merged
    return dst


def archive_has(archive, rel):
    wanted = f"{archive.root}/{rel}"
    return any(m.name == wanted and m.isfile() for m in archive.tf.getmembers())


def read_rc(archive, base):
    rel = base + ".rc"
    if not archive_has(archive, rel):
        return None
    raw = archive.text(rel, False).strip()
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def command_health(archive, base, success_mode):
    out_rel = base + ".out"
    err_rel = base + ".err"
    rc = read_rc(archive, base)
    if rc is None and not archive_has(archive, out_rel):
        return {
            "mode": "not_collected",
            "evidence_ref": out_rel,
            "error": "command evidence missing",
            "properties": {"command_base": base},
        }
    out = archive.text(out_rel, False)
    err = archive.text(err_rel, False)
    error_codes = sorted(set(MQ_ERROR_RE.findall(out + "\n" + err)))
    if rc not in (None, 0) or error_codes:
        details = []
        if rc not in (None, 0):
            details.append(f"process rc={rc}")
        if error_codes:
            details.append("MQ errors=" + ",".join(error_codes))
        return {
            "mode": "failed",
            "evidence_ref": out_rel,
            "error": "; ".join(details) or "command failed",
            "properties": {
                "command_base": base,
                "process_rc": rc,
                "mq_error_codes": error_codes,
            },
        }
    return {
        "mode": success_mode,
        "evidence_ref": out_rel,
        "error": None,
        "properties": {"command_base": base, "process_rc": rc if rc is not None else 0},
    }


def aggregate_health(states, success_mode):
    if not states:
        return {"mode": "not_collected", "error": "no command evidence", "properties": {}}
    modes = [s["mode"] for s in states]
    if all(mode == success_mode for mode in modes):
        mode = success_mode
    elif all(mode in ("failed", "not_collected") for mode in modes):
        mode = "failed" if "failed" in modes else "not_collected"
    else:
        mode = "partial"
    errors = [s.get("error") for s in states if s.get("error")]
    return {
        "mode": mode,
        "error": "; ".join(errors) if errors else None,
        "evidence_ref": states[0].get("evidence_ref"),
        "properties": {
            "command_evidence": [s.get("evidence_ref") for s in states if s.get("evidence_ref")],
            "component_modes": modes,
        },
    }


class BundleBuilder:
    def __init__(self, run, artifact):
        self.bundle = {
            "schema_version": SCHEMA_VERSION,
            "run": run,
            "coverage": [],
            "entities": [],
            "relations": [],
            "unresolved_references": [],
        }
        if artifact:
            self.bundle["run"]["artifact"] = artifact
        self._entity_keys = {}
        self._relation_keys = {}
        self._coverage = {}
        self._unresolved_keys = {}
        self._entity_type_by_ref = {}

    def entity(self, semantic_type, hints, display_name, observed_at, evidence_class,
               evidence_ref=None, status=None, properties=None):
        hints = scalar_hints(hints)
        key = (
            semantic_type,
            json.dumps(hints, sort_keys=True, separators=(",", ":")),
            evidence_class,
            evidence_ref or "",
        )
        if key in self._entity_keys:
            ref = self._entity_keys[key]
            item = next(x for x in self.bundle["entities"] if x["ref"] == ref)
            merge_properties(item["properties"], properties or {})
            if status:
                item["status"] = status
            if observed_at and observed_at > item["observed_at"]:
                item["observed_at"] = observed_at
            return ref
        ref = stable_ref("ent", semantic_type, key[1], evidence_class, evidence_ref or "")
        item = {
            "ref": ref,
            "semantic_type": semantic_type,
            "identity": {"hints": hints},
            "display_name": display_name,
            "observed_at": observed_at,
            "evidence_class": evidence_class,
            "properties": dict(properties or {}),
        }
        if status:
            item["status"] = status
        if evidence_ref:
            item["evidence_ref"] = evidence_ref
        self.bundle["entities"].append(item)
        self._entity_keys[key] = ref
        self._entity_type_by_ref[ref] = semantic_type
        return ref

    def relation(self, semantic_type, source_ref, target_ref, observed_at, evidence_class,
                 evidence_ref=None, properties=None, derivation_method=None,
                 deterministic=None, confidence=None):
        if source_ref not in self._entity_type_by_ref or target_ref not in self._entity_type_by_ref:
            raise ValueError(f"relation endpoint missing for {semantic_type}: {source_ref} -> {target_ref}")
        key = (semantic_type, source_ref, target_ref, evidence_class, evidence_ref or "")
        if key in self._relation_keys:
            return self._relation_keys[key]
        ref = stable_ref("rel", *key)
        item = {
            "ref": ref,
            "semantic_type": semantic_type,
            "source_ref": source_ref,
            "target_ref": target_ref,
            "observed_at": observed_at,
            "evidence_class": evidence_class,
            "properties": dict(properties or {}),
        }
        if evidence_ref:
            item["evidence_ref"] = evidence_ref
        if derivation_method:
            item["derivation_method"] = derivation_method
        if deterministic is not None:
            item["deterministic"] = bool(deterministic)
        if confidence is not None:
            item["confidence"] = float(confidence)
        self.bundle["relations"].append(item)
        self._relation_keys[key] = ref
        return ref

    def unresolved(self, source_ref, semantic_type, expected_target_type, vendor_value,
                   state, reason, observed_at, evidence_class, evidence_ref=None,
                   properties=None, candidate_refs=None):
        key = (source_ref, semantic_type, expected_target_type, vendor_value, evidence_ref or "")
        if key in self._unresolved_keys:
            return self._unresolved_keys[key]
        ref = stable_ref("unres", *key)
        item = {
            "ref": ref,
            "source_ref": source_ref,
            "semantic_type": semantic_type,
            "expected_target_type": expected_target_type,
            "vendor_value": vendor_value,
            "state": state,
            "reason": reason,
            "observed_at": observed_at,
            "evidence_class": evidence_class,
            "properties": dict(properties or {}),
        }
        if evidence_ref:
            item["evidence_ref"] = evidence_ref
        if candidate_refs:
            item["candidate_refs"] = list(candidate_refs)
        self.bundle["unresolved_references"].append(item)
        self._unresolved_keys[key] = ref
        return ref

    def coverage(self, scope_type, scope_key, object_class, mode, evidence_ref=None,
                 error=None, properties=None):
        key = (scope_type, scope_key, object_class)
        item = {
            "scope_type": scope_type,
            "scope_key": scope_key,
            "object_class": object_class,
            "mode": mode,
            "properties": dict(properties or {}),
        }
        if evidence_ref:
            item["evidence_ref"] = evidence_ref
        if error:
            item["error"] = error
        self._coverage[key] = item

    def finish(self):
        self.bundle["coverage"] = sorted(
            self._coverage.values(),
            key=lambda x: (x["scope_type"], x["scope_key"], x["object_class"]),
        )
        self.bundle["entities"].sort(key=lambda x: (x["semantic_type"], x["display_name"], x["ref"]))
        self.bundle["relations"].sort(key=lambda x: (x["semantic_type"], x["source_ref"], x["target_ref"], x["ref"]))
        self.bundle["unresolved_references"].sort(key=lambda x: (x["semantic_type"], x["vendor_value"], x["ref"]))
        return self.bundle


def qmgr_rows(archive):
    rows = []
    for line in archive.text("qmgrs.tsv").splitlines()[1:]:
        if "\t" not in line:
            continue
        qdir, qname = line.split("\t", 1)
        qdir = qdir.strip()
        qname = qname.strip()
        if qdir and qname:
            rows.append((qdir, qname))
    return rows


def runtime_samples(archive, qdir):
    samples = set()
    for rel in archive.members(f"qmgr/{qdir}/runtime/"):
        parts = PurePosixPath(rel).parts
        if len(parts) > 4 and parts[0] == "qmgr" and parts[1] == qdir and parts[2] == "runtime":
            samples.add(parts[3])
    return sorted(samples)


def latest_successful_sample(archive, qdir, label):
    selected = None
    for sample in runtime_samples(archive, qdir):
        base = f"qmgr/{qdir}/runtime/{sample}/{label}"
        health = command_health(archive, base, "point_in_time")
        if health["mode"] == "point_in_time":
            selected = (sample, base, health)
    return selected


def sample_time(archive, qdir, sample, fallback):
    value = archive.text(f"qmgr/{qdir}/runtime/{sample}/captured-at-utc.txt", False).strip()
    return value or fallback


def parse_dspmq(archive):
    out = {}
    for line in archive.text("mq/dspmq.out", False).splitlines():
        m = DSPMQ_RE.search(line)
        if m:
            out[m.group(1).strip()] = m.group(2).strip()
    return out


def runtime_role(status):
    value = (status or "").strip().lower()
    if "running as standby" in value or value == "standby":
        return "standby"
    if "running elsewhere" in value:
        return "not_active"
    if "running" in value or value == "active":
        return "active"
    if "ended" in value:
        return "inactive"
    return "unknown"


def normalize(archive_path, environment=None):
    archive = Archive(archive_path)
    manifest = dict(
        line.split("=", 1)
        for line in archive.text("manifest.properties").splitlines()
        if "=" in line
    )
    if manifest.get("format") != "osi-mq-topology-raw":
        raise ValueError(f"unsupported raw archive format: {manifest.get('format')!r}")
    if manifest.get("format_version") != "1":
        raise ValueError(f"unsupported raw archive format_version: {manifest.get('format_version')!r}")

    completed_at = manifest.get("completed_at_utc")
    if not completed_at:
        raise ValueError("manifest completed_at_utc is required")
    started_at = manifest.get("started_at_utc")
    host = archive.text("host/hostname.out", False).strip() or manifest.get("host") or "unknown"
    fqdn = archive.text("host/hostname-fqdn.out", False).strip()
    env = environment or infer_env(fqdn)

    ips = []
    for line in archive.text("host/ip-addresses.out", False).splitlines():
        m = re.search(r"\binet (\d+\.\d+\.\d+\.\d+)/", line)
        if m and not m.group(1).startswith("127.") and m.group(1) not in ips:
            ips.append(m.group(1))
    primary_ip = ips[0] if ips else None
    source_id = (fqdn or host).strip().lower()
    host_key = source_id

    with open(archive_path, "rb") as fh:
        archive_bytes = fh.read()
    artifact = {
        "sha256": hashlib.sha256(archive_bytes).hexdigest(),
        "media_type": "application/gzip",
        "size_bytes": len(archive_bytes),
    }
    run_id = "mqv2:" + sha256_text(f"{source_id}|{completed_at}|{artifact['sha256']}")[:24]
    run = {
        "run_id": run_id,
        "environment": env,
        "collector": "mq-topology-collector.sh",
        "collector_version": manifest.get("collector_version"),
        "normalizer_version": NORMALIZER_VERSION,
        "completed_at": completed_at,
        "source": {"kind": "ibm_mq_host", "id": source_id, "display_name": host},
        "metadata": {
            "raw_format": manifest.get("format"),
            "raw_format_version": manifest.get("format_version"),
            "runtime_samples_available": int(manifest.get("samples") or 0),
            "runtime_interval_seconds": int(manifest.get("interval_seconds") or 0),
            "normalization_policy": "latest-successful-runtime-sample-for-current-state",
        },
    }
    if started_at:
        run["started_at"] = started_at
    b = BundleBuilder(run, artifact)

    host_hints = {"fqdn": fqdn, "primary_ip": primary_ip, "name": host}
    host_ref = b.entity(
        "infra.host",
        host_hints,
        host,
        completed_at,
        "observed",
        "host/hostname.out",
        properties={
            "fqdn": fqdn or None,
            "primary_ip": primary_ip,
            "ips": ips,
            "collector_host": True,
        },
    )

    dspmq_health = command_health(archive, "mq/dspmq", "complete")
    for object_class in ("mq.queue_manager", "mq.queue_manager_instance"):
        b.coverage(
            "source", source_id, object_class, dspmq_health["mode"],
            dspmq_health.get("evidence_ref"), dspmq_health.get("error"), dspmq_health.get("properties"),
        )
    dspmq_status = parse_dspmq(archive)

    qrows = qmgr_rows(archive)
    qmgr_ref = {}
    qmgr_qmid = {}
    queue_ref = {}
    channel_ref = {}
    listener_ref = {}
    endpoint_ref = {}
    channel_type = {}
    pending_alias = []
    pending_remote = []
    pending_channel_xmitq = []

    def ensure_endpoint(raw, evidence_class, evidence_ref, observed_at, role, properties=None):
        refs = []
        for ep in parse_conname_endpoints(raw):
            identity = {"host": ep.get("host"), "port": ep.get("port"), "raw": ep.get("raw")}
            key = (ep.get("host", "").lower(), str(ep.get("port") or ""), evidence_class, evidence_ref)
            if key in endpoint_ref:
                refs.append(endpoint_ref[key])
                continue
            display = ep.get("host", "")
            if ep.get("port"):
                display += ":" + str(ep.get("port"))
            ref = b.entity(
                "infra.network_endpoint", identity, display or ep.get("raw") or "endpoint",
                observed_at, evidence_class, evidence_ref,
                properties={
                    "host": ep.get("host"),
                    "port": ep.get("port") or None,
                    "raw": ep.get("raw"),
                    "role": role,
                    **(properties or {}),
                },
            )
            endpoint_ref[key] = ref
            refs.append(ref)
        return refs

    # dspmq establishes that a logical queue manager is visible from this host and
    # provides the local instance disposition without requiring runmqsc access.
    for qdir, qname in qrows:
        status = dspmq_status.get(qname, "unknown")
        qm_ref = b.entity(
            "mq.queue_manager", {"name": qname}, qname, completed_at, "observed",
            "mq/dspmq.out", status=status,
            properties={"queue_manager": qname, "dspmq_status": status, "local_to_archive": True},
        )
        qmgr_ref[qname] = qm_ref
        instance_ref = b.entity(
            "mq.queue_manager_instance",
            {"queue_manager_key": qname, "host_key": host_key},
            f"{qname} @ {host}", completed_at, "observed", "mq/dspmq.out", status=status,
            properties={
                "queue_manager": qname,
                "host_key": host_key,
                "dspmq_status": status,
                "runtime_role": runtime_role(status),
            },
        )
        b.relation(
            "has_instance", qm_ref, instance_ref, completed_at, "observed", "mq/dspmq.out",
            properties={"queue_manager": qname, "dspmq_status": status},
        )
        b.relation(
            "runs_on", instance_ref, host_ref, completed_at, "observed", "mq/dspmq.out",
            properties={"queue_manager": qname, "host_key": host_key},
        )

    # Requested queue managers may be present in qmgrs.tsv even if dspmq parsing
    # did not produce a status line.
    for qdir, qname in qrows:
        if qname not in qmgr_ref:
            qmgr_ref[qname] = b.entity(
                "mq.queue_manager", {"name": qname}, qname, completed_at, "declared",
                "qmgrs.tsv", properties={"queue_manager": qname, "local_to_archive": True},
            )

    config_coverage = {
        "qmgr": "mq.queue_manager",
        "channels": "mq.channel",
        "listeners": "mq.listener",
        "processes": "mq.process_definition",
        "namelists": "mq.namelist",
        "services": "mq.service",
        "topics": "mq.topic",
        "subscriptions": "mq.subscription",
    }

    for qdir, qname in qrows:
        qm_source_ref = qmgr_ref[qname]
        qbase = f"qmgr/{qdir}/config/qmgr"
        qhealth = command_health(archive, qbase, "complete")
        b.coverage("queue_manager", qname, "mq.queue_manager", qhealth["mode"], qhealth.get("evidence_ref"), qhealth.get("error"), qhealth.get("properties"))
        if qhealth["mode"] == "complete":
            blocks = parse_blocks(archive.text(qbase + ".out", False))
            if blocks:
                rec = blocks[0]
                qmid = rec.get("QMID", "").strip() if isinstance(rec.get("QMID", ""), str) else str(rec.get("QMID", ""))
                hints = {"name": qname}
                if qmid:
                    hints["qmid"] = qmid
                    qmgr_qmid[qname] = qmid
                cfg_ref = b.entity(
                    "mq.queue_manager", hints, qname, completed_at, "configured", qbase + ".out",
                    properties={
                        "queue_manager": qname,
                        "qmid": qmid or None,
                        "description": rec.get("DESCR") or None,
                        "cmdlevel": rec.get("CMDLEVEL") or None,
                        "platform": rec.get("PLATFORM") or None,
                        "version": rec.get("VERSION") or None,
                        "repos": rec.get("REPOS") or None,
                    },
                )
                qm_source_ref = cfg_ref
                qmgr_ref[qname] = cfg_ref

        queue_states = [
            command_health(archive, f"qmgr/{qdir}/config/{label}", "complete")
            for label in ("queues-local", "queues-remote", "queues-alias", "queues-model")
        ]
        queue_health = aggregate_health(queue_states, "complete")
        b.coverage("queue_manager", qname, "mq.queue", queue_health["mode"], queue_health.get("evidence_ref"), queue_health.get("error"), queue_health.get("properties"))

        for label, queue_type in (
            ("queues-local", "QLOCAL"),
            ("queues-remote", "QREMOTE"),
            ("queues-alias", "QALIAS"),
            ("queues-model", "QMODEL"),
        ):
            base = f"qmgr/{qdir}/config/{label}"
            health = command_health(archive, base, "complete")
            if health["mode"] != "complete":
                continue
            for rec in parse_blocks(archive.text(base + ".out", False)):
                name = rec.get("QUEUE") or rec.get("QNAME")
                if not name:
                    continue
                props = {
                    "queue_manager": qname,
                    "queue_type": queue_type,
                    "system": str(name).startswith("SYSTEM."),
                }
                for attr in ("USAGE", "RNAME", "RQMNAME", "XMITQ", "TARGET", "CLUSTER", "CLUSNL", "DESCR", "PUT", "GET", "DEFBIND", "DEFPSIST", "MAXDEPTH", "MAXMSGL"):
                    if rec.get(attr) not in (None, ""):
                        props[attr.lower()] = rec.get(attr)
                ref = b.entity(
                    "mq.queue", {"queue_manager_key": qname, "name": name}, name,
                    completed_at, "configured", base + ".out", properties=props,
                )
                queue_ref[(qname, name)] = ref
                b.relation(
                    "contains", qm_source_ref, ref, completed_at, "configured", base + ".out",
                    properties={"queue_manager": qname, "queue_type": queue_type},
                )
                if queue_type == "QALIAS" and rec.get("TARGET"):
                    pending_alias.append((qname, ref, rec.get("TARGET"), base + ".out"))
                if queue_type == "QREMOTE":
                    pending_remote.append((qname, ref, rec, base + ".out"))

        for label, object_class in config_coverage.items():
            if label == "qmgr":
                continue
            base = f"qmgr/{qdir}/config/{label}"
            health = command_health(archive, base, "complete")
            b.coverage("queue_manager", qname, object_class, health["mode"], health.get("evidence_ref"), health.get("error"), health.get("properties"))

        channels_base = f"qmgr/{qdir}/config/channels"
        if command_health(archive, channels_base, "complete")["mode"] == "complete":
            for rec in parse_blocks(archive.text(channels_base + ".out", False)):
                name = rec.get("CHANNEL")
                if not name:
                    continue
                ctype = rec.get("CHLTYPE", "")
                props = {"queue_manager": qname, "channel_type": ctype, "system": str(name).startswith("SYSTEM.")}
                for attr in ("CONNAME", "XMITQ", "MCAUSER", "SSLCIPH", "SSLCAUTH", "CLUSTER", "CLUSNL", "DESCR", "TRPTYPE"):
                    if rec.get(attr) not in (None, ""):
                        props[attr.lower()] = rec.get(attr)
                ref = b.entity(
                    "mq.channel", {"queue_manager_key": qname, "name": name}, name,
                    completed_at, "configured", channels_base + ".out", properties=props,
                )
                channel_ref[(qname, name)] = ref
                channel_type[(qname, name)] = ctype
                b.relation(
                    "contains", qm_source_ref, ref, completed_at, "configured", channels_base + ".out",
                    properties={"queue_manager": qname, "channel_type": ctype},
                )
                if rec.get("CONNAME"):
                    for ep_ref in ensure_endpoint(rec.get("CONNAME"), "configured", channels_base + ".out", completed_at, "channel_target", {"queue_manager": qname, "channel": name}):
                        b.relation(
                            "network.uses_endpoint", ref, ep_ref, completed_at, "configured", channels_base + ".out",
                            properties={"queue_manager": qname, "channel": name},
                        )
                if rec.get("XMITQ"):
                    pending_channel_xmitq.append((qname, rec.get("XMITQ"), ref, channels_base + ".out"))

        listeners_base = f"qmgr/{qdir}/config/listeners"
        if command_health(archive, listeners_base, "complete")["mode"] == "complete":
            for rec in parse_blocks(archive.text(listeners_base + ".out", False)):
                name = rec.get("LISTENER")
                if not name:
                    continue
                props = {"queue_manager": qname, "system": str(name).startswith("SYSTEM.")}
                for attr in ("TRPTYPE", "CONTROL", "IPADDR", "PORT", "DESCR"):
                    if rec.get(attr) not in (None, ""):
                        props[attr.lower()] = rec.get(attr)
                ref = b.entity(
                    "mq.listener", {"queue_manager_key": qname, "name": name}, name,
                    completed_at, "configured", listeners_base + ".out", properties=props,
                )
                listener_ref[(qname, name)] = ref
                b.relation(
                    "contains", qm_source_ref, ref, completed_at, "configured", listeners_base + ".out",
                    properties={"queue_manager": qname},
                )
                port = str(rec.get("PORT") or "").strip()
                if port and port != "0":
                    raw_endpoint = f"{host}({port})"
                    for ep_ref in ensure_endpoint(raw_endpoint, "configured", listeners_base + ".out", completed_at, "listener", {"queue_manager": qname, "listener": name}):
                        b.relation(
                            "network.listens_on", ref, ep_ref, completed_at, "configured", listeners_base + ".out",
                            properties={"queue_manager": qname, "listener": name},
                        )
                        b.relation(
                            "network.endpoint_for", ep_ref, qm_source_ref, completed_at, "configured", listeners_base + ".out",
                            properties={"queue_manager": qname, "listener": name},
                        )

        simple_objects = (
            ("processes", "PROCESS", "mq.process_definition"),
            ("namelists", "NAMELIST", "mq.namelist"),
            ("services", "SERVICE", "mq.service"),
            ("topics", "TOPIC", "mq.topic"),
            ("subscriptions", "SUBNAME", "mq.subscription"),
        )
        for label, name_attr, semantic_type in simple_objects:
            base = f"qmgr/{qdir}/config/{label}"
            if command_health(archive, base, "complete")["mode"] != "complete":
                continue
            for rec in parse_blocks(archive.text(base + ".out", False)):
                name = rec.get(name_attr)
                if not name and semantic_type == "mq.topic":
                    name = rec.get("TOPICSTR")
                if not name:
                    continue
                ref = b.entity(
                    semantic_type, {"queue_manager_key": qname, "name": name}, name,
                    completed_at, "configured", base + ".out",
                    properties={"queue_manager": qname, "raw_attributes": rec},
                )
                b.relation(
                    "contains", qm_source_ref, ref, completed_at, "configured", base + ".out",
                    properties={"queue_manager": qname},
                )

        # Cluster queue visibility is an MQ-observed view of remote/local cluster
        # instances, not a complete queue definition enumeration.
        cluster_base = f"qmgr/{qdir}/config/queues-cluster"
        cluster_health = command_health(archive, cluster_base, "point_in_time")
        b.coverage("queue_manager", qname, "relation:mq.cluster_discovers", cluster_health["mode"], cluster_health.get("evidence_ref"), cluster_health.get("error"), {**cluster_health.get("properties", {}), "absence_closes_assertions": cluster_health["mode"] == "point_in_time"})
        if cluster_health["mode"] == "point_in_time":
            for rec in parse_blocks(archive.text(cluster_base + ".out", False)):
                name = rec.get("QUEUE")
                owner = rec.get("CLUSQMGR")
                if not name or not owner:
                    continue
                owner_ref = qmgr_ref.get(owner)
                if not owner_ref:
                    owner_ref = b.entity(
                        "mq.queue_manager", {"name": owner}, owner, completed_at, "observed", cluster_base + ".out",
                        properties={"queue_manager": owner, "reference_only": True, "cluster_visible_from": qname},
                    )
                    qmgr_ref[owner] = owner_ref
                remote_q_ref = queue_ref.get((owner, name))
                if not remote_q_ref:
                    remote_q_ref = b.entity(
                        "mq.queue", {"queue_manager_key": owner, "name": name}, name,
                        completed_at, "observed", cluster_base + ".out",
                        properties={
                            "queue_manager": owner,
                            "queue_type": "QCLUSTER_VISIBLE",
                            "cluster": rec.get("CLUSTER") or None,
                            "cluster_owner": owner,
                            "cluster_queue_type": rec.get("CLUSQT") or None,
                            "reference_only": owner not in dict(qrows).values(),
                        },
                    )
                    queue_ref[(owner, name)] = remote_q_ref
                b.relation(
                    "contains", owner_ref, remote_q_ref, completed_at, "observed", cluster_base + ".out",
                    properties={"queue_manager": owner, "cluster": rec.get("CLUSTER") or None},
                )
                b.relation(
                    "mq.cluster_discovers", qm_source_ref, remote_q_ref, completed_at, "observed", cluster_base + ".out",
                    properties={"queue_manager": qname, "cluster": rec.get("CLUSTER") or None, "owner_queue_manager": owner},
                )

    # Resolve configured queue aliases/remotes only after all locally collected
    # queue definitions have been indexed.
    for qname, alias_ref, target_name, evidence_ref in pending_alias:
        target_ref = queue_ref.get((qname, target_name))
        if target_ref:
            b.relation(
                "routing.resolves_to", alias_ref, target_ref, completed_at, "configured", evidence_ref,
                properties={"queue_manager": qname, "resolution": "local_alias_target"},
            )
        else:
            b.unresolved(
                alias_ref, "routing.resolves_to", "mq.queue", f"{qname}:{target_name}",
                "unresolved", "alias_target_not_collected", completed_at, "configured", evidence_ref,
                properties={"queue_manager": qname, "target_queue": target_name},
            )

    for qname, remote_ref, rec, evidence_ref in pending_remote:
        remote_qmgr = str(rec.get("RQMNAME") or "").strip()
        remote_name = str(rec.get("RNAME") or "").strip()
        xmitq = str(rec.get("XMITQ") or "").strip()
        if remote_qmgr and remote_qmgr not in qmgr_ref:
            qmgr_ref[remote_qmgr] = b.entity(
                "mq.queue_manager", {"name": remote_qmgr}, remote_qmgr, completed_at, "configured", evidence_ref,
                properties={"queue_manager": remote_qmgr, "reference_only": True, "referenced_by_qremote": True},
            )
        if remote_qmgr and remote_name:
            target_ref = queue_ref.get((remote_qmgr, remote_name))
            if target_ref:
                b.relation(
                    "routing.resolves_to", remote_ref, target_ref, completed_at, "configured", evidence_ref,
                    properties={"queue_manager": qname, "remote_queue_manager": remote_qmgr},
                )
            else:
                b.unresolved(
                    remote_ref, "routing.resolves_to", "mq.queue", f"{remote_qmgr}:{remote_name}",
                    "unresolved", "remote_queue_target_not_collected", completed_at, "configured", evidence_ref,
                    properties={"queue_manager": qname, "remote_queue_manager": remote_qmgr, "remote_queue": remote_name},
                )
        elif remote_qmgr:
            b.unresolved(
                remote_ref, "routing.resolves_to", "mq.queue", remote_qmgr,
                "unresolved", "remote_queue_name_unspecified", completed_at, "configured", evidence_ref,
                properties={"queue_manager": qname, "remote_queue_manager": remote_qmgr},
            )
        if xmitq:
            xmit_ref = queue_ref.get((qname, xmitq))
            if xmit_ref:
                b.relation(
                    "routing.routes_via", remote_ref, xmit_ref, completed_at, "configured", evidence_ref,
                    properties={"queue_manager": qname, "remote_queue_manager": remote_qmgr, "xmitq": xmitq},
                )
            else:
                b.unresolved(
                    remote_ref, "routing.routes_via", "mq.queue", f"{qname}:{xmitq}",
                    "unresolved", "transmission_queue_not_collected", completed_at, "configured", evidence_ref,
                    properties={"queue_manager": qname, "xmitq": xmitq},
                )

    for qname, xmitq, ch_ref, evidence_ref in pending_channel_xmitq:
        xmit_ref = queue_ref.get((qname, xmitq))
        if xmit_ref:
            b.relation(
                "routing.transmits_via", xmit_ref, ch_ref, completed_at, "configured", evidence_ref,
                properties={"queue_manager": qname, "xmitq": xmitq},
            )
        else:
            b.unresolved(
                ch_ref, "routing.transmits_via", "mq.queue", f"{qname}:{xmitq}",
                "unresolved", "channel_xmitq_not_collected", completed_at, "configured", evidence_ref,
                properties={"queue_manager": qname, "xmitq": xmitq},
            )

    # Runtime current-state projection: select only the latest successful sample
    # for each command family. Earlier samples remain available in the raw artifact.
    logical_app_ref = {}
    app_instance_ref = {}
    process_ref = {}

    def actor_for(qname, rec, observed_at, evidence_ref):
        app = str(rec.get("APPLTAG") or "").strip()
        if not app:
            return None, None
        channel = str(rec.get("CHANNEL") or "").strip()
        conname = str(rec.get("CONNAME") or "").strip()
        client_host = conname_host(conname)
        ctype = channel_type.get((qname, channel), "")
        is_client = ctype == "SVRCONN"
        if is_client:
            logical_key = app.strip().lower()
            logical_ref = logical_app_ref.get(logical_key)
            if not logical_ref:
                logical_ref = b.entity(
                    "app.application", {"canonical_key": logical_key, "name": app}, app,
                    observed_at, "inferred", evidence_ref,
                    properties={"derivation_method": "group_runtime_application_instances_by_appltag", "application_name": app},
                )
                logical_app_ref[logical_key] = logical_ref
            instance_key = f"{logical_key}|{(client_host or ('qmgr:' + qname)).lower()}"
            inst_ref = app_instance_ref.get(instance_key)
            if not inst_ref:
                inst_ref = b.entity(
                    "app.application_instance", {"canonical_key": instance_key, "name": app}, app,
                    observed_at, "observed", evidence_ref,
                    properties={
                        "queue_manager": qname,
                        "client_host": client_host or None,
                        "application_type": rec.get("APPLTYPE") or None,
                        "user_id": rec.get("USERID") or None,
                    },
                )
                app_instance_ref[instance_key] = inst_ref
                b.relation(
                    "has_instance", logical_ref, inst_ref, observed_at, "inferred", evidence_ref,
                    properties={"queue_manager": qname, "derivation_method": "appltag_and_client_host_grouping"},
                    derivation_method="appltag_and_client_host_grouping", deterministic=False,
                )
            if conname:
                for ep_ref in ensure_endpoint(conname, "observed", evidence_ref, observed_at, "mq_client_peer", {"queue_manager": qname, "application": app}):
                    b.relation(
                        "network.uses_endpoint", inst_ref, ep_ref, observed_at, "observed", evidence_ref,
                        properties={"queue_manager": qname, "application": app},
                    )
            ch_ref = channel_ref.get((qname, channel))
            if ch_ref:
                b.relation(
                    "runtime.connects_via", inst_ref, ch_ref, observed_at, "observed", evidence_ref,
                    properties={"queue_manager": qname, "channel": channel, "conname": conname or None},
                )
            return inst_ref, "application"

        pid = str(rec.get("PID") or "").strip()
        pkey = f"{qname.lower()}|{app.lower()}|{pid or 'unknown'}"
        ref = process_ref.get(pkey)
        if not ref:
            hints = {"canonical_key": pkey, "queue_manager_key": qname}
            if pid:
                hints["pid"] = pid
            ref = b.entity(
                "mq.runtime_process", hints, app, observed_at, "observed", evidence_ref,
                properties={
                    "queue_manager": qname,
                    "pid": pid or None,
                    "application_type": rec.get("APPLTYPE") or None,
                    "user_id": rec.get("USERID") or None,
                    "internal_mq_process": True,
                },
            )
            process_ref[pkey] = ref
            b.relation(
                "runtime.runs_process", qmgr_ref[qname], ref, observed_at, "observed", evidence_ref,
                properties={"queue_manager": qname},
            )
        ch_ref = channel_ref.get((qname, channel))
        if ch_ref:
            b.relation(
                "runtime.drives_channel", ref, ch_ref, observed_at, "observed", evidence_ref,
                properties={"queue_manager": qname, "channel": channel, "peer": conname or None},
            )
        return ref, "process"

    for qdir, qname in qrows:
        samples = runtime_samples(archive, qdir)
        if not samples:
            continue
        run["metadata"].setdefault("selected_runtime_samples", {})[qname] = {}

        selected_qmgr = latest_successful_sample(archive, qdir, "qmgr-status")
        if selected_qmgr:
            sample, base, _ = selected_qmgr
            observed_at = sample_time(archive, qdir, sample, completed_at)
            run["metadata"]["selected_runtime_samples"][qname]["qmgr-status"] = sample
            for rec in parse_blocks(archive.text(base + ".out", False)):
                if rec.get("QMNAME") and rec.get("QMNAME") != qname:
                    continue
                b.entity(
                    "mq.queue_manager", {"qmid": qmgr_qmid.get(qname), "name": qname}, qname,
                    observed_at, "observed", base + ".out", status=rec.get("STATUS") or dspmq_status.get(qname),
                    properties={
                        "queue_manager": qname,
                        "runtime_hostname": rec.get("HOSTNAME") or None,
                        "runtime_instance": rec.get("INSTNAME") or None,
                        "runtime_datpath": rec.get("DATPATH") or None,
                        "runtime_logpath": rec.get("LOGPATH") or None,
                        "runtime_conns": rec.get("CONNS") or None,
                        "runtime_chinit": rec.get("CHINIT") or None,
                        "runtime_cmdserv": rec.get("CMDSERV") or None,
                        "runtime_sample": sample,
                    },
                )

        selected_channels = latest_successful_sample(archive, qdir, "channel-status")
        if selected_channels:
            sample, base, health = selected_channels
            observed_at = sample_time(archive, qdir, sample, completed_at)
            run["metadata"]["selected_runtime_samples"][qname]["channel-status"] = sample
            b.coverage(
                "queue_manager", qname, "relation:network.connects_to", "point_in_time",
                base + ".out", properties={"absence_closes_assertions": True, "selected_sample": sample},
            )
            for rec in parse_blocks(archive.text(base + ".out", False)):
                ch = rec.get("CHANNEL")
                if not ch:
                    continue
                ch_ref = channel_ref.get((qname, ch))
                ctype = rec.get("CHLTYPE") or channel_type.get((qname, ch), "")
                if not ch_ref:
                    ch_ref = b.entity(
                        "mq.channel", {"queue_manager_key": qname, "name": ch}, ch,
                        observed_at, "observed", base + ".out", status=rec.get("STATUS"),
                        properties={"queue_manager": qname, "channel_type": ctype, "runtime_only": True},
                    )
                    channel_ref[(qname, ch)] = ch_ref
                    channel_type[(qname, ch)] = ctype
                rqm = str(rec.get("RQMNAME") or "").strip()
                conname = str(rec.get("CONNAME") or "").strip()
                if conname:
                    for ep_ref in ensure_endpoint(conname, "observed", base + ".out", observed_at, "channel_peer", {"queue_manager": qname, "channel": ch}):
                        b.relation(
                            "network.uses_endpoint", ch_ref, ep_ref, observed_at, "observed", base + ".out",
                            properties={"queue_manager": qname, "channel": ch},
                        )
                if rqm:
                    remote_ref = qmgr_ref.get(rqm)
                    if not remote_ref:
                        remote_ref = b.entity(
                            "mq.queue_manager", {"name": rqm}, rqm, observed_at, "observed", base + ".out",
                            properties={"queue_manager": rqm, "reference_only": True, "runtime_peer": True},
                        )
                        qmgr_ref[rqm] = remote_ref
                    if ctype in ("SDR", "CLUSSDR"):
                        b.relation(
                            "network.connects_to", ch_ref, remote_ref, observed_at, "observed", base + ".out",
                            properties={"queue_manager": qname, "remote_queue_manager": rqm, "status": rec.get("STATUS") or None, "conname": conname or None},
                        )

        selected_connections = latest_successful_sample(archive, qdir, "connections")
        if selected_connections:
            sample, base, _ = selected_connections
            observed_at = sample_time(archive, qdir, sample, completed_at)
            run["metadata"]["selected_runtime_samples"][qname]["connections"] = sample
            b.coverage(
                "queue_manager", qname, "relation:runtime.connects_via", "point_in_time",
                base + ".out", properties={"absence_closes_assertions": True, "selected_sample": sample},
            )
            for rec in parse_blocks(archive.text(base + ".out", False)):
                actor_for(qname, rec, observed_at, base + ".out")

        selected_handles = latest_successful_sample(archive, qdir, "queue-handles")
        if selected_handles:
            sample, base, _ = selected_handles
            observed_at = sample_time(archive, qdir, sample, completed_at)
            run["metadata"]["selected_runtime_samples"][qname]["queue-handles"] = sample
            for relation_type in ("runtime.opens_for_output", "runtime.opens_for_input"):
                b.coverage(
                    "queue_manager", qname, "relation:" + relation_type, "point_in_time",
                    base + ".out", properties={"absence_closes_assertions": True, "selected_sample": sample},
                )
            for rec in parse_blocks(archive.text(base + ".out", False)):
                qname_value = rec.get("QUEUE")
                if not qname_value or not rec.get("APPLTAG"):
                    continue
                q_ref = queue_ref.get((qname, qname_value))
                if not q_ref:
                    q_ref = b.entity(
                        "mq.queue", {"queue_manager_key": qname, "name": qname_value}, qname_value,
                        observed_at, "observed", base + ".out",
                        properties={"queue_manager": qname, "queue_type": "OBSERVED_ONLY", "runtime_only": True},
                    )
                    queue_ref[(qname, qname_value)] = q_ref
                actor_ref, _actor_kind = actor_for(qname, rec, observed_at, base + ".out")
                if not actor_ref:
                    continue
                common = {
                    "queue_manager": qname,
                    "channel": rec.get("CHANNEL") or None,
                    "client": conname_host(str(rec.get("CONNAME") or "")) or None,
                    "object_handle": rec.get("HOBJ") or rec.get("OBJHANDLE") or None,
                    "selected_sample": sample,
                }
                if str(rec.get("OUTPUT") or "").upper() == "YES":
                    b.relation(
                        "runtime.opens_for_output", actor_ref, q_ref, observed_at, "observed", base + ".out",
                        properties=common,
                    )
                input_mode = str(rec.get("INPUT") or "").upper()
                if input_mode and input_mode != "NO":
                    props = dict(common)
                    props["input_mode"] = rec.get("INPUT")
                    b.relation(
                        "runtime.opens_for_input", actor_ref, q_ref, observed_at, "observed", base + ".out",
                        properties=props,
                    )

        # Only claim complete runtime-process absence when both connection and
        # queue-handle enumerations succeeded for the selected current sample set.
        process_states = []
        for label in ("connections", "queue-handles"):
            selected = latest_successful_sample(archive, qdir, label)
            if selected:
                process_states.append({"mode": "point_in_time", "evidence_ref": selected[1] + ".out", "error": None})
            else:
                process_states.append({"mode": "failed", "evidence_ref": f"qmgr/{qdir}/runtime/*/{label}.out", "error": f"no successful {label} sample"})
        if all(x["mode"] == "point_in_time" for x in process_states):
            b.coverage(
                "queue_manager", qname, "mq.runtime_process", "point_in_time",
                process_states[-1]["evidence_ref"], properties={"absence_closes_assertions": True},
            )

    bundle = b.finish()
    return bundle


def main():
    parser = argparse.ArgumentParser(description="Normalize a raw IBM MQ collector archive directly to ObservationBundle v2")
    parser.add_argument("archive", help="mq-topology-*.tar.gz raw collector archive")
    parser.add_argument("-o", "--output", default="mq-observation-bundle-v2.json")
    parser.add_argument("--environment")
    args = parser.parse_args()

    bundle = normalize(args.archive, args.environment)
    with open(args.output, "w", encoding="utf-8") as fh:
        json.dump(bundle, fh, indent=2, sort_keys=False)
        fh.write("\n")
    print(json.dumps({
        "output": args.output,
        "schema_version": bundle["schema_version"],
        "run_id": bundle["run"]["run_id"],
        "environment": bundle["run"]["environment"],
        "coverage": len(bundle["coverage"]),
        "entities": len(bundle["entities"]),
        "relations": len(bundle["relations"]),
        "unresolved_references": len(bundle["unresolved_references"]),
    }, indent=2))


if __name__ == "__main__":
    main()
