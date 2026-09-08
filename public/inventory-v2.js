const iv2 = {
  topology: null,
  byId: new Map(),
  incoming: new Map(),
  outgoing: new Map(),
  qmgrByName: new Map(),
  filters: { query: "", type: "", server: "", owner: "", status: "" },
  selectedId: null,
  rendering: false
};

const iq = (id) => document.getElementById(id);
const iesc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const icollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const iuniq = (values) => [...new Set(values.filter(v => v !== null && v !== undefined && v !== ""))];

function iedges(map, id, rel) {
  return (map.get(id) || []).filter(e => !rel || e.relationship === rel);
}
function inode(id) { return iv2.byId.get(id) || null; }
function ioutNodes(id, rel) { return iedges(iv2.outgoing,id,rel).map(e=>inode(e.target)).filter(Boolean); }
function iinNodes(id, rel) { return iedges(iv2.incoming,id,rel).map(e=>inode(e.source)).filter(Boolean); }

function iqmgr(node) {
  if (!node) return null;
  if (node.type === "qmgr") return node;
  if (["queue","channel","listener"].includes(node.type)) return iv2.qmgrByName.get(node.scope) || null;
  const ownerEdge = (iv2.incoming.get(node.id)||[]).find(e => e.relationship === "OWNS" && inode(e.source)?.type === "qmgr");
  return ownerEdge ? inode(ownerEdge.source) : null;
}
function iserver(node) {
  if (!node) return null;
  if (node.type === "host") return node;
  const direct = iinNodes(node.id,"HOSTS").find(n=>n.type==="host");
  if (direct) return direct;
  const owner=iqmgr(node);
  if (owner && owner.id !== node.id) return iserver(owner);
  return null;
}
function iownerLabel(node) {
  const q=iqmgr(node); if(q) return q.name;
  if (["application","mq_process"].includes(node.type)) return "Host workload";
  if (node.type === "endpoint") return "Network endpoint";
  if (node.type === "host") return "Physical system";
  return "Unresolved";
}
function iserverLabel(node) { return iserver(node)?.name || "Unknown / not collected"; }
function imeta(node,key,fallback="") { const v=node?.metadata?.[key]; return v===undefined||v===null||v==="" ? fallback : v; }
function iarr(v){ return Array.isArray(v)?v:(v===undefined||v===null||v===""?[]:[v]); }

function istatus(node) {
  const raw=String(node?.status||"").trim();
  if (raw) {
    const upper=raw.toUpperCase();
    if (upper === "OBSERVED") return { key:"observed", label:"OBSERVED", tone:"info" };
    if (["RUNNING","ACTIVE"].includes(upper)) return { key:"running", label:upper, tone:"good" };
    if (["STOPPED","STOPPING","INACTIVE"].includes(upper)) return { key:"inactive", label:upper, tone:"warn" };
    return { key:upper.toLowerCase(), label:upper, tone:"info" };
  }
  const samples=iarr(node?.metadata?.runtime_sample);
  if(samples.length) return { key:"observed", label:"OBSERVED", tone:"info" };
  if(node?.type==="qmgr" && !iserver(node)) return { key:"unobserved", label:"REMOTE / UNOBSERVED", tone:"muted" };
  if(["channel","listener","queue","qmgr"].includes(node?.type)) return { key:"unobserved", label:"NOT OBSERVED", tone:"muted" };
  return { key:"unknown", label:"UNKNOWN", tone:"muted" };
}
function istatusBadge(node){ const s=istatus(node); return `<span class="inv-status ${s.tone}">${iesc(s.label)}</span>`; }

function irelationCounts(node) {
  const out=iv2.outgoing.get(node.id)||[], inc=iv2.incoming.get(node.id)||[];
  return {out,inc};
}
function ichannelConnections(node) {
  return iedges(iv2.incoming,node.id,"CONNECTS_VIA").filter(e=>["application","mq_process"].includes(inode(e.source)?.type)).length;
}
function iappStats(node){
  const {out,inc}=irelationCounts(node);
  const channels=out.filter(e=>e.relationship==="CONNECTS_VIA").map(e=>inode(e.target)).filter(Boolean);
  const qmgrs=iuniq(channels.map(c=>c.scope));
  const puts=out.filter(e=>e.relationship==="PUTS_TO").length;
  const gets=out.filter(e=>e.relationship==="GETS_FROM").length + inc.filter(e=>e.relationship==="CONSUMED_BY").length;
  return {channels,qmgrs,puts,gets};
}
function iqmgrStats(node){
  const owned=ioutNodes(node.id,"OWNS");
  return {
    queues:owned.filter(n=>n.type==="queue").length,
    channels:owned.filter(n=>n.type==="channel").length,
    listeners:owned.filter(n=>n.type==="listener").length
  };
}
function ihostStats(node){
  const hosted=ioutNodes(node.id,"HOSTS");
  return {qmgrs:hosted.filter(n=>n.type==="qmgr").length,apps:hosted.filter(n=>n.type==="application").length,procs:hosted.filter(n=>n.type==="mq_process").length};
}

