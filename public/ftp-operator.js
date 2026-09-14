const ftpEscape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

const ftpState = {
  loading: false,
  loadedEstate: null,
  sequence: 0,
};

async function ftpApi(path) {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(body.detail || `FTP operator query failed (${response.status})`);
    error.code = body.code;
    throw error;
  }
  return body;
}

async function ftpPaged(path, collectionKey) {
  const items = [];
  let offset = 0;
  for (let page = 0; page < 50; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const data = await ftpApi(`${path}${separator}limit=100&offset=${offset}`);
    items.push(...(Array.isArray(data[collectionKey]) ? data[collectionKey] : []));
    const next = data.page?.next_offset;
    if (next === null || next === undefined) return items;
    const parsed = Number(next);
    if (!Number.isFinite(parsed) || parsed <= offset) throw new Error(`Invalid canonical estate pagination for ${collectionKey}`);
    offset = parsed;
  }
  throw new Error(`Canonical estate pagination exceeded safety limit for ${collectionKey}`);
}

function ensureFtpPanel() {
  const routesView = document.querySelector('[data-view-panel="routes"]');
  const workbench = routesView?.querySelector(".route-workbench");
  if (!routesView || !workbench) return null;
  let panel = document.getElementById("ftpOperatorPanel");
  if (panel) return panel;
  panel = document.createElement("section");
  panel.id = "ftpOperatorPanel";
  panel.className = "panel ftp-operator-panel";
  panel.hidden = true;
  panel.innerHTML = `
    <div class="ftp-operator-head">
      <div>
        <p class="section-kicker">File-transfer estate</p>
        <h2>Qualified FTP topology</h2>
        <p>Evidence-qualified EFT/DMZ paths remain distinct from current traversal and completed-transfer claims.</p>
      </div>
      <span class="route-mode-badge"><i></i>FTP · evidence-qualified</span>
    </div>
    <div id="ftpOperatorMetrics" class="ftp-operator-metrics"></div>
    <div class="ftp-operator-grid">
      <div>
        <div class="ftp-subhead"><h3>Qualified routes</h3><span id="ftpRouteCount"></span></div>
        <div id="ftpQualifiedRoutes" class="ftp-route-list"></div>
      </div>
      <div>
        <div class="ftp-subhead"><h3>Needs mapping</h3><span id="ftpGapCount"></span></div>
        <div id="ftpMappingGaps" class="ftp-gap-list"></div>
      </div>
    </div>
    <div class="ftp-operator-footnote">A qualified route is a topology claim. Historical Site access, current listener evidence, PNC runtime corroboration, and transaction completion are shown as separate evidence dimensions.</div>`;
  workbench.parentNode.insertBefore(panel, workbench);
  return panel;
}

function evidenceTag(label, tone = "info") {
  return `<span class="ftp-evidence-tag ${ftpEscape(tone)}">${ftpEscape(label)}</span>`;
}

function completionLabel(value) {
  if (value === "observed") return "Observed";
  if (value === "not_observed") return "Not observed";
  return "Unknown";
}

function routeCard(trace) {
  const semantics = trace.semantics || {};
  const step = trace.steps?.[0] || {};
  const evidence = Array.isArray(step.evidence_classes) ? step.evidence_classes : [];
  const corroboration = Array.isArray(semantics.runtime_corroboration) ? semantics.runtime_corroboration : [];
  const siteAccess = semantics.site_access_evidence || {};
  const listener = semantics.current_listener_evidence || {};
  const completion = semantics.transfer_completion || "unknown";
  const tags = [
    evidenceTag(`${semantics.derived_epistemic || evidence[0] || "unknown"} topology`),
    siteAccess.time_scope === "historical" ? evidenceTag("historical Site access") : evidenceTag("Site access unknown", "warn"),
    listener.time_scope === "current" ? evidenceTag("current listener") : evidenceTag("listener unknown", "warn"),
    corroboration.length ? evidenceTag("current PNC corroboration") : evidenceTag("PNC corroboration absent", "warn"),
  ];
  return `<article class="ftp-route-card">
    <div class="ftp-route-card-main">
      <div>
        <span class="ftp-route-kicker">Qualified topology route</span>
        <strong>${ftpEscape(trace.source?.display_name || "File-transfer flow")}</strong>
        <small>→ ${ftpEscape(trace.target?.display_name || "Site endpoint")}</small>
      </div>
      <div class="ftp-route-outcome">
        <span>Transfer completion</span>
        <b>${ftpEscape(completionLabel(completion))}</b>
      </div>
    </div>
    <div class="ftp-evidence-tags">${tags.join("")}</div>
    <p>${ftpEscape(trace.explanation || "Qualified topology evidence is available; transaction outcome remains separately evidenced.")}</p>
    <button type="button" class="ghost ftp-inspect-route" data-from="${ftpEscape(trace.source?.entity_id)}" data-to="${ftpEscape(trace.target?.entity_id)}">Inspect route evidence</button>
  </article>`;
}

function gapCard(gap, endpointById) {
  const source = endpointById.get(String(gap.source_entity_id));
  return `<article class="ftp-gap-card">
    <div><span>${ftpEscape(gap.state || "unknown")}</span><strong>${ftpEscape(source?.display_name || gap.vendor_value || "File-transfer endpoint")}</strong></div>
    <p>${ftpEscape(gap.reason || "No evidence-backed current mapping is available.")}</p>
  </article>`;
}

