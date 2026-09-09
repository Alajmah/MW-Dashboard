const canonicalOpsState = {
  summary: null,
  context: null,
  serverQuery: "",
  loading: null,
};

const coq = (id) => document.getElementById(id);
const coesc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const conatural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function ensureCanonicalOpsStyles() {
  if (document.getElementById("canonicalOpsCss")) return;
  const link = document.createElement("link");
  link.id = "canonicalOpsCss";
  link.rel = "stylesheet";
  link.href = "/canonical-ops.css";
  document.head.appendChild(link);
}

async function canonicalOpsApi(path) {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(body.detail || `Canonical estate request failed (${response.status})`);
    error.code = body.code;
    throw error;
  }
  return body;
}

async function fetchCanonicalType(semanticType) {
  return canonicalOpsApi(`/api/v2/estate/current/entities?semantic_type=${encodeURIComponent(semanticType)}&limit=100&offset=0`);
}

async function fetchCanonicalRelation(semanticType) {
  return canonicalOpsApi(`/api/v2/estate/current/relations?semantic_type=${encodeURIComponent(semanticType)}&limit=100&offset=0`);
}

function shortCanonicalId(value) {
  const text = String(value || "");
  if (!text) return "—";
  return text.length > 20 ? `${text.slice(0, 10)}…${text.slice(-7)}` : text;
}

function setTextIfChanged(element, value) {
  if (element && element.textContent !== value) element.textContent = value;
}

function propertyValue(entity, keys) {
  const props = entity?.properties || {};
  for (const key of keys) {
    const value = props[key];
    if (Array.isArray(value) && value.length) return value.join(", ");
    if (value !== undefined && value !== null && String(value).trim()) return String(value);
  }
  return "";
}

async function loadCanonicalOpsContext() {
  if (canonicalOpsState.context && canonicalOpsState.summary) return canonicalOpsState.context;
  if (canonicalOpsState.loading) return canonicalOpsState.loading;
  canonicalOpsState.loading = Promise.all([
    canonicalOpsApi("/api/v2/estate/current/summary"),
    fetchCanonicalType("mq.queue_manager"),
    fetchCanonicalType("mq.queue_manager_instance"),
    fetchCanonicalType("infra.host"),
    fetchCanonicalRelation("has_instance"),
    fetchCanonicalRelation("runs_on"),
  ]).then(([summary, qmgrData, instanceData, hostData, hasInstanceData, runsOnData]) => {
    const qmgrs = qmgrData.entities || [];
    const instances = instanceData.entities || [];
    const hosts = hostData.entities || [];
    const byId = new Map([...qmgrs, ...instances, ...hosts].map((entity) => [entity.entity_id, entity]));
    const qmgrIds = new Set(qmgrs.map((entity) => entity.entity_id));
    const instanceIds = new Set(instances.map((entity) => entity.entity_id));
    const hostIds = new Set(hosts.map((entity) => entity.entity_id));
    const instancesByQmgr = new Map();
    const hostByInstance = new Map();

    for (const relation of hasInstanceData.relations || []) {
      if (!qmgrIds.has(relation.source_entity_id) || !instanceIds.has(relation.target_entity_id)) continue;
      if (!instancesByQmgr.has(relation.source_entity_id)) instancesByQmgr.set(relation.source_entity_id, []);
      instancesByQmgr.get(relation.source_entity_id).push(relation.target_entity_id);
    }
    for (const relation of runsOnData.relations || []) {
      if (!instanceIds.has(relation.source_entity_id) || !hostIds.has(relation.target_entity_id)) continue;
      hostByInstance.set(relation.source_entity_id, relation.target_entity_id);
    }

    const hostsByQmgr = new Map();
    for (const qmgr of qmgrs) {
      const placed = (instancesByQmgr.get(qmgr.entity_id) || [])
        .map((instanceId) => byId.get(hostByInstance.get(instanceId)))
        .filter(Boolean);
      hostsByQmgr.set(qmgr.entity_id, placed);
    }

    canonicalOpsState.summary = summary;
    canonicalOpsState.context = { qmgrs, instances, hosts, byId, instancesByQmgr, hostByInstance, hostsByQmgr };
    return canonicalOpsState.context;
  }).finally(() => {
    canonicalOpsState.loading = null;
  });
  return canonicalOpsState.loading;
}

