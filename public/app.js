const state = {
  topology: null,
  snapshots: [],
  indexes: null,
  view: "overview",
  selectedId: null,
  inventory: { query: "", type: "", server: "", owner: "" }
};

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const FLOW_RELATIONSHIPS = new Set([
  "PUTS_TO","CONSUMED_BY","ROUTES_TO","TRANSMITS_VIA","CONNECTS_TO",
  "ALIASES_TO","CONNECTS_VIA","USES_ENDPOINT","ENDPOINT_FOR","DRIVES_CHANNEL"
]);

const viewCopy = {
  overview: ["Overview","Operational view of physical placement, logical ownership and middleware relationships."],
  servers: ["Servers","What runs where: physical systems, hosted queue managers and observed workloads."],
  middleware: ["Middleware","Logical queue-manager ownership with queues, channels, listeners and placement rolled up."],
  applications: ["Applications","Observed client applications, their hosts, queue-manager connections and queue usage."],
  routes: ["Routes","Trace a supported directed message path without rendering the full topology graph."],
  inventory: ["Inventory","Search every topology object with logical owner and physical placement shown explicitly."],
  snapshots: ["Snapshots","Discovery and import history for traceability."],
  administration: ["Administration","Manual topology ingestion and activation."]
};

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || `Request failed (${response.status})`);
  return body;
}

function humanDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}
function ageLabel(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const sec = Math.max(0, Math.floor((Date.now()-d.getTime())/1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec/60); if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min/60); if (hr < 48) return `${hr}h ago`;
  return `${Math.floor(hr/24)}d ago`;
}
function uniq(values){ return [...new Set(values.filter(Boolean))]; }

function buildIndexes(topology) {
  const byId = new Map(topology.nodes.map(n => [n.id,n]));
  const incoming = new Map(), outgoing = new Map();
  for (const e of topology.edges) {
    if (!outgoing.has(e.source)) outgoing.set(e.source,[]);
    if (!incoming.has(e.target)) incoming.set(e.target,[]);
    outgoing.get(e.source).push(e); incoming.get(e.target).push(e);
  }
  const qmgrByName = new Map(topology.nodes.filter(n=>n.type==="qmgr").map(n=>[n.name,n]));
  const hostByName = new Map(topology.nodes.filter(n=>n.type==="host").map(n=>[n.name,n]));

  function incomingNodes(nodeId, rel) {
    return (incoming.get(nodeId)||[]).filter(e=>!rel||e.relationship===rel).map(e=>byId.get(e.source)).filter(Boolean);
  }
  function outgoingNodes(nodeId, rel) {
    return (outgoing.get(nodeId)||[]).filter(e=>!rel||e.relationship===rel).map(e=>byId.get(e.target)).filter(Boolean);
  }
  function qmgrOwner(node) {
    if (!node) return null;
    if (node.type==="qmgr") return node;
    if (["queue","channel","listener"].includes(node.type)) return qmgrByName.get(node.scope)||null;
    const rels = incoming.get(node.id)||[];
    for (const e of rels) {
      const src=byId.get(e.source);
      if (src?.type==="qmgr" && e.relationship==="OWNS") return src;
    }
    return null;
  }
  function serverFor(node) {
    if (!node) return null;
    if (node.type==="host") return node;
    const direct = incomingNodes(node.id,"HOSTS").find(n=>n.type==="host");
    if (direct) return direct;
    const owner=qmgrOwner(node);
    if (owner && owner.id!==node.id) return serverFor(owner);
    if (node.type==="qmgr") return incomingNodes(node.id,"HOSTS").find(n=>n.type==="host")||null;
    return null;
  }
  function owned(qmgr, type) {
    if (!qmgr) return [];
    return outgoingNodes(qmgr.id,"OWNS").filter(n=>!type||n.type===type);
  }
  function hosted(host, type) {
    if (!host) return [];
    return outgoingNodes(host.id,"HOSTS").filter(n=>!type||n.type===type);
  }
  return {byId,incoming,outgoing,qmgrByName,hostByName,incomingNodes,outgoingNodes,qmgrOwner,serverFor,owned,hosted};
}

