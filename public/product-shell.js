const PRODUCT_SHELL_REVISION = "20260910-1";

const ps = {
  globalTimer: null,
  globalController: null,
  globalResults: [],
  globalActive: -1,
  workspace: null,
  qmgrCache: null,
  qmgrSearch: "",
  qmgrPlacement: "",
};

const p$ = (id) => document.getElementById(id);
const pesc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const pnat = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const TYPE_LABELS = {
  "infra.host": "Host",
  "infra.network_endpoint": "Network endpoint",
  "app.application": "Application",
  "app.application_instance": "Application instance",
  "mq.queue_manager": "Queue manager",
  "mq.queue_manager_instance": "QM instance",
  "mq.queue": "Queue",
  "mq.channel": "Channel",
  "mq.listener": "Listener",
  "mq.cluster": "Cluster",
  "mq.topic": "Topic",
  "mq.subscription": "Subscription",
  "mq.process_definition": "Process definition",
  "mq.runtime_process": "Runtime process",
  "mq.service": "Service",
  "mq.namelist": "Namelist",
};

const WORKSPACE_TABS = {
  "infra.host": ["Overview", "Middleware", "Endpoints", "Configuration", "Evidence"],
  "mq.queue_manager": ["Overview", "Runtime", "Objects", "Connections", "Clusters", "Configuration", "Evidence"],
  "mq.queue": ["Overview", "Connections", "Routes", "Activity", "Configuration", "Evidence"],
  "mq.channel": ["Overview", "Connections", "Runtime", "Configuration", "Evidence"],
  "mq.listener": ["Overview", "Connections", "Configuration", "Evidence"],
  "app.application": ["Overview", "Connections", "Routes", "Evidence"],
  "app.application_instance": ["Overview", "Connections", "Routes", "Runtime", "Evidence"],
  "infra.network_endpoint": ["Overview", "Connections", "Evidence"],
};

function typeLabel(type) {
  return TYPE_LABELS[type] || String(type || "entity").replaceAll("_", " ").replaceAll(".", " · ");
}

function relativeAge(value) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "unknown age";
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}

async function api(path, signal) {
  const response = await fetch(path, { headers: { accept: "application/json" }, signal });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) throw new Error(body.detail || `Request failed (${response.status})`);
  return body;
}

