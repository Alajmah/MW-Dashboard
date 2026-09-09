const estateState = {
  summary: null,
  context: null,
  query: "",
  semanticType: "",
  identityState: "",
  limit: 50,
  offset: 0,
  selectedId: null,
  loading: false,
};

const eq = (id) => document.getElementById(id);
const eesc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const enatural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const MQ_OWNED_TYPES = new Set([
  "mq.queue", "mq.channel", "mq.listener", "mq.topic", "mq.subscription",
  "mq.process_definition", "mq.runtime_process", "mq.namelist", "mq.service",
  "mq.connection", "mq.object_handle",
]);

async function estateApi(path) {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(body.detail || `Request failed (${response.status})`);
    error.code = body.code;
    throw error;
  }
  return body;
}

function shortId(value) {
  const text = String(value || "");
  return text.length > 20 ? `${text.slice(0, 10)}…${text.slice(-7)}` : text || "—";
}

function typeLabel(type) {
  const labels = {
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
    "mq.runtime_process": "Runtime process",
  };
  return labels[type] || String(type || "object").replaceAll("_", " ").replaceAll(".", " · ");
}

function identityField(identityKey, field) {
  const match = String(identityKey || "").match(new RegExp(`(?:^|\\|)${field}=([^|]+)`, "i"));
  return match ? match[1] : "";
}

async function fetchEntityType(semanticType) {
  return estateApi(`/api/v2/estate/current/entities?semantic_type=${encodeURIComponent(semanticType)}&limit=100&offset=0`);
}

async function fetchRelationType(semanticType) {
  return estateApi(`/api/v2/estate/current/relations?semantic_type=${encodeURIComponent(semanticType)}&limit=100&offset=0`);
}

async function loadPlacementContext() {
  const [qmgrData, instanceData, hostData, hasInstanceData, runsOnData] = await Promise.all([
    fetchEntityType("mq.queue_manager"),
    fetchEntityType("mq.queue_manager_instance"),
    fetchEntityType("infra.host"),
    fetchRelationType("has_instance"),
    fetchRelationType("runs_on"),
  ]);
  const qmgrs = qmgrData.entities || [];
  const instances = instanceData.entities || [];
  const hosts = hostData.entities || [];
  const byId = new Map([...qmgrs, ...instances, ...hosts].map((item) => [item.entity_id, item]));
  const qmgrByName = new Map(qmgrs.filter((item) => item.display_name).map((item) => [String(item.display_name).toLowerCase(), item]));
  const hostByName = new Map(hosts.filter((item) => item.display_name).map((item) => [String(item.display_name).toLowerCase(), item]));
  const instanceIds = new Set(instances.map((item) => item.entity_id));
  const hostIds = new Set(hosts.map((item) => item.entity_id));
  const qmgrIds = new Set(qmgrs.map((item) => item.entity_id));
  const instancesByQmgr = new Map();
  for (const relation of hasInstanceData.relations || []) {
    if (!qmgrIds.has(relation.source_entity_id) || !instanceIds.has(relation.target_entity_id)) continue;
    if (!instancesByQmgr.has(relation.source_entity_id)) instancesByQmgr.set(relation.source_entity_id, []);
    instancesByQmgr.get(relation.source_entity_id).push(relation.target_entity_id);
  }
  const hostByInstance = new Map();
  for (const relation of runsOnData.relations || []) {
    if (!instanceIds.has(relation.source_entity_id) || !hostIds.has(relation.target_entity_id)) continue;
    hostByInstance.set(relation.source_entity_id, relation.target_entity_id);
  }
  const hostsByQmgr = new Map();
  for (const qmgr of qmgrs) {
    const values = (instancesByQmgr.get(qmgr.entity_id) || [])
      .map((instanceId) => byId.get(hostByInstance.get(instanceId)))
      .filter(Boolean);
    hostsByQmgr.set(qmgr.entity_id, values);
  }
  return { qmgrs, instances, hosts, byId, qmgrByName, hostByName, instancesByQmgr, hostByInstance, hostsByQmgr };
}

