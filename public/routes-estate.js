const routeState = {
  from: null,
  to: null,
  timers: { from: null, to: null },
};

const rq = (id) => document.getElementById(id);
const resc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

function typeLabel(type) {
  const map = {
    "app.application_instance": "Application instance",
    "mq.runtime_process": "MQ runtime process",
    "mq.queue": "Queue",
    "ace.message_flow": "ACE message flow",
    "datapower.service": "DataPower service",
    "filetransfer.flow": "File-transfer flow",
  };
  return map[type] || String(type || "entity").replaceAll(".", " · ").replaceAll("_", " ");
}

function ownerLabel(entity) {
  const props = entity?.properties || {};
  return props.queue_manager || props.qmgr || props.queue_manager_name || "";
}

function entityQualifier(entity) {
  const owner = ownerLabel(entity);
  const evidence = Array.isArray(entity?.evidence_classes) ? entity.evidence_classes.join(" · ") : "";
  return [typeLabel(entity?.semantic_type), owner, evidence].filter(Boolean).join(" · ");
}

async function routeApi(path) {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(body.detail || `Route query failed (${response.status})`);
    error.code = body.code;
    throw error;
  }
  return body;
}

function setSelection(side, entity, { quiet = false } = {}) {
  routeState[side] = entity || null;
  const input = rq(side === "from" ? "routeFrom" : "routeTo");
  const context = rq(side === "from" ? "routeFromContext" : "routeToContext");
  if (entity) {
    input.value = entity.display_name || entity.identity_key || entity.entity_id;
    context.textContent = entityQualifier(entity);
  } else if (!quiet) {
    context.textContent = side === "from" ? "Choose a source application, process or queue" : "Choose a destination application, process or queue";
  }
}

function searchResultHtml(entity) {
  const props = entity.properties || {};
  const system = props.system === true || String(entity.display_name || "").startsWith("SYSTEM.");
  return `<button type="button" class="route-suggestion" data-route-entity="${resc(entity.entity_id)}">
    <span class="route-suggestion-main"><strong>${resc(entity.display_name || entity.identity_key)}</strong><small>${resc(entityQualifier(entity))}</small></span>
    ${system ? '<span class="route-suggestion-tag">system</span>' : ""}
  </button>`;
}

async function searchEntities(side, query) {
  const results = rq(side === "from" ? "routeFromResults" : "routeToResults");
  const normalized = query.trim();
  if (normalized.length < 2) {
    results.innerHTML = `<div class="route-suggestion-empty">Type at least 2 characters.</div>`;
    results.classList.toggle("open", normalized.length > 0);
    return;
  }
  results.innerHTML = `<div class="route-suggestion-empty">Searching canonical estate…</div>`;
  results.classList.add("open");
  try {
    const data = await routeApi(`/api/v2/routes/search?q=${encodeURIComponent(normalized)}&limit=20`);
    const showSystem = normalized.toLowerCase().includes("system.");
    const entities = (data.results || []).filter((entity) => showSystem || entity.properties?.system !== true);
    results.innerHTML = entities.length ? entities.map(searchResultHtml).join("") : `<div class="route-suggestion-empty">No canonical route endpoints match this search.</div>`;
    results.querySelectorAll("[data-route-entity]").forEach((button) => {
      button.addEventListener("click", () => {
        const entity = entities.find((item) => item.entity_id === button.dataset.routeEntity);
        if (!entity) return;
        setSelection(side, entity);
        results.classList.remove("open");
      });
    });
  } catch (error) {
    results.innerHTML = `<div class="route-suggestion-empty">${resc(error.message)}</div>`;
  }
}

function bindPicker(side) {
  const input = rq(side === "from" ? "routeFrom" : "routeTo");
  const results = rq(side === "from" ? "routeFromResults" : "routeToResults");
  input.addEventListener("input", () => {
    routeState[side] = null;
    const context = rq(side === "from" ? "routeFromContext" : "routeToContext");
    context.textContent = "Select an exact canonical entity from the results";
    clearTimeout(routeState.timers[side]);
    routeState.timers[side] = setTimeout(() => searchEntities(side, input.value), 180);
  });
  input.addEventListener("focus", () => {
    if (results.innerHTML.trim()) results.classList.add("open");
  });
}

function evidenceBadges(values) {
  const items = Array.isArray(values) ? values : [];
  return items.map((value) => `<span class="evidence-badge ${resc(value)}">${resc(value)}</span>`).join("") || `<span class="evidence-badge">unknown</span>`;
}

function modeCard(mode) {
  if (mode === "observed_activity") return ["Observed activity", "At least one step is backed by observed message activity.", "good"];
  if (mode === "runtime_access") return ["Runtime access path", "Queue handles prove access modes, not MQPUT/MQGET operations.", "info"];
  return ["Configured semantic path", "The path is supported by configured/integration semantics rather than observed message activity.", "info"];
}