async function loadFtpOperator() {
  const panel = ensureFtpPanel();
  if (!panel || ftpState.loading) return;
  const view = document.querySelector('[data-view-panel="routes"]');
  if (!view?.classList.contains("active")) return;
  ftpState.loading = true;
  const sequence = ++ftpState.sequence;
  panel.hidden = false;
  const metrics = document.getElementById("ftpOperatorMetrics");
  const routesNode = document.getElementById("ftpQualifiedRoutes");
  const gapsNode = document.getElementById("ftpMappingGaps");
  if (metrics) metrics.innerHTML = `<div class="ftp-loading">Loading current FTP canonical state…</div>`;
  if (routesNode) routesNode.innerHTML = "";
  if (gapsNode) gapsNode.innerHTML = "";

  try {
    const [summary, flows, endpoints, servers, relations, gaps] = await Promise.all([
      ftpApi("/api/v2/estate/current/summary"),
      ftpPaged("/api/v2/estate/current/entities?semantic_type=filetransfer.flow", "entities"),
      ftpPaged("/api/v2/estate/current/entities?semantic_type=filetransfer.endpoint", "entities"),
      ftpPaged("/api/v2/estate/current/entities?semantic_type=filetransfer.server", "entities"),
      ftpPaged("/api/v2/estate/current/relations?semantic_type=integration.routes_to", "relations"),
      ftpPaged("/api/v2/estate/current/unresolved?semantic_type=filetransfer.endpoint", "unresolved"),
    ]);
    if (sequence !== ftpState.sequence) return;

    const flowById = new Map(flows.map((item) => [String(item.entity_id), item]));
    const endpointById = new Map(endpoints.map((item) => [String(item.entity_id), item]));
    const ftpRelations = relations.filter((relation) => flowById.has(String(relation.source_entity_id)) && endpointById.has(String(relation.target_entity_id)));
    const traces = (await Promise.all(ftpRelations.map(async (relation) => {
      try {
        return await ftpApi(`/api/v2/routes/trace?from=${encodeURIComponent(relation.source_entity_id)}&to=${encodeURIComponent(relation.target_entity_id)}`);
      } catch {
        return null;
      }
    }))).filter((trace) => trace?.found && trace?.semantics?.route_domain === "file_transfer" && trace?.semantics?.qualified_route === true);
    const corroborated = traces.filter((trace) => Array.isArray(trace.semantics?.runtime_corroboration) && trace.semantics.runtime_corroboration.length > 0).length;
    const completionsObserved = traces.filter((trace) => trace.semantics?.transfer_completion === "observed").length;
    const completionState = completionsObserved > 0 ? `${completionsObserved} observed` : traces.length ? "Not observed" : "Unknown";

    ftpState.loadedEstate = summary.estate?.estate_revision_id || null;
    if (metrics) metrics.innerHTML = `
      <div class="ftp-metric"><span>Qualified routes</span><strong>${traces.length.toLocaleString()}</strong><small>Inferred topology paths only</small></div>
      <div class="ftp-metric"><span>FTP servers</span><strong>${servers.length.toLocaleString()}</strong><small>EFT and gateway canonical objects</small></div>
      <div class="ftp-metric"><span>Current runtime boundary</span><strong>${corroborated}/${traces.length || 0}</strong><small>Routes with current corroboration</small></div>
      <div class="ftp-metric"><span>Transfer completion</span><strong>${ftpEscape(completionState)}</strong><small>No completion is inferred from route qualification</small></div>
      <div class="ftp-metric ${gaps.length ? "warn" : ""}"><span>Needs mapping</span><strong>${gaps.length.toLocaleString()}</strong><small>Explicit unresolved Site/listener relationships</small></div>`;

    document.getElementById("ftpRouteCount").textContent = `${traces.length} route${traces.length === 1 ? "" : "s"}`;
    document.getElementById("ftpGapCount").textContent = `${gaps.length} gap${gaps.length === 1 ? "" : "s"}`;
    routesNode.innerHTML = traces.length ? traces.map(routeCard).join("") : `<div class="ftp-empty">No qualified FTP topology routes are present in the current canonical estate.</div>`;
    gapsNode.innerHTML = gaps.length ? gaps.map((gap) => gapCard(gap, endpointById)).join("") : `<div class="ftp-empty">No unresolved FTP Site/listener mappings are present.</div>`;

    routesNode.querySelectorAll(".ftp-inspect-route").forEach((button) => {
      button.addEventListener("click", async () => {
        if (typeof window.osiTraceCanonicalRoute !== "function") return;
        button.disabled = true;
        try { await window.osiTraceCanonicalRoute(button.dataset.from, button.dataset.to); }
        finally { button.disabled = false; }
      });
    });
  } catch (error) {
    if (sequence !== ftpState.sequence) return;
    if (metrics) metrics.innerHTML = `<div class="ftp-error"><strong>FTP operator projection unavailable</strong><span>${ftpEscape(error.message)}</span></div>`;
    if (routesNode) routesNode.innerHTML = "";
    if (gapsNode) gapsNode.innerHTML = "";
  } finally {
    if (sequence === ftpState.sequence) ftpState.loading = false;
  }
}

window.osiRefreshFtpOperator = loadFtpOperator;

document.addEventListener("click", (event) => {
  const view = event.target.closest("[data-view]")?.dataset.view || event.target.closest("[data-go]")?.dataset.go;
  if (view === "routes") setTimeout(loadFtpOperator, 160);
});