function ownerFor(entity) {
  if (!entity) return null;
  const context = estateState.context;
  if (!context) return null;
  if (entity.semantic_type === "mq.queue_manager") return entity;
  if (entity.semantic_type === "mq.queue_manager_instance" || MQ_OWNED_TYPES.has(entity.semantic_type)) {
    const key = identityField(entity.identity_key, "queue_manager_key");
    return key ? context.qmgrByName.get(key.toLowerCase()) || null : null;
  }
  return null;
}

function serversFor(entity) {
  if (!entity || !estateState.context) return [];
  const context = estateState.context;
  if (entity.semantic_type === "infra.host") return [entity];
  if (entity.semantic_type === "mq.queue_manager_instance") {
    const host = context.byId.get(context.hostByInstance.get(entity.entity_id));
    return host ? [host] : [];
  }
  const owner = ownerFor(entity);
  if (owner) return context.hostsByQmgr.get(owner.entity_id) || [];
  if (entity.semantic_type === "app.application_instance") {
    const hostKey = identityField(entity.identity_key, "host_key");
    if (hostKey) {
      const host = context.hostByName.get(hostKey.toLowerCase());
      return host ? [host] : [];
    }
  }
  return [];
}

function evidenceHtml(entity) {
  const evidence = Array.isArray(entity.evidence_classes) ? entity.evidence_classes : [];
  return `<div class="estate-evidence">${evidence.map((item) => `<span>${eesc(item)}</span>`).join("") || "<span>none</span>"}</div>`;
}

function renderCanonicalBanner() {
  const section = eq("view-overview");
  if (!section || !estateState.summary) return;
  let banner = eq("canonicalEstateBanner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "canonicalEstateBanner";
    banner.className = "estate-banner";
    section.prepend(banner);
  }
  const estate = estateState.summary.estate || {};
  const sourceCount = Array.isArray(estate.source_revision_ids) ? estate.source_revision_ids.length : 0;
  banner.innerHTML = `<div><strong>Canonical semantic estate</strong><span> · ${sourceCount} active source${sourceCount === 1 ? "" : "s"} reconciled into stable logical identities</span></div><div class="estate-live">Current · ${eesc(shortId(estate.estate_revision_id))}</div>`;
}

