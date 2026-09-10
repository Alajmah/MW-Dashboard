const EXPLORE_ASSET_REVISION = "20260910-2";

const exploreInvestigationState = {
  summary: null,
  currentDetailId: null,
  detailController: null,
  detailSequence: 0,
  restoringHistory: false,
  urlTimer: null,
  pendingScrollResets: 0,
  pivotSequence: 0,
  neighborCache: new Map(),
};

const xq = (id) => document.getElementById(id);
const xesc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TYPE_LABELS = {
  "infra.host": "Hosts",
  "infra.network_endpoint": "Endpoints",
  "app.application": "Applications",
  "app.application_instance": "App instances",
  "mq.queue_manager": "Queue managers",
  "mq.queue_manager_instance": "QM instances",
  "mq.queue": "Queues",
  "mq.channel": "Channels",
  "mq.listener": "Listeners",
  "mq.cluster": "Clusters",
  "mq.topic": "Topics",
  "mq.runtime_process": "Runtime processes",
};

const QUICK_SCOPES = [
  ["", "All"],
  ["mq.queue_manager", "Queue managers"],
  ["mq.queue", "Queues"],
  ["mq.channel", "Channels"],
  ["app.application_instance", "App instances"],
  ["infra.host", "Hosts"],
  ["infra.network_endpoint", "Endpoints"],
];

function installExploreStyles() {
  if (document.querySelector('link[data-explore-investigation]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `/explore-investigation.css?v=${EXPLORE_ASSET_REVISION}`;
  link.dataset.exploreInvestigation = "true";
  document.head.appendChild(link);
}

async function exploreApi(path, { signal } = {}) {
  const response = await fetch(path, { headers: { accept: "application/json" }, signal });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) throw new Error(body.detail || `Request failed (${response.status})`);
  return body;
}

function typeLabel(type) {
  if (TYPE_LABELS[type]) return TYPE_LABELS[type].replace(/s$/, "");
  return String(type || "entity").replaceAll("_", " ").replaceAll(".", " · ");
}

async function waitForExploreReady(timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const type = xq("inventoryType");
    const size = xq("inventoryOwner");
    if (type?.options?.length > 1 && size?.options?.length > 1 && xq("inventoryRows")) return true;
    await sleep(80);
  }
  return false;
}

function currentView() {
  return document.querySelector(".nav-item.active")?.dataset.view || "overview";
}

function requestTableScrollReset(cycles = 3) {
  exploreInvestigationState.pendingScrollResets = Math.max(exploreInvestigationState.pendingScrollResets, cycles);
}

function resetTableScrollIfRequested() {
  if (exploreInvestigationState.pendingScrollResets <= 0) return;
  const wrap = xq("inventoryRows")?.closest(".table-wrap");
  if (wrap) wrap.scrollTop = 0;
  exploreInvestigationState.pendingScrollResets -= 1;
}

function cleanExploreParams(url) {
  ["q", "type", "identity", "size"].forEach((key) => url.searchParams.delete(key));
}

function syncExploreUrl({ replace = true } = {}) {
  if (exploreInvestigationState.restoringHistory || currentView() !== "inventory") return;
  const url = new URL(window.location.href);
  url.searchParams.set("view", "inventory");
  const query = xq("inventorySearch")?.value.trim() || "";
  const type = xq("inventoryType")?.value || "";
  const identity = xq("inventoryServer")?.value || "";
  const size = xq("inventoryOwner")?.value || "50";
  if (query) url.searchParams.set("q", query); else url.searchParams.delete("q");
  if (type) url.searchParams.set("type", type); else url.searchParams.delete("type");
  if (identity) url.searchParams.set("identity", identity); else url.searchParams.delete("identity");
  if (size !== "50") url.searchParams.set("size", size); else url.searchParams.delete("size");
  const next = `${url.pathname}${url.search}${url.hash}`;
  if (next === `${location.pathname}${location.search}${location.hash}`) return;
  if (replace) history.replaceState({}, "", next); else history.pushState({}, "", next);
}

