const sx = {
  topology: null,
  byId: new Map(),
  incoming: new Map(),
  outgoing: new Map(),
  qmgrByName: new Map(),
  appMode: "logical",
  inventoryPage: 1,
  inventoryPageSize: 200,
  renderingInventory: false,
  observerTimer: null,
};

const s$ = (id) => document.getElementById(id);
const sesc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[c]));
const scollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const suniq = (values) => [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ""))];

const HUMAN_TYPES = {
  host: "Host",
  qmgr: "Queue manager",
  queue: "Queue",
  channel: "Channel",
  listener: "Listener",
  application: "Application instance",
  mq_process: "MQ process",
  endpoint: "Network endpoint",
};
const QUEUE_TYPES = {
  QLOCAL: "Local queue",
  QREMOTE: "Remote queue",
  QALIAS: "Alias queue",
  QMODEL: "Model queue",
  QCLUSTER_REMOTE: "Cluster queue",
  REMOTE_TARGET: "Remote target queue",
};
const CHANNEL_TYPES = {
  SVRCONN: "Server-connection",
  SDR: "Sender",
  RCVR: "Receiver",
  CLUSSDR: "Cluster sender",
  CLUSRCVR: "Cluster receiver",
  RQSTR: "Requester",
  SVR: "Server",
};

function smeta(node, key, fallback = "") {
  const value = node?.metadata?.[key];
  return value === undefined || value === null || value === "" ? fallback : value;
}
function sarray(value) {
  return Array.isArray(value) ? value : (value === undefined || value === null || value === "" ? [] : [value]);
}
function sedges(map, id, relationship) {
  return (map.get(id) || []).filter((edge) => !relationship || edge.relationship === relationship);
}
function snode(id) { return sx.byId.get(id) || null; }
function soutNodes(id, relationship) { return sedges(sx.outgoing, id, relationship).map((edge) => snode(edge.target)).filter(Boolean); }
function sinNodes(id, relationship) { return sedges(sx.incoming, id, relationship).map((edge) => snode(edge.source)).filter(Boolean); }

function sqmgr(node) {
  if (!node) return null;
  if (node.type === "qmgr") return node;
  if (["queue", "channel", "listener"].includes(node.type)) return sx.qmgrByName.get(node.scope) || null;
  const edge = (sx.incoming.get(node.id) || []).find((item) => item.relationship === "OWNS" && snode(item.source)?.type === "qmgr");
  return edge ? snode(edge.source) : null;
}
function shost(node) {
  if (!node) return null;
  if (node.type === "host") return node;
  const direct = sinNodes(node.id, "HOSTS").find((candidate) => candidate.type === "host");
  if (direct) return direct;
  const owner = sqmgr(node);
  if (owner && owner.id !== node.id) return shost(owner);
  return null;
}
function shostLabel(node) { return shost(node)?.name || "Unknown / not collected"; }
function sownerLabel(node) {
  const owner = sqmgr(node);
  if (owner) return owner.name;
  if (["application", "mq_process"].includes(node?.type)) return "Host workload";
  if (node?.type === "endpoint") return "Network endpoint";
  if (node?.type === "host") return "Physical system";
  return "Unresolved";
}
function sip(host) {
  return smeta(host, "ip", sarray(smeta(host, "ips", [])).find(Boolean) || "");
}
function hostSecondary(host) {
  const ip = sip(host);
  const fqdn = smeta(host, "fqdn", "");
  if (fqdn && fqdn.toLowerCase() !== String(host.name).toLowerCase()) return ip && ip !== fqdn ? `${fqdn} · ${ip}` : fqdn;
  if (ip && ip !== host.name) return ip;
  return "";
}
function objectEvidence(node) {
  const incident = [...(sx.incoming.get(node.id) || []), ...(sx.outgoing.get(node.id) || [])];
  const values = new Set(incident.map((edge) => edge.relationship_source).filter(Boolean));
  if (String(node.status || "").toUpperCase() === "OBSERVED" || sarray(smeta(node, "runtime_sample", [])).length) values.add("observed");
  return values;
}
function runtimeState(node) {
  const raw = String(node?.status || "").trim().toUpperCase();
  if (["RUNNING", "ACTIVE"].includes(raw)) return { key: "running", label: "RUNNING", tone: "good" };
  if (["INACTIVE", "STOPPED", "STOPPING"].includes(raw)) return { key: "inactive", label: raw, tone: "warn" };
  return { key: "unknown", label: "UNKNOWN", tone: "muted" };
}
function evidenceState(node) {
  const evidence = objectEvidence(node);
  if (evidence.has("observed")) return { key: "observed", label: "Observed evidence", tone: "good" };
  if (evidence.has("configured")) return { key: "configured", label: "Configured evidence", tone: "configured" };
  if (evidence.has("inferred")) return { key: "inferred", label: "Inferred evidence", tone: "warn" };
  return { key: "none", label: "No relationship evidence", tone: "muted" };
}
function placementState(node) {
  const owner = node?.type === "qmgr" ? node : sqmgr(node);
  if (owner) return shost(owner) ? { key: "confirmed", label: "Placement confirmed", tone: "good" } : { key: "unresolved", label: "Placement unresolved", tone: "remote" };
  return shost(node) ? { key: "confirmed", label: "Host confirmed", tone: "good" } : { key: "unresolved", label: "Host unresolved", tone: "remote" };
}
function humanSubtype(node) {
  if (node?.type === "queue") {
    const technical = String(smeta(node, "queue_type", "QUEUE"));
    return { human: QUEUE_TYPES[technical] || "Queue", technical };
  }
  if (node?.type === "channel") {
    const technical = String(smeta(node, "channel_type", "CHANNEL"));
    return { human: CHANNEL_TYPES[technical] || "Channel", technical };
  }
  return { human: HUMAN_TYPES[node?.type] || String(node?.type || "Object").replaceAll("_", " "), technical: "" };
}
function statusBadge(node) {
  const state = runtimeState(node);
  return `<span class="inv-status ${state.tone}">${sesc(state.label)}</span>`;
}

