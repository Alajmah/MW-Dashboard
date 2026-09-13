#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CHUNK_FALLBACK=75;
const ESTATE_COLLECTIONS=['entities','relations','unresolved'];
function fail(message){throw new Error(message);}
function parseArgs(argv){const out={};for(let i=2;i<argv.length;i++){const key=argv[i];if(!key.startsWith('--'))fail(`unexpected argument: ${key}`);const value=argv[++i];if(!value)fail(`missing value for ${key}`);out[key.slice(2)]=value;}if(!out['base-url'])fail('--base-url is required');return out;}
async function api(base,path,token,options={}){const headers=new Headers(options.headers||{});headers.set('accept','application/json');headers.set('authorization',`Bearer ${token}`);if(options.body)headers.set('content-type','application/json');const response=await fetch(new URL(path,base),{...options,headers});let body={};try{body=await response.json();}catch{}if(!response.ok)fail(body.detail||`HTTP ${response.status}`);return body;}
async function fetchAll(base,collection,token){const items=[];let offset=0;while(offset!=null){const page=await api(base,`/api/v2/observations/current/${collection}?limit=100&offset=${offset}`,token);items.push(...(page.items||[]));offset=page.next_offset;}return items;}

const args=parseArgs(process.argv);
const token=process.env.ADMIN_IMPORT_TOKEN?.trim();if(!token)fail('ADMIN_IMPORT_TOKEN is required in the environment');
const base=args['base-url'].endsWith('/')?args['base-url']:args['base-url']+'/';
const rootDir=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sourceData=await api(base,'/api/v2/import/sources',token);const sources=sourceData.sources||[];if(!sources.length)fail('no current semantic sources');
const [entities,relations,unresolved]=await Promise.all(['entities','relations','unresolved'].map((x)=>fetchAll(base,x,token)));
const registry=JSON.parse(await readFile(resolve(rootDir,'services/core/registry/v1.json'),'utf8'));
const builder=await import(pathToFileURL(resolve(rootDir,'public/estate-builder.js')).href);
const estate=await builder.buildCanonicalEstate({sources,entities,relations,unresolved,registry});
const created=await api(base,'/api/v2/estate/revisions',token,{method:'POST',body:JSON.stringify({source_revision_ids:estate.source_revision_ids,source_set_hash:estate.source_set_hash,counts:{entities:estate.entities.length,relations:estate.relations.length,unresolved:estate.unresolved.length},quality:estate.quality})});
const chunkSize=Number(created.chunk_size||CHUNK_FALLBACK);
for(const collection of ESTATE_COLLECTIONS){const items=estate[collection]||[];for(let start=0;start<items.length;start+=chunkSize){await api(base,`/api/v2/estate/revisions/${encodeURIComponent(created.estate_revision_id)}/${collection}`,token,{method:'POST',body:JSON.stringify({items:items.slice(start,start+chunkSize)})});}}
const activated=await api(base,`/api/v2/estate/revisions/${encodeURIComponent(created.estate_revision_id)}/activate`,token,{method:'POST',body:'{}'});
console.log(JSON.stringify({estate_revision_id:activated.estate_revision_id,source_revision_ids:activated.source_revision_ids,canonical_counts:estate.quality?.canonical_counts,recovered_current_source_set:true},null,2));