function renderCanonicalOverview() {
  const summary = estateState.summary;
  const context = estateState.context;
  if (!summary || !context) return;
  renderCanonicalBanner();
  const byType = summary.entities_by_type || {};
  const counts = summary.counts || {};
  const stats = [
    ["Canonical entities", counts.entities || 0, "deduplicated logical identities"],
    ["Relationships", counts.relations || 0, "semantic, evidence-backed"],
    ["Active sources", summary.estate?.source_revision_ids?.length || 0, "current collector revisions"],
    ["Queue managers", byType["mq.queue_manager"] || 0, "logical queue managers"],
    ["Physical hosts", byType["infra.host"] || 0, "collected host identities"],
    ["Unresolved", counts.unresolved || 0, "explicit ambiguity / missing evidence"],
  ];
  eq("overviewStats").innerHTML = stats.map(([label, value, note]) => `<article class="stat"><span>${eesc(label)}</span><strong>${Number(value).toLocaleString()}</strong><small>${eesc(note)}</small></article>`).join("");

  eq("overviewHosts").innerHTML = context.hosts.length ? context.hosts.map((host) => {
    const qmgrs = context.qmgrs.filter((qmgr) => (context.hostsByQmgr.get(qmgr.entity_id) || []).some((item) => item.entity_id === host.entity_id));
    return `<article class="summary-card"><div class="card-head"><div><h3>${eesc(host.display_name || "Unnamed host")}</h3><p>Physical infrastructure identity</p></div><span class="pill local">observed</span></div><div class="metric-row"><div class="mini-metric"><span>Queue managers</span><strong>${qmgrs.length}</strong></div><div class="mini-metric"><span>Evidence</span><strong>${host.evidence_count || 0}</strong></div><div class="mini-metric"><span>Sources</span><strong>${host.source_count || 0}</strong></div></div><div class="identity"><div>Hosted queue managers: <strong>${eesc(qmgrs.map((item) => item.display_name).join(", ") || "None")}</strong></div><div>Identity: <strong>${eesc(host.identity_state || "resolved")}</strong></div></div><div class="estate-card-meta"><span class="estate-chip good">physical host</span>${(host.evidence_classes || []).map((item) => `<span class="estate-chip">${eesc(item)}</span>`).join("")}</div></article>`;
  }).join("") : `<div class="route-empty">No physical host evidence is present in the current canonical estate.</div>`;

  const qmgrs = [...context.qmgrs].sort((a, b) => enatural.compare(a.display_name || "", b.display_name || ""));
  eq("overviewQmgrs").innerHTML = qmgrs.map((qmgr) => {
    const hosts = context.hostsByQmgr.get(qmgr.entity_id) || [];
    const placement = hosts.length ? hosts.map((item) => item.display_name).join(", ") : "Unknown / not collected";
    return `<article class="summary-card"><div class="card-head"><div><h3>${eesc(qmgr.display_name || qmgr.identity_key)}</h3><p>Canonical IBM MQ queue manager</p></div><span class="pill ${hosts.length ? "local" : "remote"}">${hosts.length ? "placement confirmed" : "placement gap"}</span></div><div class="identity"><div>Current / observed server: <strong>${eesc(placement)}</strong></div><div>Canonical rule: <strong>${eesc(qmgr.identity_rule)}</strong></div><div>Evidence records: <strong>${qmgr.evidence_count || 0}</strong></div></div><div class="estate-card-meta"><span class="estate-chip ${qmgr.identity_state === "resolved" ? "good" : "warn"}">${eesc(qmgr.identity_state)}</span>${(qmgr.evidence_classes || []).map((item) => `<span class="estate-chip">${eesc(item)}</span>`).join("")}</div></article>`;
  }).join("");

  const states = summary.identity_states || {};
  eq("evidenceSummary").innerHTML = `<div class="estate-identity-grid"><div class="estate-identity-card"><span>Resolved identities</span><strong>${Number(states.resolved || 0).toLocaleString()}</strong><small>Stable canonical key</small></div><div class="estate-identity-card"><span>Ambiguous identities</span><strong>${Number(states.ambiguous || 0).toLocaleString()}</strong><small>Needs stronger evidence</small></div><div class="estate-identity-card"><span>Conflicted identities</span><strong>${Number(states.conflicted || 0).toLocaleString()}</strong><small>Conflicting strong identifiers</small></div></div>`;

  const unknownQmgrs = qmgrs.filter((qmgr) => !(context.hostsByQmgr.get(qmgr.entity_id) || []).length);
  const unresolvedStates = summary.unresolved_by_state || {};
  eq("placementGaps").innerHTML = `<div class="gap-row"><span>Logical QMs without physical placement</span><strong>${unknownQmgrs.length}</strong></div>${Object.entries(unresolvedStates).map(([state, count]) => `<div class="gap-row"><span>${eesc(state)} references</span><strong>${Number(count).toLocaleString()}</strong></div>`).join("")}<div class="gap-row"><span>Next evidence action</span><strong>${unknownQmgrs.length ? "Collect peer MQ hosts" : "Review unresolved routes"}</strong></div>${unknownQmgrs.slice(0, 5).map((qmgr) => `<div class="gap-row"><span>${eesc(qmgr.display_name)}</span><span class="pill remote">host unknown</span></div>`).join("")}`;
}

