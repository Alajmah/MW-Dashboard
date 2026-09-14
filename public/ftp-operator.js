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
        <p class="section-kicker">File-transfer service paths</p>
        <h2>Start with the path you care about</h2>
        <p>OSI separates what is current, historical, inferred, and still unknown so operators can follow the supported path without mistaking topology for a completed transfer.</p>
      </div>
      <span class="route-mode-badge"><i></i>FTP · canonical estate</span>
    </div>
    <div id="ftpOrientation" class="ftp-orientation" aria-live="polite"></div>
    <div class="ftp-operator-grid">
      <section aria-labelledby="ftpPathsHeading">
        <div class="ftp-subhead">
          <div><p class="section-kicker">Understand</p><h3 id="ftpPathsHeading">Service paths</h3></div>
          <span id="ftpRouteCount"></span>
        </div>
        <div id="ftpQualifiedRoutes" class="ftp-route-list"></div>
      </section>
      <aside aria-labelledby="ftpGapsHeading">
        <div class="ftp-subhead">
          <div><p class="section-kicker">Attention</p><h3 id="ftpGapsHeading">Needs mapping</h3></div>
          <span id="ftpGapCount"></span>
        </div>
        <div id="ftpMappingGaps" class="ftp-gap-list"></div>
      </aside>
    </div>
    <div class="ftp-operator-footnote"><strong>How to read this:</strong> the path lane is an evidence-backed topology projection, not a transaction timeline. Use <em>Inspect route evidence</em> to prove the underlying claims in the canonical route workbench.</div>`;
  workbench.parentNode.insertBefore(panel, workbench);
  return panel;
}

function evidenceTag(label, tone = "info", title = "") {
  const titleAttr = title ? ` title="${ftpEscape(title)}"` : "";
  return `<span class="ftp-evidence-tag ${ftpEscape(tone)}"${titleAttr}>${ftpEscape(label)}</span>`;
}

function completionLabel(value) {
  if (value === "observed") return "Completed transfer observed";
  if (value === "not_observed") return "No completed transfer observed";
  return "Transfer completion unknown";
}

function readableSourceKind(value) {
  const labels = {
    dmz_gateway_runtime: "DMZ gateway runtime",
    eft_runtime: "EFT runtime",
  };
  return labels[value] || String(value || "runtime source").replaceAll("_", " ");
}

function formatWindow(start, end) {
  if (!start && !end) return "Historical activity window retained";
  const short = (value) => {
    if (!value) return "unknown";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return String(value);
    return parsed.toISOString().replace(".000Z", "Z");
  };
  return `${short(start)} → ${short(end)}`;
}

function routeScope(trace, serverByKey) {
  const semantics = trace.semantics || {};
  const step = trace.steps?.[0] || {};
  const properties = step.properties || {};
  const siteAccess = semantics.site_access_evidence || {};
  const listener = semantics.current_listener_evidence || {};
  const corroboration = Array.isArray(semantics.runtime_corroboration) ? semantics.runtime_corroboration : [];
  const runtime = corroboration[0] || {};
  const gatewayKey = properties.gateway_server_key || runtime.gateway_server_key || null;
  const gateway = gatewayKey ? serverByKey.get(String(gatewayKey)) : null;
  const gatewayLabel = gateway?.display_name || gatewayKey || "DMZ gateway";
  const pncEndpoint = runtime.endpoint || "PNC endpoint";
  const sourceKinds = Array.isArray(runtime.sources)
    ? [...new Set(runtime.sources.map((item) => item?.source_kind).filter(Boolean))].map(readableSourceKind)
    : [];
  return {
    properties,
    siteAccess,
    listener,
    corroboration,
    runtime,
    gatewayLabel,
    pncEndpoint,
    sourceKinds,
  };
}

function pathNode(kind, label, evidence, tone, supporting) {
  return `<div class="ftp-path-node">
    <span class="ftp-path-node-kind">${ftpEscape(kind)}</span>
    <strong>${ftpEscape(label)}</strong>
    <small>${ftpEscape(supporting)}</small>
    ${evidenceTag(evidence, tone)}
  </div>`;
}

function pathConnector(label) {
  return `<div class="ftp-path-connector" aria-hidden="true"><span></span><small>${ftpEscape(label)}</small><b>›</b></div>`;
}

function routeCard(trace, serverByKey) {
  const semantics = trace.semantics || {};
  const scope = routeScope(trace, serverByKey);
  const completion = semantics.transfer_completion || "unknown";
  const hasCurrentListener = scope.listener.time_scope === "current";
  const hasCurrentPnc = scope.corroboration.some((item) => item?.time_scope === "current" && item?.independently_corroborated === true);
  const runtimeBoundaryCurrent = hasCurrentListener && hasCurrentPnc;
  const topologyLabel = semantics.derived_epistemic === "inferred" ? "Qualified · inferred" : "Qualified";
  const outcomeTone = completion === "observed" ? "ok" : completion === "not_observed" ? "neutral" : "warn";
  const sourceName = trace.source?.display_name || "File-transfer access context";
  const targetName = trace.target?.display_name || "EFT Site";
  const sourceKinds = scope.sourceKinds.length ? scope.sourceKinds.join(" + ") : "Independent runtime sources";

  const nodes = [
    pathNode(
      "Access context",
      sourceName,
      scope.siteAccess.time_scope === "historical" ? "Historical observed" : "Evidence unknown",
      scope.siteAccess.time_scope === "historical" ? "history" : "warn",
      formatWindow(scope.siteAccess.activity_window_start, scope.siteAccess.activity_window_end),
    ),
    pathNode(
      "DMZ listener",
      scope.listener.endpoint || "Listener endpoint",
      hasCurrentListener ? "Current observed" : "Current evidence unknown",
      hasCurrentListener ? "ok" : "warn",
      scope.gatewayLabel,
    ),
    pathNode(
      "PNC boundary",
      scope.pncEndpoint,
      hasCurrentPnc ? "Current corroborated" : "Corroboration absent",
      hasCurrentPnc ? "ok" : "warn",
      sourceKinds,
    ),
    pathNode(
      "EFT Site",
      targetName,
      "Topology destination",
      "info",
      "Current canonical Site object; traversal is not implied",
    ),
  ];

  return `<article class="ftp-route-card">
    <div class="ftp-route-card-main">
      <div>
        <span class="ftp-route-kicker">Service path</span>
        <strong>${ftpEscape(sourceName)}</strong>
        <small>Destination · ${ftpEscape(targetName)}</small>
      </div>
      <div class="ftp-route-statuses">
        ${evidenceTag(topologyLabel, "info", "The route is qualified by the normalization boundary but remains an inferred topology claim.")}
        ${evidenceTag(runtimeBoundaryCurrent ? "Runtime boundary current" : "Runtime boundary incomplete", runtimeBoundaryCurrent ? "ok" : "warn")}
        ${evidenceTag(completionLabel(completion), outcomeTone)}
      </div>
    </div>

    <div class="ftp-path-lane" aria-label="Evidence-backed file-transfer path components">
      ${nodes[0]}
      ${pathConnector("maps to")}
      ${nodes[1]}
      ${pathConnector("corroborates")}
      ${nodes[2]}
      ${pathConnector("supports route to")}
      ${nodes[3]}
    </div>

    <div class="ftp-route-actions">
      <button type="button" class="secondary ftp-inspect-route" data-from="${ftpEscape(trace.source?.entity_id)}" data-to="${ftpEscape(trace.target?.entity_id)}">Inspect route evidence</button>
      <details class="ftp-qualification-detail">
        <summary>Why is this path qualified?</summary>
        <div>
          <dl>
            <div><dt>Site activity</dt><dd>Historical observed evidence · ${ftpEscape(formatWindow(scope.siteAccess.activity_window_start, scope.siteAccess.activity_window_end))}</dd></div>
            <div><dt>Listener</dt><dd>${hasCurrentListener ? "Current observed" : "Unknown"} · ${ftpEscape(scope.listener.endpoint || "No endpoint")}</dd></div>
            <div><dt>PNC</dt><dd>${hasCurrentPnc ? "Current and independently corroborated" : "Not corroborated"} · ${ftpEscape(scope.pncEndpoint)}</dd></div>
            <div><dt>Runtime sources</dt><dd>${ftpEscape(sourceKinds)}</dd></div>
            <div><dt>Transfer outcome</dt><dd>${ftpEscape(completionLabel(completion))}</dd></div>
          </dl>
          <p>${ftpEscape(trace.explanation || "Route qualification and transfer outcome remain separate claims.")}</p>
        </div>
      </details>
    </div>
  </article>`;
}

function gapCard(gap, endpointById) {
  const source = endpointById.get(String(gap.source_entity_id));
  return `<article class="ftp-gap-card">
    <div class="ftp-gap-head">
      <span>Mapping gap</span>
      <strong>${ftpEscape(source?.display_name || gap.vendor_value || "File-transfer endpoint")}</strong>
    </div>
    <p>${ftpEscape(gap.reason || "No evidence-backed current Site/listener mapping is available.")}</p>
    <small>OSI keeps this unknown explicit. It is not promoted into an outage or incident by absence of mapping evidence alone.</small>
  </article>`;
}

function orientationMarkup({ traces, gaps, currentBoundary, completionSummary, servers }) {
  const allBoundaryCurrent = traces.length > 0 && currentBoundary === traces.length;
  const attention = gaps.length
    ? `${gaps.length} Site${gaps.length === 1 ? "" : "s"} still need evidence-backed mapping`
    : "No unresolved FTP Site/listener mappings";
  return `<div class="ftp-orientation-summary">
    <div>
      <span>Orient</span>
      <strong>${traces.length} qualified path${traces.length === 1 ? "" : "s"} · ${attention}</strong>
      <small>${allBoundaryCurrent ? "Every qualified path has a current listener and independently corroborated PNC boundary." : `${currentBoundary}/${traces.length || 0} qualified paths have a complete current runtime boundary.`}</small>
    </div>
    <div class="ftp-orientation-outcome">
      <span>Transaction outcome</span>
      <strong>${ftpEscape(completionSummary)}</strong>
      <small>Route qualification never substitutes for transfer completion evidence.</small>
    </div>
  </div>
  <div class="ftp-orientation-facts">
    <div><span>Qualified paths</span><strong>${traces.length.toLocaleString()}</strong></div>
    <div><span>Current runtime boundary</span><strong>${currentBoundary}/${traces.length || 0}</strong></div>
    <div><span>Needs mapping</span><strong>${gaps.length.toLocaleString()}</strong></div>
    <div><span>FTP servers in estate</span><strong>${servers.length.toLocaleString()}</strong></div>
  </div>`;
}

async function loadFtpOperator() {
  const panel = ensureFtpPanel();
  if (!panel || ftpState.loading) return;
  const view = document.querySelector('[data-view-panel="routes"]');
  if (!view?.classList.contains("active")) return;

  ftpState.loading = true;
  const sequence = ++ftpState.sequence;
  panel.hidden = false;
  const orientation = document.getElementById("ftpOrientation");
  const routesNode = document.getElementById("ftpQualifiedRoutes");
  const gapsNode = document.getElementById("ftpMappingGaps");

  if (orientation) orientation.innerHTML = `<div class="ftp-loading">Loading current FTP canonical state…</div>`;
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
    const serverByKey = new Map();
    servers.forEach((item) => {
      const key = item.properties?.source_key || item.properties?.canonical_key || item.identity_key;
      if (key) serverByKey.set(String(key), item);
    });

    const ftpRelations = relations.filter((relation) => flowById.has(String(relation.source_entity_id)) && endpointById.has(String(relation.target_entity_id)));
    const traces = (await Promise.all(ftpRelations.map(async (relation) => {
      try {
        return await ftpApi(`/api/v2/routes/trace?from=${encodeURIComponent(relation.source_entity_id)}&to=${encodeURIComponent(relation.target_entity_id)}`);
      } catch {
        return null;
      }
    })))
      .filter((trace) => trace?.found && trace?.semantics?.route_domain === "file_transfer" && trace?.semantics?.qualified_route === true)
      .sort((a, b) => String(a.source?.display_name || "").localeCompare(String(b.source?.display_name || "")));

    const currentBoundary = traces.filter((trace) => {
      const listenerCurrent = trace.semantics?.current_listener_evidence?.time_scope === "current";
      const runtimeCurrent = Array.isArray(trace.semantics?.runtime_corroboration)
        && trace.semantics.runtime_corroboration.some((item) => item?.time_scope === "current" && item?.independently_corroborated === true);
      return listenerCurrent && runtimeCurrent;
    }).length;

    const observedCompletions = traces.filter((trace) => trace.semantics?.transfer_completion === "observed").length;
    const unknownCompletions = traces.filter((trace) => !["observed", "not_observed"].includes(trace.semantics?.transfer_completion)).length;
    const completionSummary = observedCompletions > 0
      ? `${observedCompletions}/${traces.length} completed transfer${observedCompletions === 1 ? "" : "s"} observed`
      : traces.length && unknownCompletions === 0
        ? "No completed transfer observed"
        : "Transfer completion evidence unknown";

    ftpState.loadedEstate = summary.estate?.estate_revision_id || null;

    if (orientation) {
      orientation.innerHTML = orientationMarkup({
        traces,
        gaps,
        currentBoundary,
        completionSummary,
        servers,
      });
    }

    const routeCount = document.getElementById("ftpRouteCount");
    const gapCount = document.getElementById("ftpGapCount");
    if (routeCount) routeCount.textContent = `${traces.length} path${traces.length === 1 ? "" : "s"}`;
    if (gapCount) gapCount.textContent = `${gaps.length} gap${gaps.length === 1 ? "" : "s"}`;

    if (routesNode) {
      routesNode.innerHTML = traces.length
        ? traces.map((trace) => routeCard(trace, serverByKey)).join("")
        : `<div class="ftp-empty">No evidence-qualified FTP service paths are present in the current canonical estate.</div>`;
    }

    if (gapsNode) {
      gapsNode.innerHTML = gaps.length
        ? gaps.map((gap) => gapCard(gap, endpointById)).join("")
        : `<div class="ftp-empty">No unresolved FTP Site/listener mappings are present.</div>`;
    }

    routesNode?.querySelectorAll(".ftp-inspect-route").forEach((button) => {
      button.addEventListener("click", async () => {
        if (typeof window.osiTraceCanonicalRoute !== "function") return;
        button.disabled = true;
        try {
          await window.osiTraceCanonicalRoute(button.dataset.from, button.dataset.to);
          document.querySelector(".route-results-v2")?.scrollIntoView({ behavior: "smooth", block: "start" });
        } finally {
          button.disabled = false;
        }
      });
    });
  } catch (error) {
    if (sequence !== ftpState.sequence) return;
    if (orientation) orientation.innerHTML = `<div class="ftp-error"><strong>FTP service-path projection unavailable</strong><span>${ftpEscape(error.message)}</span></div>`;
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