function showMessage(text, kind="") {
  const el=$("globalMessage");
  if (!text){el.hidden=true;el.textContent="";return;}
  el.hidden=false; el.textContent=text; el.className=`global-message ${kind}`;
}

function setView(view) {
  state.view=view;
  document.querySelectorAll("[data-view-panel]").forEach(el=>el.classList.toggle("active",el.dataset.viewPanel===view));
  document.querySelectorAll(".nav-item").forEach(el=>el.classList.toggle("active",el.dataset.view===view));
  const [title,sub]=viewCopy[view]||[view,""];
  $("pageTitle").textContent=title; $("pageSubtitle").textContent=sub;
  if (view==="inventory") renderInventory();
  if (view==="servers") renderServers();
  if (view==="middleware") renderMiddleware();
  if (view==="applications") renderApplications();
  if (view==="snapshots") renderSnapshots();
  window.scrollTo({top:0,behavior:"smooth"});
}

function logicalOwnerLabel(node) {
  const owner=state.indexes.qmgrOwner(node);
  if (owner) return owner.name;
  if (node.type==="application"||node.type==="mq_process") return "Host workload";
  if (node.type==="endpoint") return "Network endpoint";
  if (node.type==="host") return "Physical system";
  return "—";
}
function serverLabel(node) {
  const h=state.indexes.serverFor(node);
  return h ? h.name : "Unknown / not collected";
}
function ipLabel(host) {
  return host?.metadata?.ip || (Array.isArray(host?.metadata?.ips) ? host.metadata.ips[0] : "") || "";
}
function nodeSearch(node){
  return [node.name,node.type,node.scope,node.status,JSON.stringify(node.metadata||{}),logicalOwnerLabel(node),serverLabel(node)].join(" ").toLowerCase();
}

function renderStats() {
  const t=state.topology, counts=new Map();
  t.nodes.forEach(n=>counts.set(n.type,(counts.get(n.type)||0)+1));
  const localQm=t.nodes.filter(n=>n.type==="qmgr"&&n.metadata?.local_to_archive).length;
  const unresolved=t.nodes.filter(n=>n.type==="qmgr"&&!state.indexes.serverFor(n)).length;
  const cards=[
    ["Objects",t.nodes.length,"indexed, not all rendered"],
    ["Relationships",t.edges.length,"evidence-aware"],
    ["Servers",counts.get("host")||0,"physical identities"],
    ["Queue managers",counts.get("qmgr")||0,`${localQm} host-confirmed`],
    ["Applications",counts.get("application")||0,"client workloads"],
    ["Placement gaps",unresolved,"remote QMs without host evidence"]
  ];
  $("overviewStats").innerHTML=cards.map(([l,v,n])=>`<article class="stat"><span>${esc(l)}</span><strong>${Number(v).toLocaleString()}</strong><small>${esc(n)}</small></article>`).join("");
}

function qmgrCard(q, compact=false) {
  const idx=state.indexes, host=idx.serverFor(q);
  const queues=idx.owned(q,"queue"), channels=idx.owned(q,"channel"), listeners=idx.owned(q,"listener");
  const local=Boolean(q.metadata?.local_to_archive || host);
  const clusters=Array.isArray(q.metadata?.clusters)?q.metadata.clusters:(q.metadata?.clusters?[q.metadata.clusters]:[]);
  return `<article class="${compact?"summary-card":"qmgr-card"}">
    <div class="card-head"><div><h3>${esc(q.name)}</h3><p>${esc(q.metadata?.description||"IBM MQ Queue Manager")}</p></div><span class="pill ${local?"local":"remote"}">${local?"host confirmed":"remote / unresolved"}</span></div>
    <div class="metric-row"><div class="mini-metric"><span>Queues</span><strong>${queues.length}</strong></div><div class="mini-metric"><span>Channels</span><strong>${channels.length}</strong></div><div class="mini-metric"><span>Listeners</span><strong>${listeners.length}</strong></div></div>
    <div class="identity"><div>Logical owner: <strong>${esc(q.name)}</strong></div><div>Current / observed server: <strong>${esc(host?.name||"Unknown")}</strong></div><div>Status: <strong>${esc(q.status||"not observed")}</strong></div></div>
    ${clusters.length?`<div class="chip-row">${clusters.slice(0,5).map(c=>`<span class="chip">${esc(c)}</span>`).join("")}</div>`:""}
    <div class="card-foot"><small>${host?esc(ipLabel(host)||"physical placement confirmed"):"requires collector from peer"}</small><button class="link-button" data-open-qmgr="${esc(q.id)}">Inspect objects →</button></div>
  </article>`;
}