function pushViewUrl(view) {
  if (exploreInvestigationState.restoringHistory) return;
  const url = new URL(window.location.href);
  url.searchParams.set("view", view);
  if (view === "inventory") {
    const query = xq("inventorySearch")?.value.trim() || "";
    const type = xq("inventoryType")?.value || "";
    const identity = xq("inventoryServer")?.value || "";
    const size = xq("inventoryOwner")?.value || "50";
    if (query) url.searchParams.set("q", query); else url.searchParams.delete("q");
    if (type) url.searchParams.set("type", type); else url.searchParams.delete("type");
    if (identity) url.searchParams.set("identity", identity); else url.searchParams.delete("identity");
    if (size !== "50") url.searchParams.set("size", size); else url.searchParams.delete("size");
  } else {
    cleanExploreParams(url);
  }
  const next = `${url.pathname}${url.search}${url.hash}`;
  if (next !== `${location.pathname}${location.search}${location.hash}`) history.pushState({}, "", next);
}

function scheduleUrlSync() {
  clearTimeout(exploreInvestigationState.urlTimer);
  exploreInvestigationState.urlTimer = setTimeout(() => syncExploreUrl(), 220);
}

function updateScopeState() {
  const activeType = xq("inventoryType")?.value || "";
  document.querySelectorAll("[data-explore-scope]").forEach((button) => {
    const active = button.dataset.exploreScope === activeType;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const summary = xq("exploreFilterSummary");
  if (!summary) return;
  const pieces = [];
  const query = xq("inventorySearch")?.value.trim();
  const identity = xq("inventoryServer")?.value;
  if (query) pieces.push(`query “${query}”`);
  if (activeType) pieces.push(TYPE_LABELS[activeType] || typeLabel(activeType));
  if (identity) pieces.push(`${identity} identity`);
  summary.textContent = pieces.length ? pieces.join(" · ") : "All canonical entities";
}

function installScopeBar(summary) {
  const panel = xq("inventoryRows")?.closest(".inventory-panel");
  const tableWrap = panel?.querySelector(".table-wrap");
  if (!panel || !tableWrap || xq("exploreScopebar")) return;
  const counts = summary?.entities_by_type || {};
  const total = Number(summary?.counts?.entities || 0);
  const bar = document.createElement("div");
  bar.id = "exploreScopebar";
  bar.className = "explore-scopebar";
  bar.setAttribute("aria-label", "Quick semantic scopes");
  bar.innerHTML = `<div class="explore-scope-buttons" role="group" aria-label="Entity scope">${QUICK_SCOPES
    .filter(([type]) => !type || Number(counts[type] || 0) > 0)
    .map(([type, label]) => {
      const count = type ? Number(counts[type] || 0) : total;
      return `<button type="button" class="explore-scope" data-explore-scope="${xesc(type)}" aria-pressed="false"><span>${xesc(label)}</span><strong>${count.toLocaleString()}</strong></button>`;
    }).join("")}</div><div id="exploreFilterSummary" class="explore-filter-summary">All canonical entities</div>`;
  panel.insertBefore(bar, tableWrap);
  bar.addEventListener("click", (event) => {
    const button = event.target.closest("[data-explore-scope]");
    if (!button) return;
    const select = xq("inventoryType");
    if (!select) return;
    requestTableScrollReset();
    select.value = button.dataset.exploreScope || "";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    updateScopeState();
    scheduleUrlSync();
  });
  updateScopeState();
}

function decorateRows() {
  const rows = xq("inventoryRows");
  if (!rows) return;
  rows.querySelectorAll("tr[data-estate-entity-id]").forEach((row) => {
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-selected", String(row.classList.contains("selected")));
    const name = row.children[1]?.querySelector("strong")?.textContent?.trim() || "entity";
    row.setAttribute("aria-label", `Inspect ${name}`);
    row.title = `Inspect ${name}`;

    const ownerRule = row.children[2]?.querySelector(".estate-owner small");
    ownerRule?.remove();

    const type = row.children[0]?.textContent?.trim() || "";
    const serverValue = row.children[3]?.querySelector("span");
    if (serverValue && type === "Application") {
      serverValue.textContent = "Instance-level placement";
      serverValue.className = "estate-server-neutral";
    } else if (serverValue && type === "Network endpoint") {
      serverValue.textContent = "Network evidence — not a host";
      serverValue.className = "estate-server-neutral";
    } else if (serverValue && type === "Cluster") {
      serverValue.textContent = "Logical cluster scope";
      serverValue.className = "estate-server-neutral";
    }
  });
  resetTableScrollIfRequested();
}

function setDetailLayout() {
  const layout = document.querySelector(".inventory-layout");
  const detail = xq("detailContent");
  if (!layout || !detail) return;
  layout.classList.toggle("explore-detail-open", !detail.hidden);
}

function relationNeighbor(relation, entity) {
  const outgoing = relation.source_entity_id === entity.entity_id;
  return {
    outgoing,
    id: relation.neighbor_entity_id || (outgoing ? relation.target_entity_id : relation.source_entity_id),
    name: relation.neighbor_display_name || relation.neighbor_identity_key || relation.neighbor_entity_id || (outgoing ? relation.target_entity_id : relation.source_entity_id),
    type: relation.neighbor_semantic_type || "entity",
  };
}

async function loadNeighborEntity(entityId, signal) {
  if (!entityId) return null;
  if (exploreInvestigationState.neighborCache.has(entityId)) return exploreInvestigationState.neighborCache.get(entityId);
  const data = await exploreApi(`/api/v2/estate/current/entities/${encodeURIComponent(entityId)}?relation_limit=1`, { signal });
  const entity = data.entity || null;
  if (entity) exploreInvestigationState.neighborCache.set(entityId, entity);
  return entity;
}

async function enrichRelations(entity, relations, signal) {
  const unresolvedIds = [];
  for (const relation of relations || []) {
    const neighbor = relationNeighbor(relation, entity);
    const visible = relation.neighbor_display_name || relation.neighbor_identity_key;
    if (!visible && neighbor.id && !exploreInvestigationState.neighborCache.has(neighbor.id)) unresolvedIds.push(neighbor.id);
  }
  const unique = [...new Set(unresolvedIds)].slice(0, 12);
  await Promise.allSettled(unique.map((id) => loadNeighborEntity(id, signal)));
  return (relations || []).map((relation) => {
    const neighbor = relationNeighbor(relation, entity);
    const cached = exploreInvestigationState.neighborCache.get(neighbor.id);
    return {
      ...relation,
      neighbor_entity_id: neighbor.id,
      neighbor_display_name: relation.neighbor_display_name || cached?.display_name || cached?.identity_key || neighbor.name,
      neighbor_semantic_type: relation.neighbor_semantic_type || cached?.semantic_type || neighbor.type,
      neighbor_identity_key: relation.neighbor_identity_key || cached?.identity_key || "",
    };
  });
}

function renderIdentityInspector(entity) {
  const facts = xq("detailFacts");
  if (!facts) return;
  let block = xq("exploreIdentityInspector");
  if (!block) {
    block = document.createElement("section");
    block.id = "exploreIdentityInspector";
    block.className = "explore-identity-inspector";
    facts.insertAdjacentElement("afterend", block);
  }
  const evidence = Array.isArray(entity.evidence_classes) ? entity.evidence_classes : [];
  const sources = Array.isArray(entity.source_ids) ? entity.source_ids : [];
  block.innerHTML = `<div class="explore-inspector-head"><div><span>Canonical identity</span><strong>Why this is one entity</strong></div><div class="explore-copy-actions"><button type="button" class="ghost" data-copy-value="${xesc(entity.entity_id)}">Copy ID</button><button type="button" class="ghost" data-copy-value="${xesc(entity.identity_key || "")}">Copy identity key</button></div></div><dl class="explore-identity-grid"><div><dt>Identity key</dt><dd>${xesc(entity.identity_key || "—")}</dd></div><div><dt>Rule</dt><dd>${xesc(entity.identity_rule || "—")}</dd></div><div><dt>Evidence</dt><dd>${xesc(evidence.join(" · ") || "none")} · ${Number(entity.evidence_count || 0).toLocaleString()} record${Number(entity.evidence_count || 0) === 1 ? "" : "s"}</dd></div><div><dt>Provenance</dt><dd>${sources.length ? sources.map((source) => xesc(source)).join("<br>") : `${Number(entity.source_count || 0).toLocaleString()} source authority`}</dd></div></dl>`;
}

function renderInvestigableRelationships(entity, relations) {
  const target = xq("detailRelationships");
  if (!target) return;
  const items = (relations || []).map((relation) => ({ relation, neighbor: relationNeighbor(relation, entity) }));
  items.sort((a, b) => {
    if (a.neighbor.outgoing !== b.neighbor.outgoing) return a.neighbor.outgoing ? -1 : 1;
    return String(a.relation.semantic_type || "").localeCompare(String(b.relation.semantic_type || "")) || String(a.neighbor.name || "").localeCompare(String(b.neighbor.name || ""));
  });
  const outgoing = items.filter((item) => item.neighbor.outgoing).length;
  const incoming = items.length - outgoing;
  target.innerHTML = items.length ? `<div class="explore-relation-summary"><span><strong>${outgoing}</strong> outgoing</span><span><strong>${incoming}</strong> incoming</span><span><strong>${items.length}</strong> total</span></div><div class="explore-relation-list">${items.map(({ relation, neighbor }) => {
    const evidence = Array.isArray(relation.evidence_classes) ? relation.evidence_classes.join(" · ") : "evidence";
    return `<button type="button" class="explore-relation-link" data-neighbor-id="${xesc(neighbor.id)}" data-neighbor-name="${xesc(neighbor.name)}" data-neighbor-type="${xesc(neighbor.type)}"><span class="explore-rel-direction">${neighbor.outgoing ? "→" : "←"}</span><span class="explore-rel-copy"><b>${xesc(relation.semantic_type)}</b><strong>${xesc(neighbor.name)}</strong><small>${xesc(typeLabel(neighbor.type))} · ${xesc(evidence)}</small></span><span class="explore-rel-action">Inspect</span></button>`;
  }).join("")}</div>` : `<div class="relationship-item"><span>No canonical relationships.</span></div>`;
}

function installMetadataToggle() {
  const metadata = xq("detailMetadata");
  const section = metadata?.closest(".detail-section");
  if (!metadata || !section) return;
  let button = xq("exploreMetadataToggle");
  if (!button) {
    button = document.createElement("button");
    button.id = "exploreMetadataToggle";
    button.type = "button";
    button.className = "explore-metadata-toggle ghost";
    button.addEventListener("click", () => {
      metadata.hidden = !metadata.hidden;
      button.setAttribute("aria-expanded", String(!metadata.hidden));
      button.textContent = metadata.hidden ? "Show raw properties & provenance" : "Hide raw properties & provenance";
    });
    section.insertBefore(button, metadata);
  }
  metadata.hidden = true;
  button.setAttribute("aria-expanded", "false");
  button.textContent = "Show raw properties & provenance";
}

async function enhanceCurrentDetail() {
  const id = exploreInvestigationState.currentDetailId;
  if (!id || xq("detailContent")?.hidden || xq("detailName")?.textContent === "Loading…") return;
  const sequence = ++exploreInvestigationState.detailSequence;
  exploreInvestigationState.detailController?.abort();
  const controller = new AbortController();
  exploreInvestigationState.detailController = controller;
  try {
    const data = await exploreApi(`/api/v2/estate/current/entities/${encodeURIComponent(id)}?relation_limit=100`, { signal: controller.signal });
    if (sequence !== exploreInvestigationState.detailSequence || id !== exploreInvestigationState.currentDetailId) return;
    const relations = await enrichRelations(data.entity, data.relations || [], controller.signal);
    if (sequence !== exploreInvestigationState.detailSequence || id !== exploreInvestigationState.currentDetailId) return;
    renderIdentityInspector(data.entity);
    renderInvestigableRelationships(data.entity, relations);
    installMetadataToggle();
  } catch (error) {
    if (error?.name !== "AbortError") console.warn("Explore detail enhancement failed", error);
  } finally {
    if (exploreInvestigationState.detailController === controller) exploreInvestigationState.detailController = null;
  }
}

async function waitForEntityRow(entityId, timeoutMs = 3500) {
  if (!entityId) return null;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const row = document.querySelector(`tr[data-estate-entity-id="${CSS.escape(entityId)}"]`);
    if (row) return row;
    await sleep(80);
  }
  return null;
}

async function inspectNeighbor(entityId, fallbackName, fallbackType) {
  const sequence = ++exploreInvestigationState.pivotSequence;
  const search = xq("inventorySearch");
  const typeSelect = xq("inventoryType");
  const identity = xq("inventoryServer");
  if (!search || !typeSelect || !identity) return;

  let target = exploreInvestigationState.neighborCache.get(entityId) || null;
  if (!target && entityId) {
    try { target = await loadNeighborEntity(entityId); } catch {}
  }
  if (sequence !== exploreInvestigationState.pivotSequence) return;

  const name = target?.display_name || target?.identity_key || fallbackName || entityId;
  const type = target?.semantic_type || fallbackType || "";
  if (!name) return;

  requestTableScrollReset(4);
  search.value = name;
  identity.value = "";
  typeSelect.value = [...typeSelect.options].some((option) => option.value === type) ? type : "";
  typeSelect.dispatchEvent(new Event("change", { bubbles: true }));
  identity.dispatchEvent(new Event("change", { bubbles: true }));
  search.dispatchEvent(new Event("input", { bubbles: true }));
  updateScopeState();
  scheduleUrlSync();

  let row = await waitForEntityRow(entityId);
  if (!row && target?.identity_key && target.identity_key !== name) {
    search.value = target.identity_key;
    requestTableScrollReset(3);
    search.dispatchEvent(new Event("input", { bubbles: true }));
    scheduleUrlSync();
    row = await waitForEntityRow(entityId);
  }
  if (sequence !== exploreInvestigationState.pivotSequence) return;
  if (row) {
    row.click();
    row.scrollIntoView({ block: "center" });
  } else {
    search.focus();
  }
}

function bindInvestigationInteractions() {
  const rows = xq("inventoryRows");
  if (rows) {
    const observer = new MutationObserver(() => decorateRows());
    observer.observe(rows, { childList: true, subtree: false });
    decorateRows();
    rows.addEventListener("click", (event) => {
      const row = event.target.closest("tr[data-estate-entity-id]");
      if (row) exploreInvestigationState.currentDetailId = row.dataset.estateEntityId;
    }, true);
    rows.addEventListener("keydown", (event) => {
      const row = event.target.closest("tr[data-estate-entity-id]");
      if (!row || !["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      row.click();
    });
  }

  const detailContent = xq("detailContent");
  if (detailContent) {
    const observer = new MutationObserver(() => setDetailLayout());
    observer.observe(detailContent, { attributes: true, attributeFilter: ["hidden"] });
    setDetailLayout();
  }

  const detailName = xq("detailName");
  if (detailName) {
    const observer = new MutationObserver(() => {
      if (detailName.textContent && detailName.textContent !== "Loading…") setTimeout(enhanceCurrentDetail, 0);
    });
    observer.observe(detailName, { childList: true, subtree: false });
  }

  xq("closeDetail")?.addEventListener("click", () => {
    exploreInvestigationState.currentDetailId = null;
    exploreInvestigationState.detailSequence += 1;
    exploreInvestigationState.detailController?.abort();
    setTimeout(setDetailLayout, 0);
  });

  document.addEventListener("click", async (event) => {
    const copy = event.target.closest("[data-copy-value]");
    if (copy) {
      const value = copy.dataset.copyValue || "";
      try {
        await navigator.clipboard.writeText(value);
        const previous = copy.textContent;
        copy.textContent = "Copied";
        setTimeout(() => { copy.textContent = previous; }, 1200);
      } catch {}
      return;
    }
    const relation = event.target.closest("[data-neighbor-id]");
    if (relation) {
      inspectNeighbor(
        relation.dataset.neighborId || "",
        relation.dataset.neighborName || "",
        relation.dataset.neighborType || "",
      );
    }
  });

  document.addEventListener("click", (event) => {
    if (event.target.closest("#estatePrev, #estateNext")) requestTableScrollReset(3);
  }, true);
}

function shieldCanonicalInventoryControls() {
  const controls = [
    ["inventorySearch", "input", true],
    ["inventoryType", "change", true],
    ["inventoryServer", "change", true],
    ["inventoryOwner", "change", true],
    ["inventoryReset", "click", true],
    ["closeDetail", "click", false],
  ];
  controls.forEach(([id, eventName, resetsTable]) => {
    const control = xq(id);
    if (!control) return;
    control.addEventListener(eventName, (event) => {
      if (currentView() !== "inventory") return;
      if (resetsTable) requestTableScrollReset();
      if (id !== "closeDetail") {
        updateScopeState();
        scheduleUrlSync();
      }
      // Canonical estate listeners are registered first in capture phase. Stop here
      // so legacy inventory listeners loaded later cannot mutate canonical controls.
      event.stopImmediatePropagation();
    }, true);
  });
}

function bindUrlState() {
  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-view], [data-go]");
    const view = target?.dataset.view || target?.dataset.go;
    if (view) setTimeout(() => pushViewUrl(view), 0);
  });

  window.addEventListener("popstate", () => restoreUrlState());
}