function configureExploreControls() {
  const search = eq("inventorySearch");
  const type = eq("inventoryType");
  const identity = eq("inventoryServer");
  const pageSize = eq("inventoryOwner");
  if (!search || !type || !identity || !pageSize) return;
  const toolbar = search.closest(".inventory-toolbar");
  toolbar?.classList.add("estate-toolbar");
  search.placeholder = "Name or canonical identity…";
  const typeLabelEl = type.closest("label")?.querySelector("span");
  const identityLabelEl = identity.closest("label")?.querySelector("span");
  const sizeLabelEl = pageSize.closest("label")?.querySelector("span");
  if (typeLabelEl) typeLabelEl.textContent = "Semantic type";
  if (identityLabelEl) identityLabelEl.textContent = "Identity";
  if (sizeLabelEl) sizeLabelEl.textContent = "Page size";
  const types = Object.keys(estateState.summary?.entities_by_type || {}).sort(enatural.compare);
  type.innerHTML = `<option value="">All semantic types</option>${types.map((value) => `<option value="${eesc(value)}">${eesc(typeLabel(value))} (${Number(estateState.summary.entities_by_type[value]).toLocaleString()})</option>`).join("")}`;
  identity.innerHTML = `<option value="">All identity states</option><option value="resolved">Resolved</option><option value="ambiguous">Ambiguous</option><option value="conflicted">Conflicted</option>`;
  pageSize.innerHTML = `<option value="25">25 rows</option><option value="50" selected>50 rows</option><option value="100">100 rows</option>`;
  const headers = eq("inventoryRows")?.closest("table")?.querySelector("thead tr");
  if (headers) headers.innerHTML = `<th>Type</th><th>Name</th><th>Logical owner</th><th>Current / observed server</th><th>Evidence</th>`;
  const heading = eq("inventoryCount")?.closest(".section-heading")?.querySelector("h2");
  if (heading) heading.textContent = "Canonical entities";
}

function rowContext(entity) {
  const owner = ownerFor(entity);
  const servers = serversFor(entity);
  return {
    owner: owner?.display_name || (entity.semantic_type === "infra.host" ? "Physical infrastructure" : entity.semantic_type.startsWith("mq.") ? "MQ semantic object" : "—"),
    servers,
  };
}

async function renderExplorePage() {
  const rows = eq("inventoryRows");
  if (!rows || estateState.loading) return;
  estateState.loading = true;
  rows.innerHTML = `<tr><td colspan="5"><div class="estate-detail-loading">Loading canonical entities…</div></td></tr>`;
  try {
    const params = new URLSearchParams({ limit: String(estateState.limit), offset: String(estateState.offset) });
    if (estateState.query) params.set("q", estateState.query);
    if (estateState.semanticType) params.set("semantic_type", estateState.semanticType);
    if (estateState.identityState) params.set("identity_state", estateState.identityState);
    const data = await estateApi(`/api/v2/estate/current/entities?${params}`);
    const entities = data.entities || [];
    const page = data.page || {};
    eq("inventoryCount").textContent = `${Number(page.total || 0).toLocaleString()} canonical entities`;
    rows.innerHTML = entities.map((entity) => {
      const context = rowContext(entity);
      const server = context.servers.length ? context.servers.map((item) => item.display_name).join(", ") : "Unknown / not collected";
      return `<tr data-estate-entity-id="${eesc(entity.entity_id)}" class="${estateState.selectedId === entity.entity_id ? "selected" : ""}"><td><span class="pill">${eesc(typeLabel(entity.semantic_type))}</span></td><td><strong>${eesc(entity.display_name || entity.identity_key)}</strong><div class="estate-row-state ${eesc(entity.identity_state)}">${eesc(entity.identity_state)}</div></td><td><div class="estate-owner"><span>${eesc(context.owner)}</span><small>${eesc(entity.identity_rule)}</small></div></td><td><span class="${context.servers.length ? "estate-server-known" : "estate-server-unknown"}">${eesc(server)}</span></td><td>${evidenceHtml(entity)}<small>${Number(entity.evidence_count || 0).toLocaleString()} evidence · ${Number(entity.source_count || 0).toLocaleString()} source${Number(entity.source_count || 0) === 1 ? "" : "s"}</small></td></tr>`;
    }).join("") || `<tr><td colspan="5"><div class="route-empty">No canonical entities match these filters.</div></td></tr>`;
    rows.querySelectorAll("tr[data-estate-entity-id]").forEach((row) => row.addEventListener("click", () => openEstateDetail(row.dataset.estateEntityId)));
    renderPagination(page);
  } catch (error) {
    rows.innerHTML = `<tr><td colspan="5"><div class="route-empty">${eesc(error.message)}</div></td></tr>`;
  } finally {
    estateState.loading = false;
  }
}

