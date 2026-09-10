#!/usr/bin/env python3
"""Offline/read-only OSI Findings v1 evaluator for IBM MQ raw evidence.

Reads an existing mq-topology-*.tar.gz only. It never connects to MQ, consumes
messages, mutates queue-manager state, or uses an external monitoring runtime.
"""
from __future__ import annotations

import argparse, hashlib, json, math, re, tarfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import PurePosixPath
from typing import Any, Iterable

SCHEMA_VERSION = "osi.findings.evaluation/v1"
EVALUATOR_VERSION = "1.0.0"
DISPLAY_RE = re.compile(r"^AMQ\d+[A-Z]:\s+Display\b", re.I)
ATTR_RE = re.compile(r"\b([A-Z][A-Z0-9_]*)\(([^()]*)\)")
MQMSG_RE = re.compile(r"\b(AMQ\d{4}[A-Z]):\s*([^\r\n]*)", re.I)
EMPTY_CODES = frozenset({"AMQ8147E", "AMQ8933I"})


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def sha256_file(filename: str) -> str:
    h = hashlib.sha256()
    with open(filename, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def canonical_id(kind: str, rule: str, key: str) -> str:
    return "cent_" + sha256_text(f"{kind}|{rule}|{key}")[:24]


def qmgr_entity_id(name: str, qmid: str | None = None) -> str:
    return canonical_id("mq.queue_manager", "qmid" if qmid else "name", (qmid or name).strip().lower())


def scoped_entity_id(kind: str, qmgr: str, name: str) -> str:
    key = f"queue_manager_key={qmgr.strip().lower()}|name={name.strip().lower()}"
    return canonical_id(kind, "rule_2", key)


def finding_id(rule: str, entity: str) -> str:
    return "find_" + sha256_text(f"{rule}|{entity}")[:24]


def observation_id(entity: str, metric: str, sample: str, evidence: str, discriminator: str = "") -> str:
    return "obs_" + sha256_text(f"{entity}|{metric}|{sample}|{evidence}|{discriminator}")[:24]


def parse_int(value: Any) -> int | None:
    try:
        text = str(value).strip()
        return int(text) if text and text not in {"-", "N/A", "None"} else None
    except (TypeError, ValueError):
        return None


def parse_blocks(text: str) -> list[dict[str, str]]:
    out, current, active = [], {}, False
    for line in text.splitlines():
        if DISPLAY_RE.search(line.strip()):
            if active and current:
                out.append(current)
            current, active = {}, True
            continue
        if active:
            for key, value in ATTR_RE.findall(line):
                current[key] = value.strip()
    if current:
        out.append(current)
    return out


class RawArchive:
    def __init__(self, filename: str):
        self.filename = filename
        self.tf = tarfile.open(filename, "r:gz")
        roots = {PurePosixPath(m.name).parts[0] for m in self.tf.getmembers() if m.name and PurePosixPath(m.name).parts}
        if len(roots) != 1:
            self.tf.close(); raise ValueError("raw archive must contain exactly one top-level directory")
        self.root = next(iter(roots))
        self.names = {m.name for m in self.tf.getmembers() if m.isfile()}

    def close(self): self.tf.close()
    def has(self, rel: str) -> bool: return f"{self.root}/{rel}" in self.names
    def text(self, rel: str, required: bool = True) -> str:
        try: member = self.tf.getmember(f"{self.root}/{rel}")
        except KeyError:
            if required: raise ValueError(f"archive member missing: {rel}")
            return ""
        fh = self.tf.extractfile(member)
        if not fh:
            if required: raise ValueError(f"archive member unreadable: {rel}")
            return ""
        return fh.read().decode("utf-8", errors="replace")
    def members(self, prefix: str) -> list[str]:
        base = f"{self.root}/{prefix.rstrip('/')}/"
        return [m.name[len(self.root)+1:] for m in self.tf.getmembers() if m.isfile() and m.name.startswith(base)]


@dataclass(frozen=True)
class CommandOutcome:
    mode: str
    evidence_ref: str
    error: str | None
    process_rc: int | None
    empty_result: bool = False


@dataclass(frozen=True)
class SampleRecord:
    qmgr: str
    object_name: str
    semantic_type: str
    sample_id: str
    observed_at: str
    evidence_ref: str
    values: dict[str, str]


def command_outcome(a: RawArchive, base: str, ok: str = "point_in_time") -> CommandOutcome:
    evidence = base + ".out"
    if not a.has(evidence) and not a.has(base + ".rc"):
        return CommandOutcome("not_collected", evidence, "command evidence missing", None)
    raw_rc = a.text(base + ".rc", False).strip()
    try: rc = int(raw_rc) if raw_rc else None
    except ValueError: rc = None
    messages = [(c.upper(), t.strip()) for c, t in MQMSG_RE.findall(a.text(evidence, False)+"\n"+a.text(base+".err", False))]
    codes = {c for c, _ in messages}
    cmd = a.text(base + ".mqsc", False).strip().upper()
    empty = rc == 10 and cmd.startswith("DISPLAY ") and "(*)" in cmd and bool(messages) and codes.issubset(EMPTY_CODES) and all("not found" in t.lower() for _, t in messages)
    if empty: return CommandOutcome(ok, evidence, None, rc, True)
    errors = sorted(c for c in codes if c.endswith("E"))
    if rc not in (None, 0) or errors:
        bits = ([f"process rc={rc}"] if rc not in (None, 0) else []) + (["MQ errors="+",".join(errors)] if errors else [])
        return CommandOutcome("failed", evidence, "; ".join(bits) or "command failed", rc)
    return CommandOutcome(ok, evidence, None, rc)


def manifest(a: RawArchive) -> dict[str, str]:
    return {k.strip(): v.strip() for line in a.text("manifest.properties").splitlines() if "=" in line for k, v in [line.split("=", 1)]}


def qmgr_rows(a: RawArchive) -> list[tuple[str, str]]:
    return [tuple(x.strip() for x in line.split("\t", 1)) for line in a.text("qmgrs.tsv").splitlines()[1:] if "\t" in line]


def runtime_samples(a: RawArchive, qdir: str) -> list[str]:
    found = set()
    for rel in a.members(f"qmgr/{qdir}/runtime"):
        p = PurePosixPath(rel).parts
        if len(p) >= 4: found.add(p[3])
    return sorted(found)


def sample_time(a: RawArchive, qdir: str, sample: str, fallback: str) -> str:
    return a.text(f"qmgr/{qdir}/runtime/{sample}/captured-at-utc.txt", False).strip() or fallback


def qmgr_config(a: RawArchive, qdir: str) -> dict[str, str]:
    base = f"qmgr/{qdir}/config/qmgr"
    if command_outcome(a, base, "complete").mode != "complete": return {}
    rows = parse_blocks(a.text(base + ".out", False)); return rows[0] if rows else {}


def get_records(a: RawArchive, qdir: str, qmgr: str, sample: str, label: str, kind: str, name_field: str, fallback: str):
    base = f"qmgr/{qdir}/runtime/{sample}/{label}"
    outcome = command_outcome(a, base)
    if outcome.mode != "point_in_time": return outcome, []
    ts = sample_time(a, qdir, sample, fallback)
    rows = []
    for values in parse_blocks(a.text(base + ".out", False)):
        name = values.get(name_field, "").strip() or (qmgr if kind == "mq.queue_manager" else "")
        if name: rows.append(SampleRecord(qmgr, name, kind, sample, ts, outcome.evidence_ref, values))
    return outcome, rows


def series_by_object(records: Iterable[SampleRecord]) -> dict[str, list[SampleRecord]]:
    out: dict[str, list[SampleRecord]] = {}
    for r in records: out.setdefault(r.object_name, []).append(r)
    for rows in out.values(): rows.sort(key=lambda r: r.observed_at)
    return out


def _epoch(ts: str): return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()

def linear_slope(values: list[int | float]) -> float:
    if len(values) < 2: return 0.0
    n=len(values); xb=(n-1)/2; yb=sum(values)/n; den=sum((x-xb)**2 for x in range(n))
    return sum((x-xb)*(y-yb) for x,y in enumerate(values))/den if den else 0.0


def queue_backlog_increasing(samples: list[SampleRecord]) -> bool:
    if len(samples) < 3: return False
    vals=[parse_int(r.values.get("CURDEPTH")) for r in samples]
    if any(v is None for v in vals): return False
    d=[int(v) for v in vals if v is not None]
    positives=sum(b>a for a,b in zip(d,d[1:]))
    return d[-1]>d[0] and d[-1]>0 and linear_slope(d)>0 and all(b>=a for a,b in zip(d[-3:],d[-2:])) and positives>=max(2, math.ceil((len(d)-1)*.5))


def queue_oldest_message_aging(samples: list[SampleRecord]) -> bool:
    if len(samples) < 3: return False
    ages=[parse_int(r.values.get("MSGAGE")) for r in samples]; depths=[parse_int(r.values.get("CURDEPTH")) for r in samples]
    if any(v is None for v in ages+depths): return False
    a=[int(v) for v in ages if v is not None]; d=[int(v) for v in depths if v is not None]
    elapsed=max(0, _epoch(samples[-1].observed_at)-_epoch(samples[0].observed_at))
    return min(d[-3:])>0 and a[-1]>a[0] and a[-1]>0 and all(b>=x for x,b in zip(a[-3:],a[-2:])) and elapsed>0 and (a[-1]-a[0])>=elapsed*.55


def all_zero_input_processes(samples):
    vals=[parse_int(r.values.get("IPPROCS")) for r in samples]
    return bool(vals) and all(v is not None and v==0 for v in vals)


def any_output_process(samples): return any((parse_int(r.values.get("OPPROCS")) or 0)>0 for r in samples)
def is_system_queue(name: str): return name.upper().startswith(("SYSTEM.", "AMQ.", "KMQ."))


def channel_instance_dimensions(r: SampleRecord):
    v=r.values; parts=[str(v.get(k) or "").strip() for k in ("JOBNAME","CONNAME","RAPPLTAG")]
    key="|".join(x for x in parts if x) or "default"
    return key, {"channel_instance_key":key,"job_name":v.get("JOBNAME") or None,"connection_name":v.get("CONNAME") or None,"remote_application":v.get("RAPPLTAG") or None,"remote_queue_manager":v.get("RQMNAME") or None,"channel_type":v.get("CHLTYPE") or None}


def obs(entity, kind, name, metric, r, value, unit, source_id, source_host, method, discriminator="", dimensions=None):
    item={"observation_id":observation_id(entity,metric,r.sample_id,r.evidence_ref,discriminator),"entity_id":entity,"semantic_type":kind,"display_name":name,"observation_type":metric,"observed_at":r.observed_at,"value":value,"unit":unit,"source":{"source_id":source_id,"source_host":source_host,"queue_manager":r.qmgr,"collection_method":method,"evidence_class":"observed","evidence_ref":r.evidence_ref,"sample_id":r.sample_id},"quality":{"coverage":"point_in_time","freshness":"sampled"}}
    if dimensions: item["dimensions"]=dimensions
    return item


def ev(r, metrics): return {"sample_id":r.sample_id,"observed_at":r.observed_at,"evidence_ref":r.evidence_ref,"observation_types":metrics}
def make_finding(rule, entity, kind, name, severity, summary, diagnosis, confidence, score, first, last, evidence, coverage="sufficient", details=None):
    return {"finding_id":finding_id(rule,entity),"rule_id":rule,"entity_id":entity,"semantic_type":kind,"display_name":name,"severity":severity,"status":"OPEN","summary":summary,"diagnosis":diagnosis,"confidence":{"level":confidence,"score":score},"first_seen":first,"last_seen":last,"coverage_state":coverage,"evidence":evidence,"related_entities":[],"details":details or {}}


def evaluate_archive(filename: str) -> dict[str, Any]:
    a=RawArchive(filename)
    try:
        mf=manifest(a)
        if mf.get("format")!="osi-mq-topology-raw" or mf.get("format_version")!="1": raise ValueError("unsupported IBM MQ raw evidence format")
        completed=mf.get("completed_at_utc") or datetime.now(timezone.utc).isoformat().replace("+00:00","Z")
        host=a.text("host/hostname.out",False).strip() or mf.get("host","unknown")
        source_id=(a.text("host/hostname-fqdn.out",False).strip() or host).lower()
        observations=[]; coverage=[]; findings=[]; qms=[]
        specs=(("qmgr-status","mq.queue_manager","QMNAME"),("listener-status","mq.listener","LISTENER"),("channel-status","mq.channel","CHANNEL"),("queue-status","mq.queue","QUEUE"))

        for qdir,qmgr in qmgr_rows(a):
            cfg=qmgr_config(a,qdir); qmid=cfg.get("QMID") or None; qmid_id=qmgr_entity_id(qmgr,qmid)
            records={label:[] for label,_,_ in specs}; outcomes={label:[] for label,_,_ in specs}; samples=runtime_samples(a,qdir)
            for sample in samples:
                ts=sample_time(a,qdir,sample,completed)
                for label,kind,name_field in specs:
                    outcome,rows=get_records(a,qdir,qmgr,sample,label,kind,name_field,completed)
                    outcomes[label].append((sample,ts,outcome)); records[label].extend(rows)
                    coverage.append({"scope_type":"queue_manager","scope_key":qmgr,"observation_family":label,"sample_id":sample,"observed_at":ts,"state":outcome.mode,"evidence_ref":outcome.evidence_ref,"error":outcome.error})

            for r in records["qmgr-status"]:
                observations.append(obs(qmid_id,"mq.queue_manager",qmgr,"mq.queue_manager.status",r,r.values.get("STATUS") or "UNKNOWN","state",source_id,host,"mqsc:DISPLAY QMSTATUS ALL"))
            for r in records["listener-status"]:
                eid=scoped_entity_id("mq.listener",qmgr,r.object_name)
                observations.append(obs(eid,"mq.listener",r.object_name,"mq.listener.status",r,r.values.get("STATUS") or "UNKNOWN","state",source_id,host,"mqsc:DISPLAY LSSTATUS(*) ALL"))
            for r in records["channel-status"]:
                eid=scoped_entity_id("mq.channel",qmgr,r.object_name); discr,dims=channel_instance_dimensions(r)
                observations.append(obs(eid,"mq.channel",r.object_name,"mq.channel.status",r,r.values.get("STATUS") or "UNKNOWN","state",source_id,host,"mqsc:DISPLAY CHSTATUS(*) ALL",discr,dims))
                if r.values.get("MONCHL"): observations.append(obs(eid,"mq.channel",r.object_name,"mq.channel.monitoring_level",r,r.values["MONCHL"],"state",source_id,host,"mqsc:DISPLAY CHSTATUS(*) ALL",discr,dims))
            for r in records["queue-status"]:
                eid=scoped_entity_id("mq.queue",qmgr,r.object_name)
                for attr,metric,unit in (("CURDEPTH","mq.queue.depth.current","messages"),("IPPROCS","mq.queue.process.input_count","processes"),("OPPROCS","mq.queue.process.output_count","processes"),("MSGAGE","mq.queue.message.age.oldest_seconds","seconds")):
                    value=parse_int(r.values.get(attr))
                    if value is not None: observations.append(obs(eid,"mq.queue",r.object_name,metric,r,value,unit,source_id,host,"mqsc:DISPLAY QSTATUS(*) TYPE(QUEUE) ALL"))

            qseries=series_by_object(records["qmgr-status"]).get(qmgr,[])
            if qseries and (state:=(qseries[-1].values.get("STATUS") or "UNKNOWN").upper())!="RUNNING":
                r=qseries[-1]; findings.append(make_finding("mq.qmgr.unavailable.v1",qmid_id,"mq.queue_manager",qmgr,"critical",f"Queue manager is {state.lower()}","The latest successful queue-manager status observation is not RUNNING.","confirmed",.99,r.observed_at,r.observed_at,[ev(r,["mq.queue_manager.status"])],details={"status":state}))

            for name,rows in series_by_object(records["listener-status"]).items():
                r=rows[-1]; state=(r.values.get("STATUS") or "UNKNOWN").upper()
                if state!="RUNNING": findings.append(make_finding("mq.listener.unavailable.v1",scoped_entity_id("mq.listener",qmgr,name),"mq.listener",name,"warning",f"Listener is {state.lower()}","The latest successful listener-status observation is not RUNNING.","confirmed",.99,r.observed_at,r.observed_at,[ev(r,["mq.listener.status"])],details={"queue_manager":qmgr,"status":state}))

            for name,rows in series_by_object(records["channel-status"]).items():
                latest_at=max(r.observed_at for r in rows); latest=[r for r in rows if r.observed_at==latest_at]
                states=sorted({(r.values.get("STATUS") or "UNKNOWN").upper() for r in latest}); abnormal=[r for r in latest if (r.values.get("STATUS") or "UNKNOWN").upper()!="RUNNING"]
                if abnormal:
                    mixed=len(abnormal)!=len(latest); summary="Some observed channel instances are not running" if mixed else f"Observed channel state is {states[0].lower()}"
                    findings.append(make_finding("mq.channel.abnormal.v1",scoped_entity_id("mq.channel",qmgr,name),"mq.channel",name,"warning",summary,"One or more channel instances in the latest successful status sample are not RUNNING. Impact is not asserted without route/workload evidence.","confirmed",.98,latest_at,latest_at,[ev(r,["mq.channel.status"]) for r in abnormal],details={"queue_manager":qmgr,"statuses":states,"instance_count":len(latest),"abnormal_instance_count":len(abnormal),"impact":"not_established"}))

            for name,rows in series_by_object(records["queue-status"]).items():
                if is_system_queue(name): continue
                backlog=queue_backlog_increasing(rows); no_input=all_zero_input_processes(rows); producer=any_output_process(rows); aging=queue_oldest_message_aging(rows)
                eid=scoped_entity_id("mq.queue",qmgr,name); first,last=rows[0],rows[-1]; depths=[parse_int(r.values.get("CURDEPTH")) for r in rows]; ages=[parse_int(r.values.get("MSGAGE")) for r in rows]
                if backlog and no_input:
                    diag="Queue depth increased across the sampled window while every successful queue-status sample reported IPPROCS=0. "+("An output process was observed, strengthening evidence that work is arriving. " if producer else "")+"This does not by itself prove an application outage."
                    findings.append(make_finding("mq.queue.backlog_no_input_process.v1",eid,"mq.queue",name,"warning","Backlog increasing with no input process observed",diag,"probable",.92 if producer else .86,first.observed_at,last.observed_at,[ev(r,["mq.queue.depth.current","mq.queue.process.input_count","mq.queue.process.output_count"]) for r in rows],details={"queue_manager":qmgr,"depth_series":depths,"input_processes_all_zero":True,"output_process_observed":producer,"policy_scope":"non_system_queue_generic_v1","impact":"not_established"}))
                elif backlog:
                    findings.append(make_finding("mq.queue.backlog_increasing.v1",eid,"mq.queue",name,"warning","Queue backlog increasing across observations","Queue depth shows a sustained positive trend across the sampled window. No business threshold or outage cause is inferred.","probable",.84,first.observed_at,last.observed_at,[ev(r,["mq.queue.depth.current"]) for r in rows],details={"queue_manager":qmgr,"depth_series":depths,"policy_scope":"non_system_queue_generic_v1","impact":"not_established"}))
                if aging:
                    findings.append(make_finding("mq.queue.oldest_message_aging.v1",eid,"mq.queue",name,"warning","Oldest queued message is aging across observations","The oldest-message age increased with wall time while the queue remained non-empty. This is persistence evidence, not a business-SLA breach claim.","probable",.86,first.observed_at,last.observed_at,[ev(r,["mq.queue.message.age.oldest_seconds","mq.queue.depth.current"]) for r in rows],details={"queue_manager":qmgr,"message_age_series_seconds":ages,"depth_series":depths,"policy_scope":"non_system_queue_generic_v1","sla_breach":"not_asserted"}))

            if str(cfg.get("MONCHL") or "").upper()=="OFF":
                findings.append(make_finding("mq.observability.channel_timing_unavailable.v1",qmid_id,"mq.queue_manager",qmgr,"info","Channel performance timing is not observable","Queue-manager configuration reports MONCHL(OFF). Channel state remains observable, but detailed channel timing diagnosis is unavailable from this evidence source.","confirmed",.99,completed,completed,[{"sample_id":"configuration","observed_at":completed,"evidence_ref":f"qmgr/{qdir}/config/qmgr.out","observation_types":["mq.channel.monitoring_coverage"]}],"limited",{"queue_manager":qmgr,"MONCHL":"OFF","health_implication":"none"}))

            for family,rows in outcomes.items():
                bad=[x for x in rows if x[2].mode in {"failed","not_collected"}]; good=[x for x in rows if x[2].mode=="point_in_time"]
                if bad:
                    evidence=[{"sample_id":s,"observed_at":ts,"evidence_ref":o.evidence_ref,"observation_types":[f"coverage.{family}"],"error":o.error} for s,ts,o in bad]
                    findings.append(make_finding(f"mq.observability.collection_gap.{family}.v1",qmid_id,"mq.queue_manager",qmgr,"warning",f"{family.replace('-',' ').title()} evidence is incomplete","One or more required runtime collection attempts failed or were not collected. Health conclusions that depend on this observation family must be treated as incomplete.","confirmed",.99,bad[0][1],bad[-1][1],evidence,"partial" if good else "failed",{"queue_manager":qmgr,"observation_family":family,"successful_samples":len(good),"failed_or_missing_samples":len(bad)}))
            qms.append({"queue_manager":qmgr,"entity_id":qmid_id,"qmid":qmid,"runtime_samples":len(samples)})

        findings.sort(key=lambda f:({"critical":0,"warning":1,"info":2}.get(f["severity"],9),f["semantic_type"],f["display_name"],f["rule_id"]))
        observations.sort(key=lambda o:(o["entity_id"],o["observation_type"],o["observed_at"],o["observation_id"]))
        coverage.sort(key=lambda c:(c["scope_key"],c["observation_family"],c["observed_at"]))
        summary={s:sum(f["severity"]==s for f in findings) for s in ("critical","warning","info")}; summary["total"]=len(findings)
        return {"schema_version":SCHEMA_VERSION,"evaluation":{"evaluator":"evaluate_findings_v1.py","evaluator_version":EVALUATOR_VERSION,"evaluated_at":datetime.now(timezone.utc).isoformat().replace("+00:00","Z"),"source_archive":PurePosixPath(filename).name,"source_archive_sha256":sha256_file(filename),"source_id":source_id,"source_host":host,"collector_version":mf.get("collector_version"),"sample_count_declared":parse_int(mf.get("samples")),"sample_interval_seconds_declared":parse_int(mf.get("interval_seconds")),"policy":{"system_queue_generic_rules":"excluded","absolute_queue_depth_thresholds":"not_used","business_sla_thresholds":"not_invented","external_monitoring_dependencies":"none"}},"queue_managers":qms,"coverage":coverage,"operational_observations":observations,"findings":findings,"summary":summary}
    finally: a.close()


def main():
    p=argparse.ArgumentParser(description="Evaluate OSI Phase 2 Findings v1 from an IBM MQ raw collector archive")
    p.add_argument("archive"); p.add_argument("-o","--output",default="osi-findings-v1.json"); args=p.parse_args()
    result=evaluate_archive(args.archive)
    with open(args.output,"w",encoding="utf-8") as fh: json.dump(result,fh,indent=2); fh.write("\n")
    print(json.dumps({"output":args.output,"schema_version":result["schema_version"],"observations":len(result["operational_observations"]),"coverage_records":len(result["coverage"]),"findings":result["summary"]},indent=2))


if __name__=="__main__": main()