function hostCard(host, compact=false) {
  const idx=state.indexes;
  const qmgrs=idx.hosted(host,"qmgr"), apps=idx.hosted(host,"application"), procs=idx.hosted(host,"mq_process");
  const qObjects=qmgrs.flatMap(q=>idx.owned(q));
  const queues=qObjects.filter(n=>n.type==="queue").length, channels=qObjects.filter(n=>n.type==="channel").length;
  const role=qmgrs.length?"MQ server":apps.length?"Client host":"Observed host";
  return `<article class="${compact?"summary-card":"server-card"}">
    <div class="card-head"><div><h3>${esc(host.name)}</h3><p>${esc(ipLabel(host)||host.metadata?.fqdn||"No IP recorded")}</p></div><span class="pill ${qmgrs.length?"local":""}">${role}</span></div>
    <div class="metric-row"><div class="mini-metric"><span>Queue managers</span><strong>${qmgrs.length}</strong></div><div class="mini-metric"><span>Applications</span><strong>${apps.length}</strong></div><div class="mini-metric"><span>MQ processes</span><strong>${procs.length}</strong></div></div>
    <div class="identity"><div>Hosted queues via QMs: <strong>${queues}</strong></div><div>Hosted channels via QMs: <strong>${channels}</strong></div>${qmgrs.length?`<div>Queue managers: <strong>${esc(qmgrs.map(q=>q.name).join(", "))}</strong></div>`:""}</div>
    <div class="card-foot"><small>${host.metadata?.collector_host?"collector source host":"observed from MQ evidence"}</small><button class="link-button" data-open-server="${esc(host.id)}">Open in inventory →</button></div>
  </article>`;
}

function renderOverview() {
  if (!state.topology) return;
  renderStats();
  const hosts=state.topology.nodes.filter(n=>n.type==="host").sort((a,b)=>natural.compare(a.name,b.name));
  const infra=hosts.filter(h=>state.indexes.hosted(h,"qmgr").length||h.metadata?.collector_host);
  const clients=hosts.filter(h=>!infra.includes(h));
  $("overviewHosts").innerHTML=[...infra.slice(0,4),...clients.slice(0,2)].map(h=>hostCard(h,true)).join("") || `<div class="route-empty">No host evidence available.</div>`;
  const qmgrs=state.topology.nodes.filter(n=>n.type==="qmgr").sort((a,b)=>{
    const al=state.indexes.serverFor(a)?0:1, bl=state.indexes.serverFor(b)?0:1;
    return al-bl||natural.compare(a.name,b.name);
  });
  $("overviewQmgrs").innerHTML=qmgrs.map(q=>qmgrCard(q,true)).join("");
  const srcCounts={observed:0,configured:0,inferred:0};
  state.topology.edges.forEach(e=>srcCounts[e.relationship_source]=(srcCounts[e.relationship_source]||0)+1);
  $("evidenceSummary").innerHTML=["observed","configured","inferred"].map(k=>`<div class="evidence-row"><span class="evidence-label"><i class="swatch ${k}"></i>${k[0].toUpperCase()+k.slice(1)}</span><strong>${(srcCounts[k]||0).toLocaleString()}</strong></div>`).join("");
  const unresolved=qmgrs.filter(q=>!state.indexes.serverFor(q));
  const endpoints=state.topology.nodes.filter(n=>n.type==="endpoint");
  $("placementGaps").innerHTML=`<div class="gap-row"><span>Queue managers without confirmed host</span><strong>${unresolved.length}</strong></div>
    <div class="gap-row"><span>Network endpoints</span><strong>${endpoints.length}</strong></div>
    <div class="gap-row"><span>Next action</span><strong>Collect peer servers</strong></div>
    ${unresolved.slice(0,5).map(q=>`<div class="gap-row"><span>${esc(q.name)}</span><span class="pill remote">host unknown</span></div>`).join("")}`;
  wireCardActions();
}

