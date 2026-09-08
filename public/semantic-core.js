export const sx = {
  topology: null,
  byId: new Map(),
  incoming: new Map(),
  outgoing: new Map(),
  qmgrByName: new Map(),
};

export const s$ = (id) => document.getElementById(id);
export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
export const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
export const uniq = (values) => [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ""))];

export const HUMAN_TYPES = {
  host: "Host", qmgr: "Queue manager", queue: "Queue", channel: "Channel",
  listener: "Listener", application: "Application instance", mq_process: "MQ process", endpoint: "Network endpoint",
};
export const QUEUE_TYPES = {
  QLOCAL: "Local queue", QREMOTE: "Remote queue", QALIAS: "Alias queue", QMODEL: "Model queue",
  QCLUSTER_REMOTE: "Cluster queue", REMOTE_TARGET: "Remote target queue",
};
export const CHANNEL_TYPES = {
  SVRCONN: "Server-connection", SDR: "Sender", RCVR: "Receiver", CLUSSDR: "Cluster sender",
  CLUSRCVR: "Cluster receiver", RQSTR: "Requester", SVR: "Server",
};

export function meta(node, key, fallback = "") {
  const value = node?.metadata?.[key];
  return value === undefined || value === null || value === "" ? fallback : value;
}
export function array(value) { return Array.isArray(value) ? value : (value === undefined || value === null || value === "" ? [] : [value]); }
export function edges(map, id, relationship) { return (map.get(id) || []).filter((edge) => !relationship || edge.relationship === relationship); }
export function node(id) { return sx.byId.get(id) || null; }
export function outNodes(id, relationship) { return edges(sx.outgoing, id, relationship).map((edge) => node(edge.target)).filter(Boolean); }
export function inNodes(id, relationship) { return edges(sx.incoming, id, relationship).map((edge) => node(edge.source)).filter(Boolean); }

export function qmgr(nodeValue) {
  if (!nodeValue) return null;
  if (nodeValue.type === "qmgr") return nodeValue;
  if (["queue","channel","listener"].includes(nodeValue.type)) return sx.qmgrByName.get(nodeValue.scope) || null;
  const edge = (sx.incoming.get(nodeValue.id) || []).find((item) => item.relationship === "OWNS" && node(item.source)?.type === "qmgr");
  return edge ? node(edge.source) : null;
}
export function host(nodeValue) {
  if (!nodeValue) return null;
  if (nodeValue.type === "host") return nodeValue;
  const direct = inNodes(nodeValue.id, "HOSTS").find((candidate) => candidate.type === "host");
  if (direct) return direct;
  const owner = qmgr(nodeValue);
  if (owner && owner.id !== nodeValue.id) return host(owner);
  return null;
}
export function hostLabel(nodeValue) { return host(nodeValue)?.name || "Unknown / not collected"; }
export function ownerLabel(nodeValue) {
  const owner = qmgr(nodeValue);
  if (owner) return owner.name;
  if (["application","mq_process"].includes(nodeValue?.type)) return "Host workload";
  if (nodeValue?.type === "endpoint") return "Network endpoint";
  if (nodeValue?.type === "host") return "Physical system";
  return "Unresolved";
}
export function ip(hostNode) { return meta(hostNode, "ip", array(meta(hostNode, "ips", [])).find(Boolean) || ""); }
export function hostSecondary(hostNode) {
  const address = ip(hostNode);
  const fqdn = meta(hostNode, "fqdn", "");
  if (fqdn && fqdn.toLowerCase() !== String(hostNode.name).toLowerCase()) return address && address !== fqdn ? `${fqdn} · ${address}` : fqdn;
  if (address && address !== hostNode.name) return address;
  return "";
}

export function objectEvidence(nodeValue) {
  const incident = [...(sx.incoming.get(nodeValue.id) || []), ...(sx.outgoing.get(nodeValue.id) || [])];
  const values = new Set(incident.map((edge) => edge.relationship_source).filter(Boolean));
  if (String(nodeValue.status || "").toUpperCase() === "OBSERVED" || array(meta(nodeValue, "runtime_sample", [])).length) values.add("observed");
  return values;
}
export function runtimeState(nodeValue) {
  const raw = String(nodeValue?.status || "").trim().toUpperCase();
  if (["RUNNING","ACTIVE"].includes(raw)) return { key:"running", label:"RUNNING", tone:"good" };
  if (["INACTIVE","STOPPED","STOPPING"].includes(raw)) return { key:"inactive", label:raw, tone:"warn" };
  return { key:"unknown", label:"UNKNOWN", tone:"muted" };
}
export function evidenceState(nodeValue) {
  const evidence = objectEvidence(nodeValue);
  if (evidence.has("observed")) return { key:"observed", label:"Observed evidence" };
  if (evidence.has("configured")) return { key:"configured", label:"Configured evidence" };
  if (evidence.has("inferred")) return { key:"inferred", label:"Inferred evidence" };
  return { key:"none", label:"No relationship evidence" };
}
export function placementState(nodeValue) {
  const owner = nodeValue?.type === "qmgr" ? nodeValue : qmgr(nodeValue);
  if (owner) return host(owner) ? { key:"confirmed", label:"Placement confirmed" } : { key:"unresolved", label:"Placement unresolved" };
  return host(nodeValue) ? { key:"confirmed", label:"Host confirmed" } : { key:"unresolved", label:"Host unresolved" };
}
export function humanSubtype(nodeValue) {
  if (nodeValue?.type === "queue") {
    const technical = String(meta(nodeValue, "queue_type", "QUEUE"));
    return { human: QUEUE_TYPES[technical] || "Queue", technical };
  }
  if (nodeValue?.type === "channel") {
    const technical = String(meta(nodeValue, "channel_type", "CHANNEL"));
    return { human: CHANNEL_TYPES[technical] || "Channel", technical };
  }
  return { human: HUMAN_TYPES[nodeValue?.type] || String(nodeValue?.type || "Object").replaceAll("_", " "), technical:"" };
}
export function statusBadge(nodeValue) { const state=runtimeState(nodeValue); return `<span class="inv-status ${state.tone}">${esc(state.label)}</span>`; }