function isearchText(node){
  return [node.name,node.type,node.scope,node.status,iownerLabel(node),iserverLabel(node),JSON.stringify(node.metadata||{})].join(" ").toLowerCase();
}
function imatches(node){
  const f=iv2.filters;
  if(f.type && node.type!==f.type) return false;
  if(f.server && iserverLabel(node)!==f.server) return false;
  if(f.owner && iownerLabel(node)!==f.owner) return false;
  if(f.status && istatus(node).key!==f.status) return false;
  if(f.query && !isearchText(node).includes(f.query.toLowerCase())) return false;
  return true;
}
function ifiltered(){
  return iv2.topology.nodes.filter(imatches).sort((a,b)=>icollator.compare(a.type,b.type)||icollator.compare(a.name,b.name));
}

function injectInventoryChrome(){
  const toolbar=iq("inventorySearch")?.closest(".toolbar");
  const panel=iq("inventoryRows")?.closest(".inventory-panel");
  if(!toolbar||!panel) return;

  if(!iq("inventoryStatus")){
    const label=document.createElement("label");
    label.className="select-box inv-status-filter";
    label.innerHTML=`<span>Runtime state</span><select id="inventoryStatus"><option value="">All states</option></select>`;
    const reset=iq("inventoryReset");
    toolbar.insertBefore(label,reset);
  }
  if(!iq("inventoryContext")){
    const ctx=document.createElement("section");
    ctx.id="inventoryContext"; ctx.className="inv-context panel";
    toolbar.parentNode.insertBefore(ctx,toolbar);
  }
  if(!iq("inventoryChips")){
    const chips=document.createElement("div");
    chips.id="inventoryChips"; chips.className="inv-filter-chips";
    toolbar.insertAdjacentElement("afterend",chips);
  }
  const thead=panel.querySelector("thead"); if(thead) thead.id="inventoryHead";

  const detail=iq("detailContent");
  if(detail && !iq("detailRuntime")){
    const facts=iq("detailFacts");
    const runtime=document.createElement("div"); runtime.id="detailRuntime"; runtime.className="detail-section inv-runtime";
    facts.insertAdjacentElement("afterend",runtime);
    const rel=iq("detailRelationships")?.closest(".detail-section");
    const meta=iq("detailMetadata")?.closest(".detail-section");
    if(meta){
      const details=document.createElement("details"); details.className="detail-section inv-raw";
      const summary=document.createElement("summary"); summary.textContent="Raw metadata";
      const dl=iq("detailMetadata");
      meta.parentNode.insertBefore(details,meta); details.append(summary,dl); meta.remove();
    }
    if(rel) rel.querySelector("h3").textContent="Relationships";
  }
}

function populateFilters(){
  const types=iuniq(iv2.topology.nodes.map(n=>n.type)).sort(icollator.compare);
  const servers=iuniq(iv2.topology.nodes.map(iserverLabel).filter(v=>v!=="Unknown / not collected")).sort(icollator.compare);
  const owners=iuniq(iv2.topology.nodes.map(iownerLabel).filter(v=>v!=="Unresolved")).sort(icollator.compare);
  iq("inventoryType").innerHTML=`<option value="">All types</option>${types.map(v=>`<option value="${iesc(v)}">${iesc(v.replaceAll("_"," "))}</option>`).join("")}`;
  iq("inventoryServer").innerHTML=`<option value="">All servers</option>${servers.map(v=>`<option value="${iesc(v)}">${iesc(v)}</option>`).join("")}`;
  iq("inventoryOwner").innerHTML=`<option value="">All owners</option>${owners.map(v=>`<option value="${iesc(v)}">${iesc(v)}</option>`).join("")}`;
  const states=iuniq(iv2.topology.nodes.map(n=>istatus(n)).map(s=>`${s.key}|${s.label}`)).sort(icollator.compare);
  iq("inventoryStatus").innerHTML=`<option value="">All states</option>${states.map(v=>{const [key,label]=v.split("|");return `<option value="${iesc(key)}">${iesc(label)}</option>`}).join("")}`;
}