function installStyles() {
  if (document.querySelector('link[data-product-shell]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `/product-shell.css?v=${PRODUCT_SHELL_REVISION}`;
  link.dataset.productShell = "true";
  document.head.appendChild(link);
}

function missionGroup(label, buttons, note = "") {
  const group = document.createElement("div");
  group.className = "nav-mission";
  const title = document.createElement("div");
  title.className = "nav-mission-title";
  title.textContent = label;
  group.appendChild(title);
  buttons.filter(Boolean).forEach((button) => group.appendChild(button));
  if (note) {
    const status = document.createElement("div");
    status.className = "nav-mission-status";
    status.textContent = note;
    group.appendChild(status);
  }
  return group;
}

function installMissionNavigation() {
  const nav = document.querySelector(".nav");
  if (!nav || nav.dataset.productShell === "true") return;
  const existing = Object.fromEntries([...nav.querySelectorAll("[data-view]")].map((button) => [button.dataset.view, button]));
  const qmgr = document.createElement("button");
  qmgr.className = "nav-item";
  qmgr.dataset.view = "qmgrs";
  qmgr.textContent = "Queue Managers";

  if (existing.inventory) existing.inventory.textContent = "Objects";
  if (existing.snapshots) existing.snapshots.textContent = "Collection";

  nav.innerHTML = "";
  nav.append(
    missionGroup("Monitor", [existing.overview]),
    missionGroup("Operate", [existing.servers, qmgr, existing.inventory, existing.routes]),
    missionGroup("Develop", [], "ACE workspace · next evidence source"),
    missionGroup("System", [existing.snapshots, existing.administration]),
  );
  nav.dataset.productShell = "true";

  const objectNav = existing.inventory;
  if (objectNav) {
    const observer = new MutationObserver(() => {
      if (objectNav.textContent.trim() !== "Objects") objectNav.textContent = "Objects";
    });
    observer.observe(objectNav, { childList: true, subtree: false });
  }
  const jump = p$("jumpInventory");
  if (jump) {
    jump.textContent = "Browse objects";
    const observer = new MutationObserver(() => {
      if (jump.textContent.trim() !== "Browse objects") jump.textContent = "Browse objects";
    });
    observer.observe(jump, { childList: true, subtree: false });
  }
}

function installQueueManagerView() {
  if (p$("view-qmgrs")) return;
  const section = document.createElement("section");
  section.id = "view-qmgrs";
  section.className = "view";
  section.dataset.viewPanel = "qmgrs";
  section.innerHTML = `
    <div class="toolbar panel qmgr-toolbar">
      <label class="search-box"><span>Search queue managers</span><input id="qmgrCanonicalSearch" type="search" placeholder="Queue manager, cluster, host…" /></label>
      <label class="select-box"><span>Placement</span><select id="qmgrCanonicalPlacement"><option value="">All placement states</option><option value="confirmed">Placement confirmed</option><option value="gap">Placement gap</option></select></label>
      <div id="qmgrCanonicalCount" class="toolbar-count"></div>
    </div>
    <section class="panel qmgr-workspace">
      <div class="section-heading compact-heading"><div><p class="section-kicker">Logical MQ ownership</p><h2>Queue manager estate</h2><p>One row per canonical logical queue manager. Physical placement is shown only when supported by collected host evidence.</p></div></div>
      <div class="table-wrap qmgr-table-wrap">
        <table class="qmgr-table">
          <thead><tr><th>Queue manager</th><th>Physical placement</th><th>Clusters</th><th>Queues</th><th>Channels</th><th>Listeners</th><th>Evidence</th><th></th></tr></thead>
          <tbody id="qmgrCanonicalRows"><tr><td colspan="8"><div class="route-empty">Open Queue Managers to load the canonical estate.</div></td></tr></tbody>
        </table>
      </div>
    </section>`;
  const routes = p$("view-routes");
  routes?.parentNode?.insertBefore(section, routes);

  p$("qmgrCanonicalSearch")?.addEventListener("input", (event) => {
    ps.qmgrSearch = event.target.value.trim().toLowerCase();
    renderQmgrRows();
  });
  p$("qmgrCanonicalPlacement")?.addEventListener("change", (event) => {
    ps.qmgrPlacement = event.target.value;
    renderQmgrRows();
  });
}

function installGlobalSearch() {
  const topbar = document.querySelector(".topbar");
  if (!topbar || p$("globalSemanticSearch")) return;
  const wrap = document.createElement("div");
  wrap.className = "global-semantic-search";
  wrap.innerHTML = `<label for="globalSemanticSearch"><span class="sr-only">Search middleware estate</span><b>⌕</b><input id="globalSemanticSearch" type="search" autocomplete="off" placeholder="Search queue managers, queues, channels, hosts…" aria-autocomplete="list" aria-controls="globalSemanticResults" aria-expanded="false" /></label><div id="globalSemanticResults" class="global-semantic-results" role="listbox"></div>`;
  topbar.insertBefore(wrap, topbar.querySelector(".top-actions"));
  const input = p$("globalSemanticSearch");
  input?.addEventListener("input", () => scheduleGlobalSearch());
  input?.addEventListener("keydown", globalSearchKeydown);
  input?.addEventListener("focus", () => { if (ps.globalResults.length) openGlobalResults(); });
  document.addEventListener("click", (event) => {
    if (!wrap.contains(event.target)) closeGlobalResults();
  });
}

function scheduleGlobalSearch() {
  clearTimeout(ps.globalTimer);
  ps.globalTimer = setTimeout(runGlobalSearch, 160);
}

async function runGlobalSearch() {
  const input = p$("globalSemanticSearch");
  const results = p$("globalSemanticResults");
  const query = input?.value.trim() || "";
  ps.globalController?.abort();
  ps.globalResults = [];
  ps.globalActive = -1;
  if (!results || query.length < 2) {
    if (results) results.innerHTML = query ? `<div class="global-search-empty">Type at least 2 characters.</div>` : "";
    closeGlobalResults();
    return;
  }
  const controller = new AbortController();
  ps.globalController = controller;
  results.innerHTML = `<div class="global-search-empty">Searching canonical estate…</div>`;
  openGlobalResults();
  try {
    const params = new URLSearchParams({ q: query, limit: "12", offset: "0" });
    const data = await api(`/api/v2/estate/current/entities?${params}`, controller.signal);
    if (controller.signal.aborted) return;
    ps.globalResults = data.entities || [];
    results.innerHTML = ps.globalResults.length ? ps.globalResults.map((entity, index) => `<button type="button" role="option" data-global-result="${index}" data-entity-id="${pesc(entity.entity_id)}"><span><strong>${pesc(entity.display_name || entity.identity_key)}</strong><small>${pesc(typeLabel(entity.semantic_type))} · ${pesc((entity.evidence_classes || []).join(" · ") || "evidence unknown")}</small></span><i>${Number(entity.source_count || 0)} source${Number(entity.source_count || 0) === 1 ? "" : "s"}</i></button>`).join("") : `<div class="global-search-empty">No canonical entities match “${pesc(query)}”.</div>`;
    results.querySelectorAll("[data-global-result]").forEach((button) => button.addEventListener("click", () => selectGlobalResult(Number(button.dataset.globalResult))));
  } catch (error) {
    if (error?.name === "AbortError") return;
    results.innerHTML = `<div class="global-search-empty error">${pesc(error instanceof Error ? error.message : String(error))}</div>`;
  }
}

function openGlobalResults() {
  const input = p$("globalSemanticSearch");
  const results = p$("globalSemanticResults");
  if (!input || !results || !results.innerHTML.trim()) return;
  results.classList.add("open");
  input.setAttribute("aria-expanded", "true");
}

function closeGlobalResults() {
  p$("globalSemanticResults")?.classList.remove("open");
  p$("globalSemanticSearch")?.setAttribute("aria-expanded", "false");
  ps.globalActive = -1;
}

function paintGlobalActive() {
  p$("globalSemanticResults")?.querySelectorAll("[data-global-result]").forEach((button, index) => {
    button.classList.toggle("active", index === ps.globalActive);
    if (index === ps.globalActive) button.scrollIntoView({ block: "nearest" });
  });
}

function globalSearchKeydown(event) {
  if (!ps.globalResults.length) {
    if (event.key === "Escape") closeGlobalResults();
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault(); ps.globalActive = (ps.globalActive + 1) % ps.globalResults.length; paintGlobalActive(); openGlobalResults();
  } else if (event.key === "ArrowUp") {
    event.preventDefault(); ps.globalActive = (ps.globalActive - 1 + ps.globalResults.length) % ps.globalResults.length; paintGlobalActive(); openGlobalResults();
  } else if (event.key === "Enter" && ps.globalActive >= 0) {
    event.preventDefault(); selectGlobalResult(ps.globalActive);
  } else if (event.key === "Escape") {
    event.preventDefault(); closeGlobalResults();
  }
}

function selectGlobalResult(index) {
  const entity = ps.globalResults[index];
  if (!entity) return;
  closeGlobalResults();
  const input = p$("globalSemanticSearch");
  if (input) input.value = "";
  void openObjectWorkspace(entity.entity_id, true);
}

function identityField(identityKey, field) {
  const match = String(identityKey || "").match(new RegExp(`(?:^|\\|)${field}=([^|]+)`, "i"));
  return match ? match[1] : "";
}

async function fetchAllEntities(semanticType) {
  const items = [];
  let offset = 0;
  for (let page = 0; page < 20; page += 1) {
    const params = new URLSearchParams({ semantic_type: semanticType, limit: "100", offset: String(offset) });
    const data = await api(`/api/v2/estate/current/entities?${params}`);
    items.push(...(data.entities || []));
    const next = data.page?.next_offset;
    if (next == null) break;
    offset = Number(next);
  }
  return items;
}

async function fetchAllRelations(semanticType) {
  const items = [];
  let offset = 0;
  for (let page = 0; page < 10; page += 1) {
    const params = new URLSearchParams({ semantic_type: semanticType, limit: "100", offset: String(offset) });
    const data = await api(`/api/v2/estate/current/relations?${params}`);
    items.push(...(data.relations || []));
    const next = data.page?.next_offset;
    if (next == null) break;
    offset = Number(next);
  }
  return items;
}

function ownedQmgrName(entity) {
  return (identityField(entity.identity_key, "queue_manager_key") || String(entity.properties?.QUEUE_MANAGER || "")).toLowerCase();
}

function propertyValue(entity, key) {
  const properties = entity?.properties && typeof entity.properties === "object" ? entity.properties : {};
  const found = Object.entries(properties).find(([name]) => name.toLowerCase() === key.toLowerCase());
  const value = found?.[1];
  if (Array.isArray(value)) return value.join(", ");
  return value == null || value === "" ? "—" : String(value);
}

async function loadQmgrModel() {
  if (ps.qmgrCache) return ps.qmgrCache;
  const [qmgrs, instances, hosts, queues, channels, listeners, hasInstances, runsOn] = await Promise.all([
    fetchAllEntities("mq.queue_manager"),
    fetchAllEntities("mq.queue_manager_instance"),
    fetchAllEntities("infra.host"),
    fetchAllEntities("mq.queue"),
    fetchAllEntities("mq.channel"),
    fetchAllEntities("mq.listener"),
    fetchAllRelations("has_instance"),
    fetchAllRelations("runs_on"),
  ]);
  const details = await Promise.all(qmgrs.map((entity) => api(`/api/v2/estate/current/entities/${encodeURIComponent(entity.entity_id)}?relation_limit=1`).then((data) => data.entity).catch(() => entity)));
  const detailById = new Map(details.map((entity) => [entity.entity_id, entity]));
  const instanceById = new Map(instances.map((entity) => [entity.entity_id, entity]));
  const hostById = new Map(hosts.map((entity) => [entity.entity_id, entity]));
  const instancesByQmgr = new Map();
  hasInstances.forEach((relation) => {
    if (!instancesByQmgr.has(relation.source_entity_id)) instancesByQmgr.set(relation.source_entity_id, []);
    instancesByQmgr.get(relation.source_entity_id).push(relation.target_entity_id);
  });
  const hostByInstance = new Map(runsOn.map((relation) => [relation.source_entity_id, relation.target_entity_id]));
  const counts = new Map();
  qmgrs.forEach((qmgr) => counts.set(String(qmgr.display_name || "").toLowerCase(), { queues: 0, channels: 0, listeners: 0 }));
  [[queues, "queues"], [channels, "channels"], [listeners, "listeners"]].forEach(([entities, field]) => entities.forEach((entity) => {
    const key = ownedQmgrName(entity);
    if (counts.has(key)) counts.get(key)[field] += 1;
  }));
  ps.qmgrCache = qmgrs.map((qmgr) => {
    const instanceIds = instancesByQmgr.get(qmgr.entity_id) || [];
    const placements = instanceIds.map((id) => hostById.get(hostByInstance.get(id))).filter(Boolean);
    const detail = detailById.get(qmgr.entity_id) || qmgr;
    return {
      entity: detail,
      placements,
      counts: counts.get(String(qmgr.display_name || "").toLowerCase()) || { queues: 0, channels: 0, listeners: 0 },
      clusters: propertyValue(detail, "CLUSTER"),
    };
  }).sort((a, b) => pnat.compare(a.entity.display_name || "", b.entity.display_name || ""));
  return ps.qmgrCache;
}

async function renderQueueManagers() {
  const rows = p$("qmgrCanonicalRows");
  if (!rows) return;
  rows.innerHTML = `<tr><td colspan="8"><div class="route-empty">Loading canonical queue-manager estate…</div></td></tr>`;
  try {
    await loadQmgrModel();
    renderQmgrRows();
  } catch (error) {
    rows.innerHTML = `<tr><td colspan="8"><div class="route-empty">${pesc(error instanceof Error ? error.message : String(error))}</div></td></tr>`;
  }
}

function renderQmgrRows() {
  const rows = p$("qmgrCanonicalRows");
  if (!rows || !ps.qmgrCache) return;
  const filtered = ps.qmgrCache.filter((item) => {
    const name = String(item.entity.display_name || "").toLowerCase();
    const clusters = String(item.clusters || "").toLowerCase();
    const hosts = item.placements.map((host) => String(host.display_name || "").toLowerCase()).join(" ");
    const searchOk = !ps.qmgrSearch || `${name} ${clusters} ${hosts}`.includes(ps.qmgrSearch);
    const placementOk = !ps.qmgrPlacement || (ps.qmgrPlacement === "confirmed" ? item.placements.length > 0 : item.placements.length === 0);
    return searchOk && placementOk;
  });
  p$("qmgrCanonicalCount").textContent = `${filtered.length} of ${ps.qmgrCache.length} logical QMs`;
  rows.innerHTML = filtered.length ? filtered.map((item) => {
    const entity = item.entity;
    const name = entity.display_name || entity.identity_key;
    const placement = item.placements.length ? item.placements.map((host) => host.display_name).join(", ") : "Not collected";
    const cluster = item.clusters === "—" ? "—" : item.clusters;
    return `<tr data-qmgr-id="${pesc(entity.entity_id)}"><td><strong>${pesc(name)}</strong><small class="qmgr-identity">${pesc(entity.identity_rule || "identity")}</small></td><td><span class="${item.placements.length ? "estate-server-known" : "estate-server-unknown"}">${pesc(placement)}</span></td><td>${pesc(cluster)}</td><td class="num">${item.counts.queues.toLocaleString()}</td><td class="num">${item.counts.channels.toLocaleString()}</td><td class="num">${item.counts.listeners.toLocaleString()}</td><td><div class="estate-evidence">${(entity.evidence_classes || []).map((value) => `<span>${pesc(value)}</span>`).join("")}</div><small title="${pesc(entity.observed_at ? new Date(entity.observed_at).toLocaleString() : "")}">${entity.observed_at ? relativeAge(entity.observed_at) : "unknown age"} · ${Number(entity.source_count || 0)} source${Number(entity.source_count || 0) === 1 ? "" : "s"}</small></td><td><button class="ghost qmgr-open" type="button" data-open-qmgr="${pesc(entity.entity_id)}">Open</button></td></tr>`;
  }).join("") : `<tr><td colspan="8"><div class="route-empty">No queue managers match these filters.</div></td></tr>`;
  rows.querySelectorAll("tr[data-qmgr-id]").forEach((row) => row.addEventListener("dblclick", () => void openObjectWorkspace(row.dataset.qmgrId, true)));
  rows.querySelectorAll("[data-open-qmgr]").forEach((button) => button.addEventListener("click", () => void openObjectWorkspace(button.dataset.openQmgr, true)));
}

function ensureObjectWorkspace() {
  let workspace = p$("objectWorkspace");
  if (workspace) return workspace;
  workspace = document.createElement("div");
  workspace.id = "objectWorkspace";
  workspace.className = "object-workspace";
  workspace.hidden = true;
  workspace.innerHTML = `<div class="object-workspace-backdrop" data-workspace-close></div><article class="object-workspace-shell" role="dialog" aria-modal="true" aria-labelledby="objectWorkspaceName"><header class="object-workspace-head"><button class="ghost object-workspace-back" type="button" data-workspace-close>← Back</button><div class="object-workspace-identity"><span id="objectWorkspaceType"></span><h2 id="objectWorkspaceName">Entity</h2><p id="objectWorkspaceScope"></p></div><div class="object-workspace-actions"><button id="objectWorkspaceFind" class="ghost" type="button">Find in Objects</button><button class="icon-button" type="button" data-workspace-close aria-label="Close object workspace">×</button></div></header><nav id="objectWorkspaceTabs" class="object-workspace-tabs" aria-label="Object detail sections"></nav><section id="objectWorkspaceBody" class="object-workspace-body"></section></article>`;
  document.body.appendChild(workspace);
  workspace.querySelectorAll("[data-workspace-close]").forEach((node) => node.addEventListener("click", () => closeObjectWorkspace(true)));
  p$("objectWorkspaceFind")?.addEventListener("click", () => findWorkspaceEntityInObjects());
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !workspace.hidden) closeObjectWorkspace(true); });
  return workspace;
}