function renderTransport(transport, queueId) {
  const rows = (transport || []).filter((item) => item.route_queue_id === queueId);
  if (!rows.length) return "";
  return `<div class="route-transport-card"><div class="transport-title"><span>MQ transport expansion</span><small>Transport is shown separately from logical resolution</small></div>${rows.map((item) => {
    const parts = [
      item.xmitq ? `<div class="transport-step"><span>XMITQ</span><strong>${resc(item.xmitq.display_name)}</strong>${evidenceBadges(item.routes_via?.evidence_classes)}</div>` : "",
      item.channel ? `<div class="transport-arrow">→</div><div class="transport-step"><span>Sender channel</span><strong>${resc(item.channel.display_name)}</strong>${evidenceBadges(item.transmits_via?.evidence_classes)}</div>` : "",
      item.peer_queue_manager ? `<div class="transport-arrow">→</div><div class="transport-step"><span>Peer queue manager</span><strong>${resc(item.peer_queue_manager.display_name)}</strong>${evidenceBadges(item.connects_to?.evidence_classes)}</div>` : "",
    ].join("");
    return `<div class="transport-line">${parts}</div>`;
  }).join("")}</div>`;
}

function unresolvedHtml(items) {
  if (!items?.length) return "";
  return `<div class="route-warnings"><h3>Unresolved evidence on this path</h3>${items.map((item) => `<div class="route-warning"><i></i><span><strong>${resc(item.state)}</strong> · ${resc(item.vendor_value || item.expected_target_type || "unknown target")} · ${resc(item.reason || item.semantic_type)}</span></div>`).join("")}</div>`;
}

function renderNotFound(data) {
  rq("routeTitle").textContent = "No supported semantic path found";
  rq("routeMeta").textContent = "Canonical estate";
  rq("routeResult").className = "route-diagnostic";
  rq("routeResult").innerHTML = `<div class="route-diagnostic-intro"><h3>We cannot prove this end-to-end path yet</h3><p>${resc(data.explanation || "No directed route is supported by current evidence.")}</p></div>
    <div class="route-diagnostic-grid">
      <div class="diagnostic-card"><span>Source</span><strong>${resc(data.source?.display_name || "Unknown")}</strong><p>${resc(entityQualifier(data.source))}</p></div>
      <div class="diagnostic-card"><span>Destination</span><strong>${resc(data.target?.display_name || "Unknown")}</strong><p>${resc(entityQualifier(data.target))}</p></div>
      <div class="diagnostic-card"><span>Interpretation</span><strong>Evidence gap, not disconnection</strong><p>Additional MQ peer, ACE, DataPower, application activity, or routing evidence may be required.</p></div>
    </div>${unresolvedHtml(data.unresolved)}`;
}

function renderFound(data) {
  const nodes = data.nodes || [];
  const steps = data.steps || [];
  const [modeTitle, modeNote, modeTone] = modeCard(data.mode);
  const warnings = steps.filter((step) => step.semantic_warning).map((step) => step.semantic_warning);
  rq("routeTitle").textContent = `${data.source?.display_name || "Source"} → ${data.target?.display_name || "Destination"}`;
  rq("routeMeta").textContent = `${steps.length} semantic step${steps.length === 1 ? "" : "s"}`;

  let journey = "";
  if (nodes.length) {
    journey += `<div class="route-node"><span>${resc(typeLabel(nodes[0].semantic_type))}</span><strong>${resc(nodes[0].display_name || nodes[0].identity_key)}</strong><small>${resc(ownerLabel(nodes[0]))}</small></div>`;
  }
  steps.forEach((step, index) => {
    const target = nodes[index + 1] || step.to;
    journey += `<div class="route-edge ${resc((step.evidence_classes || [])[0] || "configured")}"><b>→</b><span>${resc(step.label || step.semantic_type)}</span><span>${evidenceBadges(step.evidence_classes)}</span></div>`;
    journey += `<div class="route-node"><span>${resc(typeLabel(target?.semantic_type))}</span><strong>${resc(target?.display_name || target?.identity_key || "Unknown")}</strong><small>${resc(ownerLabel(target))}</small>${target?.semantic_type === "mq.queue" ? renderTransport(data.transport, target.entity_id) : ""}</div>`;
  });

  rq("routeResult").className = "route-result-shell";
  rq("routeResult").innerHTML = `<div class="route-health">
      <div class="route-health-card ${modeTone}"><span>Path semantics</span><strong>${resc(modeTitle)}</strong><small>${resc(modeNote)}</small></div>
      <div class="route-health-card"><span>Canonical estate</span><strong>${resc(String(data.estate?.estate_revision_id || "current").replace("estate_", ""))}</strong><small>${(data.estate?.source_revision_ids || []).length} reconciled source${(data.estate?.source_revision_ids || []).length === 1 ? "" : "s"}</small></div>
      <div class="route-health-card ${data.unresolved?.length ? "warn" : "good"}"><span>Unresolved on path</span><strong>${Number(data.unresolved?.length || 0).toLocaleString()}</strong><small>${data.unresolved?.length ? "Explicit gaps are preserved" : "No unresolved references attached to path entities"}</small></div>
      <div class="route-health-card info"><span>Activity claim</span><strong>${data.mode === "observed_activity" ? "Observed" : "Not claimed"}</strong><small>${data.mode === "runtime_access" ? "Open access is not PUT/GET activity" : "Evidence semantics remain explicit"}</small></div>
    </div><div class="route-journey">${journey}</div>${warnings.length ? `<div class="route-warnings"><h3>Semantic cautions</h3>${[...new Set(warnings)].map((warning) => `<div class="route-warning"><i></i><span>${resc(warning)}</span></div>`).join("")}</div>` : ""}${unresolvedHtml(data.unresolved)}`;
}