function syncFiltersFromDom(){
  iv2.filters.query=iq("inventorySearch")?.value||"";
  iv2.filters.type=iq("inventoryType")?.value||"";
  iv2.filters.server=iq("inventoryServer")?.value||"";
  iv2.filters.owner=iq("inventoryOwner")?.value||"";
  iv2.filters.status=iq("inventoryStatus")?.value||"";
}
function setFilter(key,value){
  const map={query:"inventorySearch",type:"inventoryType",server:"inventoryServer",owner:"inventoryOwner",status:"inventoryStatus"};
  const el=iq(map[key]); if(el) el.value=value||"";
  syncFiltersFromDom(); renderInventoryV2();
}

function renderContext(nodes){
  const pieces=[`Inventory`];
  if(iv2.filters.server) pieces.push(iv2.filters.server);
  if(iv2.filters.owner && !["Host workload","Network endpoint","Physical system"].includes(iv2.filters.owner)) pieces.push(iv2.filters.owner);
  if(iv2.filters.type) pieces.push(iv2.filters.type.replaceAll("_"," "));
  const running=nodes.filter(n=>istatus(n).key==="running").length;
  const observed=nodes.filter(n=>["running","observed"].includes(istatus(n).key)).length;
  const unobserved=nodes.filter(n=>istatus(n).key==="unobserved").length;
  iq("inventoryContext").innerHTML=`
    <div class="inv-breadcrumb">${pieces.map((p,i)=>`<span>${i?"› ":""}${iesc(p)}</span>`).join("")}</div>
    <div class="inv-context-metrics"><span><strong>${nodes.length.toLocaleString()}</strong> objects</span><span><strong>${running.toLocaleString()}</strong> running</span><span><strong>${observed.toLocaleString()}</strong> observed</span><span><strong>${unobserved.toLocaleString()}</strong> not observed</span></div>`;
}
function renderChips(){
  const items=[];
  if(iv2.filters.query) items.push(["query",`Search: ${iv2.filters.query}`]);
  if(iv2.filters.type) items.push(["type",`Type: ${iv2.filters.type.replaceAll("_"," ")}`]);
  if(iv2.filters.server) items.push(["server",`Server: ${iv2.filters.server}`]);
  if(iv2.filters.owner) items.push(["owner",`Owner: ${iv2.filters.owner}`]);
  if(iv2.filters.status) items.push(["status",`State: ${iq("inventoryStatus")?.selectedOptions?.[0]?.textContent||iv2.filters.status}`]);
  const el=iq("inventoryChips");
  el.hidden=!items.length;
  el.innerHTML=items.map(([key,label])=>`<button type="button" class="inv-chip" data-clear-filter="${key}">${iesc(label)} <span>×</span></button>`).join("");
}