function renderPagination(page) {
  const panel = eq("inventoryRows")?.closest(".inventory-panel");
  if (!panel) return;
  let controls = eq("estatePagination");
  if (!controls) {
    controls = document.createElement("div");
    controls.id = "estatePagination";
    controls.className = "estate-table-status";
    panel.appendChild(controls);
  }
  const total = Number(page.total || 0);
  const from = total ? Number(page.offset || 0) + 1 : 0;
  const to = Math.min(total, Number(page.offset || 0) + Number(page.limit || estateState.limit));
  controls.innerHTML = `<span>Showing <strong>${from.toLocaleString()}–${to.toLocaleString()}</strong> of <strong>${total.toLocaleString()}</strong></span><div class="estate-table-actions"><button class="ghost" id="estatePrev" type="button" ${estateState.offset <= 0 ? "disabled" : ""}>Previous</button><button class="ghost" id="estateNext" type="button" ${page.next_offset == null ? "disabled" : ""}>Next</button></div>`;
  eq("estatePrev")?.addEventListener("click", () => { estateState.offset = Math.max(0, estateState.offset - estateState.limit); renderExplorePage(); });
  eq("estateNext")?.addEventListener("click", () => { if (page.next_offset != null) { estateState.offset = Number(page.next_offset); renderExplorePage(); } });
}

async function openEstateDetail(entityId) {
  estateState.selectedId = entityId;
  eq("detailEmpty").hidden = true;
  eq("detailContent").hidden = false;
  eq("detailType").textContent = "semantic entity";
  eq("detailName").textContent = "Loading…";
  eq("detailScope").textContent = "Canonical estate";
  eq("detailFacts").innerHTML = `<div class="estate-detail-loading">Loading canonical identity, placement and evidence…</div>`;
  eq("detailRelationships").innerHTML = "";
  eq("detailMetadata").innerHTML = "";
  try {
    const data = await estateApi(`/api/v2/estate/current/entities/${encodeURIComponent(entityId)}?relation_limit=100`);
    const entity = data.entity;
    const context = rowContext(entity);
    const servers = context.servers.length ? context.servers.map((item) => item.display_name).join(", ") : "Unknown / not collected";
    eq("detailType").textContent = typeLabel(entity.semantic_type);
    eq("detailName").textContent = entity.display_name || entity.identity_key;
    eq("detailScope").textContent = `${entity.identity_state} identity · ${entity.source_count || 0} source${entity.source_count === 1 ? "" : "s"}`;
    const facts = [
      ["Logical owner", context.owner],
      ["Current / observed server", servers],
      ["Identity rule", entity.identity_rule],
      ["Identity state", entity.identity_state],
      ["Evidence records", entity.evidence_count || 0],
      ["Observed at", entity.observed_at ? new Date(entity.observed_at).toLocaleString() : "—"],
    ];
    eq("detailFacts").innerHTML = facts.map(([key, value]) => `<div class="fact"><span>${eesc(key)}</span><strong>${eesc(value)}</strong></div>`).join("");
    const relations = data.relations || [];
    eq("detailRelationships").innerHTML = relations.map((relation) => {
      const outgoing = relation.source_entity_id === entity.entity_id;
      const neighborName = relation.neighbor_display_name || relation.neighbor_entity_id || (outgoing ? relation.target_entity_id : relation.source_entity_id);
      const neighborType = relation.neighbor_semantic_type || "entity";
      return `<div class="relationship-item estate-rel-neighbor"><div><b>${outgoing ? "→" : "←"} ${eesc(relation.semantic_type)}</b><span>${eesc(neighborName)} · ${eesc(typeLabel(neighborType))}</span></div><small>${(relation.evidence_classes || []).map(eesc).join(" · ") || "evidence"}</small></div>`;
    }).join("") || `<div class="relationship-item"><span>No canonical relationships.</span></div>`;
    const propertyRows = Object.entries(entity.properties || {}).sort(([a], [b]) => enatural.compare(a, b));
    const sources = Array.isArray(entity.source_ids) ? entity.source_ids : [];
    eq("detailMetadata").innerHTML = `${propertyRows.map(([key, value]) => `<div><dt>${eesc(key)}</dt><dd>${eesc(Array.isArray(value) ? value.join(", ") : typeof value === "object" ? JSON.stringify(value) : value)}</dd></div>`).join("")}<div><dt>Provenance</dt><dd><div class="estate-provenance">${sources.map((source) => `<div class="estate-provenance-row"><strong>Source revision authority</strong><span>${eesc(source)}</span></div>`).join("") || "No source IDs"}</div></dd></div>`;
    renderExplorePage();
  } catch (error) {
    eq("detailName").textContent = "Unable to load entity";
    eq("detailFacts").innerHTML = `<div class="estate-detail-loading">${eesc(error.message)}</div>`;
  }
}

