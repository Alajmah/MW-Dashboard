#!/usr/bin/env python3
"""IBM MQ cluster semantic enrichment for ObservationBundle v2."""


def _merge_properties(dst, src):
    for key, value in (src or {}).items():
        if value in (None, "", []):
            continue
        if key not in dst or dst[key] in (None, "", []):
            dst[key] = value
        elif dst[key] != value:
            old = dst[key] if isinstance(dst[key], list) else [dst[key]]
            new = value if isinstance(value, list) else [value]
            merged = []
            for item in old + new:
                if item not in merged:
                    merged.append(item)
            dst[key] = merged


def _entity_key(semantic_type, hints, evidence_class, evidence_ref):
    import json
    cleaned = _impl.scalar_hints(hints)
    return semantic_type, json.dumps(cleaned, sort_keys=True, separators=(",", ":")), evidence_class, evidence_ref or ""


def _add_entity(bundle, semantic_type, hints, display_name, observed_at, evidence_class,
                evidence_ref=None, status=None, properties=None):
    key = _entity_key(semantic_type, hints, evidence_class, evidence_ref)
    ref = _impl.stable_ref("ent", semantic_type, key[1], evidence_class, evidence_ref or "")
    for item in bundle["entities"]:
        if item["ref"] == ref:
            _merge_properties(item["properties"], properties or {})
            if status:
                item["status"] = status
            if observed_at and observed_at > item["observed_at"]:
                item["observed_at"] = observed_at
            return ref
    item = {
        "ref": ref,
        "semantic_type": semantic_type,
        "identity": {"hints": _impl.scalar_hints(hints)},
        "display_name": display_name,
        "observed_at": observed_at,
        "evidence_class": evidence_class,
        "properties": dict(properties or {}),
    }
    if evidence_ref:
        item["evidence_ref"] = evidence_ref
    if status:
        item["status"] = status
    bundle["entities"].append(item)
    return ref


def _add_relation(bundle, semantic_type, source_ref, target_ref, observed_at, evidence_class,
                  evidence_ref=None, properties=None, derivation_method=None,
                  deterministic=None, confidence=None):
    key = (semantic_type, source_ref, target_ref, evidence_class, evidence_ref or "")
    ref = _impl.stable_ref("rel", *key)
    for item in bundle["relations"]:
        if item["ref"] == ref:
            _merge_properties(item["properties"], properties or {})
            return ref
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
    bundle["relations"].append(item)
    return ref


def _add_coverage(bundle, scope_type, scope_key, object_class, mode, evidence_ref=None,
                  error=None, properties=None):
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
    for idx, existing in enumerate(bundle["coverage"]):
        if (existing["scope_type"], existing["scope_key"], existing["object_class"]) == (scope_type, scope_key, object_class):
            bundle["coverage"][idx] = item
            return
    bundle["coverage"].append(item)


def _qualify_cluster_queue_coverage(bundle):
    for item in bundle["coverage"]:
        if item.get("object_class") != "relation:mq.cluster_discovers":
            continue
        evidence = item.get("evidence_ref") or ""
        if not evidence.endswith("/config/queues-cluster.out"):
            continue
        item["object_class"] = "relation:mq.cluster_discovers:queue"
        props = item.setdefault("properties", {})
        props.update({
            "relationship_type": "mq.cluster_discovers",
            "source_type": "mq.queue_manager",
            "target_type": "mq.queue",
            "discovery_family": "cluster_queue",
        })


def _index_qmgr_refs(bundle):
    out = {}
    strength = {}
    for item in bundle["entities"]:
        if item["semantic_type"] != "mq.queue_manager":
            continue
        name = item["display_name"]
        hints = item.get("identity", {}).get("hints", {})
        score = 2 if hints.get("qmid") else 1
        if score >= strength.get(name, -1):
            out[name] = item["ref"]
            strength[name] = score
    return out


def _index_channel_refs(bundle):
    out = {}
    for item in bundle["entities"]:
        if item["semantic_type"] != "mq.channel":
            continue
        hints = item.get("identity", {}).get("hints", {})
        qmgr = hints.get("queue_manager_key")
        name = hints.get("name") or item.get("display_name")
        if qmgr and name:
            out[(qmgr, name)] = item["ref"]
    return out


