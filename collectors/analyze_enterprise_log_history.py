#!/usr/bin/env python3
"""Offline historical log miner for manually transferred ACE and DataPower corpora."""
from __future__ import annotations
import argparse, csv, gzip, hashlib, io, json, re, tarfile, zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ACE_ID = re.compile(r"\b(BIP\d{4}[A-Z]?)\b", re.I)
SEVERITY = re.compile(r"\b(emerg(?:ency)?|alert|crit(?:ical)?|fatal|error|err|warning|warn|notice|info|debug|severe)\b", re.I)
TS_PATTERNS = [
    re.compile(r"\b(20\d{2}-\d{2}-\d{2}[T ][0-2]\d:[0-5]\d:[0-5]\d(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)"),
    re.compile(r"\b(\d{4}/\d{2}/\d{2}[ T][0-2]\d:[0-5]\d:[0-5]\d)"),
]


def args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Mine ACE or DataPower historical logs offline; no database writes or network access.")
    p.add_argument("source", help="directory, .tar.gz/.tgz, .tar, or .zip")
    p.add_argument("--product", choices=["ace", "datapower"], required=True)
    p.add_argument("--output-dir", required=True)
    p.add_argument("--max-line-bytes", type=int, default=131072)
    return p.parse_args()


def members(source: Path):
    if source.is_dir():
        for p in source.rglob("*"):
            if p.is_file():
                try: yield str(p.relative_to(source)), p.read_bytes()
                except OSError: continue
        return
    name = source.name.lower()
    if name.endswith((".tar.gz", ".tgz", ".tar")):
        with tarfile.open(source, "r:*") as tf:
            for m in tf.getmembers():
                if m.isfile() and m.size <= 512 * 1024 * 1024:
                    f = tf.extractfile(m)
                    if f: yield m.name, f.read()
        return
    if name.endswith(".zip"):
        with zipfile.ZipFile(source) as zf:
            for z in zf.infolist():
                if not z.is_dir() and z.file_size <= 512 * 1024 * 1024:
                    yield z.filename, zf.read(z)
        return
    yield source.name, source.read_bytes()


def evidence_class(product: str, path: str) -> str:
    p = path.lower()
    if product == "ace":
        if "activity" in p: return "activity"
        if "admin" in p: return "admin"
        if "stdout" in p: return "stdout"
        if "stderr" in p: return "stderr"
        if "trace" in p or p.endswith(".trc"): return "trace"
        if "syslog" in p or "messages" in p or "journal" in p: return "system"
        return "ace_log"
    if "audit" in p: return "audit"
    if "trace" in p: return "trace"
    return "system"


def best_timestamp(line: str):
    for pat in TS_PATTERNS:
        m = pat.search(line)
        if m: return m.group(1)
    return None


def severity(line: str):
    m = SEVERITY.search(line)
    if not m: return "unknown"
    s = m.group(1).lower()
    return {"err":"error","warn":"warning","critical":"critical","crit":"critical","fatal":"critical","severe":"critical","emergency":"critical","emerg":"critical"}.get(s, s)


def normalize_message(line: str) -> str:
    x = line.strip()
    x = re.sub(r"\b\d+\b", "#", x)
    x = re.sub(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", "<ip>", x)
    x = re.sub(r"\s+", " ", x)
    return x[:500]


def main():
    a = args(); source = Path(a.source); out = Path(a.output_dir); out.mkdir(parents=True, exist_ok=True)
    sev = Counter(); classes = Counter(); ids = Counter(); fingerprints = Counter(); file_stats = []
    id_first, id_last, id_files, id_example = {}, {}, defaultdict(set), {}
    events_path = out / "events.ndjson.gz"
    lines_total = 0; files_total = 0; bytes_total = 0
    with gzip.open(events_path, "wt", encoding="utf-8") as ev:
        for path, raw in members(source):
            files_total += 1; bytes_total += len(raw); cls = evidence_class(a.product, path); classes[cls] += 1
            text = raw.decode("utf-8", errors="replace"); file_lines = 0
            for line_no, line in enumerate(text.splitlines(), 1):
                file_lines += 1; lines_total += 1
                if len(line.encode("utf-8", errors="ignore")) > a.max_line_bytes: continue
                s = severity(line); sev[s] += 1; ts = best_timestamp(line)
                msgid = None
                if a.product == "ace":
                    m = ACE_ID.search(line); msgid = m.group(1).upper() if m else None
                    if msgid:
                        ids[msgid] += 1; id_files[msgid].add(path); id_example.setdefault(msgid, line.strip()[:600])
                        if ts and msgid not in id_first: id_first[msgid] = ts
                        if ts: id_last[msgid] = ts
                norm = normalize_message(line)
                if s in {"critical","error","warning","alert"} or msgid:
                    fp = hashlib.sha256(f"{cls}|{norm}".encode()).hexdigest()[:16]; fingerprints[fp] += 1
                    ev.write(json.dumps({"product":a.product,"file":path,"line":line_no,"class":cls,"timestamp":ts,"severity":s,"message_id":msgid,"fingerprint":fp,"text":line.strip()[:2000]}, ensure_ascii=False)+"\n")
            file_stats.append({"path":path,"class":cls,"bytes":len(raw),"lines":file_lines})

    catalog = out / ("ace-message-catalog.csv" if a.product == "ace" else "message-pattern-catalog.csv")
    with catalog.open("w", newline="", encoding="utf-8") as f:
        w=csv.writer(f)
        if a.product == "ace":
            w.writerow(["message_id","count","first_seen","last_seen","file_count","example"])
            for mid,count in ids.most_common(): w.writerow([mid,count,id_first.get(mid,""),id_last.get(mid,""),len(id_files[mid]),id_example.get(mid,"")])
        else:
            w.writerow(["fingerprint","count"])
            for fp,count in fingerprints.most_common(): w.writerow([fp,count])

    candidates=[]
    if a.product == "ace":
        for mid,count in ids.most_common(200):
            score = count + 3*len(id_files[mid])
            candidates.append({"kind":"ace_message","key":mid,"count":count,"file_count":len(id_files[mid]),"score":score,"example":id_example.get(mid),"first_seen":id_first.get(mid),"last_seen":id_last.get(mid)})
    for fp,count in fingerprints.most_common(200):
        if count >= 2: candidates.append({"kind":"recurring_pattern","key":fp,"count":count,"score":count})
    candidates.sort(key=lambda x:(-x["score"],-x["count"],x["key"]))
    (out/"demo-candidates.json").write_text(json.dumps({"schema_version":"osi.demo-log-candidates/v1","product":a.product,"generated_at":datetime.now(timezone.utc).isoformat(),"candidates":candidates[:250],"warning":"Heuristic discovery output only. Validate against topology, runtime evidence and source logs before demo use."}, indent=2), encoding="utf-8")
    (out/"summary.json").write_text(json.dumps({"schema_version":"osi.historical-log-analysis/v1","product":a.product,"source":str(source),"files":files_total,"bytes":bytes_total,"lines":lines_total,"evidence_classes":classes,"severities":sev,"message_ids":ids.most_common(100) if a.product=="ace" else [],"top_patterns":fingerprints.most_common(100),"file_stats":file_stats,"database_written":False}, indent=2, default=lambda x:dict(x)), encoding="utf-8")
    print(f"Analyzed {files_total} files / {lines_total} lines -> {out}")

if __name__ == "__main__": main()