function workspaceTabsFor(type) {
  return WORKSPACE_TABS[type] || ["Overview", "Connections", "Configuration", "Evidence"];
}

function relationNeighbor(relation, entityId) {
  const outgoing = relation.source_entity_id === entityId;
  return {
    outgoing,
    id: relation.neighbor_entity_id || (outgoing ? relation.target_entity_id : relation.source_entity_id),
    name: relation.neighbor_display_name || relation.neighbor_entity_id || (outgoing ? relation.target_entity_id : relation.source_entity_id),
    type: relation.neighbor_semantic_type || "entity",
  };
}

function relationMatches(tab, semanticType) {
  const type = String(semanticType || "");
  if (tab === "Connections") return type.startsWith("network.") || type.startsWith("runtime.connect") || type.startsWith("runtime.opens");
  if (tab === "Routes") return type.startsWith("routing.") || type === "mq.cluster_discovers";
  if (tab === "Activity") return type.startsWith("activity.");
  if (tab === "Runtime") return type === "runs_on" || type === "has_instance" || type.startsWith("runtime.") || type.startsWith("network.");
  if (tab === "Objects") return type === "contains" || type === "has_instance";
  if (tab === "Clusters") return type === "member_of" || type === "mq.cluster_discovers" || type.startsWith("network.connects_to");
  if (tab === "Middleware") return type === "runs_on" || type === "has_instance" || type === "contains";
  if (tab === "Endpoints") return type.startsWith("network.");
  return true;
}