def _add_endpoint(bundle, endpoint_index, raw, observed_at, evidence_ref, properties):
    refs = []
    for ep in _impl.parse_conname_endpoints(raw):
        key = (str(ep.get("host") or "").lower(), str(ep.get("port") or ""), evidence_ref)
        ref = endpoint_index.get(key)
        if not ref:
            hints = {"host": ep.get("host"), "port": ep.get("port"), "raw": ep.get("raw")}
            display = str(ep.get("host") or "")
            if ep.get("port"):
                display += ":" + str(ep.get("port"))
            ref = _add_entity(
                bundle, "infra.network_endpoint", hints, display or ep.get("raw") or "endpoint",
                observed_at, "observed", evidence_ref,
                properties={
                    "host": ep.get("host"),
                    "port": ep.get("port") or None,
                    "raw": ep.get("raw"),
                    "role": "cluster_channel_peer",
                    **properties,
                },
            )
            endpoint_index[key] = ref
        refs.append(ref)
    return refs


def _augment_cluster_qmgrs(bundle, archive):
    qrows = _impl.qmgr_rows(archive)
    local_names = {name for _qdir, name in qrows}
    qmgr_ref = _index_qmgr_refs(bundle)
    channel_ref = _index_channel_refs(bundle)
    cluster_ref = {}
    endpoint_index = {}

    for item in bundle["entities"]:
        if item["semantic_type"] == "mq.cluster":
            cluster_ref[item["display_name"]] = item["ref"]
        elif item["semantic_type"] == "infra.network_endpoint":
            props = item.get("properties", {})
            key = (str(props.get("host") or "").lower(), str(props.get("port") or ""), item.get("evidence_ref") or "")
            endpoint_index[key] = item["ref"]

    for qdir, qname in qrows:
        selected = _impl.latest_successful_sample(archive, qdir, "cluster-qmgrs")
        if not selected:
            continue
        sample, base, health = selected
        observed_at = _impl.sample_time(archive, qdir, sample, bundle["run"]["completed_at"])
        bundle["run"].setdefault("metadata", {}).setdefault("selected_runtime_samples", {}).setdefault(qname, {})["cluster-qmgrs"] = sample
        _add_coverage(
            bundle, "queue_manager", qname, "relation:mq.cluster_discovers:queue_manager", "point_in_time",
            base + ".out", properties={
                **health.get("properties", {}),
                "absence_closes_assertions": True,
                "selected_sample": sample,
                "relationship_type": "mq.cluster_discovers",
                "source_type": "mq.queue_manager",
                "target_type": "mq.queue_manager",
                "discovery_family": "cluster_queue_manager",
            },
        )
        local_ref = qmgr_ref.get(qname)
        if not local_ref:
            continue
        for rec in _impl.parse_blocks(archive.text(base + ".out", False)):
            remote_name = str(rec.get("CLUSQMGR") or "").strip()
            if not remote_name:
                continue
            qmid = str(rec.get("QMID") or "").strip()
            hints = {"name": remote_name}
            if qmid:
                hints["qmid"] = qmid
            remote_ref = _add_entity(
                bundle, "mq.queue_manager", hints, remote_name, observed_at, "observed", base + ".out",
                status=rec.get("STATUS") or None,
                properties={
                    "queue_manager": remote_name,
                    "qmid": qmid or None,
                    "reference_only": remote_name not in local_names,
                    "cluster_visible_from": qname,
                    "cluster": rec.get("CLUSTER") or None,
                    "cluster_qm_type": rec.get("QMTYPE") or None,
                    "cluster_definition_type": rec.get("DEFTYPE") or None,
                    "cluster_channel": rec.get("CHANNEL") or None,
                    "cluster_conname": rec.get("CONNAME") or None,
                    "cluster_status": rec.get("STATUS") or None,
                    "cluster_suspend": rec.get("SUSPEND") or None,
                    "version": rec.get("VERSION") or None,
                },
            )
            qmgr_ref[remote_name] = remote_ref
            cluster_name = str(rec.get("CLUSTER") or "").strip()
            cref = None
            if cluster_name:
                cref = cluster_ref.get(cluster_name)
                if not cref:
                    cref = _add_entity(
                        bundle, "mq.cluster", {"name": cluster_name}, cluster_name, observed_at, "observed",
                        base + ".out", properties={"cluster": cluster_name},
                    )
                    cluster_ref[cluster_name] = cref
                _add_relation(
                    bundle, "member_of", remote_ref, cref, observed_at, "observed", base + ".out",
                    properties={
                        "queue_manager": remote_name,
                        "cluster": cluster_name,
                        "cluster_qm_type": rec.get("QMTYPE") or None,
                        "repository": str(rec.get("QMTYPE") or "").upper() == "REPOS",
                    },
                )
            if remote_name != qname:
                _add_relation(
                    bundle, "mq.cluster_discovers", local_ref, remote_ref, observed_at, "observed", base + ".out",
                    properties={
                        "queue_manager": qname,
                        "remote_queue_manager": remote_name,
                        "remote_qmid": qmid or None,
                        "cluster": cluster_name or None,
                        "channel": rec.get("CHANNEL") or None,
                        "conname": rec.get("CONNAME") or None,
                        "definition_type": rec.get("DEFTYPE") or None,
                        "status": rec.get("STATUS") or None,
                    },
                )

            channel_name = str(rec.get("CHANNEL") or "").strip()
            if not channel_name:
                continue
            ch_ref = _add_entity(
                bundle, "mq.channel", {"queue_manager_key": qname, "name": channel_name}, channel_name,
                observed_at, "observed", base + ".out", status=rec.get("STATUS") or None,
                properties={
                    "queue_manager": qname,
                    "channel_type": "CLUSSDR" if remote_name != qname else "CLUSRCVR",
                    "cluster_definition_type": rec.get("DEFTYPE") or None,
                    "cluster": cluster_name or None,
                    "remote_queue_manager": remote_name if remote_name != qname else None,
                    "remote_qmid": qmid or None,
                    "conname": rec.get("CONNAME") or None,
                    "auto_defined": rec.get("DEFTYPE") in ("CLUSSDRA", "CLUSSDRB"),
                    "runtime_cluster_record": True,
                },
            )
            channel_ref[(qname, channel_name)] = ch_ref
            _add_relation(
                bundle, "contains", local_ref, ch_ref, observed_at, "observed", base + ".out",
                properties={"queue_manager": qname, "channel_type": "CLUSSDR" if remote_name != qname else "CLUSRCVR", "cluster": cluster_name or None},
            )
            if cref:
                _add_relation(
                    bundle, "member_of", ch_ref, cref, observed_at, "observed", base + ".out",
                    properties={"queue_manager": qname, "cluster": cluster_name},
                )
            conname = str(rec.get("CONNAME") or "").strip()
            if conname:
                for ep_ref in _add_endpoint(
                    bundle, endpoint_index, conname, observed_at, base + ".out",
                    {"queue_manager": qname, "channel": channel_name, "remote_queue_manager": remote_name},
                ):
                    _add_relation(
                        bundle, "network.uses_endpoint", ch_ref, ep_ref, observed_at, "observed", base + ".out",
                        properties={"queue_manager": qname, "channel": channel_name, "cluster": cluster_name or None},
                    )
            if remote_name != qname:
                _add_relation(
                    bundle, "network.connects_to", ch_ref, remote_ref, observed_at, "observed", base + ".out",
                    properties={
                        "queue_manager": qname,
                        "remote_queue_manager": remote_name,
                        "remote_qmid": qmid or None,
                        "cluster": cluster_name or None,
                        "status": rec.get("STATUS") or None,
                        "conname": conname or None,
                        "dynamic_cluster_channel": rec.get("DEFTYPE") in ("CLUSSDRA", "CLUSSDRB"),
                    },
                )


