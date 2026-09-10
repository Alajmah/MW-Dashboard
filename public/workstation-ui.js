const WORKSTATION_ASSET_REVISION = "20260910-1";
const COMPARE_STORAGE_KEY = "osi.compare.v1";
const LIVE_TRACE_STORAGE_KEY = "osi.routes.liveTrace.v1";
const MAX_COMPARE = 3;

const workstationState = {
  summary: null,
  estateId: "",
  compare: [],
  entityCache: new Map(),
  ageTimer: null,
  routeTimer: null,
  routeLastAutoKey: "",
};

const wq = (id) => document.getElementById(id);
const wesc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

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
  "mq.runtime_process": "Runtime process",
};

const CONTEXT_COLUMNS = {
  "mq.queue_manager": {
    owner: "Logical identity",
    server: "Physical placement",
    note: "Queue-manager identity is canonical; placement is evidence-backed and may remain unknown until its physical host is collected.",
  },
  "mq.queue_manager_instance": {
    owner: "Queue manager",
    server: "Observed host",
    note: "Queue-manager instances represent runtime placement, not a second logical queue manager.",
  },
  "mq.queue": {
    owner: "Queue manager",
    server: "QM placement",
    note: "Queues are scoped to their owning queue manager. Server placement is inherited only from confirmed queue-manager placement.",
  },
  "mq.channel": {
    owner: "Queue manager",
    server: "QM placement",
    note: "Channels remain owned by a logical queue manager; connection addresses are network endpoints, not physical hosts.",
  },
  "mq.listener": {
    owner: "Queue manager",
    server: "QM placement",
    note: "Listener placement follows its queue manager. Listening endpoints remain separate network identities.",
  },
  "mq.cluster": {
    owner: "Cluster scope",
    server: "Placement model",
    note: "MQ clusters are logical routing scopes and are not assigned a physical host by endpoint inference.",
  },
  "app.application": {
    owner: "Application scope",
    server: "Instance placement",
    note: "Logical applications do not have a physical placement; their application instances may carry observed host evidence.",
  },
  "app.application_instance": {
    owner: "Application",
    server: "Observed server",
    note: "Application-instance placement is shown only when directly supported by collected evidence.",
  },
  "infra.host": {
    owner: "Infrastructure role",
    server: "Physical host",
    note: "Only canonical infra.host identities are physical servers. Client addresses and MQ connection names remain network evidence.",
  },
  "infra.network_endpoint": {
    owner: "Network owner",
    server: "Network evidence",
    note: "Endpoints are connectivity evidence. OSI never promotes an endpoint or IP address into a physical host without host evidence.",
  },
};

