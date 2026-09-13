#!/usr/bin/env node
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const normalizer=join(root,'scripts/normalize-integrated-evidence.mjs');
const td=await mkdtemp(join(tmpdir(),'osi-integrated-guards-'));
const ev='ev:test';

function entity(id,kind,name,attributes={}){return {id,kind,name,technology:'sanitized-test',status:'observed',time_scope:'current',attributes,evidence_refs:[ev]};}
const entities=[
  entity('host:dp-a','physical_host','dp-a',{ip:'192.0.2.10'}),
  entity('datapower:runtime:dp-a','datapower_runtime','DataPower on dp-a',{management_endpoint:'https://192.0.2.10:5550/service/mgmt/current'}),
  entity('datapower:domain:APP','datapower_domain','APP'),
  entity('datapower:http-handler:APP:H','datapower_front_handler','H',{local_address:'127.0.0.1',local_port:6027}),
  entity('datapower:mpgw:APP:SVC','datapower_service','SVC'),
  entity('datapower:style-policy:APP:P','datapower_policy','P'),
  entity('datapower:style-rule:APP:R','datapower_policy_rule','R'),
  entity('datapower:style-action:APP:A','datapower_policy_action','A'),
  entity('datapower:static-resource:APP:route.xsl','static_route_resource','route.xsl',{resource_path:'local:///route.xsl',sha256_by_node:{'dp-a':'a'.repeat(64)}}),
  entity('datapower:mqqm-group:APP:GW','datapower_mq_manager_group','GW'),
  entity('mq:qmgr:QM1','mq_queue_manager','QM1'),
  entity('mq:queue:Q1','mq_queue','Q1'),
  entity('mq:channel:UNRELATED','mq_channel','UNRELATED'),
];
const route={
  format:'osi-qualified-route',version:'0.1',id:'route:test',name:'SVC → QM1',status:'qualified',time_scope:'current',
  route_uri_literal:'dpmq://GW/?RequestQueue=Q1',queue:'Q1',
  steps:[
    ['datapower:domain:APP','APP','observed'],['datapower:http-handler:APP:H','H','configured'],['datapower:mpgw:APP:SVC','SVC','configured'],
    ['datapower:style-policy:APP:P','P','configured'],['datapower:style-rule:APP:R','R','configured'],['datapower:style-action:APP:A','A','configured'],
    ['datapower:static-resource:APP:route.xsl','route.xsl','derived'],['datapower:mqqm-group:APP:GW','GW','derived+configured'],
    ['mq:qmgr:QM1','QM1','configured+observed'],['mq:queue:Q1','Q1','derived'],
  ].map(([entity,label,epistemic])=>({entity,label,epistemic})),
  runtime_corroboration_edges:['edge:runtime'],evidence_refs:[ev],interpretation:'sanitized',
};
const evidence={format:'osi-evidence-index',version:'0.1',evidence:[{id:ev,artifact:'sanitized.json',artifact_sha256:'a'.repeat(64),internal_path:'fixture',class:'sanitized-test',time_scope:'current',source_time:null,description:'fixture'}]};

async function runCase(name,graph,routeDoc){
  const gp=join(td,`${name}-graph.json`),rp=join(td,`${name}-route.json`),ep=join(td,`${name}-evidence.json`),out=join(td,`${name}-bundle.json`);
  await Promise.all([writeFile(gp,JSON.stringify(graph)),writeFile(rp,JSON.stringify(routeDoc)),writeFile(ep,JSON.stringify(evidence))]);
  const proc=spawnSync(process.execPath,[normalizer,'--graph',gp,'--route',rp,'--evidence',ep,'--source-id',`guard-${name}`,'--environment','ci','--output',out],{encoding:'utf8'});
  return {proc,out};
}
const graphBase={format:'osi-estate-graph',version:'0.1',generated_at:'2026-09-14T00:00:00Z',scope:['sanitized-test'],epistemic_values:['configured','observed','derived','inferred'],entities,
  edges:[{id:'edge:runtime',source:'host:dp-a',target:'mq:qmgr:QM1',relationship:'observed_client_connection',epistemic:'observed',time_scope:'current',status:'present',attributes:{client_ip:'192.0.2.10',channels:[]},evidence_refs:[ev]}]};

const noChannel=await runCase('no-channel',graphBase,route);
if(noChannel.proc.status!==0) throw new Error(noChannel.proc.stderr||noChannel.proc.stdout);
const noChannelBundle=JSON.parse(await readFile(noChannel.out,'utf8'));
if(noChannelBundle.entities.some((x)=>x.semantic_type==='mq.channel')) throw new Error('unrelated MQ channel was projected without supporting channel evidence');
for(const rel of noChannelBundle.relations.filter((x)=>x.semantic_type==='integration.routes_to')){
  if(rel.properties?.channel!==null) throw new Error('configured route fabricated a channel');
  if(rel.properties?.channel_resolution!=='unavailable') throw new Error('missing channel evidence was not preserved as unavailable');
}

const badGraph=structuredClone(graphBase);
badGraph.edges[0].target='mq:queue:Q1';
const invalid=await runCase('invalid-target',badGraph,route);
if(invalid.proc.status===0) throw new Error('invalid corroboration target was accepted');
if(!`${invalid.proc.stderr}\n${invalid.proc.stdout}`.includes('does not target selected queue manager')) throw new Error('invalid corroboration failure was not explicit');

const badRelationship=structuredClone(graphBase);
badRelationship.edges[0].relationship='configured_reference';
const invalidRelationship=await runCase('invalid-relationship',badRelationship,route);
if(invalidRelationship.proc.status===0) throw new Error('invalid corroboration relationship was accepted');
if(!`${invalidRelationship.proc.stderr}\n${invalidRelationship.proc.stdout}`.includes('unsupported relationship')) throw new Error('invalid relationship failure was not explicit');

console.log('Integrated evidence guard regressions OK: invalid corroboration rejected; missing channel remains unset');