function renderServers() {
  if (!state.topology) return;
  const q=$("serverSearch").value.trim().toLowerCase();
  const hosts=state.topology.nodes.filter(n=>n.type==="host").filter(h=>{
    if(!q)return true;
    const children=state.indexes.hosted(h).map(n=>n.name).join(" ");
    return `${nodeSearch(h)} ${children}`.toLowerCase().includes(q);
  }).sort((a,b)=>{
    const aq=state.indexes.hosted(a,"qmgr").length?0:1,bq=state.indexes.hosted(b,"qmgr").length?0:1;
    return aq-bq||natural.compare(a.name,b.name);
  });
  $("serverCount").textContent=`${hosts.length} server${hosts.length===1?"":"s"}`;
  $("serversGrid").innerHTML=hosts.map(h=>hostCard(h)).join("")||`<div class="route-empty">No matching servers.</div>`;
  wireCardActions();
}

function renderMiddleware() {
  if (!state.topology) return;
  const q=$("middlewareSearch").value.trim().toLowerCase(), placement=$("middlewarePlacement").value;
  const qmgrs=state.topology.nodes.filter(n=>n.type==="qmgr").filter(n=>{
    const host=state.indexes.serverFor(n), local=Boolean(host||n.metadata?.local_to_archive);
    if(placement==="local"&&!local)return false;
    if(placement==="remote"&&local)return false;
    return !q || nodeSearch(n).includes(q) || (host?.name||"").toLowerCase().includes(q);
  }).sort((a,b)=>{
    const al=state.indexes.serverFor(a)?0:1,bl=state.indexes.serverFor(b)?0:1;
    return al-bl||natural.compare(a.name,b.name);
  });
  $("middlewareCount").textContent=`${qmgrs.length} queue manager${qmgrs.length===1?"":"s"}`;
  $("qmgrGrid").innerHTML=qmgrs.map(qm=>qmgrCard(qm)).join("")||`<div class="route-empty">No matching queue managers.</div>`;
  wireCardActions();
}

function appCard(app) {
  const idx=state.indexes, host=idx.serverFor(app);
  const out=idx.outgoing.get(app.id)||[], inc=idx.incoming.get(app.id)||[];
  const channels=out.filter(e=>e.relationship==="CONNECTS_VIA").map(e=>idx.byId.get(e.target)).filter(Boolean);
  const qmgrs=uniq(channels.map(c=>c.scope));
  const puts=out.filter(e=>e.relationship==="PUTS_TO").length;
  const gets=out.filter(e=>e.relationship==="GETS_FROM").length + inc.filter(e=>e.relationship==="CONSUMED_BY").length;
  return `<article class="app-card"><div class="card-head"><div><h3>${esc(app.name)}</h3><p>${esc(host?.name||"Host unresolved")} ${host&&ipLabel(host)?`· ${esc(ipLabel(host))}`:""}</p></div><span class="pill">${esc(app.metadata?.application_type||"application")}</span></div>
    <div class="metric-row"><div class="mini-metric"><span>Queue managers</span><strong>${qmgrs.length}</strong></div><div class="mini-metric"><span>PUT routes</span><strong>${puts}</strong></div><div class="mini-metric"><span>GET / consume</span><strong>${gets}</strong></div></div>
    <div class="chip-row">${qmgrs.slice(0,6).map(q=>`<span class="chip">${esc(q)}</span>`).join("")}</div>
    <div class="card-foot"><small>${channels.length} observed channel connection${channels.length===1?"":"s"}</small><button class="link-button" data-open-node="${esc(app.id)}">Inspect →</button></div></article>`;
}
function renderApplications() {
  if(!state.topology)return;
  const q=$("applicationSearch").value.trim().toLowerCase();
  const apps=state.topology.nodes.filter(n=>n.type==="application").filter(n=>!q||nodeSearch(n).includes(q)).sort((a,b)=>natural.compare(a.name,b.name));
  $("applicationCount").textContent=`${apps.length} application${apps.length===1?"":"s"}`;
  $("applicationsGrid").innerHTML=apps.map(appCard).join("")||`<div class="route-empty">No matching applications.</div>`;
  wireCardActions();
}