function renderRelationCards(relations, entityId, emptyText) {
  if (!relations.length) return `<div class="object-workspace-empty">${pesc(emptyText)}</div>`;
  return `<div class="object-relation-grid">${relations.map((relation) => {
    const neighbor = relationNeighbor(relation, entityId);
    return `<button type="button" class="object-relation-card" data-workspace-neighbor="${pesc(neighbor.id)}"><span>${neighbor.outgoing ? "→" : "←"} ${pesc(relation.semantic_type)}</span><strong>${pesc(neighbor.name)}</strong><small>${pesc(typeLabel(neighbor.type))} · ${pesc((relation.evidence_classes || []).join(" · ") || "evidence")}</small></button>`;
  }).join("")}</div>`;
}

function valueHtml(value) {
  if (Array.isArray(value)) return pesc(value.join(", "));
  if (value && typeof value === "object") return pesc(JSON.stringify(value));
  return pesc(value == null || value === "" ? "—" : value);
}

function renderWorkspaceTab(tab) {
  const body = p$("objectWorkspaceBody");
  const data = ps.workspace;
  if (!body || !data?.entity) return;
  const entity = data.entity;
  const relations = data.relations || [];
  const properties = entity.properties && typeof entity.properties === "object" ? entity.properties : {};
  const observed = entity.observed_at ? `${relativeAge(entity.observed_at)} · ${new Date(entity.observed_at).toLocaleString()}` : "Unknown";

  if (tab === "Overview") {
    const routeRelevant = relations.filter((relation) => relationMatches("Routes", relation.semantic_type));
    body.innerHTML = `<div class="object-overview-grid"><section class="object-overview-card"><span>Identity</span><strong>${pesc(entity.identity_state || "unknown")}</strong><small>${pesc(entity.identity_rule || "rule unavailable")}</small></section><section class="object-overview-card"><span>Evidence</span><strong>${Number(entity.evidence_count || 0).toLocaleString()} records</strong><small>${pesc((entity.evidence_classes || []).join(" · ") || "none")}</small></section><section class="object-overview-card"><span>Sources</span><strong>${Number(entity.source_count || 0).toLocaleString()}</strong><small>canonical source authorities</small></section><section class="object-overview-card"><span>Observed</span><strong>${pesc(relativeAge(entity.observed_at || ""))}</strong><small>${pesc(entity.observed_at ? new Date(entity.observed_at).toLocaleString() : "timestamp unavailable")}</small></section></div><div class="object-workspace-section"><div class="object-section-heading"><div><span>Semantic neighborhood</span><h3>Important relationships</h3></div><small>${relations.length}${relations.length >= 100 ? "+" : ""} shown</small></div>${renderRelationCards(relations.slice(0, 10), entity.entity_id, "No canonical relationships were returned for this entity.")}</div>${routeRelevant.length ? `<div class="object-workspace-callout"><strong>Route evidence available</strong><span>${routeRelevant.length} routing/cluster relationship${routeRelevant.length === 1 ? "" : "s"} are visible in the current evidence window.</span></div>` : ""}`;
  } else if (tab === "Configuration") {
    const entries = Object.entries(properties).sort(([a], [b]) => pnat.compare(a, b));
    body.innerHTML = `<div class="object-section-heading"><div><span>Configuration</span><h3>Canonical properties</h3></div><small>${entries.length} fields</small></div><dl class="object-property-grid">${entries.map(([key, value]) => `<div><dt>${pesc(key)}</dt><dd>${valueHtml(value)}</dd></div>`).join("") || `<div class="object-workspace-empty">No configuration properties are present.</div>`}</dl>`;
  } else if (tab === "Evidence") {
    body.innerHTML = `<div class="object-section-heading"><div><span>Explainability</span><h3>Why OSI believes this entity exists</h3></div></div><dl class="object-evidence-grid"><div><dt>Canonical entity ID</dt><dd>${pesc(entity.entity_id)}</dd></div><div><dt>Identity key</dt><dd>${pesc(entity.identity_key || "—")}</dd></div><div><dt>Identity rule</dt><dd>${pesc(entity.identity_rule || "—")}</dd></div><div><dt>Identity state</dt><dd>${pesc(entity.identity_state || "—")}</dd></div><div><dt>Evidence classes</dt><dd>${pesc((entity.evidence_classes || []).join(" · ") || "none")}</dd></div><div><dt>Observed</dt><dd>${pesc(observed)}</dd></div><div><dt>Source authorities</dt><dd>${(entity.source_ids || []).map((source) => `<span class="object-source-id">${pesc(source)}</span>`).join("") || "—"}</dd></div></dl>`;
  } else if (tab === "Activity") {
    const activity = relations.filter((relation) => relationMatches(tab, relation.semantic_type));
    body.innerHTML = `<div class="object-section-heading"><div><span>Runtime evidence</span><h3>Observed message activity</h3></div></div>${activity.length ? renderRelationCards(activity, entity.entity_id, "") : `<div class="object-workspace-empty"><strong>No PUT/GET activity claims are present.</strong><span>Runtime queue access is not promoted to message activity. OSI will show activity only when activity evidence exists.</span></div>`}`;
  } else {
    const filtered = relations.filter((relation) => relationMatches(tab, relation.semantic_type));
    body.innerHTML = `<div class="object-section-heading"><div><span>${pesc(tab)}</span><h3>${pesc(tab)} relationships</h3></div><small>${filtered.length}${relations.length >= 100 ? "+" : ""}</small></div>${renderRelationCards(filtered, entity.entity_id, `No ${tab.toLowerCase()} relationships are supported by the current canonical evidence.`)}`;
  }
  body.querySelectorAll("[data-workspace-neighbor]").forEach((button) => button.addEventListener("click", () => void openObjectWorkspace(button.dataset.workspaceNeighbor, true)));
}