const CURATED_COMPARE_FIELDS = {
  "mq.queue_manager": [
    ["QMID", ["QMID"]],
    ["Version", ["VERSION"]],
    ["Command level", ["CMDLEVEL"]],
    ["Platform", ["PLATFORM"]],
    ["Cluster", ["CLUSTER"]],
    ["Cluster role", ["CLUSTER_QM_TYPE"]],
    ["Cluster status", ["CLUSTER_STATUS"]],
    ["Cluster connection", ["CLUSTER_CONNAME", "CONNAME"]],
    ["Description", ["DESCRIPTION"]],
  ],
  "mq.queue": [
    ["Queue type", ["QUEUE_TYPE", "TYPE"]],
    ["Cluster", ["CLUSTER"]],
    ["Cluster owner", ["CLUSTER_OWNER"]],
    ["Cluster queue type", ["CLUSTER_QUEUE_TYPE"]],
    ["XMITQ", ["XMITQ"]],
    ["Remote queue manager", ["REMOTE_QUEUE_MANAGER", "RQMNAME"]],
    ["Remote queue", ["REMOTE_QUEUE", "RNAME"]],
    ["Reference only", ["REFERENCE_ONLY"]],
  ],
  "mq.channel": [
    ["Channel type", ["CHANNEL_TYPE", "CHLTYPE"]],
    ["Cluster", ["CLUSTER"]],
    ["Connection name", ["CONNAME"]],
    ["Remote queue manager", ["REMOTE_QUEUE_MANAGER"]],
    ["Remote QMID", ["REMOTE_QMID"]],
    ["Auto defined", ["AUTO_DEFINED"]],
    ["Runtime cluster record", ["RUNTIME_CLUSTER_RECORD"]],
  ],
  "mq.listener": [
    ["Control", ["CONTROL"]],
    ["Port", ["PORT"]],
    ["Queue manager", ["QUEUE_MANAGER"]],
    ["System listener", ["SYSTEM"]],
  ],
  "infra.host": [
    ["FQDN", ["FQDN"]],
    ["Primary IP", ["PRIMARY_IP"]],
    ["IP addresses", ["IPS"]],
    ["Collector host", ["COLLECTOR_HOST"]],
  ],
  "infra.network_endpoint": [
    ["Address", ["RAW", "HOST"]],
    ["Role", ["ROLE"]],
    ["Queue manager", ["QUEUE_MANAGER"]],
    ["Remote queue manager", ["REMOTE_QUEUE_MANAGER"]],
    ["Channel", ["CHANNEL"]],
  ],
  "app.application_instance": [
    ["Application", ["APPLICATION", "APPLICATION_NAME"]],
    ["Process", ["PROCESS", "PROCESS_NAME"]],
    ["Host", ["HOST", "HOSTNAME"]],
    ["Client address", ["CLIENT_ADDRESS", "CLIENT_IP", "IP"]],
  ],
};