function buildIndexes(topology) {
  sx.topology = topology;
  sx.byId = new Map(topology.nodes.map((node) => [node.id, node]));
  sx.qmgrByName = new Map(topology.nodes.filter((node) => node.type === "qmgr").map((node) => [node.name, node]));
  sx.incoming = new Map();
  sx.outgoing = new Map();
  for (const edge of topology.edges) {
    if (!sx.outgoing.has(edge.source)) sx.outgoing.set(edge.source, []);
    if (!sx.incoming.has(edge.target)) sx.incoming.set(edge.target, []);
    sx.outgoing.get(edge.source).push(edge);
    sx.incoming.get(edge.target).push(edge);
  }
}

function hosted(host, type) {
  return soutNodes(host.id, "HOSTS").filter((node) => !type || node.type === type);
}
function owned(qmgr, type) {
  return soutNodes(qmgr.id, "OWNS").filter((node) => !type || node.type === type);
}
function appStats(app) {
  const out = sx.outgoing.get(app.id) || [];
  const inc = sx.incoming.get(app.id) || [];
  const channels = out.filter((edge) => edge.relationship === "CONNECTS_VIA").map((edge) => snode(edge.target)).filter(Boolean);
  return {
    channels,
    qmgrs: suniq(channels.map((channel) => channel.scope)).sort(scollator.compare),
    puts: out.filter((edge) => edge.relationship === "PUTS_TO").length,
    gets: out.filter((edge) => edge.relationship === "GETS_FROM").length + inc.filter((edge) => edge.relationship === "CONSUMED_BY").length,
  };
}
function hostStats(host) {
  const qmgrs = hosted(host, "qmgr");
  const apps = hosted(host, "application");
  const procs = hosted(host, "mq_process");
  const ownedObjects = qmgrs.flatMap((qmgr) => owned(qmgr));
  const appConnections = apps.reduce((sum, app) => sum + appStats(app).channels.length, 0);
  const reachedQmgrs = suniq(apps.flatMap((app) => appStats(app).qmgrs));
  return {
    qmgrs, apps, procs,
    queues: ownedObjects.filter((node) => node.type === "queue").length,
    channels: ownedObjects.filter((node) => node.type === "channel").length,
    appConnections,
    reachedQmgrs,
  };
}

function hostCard(host, compact = false) {
  const stats = hostStats(host);
  const infra = stats.qmgrs.length > 0 || Boolean(host.metadata?.collector_host);
  const secondary = hostSecondary(host);
  if (infra) {
    return `<article class="${compact ? "summary-card" : "server-card"} semantic-host-card infrastructure">
      <div class="card-head"><div><h3>${sesc(host.name)}</h3>${secondary ? `<p>${sesc(secondary)}</p>` : ""}</div><span class="pill local">MQ host</span></div>
      <div class="metric-row"><div class="mini-metric"><span>Queue managers</span><strong>${stats.qmgrs.length}</strong></div><div class="mini-metric"><span>Applications</span><strong>${stats.apps.length}</strong></div><div class="mini-metric"><span>MQ processes</span><strong>${stats.procs.length}</strong></div></div>
      <div class="identity"><div>Hosted queues: <strong>${stats.queues}</strong></div><div>Hosted channels: <strong>${stats.channels}</strong></div>${stats.qmgrs.length ? `<div>Queue managers: <strong>${sesc(stats.qmgrs.map((q) => q.name).join(", "))}</strong></div>` : ""}</div>
      <div class="card-foot"><small>${host.metadata?.collector_host ? "collector source host" : "physical placement observed"}</small><button class="link-button" data-semantic-host="${sesc(host.name)}">Open in inventory →</button></div>
    </article>`;
  }
  return `<article class="${compact ? "summary-card" : "server-card"} semantic-host-card client">
    <div class="card-head"><div><h3>${sesc(host.name)}</h3>${secondary ? `<p>${sesc(secondary)}</p>` : ""}</div><span class="pill">Client host</span></div>
    <div class="metric-row"><div class="mini-metric"><span>Applications</span><strong>${stats.apps.length}</strong></div><div class="mini-metric"><span>MQ connections</span><strong>${stats.appConnections}</strong></div><div class="mini-metric"><span>QMs reached</span><strong>${stats.reachedQmgrs.length}</strong></div></div>
    ${stats.reachedQmgrs.length ? `<div class="chip-row">${stats.reachedQmgrs.slice(0, 6).map((name) => `<span class="chip">${sesc(name)}</span>`).join("")}</div>` : ""}
    <div class="card-foot"><small>observed from MQ connection evidence</small><button class="link-button" data-semantic-host="${sesc(host.name)}">Open in inventory →</button></div>
  </article>`;
}

function qmgrCard(qmgr, compact = false) {
  const host = shost(qmgr);
  const queues = owned(qmgr, "queue");
  const channels = owned(qmgr, "channel");
  const listeners = owned(qmgr, "listener");
  const runtime = runtimeState(qmgr);
  const evidence = evidenceState(qmgr);
  const placement = placementState(qmgr);
  const clusters = sarray(smeta(qmgr, "clusters", []));
  return `<article class="${compact ? "summary-card" : "qmgr-card"} semantic-qmgr-card">
    <div class="card-head"><div><h3>${sesc(qmgr.name)}</h3><p>${sesc(smeta(qmgr, "description", "IBM MQ Queue Manager"))}</p></div><span class="pill ${placement.key === "confirmed" ? "local" : "remote"}">${placement.key === "confirmed" ? "host confirmed" : "remote / unresolved"}</span></div>
    <div class="metric-row"><div class="mini-metric"><span>Queues</span><strong>${queues.length}</strong></div><div class="mini-metric"><span>Channels</span><strong>${channels.length}</strong></div><div class="mini-metric"><span>Listeners</span><strong>${listeners.length}</strong></div></div>
    <div class="semantic-state-grid">
      <div><span>Runtime</span><strong>${sesc(runtime.label)}</strong></div>
      <div><span>Evidence</span><strong>${sesc(evidence.label.replace(" evidence", ""))}</strong></div>
      <div><span>Placement</span><strong>${host ? sesc(host.name) : "Not collected"}</strong></div>
    </div>
    ${clusters.length ? `<div class="chip-row">${clusters.slice(0, 5).map((cluster) => `<span class="chip">${sesc(cluster)}</span>`).join("")}</div>` : ""}
    <div class="card-foot"><small>${host ? sesc(hostSecondary(host) || "physical host confirmed") : "collect peer to resolve physical host"}</small><button class="link-button" data-semantic-owner="${sesc(qmgr.name)}">Inspect objects →</button></div>
  </article>`;
}