async function openObjectWorkspace(entityId, pushHistory = true) {
  if (!entityId) return;
  const workspace = ensureObjectWorkspace();
  workspace.hidden = false;
  document.body.classList.add("object-workspace-open");
  p$("objectWorkspaceType").textContent = "Canonical entity";
  p$("objectWorkspaceName").textContent = "Loading…";
  p$("objectWorkspaceScope").textContent = "Loading operational context";
  p$("objectWorkspaceTabs").innerHTML = "";
  p$("objectWorkspaceBody").innerHTML = `<div class="object-workspace-empty">Loading canonical entity detail…</div>`;
  try {
    const data = await api(`/api/v2/estate/current/entities/${encodeURIComponent(entityId)}?relation_limit=100`);
    ps.workspace = data;
    const entity = data.entity;
    p$("objectWorkspaceType").textContent = typeLabel(entity.semantic_type);
    p$("objectWorkspaceName").textContent = entity.display_name || entity.identity_key;
    p$("objectWorkspaceScope").textContent = `${entity.identity_state || "unknown"} identity · ${Number(entity.source_count || 0)} source${Number(entity.source_count || 0) === 1 ? "" : "s"} · ${entity.observed_at ? relativeAge(entity.observed_at) : "age unknown"}`;
    const tabs = workspaceTabsFor(entity.semantic_type);
    p$("objectWorkspaceTabs").innerHTML = tabs.map((tab, index) => `<button type="button" class="${index === 0 ? "active" : ""}" data-workspace-tab="${pesc(tab)}">${pesc(tab)}</button>`).join("");
    p$("objectWorkspaceTabs").querySelectorAll("[data-workspace-tab]").forEach((button) => button.addEventListener("click", () => {
      p$("objectWorkspaceTabs").querySelectorAll("button").forEach((item) => item.classList.toggle("active", item === button));
      renderWorkspaceTab(button.dataset.workspaceTab);
    }));
    renderWorkspaceTab(tabs[0]);
    if (pushHistory) {
      const url = new URL(window.location.href);
      url.searchParams.set("entity", entity.entity_id);
      history.pushState({ ...history.state, entity: entity.entity_id }, "", url);
    }
  } catch (error) {
    ps.workspace = null;
    p$("objectWorkspaceName").textContent = "Unable to load entity";
    p$("objectWorkspaceBody").innerHTML = `<div class="object-workspace-empty error">${pesc(error instanceof Error ? error.message : String(error))}</div>`;
  }
}

