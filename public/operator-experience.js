const OE_REVISION = "20260915-4";

const oeState = {
  overview: null,
  paths: [],
  pathPage: { total: 0, next_offset: null },
  selectedPath: 0,
  exploreQuery: "",
  exploreType: "",
  exploreMode: "entry",
  exploreItems: [],
  explorePage: { total: 0 },
  exploreFilters: { total_entities: 0, semantic_types: [] },
  exploreSelected: null,
  exploreSequence: 0,
  situations: [],
  situationPage: { total: null, next_offset: null },
  situationCounts: { situations: null, open_findings: null, acknowledged_findings: null },
  investigationPublished: false,
  investigationLoading: false,
  focusedFindingId: null,
  focusedFinding: null,
  focusedTab: "overview",
  collection: null,
};

const oe$ = (id) => document.getElementById(id);
const oeEsc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

async function oeApi(path) {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(body.detail || `Request failed (${response.status})`);
    error.status = response.status;
    error.code = body.code;
    throw error;
  }
  return body;
}

function relativeTime(value) {
  const time = new Date(value || 0).getTime();
  if (!Number.isFinite(time) || time <= 0) return "time unknown";
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function typeLabel(type) {
  const labels = {
    "app.application": "Application",
    "app.application_instance": "Application instance",
    "infra.host": "Host",
    "infra.network_endpoint": "Network endpoint",
    "mq.queue_manager": "Queue manager",
    "mq.queue_manager_instance": "Queue manager instance",
    "mq.queue": "Queue",
    "mq.channel": "Channel",
    "mq.listener": "Listener",
    "mq.cluster": "Cluster",
    "mq.topic": "Topic",
    "mq.process_definition": "Process",
    "mq.runtime_process": "Runtime process",
    "mq.service": "MQ service",
    "mq.namelist": "Namelist",
    "filetransfer.flow": "File-transfer path",
    "filetransfer.endpoint": "File-transfer endpoint",
    "filetransfer.server": "File-transfer server",
  };
  return labels[type] || String(type || "entity").replaceAll("_", " ").replaceAll(".", " · ");
}

function tone(value) {
  const v = String(value || "").toLowerCase();
  if (["critical", "failed", "stale", "danger"].includes(v)) return "danger";
  if (["warning", "warn", "unknown", "partial", "not_collected", "not observed", "not_observed", "incomplete"].includes(v)) return "warn";
  if (["current", "observed", "success", "qualified", "good", "corroborated"].includes(v)) return "good";
  if (["info", "historical"].includes(v)) return "info";
  return "neutral";
}

function badge(label, style = "neutral") {
  return `<span class="oe-badge ${oeEsc(style)}">${oeEsc(label)}</span>`;
}

function metric(label, value, note, style = "neutral", icon = "•") {
  return `<article class="oe-metric ${oeEsc(style)}"><span class="oe-metric-icon">${oeEsc(icon)}</span><div><strong>${oeEsc(value)}</strong><span>${oeEsc(label)}</span><small>${oeEsc(note)}</small></div></article>`;
}

function installStyles() {
  if (document.querySelector('link[data-oe-v2]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `/operator-experience.css?v=${OE_REVISION}`;
  link.dataset.oeV2 = "true";
  document.head.appendChild(link);
}

function polishShell() {
  document.body.classList.add("oe-v2-active");
  const labels = { overview: "Operations", routes: "Paths", inventory: "Explore", investigations: "Investigations", snapshots: "Collection" };
  Object.entries(labels).forEach(([view, label]) => {
    const button = document.querySelector(`.nav [data-view="${view}"]`);
    if (button && button.textContent.trim() !== label) button.textContent = label;
  });
  const brandMark = document.querySelector(".brand-mark");
  const brandStrong = document.querySelector(".brand strong");
  const brandSub = document.querySelector(".brand span");
  if (brandMark) brandMark.textContent = "OSI";
  if (brandStrong) brandStrong.textContent = "OSI Dashboard";
  if (brandSub) brandSub.textContent = "Operational Intelligence";
  const topbar = document.querySelector(".topbar");
  if (topbar && !topbar.querySelector(".oe-operator-chip")) {
    const chip = document.createElement("div");
    chip.className = "oe-operator-chip";
    chip.innerHTML = `<span>OP</span><div><strong>Operator</strong><small>Canonical estate</small></div>`;
    topbar.appendChild(chip);
  }
}

function ensureScreen(view, id, markup) {
  const panel = document.querySelector(`[data-view-panel="${view}"]`);
  if (!panel) return null;
  let screen = oe$(id);
  if (!screen) {
    screen = document.createElement("section");
    screen.id = id;
    screen.className = "oe-screen";
    screen.innerHTML = markup;
    panel.prepend(screen);
  }
  return screen;
}

function installScreens() {
  ensureScreen("overview", "oeOperations", `
    <div class="oe-page-head"><div><h2>Operations</h2><p>Start with the operational situations that deserve attention; reveal individual findings only when you investigate.</p></div><button class="oe-button ghost" data-oe-refresh="overview">Refresh</button></div>
    <div id="oeOpsMetrics" class="oe-metrics oe-metrics-4"><div class="oe-loading">Reading operational state…</div></div>
    <section class="oe-panel"><div class="oe-section-head"><div><h3>Situations requiring attention</h3><p>Related findings are compressed around the canonical object they describe.</p></div><button class="oe-link" data-oe-nav="investigations">Review situations</button></div><div id="oeAttentionTable"></div></section>
    <div class="oe-grid-2">
      <section class="oe-panel"><div class="oe-section-head"><div><h3>Affected paths</h3><p>Qualified operational paths and their current evidence boundaries.</p></div><button class="oe-link" data-oe-nav="routes">Open Paths</button></div><div id="oeAffectedPaths" class="oe-rows"></div></section>
      <section class="oe-panel"><div class="oe-section-head"><div><h3>Knowledge limitations</h3><p>Unknown mappings that constrain interpretation.</p></div></div><div id="oeKnowledgeLimits" class="oe-rows"></div></section>
    </div>`);

  ensureScreen("routes", "oePaths", `
    <div class="oe-page-head"><div><h2>Paths</h2><p>Follow an evidence-backed operational path without turning topology into a transaction claim.</p></div><button class="oe-button ghost" data-oe-route-advanced>Advanced trace</button></div>
    <section class="oe-panel oe-path-selector-panel"><label><span>Select a qualified operational path</span><select id="oePathSelect"><option>Loading paths…</option></select></label><div class="oe-head-actions"><button id="oeLoadMorePaths" class="oe-button ghost" data-oe-load-paths hidden>Load more</button><button class="oe-button ghost" data-oe-nav="investigations">View situations</button></div></section>
    <section id="oePathFocus" class="oe-panel oe-path-primary"><div class="oe-loading">Loading qualified paths…</div></section>
    <section class="oe-panel oe-path-facts"><div class="oe-section-head"><div><h3>Path facts</h3><p>Compact topology facts; proof stays behind disclosure.</p></div></div><div id="oePathDetails"></div></section>
    <details id="oePathEvidence" class="oe-panel oe-evidence-disclosure"><summary>Inspect route evidence</summary><div id="oePathEvidenceBody"></div></details>`);

  ensureScreen("inventory", "oeExplore", `
    <div class="oe-page-head"><div><h2>Explore</h2><p>Search the canonical estate first. Do not browse hundreds of objects unless a task requires it.</p></div></div>
    <form id="oeExploreForm" class="oe-explore-search"><span>⌕</span><input id="oeExploreInput" type="search" autocomplete="off" placeholder="Search an object, host, queue, path, or canonical identity…"><button class="oe-button" type="submit">Search</button></form>
    <div id="oeExploreChips" class="oe-filter-chips"></div>
    <div id="oeExploreLayout" class="oe-explore-layout entry">
      <section class="oe-panel"><div class="oe-section-head"><div><h3 id="oeExploreCount">Start with search or a type</h3><p id="oeExploreHint">Choose the smallest useful slice of the canonical estate.</p></div></div><div id="oeExploreResults" class="oe-result-list"><div class="oe-loading">Reading estate entry points…</div></div></section>
      <aside class="oe-panel oe-object-inspector"><div id="oeExploreDetail" class="oe-empty-state"><strong>Select an object</strong><p>Identity, relationships and evidence appear here.</p></div></aside>
    </div>`);

  ensureScreen("investigations", "oeInvestigations", `<div id="oeInvestigationRoot"><div class="oe-loading">Loading investigation workspace…</div></div>`);

  ensureScreen("snapshots", "oeCollection", `
    <div class="oe-page-head"><div><h2>Collection</h2><p>Can I trust what OSI currently knows? Start with source freshness and interpretation limits, not raw observation volume.</p></div><div class="oe-head-actions"><button class="oe-button ghost" data-oe-nav="administration">Import evidence</button><button class="oe-button ghost" data-oe-refresh="snapshots">Refresh</button></div></div>
    <div id="oeCollectionMetrics" class="oe-metrics oe-metrics-4"><div class="oe-loading">Reading evidence state…</div></div>
    <div class="oe-grid-collection">
      <section class="oe-panel"><div class="oe-section-head"><div><h3>Evidence domains</h3><p>Observed canonical entities by technology/domain. Volume is not health or completeness.</p></div></div><div id="oeDomainTable"></div></section>
      <section class="oe-panel"><div class="oe-section-head"><div><h3>Interpretation boundary</h3><p>What the current collection can and cannot establish.</p></div></div><div id="oeCollectionBoundary"></div></section>
    </div>
    <button class="oe-link oe-history-link" data-oe-collection-history>Show collection history</button>`);
}

function situationSignals(situation) {
  const mechanisms = Array.isArray(situation?.mechanisms) ? situation.mechanisms : [];
  return mechanisms.slice(0, 3).map((item) => item.summary || item.rule_id).filter(Boolean);
}

function situationEvidenceLabel(situation) {
  const count = Number(situation?.finding_count || 0);
  const type = typeLabel(situation?.semantic_type);
  return `${type} · ${count} finding${count === 1 ? "" : "s"}`;
}

function renderOperations() {
  const data = oeState.overview;
  if (!data) return;
  const published = data.operations?.published === true;
  const estate = data.estate || {};
  const situations = data.situations || { total: null, items: [] };
  const paths = data.paths || { total: 0, items: [] };
  const limitations = data.limitations || { total: 0, items: [] };
  const findingTotal = published ? Number(data.operations.open_findings || 0) + Number(data.operations.acknowledged_findings || 0) : null;
  oe$("oeOpsMetrics").innerHTML = [
    metric("Attention situations", published ? Number(situations.total || 0).toLocaleString() : "Unknown", published ? `${findingTotal.toLocaleString()} current findings grouped by object` : "No operational evaluation published", published ? (Number(situations.total || 0) ? "danger" : "good") : "warn", "△"),
    metric("Qualified paths", Number(paths.total || 0).toLocaleString(), "Evidence-backed operational paths", "neutral", "⌁"),
    metric("Unresolved mappings", Number(limitations.total || 0).toLocaleString(), "Canonical references that limit interpretation", Number(limitations.total || 0) ? "warn" : "neutral", "?"),
    metric("Estate freshness", estate.fresh ? "Current" : "Stale", `${Number(estate.entity_count || 0).toLocaleString()} canonical entities`, estate.fresh ? "neutral" : "danger", "●"),
  ].join("");

  const attention = Array.isArray(situations.items) ? situations.items : [];
  if (!published) {
    oe$("oeAttentionTable").innerHTML = `<div class="oe-empty-state"><strong>Operational attention is unknown</strong><p>No current operational evaluation source is published. Zero situations must not be interpreted as healthy state.</p></div>`;
  } else {
    oe$("oeAttentionTable").innerHTML = attention.length ? `<div class="oe-attention-head"><span>Severity</span><span>Situation</span><span>Evidence</span><span>Updated</span></div>${attention.map((situation) => {
      const signals = situationSignals(situation);
      return `<button class="oe-attention-row oe-situation-row" type="button" data-oe-situation="${oeEsc(situation.situation_key)}" data-oe-finding="${oeEsc(situation.focus_finding_id)}"><span>${badge(situation.severity || "info", tone(situation.severity))}</span><span><strong>${oeEsc(situation.display_name || situation.entity_id || "Operational situation")}</strong><small>${oeEsc(signals.join(" · ") || "Current evidence-linked findings")}</small></span><span><strong>${oeEsc(situationEvidenceLabel(situation))}</strong><small>${oeEsc(Number(situation.acknowledged_findings || 0) ? `${Number(situation.acknowledged_findings || 0)} acknowledged` : "All current findings open")}</small></span><span>${oeEsc(relativeTime(situation.last_seen))}</span></button>`;
    }).join("")}` : `<div class="oe-empty-state"><strong>No current situations require attention</strong><p>This remains bounded by published evidence coverage.</p></div>`;
  }

  oe$("oeAffectedPaths").innerHTML = (paths.items || []).map((path, index) => `<button class="oe-context-row" type="button" data-oe-overview-path="${index}"><span><strong>${oeEsc(path.label)}</strong><small>${path.runtime_boundary === "current" ? "Current runtime boundary supported" : "Runtime boundary incomplete"}</small></span>${badge("Qualified", "good")}</button>`).join("") || `<div class="oe-empty-state"><p>No qualified operational paths in the current projection.</p></div>`;
  oe$("oeKnowledgeLimits").innerHTML = (limitations.items || []).map((gap) => `<div class="oe-context-row"><span><strong>${oeEsc(gap.vendor_value || gap.expected_target_type || "Unresolved reference")}</strong><small>${oeEsc(gap.reason || "Evidence-backed mapping is incomplete")}</small></span>${badge(gap.state || "unknown", "warn")}</div>`).join("") || `<div class="oe-empty-state"><strong>No unresolved references returned in this slice</strong><p>${published ? `${Number(data.operations.coverage_gaps || 0).toLocaleString()} published operational coverage gaps.` : "Operational coverage is unknown because no current evaluation source is published."}</p></div>`;
}

function pathNode(node) {
  const icon = node.role === "Access context" ? "◉" : node.role === "DMZ listener" ? "⌁" : node.role === "PNC boundary" ? "◇" : "▣";
  return `<div class="oe-path-node"><span>${oeEsc(node.role)}</span><div class="oe-path-icon">${icon}</div><strong>${oeEsc(node.title)}</strong><small>${oeEsc(node.note)}</small>${badge(node.state, tone(node.state_kind || node.state))}</div>`;
}

function renderPaths() {
  const select = oe$("oePathSelect");
  if (!select) return;
  const loadMore = oe$("oeLoadMorePaths");
  if (loadMore) loadMore.hidden = oeState.pathPage?.next_offset == null;
  if (!oeState.paths.length) {
    select.innerHTML = `<option>No qualified file-transfer paths</option>`;
    select.disabled = true;
    oe$("oePathFocus").innerHTML = `<div class="oe-empty-state"><strong>No qualified paths available</strong><p>The current canonical estate does not expose a qualified file-transfer path.</p></div>`;
    oe$("oePathDetails").innerHTML = "";
    oe$("oePathEvidenceBody").innerHTML = "";
    return;
  }
  select.disabled = false;
  select.innerHTML = oeState.paths.map((path, index) => `<option value="${index}"${index === oeState.selectedPath ? " selected" : ""}>${oeEsc(path.label)}</option>`).join("");
  const path = oeState.paths[oeState.selectedPath] || oeState.paths[0];
  oe$("oePathFocus").innerHTML = `<div class="oe-path-head"><div><span>Operational path</span><h3>${oeEsc(path.label)}</h3><p>${oeEsc(path.explanation || "Evidence-qualified topology path")}</p></div><div>${badge("Qualified", "good")} ${badge(`${Number(path.gap_count || 0)} path gap${Number(path.gap_count || 0) === 1 ? "" : "s"}`, Number(path.gap_count || 0) ? "warn" : "neutral")}</div></div><div class="oe-path-lane">${(path.nodes || []).map((node, index) => `${index ? `<div class="oe-path-arrow">→</div>` : ""}${pathNode(node)}`).join("")}</div><div class="oe-path-actions"><button class="oe-button" data-oe-open-evidence>Inspect route evidence</button><button class="oe-button ghost" data-oe-nav="investigations">Related situations</button></div>`;
  oe$("oePathDetails").innerHTML = `<div class="oe-path-detail-grid">${(path.details || []).map((item) => `<div><span>${oeEsc(item.label)}</span><strong>${oeEsc(item.value)}</strong></div>`).join("")}</div>`;
  oe$("oePathEvidenceBody").innerHTML = `<div class="oe-evidence-table">${(path.evidence || []).map((item) => `<div><span>${oeEsc(item.label)}</span><strong>${oeEsc(item.state)}</strong><small>${oeEsc(item.detail)}</small></div>`).join("")}</div>${(path.gaps || []).length ? `<div class="oe-rows">${path.gaps.map((gap) => `<div class="oe-context-row"><span><strong>${oeEsc(gap.vendor_value || gap.expected_target_type || "Unresolved")}</strong><small>${oeEsc(gap.reason || "Path mapping evidence is incomplete")}</small></span>${badge(gap.state || "unknown", "warn")}</div>`).join("")}</div>` : ""}`;
}

async function loadPaths(reset = true) {
  const offset = reset ? 0 : Number(oeState.pathPage?.next_offset || 0);
  const data = await oeApi(`/api/v2/operator/paths?limit=25&offset=${offset}`);
  if (reset) oeState.paths = [];
  const known = new Set(oeState.paths.map((path) => path.id));
  for (const path of data.paths || []) if (!known.has(path.id)) oeState.paths.push(path);
  oeState.pathPage = data.page || { total: oeState.paths.length, next_offset: null };
  if (oeState.selectedPath >= oeState.paths.length) oeState.selectedPath = Math.max(0, oeState.paths.length - 1);
  renderPaths();
}

function exploreChips() {
  const filters = oeState.exploreFilters || { total_entities: 0, semantic_types: [] };
  return [{ semantic_type: "", count: Number(filters.total_entities || 0) }, ...(filters.semantic_types || [])];
}

async function runExplore() {
  const sequence = ++oeState.exploreSequence;
  const params = new URLSearchParams({ limit: "25", offset: "0" });
  if (oeState.exploreQuery) params.set("q", oeState.exploreQuery);
  if (oeState.exploreType) params.set("semantic_type", oeState.exploreType);
  oe$("oeExploreResults").innerHTML = `<div class="oe-loading">Reading the relevant estate slice…</div>`;
  const data = await oeApi(`/api/v2/operator/explore?${params.toString()}`);
  if (sequence !== oeState.exploreSequence) return;
  oeState.exploreMode = data.mode || (oeState.exploreQuery || oeState.exploreType ? "results" : "entry");
  oeState.exploreItems = data.items || [];
  oeState.explorePage = data.page || { total: oeState.exploreItems.length };
  oeState.exploreFilters = data.filters || { total_entities: 0, semantic_types: [] };
  oeState.exploreSelected = null;
  renderExplore();
}

function renderExplore() {
  const isEntry = oeState.exploreMode === "entry" && !oeState.exploreQuery && !oeState.exploreType;
  oe$("oeExploreChips").innerHTML = exploreChips().map((chip) => {
    const type = chip.semantic_type || "";
    const label = type ? typeLabel(type) : "All estate";
    return `<button type="button" class="oe-chip${type === oeState.exploreType ? " active" : ""}" data-oe-type="${oeEsc(type)}">${oeEsc(label)} <span>${Number(chip.count || 0).toLocaleString()}</span></button>`;
  }).join("");
  oe$("oeExploreLayout")?.classList.toggle("entry", isEntry);
  if (isEntry) {
    oe$("oeExploreCount").textContent = "Start with search or a type";
    oe$("oeExploreHint").textContent = `${Number(oeState.exploreFilters.total_entities || 0).toLocaleString()} canonical entities are available, but none are listed until you narrow the task.`;
    const entryPoints = (oeState.exploreFilters.semantic_types || []).slice(0, 6);
    oe$("oeExploreResults").innerHTML = `<div class="oe-explore-entry"><strong>Find the object you care about</strong><p>Search by name or canonical identity, or enter through a focused object type. OSI will reveal detail only after you choose a useful slice.</p><div class="oe-entry-grid">${entryPoints.map((item) => `<button type="button" data-oe-type="${oeEsc(item.semantic_type)}"><span>${oeEsc(typeLabel(item.semantic_type))}</span><strong>${Number(item.count || 0).toLocaleString()}</strong></button>`).join("")}</div></div>`;
    oe$("oeExploreDetail").innerHTML = `<div class="oe-empty-state"><strong>Object detail appears after selection</strong><p>Canonical identity, relationships, sources and evidence remain one step behind search.</p></div>`;
    return;
  }
  oe$("oeExploreCount").textContent = `Results (${Number(oeState.explorePage?.total || 0).toLocaleString()})`;
  oe$("oeExploreHint").textContent = "25 results per query; refine the search instead of scanning the estate.";
  oe$("oeExploreResults").innerHTML = oeState.exploreItems.length ? oeState.exploreItems.map((entity) => `<button class="oe-result-row${oeState.exploreSelected?.entity?.entity_id === entity.entity_id ? " active" : ""}" type="button" data-oe-entity="${oeEsc(entity.entity_id)}"><span class="oe-result-icon">${String(entity.semantic_type || "").startsWith("mq.") ? "▦" : String(entity.semantic_type || "").startsWith("filetransfer.") ? "⇄" : "◇"}</span><span><strong>${oeEsc(entity.display_name || entity.identity_key)}</strong><small>${oeEsc(typeLabel(entity.semantic_type))} · ${oeEsc((entity.evidence_classes || []).join(" · ") || "evidence unknown")}</small></span>${badge(entity.identity_state || "canonical", entity.identity_state === "conflicted" ? "warn" : "neutral")}</button>`).join("") : `<div class="oe-empty-state"><strong>No canonical entities match</strong><p>Adjust the search or semantic-type filter.</p></div>`;
  if (!oeState.exploreSelected) oe$("oeExploreDetail").innerHTML = `<div class="oe-empty-state"><strong>Select one result</strong><p>Identity, relationships and evidence will appear here without expanding every row.</p></div>`;
}

async function selectExploreEntity(entityId) {
  const detail = await oeApi(`/api/v2/operator/explore/${encodeURIComponent(entityId)}`);
  oeState.exploreSelected = detail;
  renderExplore();
  const entity = detail.entity || {};
  const relations = detail.relations || [];
  const properties = entity.properties && typeof entity.properties === "object" ? Object.entries(entity.properties).slice(0, 8) : [];
  oe$("oeExploreDetail").innerHTML = `<div class="oe-inspector-head"><span class="oe-result-icon large">◇</span><div><h3>${oeEsc(entity.display_name || entity.identity_key || "Entity")}</h3><p>${oeEsc(typeLabel(entity.semantic_type))}</p>${badge(entity.identity_state || "canonical", entity.identity_state === "conflicted" ? "warn" : "neutral")}</div></div><div class="oe-inspector-proof"><span>Why OSI knows this object</span><strong>${Number(detail.presentation?.source_count || 0).toLocaleString()} source${Number(detail.presentation?.source_count || 0) === 1 ? "" : "s"} · ${Number(detail.presentation?.evidence_count || 0).toLocaleString()} evidence reference${Number(detail.presentation?.evidence_count || 0) === 1 ? "" : "s"}</strong><small>${oeEsc((entity.evidence_classes || []).join(" · ") || "Evidence class unknown")}</small></div><div class="oe-tabs"><button class="active" type="button">Overview</button><button type="button" disabled>Related (${Number(detail.presentation?.related_count || relations.length)})</button><button type="button" disabled>Evidence (${Number(detail.presentation?.evidence_count || 0)})</button></div><dl class="oe-inspector-facts"><div><dt>Canonical identity</dt><dd>${oeEsc(entity.identity_key || "—")}</dd></div><div><dt>Identity rule</dt><dd>${oeEsc(entity.identity_rule || "—")}</dd></div><div><dt>Observed</dt><dd>${oeEsc(relativeTime(entity.observed_at))}</dd></div><div><dt>Sources</dt><dd>${Number(detail.presentation?.source_count || 0).toLocaleString()}</dd></div><div><dt>Evidence classes</dt><dd>${oeEsc((entity.evidence_classes || []).join(", ") || "unknown")}</dd></div><div><dt>Relationships</dt><dd>${relations.length.toLocaleString()}</dd></div></dl>${properties.length ? `<div class="oe-inspector-section"><h4>Key properties</h4>${properties.map(([key, value]) => `<div class="oe-property-row"><span>${oeEsc(key)}</span><strong>${oeEsc(Array.isArray(value) ? value.join(", ") : typeof value === "object" ? JSON.stringify(value) : value)}</strong></div>`).join("")}</div>` : ""}<div class="oe-inspector-section"><h4>Related canonical entities</h4>${relations.slice(0, 6).map((relation) => `<div class="oe-property-row"><span>${oeEsc(relation.semantic_type)}</span><strong>${oeEsc(relation.source_entity_id === entity.entity_id ? relation.target_entity_id : relation.source_entity_id)}</strong></div>`).join("") || `<p>No relationships returned in this slice.</p>`}</div>`;
}

function investigationQueueMarkup() {
  const total = oeState.situationPage?.total;
  const counts = oeState.situationCounts || {};
  return `<div class="oe-page-head"><div><h2>Investigations</h2><p>Review operational situations, not a wall of duplicate findings. Each situation keeps its rule mechanisms visible underneath.</p></div><button class="oe-button ghost" data-oe-refresh="investigations">Refresh</button></div><div class="oe-metrics oe-metrics-3">${metric("Attention situations", oeState.investigationPublished ? Number(total || 0).toLocaleString() : "Unknown", oeState.investigationPublished ? "Grouped by canonical object" : "No operational evaluation", oeState.investigationPublished ? (Number(total || 0) ? "danger" : "neutral") : "warn", "△")}${metric("Open findings", oeState.investigationPublished ? Number(counts.open_findings || 0).toLocaleString() : "Unknown", oeState.investigationPublished ? "Individual findings behind situations" : "No operational evaluation", "neutral", "•")}${metric("Acknowledged", oeState.investigationPublished ? Number(counts.acknowledged_findings || 0).toLocaleString() : "Unknown", oeState.investigationPublished ? "Still current" : "No operational evaluation", "neutral", "●")}</div><section class="oe-panel"><div class="oe-section-head"><div><h3>Situation queue</h3><p>Severity first, then recency. One row represents one canonical object with its current finding mechanisms.</p></div></div><div id="oeFindingQueue" class="oe-finding-queue"></div><div id="oeFindingLoadMore" class="oe-load-more"></div></section>`;
}

function renderFindingQueue() {
  const root = oe$("oeInvestigationRoot");
  if (!root) return;
  root.innerHTML = investigationQueueMarkup();
  if (!oeState.investigationPublished) {
    oe$("oeFindingQueue").innerHTML = `<div class="oe-empty-state"><strong>Investigation queue is unknown</strong><p>No current operational evaluation source is published, so zero situations cannot be treated as an evaluated estate.</p></div>`;
    oe$("oeFindingLoadMore").innerHTML = "";
    return;
  }
  oe$("oeFindingQueue").innerHTML = oeState.situations.length ? oeState.situations.map((situation) => {
    const signals = situationSignals(situation);
    return `<button class="oe-finding-row oe-situation-row" type="button" data-oe-situation="${oeEsc(situation.situation_key)}" data-oe-finding="${oeEsc(situation.focus_finding_id)}"><span>${badge(situation.severity || "info", tone(situation.severity))}</span><span><strong>${oeEsc(situation.display_name || situation.entity_id)}</strong><small>${oeEsc(signals.join(" · ") || "Current evidence-linked findings")}</small></span><span><strong>${Number(situation.finding_count || 0)} finding${Number(situation.finding_count || 0) === 1 ? "" : "s"}</strong><small>${oeEsc(relativeTime(situation.last_seen))}</small></span><span>Investigate →</span></button>`;
  }).join("") : `<div class="oe-empty-state"><strong>No current situations</strong><p>Absence of situations is bounded by the published operational evaluation coverage.</p></div>`;
  oe$("oeFindingLoadMore").innerHTML = oeState.situationPage?.next_offset != null ? `<button class="oe-button ghost" data-oe-load-findings>Load more situations</button>` : "";
}

async function loadInvestigations(reset = true) {
  if (oeState.investigationLoading) return;
  oeState.investigationLoading = true;
  try {
    const offset = reset ? 0 : Number(oeState.situationPage?.next_offset || 0);
    const data = await oeApi(`/api/v2/operator/situations?limit=20&offset=${offset}`);
    if (reset) oeState.situations = [];
    const known = new Set(oeState.situations.map((situation) => situation.situation_key));
    for (const situation of data.items || []) if (!known.has(situation.situation_key)) oeState.situations.push(situation);
    oeState.situationPage = data.page || { total: null, next_offset: null };
    oeState.situationCounts = data.counts || { situations: null, open_findings: null, acknowledged_findings: null };
    oeState.investigationPublished = data.published === true;
    renderFindingQueue();
  } finally { oeState.investigationLoading = false; }
}

function clearFocusedFinding() {
  oeState.focusedFindingId = null;
  oeState.focusedFinding = null;
  oeState.focusedTab = "overview";
  try { sessionStorage.removeItem("osi.oe.focus"); } catch {}
}

async function focusFinding(id) {
  oeState.focusedFindingId = id;
  oeState.focusedTab = "overview";
  try { sessionStorage.setItem("osi.oe.focus", id); } catch {}
  try {
    oeState.focusedFinding = await oeApi(`/api/v2/operator/investigations/${encodeURIComponent(id)}`);
    renderFocusedInvestigation();
  } catch (error) {
    if (error?.status === 404) {
      clearFocusedFinding();
      await loadInvestigations(true);
      return;
    }
    throw error;
  }
}

function noteKey(id) { return `osi.oe.notes.${id}`; }
function checkKey(id) { return `osi.oe.checks.${id}`; }
function getNote(id) { try { return sessionStorage.getItem(noteKey(id)) || ""; } catch { return ""; } }
function getChecks(id) { try { return JSON.parse(sessionStorage.getItem(checkKey(id)) || "[]"); } catch { return []; } }

function statusBlock(finding) {
  const evidenceCount = Array.isArray(finding.evidence) ? finding.evidence.length : 0;
  const score = Number(finding.confidence?.score);
  return `<div class="oe-investigation-status"><div><span>Status</span><strong>${oeEsc(finding.status || "OPEN")}</strong></div><div><span>Severity</span><strong>${oeEsc(finding.severity || "info")}</strong></div><div><span>Confidence</span><strong>${oeEsc(finding.confidence?.level || "unknown")}${Number.isFinite(score) ? ` · ${Math.round(score * 100)}%` : ""}</strong></div><div><span>Coverage</span><strong>${oeEsc(finding.coverage_state || "unknown")}</strong></div><div><span>Evidence</span><strong>${evidenceCount}</strong></div><div><span>Last seen</span><strong>${oeEsc(relativeTime(finding.last_seen))}</strong></div></div>`;
}

function renderFocusedInvestigation() {
  const root = oe$("oeInvestigationRoot");
  const detail = oeState.focusedFinding;
  if (!root || !detail?.finding) return;
  const finding = detail.finding;
  const relatedFindings = detail.related_findings || [];
  const tabs = [["overview", "Overview"], ["context", "Path context"], ["related", `Related findings (${relatedFindings.length})`], ["evidence", `Evidence (${Array.isArray(finding.evidence) ? finding.evidence.length : 0})`], ["notes", "Notes"]];
  root.innerHTML = `<div class="oe-investigation-head"><div><button class="oe-link" data-oe-back-findings>← Back to situations</button><h2>Investigating: ${oeEsc(finding.display_name || finding.entity_id)}</h2><p>${oeEsc(finding.summary || finding.diagnosis || "Evidence-linked operational finding")}</p></div>${badge(finding.status || "OPEN", finding.status === "OPEN" ? "warn" : "info")}</div><div class="oe-tabs oe-investigation-tabs">${tabs.map(([key, label]) => `<button type="button" class="${oeState.focusedTab === key ? "active" : ""}" data-oe-investigation-tab="${key}">${oeEsc(label)}</button>`).join("")}</div><div id="oeInvestigationTabBody"></div>`;
  renderInvestigationTab();
}

function renderInvestigationTab() {
  const body = oe$("oeInvestigationTabBody");
  const detail = oeState.focusedFinding;
  if (!body || !detail?.finding) return;
  const finding = detail.finding;
  const evidence = Array.isArray(finding.evidence) ? finding.evidence : [];
  const related = Array.isArray(finding.related_entities) ? finding.related_entities : [];
  if (oeState.focusedTab === "overview") {
    const checks = getChecks(finding.finding_id);
    const tasks = ["Review supporting evidence", "Inspect related canonical entities", "Confirm the coverage boundary", "Record working notes"];
    body.innerHTML = `<div class="oe-investigation-grid"><section class="oe-panel"><div class="oe-section-head"><div><h3>Finding summary</h3><p>This is the selected mechanism inside the broader object situation.</p></div><button class="oe-link" data-oe-inspect-entity="${oeEsc(finding.entity_id)}">View in Explore</button></div><div class="oe-investigation-copy"><strong>${oeEsc(finding.diagnosis || finding.summary || "No diagnosis supplied")}</strong><p>Entity: ${oeEsc(finding.entity_id)} · ${oeEsc(typeLabel(finding.semantic_type))}</p>${badge(finding.coverage_state || "unknown", tone(finding.coverage_state))}</div><div class="oe-key-questions"><h4>Key questions</h4><div><b>1</b><span>What evidence directly supports this mechanism?</span></div><div><b>2</b><span>What other current findings affect the same object?</span></div><div><b>3</b><span>Does the current coverage limit the conclusion?</span></div></div></section><section class="oe-panel"><div class="oe-section-head"><div><h3>Next steps</h3><p>Browser-session working checklist; not a persistent case record.</p></div></div><div class="oe-checklist">${tasks.map((task, index) => `<label><input type="checkbox" data-oe-check-index="${index}"${checks.includes(index) ? " checked" : ""}><span>${oeEsc(task)}</span></label>`).join("")}</div><div class="oe-note-box"><label>Working note <small>this browser session only</small><textarea id="oeInvestigationNote" placeholder="Add a note, observation, or hypothesis…">${oeEsc(getNote(finding.finding_id))}</textarea></label><button class="oe-button ghost" data-oe-save-note>Save session note</button></div></section><aside class="oe-panel"><div class="oe-section-head"><div><h3>Status</h3><p>Current finding state.</p></div></div>${statusBlock(finding)}<div class="oe-tag-box"><span>Tags</span>${badge(finding.semantic_type || "entity", "info")} ${badge(finding.coverage_state || "unknown", tone(finding.coverage_state))} ${badge(`${evidence.length} evidence refs`, "neutral")}</div></aside></div>`;
  } else if (oeState.focusedTab === "context") {
    const path = detail.path_context;
    body.innerHTML = `<section class="oe-panel"><div class="oe-section-head"><div><h3>Path context</h3><p>Only canonical or qualified topology context is shown.</p></div></div>${path ? `<div class="oe-path-mini"><strong>${oeEsc(path.label)}</strong><p>Runtime boundary: ${oeEsc(path.runtime_boundary)} · Transfer completion: ${oeEsc(String(path.transfer_completion || "unknown").replaceAll("_", " "))}</p>${badge("Qualified", "good")}</div>` : `<div class="oe-empty-state"><strong>No qualified operational path matched this finding</strong><p>The finding remains anchored to its canonical entity and related-entity references.</p></div>`}<div class="oe-related-ids">${related.map((id) => `<button class="oe-chip" data-oe-inspect-entity="${oeEsc(id)}">${oeEsc(id)}</button>`).join("")}</div></section>`;
  } else if (oeState.focusedTab === "related") {
    body.innerHTML = `<section class="oe-panel"><div class="oe-section-head"><div><h3>Other mechanisms on this object</h3><p>Additional current findings anchored to the same canonical entity.</p></div></div><div class="oe-rows">${(detail.related_findings || []).map((item) => `<button class="oe-context-row" data-oe-finding="${oeEsc(item.finding_id)}"><span><strong>${oeEsc(item.summary || item.rule_id || "Evidence-linked finding")}</strong><small>${oeEsc(item.diagnosis || item.display_name || item.entity_id)}</small></span>${badge(item.severity || "info", tone(item.severity))}</button>`).join("") || `<div class="oe-empty-state"><p>No additional current findings are anchored to this entity.</p></div>`}</div></section>`;
  } else if (oeState.focusedTab === "evidence") {
    body.innerHTML = `<div class="oe-grid-2"><section class="oe-panel"><div class="oe-section-head"><div><h3>Evidence references</h3><p>Exact references supplied by the finding evaluation.</p></div></div><div class="oe-evidence-list">${evidence.map((item) => `<pre>${oeEsc(typeof item === "string" ? item : JSON.stringify(item, null, 2))}</pre>`).join("") || `<div class="oe-empty-state"><p>No evidence references supplied.</p></div>`}</div></section><section class="oe-panel"><div class="oe-section-head"><div><h3>Current occurrences</h3><p>Evaluation occurrences for this finding.</p></div></div><div class="oe-rows">${(detail.occurrences || []).map((occurrence) => `<div class="oe-context-row"><span><strong>${oeEsc(occurrence.source_id || occurrence.source_host || "evaluation source")}</strong><small>${oeEsc(relativeTime(occurrence.last_seen))} · ${oeEsc(occurrence.evaluation_revision_id || "")}</small></span>${badge("current", "good")}</div>`).join("")}</div></section></div>`;
  } else {
    body.innerHTML = `<section class="oe-panel oe-notes-panel"><div class="oe-section-head"><div><h3>Working notes</h3><p>Session-local notes deliberately do not mutate canonical state or create an incident record.</p></div></div><textarea id="oeInvestigationNote" placeholder="Add a note, observation, or hypothesis…">${oeEsc(getNote(finding.finding_id))}</textarea><button class="oe-button" data-oe-save-note>Save session note</button></section>`;
  }
}

function renderCollection() {
  const data = oeState.collection;
  if (!data) return;
  const estate = data.estate || {};
  const telemetry = data.telemetry || {};
  oe$("oeCollectionMetrics").innerHTML = [
    metric("Semantic sources", Number(data.sources?.current || 0).toLocaleString(), "Current source revisions", Number(data.sources?.current || 0) ? "neutral" : "warn", "▣"),
    metric("Estate freshness", estate.fresh ? "Current" : "Stale", `${Number(estate.entities || 0).toLocaleString()} canonical entities`, estate.fresh ? "neutral" : "danger", "●"),
    metric("Unresolved mappings", Number(estate.unresolved || 0).toLocaleString(), "Canonical references limiting interpretation", Number(estate.unresolved || 0) ? "warn" : "neutral", "?"),
    metric("Telemetry ingress", telemetry.ingress_enabled ? "Enabled" : "Disabled", telemetry.mode || "mode unknown", "neutral", "↯"),
  ].join("");
  const domains = data.domains || [];
  const max = Math.max(1, ...domains.map((item) => Number(item.count || 0)));
  oe$("oeDomainTable").innerHTML = `<div class="oe-domain-head"><span>Domain</span><span>Observed entities</span><span>Relative volume</span></div>${domains.map((item) => `<div class="oe-domain-row"><strong>${oeEsc(item.name)}</strong><span>${Number(item.count || 0).toLocaleString()}</span><span><i style="width:${Math.max(8, Math.round((Number(item.count || 0) / max) * 100))}%"></i></span></div>`).join("")}`;
  oe$("oeCollectionBoundary").innerHTML = `<div class="oe-boundary-list">${(data.boundaries || []).map((item) => `<div>${badge(item.state, tone(item.kind))}<p>${oeEsc(item.detail)}</p></div>`).join("")}</div>`;
}

async function refreshView(view) {
  polishShell();
  try {
    if (view === "overview") {
      oeState.overview = await oeApi("/api/v2/operator/overview");
      renderOperations();
      return;
    }
    if (view === "routes") {
      await loadPaths(true);
      return;
    }
    if (view === "inventory") {
      await runExplore();
      return;
    }
    if (view === "investigations") {
      if (oeState.focusedFindingId) await focusFinding(oeState.focusedFindingId);
      else await loadInvestigations(true);
      return;
    }
    if (view === "snapshots") {
      oeState.collection = await oeApi("/api/v2/operator/collection");
      renderCollection();
    }
  } catch (error) {
    const screen = document.querySelector(`[data-view-panel="${view}"] .oe-screen`);
    if (screen) screen.innerHTML = `<div class="oe-empty-state error"><strong>Unable to load this workspace</strong><p>${oeEsc(error instanceof Error ? error.message : String(error))}</p><button class="oe-button ghost" data-oe-refresh="${oeEsc(view)}">Retry</button></div>`;
  }
}

function navigate(view) { window.osiNavigateProduct?.(view); }

function handleClick(event) {
  const nav = event.target.closest("[data-oe-nav]");
  if (nav) { navigate(nav.dataset.oeNav); return; }
  const refresh = event.target.closest("[data-oe-refresh]");
  if (refresh) { void refreshView(refresh.dataset.oeRefresh); return; }
  const overviewPath = event.target.closest("[data-oe-overview-path]");
  if (overviewPath) { oeState.selectedPath = Number(overviewPath.dataset.oeOverviewPath || 0); navigate("routes"); return; }
  const finding = event.target.closest("[data-oe-finding]");
  if (finding) { navigate("investigations"); setTimeout(() => void focusFinding(finding.dataset.oeFinding), 30); return; }
  const type = event.target.closest("[data-oe-type]");
  if (type) { oeState.exploreType = type.dataset.oeType || ""; void runExplore(); return; }
  const entity = event.target.closest("[data-oe-entity]");
  if (entity) { void selectExploreEntity(entity.dataset.oeEntity); return; }
  const inspect = event.target.closest("[data-oe-inspect-entity]");
  if (inspect) { navigate("inventory"); setTimeout(() => void selectExploreEntity(inspect.dataset.oeInspectEntity), 50); return; }
  if (event.target.closest("[data-oe-open-evidence]")) { const details = oe$("oePathEvidence"); if (details) { details.open = true; details.scrollIntoView({ behavior: "smooth", block: "start" }); } return; }
  if (event.target.closest("[data-oe-route-advanced]")) { document.querySelector('[data-view-panel="routes"]')?.classList.toggle("oe-show-legacy-route"); return; }
  if (event.target.closest("[data-oe-load-paths]")) { void loadPaths(false); return; }
  const history = event.target.closest("[data-oe-collection-history]");
  if (history) { document.querySelector('[data-view-panel="snapshots"]')?.classList.toggle("oe-show-legacy-collection"); history.textContent = history.textContent.includes("Show") ? "Hide collection history" : "Show collection history"; return; }
  if (event.target.closest("[data-oe-back-findings]")) { clearFocusedFinding(); renderFindingQueue(); return; }
  const tab = event.target.closest("[data-oe-investigation-tab]");
  if (tab) { oeState.focusedTab = tab.dataset.oeInvestigationTab; renderFocusedInvestigation(); return; }
  if (event.target.closest("[data-oe-load-findings]")) { void loadInvestigations(false); return; }
  const save = event.target.closest("[data-oe-save-note]");
  if (save) { const findingData = oeState.focusedFinding?.finding; if (findingData) { try { sessionStorage.setItem(noteKey(findingData.finding_id), oe$("oeInvestigationNote")?.value || ""); } catch {} save.textContent = "Saved for this session"; setTimeout(() => { save.textContent = "Save session note"; }, 1200); } }
}

function handleChange(event) {
  if (event.target?.id === "oePathSelect") { oeState.selectedPath = Math.max(0, Number(event.target.value || 0)); renderPaths(); return; }
  if (event.target?.matches("[data-oe-check-index]")) { const finding = oeState.focusedFinding?.finding; if (!finding) return; const checked = [...document.querySelectorAll("[data-oe-check-index]")].filter((input) => input.checked).map((input) => Number(input.dataset.oeCheckIndex)); try { sessionStorage.setItem(checkKey(finding.finding_id), JSON.stringify(checked)); } catch {} }
}

function handleSubmit(event) {
  if (event.target?.id !== "oeExploreForm") return;
  event.preventDefault();
  oeState.exploreQuery = oe$("oeExploreInput")?.value.trim() || "";
  void runExplore();
}

function installOperatorExperience() {
  installStyles();
  polishShell();
  installScreens();
  try { oeState.focusedFindingId = sessionStorage.getItem("osi.oe.focus") || null; } catch {}
  document.addEventListener("click", handleClick);
  document.addEventListener("change", handleChange);
  document.addEventListener("submit", handleSubmit);
  void refreshView("overview");
}

window.osiRefreshOperatorExperience = refreshView;
setTimeout(installOperatorExperience, 0);