function applyCanonicalShell() {
  const summary = canonicalOpsState.summary;
  if (!summary) return;
  const estate = summary.estate || {};
  const sourceCount = Array.isArray(estate.source_revision_ids) ? estate.source_revision_ids.length : 0;
  const entityCount = Number(summary.counts?.entities || 0);
  const estateLabel = `Estate ${shortCanonicalId(estate.estate_revision_id)}`;
  setTextIfChanged(coq("snapshotBadge"), estateLabel);
  setTextIfChanged(coq("sidebarSnapshot"), `${sourceCount} source${sourceCount === 1 ? "" : "s"} · ${entityCount.toLocaleString()} entities`);
  const activated = estate.activated_at ? new Date(estate.activated_at) : null;
  setTextIfChanged(coq("snapshotAge"), activated && !Number.isNaN(activated.getTime()) ? activated.toLocaleString() : "");
  if (coq("snapshotBadge")) coq("snapshotBadge").title = estate.estate_revision_id || "Current canonical estate";
}

function renderEstateStatusLine() {
  const banner = coq("canonicalEstateBanner");
  const summary = canonicalOpsState.summary;
  if (!banner || !summary) return;
  const estate = summary.estate || {};
  const sourceCount = Array.isArray(estate.source_revision_ids) ? estate.source_revision_ids.length : 0;
  const conflicts = Number(summary.identity_states?.conflicted || 0);
  banner.innerHTML = `<div><strong>Source set current</strong><span> · ${sourceCount} collector revision${sourceCount === 1 ? "" : "s"} · ${conflicts} identity conflict${conflicts === 1 ? "" : "s"}</span></div><div class="estate-live">● ${coesc(shortCanonicalId(estate.estate_revision_id))}</div>`;
}

function qmgrEvidence(qmgr) {
  const classes = Array.isArray(qmgr.evidence_classes) ? qmgr.evidence_classes : [];
  return classes.length ? classes.join(" + ") : "no evidence class";
}

async function renderQmgrLedger() {
  const container = coq("overviewQmgrs");
  if (!container) return;
  const context = await loadCanonicalOpsContext();
  const qmgrs = [...context.qmgrs].sort((a, b) => {
    const aPlaced = (context.hostsByQmgr.get(a.entity_id) || []).length ? 0 : 1;
    const bPlaced = (context.hostsByQmgr.get(b.entity_id) || []).length ? 0 : 1;
    return aPlaced - bPlaced || conatural.compare(a.display_name || "", b.display_name || "");
  });
  const placedCount = qmgrs.filter((qmgr) => (context.hostsByQmgr.get(qmgr.entity_id) || []).length).length;
  const gapCount = qmgrs.length - placedCount;
  container.classList.add("qmgr-ledger-host");
  container.innerHTML = `<div class="qmgr-ledger">
    <div class="qmgr-ledger-summary"><span><strong>${placedCount}</strong> placement confirmed</span><span><strong>${gapCount}</strong> placement gap${gapCount === 1 ? "" : "s"}</span><span><strong>${qmgrs.length}</strong> logical queue managers</span></div>
    <div class="qmgr-ledger-head" aria-hidden="true"><span>Queue manager</span><span>Current / observed server</span><span>Identity</span><span>Evidence</span><span>Placement</span></div>
    <div class="qmgr-ledger-body">${qmgrs.map((qmgr) => {
      const hosts = context.hostsByQmgr.get(qmgr.entity_id) || [];
      const placement = hosts.length ? hosts.map((host) => host.display_name).join(", ") : "Not collected";
      const identity = `${qmgr.identity_state || "resolved"} · ${qmgr.identity_rule || "registry"}`;
      return `<div class="qmgr-ledger-row ${hosts.length ? "placed" : "gap"}">
        <strong>${coesc(qmgr.display_name || qmgr.identity_key)}</strong>
        <span class="machine-value ${hosts.length ? "known" : "unknown"}">${coesc(placement)}</span>
        <span class="identity-cell">${qmgr.identity_state === "conflicted" ? "△" : "●"} ${coesc(identity)}</span>
        <span class="evidence-cell"><b>${Number(qmgr.evidence_count || 0).toLocaleString()}</b> · ${coesc(qmgrEvidence(qmgr))}</span>
        <span class="placement-state ${hosts.length ? "confirmed" : "missing"}">${hosts.length ? "● confirmed" : "△ gap"}</span>
      </div>`;
    }).join("")}</div>
  </div>`;
  renderEstateStatusLine();
  applyCanonicalShell();
}