function closeObjectWorkspace(updateHistory) {
  const workspace = p$("objectWorkspace");
  if (!workspace || workspace.hidden) return;
  workspace.hidden = true;
  document.body.classList.remove("object-workspace-open");
  ps.workspace = null;
  if (updateHistory) {
    const url = new URL(window.location.href);
    url.searchParams.delete("entity");
    history.pushState({ ...history.state, entity: null }, "", url);
  }
}

function findWorkspaceEntityInObjects() {
  const entity = ps.workspace?.entity;
  if (!entity) return;
  closeObjectWorkspace(false);
  const nav = document.querySelector('[data-view="inventory"]');
  nav?.click();
  setTimeout(() => {
    const type = p$("inventoryType");
    const search = p$("inventorySearch");
    const identity = p$("inventoryServer");
    if (identity) { identity.value = ""; identity.dispatchEvent(new Event("change", { bubbles: true })); }
    if (type && [...type.options].some((option) => option.value === entity.semantic_type)) {
      type.value = entity.semantic_type;
      type.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (search) {
      search.value = entity.display_name || "";
      search.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }, 160);
}

function installObjectWorkspaceLauncher() {
  const head = document.querySelector("#detailContent .detail-head");
  if (head && !p$("openObjectWorkspace")) {
    const button = document.createElement("button");
    button.id = "openObjectWorkspace";
    button.type = "button";
    button.className = "ghost detail-workspace-open";
    button.textContent = "Open workspace";
    const close = p$("closeDetail");
    close?.insertAdjacentElement("beforebegin", button);
    button.addEventListener("click", () => {
      const row = document.querySelector('#inventoryRows tr.selected, #inventoryRows tr[aria-selected="true"]');
      if (row?.dataset.estateEntityId) void openObjectWorkspace(row.dataset.estateEntityId, true);
    });
  }
  const rows = p$("inventoryRows");
  rows?.addEventListener("dblclick", (event) => {
    const row = event.target.closest("tr[data-estate-entity-id]");
    if (row) void openObjectWorkspace(row.dataset.estateEntityId, true);
  });
}

function restoreWorkspaceFromUrl() {
  const entityId = new URL(window.location.href).searchParams.get("entity");
  if (entityId) void openObjectWorkspace(entityId, false);
  else closeObjectWorkspace(false);
}

function initProductShell() {
  installStyles();
  installMissionNavigation();
  installQueueManagerView();
  installGlobalSearch();
  installObjectWorkspaceLauncher();
  window.addEventListener("popstate", restoreWorkspaceFromUrl);
  setTimeout(restoreWorkspaceFromUrl, 500);
}

window.osiRenderQueueManagers = renderQueueManagers;
window.osiOpenObjectWorkspace = openObjectWorkspace;
window.osiProductShellRefresh = () => {
  const nav = document.querySelector('[data-view="inventory"]');
  if (nav && nav.textContent.trim() !== "Objects") nav.textContent = "Objects";
  const jump = p$("jumpInventory");
  if (jump && jump.textContent.trim() !== "Browse objects") jump.textContent = "Browse objects";
};

initProductShell();