function renderHosts() {
  if (!sx.topology) return;
  const allHosts = sx.topology.nodes.filter((node) => node.type === "host").sort((a, b) => scollator.compare(a.name, b.name));
  const query = (s$("serverSearch")?.value || "").trim().toLowerCase();
  const matches = allHosts.filter((host) => {
    if (!query) return true;
    const stats = hostStats(host);
    return [host.name, sip(host), hostSecondary(host), ...stats.qmgrs.map((q) => q.name), ...stats.apps.map((app) => app.name)].join(" ").toLowerCase().includes(query);
  });
  const infrastructure = matches.filter((host) => hostStats(host).qmgrs.length || host.metadata?.collector_host);
  const clients = matches.filter((host) => !infrastructure.includes(host));
  if (s$("serverCount")) s$("serverCount").textContent = `${matches.length} host${matches.length === 1 ? "" : "s"}`;
  if (s$("serversGrid")) {
    s$("serversGrid").innerHTML = `
      <section class="host-group"><div class="semantic-section-title"><div><span>Middleware infrastructure</span><strong>${infrastructure.length}</strong></div><p>Hosts with locally confirmed queue managers or collector evidence.</p></div><div class="server-grid">${infrastructure.map((host) => hostCard(host)).join("") || `<div class="route-empty">No matching middleware hosts.</div>`}</div></section>
      <section class="host-group"><div class="semantic-section-title"><div><span>Observed client hosts</span><strong>${clients.length}</strong></div><p>Systems observed connecting to middleware. These are clients, not middleware servers.</p></div><div class="server-grid">${clients.map((host) => hostCard(host)).join("") || `<div class="route-empty">No matching client hosts.</div>`}</div></section>`;
  }
  if (s$("overviewHosts")) {
    s$("overviewHosts").innerHTML = [...infrastructure.slice(0, 3), ...clients.slice(0, 3)].map((host) => hostCard(host, true)).join("") || `<div class="route-empty">No host evidence available.</div>`;
  }
}

function renderMiddleware() {
  if (!sx.topology || !s$("qmgrGrid")) return;
  const query = (s$("middlewareSearch")?.value || "").trim().toLowerCase();
  const placement = s$("middlewarePlacement")?.value || "";
  const qmgrs = sx.topology.nodes.filter((node) => node.type === "qmgr").filter((qmgr) => {
    const host = shost(qmgr);
    if (placement === "local" && !host) return false;
    if (placement === "remote" && host) return false;
    return !query || [qmgr.name, smeta(qmgr, "description", ""), host?.name || "", JSON.stringify(qmgr.metadata || {})].join(" ").toLowerCase().includes(query);
  }).sort((a, b) => (shost(a) ? 0 : 1) - (shost(b) ? 0 : 1) || scollator.compare(a.name, b.name));
  s$("qmgrGrid").innerHTML = qmgrs.map((qmgr) => qmgrCard(qmgr)).join("") || `<div class="route-empty">No matching queue managers.</div>`;
  if (s$("middlewareCount")) s$("middlewareCount").textContent = `${qmgrs.length} queue manager${qmgrs.length === 1 ? "" : "s"}`;
  if (s$("overviewQmgrs")) {
    const allQmgrs = sx.topology.nodes.filter((node) => node.type === "qmgr").sort((a, b) => (shost(a) ? 0 : 1) - (shost(b) ? 0 : 1) || scollator.compare(a.name, b.name));
    s$("overviewQmgrs").innerHTML = allQmgrs.map((qmgr) => qmgrCard(qmgr, true)).join("");
  }
}