async function restoreUrlState() {
  if (!(await waitForExploreReady())) return;
  const url = new URL(window.location.href);
  const requestedView = url.searchParams.get("view") || "overview";
  const nav = document.querySelector(`[data-view="${CSS.escape(requestedView)}"]`);
  exploreInvestigationState.restoringHistory = true;
  try {
    if (nav && !nav.classList.contains("active")) nav.click();
    if (requestedView !== "inventory") return;
    const search = xq("inventorySearch");
    const type = xq("inventoryType");
    const identity = xq("inventoryServer");
    const size = xq("inventoryOwner");
    const queryValue = url.searchParams.get("q") || "";
    const typeValue = url.searchParams.get("type") || "";
    const identityValue = url.searchParams.get("identity") || "";
    const sizeValue = url.searchParams.get("size") || "50";
    requestTableScrollReset(4);
    search.value = queryValue;
    type.value = [...type.options].some((option) => option.value === typeValue) ? typeValue : "";
    identity.value = [...identity.options].some((option) => option.value === identityValue) ? identityValue : "";
    size.value = [...size.options].some((option) => option.value === sizeValue) ? sizeValue : "50";
    type.dispatchEvent(new Event("change", { bubbles: true }));
    identity.dispatchEvent(new Event("change", { bubbles: true }));
    size.dispatchEvent(new Event("change", { bubbles: true }));
    search.dispatchEvent(new Event("input", { bubbles: true }));
    updateScopeState();
    await sleep(700);
    search.dispatchEvent(new Event("input", { bubbles: true }));
  } finally {
    await sleep(0);
    exploreInvestigationState.restoringHistory = false;
  }
}

async function initExploreInvestigation() {
  installExploreStyles();
  if (!(await waitForExploreReady())) return;
  try {
    exploreInvestigationState.summary = await exploreApi("/api/v2/estate/current/summary");
    installScopeBar(exploreInvestigationState.summary);
  } catch {}
  bindInvestigationInteractions();
  shieldCanonicalInventoryControls();
  bindUrlState();
  await restoreUrlState();
}

initExploreInvestigation();