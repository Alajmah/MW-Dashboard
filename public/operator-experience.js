const OE_REVISION = "20260915-1";

const oeState = {
  core: null,
  attentionFindings: [],
  findings: [],
  findingTotals: { open: 0, acknowledged: 0 },
  findingOffset: 0,
  findingHasMore: false,
  findingLoading: false,
  focusedFindingId: null,
  focusedFinding: null,
  focusedRelatedFindings: [],
  focusedTab: "overview",
  paths: [],
  pathGaps: [],
  selectedPath: 0,
  exploreQuery: "",
  exploreType: "",
  exploreResults: [],
  exploreTotal: 0,
  exploreSelected: null,
  exploreSummary: null,
};

const oe$ = (id) => document.getElementById(id);
const oeEsc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

async function oeApi(path) {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) throw new Error(body.detail || `Request failed (${response.status})`);
  return body;
}

async function oePaged(path, key, maxPages = 20) {
  const items = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const data = await oeApi(`${path}${path.includes("?") ? "&" : "?"}limit=100&offset=${offset}`);
    items.push(...(Array.isArray(data[key]) ? data[key] : []));
    const next = Number(data.page?.next_offset);
    if (data.page?.next_offset == null || !Number.isFinite(next) || next <= offset) break;
    offset = next;
  }
  return items;
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
  if (["critical", "failed", "stale"].includes(v)) return "danger";
  if (["warning", "unknown", "partial", "not_collected", "not observed", "not_observed"].includes(v)) return "warn";
  if (["current", "observed", "success", "qualified"].includes(v)) return "good";
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
    <div class="oe-page-head"><div><h2>Operations</h2><p>A focused view of what needs attention across the evidence-backed estate.</p></div><button class="oe-button ghost" data-oe-refresh="overview">Refresh</button></div>
    <div id="oeOpsMetrics" class="oe-metrics oe-metrics-4"><div class="oe-loading">Reading operational state…</div></div>
    <section class="oe-panel"><div class="oe-section-head"><div><h3>Operational attention</h3><p>Highest-priority current findings only.</p></div><button class="oe-link" data-oe-nav="investigations">Review all findings</button></div><div id="oeAttentionTable"></div></section>
    <div class="oe-grid-2">
      <section class="oe-panel"><div class="oe-section-head"><div><h3>Affected paths</h3><p>Qualified service paths and their current evidence boundaries.</p></div><button class="oe-link" data-oe-nav="routes">Open Paths</button></div><div id="oeAffectedPaths" class="oe-rows"></div></section>
      <section class="oe-panel"><div class="oe-section-head"><div><h3>Knowledge limitations</h3><p>Unknowns that constrain interpretation.</p></div></div><div id="oeKnowledgeLimits" class="oe-rows"></div></section>
    </div>`);

  ensureScreen("routes", "oePaths", `
    <div class="oe-page-head"><div><h2>Paths</h2><p>Follow an evidence-backed service path without turning topology into a transaction claim.</p></div><button class="oe-button ghost" data-oe-route-advanced>Advanced trace</button></div>
    <section class="oe-panel oe-path-selector-panel"><label><span>Select a qualified service path</span><select id="oePathSelect"><option>Loading paths…</option></select></label><button class="oe-button ghost" data-oe-nav="investigations">View findings</button></section>
    <section id="oePathFocus" class="oe-panel"><div class="oe-loading">Loading qualified paths…</div></section>
    <section class="oe-panel"><div class="oe-section-head"><div><h3>Path details</h3><p>Compact topology facts for the selected path.</p></div></div><div id="oePathDetails"></div></section>
    <details id="oePathEvidence" class="oe-panel oe-evidence-disclosure"><summary>Inspect route evidence</summary><div id="oePathEvidenceBody"></div></details>`);

  ensureScreen("inventory", "oeExplore", `
    <div class="oe-page-head"><div><h2>Explore</h2><p>Search the canonical estate, then reveal detail only for the object you care about.</p></div></div>
    <form id="oeExploreForm" class="oe-explore-search"><span>⌕</span><input id="oeExploreInput" type="search" autocomplete="off" placeholder="Search names or canonical identities…"><button class="oe-button" type="submit">Search</button></form>
    <div id="oeExploreChips" class="oe-filter-chips"></div>
    <div class="oe-explore-layout">
      <section class="oe-panel"><div class="oe-section-head"><div><h3 id="oeExploreCount">Results</h3><p>25 results per query to keep scanning manageable.</p></div></div><div id="oeExploreResults" class="oe-result-list"><div class="oe-loading">Loading canonical entities…</div></div></section>
      <aside class="oe-panel oe-object-inspector"><div id="oeExploreDetail" class="oe-empty-state"><strong>Select an object</strong><p>Overview, relationships and evidence appear here.</p></div></aside>
    </div>`);

  ensureScreen("investigations", "oeInvestigations", `<div id="oeInvestigationRoot"><div class="oe-loading">Loading investigation workspace…</div></div>`);

  ensureScreen("snapshots", "oeCollection", `
    <div class="oe-page-head"><div><h2>Collection</h2><p>Understand data trust, evidence freshness and collection limits without equating collection with health.</p></div><div class="oe-head-actions"><button class="oe-button ghost" data-oe-nav="administration">Import evidence</button><button class="oe-button ghost" data-oe-refresh="snapshots">Refresh</button></div></div>
    <div id="oeCollectionMetrics" class="oe-metrics oe-metrics-5"><div class="oe-loading">Reading evidence state…</div></div>
    <div class="oe-grid-collection">
      <section class="oe-panel"><div class="oe-section-head"><div><h3>Evidence domains</h3><p>Observed canonical entities by technology/domain. These bars are volume, not health or completeness percentages.</p></div></div><div id="oeDomainTable"></div></section>
      <section class="oe-panel"><div class="oe-section-head"><div><h3>Interpretation boundary</h3><p>What the current collection can and cannot establish.</p></div></div><div id="oeCollectionBoundary"></div></section>
    </div>
    <button class="oe-link oe-history-link" data-oe-collection-history>Show collection history</button>`);
}

async function loadCore() {
  const [estateStatus, estateSummary, operations, importStatus, telemetry, open, acknowledged, unresolved] = await Promise.all([
    oeApi("/api/v2/estate/status"),
    oeApi("/api/v2/estate/current/summary"),
    oeApi("/api/v2/operations/status"),
    oeApi("/api/v2/import/status"),
    oeApi("/api/v2/telemetry/status"),
    oeApi("/api/v2/findings/current?status=OPEN&limit=6&offset=0"),
    oeApi("/api/v2/findings/current?status=ACKNOWLEDGED&limit=6&offset=0"),
    oeApi("/api/v2/estate/current/unresolved?limit=12&offset=0"),
  ]);
  oeState.core = { estateStatus, estateSummary, operations, importStatus, telemetry, unresolved };
  oeState.attentionFindings = [...(open.findings || []), ...(acknowledged.findings || [])]
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || new Date(b.last_seen || 0) - new Date(a.last_seen || 0));
  oeState.findingTotals = { open: Number(open.page?.total || 0), acknowledged: Number(acknowledged.page?.total || 0) };
  oeState.exploreSummary = estateSummary;
}

function severityRank(value) { return value === "critical" ? 0 : value === "warning" ? 1 : 2; }

async function ensurePaths() {
  if (oeState.paths.length || oeState.pathGaps.length) return;
  const [flows, endpoints, relations, gaps] = await Promise.all([
    oePaged("/api/v2/estate/current/entities?semantic_type=filetransfer.flow", "entities"),
    oePaged("/api/v2/estate/current/entities?semantic_type=filetransfer.endpoint", "entities"),
    oePaged("/api/v2/estate/current/relations?semantic_type=integration.routes_to", "relations"),
    oePaged("/api/v2/estate/current/unresolved?semantic_type=filetransfer.endpoint", "unresolved"),
  ]);
  const flowIds = new Set(flows.map((item) => String(item.entity_id)));
  const endpointIds = new Set(endpoints.map((item) => String(item.entity_id)));
  const candidates = relations.filter((relation) => flowIds.has(String(relation.source_entity_id)) && endpointIds.has(String(relation.target_entity_id)));
  oeState.paths = (await Promise.all(candidates.map(async (relation) => {
    try {
      const trace = await oeApi(`/api/v2/routes/trace?from=${encodeURIComponent(relation.source_entity_id)}&to=${encodeURIComponent(relation.target_entity_id)}`);
      return trace?.found && trace?.semantics?.route_domain === "file_transfer" && trace?.semantics?.qualified_route === true ? trace : null;
    } catch { return null; }
  }))).filter(Boolean).sort((a, b) => String(a.source?.display_name || "").localeCompare(String(b.source?.display_name || "")));
  oeState.pathGaps = gaps;
}

function routeScope(trace) {
  const semantics = trace?.semantics || {};
  const step = trace?.steps?.[0] || {};
  const siteAccess = semantics.site_access_evidence || {};
  const listener = semantics.current_listener_evidence || {};
  const corroboration = Array.isArray(semantics.runtime_corroboration) ? semantics.runtime_corroboration : [];
  const runtime = corroboration[0] || {};
  const gateway = step.properties?.gateway_server_key || runtime.gateway_server_key || "DMZ gateway";
  const sourceKinds = Array.isArray(runtime.sources)
    ? [...new Set(runtime.sources.map((item) => item?.source_kind).filter(Boolean))].map((value) => String(value).replaceAll("_", " "))
    : [];
  return { siteAccess, listener, corroboration, runtime, gateway, sourceKinds };
}

function pathNode(kind, title, state, note, style) {
  const icon = kind === "Access context" ? "◉" : kind === "DMZ listener" ? "⌁" : kind === "PNC boundary" ? "◇" : "▣";
  return `<div class="oe-path-node"><span>${oeEsc(kind)}</span><div class="oe-path-icon">${icon}</div><strong>${oeEsc(title)}</strong><small>${oeEsc(note)}</small>${badge(state, style)}</div>`;
}

function renderOperations() {
  const { estateStatus, operations, unresolved } = oeState.core || {};
  if (!estateStatus) return;
  const estate = estateStatus.current_estate || {};
  const attention = oeState.attentionFindings.slice(0, 6);
  oe$("oeOpsMetrics").innerHTML = [
    metric("Open findings", oeState.findingTotals.open.toLocaleString(), "Current evidence-linked items", oeState.findingTotals.open ? "danger" : "good", "△"),
    metric("Qualified paths", oeState.paths.length.toLocaleString(), "Evidence-backed file-transfer paths", oeState.paths.length ? "info" : "neutral", "⌁"),
    metric("Knowledge gaps", Number(estate.unresolved_count || 0).toLocaleString(), "Canonical unresolved references", Number(estate.unresolved_count || 0) ? "warn" : "good", "?"),
    metric("Estate freshness", estateStatus.estate_fresh ? "Current" : "Stale", `${Number(estate.entity_count || 0).toLocaleString()} canonical entities`, estateStatus.estate_fresh ? "good" : "danger", "●"),
  ].join("");
  oe$("oeAttentionTable").innerHTML = attention.length ? `<div class="oe-attention-head"><span>Severity</span><span>Item</span><span>Context</span><span>Detected</span></div>${attention.map((finding) => `<button class="oe-attention-row" type="button" data-oe-finding="${oeEsc(finding.finding_id)}"><span>${badge(finding.severity || "info", tone(finding.severity))}</span><span><strong>${oeEsc(finding.display_name || finding.entity_id || "Finding")}</strong><small>${oeEsc(finding.summary || finding.diagnosis || "Evidence-linked operational finding")}</small></span><span>${oeEsc(typeLabel(finding.semantic_type))}</span><span>${oeEsc(relativeTime(finding.last_seen))}</span></button>`).join("")}` : `<div class="oe-empty-state"><strong>No unresolved findings in current evaluations</strong><p>This remains bounded by published evidence coverage.</p></div>`;
  oe$("oeAffectedPaths").innerHTML = oeState.paths.slice(0, 4).map((trace, index) => {
    const scope = routeScope(trace);
    const current = scope.listener.time_scope === "current" && scope.corroboration.some((item) => item?.time_scope === "current" && item?.independently_corroborated === true);
    return `<button class="oe-context-row" type="button" data-oe-path-index="${index}"><span><strong>${oeEsc(trace.source?.display_name || "Source")} → ${oeEsc(trace.target?.display_name || "Destination")}</strong><small>${current ? "Current runtime boundary supported" : "Runtime boundary incomplete"}</small></span>${badge("Qualified", "good")}</button>`;
  }).join("") || `<div class="oe-empty-state"><p>No qualified service paths in the current projection.</p></div>`;
  const gaps = unresolved?.unresolved || [];
  oe$("oeKnowledgeLimits").innerHTML = gaps.slice(0, 4).map((gap) => `<div class="oe-context-row"><span><strong>${oeEsc(gap.vendor_value || gap.expected_target_type || "Unresolved reference")}</strong><small>${oeEsc(gap.reason || "Evidence-backed mapping is incomplete")}</small></span>${badge(gap.state || "unknown", "warn")}</div>`).join("") || `<div class="oe-empty-state"><strong>No unresolved references returned in this slice</strong><p>Published operational coverage gaps: ${Number(operations?.current_coverage_gaps || 0).toLocaleString()}.</p></div>`;
}

function renderPaths() {
  const select = oe$("oePathSelect");
  if (!select) return;
  if (!oeState.paths.length) {
    select.innerHTML = `<option>No qualified file-transfer paths</option>`;
    select.disabled = true;
    oe$("oePathFocus").innerHTML = `<div class="oe-empty-state"><strong>No qualified paths available</strong><p>The canonical estate does not currently expose a qualified file-transfer path.</p></div>`;
    oe$("oePathDetails").innerHTML = "";
    oe$("oePathEvidenceBody").innerHTML = "";
    return;
  }
  select.disabled = false;
  select.innerHTML = oeState.paths.map((trace, index) => `<option value="${index}"${index === oeState.selectedPath ? " selected" : ""}>${oeEsc(trace.source?.display_name || "Source")} → ${oeEsc(trace.target?.display_name || "Destination")}</option>`).join("");
  const trace = oeState.paths[oeState.selectedPath] || oeState.paths[0];
  const scope = routeScope(trace);
  const semantics = trace.semantics || {};
  const completion = semantics.transfer_completion || "unknown";
  const listenerCurrent = scope.listener.time_scope === "current";
  const pncCurrent = scope.corroboration.some((item) => item?.time_scope === "current" && item?.independently_corroborated === true);
  const source = trace.source?.display_name || "Access context";
  const target = trace.target?.display_name || "EFT Site";
  const pnc = scope.runtime.endpoint || "PNC boundary";
  const runtimeSources = scope.sourceKinds.length ? scope.sourceKinds.join(" + ") : "runtime source unavailable";
  oe$("oePathFocus").innerHTML = `<div class="oe-path-head"><div><span>Path</span><h3>${oeEsc(source)} → ${oeEsc(target)}</h3><p>${oeEsc(trace.explanation || "Evidence-qualified topology path")}</p></div><div>${badge("Qualified", "good")} ${badge(`${oeState.pathGaps.length} mapping gap${oeState.pathGaps.length === 1 ? "" : "s"}`, oeState.pathGaps.length ? "warn" : "good")}</div></div><div class="oe-path-lane">${pathNode("Access context", source, scope.siteAccess.time_scope === "historical" ? "Historical" : "Unknown", scope.siteAccess.time_scope === "historical" ? "Observed Site-access window retained" : "Site-access evidence not classified", scope.siteAccess.time_scope === "historical" ? "info" : "warn")}<div class="oe-path-arrow">→</div>${pathNode("DMZ listener", scope.listener.endpoint || "Listener endpoint", listenerCurrent ? "Current" : "Unknown", String(scope.gateway), listenerCurrent ? "good" : "warn")}<div class="oe-path-arrow">→</div>${pathNode("PNC boundary", pnc, pncCurrent ? "Corroborated" : "Unknown", runtimeSources, pncCurrent ? "good" : "warn")}<div class="oe-path-arrow">→</div>${pathNode("EFT Site", target, "Topology destination", "Canonical endpoint; traversal is not implied", "info")}</div><div class="oe-path-actions"><button class="oe-button" data-oe-open-evidence>Inspect route evidence</button><button class="oe-button ghost" data-oe-nav="investigations">Related findings</button></div>`;
  oe$("oePathDetails").innerHTML = `<div class="oe-path-detail-grid"><div><span>Source</span><strong>${oeEsc(source)}</strong></div><div><span>Destination</span><strong>${oeEsc(target)}</strong></div><div><span>Topology</span><strong>${oeEsc(semantics.derived_epistemic || "qualified")}</strong></div><div><span>Runtime boundary</span><strong>${listenerCurrent && pncCurrent ? "current" : "incomplete"}</strong></div><div><span>Transfer completion</span><strong>${oeEsc(String(completion).replaceAll("_", " "))}</strong></div><div><span>Canonical gaps</span><strong>${oeState.pathGaps.length.toLocaleString()}</strong></div></div>`;
  const rows = [
    ["Site activity", scope.siteAccess.time_scope || "unknown", scope.siteAccess.activity_window_start || "No start", scope.siteAccess.activity_window_end || "No end"],
    ["Listener", listenerCurrent ? "current observed" : "unknown", scope.listener.endpoint || "No endpoint", String(scope.gateway)],
    ["PNC boundary", pncCurrent ? "current corroborated" : "unknown", pnc, runtimeSources],
    ["Transfer outcome", String(completion).replaceAll("_", " "), "Independent from route qualification", "No transaction animation or implied success"],
  ];
  oe$("oePathEvidenceBody").innerHTML = `<div class="oe-evidence-table">${rows.map(([name, state, a, b]) => `<div><span>${oeEsc(name)}</span><strong>${oeEsc(state)}</strong><small>${oeEsc(a)} · ${oeEsc(b)}</small></div>`).join("")}</div>`;
}

function exploreChips(summary) {
  const counts = summary?.entities_by_type || {};
  const preferred = ["filetransfer.flow", "filetransfer.endpoint", "mq.listener", "mq.queue_manager", "mq.queue", "mq.channel", "infra.host", "app.application"];
  const available = preferred.filter((type) => Number(counts[type] || 0) > 0).slice(0, 6);
  return [{ type: "", label: "All types", count: Number(summary?.counts?.entities || 0) }, ...available.map((type) => ({ type, label: typeLabel(type), count: Number(counts[type] || 0) }))];
}

async function runExplore() {
  const params = new URLSearchParams({ limit: "25", offset: "0" });
  if (oeState.exploreQuery) params.set("q", oeState.exploreQuery);
  if (oeState.exploreType) params.set("semantic_type", oeState.exploreType);
  const data = await oeApi(`/api/v2/estate/current/entities?${params}`);
  oeState.exploreResults = data.entities || [];
  oeState.exploreTotal = Number(data.page?.total || oeState.exploreResults.length);
  renderExplore();
}

function renderExplore() {
  oe$("oeExploreChips").innerHTML = exploreChips(oeState.exploreSummary).map((chip) => `<button type="button" class="oe-chip${chip.type === oeState.exploreType ? " active" : ""}" data-oe-type="${oeEsc(chip.type)}">${oeEsc(chip.label)} <span>${chip.count.toLocaleString()}</span></button>`).join("");
  oe$("oeExploreCount").textContent = `Results (${oeState.exploreTotal.toLocaleString()})`;
  oe$("oeExploreResults").innerHTML = oeState.exploreResults.length ? oeState.exploreResults.map((entity) => `<button class="oe-result-row${oeState.exploreSelected?.entity?.entity_id === entity.entity_id ? " active" : ""}" type="button" data-oe-entity="${oeEsc(entity.entity_id)}"><span class="oe-result-icon">${String(entity.semantic_type || "").startsWith("mq.") ? "▦" : String(entity.semantic_type || "").startsWith("filetransfer.") ? "⇄" : "◇"}</span><span><strong>${oeEsc(entity.display_name || entity.identity_key)}</strong><small>${oeEsc(typeLabel(entity.semantic_type))} · ${oeEsc((entity.evidence_classes || []).join(" · ") || "evidence unknown")}</small></span>${badge(entity.identity_state || "canonical", entity.identity_state === "conflicted" ? "warn" : "good")}</button>`).join("") : `<div class="oe-empty-state"><strong>No canonical entities match</strong><p>Adjust the search or semantic-type filter.</p></div>`;
}

async function selectExploreEntity(entityId) {
  const detail = await oeApi(`/api/v2/estate/current/entities/${encodeURIComponent(entityId)}?relation_limit=40`);
  oeState.exploreSelected = detail;
  renderExplore();
  const entity = detail.entity || {};
  const relations = detail.relations || [];
  const properties = entity.properties && typeof entity.properties === "object" ? Object.entries(entity.properties).slice(0, 8) : [];
  oe$("oeExploreDetail").innerHTML = `<div class="oe-inspector-head"><span class="oe-result-icon large">◇</span><div><h3>${oeEsc(entity.display_name || entity.identity_key || "Entity")}</h3><p>${oeEsc(typeLabel(entity.semantic_type))}</p>${badge(entity.identity_state || "canonical", entity.identity_state === "conflicted" ? "warn" : "good")}</div></div><div class="oe-tabs"><button class="active" type="button">Overview</button><button type="button" disabled>Related (${relations.length})</button><button type="button" disabled>Evidence (${Number(entity.evidence_count || 0)})</button></div><dl class="oe-inspector-facts"><div><dt>Canonical identity</dt><dd>${oeEsc(entity.identity_key || "—")}</dd></div><div><dt>Identity rule</dt><dd>${oeEsc(entity.identity_rule || "—")}</dd></div><div><dt>Observed</dt><dd>${oeEsc(relativeTime(entity.observed_at))}</dd></div><div><dt>Sources</dt><dd>${Number(entity.source_count || 0).toLocaleString()}</dd></div><div><dt>Evidence classes</dt><dd>${oeEsc((entity.evidence_classes || []).join(", ") || "unknown")}</dd></div><div><dt>Relationships</dt><dd>${relations.length.toLocaleString()}</dd></div></dl>${properties.length ? `<div class="oe-inspector-section"><h4>Key properties</h4>${properties.map(([key, value]) => `<div class="oe-property-row"><span>${oeEsc(key)}</span><strong>${oeEsc(Array.isArray(value) ? value.join(", ") : typeof value === "object" ? JSON.stringify(value) : value)}</strong></div>`).join("")}</div>` : ""}<div class="oe-inspector-section"><h4>Related canonical entities</h4>${relations.slice(0, 6).map((relation) => `<div class="oe-property-row"><span>${oeEsc(relation.semantic_type)}</span><strong>${oeEsc(relation.source_entity_id === entity.entity_id ? relation.target_entity_id : relation.source_entity_id)}</strong></div>`).join("") || `<p>No relationships returned in this slice.</p>`}</div>`;
}

function investigationQueueMarkup() {
  const total = oeState.findingTotals.open + oeState.findingTotals.acknowledged;
  return `<div class="oe-page-head"><div><h2>Investigations</h2><p>Choose one evidence-linked problem and carry only its relevant context forward.</p></div><button class="oe-button ghost" data-oe-refresh="investigations">Refresh</button></div><div class="oe-metrics oe-metrics-3">${metric("Open", oeState.findingTotals.open.toLocaleString(), "Current findings", oeState.findingTotals.open ? "danger" : "good", "△")}${metric("Acknowledged", oeState.findingTotals.acknowledged.toLocaleString(), "Still current", "info", "●")}${metric("Review queue", total.toLocaleString(), "Paginated; nothing silently hidden", "neutral", "≡")}</div><section class="oe-panel"><div class="oe-section-head"><div><h3>Investigation queue</h3><p>Severity first, then recency.</p></div></div><div id="oeFindingQueue" class="oe-finding-queue"></div><div id="oeFindingLoadMore" class="oe-load-more"></div></section>`;
}

function renderFindingQueue() {
  const root = oe$("oeInvestigationRoot");
  if (!root) return;
  root.innerHTML = investigationQueueMarkup();
  oe$("oeFindingQueue").innerHTML = oeState.findings.length ? oeState.findings.map((finding) => `<button class="oe-finding-row" type="button" data-oe-finding="${oeEsc(finding.finding_id)}"><span>${badge(finding.severity || "info", tone(finding.severity))}</span><span><strong>${oeEsc(finding.display_name || finding.entity_id)}</strong><small>${oeEsc(finding.summary || finding.diagnosis || "Evidence-linked finding")}</small></span><span>${oeEsc(finding.status || "OPEN")}<small>${oeEsc(relativeTime(finding.last_seen))}</small></span><span>Focus →</span></button>`).join("") : `<div class="oe-empty-state"><strong>No current findings</strong><p>Absence of findings is bounded by published evidence coverage.</p></div>`;
  oe$("oeFindingLoadMore").innerHTML = oeState.findingHasMore ? `<button class="oe-button ghost" data-oe-load-findings>Load more findings</button>` : "";
}

async function fetchFindingPage(reset = false) {
  if (oeState.findingLoading) return;
  oeState.findingLoading = true;
  try {
    if (reset) { oeState.findings = []; oeState.findingOffset = 0; oeState.findingHasMore = false; }
    const pageSize = 20;
    const [open, acknowledged] = await Promise.all([
      oeApi(`/api/v2/findings/current?status=OPEN&limit=${pageSize}&offset=${oeState.findingOffset}`),
      oeApi(`/api/v2/findings/current?status=ACKNOWLEDGED&limit=${pageSize}&offset=${oeState.findingOffset}`),
    ]);
    const known = new Set(oeState.findings.map((finding) => finding.finding_id));
    [...(open.findings || []), ...(acknowledged.findings || [])].forEach((finding) => { if (!known.has(finding.finding_id)) oeState.findings.push(finding); });
    oeState.findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || new Date(b.last_seen || 0) - new Date(a.last_seen || 0));
    oeState.findingTotals = { open: Number(open.page?.total || 0), acknowledged: Number(acknowledged.page?.total || 0) };
    oeState.findingOffset += pageSize;
    oeState.findingHasMore = open.page?.next_offset != null || acknowledged.page?.next_offset != null;
  } finally { oeState.findingLoading = false; }
}

async function focusFinding(id) {
  oeState.focusedFindingId = id;
  oeState.focusedTab = "overview";
  try { sessionStorage.setItem("osi.oe.focus", id); } catch {}
  const detail = await oeApi(`/api/v2/findings/current/${encodeURIComponent(id)}`);
  oeState.focusedFinding = detail;
  const entityId = detail.finding?.entity_id;
  oeState.focusedRelatedFindings = entityId ? (await oeApi(`/api/v2/findings/current?entity_id=${encodeURIComponent(entityId)}&limit=20&offset=0`)).findings?.filter((item) => item.finding_id !== id) || [] : [];
  renderFocusedInvestigation();
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
  const tabs = [["overview", "Overview"], ["context", "Path context"], ["related", `Related findings (${oeState.focusedRelatedFindings.length})`], ["evidence", `Evidence (${Array.isArray(finding.evidence) ? finding.evidence.length : 0})`], ["notes", "Notes"]];
  root.innerHTML = `<div class="oe-investigation-head"><div><button class="oe-link" data-oe-back-findings>← Back to findings</button><h2>Investigating: ${oeEsc(finding.display_name || finding.entity_id)}</h2><p>${oeEsc(finding.summary || finding.diagnosis || "Evidence-linked operational finding")}</p></div>${badge(finding.status || "OPEN", finding.status === "OPEN" ? "warn" : "info")}</div><div class="oe-tabs oe-investigation-tabs">${tabs.map(([key, label]) => `<button type="button" class="${oeState.focusedTab === key ? "active" : ""}" data-oe-investigation-tab="${key}">${oeEsc(label)}</button>`).join("")}</div><div id="oeInvestigationTabBody"></div>`;
  renderInvestigationTab();
}

function matchedPathForFinding(finding) {
  const refs = new Set([finding.entity_id, ...(Array.isArray(finding.related_entities) ? finding.related_entities : [])].map(String));
  return oeState.paths.find((trace) => refs.has(String(trace.source?.entity_id)) || refs.has(String(trace.target?.entity_id))) || null;
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
    body.innerHTML = `<div class="oe-investigation-grid"><section class="oe-panel"><div class="oe-section-head"><div><h3>Finding summary</h3><p>What is currently claimed and where it is anchored.</p></div><button class="oe-link" data-oe-inspect-entity="${oeEsc(finding.entity_id)}">View in Explore</button></div><div class="oe-investigation-copy"><strong>${oeEsc(finding.diagnosis || finding.summary || "No diagnosis supplied")}</strong><p>Entity: ${oeEsc(finding.entity_id)} · ${oeEsc(typeLabel(finding.semantic_type))}</p>${badge(finding.coverage_state || "unknown", tone(finding.coverage_state))}</div><div class="oe-key-questions"><h4>Key questions</h4><div><b>1</b><span>What evidence directly supports this finding?</span></div><div><b>2</b><span>Which related entities are operationally relevant?</span></div><div><b>3</b><span>Does the current coverage limit the conclusion?</span></div></div></section><section class="oe-panel"><div class="oe-section-head"><div><h3>Next steps</h3><p>Browser-session working checklist; not a persistent case record.</p></div></div><div class="oe-checklist">${tasks.map((task, index) => `<label><input type="checkbox" data-oe-check-index="${index}"${checks.includes(index) ? " checked" : ""}><span>${oeEsc(task)}</span></label>`).join("")}</div><div class="oe-note-box"><label>Working note <small>this browser session only</small><textarea id="oeInvestigationNote" placeholder="Add a note, observation, or hypothesis…">${oeEsc(getNote(finding.finding_id))}</textarea></label><button class="oe-button ghost" data-oe-save-note>Save session note</button></div></section><aside class="oe-panel"><div class="oe-section-head"><div><h3>Status</h3><p>Current finding state.</p></div></div>${statusBlock(finding)}<div class="oe-tag-box"><span>Tags</span>${badge(finding.semantic_type || "entity", "info")} ${badge(finding.coverage_state || "unknown", tone(finding.coverage_state))} ${badge(`${evidence.length} evidence refs`, "neutral")}</div></aside></div>`;
  } else if (oeState.focusedTab === "context") {
    const path = matchedPathForFinding(finding);
    body.innerHTML = `<section class="oe-panel"><div class="oe-section-head"><div><h3>Path context</h3><p>Only canonical or qualified topology context is shown.</p></div></div>${path ? `<div class="oe-path-mini"><strong>${oeEsc(path.source?.display_name)} → ${oeEsc(path.target?.display_name)}</strong><p>${oeEsc(path.explanation || "Qualified topology route")}</p>${badge("Qualified", "good")}</div>` : `<div class="oe-empty-state"><strong>No qualified service path matched this finding</strong><p>The finding remains anchored to its canonical entity and related-entity references.</p></div>`}<div class="oe-related-ids">${related.map((id) => `<button class="oe-chip" data-oe-inspect-entity="${oeEsc(id)}">${oeEsc(id)}</button>`).join("")}</div></section>`;
  } else if (oeState.focusedTab === "related") {
    body.innerHTML = `<section class="oe-panel"><div class="oe-section-head"><div><h3>Related findings</h3><p>Other current findings anchored to the same canonical entity.</p></div></div><div class="oe-rows">${oeState.focusedRelatedFindings.map((item) => `<button class="oe-context-row" data-oe-finding="${oeEsc(item.finding_id)}"><span><strong>${oeEsc(item.display_name || item.entity_id)}</strong><small>${oeEsc(item.summary || item.diagnosis || "Evidence-linked finding")}</small></span>${badge(item.severity || "info", tone(item.severity))}</button>`).join("") || `<div class="oe-empty-state"><p>No additional current findings are anchored to this entity.</p></div>`}</div></section>`;
  } else if (oeState.focusedTab === "evidence") {
    body.innerHTML = `<div class="oe-grid-2"><section class="oe-panel"><div class="oe-section-head"><div><h3>Evidence references</h3><p>Exact references supplied by the finding evaluation.</p></div></div><div class="oe-evidence-list">${evidence.map((item) => `<pre>${oeEsc(typeof item === "string" ? item : JSON.stringify(item, null, 2))}</pre>`).join("") || `<div class="oe-empty-state"><p>No evidence references supplied.</p></div>`}</div></section><section class="oe-panel"><div class="oe-section-head"><div><h3>Current occurrences</h3><p>Evaluation occurrences for this finding.</p></div></div><div class="oe-rows">${(detail.occurrences || []).map((occurrence) => `<div class="oe-context-row"><span><strong>${oeEsc(occurrence.source_id || occurrence.source_host || "evaluation source")}</strong><small>${oeEsc(relativeTime(occurrence.last_seen))} · ${oeEsc(occurrence.evaluation_revision_id || "")}</small></span>${badge("current", "good")}</div>`).join("")}</div></section></div>`;
  } else {
    body.innerHTML = `<section class="oe-panel oe-notes-panel"><div class="oe-section-head"><div><h3>Working notes</h3><p>Session-local notes deliberately do not mutate canonical state or create an incident record.</p></div></div><textarea id="oeInvestigationNote" placeholder="Add a note, observation, or hypothesis…">${oeEsc(getNote(finding.finding_id))}</textarea><button class="oe-button" data-oe-save-note>Save session note</button></section>`;
  }
}

function domainRollup(summary) {
  const counts = summary?.entities_by_type || {};
  const groups = [["IBM MQ", (type) => type.startsWith("mq.")], ["File transfer", (type) => type.startsWith("filetransfer.")], ["Applications", (type) => type.startsWith("app.")], ["Infrastructure", (type) => type.startsWith("infra.")], ["Integration", (type) => type.startsWith("ace.") || type.startsWith("datapower.") || type.startsWith("integration.")]];
  return groups.map(([name, test]) => [name, Object.entries(counts).filter(([type]) => test(type)).reduce((sum, [, count]) => sum + Number(count || 0), 0)]).filter(([, count]) => count > 0);
}

function renderCollection() {
  const { estateStatus, estateSummary, operations, importStatus, telemetry } = oeState.core || {};
  if (!estateStatus) return;
  const estate = estateStatus.current_estate || {};
  oe$("oeCollectionMetrics").innerHTML = [metric("Semantic sources", Number(importStatus.current_sources || 0).toLocaleString(), "Current source revisions", Number(importStatus.current_sources || 0) ? "good" : "warn", "▣"), metric("Estate freshness", estateStatus.estate_fresh ? "Current" : "Stale", `${Number(estate.entity_count || 0).toLocaleString()} entities`, estateStatus.estate_fresh ? "good" : "danger", "●"), metric("Operational findings", Number(operations.current_findings || 0).toLocaleString(), `${Number(operations.current_observations || 0).toLocaleString()} observations`, "info", "◇"), metric("Unresolved mappings", Number(estate.unresolved_count || 0).toLocaleString(), "Canonical references", Number(estate.unresolved_count || 0) ? "warn" : "good", "?"), metric("Telemetry ingress", telemetry.ingress_enabled ? "Enabled" : "Disabled", telemetry.mode || "mode unknown", telemetry.ingress_enabled ? "good" : "neutral", "↯")].join("");
  const domains = domainRollup(estateSummary);
  const max = Math.max(1, ...domains.map(([, count]) => count));
  oe$("oeDomainTable").innerHTML = `<div class="oe-domain-head"><span>Domain</span><span>Observed entities</span><span>Relative volume</span></div>${domains.map(([name, count]) => `<div class="oe-domain-row"><strong>${oeEsc(name)}</strong><span>${count.toLocaleString()}</span><span><i style="width:${Math.max(8, Math.round((count / max) * 100))}%"></i></span></div>`).join("")}`;
  oe$("oeCollectionBoundary").innerHTML = `<div class="oe-boundary-list"><div>${badge(estateStatus.estate_fresh ? "Current estate" : "Stale estate", estateStatus.estate_fresh ? "good" : "danger")}<p>Canonical estate freshness says the current source set has been reconciled; it does not prove runtime health.</p></div><div>${badge(`${Number(operations.current_coverage_gaps || 0)} published coverage gaps`, Number(operations.current_coverage_gaps || 0) ? "warn" : "good")}<p>Zero published gaps is bounded by the operational evaluation sources that exist.</p></div><div>${badge(`${Number(estate.unresolved_count || 0)} unresolved`, Number(estate.unresolved_count || 0) ? "warn" : "good")}<p>Unknown canonical relationships remain unknown rather than being converted into outages or healthy state.</p></div><div>${badge(telemetry.ingress_enabled ? "Telemetry enabled" : "Telemetry disabled", telemetry.ingress_enabled ? "good" : "neutral")}<p>${oeEsc(telemetry.mode || "Telemetry mode unknown")}.</p></div></div>`;
}

async function refreshView(view) {
  polishShell();
  try {
    if (!oeState.core) await loadCore();
    if (["overview", "routes", "investigations"].includes(view)) await ensurePaths();
    if (view === "overview") renderOperations();
    if (view === "routes") renderPaths();
    if (view === "inventory") {
      if (!oeState.exploreSummary) oeState.exploreSummary = await oeApi("/api/v2/estate/current/summary");
      if (!oeState.exploreResults.length) await runExplore(); else renderExplore();
    }
    if (view === "investigations") {
      if (oeState.focusedFindingId) {
        if (!oeState.focusedFinding) await focusFinding(oeState.focusedFindingId); else renderFocusedInvestigation();
      } else {
        if (!oeState.findings.length) await fetchFindingPage(true);
        renderFindingQueue();
      }
    }
    if (view === "snapshots") renderCollection();
  } catch (error) {
    const screen = document.querySelector(`[data-view-panel="${view}"] .oe-screen`);
    if (screen) screen.innerHTML = `<div class="oe-empty-state error"><strong>Unable to load this workspace</strong><p>${oeEsc(error instanceof Error ? error.message : String(error))}</p></div>`;
  }
}

function navigate(view) { window.osiNavigateProduct?.(view); }

function handleClick(event) {
  const nav = event.target.closest("[data-oe-nav]");
  if (nav) { navigate(nav.dataset.oeNav); return; }
  const refresh = event.target.closest("[data-oe-refresh]");
  if (refresh) {
    oeState.core = null;
    if (refresh.dataset.oeRefresh === "investigations") { oeState.findings = []; oeState.findingOffset = 0; oeState.focusedFinding = null; }
    void refreshView(refresh.dataset.oeRefresh);
    return;
  }
  const pathIndex = event.target.closest("[data-oe-path-index]");
  if (pathIndex) { oeState.selectedPath = Number(pathIndex.dataset.oePathIndex || 0); navigate("routes"); setTimeout(renderPaths, 30); return; }
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
  const history = event.target.closest("[data-oe-collection-history]");
  if (history) { document.querySelector('[data-view-panel="snapshots"]')?.classList.toggle("oe-show-legacy-collection"); history.textContent = history.textContent.includes("Show") ? "Hide collection history" : "Show collection history"; return; }
  if (event.target.closest("[data-oe-back-findings]")) { oeState.focusedFindingId = null; oeState.focusedFinding = null; oeState.focusedRelatedFindings = []; try { sessionStorage.removeItem("osi.oe.focus"); } catch {} renderFindingQueue(); return; }
  const tab = event.target.closest("[data-oe-investigation-tab]");
  if (tab) { oeState.focusedTab = tab.dataset.oeInvestigationTab; renderFocusedInvestigation(); return; }
  if (event.target.closest("[data-oe-load-findings]")) { void fetchFindingPage(false).then(renderFindingQueue); return; }
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