function applicationGroups() {
  const groups = new Map();
  for (const app of sx.topology.nodes.filter((node) => node.type === "application")) {
    const key = app.name.trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, { name: app.name, instances: [] });
    groups.get(key).instances.push(app);
  }
  return [...groups.values()].sort((a, b) => scollator.compare(a.name, b.name));
}
function logicalAppCard(group) {
  const instanceStats = group.instances.map((app) => ({ app, host: shost(app), stats: appStats(app) }));
  const hosts = suniq(instanceStats.map((item) => item.host?.name || "Unknown / not collected")).sort(scollator.compare);
  const qmgrs = suniq(instanceStats.flatMap((item) => item.stats.qmgrs)).sort(scollator.compare);
  const puts = instanceStats.reduce((sum, item) => sum + item.stats.puts, 0);
  const gets = instanceStats.reduce((sum, item) => sum + item.stats.gets, 0);
  const connections = instanceStats.reduce((sum, item) => sum + item.stats.channels.length, 0);
  return `<article class="app-card semantic-app-card logical">
    <div class="card-head"><div><h3>${sesc(group.name)}</h3><p>${group.instances.length} instance${group.instances.length === 1 ? "" : "s"}${hosts.length ? ` · ${sesc(hosts.join(", "))}` : ""}</p></div><span class="pill">logical app</span></div>
    <div class="metric-row"><div class="mini-metric"><span>Instances</span><strong>${group.instances.length}</strong></div><div class="mini-metric"><span>Queue managers</span><strong>${qmgrs.length}</strong></div><div class="mini-metric"><span>Connections</span><strong>${connections}</strong></div></div>
    <div class="semantic-app-flow"><span>PUT routes <strong>${puts}</strong></span><span>GET / consume <strong>${gets}</strong></span></div>
    ${qmgrs.length ? `<div class="chip-row">${qmgrs.slice(0, 6).map((name) => `<span class="chip">${sesc(name)}</span>`).join("")}</div>` : ""}
    <div class="card-foot"><small>${hosts.length} observed host${hosts.length === 1 ? "" : "s"}</small><button class="link-button" data-semantic-app-group="${sesc(group.name)}">${group.instances.length > 1 ? "Open instances" : "Inspect instance"} →</button></div>
  </article>`;
}
function appInstanceCard(app) {
  const host = shost(app);
  const stats = appStats(app);
  const secondary = host ? hostSecondary(host) : "";
  return `<article class="app-card semantic-app-card instance">
    <div class="card-head"><div><h3>${sesc(app.name)}</h3><p>${sesc(host?.name || "Host unresolved")}${secondary ? ` · ${sesc(secondary)}` : ""}</p></div><span class="pill">instance</span></div>
    <div class="metric-row"><div class="mini-metric"><span>Queue managers</span><strong>${stats.qmgrs.length}</strong></div><div class="mini-metric"><span>PUT routes</span><strong>${stats.puts}</strong></div><div class="mini-metric"><span>GET / consume</span><strong>${stats.gets}</strong></div></div>
    ${stats.qmgrs.length ? `<div class="chip-row">${stats.qmgrs.slice(0, 6).map((name) => `<span class="chip">${sesc(name)}</span>`).join("")}</div>` : ""}
    <div class="card-foot"><small>${stats.channels.length} observed channel connection${stats.channels.length === 1 ? "" : "s"}</small><button class="link-button" data-semantic-node="${sesc(app.id)}">Inspect →</button></div>
  </article>`;
}
function ensureAppToggle() {
  const toolbar = s$("applicationSearch")?.closest(".toolbar");
  if (!toolbar || s$("semanticAppMode")) return;
  const wrap = document.createElement("div");
  wrap.id = "semanticAppMode";
  wrap.className = "semantic-segmented";
  wrap.innerHTML = `<button type="button" data-app-mode="logical">Applications</button><button type="button" data-app-mode="instances">Instances</button>`;
  const count = s$("applicationCount");
  toolbar.insertBefore(wrap, count || null);
}
function renderApplications() {
  if (!sx.topology || !s$("applicationsGrid")) return;
  ensureAppToggle();
  const query = (s$("applicationSearch")?.value || "").trim().toLowerCase();
  const groups = applicationGroups();
  document.querySelectorAll("#semanticAppMode [data-app-mode]").forEach((button) => button.classList.toggle("active", button.dataset.appMode === sx.appMode));
  if (sx.appMode === "logical") {
    const filtered = groups.filter((group) => !query || [group.name, ...group.instances.flatMap((app) => [shost(app)?.name || "", ...appStats(app).qmgrs])].join(" ").toLowerCase().includes(query));
    s$("applicationsGrid").innerHTML = filtered.map(logicalAppCard).join("") || `<div class="route-empty">No matching applications.</div>`;
    if (s$("applicationCount")) s$("applicationCount").textContent = `${filtered.length} logical application${filtered.length === 1 ? "" : "s"} · ${filtered.reduce((sum, group) => sum + group.instances.length, 0)} instances`;
  } else {
    const instances = sx.topology.nodes.filter((node) => node.type === "application").filter((app) => !query || [app.name, shost(app)?.name || "", ...appStats(app).qmgrs].join(" ").toLowerCase().includes(query)).sort((a, b) => scollator.compare(a.name, b.name) || scollator.compare(shost(a)?.name || "", shost(b)?.name || ""));
    s$("applicationsGrid").innerHTML = instances.map(appInstanceCard).join("") || `<div class="route-empty">No matching application instances.</div>`;
    if (s$("applicationCount")) s$("applicationCount").textContent = `${instances.length} application instance${instances.length === 1 ? "" : "s"}`;
  }
}

function patchOverviewStats() {
  const cards = [...document.querySelectorAll("#overviewStats .stat")];
  const groups = applicationGroups();
  for (const card of cards) {
    const label = card.querySelector("span")?.textContent?.trim();
    if (label === "Servers") card.querySelector("span").textContent = "Hosts";
    if (label === "Applications") {
      card.querySelector("span").textContent = "Applications";
      if (card.querySelector("strong")) card.querySelector("strong").textContent = groups.length.toLocaleString();
      if (card.querySelector("small")) card.querySelector("small").textContent = `${sx.topology.nodes.filter((node) => node.type === "application").length} observed instances`;
    }
  }
}