function inventoryNodes() {
  if(!state.topology)return [];
  const f=state.inventory,q=f.query.toLowerCase();
  return state.topology.nodes.filter(n=>{
    if(f.type&&n.type!==f.type)return false;
    if(f.server&&serverLabel(n)!==f.server)return false;
    if(f.owner&&logicalOwnerLabel(n)!==f.owner)return false;
    return !q||nodeSearch(n).includes(q);
  }).sort((a,b)=>natural.compare(a.type,b.type)||natural.compare(a.name,b.name));
}
function renderInventory() {
  if(!state.topology)return;
  const nodes=inventoryNodes(), visible=nodes.slice(0,700);
  $("inventoryCount").textContent=nodes.length>visible.length?`Showing ${visible.length} of ${nodes.length.toLocaleString()} objects`:`${nodes.length.toLocaleString()} objects`;
  $("inventoryRows").innerHTML=visible.map(n=>`<tr data-node-id="${esc(n.id)}" class="${n.id===state.selectedId?"selected":""}">
    <td><span class="pill">${esc(n.type.replaceAll("_"," "))}</span></td><td><strong>${esc(n.name)}</strong></td><td>${esc(logicalOwnerLabel(n))}</td><td>${esc(serverLabel(n))}</td><td>${esc(n.status||"—")}</td></tr>`).join("");
  $("inventoryRows").querySelectorAll("tr[data-node-id]").forEach(row=>row.addEventListener("click",()=>selectNode(row.dataset.nodeId)));
  renderDetail();
}
function populateInventoryFilters() {
  const types=uniq(state.topology.nodes.map(n=>n.type)).sort(natural.compare);
  $("inventoryType").innerHTML=`<option value="">All types</option>${types.map(v=>`<option>${esc(v)}</option>`).join("")}`;
  const servers=uniq(state.topology.nodes.map(serverLabel).filter(v=>v!=="Unknown / not collected")).sort(natural.compare);
  $("inventoryServer").innerHTML=`<option value="">All servers</option>${servers.map(v=>`<option>${esc(v)}</option>`).join("")}`;
  const owners=uniq(state.topology.nodes.map(logicalOwnerLabel).filter(v=>v!=="—")).sort(natural.compare);
  $("inventoryOwner").innerHTML=`<option value="">All owners</option>${owners.map(v=>`<option>${esc(v)}</option>`).join("")}`;
}
function selectNode(id) {
  state.selectedId=id; setView("inventory"); renderInventory();
}
function renderDetail() {
  if(!state.topology||!state.selectedId){$("detailEmpty").hidden=false;$("detailContent").hidden=true;return;}
  const n=state.indexes.byId.get(state.selectedId); if(!n){state.selectedId=null;return renderDetail();}
  $("detailEmpty").hidden=true;$("detailContent").hidden=false;
  $("detailType").textContent=n.type.replaceAll("_"," ");$("detailName").textContent=n.name;$("detailScope").textContent=`${n.environment||"default"} · ${n.scope||"global"}`;
  const owner=logicalOwnerLabel(n), server=serverLabel(n);
  const rels=[...(state.indexes.outgoing.get(n.id)||[]).map(e=>({e,dir:"→",other:state.indexes.byId.get(e.target)})),...(state.indexes.incoming.get(n.id)||[]).map(e=>({e,dir:"←",other:state.indexes.byId.get(e.source)}))];
  const facts=[["Logical owner",owner],["Current / observed server",server],["Status",n.status||"—"],["Observation source",state.topology.discovery?.source_host||state.topology.discovery?.collector||"—"],["Relationships",rels.length],["Environment",n.environment||"default"]];
  $("detailFacts").innerHTML=facts.map(([k,v])=>`<div class="fact"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join("");
  $("detailRelationships").innerHTML=rels.slice(0,120).map(({e,dir,other})=>`<div class="relationship-item"><b>${esc(dir)} ${esc(e.relationship)} · ${esc(other?.name||"unknown")}</b><span>${esc(e.relationship_source)} · confidence ${esc(e.confidence)}</span></div>`).join("")||`<div class="relationship-item"><span>No relationships.</span></div>`;
  const meta=Object.entries(n.metadata||{}).sort(([a],[b])=>natural.compare(a,b));
  $("detailMetadata").innerHTML=meta.map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${esc(Array.isArray(v)?v.join(", "):typeof v==="object"?JSON.stringify(v):v)}</dd></div>`).join("")||`<div><dt>Metadata</dt><dd>None</dd></div>`;
}

