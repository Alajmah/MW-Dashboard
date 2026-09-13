#!/usr/bin/env node
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const td=await mkdtemp(join(tmpdir(),'osi-integrated-ci-'));
const evIds=Array.from({length:15},(_,i)=>`ev:test:${String(i+1).padStart(2,'0')}`);
const entities=[];
function ent(id,kind,name,status='observed',attributes={},ev=0){entities.push({id,kind,name,technology:'sanitized-test',status,time_scope:'current',attributes,evidence_refs:[evIds[ev%evIds.length]]});}
ent('host:ace-a','physical_host','ace-a','observed',{ip:'192.0.2.21'},0);
ent('ace:node:ace-a:INODEA','ace_integration_node','INODEA','running',{physical_host:'ace-a',ace_version:'12.x'},1);
for(const [i,h,ip] of [[0,'dp-a','192.0.2.10'],[1,'dp-b','192.0.2.11']]){ent(`host:${h}`,'physical_host',h,'observed',{ip},2+i);ent(`datapower:runtime:${h}`,'datapower_runtime',`DataPower on ${h}`,'running',{management_endpoint:`https://${ip}:5550/service/mgmt/current`,version:'10.x'},4+i);}
ent('datapower:domain:APP_DOMAIN','datapower_domain','APP_DOMAIN','observed',{},6);
ent('datapower:http-handler:APP_DOMAIN:HTTP_FSH','datapower_front_handler','HTTP_FSH','configured',{local_address:'127.0.0.1',local_port:6027},7);
ent('datapower:mpgw:APP_DOMAIN:DP_GATEWAY','datapower_service','DP_GATEWAY','up',{},8);
ent('datapower:style-policy:APP_DOMAIN:POLICY','datapower_policy','POLICY','configured',{},9);
ent('datapower:style-rule:APP_DOMAIN:RULE','datapower_policy_rule','RULE','configured',{},10);
ent('datapower:style-action:APP_DOMAIN:ACTION','datapower_policy_action','ACTION','configured',{},11);
ent('datapower:static-resource:APP_DOMAIN:route.xsl','static_route_resource','route.xsl','hash-parity',{resource_path:'local:///Services/APP/route.xsl',route_uri_literal:'dpmq://GWQM/?RequestQueue=APP.REQUEST.IN',sha256_by_node:{'dp-a':'a'.repeat(64),'dp-b':'a'.repeat(64)}},12);
ent('datapower:mqqm-group:APP_DOMAIN:GWQM','datapower_mq_manager_group','GWQM','up',{},13);
ent('mq:qmgr:GWQM01P','mq_queue_manager','GWQM01P','running',{monchl:'OFF'},14);
ent('mq:queue:APP.REQUEST.IN','mq_queue','APP.REQUEST.IN','configured-target',{},0);
ent('mq:channel:SVRCON_DP','mq_channel','SVRCON_DP','observed',{},1);
const edges=['dp-a','dp-b'].map((h,i)=>({id:`edge:observed-client:host:${h}:GWQM01P`,source:`host:${h}`,target:'mq:qmgr:GWQM01P',relationship:'observed_client_connection',epistemic:'observed',time_scope:'current',status:'present',attributes:{client_ip:`192.0.2.${10+i}`,application_tags:['DataPower MQClient'],channels:['SVRCON_DP'],sample_connection_count:2},evidence_refs:[evIds[2+i]]}));
const graph={format:'osi-estate-graph',version:'0.1',generated_at:'2026-09-13T12:00:00Z',scope:['sanitized-test'],epistemic_values:['configured','observed','derived','inferred'],entities,edges};
const routeSteps=[['datapower:domain:APP_DOMAIN','APP_DOMAIN','observed'],['datapower:http-handler:APP_DOMAIN:HTTP_FSH','HTTP handler 127.0.0.1:6027','configured'],['datapower:mpgw:APP_DOMAIN:DP_GATEWAY','DP_GATEWAY','configured'],['datapower:style-policy:APP_DOMAIN:POLICY','StylePolicy','configured'],['datapower:style-rule:APP_DOMAIN:RULE','Request rule','configured'],['datapower:style-action:APP_DOMAIN:ACTION','XSLT action','configured'],['datapower:static-resource:APP_DOMAIN:route.xsl','Static route resource','derived'],['datapower:mqqm-group:APP_DOMAIN:GWQM','GWQM','derived+configured'],['mq:qmgr:GWQM01P','GWQM01P','configured+observed'],['mq:queue:APP.REQUEST.IN','APP.REQUEST.IN','derived']];
const route={format:'osi-qualified-route',version:'0.1',id:'route:test:dp-to-mq',name:'DP_GATEWAY → GWQM01P',status:'qualified',time_scope:'current',route_uri_literal:'dpmq://GWQM/?RequestQueue=APP.REQUEST.IN',queue:'APP.REQUEST.IN',steps:routeSteps.map(([entity,label,epistemic])=>({entity,label,epistemic})),runtime_corroboration_edges:['edge:observed-client:host:dp-a:GWQM01P','edge:observed-client:host:dp-b:GWQM01P'],evidence_refs:evIds,interpretation:'Sanitized qualified route fixture.'};
const evidence={format:'osi-evidence-index',version:'0.1',evidence:evIds.map((id,i)=>({id,artifact:`sanitized-${i+1}.json`,artifact_sha256:'abcdef0123456789'.repeat(4),internal_path:`fixture/${i+1}`,class:'sanitized-test',time_scope:'current',source_time:null,description:'Sanitized CI evidence.'}))};
for(const [name,value] of [['graph.json',graph],['route.json',route],['evidence.json',evidence]]) await writeFile(join(td,name),JSON.stringify(value));
const out=join(td,'bundle.json');
const proc=spawnSync(process.execPath,[join(root,'scripts/normalize-integrated-evidence.mjs'),'--graph',join(td,'graph.json'),'--route',join(td,'route.json'),'--evidence',join(td,'evidence.json'),'--source-id','ci-integrated-projection','--environment','ci','--output',out],{encoding:'utf8'});
if(proc.status!==0) throw new Error(proc.stderr||proc.stdout||'normalizer failed');
const b=JSON.parse(await readFile(out,'utf8')); const assert=(v,m)=>{if(!v)throw new Error(m)};
assert(b.schema_version==='osi.observation.bundle/v2','schema');
assert(b.run.collector==='osi-integrated-evidence-projection','collector');
assert(b.run.normalizer_version==='3.1.0','semantic normalizer contract');
assert(b.run.metadata?.excludes_historical===true,'historical exclusion');
assert(b.entities.some(x=>x.semantic_type==='ace.integration_node'),'ACE node missing');
assert(b.entities.filter(x=>x.semantic_type==='datapower.appliance').length===2,'DataPower appliances');
const target=b.entities.find(x=>x.semantic_type==='mq.queue'&&x.display_name==='APP.REQUEST.IN'); assert(target,'route target queue'); assert(target.properties?.route_target===true,'route target marker'); assert(!Object.hasOwn(target.properties||{},'queue_type'),'static route must not invent MQ queue type');
const routes=b.relations.filter(x=>x.semantic_type==='integration.routes_to'); assert(routes.length===2,'two active-active route relations');
for(const r of routes){assert(r.evidence_class==='configured','route evidence');assert(r.derivation_method==='deterministic_static_route_projection','derivation');assert(r.deterministic===true,'deterministic');assert(r.properties?.epistemic==='derived','derived property');assert(r.properties?.qualified_route===true,'qualified route');assert(r.properties?.qualified_route_chain?.length>=8,'route chain');assert(r.properties?.runtime_corroboration?.length===1,'runtime corroboration separation');}
const net=b.relations.filter(x=>x.semantic_type==='network.connects_to'); assert(net.some(x=>x.evidence_class==='configured'),'configured backend'); assert(net.some(x=>x.evidence_class==='observed'),'observed backend');
assert(!JSON.stringify(b).includes('SVEGW01P'),'real queue manager leaked into sanitized test');
assert(!JSON.stringify(b).includes('sjeditb'),'real hostname leaked into sanitized test');
console.log(`Integrated observation bundle OK: ${b.entities.length} entities, ${b.relations.length} relations`);