function invLegacyKey(node) {
  const raw = String(node?.status || "").trim().toUpperCase();
  if (raw === "OBSERVED") return "observed";
  if (["RUNNING", "ACTIVE"].includes(raw)) return "running";
  if (["STOPPED", "STOPPING", "INACTIVE"].includes(raw)) return "inactive";
  if (raw) return raw.toLowerCase();
  if (sarray(smeta(node, "runtime_sample", [])).length) return "observed";
  if (node?.type === "qmgr" && !shost(node)) return "unobserved";
  if (["channel", "listener", "queue", "qmgr"].includes(node?.type)) return "unobserved";
  return "unknown";
}
function inventoryFilters() {
  return {
    query: (s$("inventorySearch")?.value || "").trim().toLowerCase(),
    type: s$("inventoryType")?.value || "",
    server: s$("inventoryServer")?.value || "",
    owner: s$("inventoryOwner")?.value || "",
    status: s$("inventoryStatus")?.value || "",
  };
}
function inventorySearchText(node) {
  return [node.name, node.type, node.scope, node.status, sownerLabel(node), shostLabel(node), JSON.stringify(node.metadata || {})].join(" ").toLowerCase();
}
function inventoryNodes() {
  const f = inventoryFilters();
  return sx.topology.nodes.filter((node) => {
    if (f.type && node.type !== f.type) return false;
    if (f.server && shostLabel(node) !== f.server) return false;
    if (f.owner && sownerLabel(node) !== f.owner) return false;
    if (f.status) {
      if (f.status === "unknown") { if (runtimeState(node).key !== "unknown") return false; }
      else if (f.status === "running") { if (runtimeState(node).key !== "running") return false; }
      else if (f.status === "inactive") { if (runtimeState(node).key !== "inactive") return false; }
      else if (invLegacyKey(node) !== f.status) return false;
    }
    if (f.query && !inventorySearchText(node).includes(f.query)) return false;
    return true;
  }).sort((a, b) => scollator.compare(a.type, b.type) || scollator.compare(sownerLabel(a), sownerLabel(b)) || scollator.compare(a.name, b.name));
}
function channelConnections(node) {
  return sedges(sx.incoming, node.id, "CONNECTS_VIA").filter((edge) => ["application", "mq_process"].includes(snode(edge.source)?.type)).length;
}
function qmgrStats(node) {
  const children = owned(node);
  return { queues: children.filter((item) => item.type === "queue").length, channels: children.filter((item) => item.type === "channel").length, listeners: children.filter((item) => item.type === "listener").length };
}
function inventoryColumns(type) {
  const f = inventoryFilters();
  const fixedServer = Boolean(f.server), fixedOwner = Boolean(f.owner);
  if (type === "channel") return [
    ["Name", (node) => `<strong>${sesc(node.name)}</strong>`],
    ...(!fixedOwner ? [["Queue manager", (node) => `<strong class="semantic-owner">${sesc(sownerLabel(node))}</strong>`]] : []),
    ["Channel type", (node) => { const t = humanSubtype(node); return `<span>${sesc(t.human)}</span><small class="semantic-technical">${sesc(t.technical)}</small>`; }],
    ["Runtime", (node) => statusBadge(node)],
    ["Peer / CONNAME", (node) => sesc(smeta(node, "runtime_conname", smeta(node, "conname", "Not observed")))],
    ["Connections", (node) => String(channelConnections(node))],
  ];
  if (type === "queue") return [
    ["Name", (node) => `<strong>${sesc(node.name)}</strong>`],
    ...(!fixedOwner ? [["Queue manager", (node) => `<strong class="semantic-owner">${sesc(sownerLabel(node))}</strong>`]] : []),
    ["Queue type", (node) => { const t = humanSubtype(node); return `<span>${sesc(t.human)}</span><small class="semantic-technical">${sesc(t.technical)}</small>`; }],
    ["Runtime", (node) => statusBadge(node)],
    ["Depth", (node) => sesc(smeta(node, "runtime_curdepth", "Not observed"))],
    ["Open I / O", (node) => `${sesc(smeta(node, "runtime_ipprocs", "—"))} / ${sesc(smeta(node, "runtime_opprocs", "—"))}`],
  ];
  if (type === "application") return [
    ["Application instance", (node) => `<strong>${sesc(node.name)}</strong>`],
    ...(!fixedServer ? [["Client host", (node) => sesc(shostLabel(node))]] : []),
    ["Queue managers", (node) => sesc(appStats(node).qmgrs.join(", ") || "—")],
    ["Channels", (node) => String(appStats(node).channels.length)],
    ["PUT queues", (node) => String(appStats(node).puts)],
    ["GET / consume", (node) => String(appStats(node).gets)],
  ];
  if (type === "qmgr") return [
    ["Queue manager", (node) => `<strong>${sesc(node.name)}</strong>`],
    ...(!fixedServer ? [["Observed host", (node) => sesc(shostLabel(node))]] : []),
    ["Runtime", (node) => statusBadge(node)],
    ["Evidence", (node) => sesc(evidenceState(node).label.replace(" evidence", ""))],
    ["Placement", (node) => sesc(placementState(node).label.replace("Placement ", ""))],
    ["Queues", (node) => String(qmgrStats(node).queues)],
    ["Channels", (node) => String(qmgrStats(node).channels)],
  ];
  if (type === "listener") return [
    ["Listener", (node) => `<strong>${sesc(node.name)}</strong>`],
    ...(!fixedOwner ? [["Queue manager", (node) => `<strong class="semantic-owner">${sesc(sownerLabel(node))}</strong>`]] : []),
    ["Runtime", (node) => statusBadge(node)],
    ["Protocol", (node) => sesc(smeta(node, "trptype", "—"))],
    ["Address / port", (node) => `${sesc(smeta(node, "runtime_ipaddr", "*"))}:${sesc(smeta(node, "runtime_port", smeta(node, "port", "—")))}`],
  ];
  if (type === "mq_process") return [
    ["Process", (node) => `<strong>${sesc(node.name)}</strong>`],
    ["Queue manager", (node) => sesc(smeta(node, "qmgr", node.scope || "—"))],
    ...(!fixedServer ? [["Host", (node) => sesc(shostLabel(node))]] : []),
    ["PID", (node) => sesc(sarray(smeta(node, "pids", [])).join(", ") || "—")],
    ["User", (node) => sesc(sarray(smeta(node, "user_ids", [])).join(", ") || "—")],
  ];
  if (type === "host") return [
    ["Host", (node) => `<strong>${sesc(node.name)}</strong>`],
    ["IP / hostname", (node) => sesc(hostSecondary(node) || "—")],
    ["Role", (node) => hostStats(node).qmgrs.length ? "Middleware infrastructure" : "Client host"],
    ["Queue managers", (node) => String(hostStats(node).qmgrs.length)],
    ["Applications", (node) => String(hostStats(node).apps.length)],
  ];
  if (type === "endpoint") return [
    ["Endpoint", (node) => `<strong>${sesc(node.name)}</strong>`],
    ["Target QM", (node) => sesc(smeta(node, "qmgr", "—"))],
    ["Transport", (node) => sesc(smeta(node, "transport", "—"))],
    ["Channel", (node) => sesc(smeta(node, "channel", "—"))],
    ["Evidence", (node) => sesc(evidenceState(node).label.replace(" evidence", ""))],
  ];
  return [
    ["Type", (node) => `<span class="pill">${sesc(HUMAN_TYPES[node.type] || node.type.replaceAll("_", " "))}</span>`],
    ["Name", (node) => `<strong>${sesc(node.name)}</strong>`],
    ...(!fixedOwner ? [["Logical owner", (node) => sesc(sownerLabel(node))]] : []),
    ...(!fixedServer ? [["Current / observed host", (node) => sesc(shostLabel(node))]] : []),
    ["Runtime", (node) => statusBadge(node)],
  ];
}
function ensureInventoryPager() {
  if (s$("semanticInventoryPager")) return s$("semanticInventoryPager");
  const wrap = s$("inventoryRows")?.closest(".table-wrap");
  if (!wrap) return null;
  const pager = document.createElement("div");
  pager.id = "semanticInventoryPager";
  pager.className = "semantic-pager";
  wrap.insertAdjacentElement("afterend", pager);
  return pager;
}
function patchInventoryStatusOptions() {
  const select = s$("inventoryStatus");
  if (!select || select.dataset.semanticRuntime === "1") return;
  select.innerHTML = `<option value="">All runtime states</option><option value="running">RUNNING</option><option value="inactive">INACTIVE / STOPPED</option><option value="unknown">UNKNOWN</option>`;
  select.dataset.semanticRuntime = "1";
}
function renderInventoryContext(nodes) {
  const context = s$("inventoryContext");
  if (!context) return;
  const f = inventoryFilters();
  const pieces = ["Inventory"];
  if (f.server) pieces.push(f.server);
  if (f.owner && !["Host workload", "Network endpoint", "Physical system"].includes(f.owner)) pieces.push(f.owner);
  if (f.type) pieces.push(HUMAN_TYPES[f.type] || f.type.replaceAll("_", " "));
  const runtime = { running: 0, inactive: 0, unknown: 0 };
  const evidence = { observed: 0, configured: 0, inferred: 0 };
  for (const node of nodes) {
    runtime[runtimeState(node).key] = (runtime[runtimeState(node).key] || 0) + 1;
    const set = objectEvidence(node);
    for (const key of ["observed", "configured", "inferred"]) if (set.has(key)) evidence[key]++;
  }
  context.innerHTML = `<div class="inv-breadcrumb">${pieces.map((part, index) => `<span>${index ? "› " : ""}${sesc(part)}</span>`).join("")}</div>
    <div class="semantic-inventory-summary"><div><span>Total</span><strong>${nodes.length.toLocaleString()}</strong><small>matching objects</small></div><div><span>Runtime coverage</span><strong>${runtime.running.toLocaleString()} running · ${runtime.inactive.toLocaleString()} inactive</strong><small>${runtime.unknown.toLocaleString()} runtime unknown</small></div><div><span>Evidence coverage</span><strong>${evidence.observed.toLocaleString()} observed · ${evidence.configured.toLocaleString()} configured</strong><small>${evidence.inferred.toLocaleString()} inferred · evidence categories may overlap</small></div></div>`;
}
function renderInventoryPage() {
  if (!sx.topology || sx.renderingInventory || !s$("inventoryRows") || !s$("inventoryHead")) return;
  sx.renderingInventory = true;
  try {
    patchInventoryStatusOptions();
    const nodes = inventoryNodes();
    const pages = Math.max(1, Math.ceil(nodes.length / sx.inventoryPageSize));
    sx.inventoryPage = Math.min(Math.max(1, sx.inventoryPage), pages);
    const start = (sx.inventoryPage - 1) * sx.inventoryPageSize;
    const visible = nodes.slice(start, start + sx.inventoryPageSize);
    const cols = inventoryColumns(inventoryFilters().type || "");
    s$("inventoryHead").innerHTML = `<tr>${cols.map(([heading]) => `<th>${sesc(heading)}</th>`).join("")}</tr>`;
    const selectedName = s$("detailContent") && !s$("detailContent").hidden ? s$("detailName")?.textContent : "";
    s$("inventoryRows").innerHTML = visible.map((node) => `<tr tabindex="0" data-inv-node-id="${sesc(node.id)}" class="${selectedName === node.name ? "selected" : ""}">${cols.map(([, formatter]) => `<td>${formatter(node)}</td>`).join("")}</tr>`).join("");
    if (s$("inventoryCount")) s$("inventoryCount").textContent = nodes.length ? `Showing ${(start + 1).toLocaleString()}–${Math.min(start + visible.length, nodes.length).toLocaleString()} of ${nodes.length.toLocaleString()} objects` : "0 objects";
    renderInventoryContext(nodes);
    const pager = ensureInventoryPager();
    if (pager) {
      pager.hidden = pages <= 1;
      pager.innerHTML = pages <= 1 ? "" : `<button type="button" class="ghost" data-semantic-page="prev" ${sx.inventoryPage <= 1 ? "disabled" : ""}>← Previous</button><span>Page <strong>${sx.inventoryPage}</strong> of ${pages}</span><button type="button" class="ghost" data-semantic-page="next" ${sx.inventoryPage >= pages ? "disabled" : ""}>Next →</button>`;
    }
  } finally {
    sx.renderingInventory = false;
  }
}