function columnsFor(type){
  const fixedServer=Boolean(iv2.filters.server), fixedOwner=Boolean(iv2.filters.owner);
  if(type==="channel") return [
    ["Name",n=>`<strong>${iesc(n.name)}</strong>`],
    ["Channel type",n=>iesc(imeta(n,"channel_type","—"))],
    ...(!fixedOwner?[["Queue manager",n=>iesc(iownerLabel(n))]]:[]),
    ["Runtime",n=>istatusBadge(n)],
    ["Peer / CONNAME",n=>iesc(imeta(n,"runtime_conname",imeta(n,"conname","Not observed")))],
    ["Connections",n=>String(ichannelConnections(n))]
  ];
  if(type==="queue") return [
    ["Name",n=>`<strong>${iesc(n.name)}</strong>`],
    ["Queue type",n=>iesc(imeta(n,"queue_type","—"))],
    ...(!fixedOwner?[["Queue manager",n=>iesc(iownerLabel(n))]]:[]),
    ["Runtime",n=>istatusBadge(n)],
    ["Depth",n=>iesc(imeta(n,"runtime_curdepth","Not observed"))],
    ["Open I / O",n=>`${iesc(imeta(n,"runtime_ipprocs","—"))} / ${iesc(imeta(n,"runtime_opprocs","—"))}`]
  ];
  if(type==="application") return [
    ["Application",n=>`<strong>${iesc(n.name)}</strong>`],
    ...(!fixedServer?[["Client host",n=>iesc(iserverLabel(n))]]:[]),
    ["Queue managers",n=>iesc(iappStats(n).qmgrs.join(", ")||"—")],
    ["Channels",n=>String(iappStats(n).channels.length)],
    ["PUT queues",n=>String(iappStats(n).puts)],
    ["GET / consume",n=>String(iappStats(n).gets)]
  ];
  if(type==="qmgr") return [
    ["Queue manager",n=>`<strong>${iesc(n.name)}</strong>`],
    ...(!fixedServer?[["Observed server",n=>iesc(iserverLabel(n))]]:[]),
    ["Runtime",n=>istatusBadge(n)],
    ["Version",n=>iesc(imeta(n,"version",imeta(n,"cluster_version","—")))],
    ["Queues",n=>String(iqmgrStats(n).queues)],
    ["Channels",n=>String(iqmgrStats(n).channels)],
    ["Listeners",n=>String(iqmgrStats(n).listeners)]
  ];
  if(type==="listener") return [
    ["Listener",n=>`<strong>${iesc(n.name)}</strong>`],
    ...(!fixedOwner?[["Queue manager",n=>iesc(iownerLabel(n))]]:[]),
    ["Runtime",n=>istatusBadge(n)],
    ["Protocol",n=>iesc(imeta(n,"trptype","—"))],
    ["Address / port",n=>`${iesc(imeta(n,"runtime_ipaddr","*"))}:${iesc(imeta(n,"runtime_port",imeta(n,"port","—")))}`],
    ["Control",n=>iesc(imeta(n,"control","—"))]
  ];
  if(type==="mq_process") return [
    ["Process",n=>`<strong>${iesc(n.name)}</strong>`],
    ["Queue manager",n=>iesc(imeta(n,"qmgr",n.scope||"—"))],
    ...(!fixedServer?[["Server",n=>iesc(iserverLabel(n))]]:[]),
    ["Runtime",n=>istatusBadge(n)],
    ["PID",n=>iesc(iarr(imeta(n,"pids",[])).join(", ")||"—")],
    ["User",n=>iesc(iarr(imeta(n,"user_ids",[])).join(", ")||"—")]
  ];
  if(type==="host") return [
    ["Host",n=>`<strong>${iesc(n.name)}</strong>`],
    ["IP",n=>iesc(imeta(n,"ip",n.name))],
    ["Role",n=>iesc(iarr(imeta(n,"roles",[])).join(", ")||"—")],
    ["Queue managers",n=>String(ihostStats(n).qmgrs)],
    ["Applications",n=>String(ihostStats(n).apps)],
    ["Runtime",n=>istatusBadge(n)]
  ];
  if(type==="endpoint") return [
    ["Endpoint",n=>`<strong>${iesc(n.name)}</strong>`],
    ["Role",n=>iesc(iarr(imeta(n,"roles",[])).join(", ")||"—")],
    ["Target QM",n=>iesc(imeta(n,"qmgr","—"))],
    ["Transport",n=>iesc(imeta(n,"transport","—"))],
    ["Channel",n=>iesc(imeta(n,"channel","—"))],
    ["Runtime",n=>istatusBadge(n)]
  ];
  return [
    ["Type",n=>`<span class="pill">${iesc(n.type.replaceAll("_"," "))}</span>`],
    ["Name",n=>`<strong>${iesc(n.name)}</strong>`],
    ...(!fixedOwner?[["Logical owner",n=>iesc(iownerLabel(n))]]:[]),
    ...(!fixedServer?[["Current / observed server",n=>iesc(iserverLabel(n))]]:[]),
    ["Runtime",n=>istatusBadge(n)]
  ];
}

function renderTable(nodes){
  const type=iv2.filters.type||"";
  const cols=columnsFor(type);
  iq("inventoryHead").innerHTML=`<tr>${cols.map(([h])=>`<th>${iesc(h)}</th>`).join("")}</tr>`;
  const visible=nodes.slice(0,700);
  iq("inventoryCount").textContent=nodes.length>visible.length?`Showing ${visible.length} of ${nodes.length.toLocaleString()} objects`:`${nodes.length.toLocaleString()} objects`;
  iq("inventoryRows").innerHTML=visible.map(n=>`<tr tabindex="0" data-inv-node-id="${iesc(n.id)}" class="${n.id===iv2.selectedId?"selected":""}">${cols.map(([,fn])=>`<td>${fn(n)}</td>`).join("")}</tr>`).join("");
}

