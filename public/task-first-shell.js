const TASK_FIRST_UI_REVISION = "20260915-3";

const taskState = {
  findings: [],
  focus: null,
  investigationLoading: false,
  collectionLoading: false,
};

const tq = (id) => document.getElementById(id);
const tesc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

function installTaskFirstStyles() {
  if (document.querySelector('link[data-task-first-shell]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `/task-first-shell.css?v=${TASK_FIRST_UI_REVISION}`;
  link.dataset.taskFirstShell = "true";
  document.head.appendChild(link);
}

async function taskApi(path) {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) throw new Error(body.detail || `Request failed (${response.status})`);
  return body;
}

function replacePrimaryNavigation() {
  const nav = document.querySelector(".nav");
  if (!nav) return;
  nav.innerHTML = `
    <button class="nav-item active" data-view="overview">Operations</button>
    <button class="nav-item" data-view="routes">Paths</button>
    <button class="nav-item" data-view="inventory">Explore</button>
    <button class="nav-item" data-view="investigations">Investigations</button>
    <button class="nav-item" data-view="snapshots">Collection</button>`;
  const brandSubtitle = document.querySelector(".brand span");
  if (brandSubtitle) brandSubtitle.textContent = "Operational Intelligence";
}

function refineGlobalSearch() {
  document.querySelector(".task-global-search")?.remove();
  const input = tq("globalSemanticSearch");
  if (!input) return;
  input.placeholder = "Search objects, services, hosts, queues…";
  input.setAttribute("aria-label", "Search canonical estate");
  input.title = "Search canonical estate (/)";
}

function ensureOperationsAttentionLink() {
  const head = tq("operationalAttention")?.querySelector(".operational-attention-head");
  if (!head || head.querySelector(".task-attention-link")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost task-attention-link";
  button.dataset.go = "investigations";
  button.textContent = "Review all findings";
  head.appendChild(button);
}

function ensureOverviewTaskFrame() {
  const overview = tq("view-overview");
  if (!overview || tq("taskEstateContext")) {
    ensureOperationsAttentionLink();
    return;
  }

  const start = document.createElement("section");
  start.id = "taskStartActions";
  start.className = "task-start-actions";
  start.innerHTML = `
    <div><span>Start with the question</span><strong>What do you need to understand?</strong></div>
    <div class="task-start-buttons">
      <button type="button" class="ghost" data-go="routes">Trace a path</button>
      <button type="button" class="ghost" data-go="inventory">Find an object</button>
      <button type="button" class="ghost" data-go="investigations">Review findings</button>
    </div>`;

  const details = document.createElement("details");
  details.id = "taskEstateContext";
  details.className = "task-estate-context panel";
  details.innerHTML = `
    <summary><span><strong>Estate context</strong><small>Inventory, placement and reconciliation — open only when you need broader estate context.</small></span><span class="task-disclosure">Show context</span></summary>
    <div id="taskEstateContextBody" class="task-estate-context-body"></div>`;

  const body = details.querySelector("#taskEstateContextBody");
  const sections = [
    tq("overviewStats"),
    tq("overviewHosts")?.closest(".section-block"),
    tq("overviewQmgrs")?.closest(".section-block"),
    tq("evidenceSummary")?.closest(".section-block"),
  ].filter(Boolean);
  [...new Set(sections)].forEach((node) => body.appendChild(node));
  overview.append(start, details);
  details.addEventListener("toggle", () => {
    const label = details.querySelector(".task-disclosure");
    if (label) label.textContent = details.open ? "Hide context" : "Show context";
  });
  ensureOperationsAttentionLink();
}

function applyExploreDensity() {
  const pageSize = tq("inventoryOwner");
  if (!pageSize || pageSize.dataset.taskDensityApplied === "true") return;
  if (![...pageSize.options].some((option) => option.value === "25")) return;
  pageSize.dataset.taskDensityApplied = "true";
  pageSize.value = "25";
  pageSize.dispatchEvent(new Event("change", { bubbles: true }));
}

function ensureExploreTaskFrame() {
  const view = tq("view-inventory");
  const toolbar = view?.querySelector(".inventory-toolbar");
  if (!view || !toolbar) return;
  if (!tq("taskExploreIntro")) {
    const intro = document.createElement("section");
    intro.id = "taskExploreIntro";
    intro.className = "task-explore-intro";
    intro.innerHTML = `
      <div><span>Search first</span><strong>Find the object you care about, then reveal its context.</strong><p>Physical hosts, middleware objects and applications remain available as focused views without occupying the primary navigation.</p></div>
      <details><summary>Browse focused views</summary><div>
        <button type="button" class="ghost" data-go="servers">Servers</button>
        <button type="button" class="ghost" data-go="middleware">Middleware</button>
        <button type="button" class="ghost" data-go="applications">Applications</button>
      </div></details>`;
    view.insertBefore(intro, toolbar);
  }
  applyExploreDensity();
}

function ensureCollectionTaskFrame() {
  const view = tq("view-snapshots");
  if (!view || tq("collectionTrustSummary")) return;
  const section = document.createElement("section");
  section.id = "collectionTrustSummary";
  section.className = "task-collection panel";
  section.innerHTML = `
    <div class="task-section-head">
      <div><span>Data trust</span><h2>Can I trust the current evidence?</h2><p>Freshness, active sources and collection limitations are summarized here. Raw history remains available below.</p></div>
      <button type="button" class="ghost" data-go="administration">Import evidence</button>
    </div>
    <div id="collectionTrustMetrics" class="task-trust-metrics"><div class="task-loading">Reading collection state…</div></div>
    <div id="collectionTrustNote" class="task-trust-note"></div>`;
  view.prepend(section);
}

function ensureInvestigationView() {
  if (tq("view-investigations")) return;
  const main = tq("mainContent");
  const snapshots = tq("view-snapshots");
  if (!main) return;
  const section = document.createElement("section");
  section.id = "view-investigations";
  section.className = "view";
  section.dataset.viewPanel = "investigations";
  section.innerHTML = `
    <div class="task-investigation-layout">
      <section class="panel task-investigation-queue">
        <div class="task-section-head">
          <div><span>Investigation queue</span><h2>What deserves focused review?</h2><p>Current evidence-linked findings are ranked here so you can choose one problem without carrying the entire estate in your head.</p></div>
          <button id="taskRefreshInvestigations" type="button" class="ghost">Refresh</button>
        </div>
        <div id="taskInvestigationSummary" class="task-investigation-summary"></div>
        <div id="taskInvestigationRows" class="task-investigation-rows"><div class="task-loading">Loading current findings…</div></div>
      </section>
      <aside class="panel task-investigation-focus">
        <div id="taskInvestigationFocus"></div>
      </aside>
    </div>`;
  if (snapshots) main.insertBefore(section, snapshots);
  else main.appendChild(section);

  tq("taskRefreshInvestigations")?.addEventListener("click", () => refreshInvestigations(true));
  section.addEventListener("click", (event) => {
    const focus = event.target.closest("[data-focus-finding]");
    if (focus) {
      setInvestigationFocus(focus.dataset.focusFinding);
      return;
    }
    const inspect = event.target.closest("[data-inspect-finding]");
    if (inspect) {
      inspectFocusedFinding(inspect.dataset.inspectFinding);
      return;
    }
    if (event.target.closest("[data-clear-investigation]")) {
      taskState.focus = null;
      try { sessionStorage.removeItem("osi.task.investigation"); } catch {}
      renderInvestigationFocus();
    }
  });
}

function severityRank(value) {
  return value === "critical" ? 0 : value === "warning" ? 1 : 2;
}

function relativeTime(value) {
  const timestamp = new Date(value || 0).getTime();
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "time unknown";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function confidenceText(confidence) {
  const level = confidence?.level || "unknown";
  const score = Number(confidence?.score);
  return Number.isFinite(score) ? `${level} · ${Math.round(score * 100)}%` : level;
}

function investigationRow(finding) {
  const evidenceCount = Array.isArray(finding.evidence) ? finding.evidence.length : 0;
  return `<button type="button" class="task-investigation-row severity-${tesc(finding.severity || "info")}" data-focus-finding="${tesc(finding.finding_id)}">
    <span class="task-investigation-severity">${tesc(finding.severity || "info")}</span>
    <span class="task-investigation-copy"><strong>${tesc(finding.display_name || finding.entity_id || "Finding")}</strong><span>${tesc(finding.summary || finding.diagnosis || "Evidence-linked operational finding")}</span><small>${tesc(finding.status || "OPEN")} · ${tesc(confidenceText(finding.confidence))} confidence · ${evidenceCount} evidence reference${evidenceCount === 1 ? "" : "s"} · ${tesc(relativeTime(finding.last_seen))}</small></span>
    <span class="task-investigation-open">Focus →</span>
  </button>`;
}

function restoreInvestigationFocus() {
  try {
    const id = sessionStorage.getItem("osi.task.investigation");
    if (id) taskState.focus = id;
  } catch {}
}

function setInvestigationFocus(id) {
  taskState.focus = id || null;
  try {
    if (id) sessionStorage.setItem("osi.task.investigation", id);
  } catch {}
  renderInvestigationFocus();
}

function focusedFinding() {
  return taskState.findings.find((item) => item.finding_id === taskState.focus) || null;
}

function renderInvestigationFocus() {
  const target = tq("taskInvestigationFocus");
  if (!target) return;
  const finding = focusedFinding();
  if (!finding) {
    target.innerHTML = `<div class="task-focus-empty"><span>Focused workspace</span><h2>Select one finding</h2><p>The focused panel shows only the context required to decide what to inspect next. Evidence remains available on the canonical object when you need proof.</p><small>No persistent case record is created here; focus is browser-session context only.</small></div>`;
    return;
  }
  const evidenceCount = Array.isArray(finding.evidence) ? finding.evidence.length : 0;
  target.innerHTML = `
    <div class="task-focus-head"><span>Investigating</span><h2>${tesc(finding.display_name || finding.entity_id || "Finding")}</h2><p>${tesc(finding.summary || finding.diagnosis || "Evidence-linked operational finding")}</p></div>
    <div class="task-focus-facts">
      <div><span>Severity</span><strong>${tesc(finding.severity || "info")}</strong></div>
      <div><span>Lifecycle</span><strong>${tesc(finding.status || "OPEN")}</strong></div>
      <div><span>Confidence</span><strong>${tesc(confidenceText(finding.confidence))}</strong></div>
      <div><span>Coverage</span><strong>${tesc(finding.coverage_state || "unknown")}</strong></div>
      <div><span>Evidence</span><strong>${evidenceCount}</strong></div>
      <div><span>Last seen</span><strong>${tesc(relativeTime(finding.last_seen))}</strong></div>
    </div>
    <div class="task-focus-next"><span>Next action</span><strong>Inspect the canonical object and its supporting evidence.</strong><p>OSI keeps the finding, topology, runtime observations and evidence provenance separate so the investigation does not become a synthetic health claim.</p></div>
    <div class="task-focus-actions"><button type="button" data-inspect-finding="${tesc(finding.finding_id)}">Inspect object</button><button type="button" class="ghost" data-clear-investigation>Clear focus</button></div>`;
}

function inspectFocusedFinding(id) {
  const finding = taskState.findings.find((item) => item.finding_id === id);
  if (!finding) return;
  const query = finding.display_name || finding.entity_id || "";
  window.osiNavigateProduct?.("inventory");
  setTimeout(() => {
    const input = tq("inventorySearch");
    if (!input) return;
    input.value = query;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  }, 100);
}

async function refreshInvestigations(force = false) {
  if (taskState.investigationLoading) return;
  const rows = tq("taskInvestigationRows");
  if (!rows) return;
  if (!force && taskState.findings.length) {
    renderInvestigationFocus();
    return;
  }
  taskState.investigationLoading = true;
  rows.innerHTML = `<div class="task-loading">Reading current operational findings…</div>`;
  try {
    const [status, open, acknowledged] = await Promise.all([
      taskApi("/api/v2/operations/status"),
      taskApi("/api/v2/findings/current?status=OPEN&limit=20&offset=0"),
      taskApi("/api/v2/findings/current?status=ACKNOWLEDGED&limit=20&offset=0"),
    ]);
    taskState.findings = [...(open.findings || []), ...(acknowledged.findings || [])]
      .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || new Date(b.last_seen || 0) - new Date(a.last_seen || 0));
    const openCount = Number(open?.page?.total || 0);
    const ackCount = Number(acknowledged?.page?.total || 0);
    const gaps = Number(status.current_coverage_gaps || 0);
    const summary = tq("taskInvestigationSummary");
    if (summary) summary.innerHTML = `
      <div><span>Open</span><strong>${openCount.toLocaleString()}</strong></div>
      <div><span>Acknowledged</span><strong>${ackCount.toLocaleString()}</strong></div>
      <div><span>Coverage gaps</span><strong>${gaps.toLocaleString()}</strong></div>`;
    rows.innerHTML = taskState.findings.length
      ? taskState.findings.slice(0, 20).map(investigationRow).join("")
      : `<div class="task-empty"><strong>No unresolved findings in current operational evaluations</strong><span>This is bounded by published evidence coverage and does not imply that unobserved parts of the estate are healthy.</span></div>`;
    if (taskState.focus && !focusedFinding()) taskState.focus = null;
    renderInvestigationFocus();
  } catch (error) {
    rows.innerHTML = `<div class="task-empty error"><strong>Investigation queue unavailable</strong><span>${tesc(error instanceof Error ? error.message : String(error))}</span></div>`;
  } finally {
    taskState.investigationLoading = false;
  }
}

function trustMetric(label, value, note, tone = "") {
  return `<div class="task-trust-card ${tone}"><span>${tesc(label)}</span><strong>${tesc(value)}</strong><small>${tesc(note)}</small></div>`;
}

async function refreshCollectionTrust() {
  if (taskState.collectionLoading || !tq("collectionTrustMetrics")) return;
  taskState.collectionLoading = true;
  try {
    const [importStatus, estateStatus, operationsStatus, telemetryStatus] = await Promise.all([
      taskApi("/api/v2/import/status"),
      taskApi("/api/v2/estate/status"),
      taskApi("/api/v2/operations/status"),
      taskApi("/api/v2/telemetry/status"),
    ]);
    const estate = estateStatus.current_estate || {};
    const sources = Number(importStatus.current_sources || estateStatus.current_sources || 0);
    const fresh = estateStatus.estate_fresh === true;
    const unresolved = Number(estate.unresolved_count || 0);
    const findings = Number(operationsStatus.current_findings || 0);
    const gaps = Number(operationsStatus.current_coverage_gaps || 0);
    const operationalPublished = Number(operationsStatus.current_sources || 0) > 0;
    const metrics = tq("collectionTrustMetrics");
    metrics.innerHTML = [
      trustMetric("Semantic sources", sources.toLocaleString(), "Current source revisions", sources ? "current" : "unknown"),
      trustMetric("Canonical estate", fresh ? "Current" : "Stale", `${Number(estate.entity_count || 0).toLocaleString()} entities · ${Number(estate.relation_count || 0).toLocaleString()} relations`, fresh ? "current" : "attention"),
      trustMetric("Operational evidence", operationalPublished ? `${findings.toLocaleString()} findings` : "Unknown", operationalPublished ? "Current evaluation published" : "No current operational source", operationalPublished ? "current" : "unknown"),
      trustMetric("Coverage gaps", operationalPublished ? gaps.toLocaleString() : "Unknown", operationalPublished ? "Partial / failed / not collected" : "No operational evaluation", gaps ? "attention" : operationalPublished ? "current" : "unknown"),
    ].join("");
    const note = tq("collectionTrustNote");
    if (note) {
      const telemetry = telemetryStatus.ingress_enabled ? `Telemetry ingress is enabled (${telemetryStatus.mode || "mode unknown"}).` : `Telemetry ingress is disabled (${telemetryStatus.mode || "mode unknown"}).`;
      note.innerHTML = `<strong>Interpretation boundary:</strong> ${unresolved.toLocaleString()} canonical reference${unresolved === 1 ? " remains" : "s remain"} unresolved. ${tesc(telemetry)} Missing evidence stays unknown; current-source counts and a fresh estate do not convert unobserved runtime behavior into healthy state.`;
    }
  } catch (error) {
    tq("collectionTrustMetrics").innerHTML = `<div class="task-empty error"><strong>Collection state unavailable</strong><span>${tesc(error instanceof Error ? error.message : String(error))}</span></div>`;
  } finally {
    taskState.collectionLoading = false;
  }
}

function installTaskFirstShell() {
  document.body.classList.add("task-first-mode");
  installTaskFirstStyles();
  replacePrimaryNavigation();
  refineGlobalSearch();
  ensureOverviewTaskFrame();
  ensureExploreTaskFrame();
  ensureInvestigationView();
  ensureCollectionTaskFrame();
  restoreInvestigationFocus();
  renderInvestigationFocus();
}

window.osiRefreshTaskFirstUI = async (view) => {
  refineGlobalSearch();
  if (view === "investigations") await refreshInvestigations();
  if (view === "snapshots") await refreshCollectionTrust();
  if (view === "overview") ensureOverviewTaskFrame();
  if (view === "inventory") ensureExploreTaskFrame();
};

installTaskFirstShell();