def _augment_cluster_queue_membership(bundle):
    entities = {item["ref"]: item for item in bundle["entities"]}
    qmgr_ref = _index_qmgr_refs(bundle)
    cluster_ref = {
        item["display_name"]: item["ref"]
        for item in bundle["entities"] if item["semantic_type"] == "mq.cluster"
    }
    discoveries = [rel for rel in list(bundle["relations"]) if rel["semantic_type"] == "mq.cluster_discovers"]
    for rel in discoveries:
        target = entities.get(rel["target_ref"])
        if not target or target["semantic_type"] != "mq.queue":
            continue
        props = rel.get("properties", {})
        cluster_name = str(props.get("cluster") or target.get("properties", {}).get("cluster") or "").strip()
        if not cluster_name:
            continue
        evidence_ref = rel.get("evidence_ref")
        cref = cluster_ref.get(cluster_name)
        if not cref:
            cref = _add_entity(
                bundle, "mq.cluster", {"name": cluster_name}, cluster_name, rel["observed_at"], "observed",
                evidence_ref, properties={"cluster": cluster_name},
            )
            cluster_ref[cluster_name] = cref
            entities[cref] = next(item for item in bundle["entities"] if item["ref"] == cref)
        _add_relation(
            bundle, "member_of", target["ref"], cref, rel["observed_at"], "observed", evidence_ref,
            properties={"queue_manager": target.get("properties", {}).get("queue_manager"), "cluster": cluster_name},
        )
        owner = props.get("owner_queue_manager") or target.get("properties", {}).get("queue_manager")
        owner_ref = qmgr_ref.get(owner)
        if owner_ref:
            _add_relation(
                bundle, "member_of", owner_ref, cref, rel["observed_at"], "observed", evidence_ref,
                properties={"queue_manager": owner, "cluster": cluster_name},
            )
        source_qm = props.get("queue_manager")
        source_ref = qmgr_ref.get(source_qm)
        if source_ref:
            _add_relation(
                bundle, "member_of", source_ref, cref, rel["observed_at"], "observed", evidence_ref,
                properties={"queue_manager": source_qm, "cluster": cluster_name},
            )