async function runRoute() {
  if (!routeState.from || !routeState.to) {
    rq("routeTitle").textContent = "Choose exact canonical endpoints";
    rq("routeMeta").textContent = "Search and select both ends";
    rq("routeResult").className = "route-diagnostic";
    rq("routeResult").innerHTML = `<div class="route-diagnostic-intro"><h3>Route endpoints are not resolved</h3><p>Select a result from each search list; typed text alone is not treated as an entity identity.</p></div>`;
    return;
  }
  rq("routeTitle").textContent = "Tracing canonical semantics…";
  rq("routeMeta").textContent = "Current estate";
  rq("routeResult").className = "route-empty";
  rq("routeResult").textContent = "Querying the canonical estate for the strongest supported semantic path and MQ transport expansion…";
  try {
    const data = await routeApi(`/api/v2/routes/trace?from=${encodeURIComponent(routeState.from.entity_id)}&to=${encodeURIComponent(routeState.to.entity_id)}&max_depth=12`);
    if (data.found) renderFound(data); else renderNotFound(data);
  } catch (error) {
    rq("routeTitle").textContent = "Route query unavailable";
    rq("routeMeta").textContent = error.code || "Error";
    rq("routeResult").className = "route-diagnostic";
    rq("routeResult").innerHTML = `<div class="route-diagnostic-intro"><h3>Canonical route query failed</h3><p>${resc(error.message)}</p></div>`;
  }
}

function swapEndpoints() {
  const oldFrom = routeState.from;
  const oldTo = routeState.to;
  setSelection("from", oldTo, { quiet: true });
  setSelection("to", oldFrom, { quiet: true });
  if (routeState.from && routeState.to) runRoute();
}

function configureRouteCopy() {
  const head = document.querySelector(".route-workbench-head");
  if (head) {
    const kicker = head.querySelector(".section-kicker");
    const title = head.querySelector("h2");
    const copy = head.querySelector("p:not(.section-kicker)");
    const badge = head.querySelector(".route-mode-badge");
    if (kicker) kicker.textContent = "Canonical semantic trace";
    if (title) title.textContent = "What path can the current evidence support?";
    if (copy) copy.textContent = "Trace application/process queue access, configured queue resolution, integration delivery semantics and MQ transport without converting object-handle access into false PUT/GET activity.";
    if (badge) badge.innerHTML = "<i></i>Canonical · evidence-aware";
  }
  const help = document.querySelector(".route-help-copy");
  if (help) help.innerHTML = "<strong>How to read the result:</strong> runtime open-for-output/input is access evidence only. Actual PUT/GET activity is shown only when activity evidence exists. QREMOTE/XMITQ/channel transport is expanded separately from logical queue resolution.";
  if (rq("routeSuggestions")) rq("routeSuggestions").innerHTML = `<span>Search two canonical entities above. System queues remain hidden unless you explicitly search for <strong>SYSTEM.</strong></span>`;
}

function initCanonicalRoutes() {
  const form = rq("routeForm");
  if (!form || form.dataset.canonicalBound === "true") return;
  form.dataset.canonicalBound = "true";
  configureRouteCopy();
  setSelection("from", null);
  setSelection("to", null);
  bindPicker("from");
  bindPicker("to");
  form.addEventListener("submit", (event) => { event.preventDefault(); runRoute(); });
  rq("routeSwap")?.addEventListener("click", swapEndpoints);
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".route-picker")) {
      rq("routeFromResults")?.classList.remove("open");
      rq("routeToResults")?.classList.remove("open");
    }
  });
}

initCanonicalRoutes();