function bindExploreControls() {
  let timer;
  eq("inventorySearch")?.addEventListener("input", (event) => {
    clearTimeout(timer);
    timer = setTimeout(() => { estateState.query = event.target.value.trim(); estateState.offset = 0; renderExplorePage(); }, 180);
  }, true);
  eq("inventoryType")?.addEventListener("change", (event) => { estateState.semanticType = event.target.value; estateState.offset = 0; renderExplorePage(); }, true);
  eq("inventoryServer")?.addEventListener("change", (event) => { estateState.identityState = event.target.value; estateState.offset = 0; renderExplorePage(); }, true);
  eq("inventoryOwner")?.addEventListener("change", (event) => { estateState.limit = Number(event.target.value) || 50; estateState.offset = 0; renderExplorePage(); }, true);
  eq("inventoryReset")?.addEventListener("click", () => {
    estateState.query = ""; estateState.semanticType = ""; estateState.identityState = ""; estateState.limit = 50; estateState.offset = 0;
    eq("inventorySearch").value = ""; eq("inventoryType").value = ""; eq("inventoryServer").value = ""; eq("inventoryOwner").value = "50";
    renderExplorePage();
  }, true);
  eq("closeDetail")?.addEventListener("click", () => { estateState.selectedId = null; eq("detailEmpty").hidden = false; eq("detailContent").hidden = true; renderExplorePage(); }, true);
  document.addEventListener("click", (event) => {
    const view = event.target.closest("[data-view]")?.dataset.view || event.target.closest("[data-go]")?.dataset.go;
    if (view === "overview") renderCanonicalOverview();
    if (view === "inventory") renderExplorePage();
  });
}

async function initEstateUI() {
  try {
    const [summary, context] = await Promise.all([
      estateApi("/api/v2/estate/current/summary"),
      loadPlacementContext(),
    ]);
    estateState.summary = summary;
    estateState.context = context;
    const estateId = summary.estate?.estate_revision_id;
    if (eq("snapshotBadge")) eq("snapshotBadge").textContent = `Estate ${shortId(estateId)}`;
    if (eq("sidebarSnapshot")) eq("sidebarSnapshot").textContent = `${summary.estate?.source_revision_ids?.length || 0} semantic source(s)`;
    if (eq("snapshotAge")) eq("snapshotAge").textContent = summary.estate?.activated_at ? new Date(summary.estate.activated_at).toLocaleString() : "";
    const inventoryNav = document.querySelector('[data-view="inventory"]');
    if (inventoryNav) inventoryNav.textContent = "Explore";
    if (eq("jumpInventory")) eq("jumpInventory").textContent = "Explore estate";
    configureExploreControls();
    bindExploreControls();
    renderCanonicalOverview();
    await renderExplorePage();
  } catch (error) {
    const message = eq("globalMessage");
    if (message) {
      message.hidden = false;
      message.className = "global-message error";
      message.textContent = error.code === "ESTATE_STALE" || error.code === "ESTATE_PENDING"
        ? `${error.message}. Reconcile the current source set in the evidence importer before using canonical views.`
        : `Canonical estate unavailable: ${error.message}`;
    }
  }
}

initEstateUI();