function semanticRelation(node,e,dir,other){
  const rel=e.relationship;
  const map={
    OWNS: dir==="in"?"Owned by queue manager":"Owns",
    HOSTS: dir==="in"?"Hosted on server":"Hosts",
    CONNECTS_VIA: dir==="in"?"Used by application / process":"Connects via",
    PUTS_TO: dir==="in"?"Receives PUTs from":"Puts messages to",
    GETS_FROM: dir==="in"?"Read by application":"Reads from",
    CONSUMED_BY: dir==="out"?"Consumed by":"Consumes from",
    ROUTES_TO: dir==="out"?"Routes through transmit queue":"Receives route from",
    TRANSMITS_VIA: dir==="out"?"Transmitted via channel":"Carries transmit queue",
    CONNECTS_TO: dir==="out"?"Connects to queue manager":"Receives channel from",
    USES_ENDPOINT: dir==="out"?"Uses network endpoint":"Used by channel",
    ENDPOINT_FOR: dir==="out"?"Endpoint for queue manager":"Reached through endpoint",
    ALIASES_TO: dir==="out"?"Resolves to queue":"Resolved from queue",
    DRIVES_CHANNEL: dir==="in"?"Driven by MQ process":"Drives channel"
  };
  return map[rel] || rel.replaceAll("_"," ").toLowerCase().replace(/^./,c=>c.toUpperCase());
}
function evidenceBadge(e){ const s=e.relationship_source||"configured"; return `<span class="evidence-badge ${iesc(s)}">${iesc(s)}</span>`; }

function detailFacts(node){
  const owner=iownerLabel(node), server=iserverLabel(node), status=istatus(node).label;
  if(node.type==="channel") return [
    ["Channel type",imeta(node,"channel_type","Unknown")],["Queue manager",owner],["Observed server",server],["Runtime",status],["Peer / CONNAME",imeta(node,"runtime_conname",imeta(node,"conname","Not observed"))],["Connections",ichannelConnections(node)]
  ];
  if(node.type==="queue") return [
    ["Queue type",imeta(node,"queue_type","Unknown")],["Queue manager",owner],["Observed server",server],["Runtime",status],["Current depth",imeta(node,"runtime_curdepth","Not observed")],["Open input / output",`${imeta(node,"runtime_ipprocs","—")} / ${imeta(node,"runtime_opprocs","—")}`]
  ];
  if(node.type==="application") { const a=iappStats(node); return [["Client host",server],["Queue managers",a.qmgrs.join(", ")||"—"],["Channels",a.channels.length],["PUT queues",a.puts],["GET / consume",a.gets],["Users",iarr(imeta(node,"user_ids",[])).join(", ")||"—"]]; }
  if(node.type==="qmgr") { const q=iqmgrStats(node); return [["Observed server",server],["Runtime",status],["Version",imeta(node,"version",imeta(node,"cluster_version","—"))],["Queues",q.queues],["Channels",q.channels],["Listeners",q.listeners]]; }
  if(node.type==="listener") return [["Queue manager",owner],["Observed server",server],["Runtime",status],["Protocol",imeta(node,"trptype","—")],["Address / port",`${imeta(node,"runtime_ipaddr","*")}:${imeta(node,"runtime_port",imeta(node,"port","—"))}`],["Control",imeta(node,"control","—")]];
  if(node.type==="mq_process") return [["Queue manager",imeta(node,"qmgr",node.scope||"—")],["Server",server],["Runtime",status],["PID",iarr(imeta(node,"pids",[])).join(", ")||"—"],["User",iarr(imeta(node,"user_ids",[])).join(", ")||"—"],["Process type",iarr(imeta(node,"application_types",[])).join(", ")||"SYSTEM"]];
  if(node.type==="host") { const h=ihostStats(node); return [["IP",imeta(node,"ip",node.name)],["Roles",iarr(imeta(node,"roles",[])).join(", ")||"—"],["Queue managers",h.qmgrs],["Applications",h.apps],["MQ processes",h.procs],["Runtime",status]]; }
  if(node.type==="endpoint") return [["Host",imeta(node,"host","—")],["Port",imeta(node,"port","—")],["Roles",iarr(imeta(node,"roles",[])).join(", ")||"—"],["Target QM",imeta(node,"qmgr","—")],["Channel",imeta(node,"channel","—")],["Runtime",status]];
  return [["Logical owner",owner],["Current / observed server",server],["Runtime",status],["Environment",node.environment||"default"],["Scope",node.scope||"global"],["Relationships",(iv2.incoming.get(node.id)||[]).length+(iv2.outgoing.get(node.id)||[]).length]];
}
function detailRuntime(node){
  const samples=iarr(imeta(node,"runtime_sample",[]));
  const fields=[];
  if(samples.length) fields.push(["Observed samples",samples.length],["Latest sample",samples[samples.length-1]]);
  if(node.type==="queue") {
    if(imeta(node,"runtime_lputdate")) fields.push(["Last PUT",`${imeta(node,"runtime_lputdate")} ${imeta(node,"runtime_lputtime","")}`]);
    if(imeta(node,"runtime_lgetdate")) fields.push(["Last GET",`${imeta(node,"runtime_lgetdate")} ${imeta(node,"runtime_lgettime","")}`]);
    if(imeta(node,"put")) fields.push(["PUT enabled",imeta(node,"put")]);
    if(imeta(node,"get")) fields.push(["GET enabled",imeta(node,"get")]);
  }
  if(node.type==="channel") {
    if(imeta(node,"trptype")) fields.push(["Transport",imeta(node,"trptype")]);
    if(imeta(node,"xmitq")) fields.push(["Transmit queue",imeta(node,"xmitq")]);
    if(imeta(node,"mcauser")) fields.push(["MCA user",imeta(node,"mcauser")]);
  }
  if(!fields.length) return "";
  return `<h3>Runtime & configuration</h3><div class="inv-runtime-grid">${fields.map(([k,v])=>`<div><span>${iesc(k)}</span><strong>${iesc(v)}</strong></div>`).join("")}</div>`;
}