function patchDetailSemantics() {
  const detail = s$("detailContent");
  if (!detail || detail.hidden) return;
  const name = s$("detailName")?.textContent;
  const type = s$("detailType")?.textContent?.trim().replaceAll(" ", "_");
  const candidates = sx.topology.nodes.filter((node) => node.name === name && node.type === type);
  const scope = s$("detailScope")?.textContent || "";
  const node = candidates.find((candidate) => scope.includes(candidate.scope || "")) || candidates[0];
  if (!node) return;
  const runtime = runtimeState(node);
  const evidence = evidenceState(node);
  const placement = placementState(node);
  document.querySelectorAll("#detailFacts .fact").forEach((fact) => {
    const label = fact.querySelector("span")?.textContent?.trim();
    if (label === "Runtime") fact.querySelector("strong").textContent = runtime.label;
  });
  let strip = s$("semanticDetailStates");
  if (!strip) {
    strip = document.createElement("div");
    strip.id = "semanticDetailStates";
    strip.className = "semantic-detail-states";
    s$("detailFacts")?.insertAdjacentElement("beforebegin", strip);
  }
  strip.innerHTML = `<div><span>Runtime</span><strong>${sesc(runtime.label)}</strong></div><div><span>Evidence</span><strong>${sesc(evidence.label)}</strong></div><div><span>Placement</span><strong>${sesc(placement.label)}</strong></div>`;
}