export function hosted(hostNode, type) { return outNodes(hostNode.id, "HOSTS").filter((item) => !type || item.type === type); }
export function owned(qmgrNode, type) { return outNodes(qmgrNode.id, "OWNS").filter((item) => !type || item.type === type); }
export function appStats(app) {
  const outgoing = sx.outgoing.get(app.id) || [], incoming = sx.incoming.get(app.id) || [];
  const channels = outgoing.filter((edge) => edge.relationship === "CONNECTS_VIA").map((edge) => node(edge.target)).filter(Boolean);
  return {
    channels,
    qmgrs: uniq(channels.map((channel) => channel.scope)).sort(collator.compare),
    puts: outgoing.filter((edge) => edge.relationship === "PUTS_TO").length,
    gets: outgoing.filter((edge) => edge.relationship === "GETS_FROM").length + incoming.filter((edge) => edge.relationship === "CONSUMED_BY").length,
  };
}
export function hostStats(hostNode) {
  const qmgrs=hosted(hostNode,"qmgr"), apps=hosted(hostNode,"application"), procs=hosted(hostNode,"mq_process");
  const objects=qmgrs.flatMap((item)=>owned(item));
  return {
    qmgrs, apps, procs,
    queues: objects.filter((item)=>item.type==="queue").length,
    channels: objects.filter((item)=>item.type==="channel").length,
    appConnections: apps.reduce((sum,app)=>sum+appStats(app).channels.length,0),
    reachedQmgrs: uniq(apps.flatMap((app)=>appStats(app).qmgrs)),
  };
}
export function applicationGroups() {
  const groups=new Map();
  for(const app of sx.topology.nodes.filter((item)=>item.type==="application")){
    const key=app.name.trim().toLowerCase();
    if(!groups.has(key))groups.set(key,{name:app.name,instances:[]});
    groups.get(key).instances.push(app);
  }
  return [...groups.values()].sort((a,b)=>collator.compare(a.name,b.name));
}

export function ensureBreadcrumb() {
  if (s$("semanticBreadcrumb")) return s$("semanticBreadcrumb");
  const topbar=document.querySelector(".topbar"); if(!topbar)return null;
  const bar=document.createElement("nav"); bar.id="semanticBreadcrumb"; bar.className="semantic-breadcrumb"; bar.setAttribute("aria-label","Current context");
  topbar.insertAdjacentElement("afterend",bar); return bar;
}
export function setBreadcrumb(parts, hidden=false) {
  const bar=ensureBreadcrumb(); if(!bar)return;
  bar.innerHTML=parts.map((part,index)=>`<span>${index?"›":""}</span><strong>${esc(part)}</strong>`).join(""); bar.hidden=hidden;
}
export function currentView() { return document.querySelector(".view.active")?.dataset?.viewPanel || "overview"; }

function build(topology) {
  sx.topology=topology; sx.byId=new Map(topology.nodes.map((item)=>[item.id,item])); sx.qmgrByName=new Map(topology.nodes.filter((item)=>item.type==="qmgr").map((item)=>[item.name,item])); sx.incoming=new Map(); sx.outgoing=new Map();
  for(const edge of topology.edges){if(!sx.outgoing.has(edge.source))sx.outgoing.set(edge.source,[]);if(!sx.incoming.has(edge.target))sx.incoming.set(edge.target,[]);sx.outgoing.get(edge.source).push(edge);sx.incoming.get(edge.target).push(edge);}
}
async function load(){const response=await fetch("/api/v1/topology/current");if(!response.ok)throw new Error("No active topology");build(await response.json());return sx.topology;}
export const ready=load().catch((error)=>{console.warn("Semantic UX topology unavailable",error);return null;});
export async function waitForLegacy(){for(let i=0;i<100;i++){const badge=s$("snapshotBadge")?.textContent||"";if(badge&&!badge.includes("No active"))return;await new Promise((resolve)=>setTimeout(resolve,20));}}

export function installSnapshotReload(){
  const badge=s$("snapshotBadge"); if(!badge)return;
  let value=badge.textContent;
  new MutationObserver(()=>{const next=badge.textContent;if(value&&next&&next!==value)location.reload();value=next;}).observe(badge,{childList:true,subtree:true,characterData:true});
}