function selectInventoryNode(id,scroll=false){
  if(!iv2.byId.has(id)) return;
  iv2.selectedId=id; renderInventoryV2(false);
  if(scroll) iq("detailContent")?.scrollIntoView({block:"nearest",behavior:"smooth"});
}
function renderDetailV2(){
  const empty=iq("detailEmpty"), content=iq("detailContent");
  const node=inode(iv2.selectedId);
  if(!node){ empty.hidden=false; content.hidden=true; return; }
  empty.hidden=true; content.hidden=false;
  iq("detailType").textContent=node.type.replaceAll("_"," ");
  iq("detailName").textContent=node.name;
  const subtype=node.type==="channel"?imeta(node,"channel_type",""):node.type==="queue"?imeta(node,"queue_type",""):"";
  iq("detailScope").textContent=[subtype,node.environment||"default",node.scope||"global"].filter(Boolean).join(" · ");
  const facts=detailFacts(node);
  iq("detailFacts").innerHTML=facts.map(([k,v])=>`<div class="fact"><span>${iesc(k)}</span><strong>${iesc(v)}</strong></div>`).join("");
  iq("detailRuntime").innerHTML=detailRuntime(node);
  iq("detailRuntime").hidden=!iq("detailRuntime").innerHTML;

  const rels=[...(iv2.outgoing.get(node.id)||[]).map(e=>({e,dir:"out",other:inode(e.target)})),...(iv2.incoming.get(node.id)||[]).map(e=>({e,dir:"in",other:inode(e.source)}))]
    .filter(x=>x.other).sort((a,b)=>icollator.compare(semanticRelation(node,a.e,a.dir,a.other),semanticRelation(node,b.e,b.dir,b.other)));
  iq("detailRelationships").innerHTML=rels.length?rels.map(({e,dir,other})=>`<button type="button" class="inv-relation" data-inv-related="${iesc(other.id)}"><span class="inv-rel-main"><b>${iesc(semanticRelation(node,e,dir,other))}</b><strong>${iesc(other.name)}</strong><small>${iesc(other.type.replaceAll("_"," "))} · ${iesc(iownerLabel(other))}</small></span>${evidenceBadge(e)}</button>`).join(""):`<div class="relationship-item"><span>No relationships.</span></div>`;
  const meta=Object.entries(node.metadata||{}).sort(([a],[b])=>icollator.compare(a,b));
  iq("detailMetadata").innerHTML=meta.map(([k,v])=>`<div><dt>${iesc(k)}</dt><dd>${iesc(Array.isArray(v)?v.join(", "):typeof v==="object"?JSON.stringify(v):v)}</dd></div>`).join("")||`<div><dt>Metadata</dt><dd>None</dd></div>`;

  const owner=iqmgr(node), server=iserver(node);
  let actions=iq("inventoryDetailActions");
  if(!actions){actions=document.createElement("div");actions.id="inventoryDetailActions";actions.className="inv-detail-actions";iq("detailFacts").insertAdjacentElement("beforebegin",actions);}
  actions.innerHTML=`${owner&&owner.id!==node.id?`<button type="button" class="ghost" data-filter-owner="${iesc(owner.name)}">Queue manager: ${iesc(owner.name)}</button>`:""}${server&&server.id!==node.id?`<button type="button" class="ghost" data-filter-server="${iesc(server.name)}">Server: ${iesc(server.name)}</button>`:""}`;
}