function routeLabel(node){ return `${node.name} [${node.type} · ${node.scope||"global"}]`; }
function populateRouteObjects() {
  const eligible=state.topology.nodes.filter(n=>["application","queue","qmgr","channel","endpoint"].includes(n.type)).sort((a,b)=>natural.compare(a.name,b.name));
  $("routeObjects").innerHTML=eligible.map(n=>`<option value="${esc(routeLabel(n))}"></option>`).join("");
}
function resolveRouteInput(value) {
  const exact=state.topology.nodes.find(n=>routeLabel(n)===value); if(exact)return exact;
  const q=value.trim().toLowerCase(); if(!q)return null;
  const matches=state.topology.nodes.filter(n=>["application","queue","qmgr","channel","endpoint"].includes(n.type)&&n.name.toLowerCase()===q);
  if(matches.length===1)return matches[0];
  return null;
}
function findRoute(startId,targetId) {
  const byId=state.indexes.byId, outgoing=state.indexes.outgoing;
  const queue=[startId], seen=new Set([startId]), prev=new Map();
  while(queue.length){
    const id=queue.shift(); if(id===targetId)break;
    for(const e of outgoing.get(id)||[]){
      if(!FLOW_RELATIONSHIPS.has(e.relationship))continue;
      if(!byId.has(e.target)||seen.has(e.target))continue;
      seen.add(e.target); prev.set(e.target,{from:id,edge:e}); queue.push(e.target);
    }
  }
  if(!seen.has(targetId))return null;
  const steps=[]; let cur=targetId;
  while(cur!==startId){const p=prev.get(cur);if(!p)return null;steps.push({node:byId.get(cur),edge:p.edge});cur=p.from;}
  steps.reverse(); return {start:byId.get(startId),steps};
}
function renderRoute(result) {
  if(!result){$("routeTitle").textContent="No supported directed route found";$("routeMeta").textContent="Current evidence";$("routeResult").className="route-empty";$("routeResult").textContent="No path exists using message-flow relationships in the currently loaded snapshot. This does not prove the systems are disconnected; additional server/ACE/DataPower evidence may be required.";return;}
  const nodes=[result.start,...result.steps.map(s=>s.node)];
  $("routeTitle").textContent=`${nodes[0].name} → ${nodes[nodes.length-1].name}`;$("routeMeta").textContent=`${result.steps.length} relationship${result.steps.length===1?"":"s"}`;
  let html=`<div class="route-node"><span>${esc(result.start.type)}</span><strong>${esc(result.start.name)}</strong></div>`;
  result.steps.forEach(s=>{html+=`<div class="route-edge ${esc(s.edge.relationship_source)}"><b>→</b><span>${esc(s.edge.relationship)}</span><span>${esc(s.edge.relationship_source)}</span></div><div class="route-node"><span>${esc(s.node.type)}</span><strong>${esc(s.node.name)}</strong></div>`;});
  $("routeResult").className="route-path";$("routeResult").innerHTML=html;
}

function renderSnapshots() {
  $("snapshotCount").textContent=`${state.snapshots.length} retained`;
  $("snapshotList").innerHTML=state.snapshots.map(s=>`<div class="snapshot-row"><div><strong>${esc(s.snapshot_id)}</strong><small>${s.is_active?"Active snapshot":"Historical snapshot"}</small></div><div>${esc(s.status||"—")}</div><div>${Number(s.node_count||0).toLocaleString()} objects</div><div><small>${esc(humanDate(s.created_at||s.imported_at))}</small></div></div>`).join("")||`<div class="route-empty">No snapshot history available.</div>`;
}

