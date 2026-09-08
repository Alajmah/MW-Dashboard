#!/usr/bin/env python3
import argparse
import hashlib
import json
import re
import tarfile
from pathlib import PurePosixPath

DISPLAY_RE = re.compile(r'^AMQ\d+[A-Z]:.*Display .* details\.$', re.IGNORECASE)
ATTR_START_RE = re.compile(r'([A-Z][A-Z0-9_]*)\(')
IPV4_RE = re.compile(r'^\d+\.\d+\.\d+\.\d+$')


def parse_attrs_line(line):
    out = []
    i = 0
    while i < len(line):
        m = ATTR_START_RE.search(line, i)
        if not m:
            break
        key = m.group(1)
        p = m.end() - 1
        depth = 0
        j = p
        while j < len(line):
            if line[j] == '(':
                depth += 1
            elif line[j] == ')':
                depth -= 1
                if depth == 0:
                    out.append((key, line[p + 1:j].strip()))
                    i = j + 1
                    break
            j += 1
        else:
            break
    return out


def parse_blocks(text):
    blocks = []
    cur = None
    for line in text.splitlines():
        if line.startswith('AMQ'):
            if DISPLAY_RE.match(line):
                if cur:
                    blocks.append(cur)
                cur = {'_message': line.strip()}
            continue
        if cur is not None:
            for k, v in parse_attrs_line(line):
                if k in cur:
                    if not isinstance(cur[k], list):
                        cur[k] = [cur[k]]
                    cur[k].append(v)
                else:
                    cur[k] = v
    if cur:
        blocks.append(cur)
    return blocks


def h(s):
    return hashlib.sha256(s.encode()).hexdigest()


def node_id(t, e, scope, identity):
    return 'n_' + h(f'{t}|{e}|{scope}|{identity}')[:20]


def edge_id(s, r, t):
    return 'e_' + h(f'{s}|{r}|{t}')[:20]


def parse_conname_endpoints(v):
    out = []
    if not v:
        return out
    for raw in v.split(','):
        raw = raw.strip()
        if not raw:
            continue
        m = re.match(r'^(.*)\((\d+)\)$', raw)
        if m:
            host = m.group(1).strip()
            port = m.group(2)
        else:
            host = raw
            port = ''
        out.append({'host': host, 'port': port, 'raw': raw})
    return out


def conname_host(v):
    endpoints = parse_conname_endpoints(v)
    return endpoints[0]['host'] if endpoints else ''


def infer_env(fqdn):
    x = fqdn.lower()
    for key, val in [('prod', 'prod'), ('production', 'prod'), ('uat', 'uat'), ('test', 'test'), ('dev', 'dev')]:
        if re.search(rf'(^|[.\-_]){key}([.\-_]|$)', x):
            return val
    return 'default'


def is_ip(value):
    return bool(IPV4_RE.match(value or ''))


def merge_value(old, new):
    if new in (None, '', []):
        return old
    if old in (None, '', []):
        return new
    if old == new:
        return old
    old_items = old if isinstance(old, list) else [old]
    new_items = new if isinstance(new, list) else [new]
    out = []
    for value in old_items + new_items:
        if value not in out:
            out.append(value)
    return out


def merge_metadata(dst, src):
    for k, v in (src or {}).items():
        if v in (None, '', []):
            continue
        dst[k] = merge_value(dst.get(k), v)
    return dst


class Archive:
    def __init__(self, path):
        self.tf = tarfile.open(path, 'r:gz')
        ms = self.tf.getmembers()
        names = [m.name for m in ms if m.isfile()]
        roots = {PurePosixPath(n).parts[0] for n in names if PurePosixPath(n).parts}
        if len(roots) != 1:
            raise ValueError('archive must contain exactly one top-level directory')
        self.root = next(iter(roots))
        for m in ms:
            p = PurePosixPath(m.name)
            if p.is_absolute() or '..' in p.parts or m.issym() or m.islnk():
                raise ValueError(f'unsafe tar member: {m.name}')

    def text(self, rel, required=True):
        name = f'{self.root}/{rel}'
        try:
            f = self.tf.extractfile(name)
        except KeyError:
            f = None
        if not f:
            if required:
                raise FileNotFoundError(name)
            return ''
        return f.read().decode('utf-8', 'replace')

    def members(self, prefix):
        full = f'{self.root}/{prefix}'
        return sorted(
            m.name[len(self.root) + 1:]
            for m in self.tf.getmembers()
            if m.isfile() and m.name.startswith(full)
        )


