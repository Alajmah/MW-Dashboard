#!/usr/bin/env python3
import argparse, hashlib, json, re, tarfile
from pathlib import PurePosixPath

DISPLAY_RE = re.compile(r'^AMQ\d+[A-Z]:.*Display .* details\.$')
ATTR_START_RE = re.compile(r'([A-Z][A-Z0-9_]*)\(')


def parse_attrs_line(line):
    out=[]; i=0
    while i < len(line):
        m=ATTR_START_RE.search(line,i)
        if not m: break
        key=m.group(1); p=m.end()-1; depth=0; j=p
        while j < len(line):
            if line[j]=='(': depth+=1
            elif line[j]==')':
                depth-=1
                if depth==0:
                    out.append((key,line[p+1:j].strip())); i=j+1; break
            j+=1
        else: break
    return out


def parse_blocks(text):
    blocks=[]; cur=None
    for line in text.splitlines():
        if line.startswith('AMQ'):
            if DISPLAY_RE.match(line):
                if cur: blocks.append(cur)
                cur={'_message':line.strip()}
            continue
        if cur is not None:
            for k,v in parse_attrs_line(line):
                if k in cur:
                    if not isinstance(cur[k],list): cur[k]=[cur[k]]
                    cur[k].append(v)
                else: cur[k]=v
    if cur: blocks.append(cur)
    return blocks


def h(s): return hashlib.sha256(s.encode()).hexdigest()
def node_id(t,e,scope,name): return 'n_'+h(f'{t}|{e}|{scope}|{name}')[:20]
def edge_id(s,r,t): return 'e_'+h(f'{s}|{r}|{t}')[:20]

def conname_host(v):
    if not v: return ''
    first=v.split(',')[0].strip()
    m=re.match(r'^(.*)\((\d+)\)$',first)
    return (m.group(1) if m else first).strip()

def infer_env(fqdn):
    x=fqdn.lower()
    for key,val in [('prod','prod'),('production','prod'),('uat','uat'),('test','test'),('dev','dev')]:
        if re.search(rf'(^|[.\-_]){key}([.\-_]|$)',x): return val
    return 'default'

class Archive:
    def __init__(self,path):
        self.tf=tarfile.open(path,'r:gz')
        ms=self.tf.getmembers()
        names=[m.name for m in ms if m.isfile()]
        roots={PurePosixPath(n).parts[0] for n in names if PurePosixPath(n).parts}
        if len(roots)!=1: raise ValueError('archive must contain exactly one top-level directory')
        self.root=next(iter(roots))
        for m in ms:
            p=PurePosixPath(m.name)
            if p.is_absolute() or '..' in p.parts or m.issym() or m.islnk():
                raise ValueError(f'unsafe tar member: {m.name}')
    def text(self,rel,required=True):
        name=f'{self.root}/{rel}'
        try: f=self.tf.extractfile(name)
        except KeyError: f=None
        if not f:
            if required: raise FileNotFoundError(name)
            return ''
        return f.read().decode('utf-8','replace')
    def members(self,prefix):
        full=f'{self.root}/{prefix}'
        return sorted(m.name[len(self.root)+1:] for m in self.tf.getmembers() if m.isfile() and m.name.startswith(full))