def _fix_cluster_alias_resolution(bundle):
    entities = {item["ref"]: item for item in bundle["entities"]}
    visible = {}
    for rel in bundle["relations"]:
        if rel["semantic_type"] != "mq.cluster_discovers":
            continue
        target = entities.get(rel["target_ref"])
        if not target or target["semantic_type"] != "mq.queue":
            continue
        source_qm = rel.get("properties", {}).get("queue_manager")
        if not source_qm:
            continue
        visible.setdefault((source_qm, target["display_name"]), []).append({
            "ref": target["ref"],
            "queue_manager": target.get("properties", {}).get("queue_manager"),
            "cluster": rel.get("properties", {}).get("cluster"),
            "evidence_ref": rel.get("evidence_ref"),
        })

    revised = []
    for item in bundle["unresolved_references"]:
        if item.get("reason") != "alias_target_not_collected":
            revised.append(item)
            continue
        props = item.get("properties", {})
        qmgr = props.get("queue_manager")
        target_name = props.get("target_queue")
        candidates = []
        seen = set()
        for candidate in visible.get((qmgr, target_name), []):
            if candidate["ref"] in seen:
                continue
            seen.add(candidate["ref"])
            candidates.append(candidate)
        if len(candidates) == 1:
            candidate = candidates[0]
            _add_relation(
                bundle, "routing.resolves_to", item["source_ref"], candidate["ref"], item["observed_at"],
                "inferred", item.get("evidence_ref"),
                properties={
                    "queue_manager": qmgr,
                    "resolution": "single_cluster_visible_candidate",
                    "target_queue": target_name,
                    "target_queue_manager": candidate.get("queue_manager"),
                    "cluster": candidate.get("cluster"),
                    "cluster_evidence_ref": candidate.get("evidence_ref"),
                },
                derivation_method="qalias_single_cluster_visible_candidate", deterministic=True,
            )
            continue
        if len(candidates) > 1:
            dynamic = dict(item)
            dynamic["state"] = "dynamic"
            dynamic["reason"] = "cluster_alias_multiple_candidates"
            dynamic["evidence_class"] = "inferred"
            dynamic["candidate_refs"] = [candidate["ref"] for candidate in candidates]
            dynamic_props = dict(props)
            dynamic_props.update({
                "candidate_count": len(candidates),
                "candidate_queue_managers": sorted({c.get("queue_manager") for c in candidates if c.get("queue_manager")}),
                "clusters": sorted({c.get("cluster") for c in candidates if c.get("cluster")}),
                "cluster_evidence_refs": sorted({c.get("evidence_ref") for c in candidates if c.get("evidence_ref")}),
            })
            dynamic["properties"] = dynamic_props
            revised.append(dynamic)
            continue
        revised.append(item)
    bundle["unresolved_references"] = revised


def enrich(bundle, archive, impl):
    global _impl
    _impl = impl
    _qualify_cluster_queue_coverage(bundle)
    _augment_cluster_qmgrs(bundle, archive)
    _augment_cluster_queue_membership(bundle)
    _fix_cluster_alias_resolution(bundle)
    bundle["coverage"].sort(key=lambda x: (x["scope_type"], x["scope_key"], x["object_class"]))
    bundle["entities"].sort(key=lambda x: (x["semantic_type"], x["display_name"], x["ref"]))
    bundle["relations"].sort(key=lambda x: (x["semantic_type"], x["source_ref"], x["target_ref"], x["ref"]))
    bundle["unresolved_references"].sort(key=lambda x: (x["semantic_type"], x["vendor_value"], x["ref"]))
    return bundle