class Builder:
    def __init__(self, env):
        self.env = env
        self.nodes = {}
        self.edges = {}

    def node(self, t, name, scope='global', status=None, metadata=None, identity=None):
        identity = identity or name
        nid = node_id(t, self.env, scope, identity)
        md = dict(metadata or {})
        if nid in self.nodes:
            old = self.nodes[nid]
            merge_metadata(old['metadata'], md)
            if status:
                current = old.get('status')
                if current in (None, '', 'unverified', 'observed') or status not in ('observed', 'unverified'):
                    old['status'] = status
            if t == 'host' and is_ip(old['name']) and not is_ip(name):
                old['name'] = name
        else:
            self.nodes[nid] = {
                'id': nid,
                'type': t,
                'name': name,
                'environment': self.env,
                'scope': scope,
                'status': status,
                'metadata': md,
            }
        return nid

    def edge(self, s, r, t, source, confidence=1.0, evidence=None, metadata=None):
        eid = edge_id(s, r, t)
        md = dict(metadata or {})
        if eid in self.edges:
            e = self.edges[eid]
            rank = {'inferred': 0, 'configured': 1, 'observed': 2}
            if rank[source] > rank[e['relationship_source']]:
                e['relationship_source'] = source
            e['confidence'] = max(e['confidence'], confidence)
            if evidence:
                files = e['metadata'].get('evidence_files', [])
                files = files if isinstance(files, list) else [files]
                if evidence not in files:
                    files.append(evidence)
                e['metadata']['evidence_files'] = sorted(files)
            merge_metadata(e['metadata'], md)
        else:
            if evidence:
                md['evidence_files'] = [evidence]
            self.edges[eid] = {
                'id': eid,
                'source': s,
                'relationship': r,
                'target': t,
                'relationship_source': source,
                'confidence': confidence,
                'evidence': evidence,
                'metadata': md,
            }
        return eid


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('archive')
    ap.add_argument('-o', '--output', default='normalized-topology.json')
    ap.add_argument('--environment')
    args = ap.parse_args()

    a = Archive(args.archive)
    manifest = dict(
        line.split('=', 1)
        for line in a.text('manifest.properties').splitlines()
        if '=' in line
    )
    fqdn = a.text('host/hostname-fqdn.out').strip()
    host = a.text('host/hostname.out').strip() or manifest.get('host', 'unknown')
    env = args.environment or infer_env(fqdn)
    b = Builder(env)

    ips = []
    for line in a.text('host/ip-addresses.out', False).splitlines():
        m = re.search(r'\binet (\d+\.\d+\.\d+\.\d+)/', line)
        if m and not m.group(1).startswith('127.') and ' virbr' not in line:
            ips.append(m.group(1))
    primary_ip = ips[0] if ips else None

    host_alias_to_identity = {}
    local_identity = primary_ip or fqdn or host
    for alias in [host, fqdn] + ips:
        if alias:
            host_alias_to_identity[alias.lower()] = local_identity

    def canonical_host(value, role, display_name=None, metadata=None):
        raw = (value or '').strip()
        if not raw:
            identity = local_identity
            display = host
        else:
            identity = host_alias_to_identity.get(raw.lower(), raw.lower())
            display = display_name or raw
        aliases = [x for x in [raw, display_name] if x]
        md = {'roles': [role], 'aliases': aliases}
        if is_ip(raw):
            md['ip'] = raw
        merge_metadata(md, metadata or {})
        hid = b.node('host', display, scope='host', status='observed', metadata=md, identity=identity)
        for alias in aliases:
            host_alias_to_identity[alias.lower()] = identity
        return hid

    def canonical_endpoint(conname, role, metadata=None):
        endpoint_ids = []
        for ep in parse_conname_endpoints(conname):
            identity = f"{ep['host'].lower()}:{ep['port']}" if ep['port'] else ep['host'].lower()
            display = f"{ep['host']}:{ep['port']}" if ep['port'] else ep['host']
            md = {
                'roles': [role],
                'host': ep['host'],
                'port': ep['port'] or None,
                'raw_conname': ep['raw'],
            }
            merge_metadata(md, metadata or {})
            eid = b.node('endpoint', display, scope='network', status='observed', metadata=md, identity=identity)
            endpoint_ids.append(eid)
        return endpoint_ids

    host_id = canonical_host(
        host,
        'mq_host',
        display_name=host,
        metadata={
            'fqdn': fqdn,
            'ip': primary_ip,
            'ips': ips,
            'collector_host': True,
            'aliases': [x for x in [host, fqdn] + ips if x],
        },
    )

    qmgr_status = {}
    for line in a.text('mq/dspmq.out').splitlines():
        m = re.search(r'QMNAME\(([^)]+)\).*STATUS\(([^)]+)\)', line)
        if m:
            qmgr_status[m.group(1)] = m.group(2)

    qrows = []
    for line in a.text('qmgrs.tsv').splitlines()[1:]:
        if '\t' in line:
            qrows.append(tuple(line.split('\t', 1)))

    def qmgr_node(qname, status=None, metadata=None, local=False):
        md = {'local_to_archive': bool(local)}
        if not local:
            md['remote_reference'] = True
        merge_metadata(md, metadata or {})
        return b.node('qmgr', qname, scope='qmgr', status=status, metadata=md, identity=qname)

    local_qmgr_ids = {}
    queue_ids = {}
    channel_ids = {}
    listener_ids = {}
    pending_aliases = []

    for qdir, qname in qrows:
        qmgr_cfg = parse_blocks(a.text(f'qmgr/{qdir}/config/qmgr.out'))
        qm = qmgr_cfg[0] if qmgr_cfg else {}
        qid = qmgr_node(
            qname,
            status=qmgr_status.get(qname),
            local=True,
            metadata={
                'description': qm.get('DESCR', ''),
                'qmid': qm.get('QMID', ''),
                'cmdlevel': qm.get('CMDLEVEL', ''),
                'platform': qm.get('PLATFORM', ''),
                'version': qm.get('VERSION', ''),
                'repos': qm.get('REPOS', ''),
            },
        )
        local_qmgr_ids[qname] = qid
        b.edge(host_id, 'HOSTS', qid, 'configured', 1.0, f'qmgr/{qdir}/config/qmgr.out')

    for qdir, qname in qrows:
        qid = local_qmgr_ids[qname]

        for filelabel, qtype in [
            ('queues-local', 'QLOCAL'),
            ('queues-remote', 'QREMOTE'),
            ('queues-alias', 'QALIAS'),
            ('queues-model', 'QMODEL'),
        ]:
            for rec in parse_blocks(a.text(f'qmgr/{qdir}/config/{filelabel}.out')):
                name = rec.get('QUEUE') or rec.get('QNAME')
                if not name:
                    continue
                md = {'queue_type': qtype, 'system': name.startswith('SYSTEM.')}
                for k in [
                    'USAGE', 'RNAME', 'RQMNAME', 'XMITQ', 'TARGET', 'CLUSTER', 'CLUSNL',
                    'DESCR', 'PUT', 'GET', 'DEFBIND', 'DEFPSIST', 'MAXDEPTH', 'MAXMSGL',
                ]:
                    if rec.get(k) not in (None, ''):
                        md[k.lower()] = rec.get(k)
                qn = b.node('queue', name, scope=qname, metadata=md)
                queue_ids[(qname, name)] = qn
                b.edge(qid, 'OWNS', qn, 'configured', 1.0, f'qmgr/{qdir}/config/{filelabel}.out', {'queue_type': qtype})
                if qtype == 'QALIAS' and rec.get('TARGET'):
                    pending_aliases.append((qdir, qname, qn, rec.get('TARGET')))

        for rec in parse_blocks(a.text(f'qmgr/{qdir}/config/channels.out')):
            name = rec.get('CHANNEL')
            if not name:
                continue
            md = {'channel_type': rec.get('CHLTYPE', ''), 'system': name.startswith('SYSTEM.')}
            for k in ['CONNAME', 'XMITQ', 'MCAUSER', 'SSLCIPH', 'SSLCAUTH', 'CLUSTER', 'CLUSNL', 'DESCR', 'TRPTYPE']:
                if rec.get(k) not in (None, ''):
                    md[k.lower()] = rec.get(k)
            cn = b.node('channel', name, scope=qname, metadata=md)
            channel_ids[(qname, name)] = cn
            b.edge(qid, 'OWNS', cn, 'configured', 1.0, f'qmgr/{qdir}/config/channels.out', {'channel_type': rec.get('CHLTYPE', '')})
            if rec.get('CONNAME'):
                for epid in canonical_endpoint(rec.get('CONNAME'), 'channel_target', {'transport': rec.get('TRPTYPE', '')}):
                    b.edge(cn, 'USES_ENDPOINT', epid, 'configured', 1.0, f'qmgr/{qdir}/config/channels.out')
            xq = rec.get('XMITQ', '')
            if xq:
                xqid = queue_ids.get((qname, xq)) or b.node(
                    'queue', xq, scope=qname, metadata={'queue_type': 'QLOCAL', 'usage': 'XMITQ', 'system': xq.startswith('SYSTEM.')}
                )
                queue_ids[(qname, xq)] = xqid
                b.edge(xqid, 'TRANSMITS_VIA', cn, 'configured', 1.0, f'qmgr/{qdir}/config/channels.out')

        for rec in parse_blocks(a.text(f'qmgr/{qdir}/config/listeners.out')):
            name = rec.get('LISTENER')
            if not name:
                continue
            md = {k.lower(): rec.get(k) for k in ['TRPTYPE', 'CONTROL', 'IPADDR', 'PORT', 'DESCR'] if rec.get(k) not in (None, '')}
            md['system'] = name.startswith('SYSTEM.')
            ln = b.node('listener', name, scope=qname, metadata=md)
            listener_ids[(qname, name)] = ln
            b.edge(qid, 'OWNS', ln, 'configured', 1.0, f'qmgr/{qdir}/config/listeners.out')
            port = rec.get('PORT', '')
            if port and port != '0':
                listener_conname = f"{host}({port})"
                for epid in canonical_endpoint(listener_conname, 'listener', {'qmgr': qname, 'listener': name}):
                    b.edge(ln, 'LISTENS_ON', epid, 'configured', 1.0, f'qmgr/{qdir}/config/listeners.out')
                    b.edge(epid, 'ENDPOINT_FOR', qid, 'configured', 1.0, f'qmgr/{qdir}/config/listeners.out')

        for rec in parse_blocks(a.text(f'qmgr/{qdir}/config/queues-remote.out')):
            src = rec.get('QUEUE')
            rqm = rec.get('RQMNAME', '')
            rn = rec.get('RNAME', '')
            xq = rec.get('XMITQ', '')
            if not src or not rqm:
                continue
            srcid = queue_ids.get((qname, src))
            qmgr_node(rqm, metadata={'remote_reference': rqm not in local_qmgr_ids}, local=rqm in local_qmgr_ids)
            if rn:
                dst = queue_ids.get((rqm, rn))
                if not dst:
                    dst = b.node(
                        'queue',
                        rn,
                        scope=rqm,
                        status='unverified',
                        metadata={'queue_type': 'REMOTE_TARGET', 'reference_only': True, 'system': rn.startswith('SYSTEM.')},
                    )
                    queue_ids[(rqm, rn)] = dst
                if srcid:
                    b.edge(srcid, 'ALIASES_TO', dst, 'configured', 1.0, f'qmgr/{qdir}/config/queues-remote.out', {'remote_qmgr': rqm, 'reference_only': True})
            if srcid and xq:
                xqid = queue_ids.get((qname, xq)) or b.node('queue', xq, scope=qname, metadata={'queue_type': 'QLOCAL', 'usage': 'XMITQ'})
                queue_ids[(qname, xq)] = xqid
                b.edge(srcid, 'ROUTES_TO', xqid, 'configured', 1.0, f'qmgr/{qdir}/config/queues-remote.out', {'remote_qmgr': rqm})

        for rec in parse_blocks(a.text(f'qmgr/{qdir}/config/queues-cluster.out')):
            name = rec.get('QUEUE')
            owner = rec.get('CLUSQMGR')
            cluster = rec.get('CLUSTER', '')
            if not name or not owner:
                continue
            oq = qmgr_node(owner, local=owner in local_qmgr_ids, metadata={'cluster_member': True})
            existing = queue_ids.get((owner, name))
            if existing:
                cq = existing
                merge_metadata(b.nodes[cq]['metadata'], {
                    'cluster_visible': True,
                    'cluster': cluster,
                    'cluster_queue_type': rec.get('CLUSQT', ''),
                    'cluster_owner': owner,
                })
                if b.nodes[cq]['metadata'].get('reference_only'):
                    b.nodes[cq]['metadata']['reference_only'] = False
                    if b.nodes[cq].get('status') == 'unverified':
                        b.nodes[cq]['status'] = 'observed'
            else:
                cq = b.node(
                    'queue',
                    name,
                    scope=owner,
                    status='observed',
                    metadata={
                        'queue_type': 'QCLUSTER_REMOTE',
                        'cluster_visible': True,
                        'cluster': cluster,
                        'cluster_queue_type': rec.get('CLUSQT', ''),
                        'cluster_owner': owner,
                        'system': name.startswith('SYSTEM.'),
                    },
                )
                queue_ids[(owner, name)] = cq
            b.edge(oq, 'OWNS', cq, 'configured', 1.0, f'qmgr/{qdir}/config/queues-cluster.out', {'cluster': cluster})
            b.edge(qid, 'CLUSTER_DISCOVERS', cq, 'configured', 1.0, f'qmgr/{qdir}/config/queues-cluster.out', {'cluster': cluster, 'owner_qmgr': owner})

    by_queue_name = {}
    for (owner, qname), qid in queue_ids.items():
        by_queue_name.setdefault(qname, []).append((owner, qid))
    for qdir, owner_qmgr, alias_id, target_name in pending_aliases:
        candidates = []
        local_target = queue_ids.get((owner_qmgr, target_name))
        if local_target and local_target != alias_id:
            candidates.append((owner_qmgr, local_target, 'local'))
        if not candidates:
            for target_owner, target_id in by_queue_name.get(target_name, []):
                if target_id != alias_id and b.nodes[target_id]['metadata'].get('cluster_visible'):
                    candidates.append((target_owner, target_id, 'cluster'))
        for target_owner, target_id, mode in candidates:
            b.edge(alias_id, 'ALIASES_TO', target_id, 'configured', 1.0, f'qmgr/{qdir}/config/queues-alias.out', {'resolution': mode, 'target_owner': target_owner})

    apstatus_names = {qname: set() for _, qname in qrows}
    sample_names = {}
    for qdir, qname in qrows:
        samples = sorted({
            PurePosixPath(x).parts[3]
            for x in a.members(f'qmgr/{qdir}/runtime/')
            if len(PurePosixPath(x).parts) > 4
        })
        sample_names[qname] = samples
        for sname in samples:
            for rec in parse_blocks(a.text(f'qmgr/{qdir}/runtime/{sname}/application-status.out', False)):
                if rec.get('APPLNAME'):
                    apstatus_names[qname].add(rec['APPLNAME'])

    app_ids = {}
    process_ids = {}

    def actor_for(qname, qdir, rec, evidence):
        app = rec.get('APPLTAG')
        if not app:
            return None, None, None, None
        ch = rec.get('CHANNEL', '')
        con = rec.get('CONNAME', '')
        hpart = conname_host(con)
        cid = channel_ids.get((qname, ch)) if ch else None
        ctype = b.nodes[cid]['metadata'].get('channel_type', '') if cid else ''
        is_client_app = (ctype == 'SVRCONN') or (app in apstatus_names.get(qname, set()))

        if is_client_app:
            ahost = canonical_host(hpart, 'mq_client') if hpart else host_id
            ascope = f'host:{ahost}'
            key = (ascope, app)
            aid = app_ids.get(key)
            if not aid:
                aid = b.node(
                    'application',
                    app,
                    scope=ascope,
                    status='observed',
                    metadata={
                        'application_types': [rec.get('APPLTYPE', '')] if rec.get('APPLTYPE') else [],
                        'user_ids': [rec.get('USERID', '')] if rec.get('USERID') else [],
                        'observed_qmgrs': [qname],
                        'system': False,
                    },
                )
                app_ids[key] = aid
            else:
                merge_metadata(b.nodes[aid]['metadata'], {
                    'application_types': [rec.get('APPLTYPE', '')] if rec.get('APPLTYPE') else [],
                    'user_ids': [rec.get('USERID', '')] if rec.get('USERID') else [],
                    'observed_qmgrs': [qname],
                })
            b.edge(ahost, 'HOSTS', aid, 'observed', 1.0, evidence)
            if cid:
                b.edge(aid, 'CONNECTS_VIA', cid, 'observed', 1.0, evidence, {'conname': con, 'qmgr': qname})
            return aid, 'application', hpart, cid

        pkey = (qname, app)
        pid = process_ids.get(pkey)
        if not pid:
            pid = b.node(
                'mq_process',
                app,
                scope=qname,
                status='observed',
                metadata={
                    'application_types': [rec.get('APPLTYPE', '')] if rec.get('APPLTYPE') else [],
                    'user_ids': [rec.get('USERID', '')] if rec.get('USERID') else [],
                    'pids': [rec.get('PID', '')] if rec.get('PID') else [],
                    'system': True,
                    'qmgr': qname,
                },
            )
            process_ids[pkey] = pid
        else:
            merge_metadata(b.nodes[pid]['metadata'], {
                'pids': [rec.get('PID', '')] if rec.get('PID') else [],
                'user_ids': [rec.get('USERID', '')] if rec.get('USERID') else [],
            })
        b.edge(host_id, 'HOSTS', pid, 'observed', 1.0, evidence)
        b.edge(local_qmgr_ids[qname], 'RUNS_PROCESS', pid, 'observed', 1.0, evidence)
        if cid:
            b.edge(pid, 'DRIVES_CHANNEL', cid, 'observed', 1.0, evidence, {'peer': con})
        return pid, 'mq_process', '', cid

    for qdir, qname in qrows:
        qid = local_qmgr_ids[qname]
        for sname in sample_names[qname]:
            base = f'qmgr/{qdir}/runtime/{sname}'

            for rec in parse_blocks(a.text(f'{base}/qmgr-status.out', False)):
                if rec.get('QMNAME') and rec.get('QMNAME') != qname:
                    continue
                if rec.get('STATUS'):
                    b.nodes[qid]['status'] = rec.get('STATUS')
                merge_metadata(b.nodes[qid]['metadata'], {
                    'runtime_conns': rec.get('CONNS', ''),
                    'runtime_chinit': rec.get('CHINIT', ''),
                    'runtime_cmdserv': rec.get('CMDSERV', ''),
                    'runtime_hostname': rec.get('HOSTNAME', ''),
                    'runtime_instance': rec.get('INSTNAME', ''),
                    'runtime_datpath': rec.get('DATPATH', ''),
                    'runtime_logpath': rec.get('LOGPATH', ''),
                    'runtime_sample': sname,
                })

            for rec in parse_blocks(a.text(f'{base}/listener-status.out', False)):
                name = rec.get('LISTENER')
                if not name:
                    continue
                lid = listener_ids.get((qname, name)) or b.node(
                    'listener', name, scope=qname, metadata={'system': name.startswith('SYSTEM.')}
                )
                listener_ids[(qname, name)] = lid
                if rec.get('STATUS'):
                    b.nodes[lid]['status'] = rec.get('STATUS')
                merge_metadata(b.nodes[lid]['metadata'], {
                    'runtime_ipaddr': rec.get('IPADDR', ''),
                    'runtime_port': rec.get('PORT', ''),
                    'runtime_pid': rec.get('PID', ''),
                    'runtime_backlog': rec.get('BACKLOG', ''),
                    'runtime_sample': sname,
                })

            for rec in parse_blocks(a.text(f'{base}/channel-status.out', False)):
                ch = rec.get('CHANNEL')
                status = rec.get('STATUS', '')
                rqm = rec.get('RQMNAME', '')
                con = rec.get('CONNAME', '')
                ctype = rec.get('CHLTYPE', '')
                if not ch:
                    continue
                cid = channel_ids.get((qname, ch)) or b.node('channel', ch, scope=qname, metadata={'channel_type': ctype, 'system': ch.startswith('SYSTEM.')})
                channel_ids[(qname, ch)] = cid
                if status:
                    b.nodes[cid]['status'] = status
                merge_metadata(b.nodes[cid]['metadata'], {'runtime_conname': con, 'runtime_sample': sname})
                if rqm:
                    rid = qmgr_node(rqm, status='observed', local=rqm in local_qmgr_ids, metadata={'remote_reference': rqm not in local_qmgr_ids})
                    if con:
                        for epid in canonical_endpoint(con, 'channel_peer', {'channel': ch, 'qmgr': rqm}):
                            b.edge(cid, 'USES_ENDPOINT', epid, 'observed', 1.0, f'{base}/channel-status.out')
                            b.edge(epid, 'ENDPOINT_FOR', rid, 'observed', 1.0, f'{base}/channel-status.out', {'channel': ch})
                    if ctype in ('SDR', 'CLUSSDR'):
                        b.edge(cid, 'CONNECTS_TO', rid, 'observed', 1.0, f'{base}/channel-status.out', {'conname': con, 'status': status})
                    elif ctype in ('RCVR', 'CLUSRCVR'):
                        b.edge(rid, 'CONNECTS_VIA', cid, 'observed', 1.0, f'{base}/channel-status.out', {'conname': con, 'status': status})

            for rec in parse_blocks(a.text(f'{base}/cluster-qmgrs.out', False)):
                rqm = rec.get('CLUSQMGR')
                if not rqm:
                    continue
                rid = qmgr_node(
                    rqm,
                    local=rqm in local_qmgr_ids,
                    metadata={
                        'qmid': rec.get('QMID', ''),
                        'clusters': [rec.get('CLUSTER', '')] if rec.get('CLUSTER') else [],
                        'cluster_qmtype': rec.get('QMTYPE', ''),
                        'cluster_deftype': rec.get('DEFTYPE', ''),
                        'cluster_version': rec.get('VERSION', ''),
                        'cluster_suspend': rec.get('SUSPEND', ''),
                        'cluster_link_statuses': [rec.get('STATUS', '')] if rec.get('STATUS') else [],
                    },
                )
                con = rec.get('CONNAME', '')
                ch = rec.get('CHANNEL', '')
                if ch:
                    cid = channel_ids.get((qname, ch)) or b.node(
                        'channel',
                        ch,
                        scope=qname,
                        metadata={'channel_type': 'CLUSSDR', 'system': ch.startswith('SYSTEM.'), 'auto_cluster_sender': True},
                    )
                    channel_ids[(qname, ch)] = cid
                    merge_metadata(b.nodes[cid]['metadata'], {
                        'cluster': rec.get('CLUSTER', ''),
                        'conname': con,
                        'xmitq': rec.get('XMITQ', ''),
                    })
                    if con:
                        for epid in canonical_endpoint(con, 'cluster_peer', {'cluster': rec.get('CLUSTER', ''), 'qmgr': rqm}):
                            b.edge(cid, 'USES_ENDPOINT', epid, 'observed', 1.0, f'{base}/cluster-qmgrs.out')
                            b.edge(epid, 'ENDPOINT_FOR', rid, 'configured', 1.0, f'{base}/cluster-qmgrs.out', {'cluster': rec.get('CLUSTER', '')})
                    if rec.get('STATUS'):
                        b.nodes[cid]['status'] = rec.get('STATUS')
                    b.edge(qid, 'OWNS', cid, 'observed', 1.0, f'{base}/cluster-qmgrs.out', {'cluster': rec.get('CLUSTER', '')})
                    b.edge(cid, 'CONNECTS_TO', rid, 'observed', 1.0, f'{base}/cluster-qmgrs.out', {'cluster': rec.get('CLUSTER', ''), 'conname': con})

            for rec in parse_blocks(a.text(f'{base}/connections.out', False)):
                actor_for(qname, qdir, rec, f'{base}/connections.out')

            for rec in parse_blocks(a.text(f'{base}/queue-handles.out', False)):
                q = rec.get('QUEUE')
                app = rec.get('APPLTAG')
                if not q or not app:
                    continue
                qnode = queue_ids.get((qname, q)) or b.node(
                    'queue', q, scope=qname, status='observed', metadata={'queue_type': 'OBSERVED', 'system': q.startswith('SYSTEM.')}
                )
                queue_ids[(qname, q)] = qnode
                actor_id, actor_type, hpart, cid = actor_for(qname, qdir, rec, f'{base}/queue-handles.out')
                if not actor_id:
                    continue
                via = rec.get('CHANNEL', '') or None
                common_md = {'via_channel': via, 'qmgr': qname}
                if hpart:
                    common_md['client'] = hpart
                if rec.get('OUTPUT') == 'YES':
                    b.edge(actor_id, 'PUTS_TO', qnode, 'observed', 1.0, f'{base}/queue-handles.out', common_md)
                if rec.get('INPUT') not in (None, '', 'NO'):
                    md = dict(common_md)
                    md['input_mode'] = rec.get('INPUT')
                    b.edge(actor_id, 'GETS_FROM', qnode, 'observed', 1.0, f'{base}/queue-handles.out', md)
                    if actor_type == 'application':
                        b.edge(qnode, 'CONSUMED_BY', actor_id, 'observed', 1.0, f'{base}/queue-handles.out', {'via_channel': via})

            for rec in parse_blocks(a.text(f'{base}/queue-status.out', False)):
                q = rec.get('QUEUE')
                if not q:
                    continue
                qnode = queue_ids.get((qname, q))
                if qnode:
                    md = b.nodes[qnode]['metadata']
                    for k in ['CURDEPTH', 'IPPROCS', 'OPPROCS', 'UNCOM', 'LGETDATE', 'LGETTIME', 'LPUTDATE', 'LPUTTIME']:
                        if rec.get(k) not in (None, ''):
                            md['runtime_' + k.lower()] = rec.get(k)
                    md['runtime_sample'] = sname

    discovery = {
        'collector': 'mq-topology-collector.sh',
        'collector_version': manifest.get('collector_version'),
        'normalizer_version': '2.0.0',
        'started_at': manifest.get('started_at_utc'),
        'completed_at': manifest.get('completed_at_utc'),
        'source_host': host,
        'notes': [
            f"Normalized from raw archive format {manifest.get('format')} v{manifest.get('format_version')}",
            f"Runtime samples: {manifest.get('samples')} at {manifest.get('interval_seconds')} second interval",
            'Host and queue-manager identities are canonicalized independently of observed roles/locations.',
            'MQ internal processes are separated from client applications.',
            'Network CONNAME values are endpoint objects, not asserted physical hosts.',
        ],
    }
    snap = {
        'schema_version': '1.0',
        'snapshot_id': 'snap_' + manifest.get('completed_at_utc', '').replace('-', '').replace(':', '') + '_' + h(host + manifest.get('completed_at_utc', '') + '|v2')[:10],
        'created_at': manifest.get('completed_at_utc'),
        'environment': env,
        'discovery': discovery,
        'nodes': sorted(b.nodes.values(), key=lambda x: (x['type'], x['scope'], x['name'])),
        'edges': sorted(b.edges.values(), key=lambda x: (x['relationship'], x['source'], x['target'])),
    }
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(snap, f, indent=2, sort_keys=False)
    counts = {}
    for n in snap['nodes']:
        counts[n['type']] = counts.get(n['type'], 0) + 1
    print(json.dumps({'output': args.output, 'environment': env, 'nodes': len(snap['nodes']), 'edges': len(snap['edges']), 'node_types': counts}, indent=2))


if __name__ == '__main__':
    main()
