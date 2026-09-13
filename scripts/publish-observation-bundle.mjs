#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CHUNK_FALLBACK = 75;
const COLLECTIONS = [
  ['coverage','coverage'], ['entities','entities'], ['relations','relations'], ['unresolved_references','unresolved'],
];
const ESTATE_COLLECTIONS = ['entities','relations','unresolved'];

function fail(message){ throw new Error(message); }
function sha256(value){ return createHash('sha256').update(value).digest('hex'); }
function parseArgs(argv){
  const out={}; for(let i=2;i<argv.length;i++){const k=argv[i]; if(!k.startsWith('--')) fail(`unexpected argument: ${k}`); const v=argv[++i]; if(!v) fail(`missing value for ${k}`); out[k.slice(2)]=v;}
  for(const k of ['bundle','base-url']) if(!out[k]) fail(`--${k} is required`); return out;
}
async function api(base,path,token,options={}){
  const headers=new Headers(options.headers||{}); headers.set('accept','application/json'); if(token) headers.set('authorization',`Bearer ${token}`); if(options.body) headers.set('content-type','application/json');
  const response=await fetch(new URL(path,base),{...options,headers}); let body={}; try{body=await response.json();}catch{}
  if(!response.ok){const e=new Error(body.detail||`HTTP ${response.status}`); e.details=body.errors; throw e;} return body;
}
async function fetchAll(base,collection,token){
  const items=[]; let offset=0; while(offset!=null){const page=await api(base,`/api/v2/observations/current/${collection}?limit=100&offset=${offset}`,token); items.push(...(page.items||[])); offset=page.next_offset;} return items;
}
async function postChunks(base,token,revisionId,bundle,chunkSize){
  for(const [key,endpoint] of COLLECTIONS){const items=bundle[key]||[]; for(let start=0;start<items.length;start+=chunkSize){await api(base,`/api/v2/import/revisions/${encodeURIComponent(revisionId)}/${endpoint}`,token,{method:'POST',body:JSON.stringify({start,items:items.slice(start,start+chunkSize)})});}}
}
async function reconcile(base,token,rootDir){
  const sourceData=await api(base,'/api/v2/import/sources',token); const sources=sourceData.sources||[]; if(!sources.length) fail('no current semantic sources');
  const [entities,relations,unresolved]=await Promise.all(['entities','relations','unresolved'].map((x)=>fetchAll(base,x,token)));
  const registry=JSON.parse(await readFile(resolve(rootDir,'services/core/registry/v1.json'),'utf8'));
  const builder=await import(pathToFileURL(resolve(rootDir,'public/estate-builder.js')).href);
  const estate=await builder.buildCanonicalEstate({sources,entities,relations,unresolved,registry});
  const created=await api(base,'/api/v2/estate/revisions',token,{method:'POST',body:JSON.stringify({source_revision_ids:estate.source_revision_ids,source_set_hash:estate.source_set_hash,counts:{entities:estate.entities.length,relations:estate.relations.length,unresolved:estate.unresolved.length},quality:estate.quality})});
  const chunkSize=Number(created.chunk_size||CHUNK_FALLBACK); let sent=0;
  for(const collection of ESTATE_COLLECTIONS){const items=estate[collection]||[]; for(let start=0;start<items.length;start+=chunkSize){const chunk=items.slice(start,start+chunkSize); await api(base,`/api/v2/estate/revisions/${encodeURIComponent(created.estate_revision_id)}/${collection}`,token,{method:'POST',body:JSON.stringify({items:chunk})}); sent+=chunk.length;}}
  const activated=await api(base,`/api/v2/estate/revisions/${encodeURIComponent(created.estate_revision_id)}/activate`,token,{method:'POST',body:'{}'});
  return {estate,activated,sent};
}

const args=parseArgs(process.argv); const token=process.env.ADMIN_IMPORT_TOKEN?.trim(); if(!token) fail('ADMIN_IMPORT_TOKEN is required in the environment');
const bundlePath=resolve(args.bundle); const raw=await readFile(bundlePath); const bundle=JSON.parse(raw.toString('utf8')); if(bundle.schema_version!=='osi.observation.bundle/v2') fail('unsupported bundle schema');
const base=args['base-url'].endsWith('/')?args['base-url']:args['base-url']+'/'; const fileSha=sha256(raw); const run=bundle.run||{};
const manifest={schema_version:bundle.schema_version,run_id:run.run_id,environment:run.environment,collector:run.collector,collector_version:run.collector_version||null,normalizer_version:run.normalizer_version,completed_at:run.completed_at,source:run.source,archive:{filename:basename(bundlePath),sha256:fileSha,size_bytes:raw.byteLength},bundle_sha256:fileSha,counts:{coverage:(bundle.coverage||[]).length,entities:(bundle.entities||[]).length,relations:(bundle.relations||[]).length,unresolved:(bundle.unresolved_references||[]).length},quality:{valid:true,projection_profile:run.metadata?.projection_profile||null}};
const created=await api(base,'/api/v2/import/revisions',token,{method:'POST',body:JSON.stringify(manifest)}); await postChunks(base,token,created.revision_id,bundle,Number(created.chunk_size||CHUNK_FALLBACK));
const activated=await api(base,`/api/v2/import/revisions/${encodeURIComponent(created.revision_id)}/activate`,token,{method:'POST',body:'{}'});
console.log(`Activated source revision ${activated.revision_id}; reconciling canonical estate…`);
const rootDir=resolve(dirname(fileURLToPath(import.meta.url)),'..'); const result=await reconcile(base,token,rootDir);
console.log(JSON.stringify({source_revision_id:activated.revision_id,estate_revision_id:result.activated.estate_revision_id,source_count:result.activated.source_revision_ids?.length??null,canonical_counts:result.estate.quality?.canonical_counts},null,2));