function wireCardActions() {
  document.querySelectorAll("[data-open-qmgr]").forEach(b=>b.addEventListener("click",()=>{
    const q=state.indexes.byId.get(b.dataset.openQmgr); state.inventory.owner=q?.name||"";$("inventoryOwner").value=state.inventory.owner;state.inventory.query="";$("inventorySearch").value="";setView("inventory");
  }));
  document.querySelectorAll("[data-open-server]").forEach(b=>b.addEventListener("click",()=>{
    const h=state.indexes.byId.get(b.dataset.openServer); state.inventory.server=h?.name||"";$("inventoryServer").value=state.inventory.server;state.inventory.query="";$("inventorySearch").value="";setView("inventory");
  }));
  document.querySelectorAll("[data-open-node]").forEach(b=>b.addEventListener("click",()=>selectNode(b.dataset.openNode)));
}

function bindEvents() {
  document.querySelectorAll(".nav-item").forEach(b=>b.addEventListener("click",()=>setView(b.dataset.view)));
  document.querySelectorAll("[data-go]").forEach(b=>b.addEventListener("click",()=>setView(b.dataset.go)));
  $("jumpInventory").addEventListener("click",()=>setView("inventory"));
  $("serverSearch").addEventListener("input",renderServers);
  $("middlewareSearch").addEventListener("input",renderMiddleware);
  $("middlewarePlacement").addEventListener("change",renderMiddleware);
  $("applicationSearch").addEventListener("input",renderApplications);
  $("inventorySearch").addEventListener("input",e=>{state.inventory.query=e.target.value;renderInventory();});
  $("inventoryType").addEventListener("change",e=>{state.inventory.type=e.target.value;renderInventory();});
  $("inventoryServer").addEventListener("change",e=>{state.inventory.server=e.target.value;renderInventory();});
  $("inventoryOwner").addEventListener("change",e=>{state.inventory.owner=e.target.value;renderInventory();});
  $("inventoryReset").addEventListener("click",()=>{state.inventory={query:"",type:"",server:"",owner:""};$("inventorySearch").value="";$("inventoryType").value="";$("inventoryServer").value="";$("inventoryOwner").value="";renderInventory();});
  $("closeDetail").addEventListener("click",()=>{state.selectedId=null;renderInventory();});
  $("routeForm").addEventListener("submit",e=>{e.preventDefault();const a=resolveRouteInput($("routeFrom").value),b=resolveRouteInput($("routeTo").value);if(!a||!b){renderRoute(null);$("routeTitle").textContent="Choose unambiguous objects";return;}renderRoute(findRoute(a.id,b.id));});
  $("topologyFile").addEventListener("change",()=>{$("fileHint").textContent=$("topologyFile").files[0]?.name||"No file selected";});
  $("uploadForm").addEventListener("submit",async e=>{
    e.preventDefault();const file=$("topologyFile").files[0];if(!file)return;
    $("uploadStatus").className="status-line working";$("uploadStatus").textContent=`Validating and importing ${file.name}…`;$("uploadButton").disabled=true;
    try{const result=await api("/api/v1/topology/import",{method:"POST",headers:{"content-type":"application/json"},body:file});$("uploadStatus").className="status-line success";$("uploadStatus").textContent=`Activated ${result.snapshot_id}: ${result.node_count} objects, ${result.edge_count} relationships.`;$("topologyFile").value="";$("fileHint").textContent="No file selected";await loadAll();setView("overview");}
    catch(err){$("uploadStatus").className="status-line error";$("uploadStatus").textContent=`Import rejected: ${err.message}. Existing topology was preserved.`;}
    finally{$("uploadButton").disabled=false;}
  });
}

async function loadAll() {
  showMessage("");
  try{
    const [topology,snapshots]=await Promise.all([api("/api/v1/topology/current"),api("/api/v1/snapshots").catch(()=>[])]);
    state.topology=topology;state.snapshots=Array.isArray(snapshots)?snapshots:(snapshots.snapshots||[]);
    state.indexes=buildIndexes(topology);
    $("snapshotBadge").textContent=topology.snapshot_id;$("sidebarSnapshot").textContent=topology.snapshot_id;$("snapshotAge").textContent=ageLabel(topology.created_at);
    populateInventoryFilters();populateRouteObjects();renderOverview();renderServers();renderMiddleware();renderApplications();renderInventory();renderSnapshots();
  }catch(err){
    if(String(err.message).includes("No active topology")){showMessage("No active topology snapshot. Open Administration to import the first normalized snapshot.");setView("administration");}
    else showMessage(err.message,"error");
  }
}

bindEvents();
loadAll();