function renderInventoryV2(keepDetail=true){
  if(!iv2.topology||iv2.rendering) return;
  iv2.rendering=true;
  try{
    syncFiltersFromDom();
    const nodes=ifiltered();
    renderContext(nodes); renderChips(); renderTable(nodes);
    if(!keepDetail && iv2.selectedId && !nodes.some(n=>n.id===iv2.selectedId)) iv2.selectedId=null;
    renderDetailV2();
  } finally { iv2.rendering=false; }
}

function bindInventory(){
  ["inventorySearch","inventoryType","inventoryServer","inventoryOwner","inventoryStatus"].forEach(id=>{
    const el=iq(id); if(!el)return;
    el.addEventListener(id==="inventorySearch"?"input":"change",()=>renderInventoryV2(false));
  });
  iq("inventoryReset")?.addEventListener("click",()=>setTimeout(()=>{iq("inventoryStatus").value="";renderInventoryV2(false)},0));
  iq("closeDetail")?.addEventListener("click",()=>setTimeout(()=>{iv2.selectedId=null;renderInventoryV2()},0));

  document.addEventListener("click",e=>{
    const row=e.target.closest("[data-inv-node-id]"); if(row){selectInventoryNode(row.dataset.invNodeId);return;}
    const related=e.target.closest("[data-inv-related]"); if(related){selectInventoryNode(related.dataset.invRelated,true);return;}
    const clear=e.target.closest("[data-clear-filter]"); if(clear){setFilter(clear.dataset.clearFilter,"");return;}
    const owner=e.target.closest("[data-filter-owner]"); if(owner){setFilter("owner",owner.dataset.filterOwner);return;}
    const server=e.target.closest("[data-filter-server]"); if(server){setFilter("server",server.dataset.filterServer);return;}
  });
  iq("inventoryRows")?.addEventListener("keydown",e=>{const row=e.target.closest("[data-inv-node-id]");if(row&&(e.key==="Enter"||e.key===" ")){e.preventDefault();selectInventoryNode(row.dataset.invNodeId);}});

  document.addEventListener("click",e=>{
    const t=e.target.closest("[data-open-node],[data-open-server],[data-open-qmgr]"); if(!t)return;
    setTimeout(()=>{
      if(t.dataset.openNode) selectInventoryNode(t.dataset.openNode,true);
      if(t.dataset.openServer){ const n=inode(t.dataset.openServer); if(n)setFilter("server",n.name); }
      if(t.dataset.openQmgr){ const n=inode(t.dataset.openQmgr); if(n)setFilter("owner",n.name); }
    },0);
  },true);
}

async function loadInventoryV2(){
  try{
    injectInventoryChrome();
    const res=await fetch("/api/v1/topology/current");
    if(!res.ok) return;
    iv2.topology=await res.json();
    iv2.byId=new Map(iv2.topology.nodes.map(n=>[n.id,n]));
    iv2.qmgrByName=new Map(iv2.topology.nodes.filter(n=>n.type==="qmgr").map(n=>[n.name,n]));
    for(const e of iv2.topology.edges){
      if(!iv2.outgoing.has(e.source))iv2.outgoing.set(e.source,[]);
      if(!iv2.incoming.has(e.target))iv2.incoming.set(e.target,[]);
      iv2.outgoing.get(e.source).push(e); iv2.incoming.get(e.target).push(e);
    }
    populateFilters(); bindInventory(); renderInventoryV2();
  }catch(err){console.error("Inventory v2 failed to initialize",err);}
}

loadInventoryV2();