function installWorkstationStyles() {
  if (document.querySelector('link[data-workstation-ui]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `/workstation-ui.css?v=${WORKSTATION_ASSET_REVISION}`;
  link.dataset.workstationUi = "true";
  document.head.appendChild(link);
}

async function workstationApi(path) {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) throw new Error(body.detail || `Request failed (${response.status})`);
  return body;
}

function currentView() {
  return document.querySelector(".nav-item.active")?.dataset.view || "overview";
}

function typeLabel(type) {
  return TYPE_LABELS[type] || String(type || "entity").replaceAll("_", " ").replaceAll(".", " · ");
}

function formatValue(value) {
  if (value == null || value === "") return "—";
  if (Array.isArray(value)) return value.join(", ") || "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function propertyValue(entity, aliases) {
  const properties = entity?.properties && typeof entity.properties === "object" ? entity.properties : {};
  const normalized = new Map(Object.entries(properties).map(([key, value]) => [key.toLowerCase(), value]));
  for (const alias of aliases) {
    const value = normalized.get(String(alias).toLowerCase());
    if (value != null && formatValue(value) !== "—") return formatValue(value);
  }
  return "—";
}

function relativeAge(value) {
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(time)) return "unknown age";
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ${hours % 24}h ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ${days % 30}d ago`;
}

function renderEstateAge() {
  const target = wq("snapshotAge");
  const activatedAt = workstationState.summary?.estate?.activated_at;
  if (!target || !activatedAt) return;
  const exact = new Date(activatedAt);
  if (!Number.isFinite(exact.getTime())) return;
  target.textContent = `Activated ${relativeAge(exact)}`;
  target.title = `Canonical estate activated ${exact.toLocaleString()}`;
  target.dataset.workstationTimestamp = activatedAt;
}

function decorateDetailAge() {
  const facts = wq("detailFacts");
  if (!facts) return;
  [...facts.querySelectorAll(".fact")].forEach((fact) => {
    const label = fact.querySelector("span")?.textContent?.trim().toLowerCase();
    const value = fact.querySelector("strong");
    if (label !== "observed at" || !value) return;
    let timestamp = value.dataset.workstationTimestamp || "";
    if (!timestamp) {
      const parsed = new Date(value.textContent || "");
      if (!Number.isFinite(parsed.getTime())) return;
      timestamp = parsed.toISOString();
      value.dataset.workstationTimestamp = timestamp;
      value.dataset.workstationExact = parsed.toLocaleString();
    }
    const parsed = new Date(timestamp);
    value.textContent = relativeAge(parsed);
    value.title = value.dataset.workstationExact || parsed.toLocaleString();
    value.classList.add("workstation-live-age");
    let exact = fact.querySelector(".workstation-age-exact");
    if (!exact) {
      exact = document.createElement("small");
      exact.className = "workstation-age-exact";
      fact.appendChild(exact);
    }
    exact.textContent = value.dataset.workstationExact || parsed.toLocaleString();
  });
}

function updateAges() {
  renderEstateAge();
  decorateDetailAge();
  document.querySelectorAll("[data-compare-observed-at]").forEach((node) => {
    node.textContent = relativeAge(node.dataset.compareObservedAt || "");
  });
}

function startAgeTicker() {
  updateAges();
  clearInterval(workstationState.ageTimer);
  workstationState.ageTimer = setInterval(updateAges, 30_000);
}

function updateContextColumns() {
  const select = wq("inventoryType");
  const table = wq("inventoryRows")?.closest("table");
  if (!select || !table) return;
  const headers = table.querySelectorAll("thead th");
  if (headers.length < 5) return;
  const context = CONTEXT_COLUMNS[select.value] || {
    owner: "Logical owner",
    server: "Current / observed server",
    note: "Canonical entities remain separate from physical placement and network endpoints; evidence determines what OSI can claim.",
  };
  headers[2].textContent = context.owner;
  headers[3].textContent = context.server;
  let note = wq("exploreColumnContext");
  const scopebar = wq("exploreScopebar");
  if (!note && scopebar) {
    note = document.createElement("div");
    note.id = "exploreColumnContext";
    note.className = "explore-column-context";
    scopebar.insertAdjacentElement("afterend", note);
  }
  if (note) note.textContent = context.note;
}

function rowSnapshot(row) {
  return {
    id: row?.dataset.estateEntityId || "",
    name: row?.children?.[1]?.querySelector("strong")?.textContent?.trim() || "Canonical entity",
    owner: row?.children?.[2]?.textContent?.replace(/\s+/g, " ").trim() || "—",
    server: row?.children?.[3]?.textContent?.replace(/\s+/g, " ").trim() || "—",
    evidence: row?.children?.[4]?.textContent?.replace(/\s+/g, " ").trim() || "—",
  };
}

async function loadEntityDetail(entityId) {
  if (!entityId) throw new Error("Canonical entity ID is missing");
  if (workstationState.entityCache.has(entityId)) return workstationState.entityCache.get(entityId);
  const data = await workstationApi(`/api/v2/estate/current/entities/${encodeURIComponent(entityId)}?relation_limit=1`);
  workstationState.entityCache.set(entityId, data.entity);
  return data.entity;
}

function compareSelection(entityId) {
  return workstationState.compare.find((item) => item.id === entityId) || null;
}

function persistCompare() {
  try {
    localStorage.setItem(COMPARE_STORAGE_KEY, JSON.stringify({
      estateId: workstationState.estateId,
      items: workstationState.compare.slice(0, MAX_COMPARE),
    }));
  } catch {}
}

function restoreCompare() {
  try {
    const parsed = JSON.parse(localStorage.getItem(COMPARE_STORAGE_KEY) || "null");
    if (!parsed || parsed.estateId !== workstationState.estateId || !Array.isArray(parsed.items)) {
      workstationState.compare = [];
      localStorage.removeItem(COMPARE_STORAGE_KEY);
      return;
    }
    const firstType = parsed.items[0]?.type || "";
    workstationState.compare = parsed.items
      .filter((item) => item?.id && item?.type && (!firstType || item.type === firstType))
      .slice(0, MAX_COMPARE);
  } catch {
    workstationState.compare = [];
  }
}

function showWorkstationToast(message, tone = "info") {
  let toast = wq("workstationToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "workstationToast";
    document.body.appendChild(toast);
  }
  toast.className = `workstation-toast ${tone}`;
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toast._workstationTimer);
  toast._workstationTimer = setTimeout(() => { toast.hidden = true; }, 2600);
}

async function addCompareEntity(entityId, snapshot = {}) {
  if (compareSelection(entityId)) return;
  if (workstationState.compare.length >= MAX_COMPARE) {
    showWorkstationToast(`Compare supports up to ${MAX_COMPARE} canonical entities.`, "warn");
    return;
  }
  const entity = await loadEntityDetail(entityId);
  const currentType = workstationState.compare[0]?.type || "";
  if (currentType && entity.semantic_type !== currentType) {
    showWorkstationToast(`Compare is scoped to one semantic type. Current selection is ${typeLabel(currentType)}.`, "warn");
    return;
  }
  workstationState.compare.push({
    id: entity.entity_id,
    name: entity.display_name || entity.identity_key || entity.entity_id,
    type: entity.semantic_type,
    owner: snapshot.owner || "—",
    server: snapshot.server || "—",
    evidence: snapshot.evidence || "—",
  });
  persistCompare();
  refreshCompareUI();
}

function removeCompareEntity(entityId) {
  workstationState.compare = workstationState.compare.filter((item) => item.id !== entityId);
  persistCompare();
  refreshCompareUI();
}

async function toggleCompareEntity(entityId, snapshot = {}) {
  if (compareSelection(entityId)) removeCompareEntity(entityId);
  else {
    try { await addCompareEntity(entityId, snapshot); }
    catch (error) { showWorkstationToast(error instanceof Error ? error.message : String(error), "error"); }
  }
}

function ensureCompareTray() {
  const panel = wq("inventoryRows")?.closest(".inventory-panel");
  if (!panel) return null;
  let tray = wq("workstationCompareTray");
  if (!tray) {
    tray = document.createElement("div");
    tray.id = "workstationCompareTray";
    tray.className = "workstation-compare-tray";
    const scopebar = wq("exploreScopebar");
    if (scopebar) scopebar.insertAdjacentElement("afterend", tray);
    else panel.querySelector(".section-heading")?.insertAdjacentElement("afterend", tray);
  }
  return tray;
}

function renderCompareTray() {
  const tray = ensureCompareTray();
  if (!tray) return;
  const items = workstationState.compare;
  tray.hidden = !items.length;
  if (!items.length) {
    tray.innerHTML = "";
    return;
  }
  tray.innerHTML = `<div class="workstation-compare-copy"><span>Compare</span><strong>${items.length} ${wesc(typeLabel(items[0].type))}${items.length === 1 ? "" : "s"} selected</strong></div><div class="workstation-compare-items">${items.map((item) => `<span class="workstation-compare-chip"><b>${wesc(item.name)}</b><button type="button" data-compare-remove="${wesc(item.id)}" aria-label="Remove ${wesc(item.name)} from compare">×</button></span>`).join("")}</div><div class="workstation-compare-actions"><button type="button" class="ghost" id="workstationCompareClear">Clear</button><button type="button" id="workstationCompareOpen" ${items.length < 2 ? "disabled" : ""}>Compare ${items.length}</button></div>`;
  tray.querySelectorAll("[data-compare-remove]").forEach((button) => button.addEventListener("click", () => removeCompareEntity(button.dataset.compareRemove)));
  wq("workstationCompareClear")?.addEventListener("click", () => {
    workstationState.compare = [];
    persistCompare();
    refreshCompareUI();
  });
  wq("workstationCompareOpen")?.addEventListener("click", () => openCompareModal());
}

function decorateCompareRows() {
  const rows = wq("inventoryRows");
  if (!rows) return;
  rows.querySelectorAll("tr[data-estate-entity-id]").forEach((row) => {
    const id = row.dataset.estateEntityId || "";
    const typeCell = row.children[0];
    if (!id || !typeCell) return;
    typeCell.classList.add("workstation-type-cell");
    let button = typeCell.querySelector("[data-compare-row]");
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "workstation-compare-toggle";
      button.dataset.compareRow = id;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void toggleCompareEntity(id, rowSnapshot(row));
      });
      typeCell.appendChild(button);
    }
    const selected = Boolean(compareSelection(id));
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
    button.setAttribute("aria-label", `${selected ? "Remove" : "Add"} ${rowSnapshot(row).name} ${selected ? "from" : "to"} compare`);
    button.title = selected ? "Remove from compare" : "Add to compare";
    button.textContent = selected ? "✓" : "+";
  });
}

function decorateDetailCompare() {
  const inspector = wq("exploreIdentityInspector");
  const actions = inspector?.querySelector(".explore-copy-actions");
  const copyId = actions?.querySelector("[data-copy-value]");
  if (!actions || !copyId) return;
  const id = copyId.dataset.copyValue || "";
  if (!id) return;
  let button = actions.querySelector("[data-compare-detail]");
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.className = "ghost";
    button.dataset.compareDetail = id;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const selectedRow = document.querySelector(`tr[data-estate-entity-id="${CSS.escape(id)}"]`);
      void toggleCompareEntity(id, rowSnapshot(selectedRow));
    });
    actions.prepend(button);
  }
  const selected = Boolean(compareSelection(id));
  button.textContent = selected ? "Remove compare" : "Add to compare";
  button.setAttribute("aria-pressed", String(selected));
}

function refreshCompareUI() {
  decorateCompareRows();
  decorateDetailCompare();
  renderCompareTray();
  const nav = document.querySelector('[data-view="inventory"]');
  if (nav) {
    let badge = nav.querySelector(".workstation-nav-compare");
    if (!badge && workstationState.compare.length) {
      badge = document.createElement("span");
      badge.className = "workstation-nav-compare";
      nav.appendChild(badge);
    }
    if (badge) {
      badge.textContent = String(workstationState.compare.length);
      badge.hidden = !workstationState.compare.length;
    }
  }
}

function ensureCompareModal() {
  let modal = wq("workstationCompareModal");
  if (modal) return modal;
  modal = document.createElement("div");
  modal.id = "workstationCompareModal";
  modal.className = "workstation-compare-modal";
  modal.hidden = true;
  modal.innerHTML = `<div class="workstation-compare-backdrop" data-compare-close></div><section class="workstation-compare-dialog" role="dialog" aria-modal="true" aria-labelledby="workstationCompareTitle"><header><div><span>Canonical comparison</span><h2 id="workstationCompareTitle">Compare entities</h2></div><div class="workstation-compare-dialog-actions"><label><input id="workstationCompareDiffOnly" type="checkbox" /> Differences only</label><button type="button" class="icon-button" data-compare-close aria-label="Close comparison">×</button></div></header><div id="workstationCompareBody" class="workstation-compare-body"></div></section>`;
  document.body.appendChild(modal);
  modal.querySelectorAll("[data-compare-close]").forEach((node) => node.addEventListener("click", closeCompareModal));
  wq("workstationCompareDiffOnly")?.addEventListener("change", (event) => modal.classList.toggle("differences-only", event.target.checked));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) closeCompareModal();
  });
  return modal;
}

function closeCompareModal() {
  const modal = wq("workstationCompareModal");
  if (!modal) return;
  modal.hidden = true;
  modal.classList.remove("differences-only");
  const diffOnly = wq("workstationCompareDiffOnly");
  if (diffOnly) diffOnly.checked = false;
  document.body.classList.remove("workstation-modal-open");
}

function comparisonRows(details) {
  const selections = workstationState.compare;
  const baseRows = [
    ["Entity type", details.map((entity) => typeLabel(entity.semantic_type))],
    ["Identity state", details.map((entity) => formatValue(entity.identity_state))],
    ["Identity rule", details.map((entity) => formatValue(entity.identity_rule))],
    ["Evidence", details.map((entity) => `${(entity.evidence_classes || []).join(" · ") || "none"} · ${Number(entity.evidence_count || 0).toLocaleString()} record${Number(entity.evidence_count || 0) === 1 ? "" : "s"}`)],
    ["Sources", details.map((entity) => `${Number(entity.source_count || 0).toLocaleString()} source${Number(entity.source_count || 0) === 1 ? "" : "s"}`)],
    ["Observed", details.map((entity) => entity.observed_at || "")],
    ["Logical owner", details.map((_, index) => selections[index]?.owner || "—")],
    ["Placement", details.map((_, index) => selections[index]?.server || "—")],
  ];
  const fields = CURATED_COMPARE_FIELDS[details[0]?.semantic_type] || [];
  const propertyRows = fields.map(([label, aliases]) => [label, details.map((entity) => propertyValue(entity, aliases))]);
  return [...baseRows, ...propertyRows].filter(([label, values]) => label === "Observed" || values.some((value) => value && value !== "—"));
}

function renderComparison(details) {
  const body = wq("workstationCompareBody");
  const title = wq("workstationCompareTitle");
  if (!body || !title) return;
  title.textContent = `Compare ${details.length} ${typeLabel(details[0]?.semantic_type)}${details.length === 1 ? "" : "s"}`;
  const names = details.map((entity) => entity.display_name || entity.identity_key || entity.entity_id);
  const rows = comparisonRows(details);
  body.innerHTML = `<div class="workstation-compare-grid" style="--compare-columns:${details.length}"><div class="workstation-compare-corner">Property</div>${names.map((name) => `<div class="workstation-compare-name">${wesc(name)}</div>`).join("")}${rows.map(([label, values]) => {
    const displayValues = label === "Observed" ? values.map((value) => value ? relativeAge(value) : "—") : values.map(formatValue);
    const different = new Set(displayValues.map((value) => String(value).toLowerCase())).size > 1;
    return `<div class="workstation-compare-row ${different ? "is-different" : "is-same"}" data-compare-row-kind="${different ? "different" : "same"}"><div class="workstation-compare-label">${wesc(label)}</div>${displayValues.map((value, index) => `<div class="workstation-compare-value"${label === "Observed" && values[index] ? ` data-compare-observed-at="${wesc(values[index])}" title="${wesc(new Date(values[index]).toLocaleString())}"` : ""}>${wesc(value)}</div>`).join("")}</div>`;
  }).join("")}</div>`;
}

async function openCompareModal() {
  if (workstationState.compare.length < 2) {
    showWorkstationToast("Select at least two canonical entities to compare.", "warn");
    return;
  }
  const modal = ensureCompareModal();
  const body = wq("workstationCompareBody");
  modal.hidden = false;
  document.body.classList.add("workstation-modal-open");
  body.innerHTML = `<div class="workstation-compare-loading">Loading canonical entity specifications…</div>`;
  try {
    const details = await Promise.all(workstationState.compare.map((item) => loadEntityDetail(item.id)));
    renderComparison(details);
    updateAges();
  } catch (error) {
    body.innerHTML = `<div class="workstation-compare-loading error">${wesc(error instanceof Error ? error.message : String(error))}</div>`;
  }
}

function routeSelection(side) {
  const input = wq(side === "from" ? "routeFrom" : "routeTo");
  const context = wq(side === "from" ? "routeFromContext" : "routeToContext");
  const value = input?.value.trim() || "";
  const qualifier = context?.textContent?.trim() || "";
  const pending = /^(choose|select an exact|searching|type at least|no visible)/i.test(qualifier);
  return {
    exact: Boolean(value && qualifier && !pending),
    value,
    qualifier,
  };
}

function routeEvidenceTokens(...selections) {
  const tokens = new Set();
  for (const selection of selections) {
    const text = selection.qualifier.toLowerCase();
    ["observed", "configured", "declared", "inferred"].forEach((token) => {
      if (text.includes(token)) tokens.add(token);
    });
  }
  return [...tokens];
}

function routeOutcome() {
  const result = wq("routeResult");
  if (!result) return { state: "idle", label: "Not evaluated" };
  if (result.classList.contains("route-result-shell")) {
    const semantic = result.querySelector(".route-health-card strong")?.textContent?.trim();
    return { state: "found", label: semantic || "Path evaluated" };
  }
  if (result.classList.contains("route-diagnostic")) return { state: "gap", label: "Evidence gap" };
  return { state: "idle", label: "Not evaluated" };
}

function ensureRouteLivePanel() {
  const form = wq("routeForm");
  if (!form) return null;
  let panel = wq("routeLiveInterpretation");
  if (panel) return panel;
  panel = document.createElement("section");
  panel.id = "routeLiveInterpretation";
  panel.className = "route-live-interpretation";
  panel.innerHTML = `<div class="route-live-head"><div><span>Live interpretation</span><strong id="routeLiveHeadline">Select canonical endpoints</strong></div><label class="route-live-toggle"><input id="routeLiveTraceToggle" type="checkbox" /> <span>Live trace</span></label></div><div class="route-live-grid"><div><span>Source</span><strong id="routeLiveSource">Not selected</strong><small id="routeLiveSourceMeta">Awaiting exact canonical entity</small></div><div><span>Destination</span><strong id="routeLiveDestination">Not selected</strong><small id="routeLiveDestinationMeta">Awaiting exact canonical entity</small></div><div><span>Selection evidence</span><strong id="routeLiveEvidence">Pending</strong><small>Selection evidence does not imply PUT/GET activity</small></div><div><span>Evaluation</span><strong id="routeLiveEvaluation">Not evaluated</strong><small id="routeLiveEvaluationMeta">Trace when both endpoints are exact</small></div></div><p>Live trace evaluates the current canonical evidence automatically; it does not create or infer PUT/GET activity evidence.</p>`;
  form.insertAdjacentElement("afterend", panel);
  const toggle = wq("routeLiveTraceToggle");
  try { toggle.checked = localStorage.getItem(LIVE_TRACE_STORAGE_KEY) === "1"; } catch {}
  toggle.addEventListener("change", () => {
    try { localStorage.setItem(LIVE_TRACE_STORAGE_KEY, toggle.checked ? "1" : "0"); } catch {}
    const outcome = routeOutcome();
    if (toggle.checked && outcome.state !== "idle") workstationState.routeLastAutoKey = currentRouteKey();
    else if (!toggle.checked) workstationState.routeLastAutoKey = "";
    renderRouteLiveInterpretation();
  });
  return panel;
}

function currentRouteKey() {
  const from = routeSelection("from");
  const to = routeSelection("to");
  if (!from.exact || !to.exact) return "";
  return `${from.value}\n${from.qualifier}\n→\n${to.value}\n${to.qualifier}`;
}

function maybeAutoTrace() {
  const toggle = wq("routeLiveTraceToggle");
  const key = currentRouteKey();
  clearTimeout(workstationState.routeTimer);
  if (!toggle?.checked || !key) {
    if (!key) workstationState.routeLastAutoKey = "";
    return;
  }
  if (key === workstationState.routeLastAutoKey) return;
  workstationState.routeTimer = setTimeout(() => {
    if (!toggle.checked || currentRouteKey() !== key) return;
    workstationState.routeLastAutoKey = key;
    wq("routeForm")?.querySelector(".route-submit")?.click();
  }, 320);
}

function renderRouteLiveInterpretation() {
  if (!ensureRouteLivePanel()) return;
  const from = routeSelection("from");
  const to = routeSelection("to");
  const evidence = routeEvidenceTokens(from, to);
  const outcome = routeOutcome();
  const live = Boolean(wq("routeLiveTraceToggle")?.checked);

  wq("routeLiveSource").textContent = from.exact ? from.value : "Not selected";
  wq("routeLiveSourceMeta").textContent = from.exact ? from.qualifier : "Awaiting exact canonical entity";
  wq("routeLiveDestination").textContent = to.exact ? to.value : "Not selected";
  wq("routeLiveDestinationMeta").textContent = to.exact ? to.qualifier : "Awaiting exact canonical entity";
  wq("routeLiveEvidence").textContent = evidence.length ? evidence.join(" · ") : "Pending";

  let headline = "Select canonical endpoints";
  let evaluation = outcome.label;
  let evaluationMeta = "Trace when both endpoints are exact";
  if (outcome.state === "found") {
    headline = "Canonical path evaluated";
    evaluationMeta = "Result reflects the current evidence set";
  } else if (outcome.state === "gap") {
    headline = "Current evidence cannot prove the full path";
    evaluationMeta = "This is an evidence gap, not proof of disconnection";
  } else if (from.exact && to.exact) {
    headline = live ? "Live evaluation armed" : "Ready to evaluate";
    evaluation = live ? "Auto trace" : "Ready to trace";
    evaluationMeta = live ? "Trace starts automatically after selection settles" : "Use Trace delivery or enable Live trace";
  } else if (from.exact) {
    headline = "Select a destination";
    evaluation = "Waiting";
  } else if (to.exact) {
    headline = "Select a source";
    evaluation = "Waiting";
  }
  wq("routeLiveHeadline").textContent = headline;
  wq("routeLiveEvaluation").textContent = evaluation;
  wq("routeLiveEvaluationMeta").textContent = evaluationMeta;
  maybeAutoTrace();
}

function bindRouteLiveInterpretation() {
  ensureRouteLivePanel();
  ["routeFromContext", "routeToContext", "routeResult", "routeTitle"].forEach((id) => {
    const node = wq(id);
    if (!node) return;
    const observer = new MutationObserver(() => queueMicrotask(renderRouteLiveInterpretation));
    observer.observe(node, { childList: true, subtree: false });
  });
  ["routeFrom", "routeTo"].forEach((id) => wq(id)?.addEventListener("input", () => renderRouteLiveInterpretation()));
  renderRouteLiveInterpretation();
}

function bindWorkstationObservers() {
  const rows = wq("inventoryRows");
  if (rows) {
    const observer = new MutationObserver(() => {
      decorateCompareRows();
      updateContextColumns();
    });
    observer.observe(rows, { childList: true, subtree: false });
  }
  const facts = wq("detailFacts");
  if (facts) {
    const observer = new MutationObserver(() => queueMicrotask(decorateDetailAge));
    observer.observe(facts, { childList: true, subtree: false });
  }
  const detailContent = wq("detailContent");
  if (detailContent) {
    const observer = new MutationObserver(() => queueMicrotask(() => {
      decorateDetailCompare();
      decorateDetailAge();
    }));
    observer.observe(detailContent, { childList: true, subtree: false });
  }
  const type = wq("inventoryType");
  if (type) {
    type.addEventListener("change", () => setTimeout(updateContextColumns, 0), true);
    const observer = new MutationObserver(() => queueMicrotask(updateContextColumns));
    observer.observe(type, { childList: true, subtree: false });
  }
  document.addEventListener("click", (event) => {
    const view = event.target.closest("[data-view], [data-go]")?.dataset.view || event.target.closest("[data-go]")?.dataset.go;
    if (view === "inventory") setTimeout(() => {
      updateContextColumns();
      refreshCompareUI();
    }, 80);
    if (view === "routes") setTimeout(renderRouteLiveInterpretation, 80);
  }, true);
}

async function initWorkstationUI() {
  installWorkstationStyles();
  try {
    workstationState.summary = await workstationApi("/api/v2/estate/current/summary");
    workstationState.estateId = String(workstationState.summary?.estate?.estate_revision_id || "");
  } catch {
    return;
  }
  restoreCompare();
  startAgeTicker();
  bindWorkstationObservers();
  updateContextColumns();
  refreshCompareUI();
  bindRouteLiveInterpretation();
}

window.osiOpenCompare = openCompareModal;
window.osiRefreshWorkstationUI = refreshCompareUI;
void initWorkstationUI();