function hostSearchText(host, qmgrs) {
  return [host.display_name, host.identity_key, JSON.stringify(host.properties || {}), ...qmgrs.map((qmgr) => qmgr.display_name)].join(" ").toLowerCase();
}

function physicalHostCard(host, qmgrs) {
  const fqdn = propertyValue(host, ["fqdn", "fully_qualified_domain_name", "dns_name"]);
  const ip = propertyValue(host, ["ip", "ip_address", "ipv4", "ip_addresses", "addresses"]);
  const os = propertyValue(host, ["os", "operating_system", "platform", "os_release"]);
  const subtitle = [fqdn, ip].filter(Boolean).join(" · ") || "Direct collector host identity";
  return `<article class="physical-server-card">
    <div class="physical-server-head"><div><p class="server-kicker">Physical host</p><h2>${coesc(host.display_name || host.identity_key)}</h2><p>${coesc(subtitle)}</p></div><span class="placement-state confirmed">● collected</span></div>
    <div class="server-spec-strip">
      <div><span>Queue managers</span><strong>${qmgrs.length}</strong></div>
      <div><span>Sources</span><strong>${Number(host.source_count || 0).toLocaleString()}</strong></div>
      <div><span>Evidence</span><strong>${Number(host.evidence_count || 0).toLocaleString()}</strong></div>
      <div><span>Identity</span><strong>${coesc(host.identity_state || "resolved")}</strong></div>
    </div>
    <div class="server-detail-grid">
      <div><span>Canonical identity rule</span><strong>${coesc(host.identity_rule || "registry")}</strong></div>
      <div><span>Operating system</span><strong>${coesc(os || "Not exposed in canonical host projection")}</strong></div>
    </div>
    <div class="placed-qmgr-block"><div class="placed-qmgr-title"><span>Logical middleware placed here</span><strong>${qmgrs.length}</strong></div><div class="placed-qmgr-list">${qmgrs.length ? qmgrs.sort((a, b) => conatural.compare(a.display_name || "", b.display_name || "")).map((qmgr) => `<span>${coesc(qmgr.display_name)}</span>`).join("") : `<em>No queue-manager placement is currently attached to this host.</em>`}</div></div>
  </article>`;
}

