#!/usr/bin/env node
import http from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const calls=[];
let receivedEstateManifest=null;
const server=http.createServer(async(req,res)=>{
  let body=''; for await(const chunk of req) body+=chunk;
  calls.push(`${req.method} ${req.url}`);
  res.setHeader('content-type','application/json');
  const send=(status,payload)=>{res.statusCode=status;res.end(JSON.stringify(payload));};
  if(req.method==='GET'&&req.url==='/api/v2/import/sources') return send(200,{sources:[{revision_id:'src-current-1',source_id:'sanitized-source',source_display_name:'Sanitized source'}]});
  if(req.method==='GET'&&req.url?.startsWith('/api/v2/observations/current/')) return send(200,{items:[],next_offset:null});
  if(req.method==='POST'&&req.url==='/api/v2/estate/revisions'){
    receivedEstateManifest=JSON.parse(body||'{}');
    return send(201,{status:'STAGING',estate_revision_id:'estate-recovery-1',source_revision_ids:['src-current-1'],source_set_hash:receivedEstateManifest.source_set_hash,chunk_size:75});
  }
  if(req.method==='POST'&&req.url==='/api/v2/estate/revisions/estate-recovery-1/activate') return send(200,{status:'ACTIVE',estate_revision_id:'estate-recovery-1',source_revision_ids:['src-current-1']});
  if(req.url?.startsWith('/api/v2/import/revisions')) return send(500,{detail:'recovery helper must not create or mutate source revisions'});
  return send(404,{detail:'unexpected request'});
});
await new Promise((resolveListen)=>server.listen(0,'127.0.0.1',resolveListen));
const {port}=server.address();
const child=spawn(process.execPath,[resolve(root,'scripts/reconcile-current-estate.mjs'),'--base-url',`http://127.0.0.1:${port}/`],{
  cwd:root,env:{...process.env,ADMIN_IMPORT_TOKEN:'ci-token'},stdio:['ignore','pipe','pipe']
});
let stdout='',stderr=''; child.stdout.on('data',(d)=>stdout+=d); child.stderr.on('data',(d)=>stderr+=d);
const code=await new Promise((resolveExit)=>child.on('close',resolveExit));
await new Promise((resolveClose)=>server.close(resolveClose));
if(code!==0) throw new Error(stderr||stdout||`recovery helper exited ${code}`);
const result=JSON.parse(stdout);
if(result.estate_revision_id!=='estate-recovery-1'||result.recovered_current_source_set!==true) throw new Error('recovery result did not report activated estate');
if(!receivedEstateManifest||JSON.stringify(receivedEstateManifest.source_revision_ids)!==JSON.stringify(['src-current-1'])) throw new Error('recovery did not reconcile the current source set');
if(calls.some((x)=>x.includes('/api/v2/import/revisions'))) throw new Error('recovery attempted source revision creation or mutation');
console.log('Canonical estate recovery helper OK: current source set rebuilt without source revision creation');
