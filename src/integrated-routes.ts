export interface IntegratedRoutesEnv { DB: D1Database; }

type JsonMap = Record<string, unknown>;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
function reply(data: unknown, status=200): Response { return new Response(JSON.stringify(data,null,2),{status,headers:JSON_HEADERS}); }
function parseJson(value: unknown, fallback: unknown){ try{return JSON.parse(String(value ?? ""));}catch{return fallback;} }

async function sourceSetHash(values:string[]):Promise<string>{
  const stable=[...new Set(values)].sort().join("\n");
  const bytes=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(stable)));
  return Array.from(bytes,(byte)=>byte.toString(16).padStart(2,"0")).join("");
}
async function freshEstate(db:D1Database):Promise<Record<string,unknown>|Response|null>{
  const estate=await db.prepare(`SELECT estate_revision_id,source_set_hash,source_revision_ids_json,built_at,activated_at,quality_json
                                 FROM semantic_estate_revision WHERE is_current=1 LIMIT 1`).first<Record<string,unknown>>();
  if(!estate)return null;
  const current=await db.prepare("SELECT revision_id FROM semantic_source_revision WHERE is_current=1 ORDER BY revision_id").all<{revision_id:string}>();
  const sourceIds=(current.results??[]).map((row)=>String(row.revision_id));
  if(String(estate.source_set_hash)!==await sourceSetHash(sourceIds)){
    return reply({detail:"Canonical estate is stale because the current source set has changed",code:"ESTATE_STALE",current_estate_revision_id:estate.estate_revision_id,current_sources:sourceIds.length},409);
  }
  return estate;
}
async function entity(db:D1Database,estateId:string,id:string):Promise<Record<string,unknown>|null>{
  const row=await db.prepare(`SELECT entity_id,semantic_type,identity_key,identity_state,display_name,observed_at,properties_json,evidence_classes_json,source_ids_json,evidence_count,source_count
                              FROM semantic_estate_entity WHERE estate_revision_id=? AND entity_id=? LIMIT 1`).bind(estateId,id).first<Record<string,unknown>>();
  if(!row)return null; return {...row,properties:parseJson(row.properties_json,{}),evidence_classes:parseJson(row.evidence_classes_json,[]),source_ids:parseJson(row.source_ids_json,[]),properties_json:undefined,evidence_classes_json:undefined,source_ids_json:undefined};
}
async function directIntegratedRoute(db:D1Database,estateId:string,from:string,to:string):Promise<Record<string,unknown>|null>{
  const row=await db.prepare(`SELECT relation_id,semantic_type,source_entity_id,target_entity_id,observed_at,properties_json,evidence_classes_json,source_ids_json,evidence_count,source_count
                              FROM semantic_estate_relation
                              WHERE estate_revision_id=? AND source_entity_id=? AND target_entity_id=? AND semantic_type='integration.routes_to' LIMIT 1`).bind(estateId,from,to).first<Record<string,unknown>>();
  if(!row)return null; return {...row,properties:parseJson(row.properties_json,{}),evidence_classes:parseJson(row.evidence_classes_json,[]),source_ids:parseJson(row.source_ids_json,[]),properties_json:undefined,evidence_classes_json:undefined,source_ids_json:undefined};
}
async function unresolvedFor(db:D1Database,estateId:string,ids:string[]):Promise<Record<string,unknown>[]>{
  if(!ids.length)return []; const placeholders=ids.map(()=>'?').join(','); const result=await db.prepare(`SELECT unresolved_id,source_entity_id,semantic_type,expected_target_type,vendor_value,state,reason,candidate_entity_ids_json,source_ids_json,evidence_count FROM semantic_estate_unresolved WHERE estate_revision_id=? AND source_entity_id IN (${placeholders}) ORDER BY unresolved_id`).bind(estateId,...ids).all<Record<string,unknown>>();
  return (result.results??[]).map((row)=>({...row,candidate_entity_ids:parseJson(row.candidate_entity_ids_json,[]),source_ids:parseJson(row.source_ids_json,[]),candidate_entity_ids_json:undefined,source_ids_json:undefined}));
}

export async function handleIntegratedRoutes(request:Request,env:IntegratedRoutesEnv):Promise<Response|null>{
  const url=new URL(request.url); if(request.method!=="GET"||url.pathname!=="/api/v2/routes/trace")return null;
  const from=url.searchParams.get("from")?.trim(); const to=url.searchParams.get("to")?.trim(); if(!from||!to)return null;
  try{
    const estate=await freshEstate(env.DB); if(!estate)return null; if(estate instanceof Response)return estate;
    const estateId=String(estate.estate_revision_id);
    const relation=await directIntegratedRoute(env.DB,estateId,from,to); if(!relation)return null;
    const [source,target]=await Promise.all([entity(env.DB,estateId,from),entity(env.DB,estateId,to)]); if(!source||!target)return null;
    const properties=(relation.properties??{}) as JsonMap; const evidenceClasses=Array.isArray(relation.evidence_classes)?relation.evidence_classes:[];
    const semanticWarning=typeof properties.semantic_warning==="string"?properties.semantic_warning:"Configured integration route evidence does not prove a specific runtime message traversal.";
    const unresolved=await unresolvedFor(env.DB,estateId,[from,to]);
    return reply({
      found:true, mode:"configured_semantic_path", source, target, nodes:[source,target],
      steps:[{relation_id:relation.relation_id,semantic_type:"integration.routes_to",label:"Routes to",reversed:false,from:source,to:target,evidence_classes:evidenceClasses,properties,semantic_warning:semanticWarning}],
      transport:[], unresolved,
      estate:{estate_revision_id:estateId,source_set_hash:estate.source_set_hash,source_revision_ids:parseJson(estate.source_revision_ids_json,[]),built_at:estate.built_at,activated_at:estate.activated_at,quality:parseJson(estate.quality_json,{})},
      semantics:{runtime_access_is_activity:false,configured_route_is_runtime_traversal:false,qualified_route:Boolean(properties.qualified_route),derived_epistemic:properties.epistemic??null,runtime_corroboration:properties.runtime_corroboration??[]},
      explanation:"A deterministic configured DataPower route is supported by the current canonical estate. Static route evidence remains distinct from runtime MQ connectivity evidence."
    });
  }catch(error){console.error("integrated route query failed",error); return reply({detail:"Integrated route query failed",code:"INTEGRATED_ROUTE_QUERY_FAILED"},500);}
}