function simplifyKnownRoutes() {
  const root = s$("routeSuggestions");
  if (!root || root.querySelector("details.semantic-known-routes")) return;
  const buttons = [...root.querySelectorAll("button")];
  if (!buttons.length) return;
  const details = document.createElement("details");
  details.className = "semantic-known-routes";
  const summary = document.createElement("summary");
  summary.innerHTML = `Try a known route <span>${buttons.length} examples</span>`;
  const list = document.createElement("div");
  list.className = "semantic-known-list";
  buttons.forEach((button) => list.appendChild(button));
  details.append(summary, list);
  root.replaceChildren(details);
}
function patchRouteTypes() {
  document.querySelectorAll("#routeResult .route-type").forEach((el) => {
    if (el.dataset.semanticType === "1") return;
    const technical = el.textContent.trim();
    const human = QUEUE_TYPES[technical] || CHANNEL_TYPES[technical] || HUMAN_TYPES[technical.toLowerCase()] || technical.replaceAll("_", " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
    if (human !== technical) {
      el.textContent = human;
      const tech = document.createElement("small");
      tech.className = "semantic-technical-type";
      tech.textContent = technical;
      el.insertAdjacentElement("afterend", tech);
    }
    el.dataset.semanticType = "1";
  });
  document.querySelectorAll("#routeResult .journey-card-head .pill").forEach((pill) => {
    if (["status n/a", "observed"].includes(pill.textContent.trim().toLowerCase())) pill.textContent = "runtime unknown";
  });
}
function patchRouteEvidence() {
  const cards = [...document.querySelectorAll("#routeResult .route-health-card")];
  if (!cards.length) return;
  const evidenceCard = cards.find((card) => card.querySelector("span")?.textContent?.trim().toLowerCase() === "evidence");
  if (!evidenceCard) return;
  const deliveryBadges = [...document.querySelectorAll("#routeResult .journey-transition .evidence-badge")].filter((badge) => !badge.closest(".transport-detail"));
  const deliveryCounts = { observed: 0, configured: 0, inferred: 0 };
  deliveryBadges.forEach((badge) => { const key = badge.textContent.trim().toLowerCase(); if (key in deliveryCounts) deliveryCounts[key]++; });
  const deliveryParts = Object.entries(deliveryCounts).filter(([, count]) => count).map(([key, count]) => `${count} ${key}`);
  const transportTexts = [...document.querySelectorAll("#routeResult .transport-head small")].map((el) => el.textContent.trim()).filter(Boolean);
  evidenceCard.querySelector("span").textContent = "Evidence breakdown";
  const strong = evidenceCard.querySelector("strong");
  const small = evidenceCard.querySelector("small");
  if (strong) strong.textContent = deliveryParts.length ? `${deliveryParts.join(" · ")} delivery` : "No delivery-edge evidence";
  if (small) small.textContent = transportTexts.length ? `Transport: ${transportTexts.join(" · ")}` : "Transport evidence not expanded";
}
function patchRoutes() {
  simplifyKnownRoutes();
  patchRouteTypes();
  patchRouteEvidence();
}

function ensureBreadcrumb() {
  if (s$("semanticBreadcrumb")) return;
  const topbar = document.querySelector(".topbar");
  if (!topbar) return;
  const bar = document.createElement("nav");
  bar.id = "semanticBreadcrumb";
  bar.className = "semantic-breadcrumb";
  bar.setAttribute("aria-label", "Current context");
  topbar.insertAdjacentElement("afterend", bar);
}
function currentView() {
  return document.querySelector(".view.active")?.dataset?.viewPanel || "overview";
}
function renderBreadcrumb() {
  ensureBreadcrumb();
  const bar = s$("semanticBreadcrumb");
  if (!bar) return;
  const view = currentView();
  const labels = { overview: "Overview", servers: "Hosts", middleware: "Middleware", applications: "Applications", routes: "Routes", inventory: "Inventory", snapshots: "Snapshots", administration: "Administration" };
  const parts = [labels[view] || view];
  if (view === "inventory") {
    const f = inventoryFilters();
    if (f.server) parts.push(f.server);
    if (f.owner && !["Host workload", "Network endpoint", "Physical system"].includes(f.owner)) parts.push(f.owner);
    if (f.type) parts.push(HUMAN_TYPES[f.type] || f.type.replaceAll("_", " "));
    if (s$("detailContent") && !s$("detailContent").hidden && s$("detailName")?.textContent) parts.push(s$("detailName").textContent);
  }
  if (view === "routes") {
    if (s$("routeFrom")?.dataset?.selectedId || s$("routeFrom")?.value) parts.push(s$("routeFrom").value);
    if (s$("routeTo")?.dataset?.selectedId || s$("routeTo")?.value) parts.push(s$("routeTo").value);
  }
  bar.innerHTML = parts.map((part, index) => `<span>${index ? "›" : ""}</span><strong>${sesc(part)}</strong>`).join("");
  bar.hidden = view === "overview";
}

function renameHostsUI() {
  const nav = document.querySelector('[data-view="servers"]');
  if (nav) nav.textContent = "Hosts";
  const heading = document.querySelector('#view-overview [data-go="servers"]');
  if (heading) heading.textContent = "Open hosts";
  const serverSearchLabel = s$("serverSearch")?.closest("label")?.querySelector("span");
  if (serverSearchLabel) serverSearchLabel.textContent = "Search hosts";
  const invServerLabel = s$("inventoryServer")?.closest("label")?.querySelector("span");
  if (invServerLabel) invServerLabel.textContent = "Host";
  if (currentView() === "servers") {
    if (s$("pageTitle")) s$("pageTitle").textContent = "Hosts";
    if (s$("pageSubtitle")) s$("pageSubtitle").textContent = "Middleware infrastructure and observed client hosts, separated by operational role.";
  }
}

function semanticNavigateInventory({ host = "", owner = "", nodeId = "" } = {}) {
  const nav = document.querySelector('[data-view="inventory"]');
  nav?.click();
  setTimeout(() => {
    if (host && s$("inventoryServer")) { s$("inventoryServer").value = host; s$("inventoryServer").dispatchEvent(new Event("change", { bubbles: true })); }
    if (owner && s$("inventoryOwner")) { s$("inventoryOwner").value = owner; s$("inventoryOwner").dispatchEvent(new Event("change", { bubbles: true })); }
    if (nodeId) {
      const row = document.querySelector(`[data-inv-node-id="${CSS.escape(nodeId)}"]`);
      row?.click();
    }
    sx.inventoryPage = 1;
    scheduleRefresh();
  }, 20);
}

function bindSemanticEvents() {
  document.addEventListener("click", (event) => {
    const host = event.target.closest("[data-semantic-host]");
    if (host) { semanticNavigateInventory({ host: host.dataset.semanticHost }); return; }
    const owner = event.target.closest("[data-semantic-owner]");
    if (owner) { semanticNavigateInventory({ owner: owner.dataset.semanticOwner }); return; }
    const node = event.target.closest("[data-semantic-node]");
    if (node) { semanticNavigateInventory({ nodeId: node.dataset.semanticNode }); return; }
    const group = event.target.closest("[data-semantic-app-group]");
    if (group) {
      sx.appMode = "instances";
      if (s$("applicationSearch")) s$("applicationSearch").value = group.dataset.semanticAppGroup;
      renderApplications();
      return;
    }
    const mode = event.target.closest("[data-app-mode]");
    if (mode) { sx.appMode = mode.dataset.appMode; renderApplications(); return; }
    const page = event.target.closest("[data-semantic-page]");
    if (page) {
      sx.inventoryPage += page.dataset.semanticPage === "next" ? 1 : -1;
      renderInventoryPage();
      s$("inventoryRows")?.closest(".table-wrap")?.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
  });

  ["serverSearch", "middlewareSearch", "middlewarePlacement", "applicationSearch"].forEach((id) => {
    const el = s$(id); if (!el) return;
    el.addEventListener(id.endsWith("Placement") ? "change" : "input", () => {
      if (id === "serverSearch") renderHosts();
      if (id.startsWith("middleware")) renderMiddleware();
      if (id === "applicationSearch") renderApplications();
    });
  });
  ["inventorySearch", "inventoryType", "inventoryServer", "inventoryOwner", "inventoryStatus"].forEach((id) => {
    const el = s$(id); if (!el) return;
    el.addEventListener(id === "inventorySearch" ? "input" : "change", () => { sx.inventoryPage = 1; setTimeout(() => { renderInventoryPage(); renderBreadcrumb(); patchDetailSemantics(); }, 0); }, true);
  });
  s$("inventoryReset")?.addEventListener("click", () => { sx.inventoryPage = 1; setTimeout(() => { patchInventoryStatusOptions(); renderInventoryPage(); }, 10); }, true);
  document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => setTimeout(() => { renameHostsUI(); renderBreadcrumb(); if (button.dataset.view === "servers") renderHosts(); if (button.dataset.view === "middleware") renderMiddleware(); if (button.dataset.view === "applications") renderApplications(); if (button.dataset.view === "inventory") renderInventoryPage(); }, 0), true));
}