async function renderCanonicalServers() {
  const grid = coq("serversGrid");
  const count = coq("serverCount");
  if (!grid) return;
  const context = await loadCanonicalOpsContext();
  const query = canonicalOpsState.serverQuery.trim().toLowerCase();
  const records = context.hosts.map((host) => ({
    host,
    qmgrs: context.qmgrs.filter((qmgr) => (context.hostsByQmgr.get(qmgr.entity_id) || []).some((candidate) => candidate.entity_id === host.entity_id)),
  })).filter(({ host, qmgrs }) => !query || hostSearchText(host, qmgrs).includes(query));
  const endpointCount = Number(canonicalOpsState.summary?.entities_by_type?.["infra.network_endpoint"] || 0);
  const appInstanceCount = Number(canonicalOpsState.summary?.entities_by_type?.["app.application_instance"] || 0);
  if (count) count.textContent = `${records.length} physical server${records.length === 1 ? "" : "s"}`;
  grid.classList.add("canonical-server-grid");
  grid.innerHTML = `<div class="canonical-server-view">
    <div class="physical-server-list">${records.length ? records.map(({ host, qmgrs }) => physicalHostCard(host, qmgrs)).join("") : `<div class="canonical-empty">No physical host matches this search.</div>`}</div>
    <aside class="server-boundary-card"><p class="server-kicker">Semantic boundary</p><h3>Client IPs are not physical servers</h3><p>Observed client addresses and network endpoints remain application/network evidence. OSI does not promote an endpoint into an <code>infra.host</code> without host evidence.</p><div class="boundary-counts"><span><strong>${endpointCount}</strong> network endpoints tracked separately</span><span><strong>${appInstanceCount}</strong> application instances tracked separately</span></div><small>Use Applications or Explore when investigating client-side evidence.</small></aside>
  </div>`;
  applyCanonicalShell();
}

function installCanonicalObservers() {
  const shellNodes = [coq("snapshotBadge"), coq("sidebarSnapshot"), coq("snapshotAge")].filter(Boolean);
  if (shellNodes.length) {
    const shellObserver = new MutationObserver(() => requestAnimationFrame(applyCanonicalShell));
    shellNodes.forEach((node) => shellObserver.observe(node, { childList: true, subtree: true, characterData: true }));
  }
  const qmgrContainer = coq("overviewQmgrs");
  if (qmgrContainer) {
    const qmgrObserver = new MutationObserver(() => {
      if (coq("view-overview")?.classList.contains("active") && !qmgrContainer.querySelector(".qmgr-ledger")) requestAnimationFrame(renderQmgrLedger);
    });
    qmgrObserver.observe(qmgrContainer, { childList: true });
  }
  const serverGrid = coq("serversGrid");
  if (serverGrid) {
    const serverObserver = new MutationObserver(() => {
      if (coq("view-servers")?.classList.contains("active") && !serverGrid.querySelector(".canonical-server-view")) requestAnimationFrame(renderCanonicalServers);
    });
    serverObserver.observe(serverGrid, { childList: true });
  }
}

function bindCanonicalServerSearch() {
  const input = coq("serverSearch");
  if (!input || input.dataset.canonicalBound === "true") return;
  input.dataset.canonicalBound = "true";
  input.placeholder = "Physical hostname, FQDN, IP, queue manager…";
  input.addEventListener("input", (event) => {
    event.stopImmediatePropagation();
    canonicalOpsState.serverQuery = event.target.value;
    renderCanonicalServers();
  }, true);
}

async function initCanonicalOps() {
  ensureCanonicalOpsStyles();
  try {
    await loadCanonicalOpsContext();
    applyCanonicalShell();
    bindCanonicalServerSearch();
    installCanonicalObservers();
    await renderQmgrLedger();
    if (coq("view-servers")?.classList.contains("active")) await renderCanonicalServers();
    document.addEventListener("click", (event) => {
      const view = event.target.closest("[data-view]")?.dataset.view || event.target.closest("[data-go]")?.dataset.go;
      if (!view) return;
      setTimeout(() => {
        applyCanonicalShell();
        if (view === "overview") renderQmgrLedger();
        if (view === "servers") renderCanonicalServers();
      }, 0);
    });
  } catch (error) {
    console.error("Canonical operational UI failed to initialize", error);
  }
}

window.osiApplyCanonicalShell = applyCanonicalShell;
window.osiRenderCanonicalServers = renderCanonicalServers;
window.osiRenderQmgrLedger = renderQmgrLedger;

initCanonicalOps();