class Builder:
    def __init__(self,env): self.env=env; self.nodes={}; self.edges={}
    def node(self,t,name,scope='global',status=None,metadata=None):
        nid=node_id(t,self.env,scope,name)
        md=dict(metadata or {})
        if nid in self.nodes:
            old=self.nodes[nid]
            old['metadata'].update({k:v for k,v in md.items() if v not in (None,'',[])})
            if status: old['status']=status
        else:
            self.nodes[nid]={'id':nid,'type':t,'name':name,'environment':self.env,'scope':scope,'status':status,'metadata':md}
        return nid
    def edge(self,s,r,t,source,confidence=1.0,evidence=None,metadata=None):
        eid=edge_id(s,r,t); md=dict(metadata or {})
        if eid in self.edges:
            e=self.edges[eid]
            rank={'inferred':0,'configured':1,'observed':2}
            if rank[source]>rank[e['relationship_source']]: e['relationship_source']=source
            e['confidence']=max(e['confidence'],confidence)
            ev=set(e['metadata'].get('evidence_files',[]))
            if evidence: ev.add(evidence)
            if ev: e['metadata']['evidence_files']=sorted(ev)
            for k,v in md.items():
                if k not in e['metadata']: e['metadata'][k]=v
                elif e['metadata'][k]!=v:
                    vals=e['metadata'][k] if isinstance(e['metadata'][k],list) else [e['metadata'][k]]
                    if v not in vals: vals.append(v)
                    e['metadata'][k]=vals
        else:
            if evidence: md['evidence_files']=[evidence]
            self.edges[eid]={'id':eid,'source':s,'relationship':r,'target':t,'relationship_source':source,'confidence':confidence,'evidence':evidence,'metadata':md}
        return eid

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('archive')
    ap.add_argument('-o','--output',default='normalized-topology.json')
    ap.add_argument('--environment')
    args=ap.parse_args()
    a=Archive(args.archive)
    manifest=dict(line.split('=',1) for line in a.text('manifest.properties').splitlines() if '=' in line)
    fqdn=a.text('host/hostname-fqdn.out').strip()
    host=a.text('host/hostname.out').strip() or manifest.get('host','unknown')
    env=args.environment or infer_env(fqdn)
    b=Builder(env)

    ips=[]
    for line in a.text('host/ip-addresses.out',False).splitlines():
        m=re.search(r'\binet (\d+\.\d+\.\d+\.\d+)/',line)
        if m and not m.group(1).startswith('127.') and ' virbr' not in line: ips.append(m.group(1))
    primary_ip=ips[0] if ips else None
    host_id=b.node('host',host,scope='host',status='observed',metadata={'fqdn':fqdn,'ip':primary_ip,'ips':ips,'collector_host':True})

    qmgr_status={}
    for line in a.text('mq/dspmq.out').splitlines():
        m=re.search(r'QMNAME\(([^)]+)\).*STATUS\(([^)]+)\)',line)
        if m: qmgr_status[m.group(1)]=m.group(2)
    qrows=[]
    for line in a.text('qmgrs.tsv').splitlines()[1:]:
        if '\t' in line: qrows.append(tuple(line.split('\t',1)))

    local_qmgr_ids={}; queue_ids={}; channel_ids={}

    for qdir,qname in qrows:
        qmgr_cfg=parse_blocks(a.text(f'qmgr/{qdir}/config/qmgr.out'))
        qm=qmgr_cfg[0] if qmgr_cfg else {}
        qid=b.node('qmgr',qname,scope=host,status=qmgr_status.get(qname),metadata={'description':qm.get('DESCR',''),'qmid':qm.get('QMID',''),'cmdlevel':qm.get('CMDLEVEL',''),'platform':qm.get('PLATFORM',''),'version':qm.get('VERSION',''),'repos':qm.get('REPOS','')})
        local_qmgr_ids[qname]=qid
        b.edge(host_id,'HOSTS',qid,'configured',1.0,f'qmgr/{qdir}/config/qmgr.out')

        for filelabel,qtype in [('queues-local','QLOCAL'),('queues-remote','QREMOTE'),('queues-alias','QALIAS')]:
            for rec in parse_blocks(a.text(f'qmgr/{qdir}/config/{filelabel}.out')):
                name=rec.get('QUEUE') or rec.get('QNAME')
                if not name: continue
                md={'queue_type':qtype,'system':name.startswith('SYSTEM.')}
                for k in ['USAGE','RNAME','RQMNAME','XMITQ','TARGET','CLUSTER','CLUSNL','DESCR','PUT','GET','DEFBIND','DEFPSIST','MAXDEPTH','MAXMSGL']:
                    if rec.get(k) not in (None,''): md[k.lower()]=rec.get(k)
                qn=b.node('queue',name,scope=qname,metadata=md)
                queue_ids[(qname,name)]=qn
                b.edge(qid,'OWNS',qn,'configured',1.0,f'qmgr/{qdir}/config/{filelabel}.out',{'queue_type':qtype})

        for rec in parse_blocks(a.text(f'qmgr/{qdir}/config/channels.out')):
            name=rec.get('CHANNEL')
            if not name: continue
            md={'channel_type':rec.get('CHLTYPE',''),'system':name.startswith('SYSTEM.')}
            for k in ['CONNAME','XMITQ','MCAUSER','SSLCIPH','SSLCAUTH','CLUSTER','CLUSNL','DESCR','TRPTYPE']:
                if rec.get(k) not in (None,''): md[k.lower()]=rec.get(k)
            cn=b.node('channel',name,scope=qname,metadata=md)
            channel_ids[(qname,name)]=cn
            b.edge(qid,'OWNS',cn,'configured',1.0,f'qmgr/{qdir}/config/channels.out',{'channel_type':rec.get('CHLTYPE','')})
            xq=rec.get('XMITQ','')
            if xq:
                xqid=queue_ids.get((qname,xq)) or b.node('queue',xq,scope=qname,metadata={'queue_type':'XMITQ','system':xq.startswith('SYSTEM.')})
                queue_ids[(qname,xq)]=xqid
                b.edge(xqid,'TRANSMITS_VIA',cn,'configured',1.0,f'qmgr/{qdir}/config/channels.out')

        for rec in parse_blocks(a.text(f'qmgr/{qdir}/config/listeners.out')):
            name=rec.get('LISTENER')
            if not name: continue
            ln=b.node('listener',name,scope=qname,metadata={k.lower():rec.get(k) for k in ['TRPTYPE','CONTROL','IPADDR','PORT','DESCR'] if rec.get(k) not in (None,'')})
            b.edge(qid,'OWNS',ln,'configured',1.0,f'qmgr/{qdir}/config/listeners.out')

        for rec in parse_blocks(a.text(f'qmgr/{qdir}/config/queues-remote.out')):
            src=rec.get('QUEUE'); rqm=rec.get('RQMNAME',''); rn=rec.get('RNAME',''); xq=rec.get('XMITQ','')
            if not src or not rqm: continue
            srcid=queue_ids.get((qname,src)); rqmid=local_qmgr_ids.get(rqm) or b.node('qmgr',rqm,scope='remote',metadata={'remote':True})
            if rn:
                dst=b.node('queue',rn,scope=rqm,metadata={'queue_type':'REMOTE_TARGET','system':rn.startswith('SYSTEM.')})
                b.edge(rqmid,'OWNS',dst,'configured',1.0,f'qmgr/{qdir}/config/queues-remote.out')
                if srcid: b.edge(srcid,'ALIASES_TO',dst,'configured',1.0,f'qmgr/{qdir}/config/queues-remote.out')
            if srcid and xq:
                xqid=queue_ids.get((qname,xq)) or b.node('queue',xq,scope=qname,metadata={'queue_type':'XMITQ'})
                queue_ids[(qname,xq)]=xqid
                b.edge(srcid,'ROUTES_TO',xqid,'configured',1.0,f'qmgr/{qdir}/config/queues-remote.out',{'remote_qmgr':rqm})

        for rec in parse_blocks(a.text(f'qmgr/{qdir}/config/queues-cluster.out')):
            name=rec.get('QUEUE'); owner=rec.get('CLUSQMGR'); cluster=rec.get('CLUSTER','')
            if not name or not owner: continue
            oq=local_qmgr_ids.get(owner) or b.node('qmgr',owner,scope='remote',metadata={'remote':owner not in local_qmgr_ids})
            cq=b.node('queue',name,scope=owner,metadata={'queue_type':'QCLUSTER','cluster':cluster,'cluster_queue_type':rec.get('CLUSQT',''),'system':name.startswith('SYSTEM.')})
            b.edge(oq,'OWNS',cq,'configured',1.0,f'qmgr/{qdir}/config/queues-cluster.out',{'cluster':cluster})
            b.edge(qid,'CLUSTER_DISCOVERS',cq,'configured',1.0,f'qmgr/{qdir}/config/queues-cluster.out',{'cluster':cluster,'owner_qmgr':owner})

    app_ids={}
    for qdir,qname in qrows:
        qid=local_qmgr_ids[qname]
        samples=sorted({PurePosixPath(x).parts[3] for x in a.members(f'qmgr/{qdir}/runtime/') if len(PurePosixPath(x).parts)>4})
        for sname in samples:
            base=f'qmgr/{qdir}/runtime/{sname}'
            for rec in parse_blocks(a.text(f'{base}/channel-status.out',False)):
                ch=rec.get('CHANNEL'); status=rec.get('STATUS',''); rqm=rec.get('RQMNAME',''); con=rec.get('CONNAME',''); ctype=rec.get('CHLTYPE','')
                if not ch: continue
                cid=channel_ids.get((qname,ch)) or b.node('channel',ch,scope=qname,metadata={'channel_type':ctype})
                channel_ids[(qname,ch)]=cid
                b.nodes[cid]['status']=status or b.nodes[cid].get('status')
                if rqm:
                    rid=local_qmgr_ids.get(rqm) or b.node('qmgr',rqm,scope='remote',status='observed',metadata={'remote':rqm not in local_qmgr_ids})
                    hostpart=conname_host(con)
                    if hostpart:
                        rh=b.node('host',hostpart,scope='endpoint',status='observed',metadata={'ip':hostpart if re.match(r'^\d+\.\d+\.\d+\.\d+$',hostpart) else None,'remote_endpoint':True})
                        b.edge(rh,'HOSTS',rid,'observed',1.0,f'{base}/channel-status.out',{'channel':ch})
                    if ctype in ('SDR','CLUSSDR'):
                        b.edge(cid,'CONNECTS_TO',rid,'observed',1.0,f'{base}/channel-status.out',{'conname':con,'status':status})
                    elif ctype in ('RCVR','CLUSRCVR'):
                        b.edge(rid,'CONNECTS_VIA',cid,'observed',1.0,f'{base}/channel-status.out',{'conname':con,'status':status})

            for rec in parse_blocks(a.text(f'{base}/connections.out',False)):
                app=rec.get('APPLTAG'); atype=rec.get('APPLTYPE',''); ch=rec.get('CHANNEL',''); con=rec.get('CONNAME','')
                if not app: continue
                hpart=conname_host(con)
                ahost=host_id if not hpart else b.node('host',hpart,scope='client',status='observed',metadata={'ip':hpart if re.match(r'^\d+\.\d+\.\d+\.\d+$',hpart) else None,'client':True})
                ascope=f'{qname}|{hpart or host}'
                sysapp=(atype!='USER' or app.lower().startswith(('amq','runmq','kmq')))
                aid=app_ids.get((ascope,app)) or b.node('application',app,scope=ascope,status='observed',metadata={'application_type':atype,'user_id':rec.get('USERID',''),'pid':rec.get('PID',''),'system':sysapp})
                app_ids[(ascope,app)]=aid
                b.edge(ahost,'HOSTS',aid,'observed',1.0,f'{base}/connections.out')
                if ch:
                    cid=channel_ids.get((qname,ch)) or b.node('channel',ch,scope=qname,metadata={'channel_type':'SVRCONN'})
                    channel_ids[(qname,ch)]=cid
                    b.edge(aid,'CONNECTS_VIA',cid,'observed',1.0,f'{base}/connections.out',{'conname':con})
                    b.edge(cid,'CONNECTS_TO',qid,'configured',1.0,f'qmgr/{qdir}/config/channels.out')

            for rec in parse_blocks(a.text(f'{base}/queue-handles.out',False)):
                q=rec.get('QUEUE'); app=rec.get('APPLTAG'); atype=rec.get('APPLTYPE',''); ch=rec.get('CHANNEL',''); con=rec.get('CONNAME','')
                if not q or not app: continue
                qnode=queue_ids.get((qname,q)) or b.node('queue',q,scope=qname,metadata={'queue_type':'OBSERVED','system':q.startswith('SYSTEM.')})
                queue_ids[(qname,q)]=qnode
                hpart=conname_host(con)
                ahost=host_id if not hpart else b.node('host',hpart,scope='client',status='observed',metadata={'ip':hpart if re.match(r'^\d+\.\d+\.\d+\.\d+$',hpart) else None,'client':True})
                ascope=f'{qname}|{hpart or host}'
                aid=app_ids.get((ascope,app)) or b.node('application',app,scope=ascope,status='observed',metadata={'application_type':atype,'user_id':rec.get('USERID',''),'system':(atype!='USER' or app.lower().startswith(('amq','runmq','kmq')))})
                app_ids[(ascope,app)]=aid
                b.edge(ahost,'HOSTS',aid,'observed',1.0,f'{base}/queue-handles.out')
                target_source=aid
                if ch:
                    cid=channel_ids.get((qname,ch)) or b.node('channel',ch,scope=qname,metadata={'channel_type':'SVRCONN'})
                    channel_ids[(qname,ch)]=cid
                    b.edge(aid,'CONNECTS_VIA',cid,'observed',1.0,f'{base}/queue-handles.out',{'conname':con})
                    b.edge(cid,'CONNECTS_TO',qid,'configured',1.0,f'qmgr/{qdir}/config/channels.out')
                    target_source=cid
                if rec.get('OUTPUT')=='YES':
                    b.edge(target_source,'PUTS_TO',qnode,'observed',1.0,f'{base}/queue-handles.out',{'application':app,'client':hpart})
                if rec.get('INPUT') not in (None,'','NO'):
                    b.edge(target_source,'GETS_FROM',qnode,'observed',1.0,f'{base}/queue-handles.out',{'application':app,'client':hpart,'input_mode':rec.get('INPUT')})
                    b.edge(qnode,'CONSUMED_BY',aid,'observed',1.0,f'{base}/queue-handles.out',{'via_channel':ch or None})

            for rec in parse_blocks(a.text(f'{base}/queue-status.out',False)):
                q=rec.get('QUEUE')
                if not q: continue
                qnode=queue_ids.get((qname,q))
                if qnode:
                    md=b.nodes[qnode]['metadata']
                    for k in ['CURDEPTH','IPPROCS','OPPROCS','UNCOM','LGETDATE','LGETTIME','LPUTDATE','LPUTTIME']:
                        if rec.get(k) not in (None,''): md['runtime_'+k.lower()]=rec.get(k)
                    md['runtime_sample']=sname

    discovery={
      'collector':'mq-topology-collector.sh',
      'collector_version':manifest.get('collector_version'),
      'started_at':manifest.get('started_at_utc'),
      'completed_at':manifest.get('completed_at_utc'),
      'source_host':host,
      'notes':[f"Normalized from raw archive format {manifest.get('format')} v{manifest.get('format_version')}",f"Runtime samples: {manifest.get('samples')} at {manifest.get('interval_seconds')} second interval"]
    }
    snap={
      'schema_version':'1.0',
      'snapshot_id':'snap_'+manifest.get('completed_at_utc','').replace('-','').replace(':','')+'_'+h(host+manifest.get('completed_at_utc',''))[:10],
      'created_at':manifest.get('completed_at_utc'),
      'environment':env,
      'discovery':discovery,
      'nodes':sorted(b.nodes.values(),key=lambda x:(x['type'],x['scope'],x['name'])),
      'edges':sorted(b.edges.values(),key=lambda x:(x['relationship'],x['source'],x['target']))
    }
    with open(args.output,'w',encoding='utf-8') as f: json.dump(snap,f,indent=2,sort_keys=False)
    counts={}
    for n in snap['nodes']: counts[n['type']]=counts.get(n['type'],0)+1
    print(json.dumps({'output':args.output,'environment':env,'nodes':len(snap['nodes']),'edges':len(snap['edges']),'node_types':counts},indent=2))

if __name__=='__main__': main()