function scheduleRefresh() {
  if (sx.observerTimer) return;
  sx.observerTimer = setTimeout(() => {
    sx.observerTimer = null;
    renameHostsUI();
    patchOverviewStats();
    renderBreadcrumb();
    if (currentView() === "servers") renderHosts();
    if (currentView() === "middleware") renderMiddleware();
    if (currentView() === "applications") renderApplications();
    if (currentView() === "inventory") { renderInventoryPage(); patchDetailSemantics(); }
    if (currentView() === "routes") patchRoutes();
  }, 0);
}

function installObserver() {
  const observer = new MutationObserver((mutations) => {
    if (sx.renderingInventory) return;
    const relevant = mutations.some((mutation) => {
      const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      return target?.closest?.("#overviewStats,#overviewHosts,#overviewQmgrs,#serversGrid,#qmgrGrid,#applicationsGrid,#inventoryRows,#inventoryContext,#detailContent,#routeSuggestions,#routeResult,#pageTitle,.view");
    });
    if (relevant) scheduleRefresh();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

function injectCss() {
  if (document.querySelector('link[href="/semantic-ux.css"]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/semantic-ux.css";
  document.head.appendChild(link);
}

async function initSemanticUx() {
  injectCss();
  try {
    const response = await fetch("/api/v1/topology/current");
    if (!response.ok) return;
    buildIndexes(await response.json());
    ensureAppToggle();
    ensureBreadcrumb();
    renameHostsUI();
    patchOverviewStats();
    renderHosts();
    renderMiddleware();
    renderApplications();
    patchInventoryStatusOptions();
    renderInventoryPage();
    patchDetailSemantics();
    patchRoutes();
    renderBreadcrumb();
    bindSemanticEvents();
    installObserver();
  } catch (error) {
    console.error("Semantic UX pass failed to initialize", error);
  }
}

initSemanticUx();
