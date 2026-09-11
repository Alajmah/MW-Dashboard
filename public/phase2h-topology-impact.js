const PHASE2H_REVISION = "20260911-1";
const basePhase2HEnhance = window.osiEnhanceObjectWorkspace;

const phase2hState = {
  entityId: "",
  canonical: null,
  impact: null,
  error: "",
  sequence: 0,
};

const h$ = (id) => document.getElementById(id);
const hEsc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

function installPhase2HStyles() {
  if (document.querySelector('link[data-phase2h-impact]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `/phase2h-topology-impact.css?v=${PHASE2H_REVISION}`;
  link.dataset.phase2hImpact = "true";
  document.head.appendChild(link);
}

async function hApi(path) {
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

function hType(type) {
  const labels = {
    "app.application_instance": "Application instance",
    "mq.runtime_process": "MQ runtime process",
    "runtime.process": "Runtime process",
    "mq.queue": "Queue",
    "mq.queue_manager": "Queue Manager",
    "mq.channel": "Channel",
    "mq.cluster": "MQ Cluster",
    "mq.listener": "Listener",
    "infra.host": "Physical host",
    "ace.message_flow": "ACE message flow",
    "datapower.service": "DataPower service",
    "filetransfer.flow": "File-transfer flow",
  };
  return labels[type] || String(type || "Entity").replaceAll("_", " ").replaceAll(".", " · ");
}

function hEvidence(values) {
  const list = Array.isArray(values) ? values : [];
  return list.length ? list.map((value) => `<span class="p2h-evidence ${hEsc(value)}">${hEsc(value)}</span>`).join("") : `<span class="p2h-evidence">evidence-backed</span>`;
}

function hKindLabel(kind) {
  const labels = {
    observed_activity: "Observed activity",
    runtime_access: "Runtime access",
    configured_delivery: "Configured delivery",
    transport: "MQ transport",
    structural_context: "Structural context",
  };
  return labels[kind] || String(kind || "Evidence").replaceAll("_", " ");
}

function coverageCopy(state) {
  const copy = {
    bounded_segment: ["Delivery context exists on both sides", "Canonical delivery-facing relationships are present upstream and downstream. Use route verification before treating them as one supported end-to-end path."],
    upstream_with_transport: ["Upstream context and transport are established", "The estate shows how work can arrive and explicit MQ transport context, but the downstream application/service continuation is not established."],
    upstream_only: ["Upstream context is established; continuation is unknown", "Current evidence shows an upstream producer/access relationship to this object. No downstream delivery-facing relationship is established from this object."],
    downstream_only: ["Downstream context is established; origin is unknown", "Current evidence shows a downstream consumer/resolution relationship, but the upstream delivery origin is not established."],
    transport_only: ["MQ transport context is established", "Transport configuration is present, but application-facing delivery adjacency is not established around this object."],
    no_delivery_adjacency: ["No delivery-facing adjacency is established", "The current canonical estate may still contain ownership or cluster context, but it does not support an adjacent producer, consumer, resolution, or observed activity claim for this object."],
  };
  return copy[state] || ["Impact context is evidence-bounded", "OSI reports only relationships represented in the current canonical estate."];
}

function relationCard(item) {
  const neighbor = item?.neighbor || {};
  const warning = item?.semantic_warning ? `<p class="p2h-warning">${hEsc(item.semantic_warning)}</p>` : "";
  return `<button type="button" class="p2h-relation-card" data-p2h-neighbor="${hEsc(neighbor.entity_id || "")}">
    <span>${hEsc(item.label || item.semantic_type || "Relationship")}</span>
    <strong>${hEsc(neighbor.display_name || neighbor.identity_key || neighbor.entity_id || "Unknown entity")}</strong>
    <small>${hEsc(hType(neighbor.semantic_type))} · ${hEsc(hKindLabel(item.kind))}</small>
    <div>${hEvidence(item.evidence_classes)}</div>
    ${warning}
  </button>`;
}

function relationColumn(title, subtitle, items, emptyCopy) {
  return `<section class="p2h-side"><header><span>${hEsc(title)}</span><small>${hEsc(subtitle)}</small></header>${items?.length ? `<div class="p2h-side-list">${items.map(relationCard).join("")}</div>` : `<div class="p2h-side-empty">${hEsc(emptyCopy)}</div>`}</section>`;
}

function transportHtml(items) {
  if (!items?.length) return "";
  return `<section class="p2h-section"><div class="p2h-section-title"><div><span>Explicit MQ transport</span><h3>Configured transport continuation</h3></div><small>Transport context is separate from application/message activity</small></div><div class="p2h-transport-list">${items.map((item) => `<article><div class="p2h-transport-node"><span>XMITQ</span><strong>${hEsc(item.xmitq?.display_name || "Unknown")}</strong>${hEvidence(item.routes_via?.evidence_classes)}</div><b>→</b><div class="p2h-transport-node"><span>Sender channel</span><strong>${hEsc(item.channel?.display_name || "Not established")}</strong>${item.transmits_via ? hEvidence(item.transmits_via.evidence_classes) : ""}</div><b>→</b><div class="p2h-transport-node"><span>Peer queue manager</span><strong>${hEsc(item.peer_queue_manager?.display_name || "Not established")}</strong>${item.connects_to ? hEvidence(item.connects_to.evidence_classes) : ""}</div></article>`).join("")}</div></section>`;
}

function contextHtml(items) {
  if (!items?.length) return "";
  return `<section class="p2h-section"><div class="p2h-section-title"><div><span>Topology context</span><h3>Ownership, cluster and placement context</h3></div><small>Context only · not delivery proof</small></div><div class="p2h-context-grid">${items.map((item) => {
    const neighbor = item.neighbor || {};
    return `<button type="button" data-p2h-neighbor="${hEsc(neighbor.entity_id || "")}"><span>${hEsc(item.label || item.semantic_type || "Relationship")}</span><strong>${hEsc(neighbor.display_name || neighbor.identity_key || neighbor.entity_id || "Unknown")}</strong><small>${hEsc(hType(neighbor.semantic_type))}</small>${item.semantic_warning ? `<em>${hEsc(item.semantic_warning)}</em>` : ""}</button>`;
  }).join("")}</div></section>`;
}

function unresolvedHtml(items) {
  if (!items?.length) return "";
  return `<section class="p2h-section p2h-unresolved"><div class="p2h-section-title"><div><span>Evidence boundary</span><h3>Unresolved route evidence</h3></div><small>${items.length} unresolved reference${items.length === 1 ? "" : "s"}</small></div>${items.map((item) => `<article><strong>${hEsc(item.vendor_value || item.expected_target_type || "Unknown target")}</strong><span>${hEsc(item.state || "unresolved")} · ${hEsc(item.semantic_type || "relationship")}</span><p>${hEsc(item.reason || "Additional source evidence is required.")}</p></article>`).join("")}</section>`;
}

function traceCandidateHtml(candidates) {
  if (!candidates?.length) return `<section class="p2h-section"><div class="p2h-section-title"><div><span>Route correlation</span><h3>No endpoint pair is available for route verification</h3></div></div><p class="p2h-copy">OSI does not have both an upstream and a downstream delivery-facing neighbor around this object. That is an evidence boundary, not proof of disconnection.</p></section>`;
  return `<section class="p2h-section"><div class="p2h-section-title"><div><span>Route correlation</span><h3>Verify a supported semantic path</h3></div><small>Passive canonical query · not an active MQ trace</small></div><p class="p2h-copy">These pairs are candidates because both endpoints are adjacent to the investigated object. A candidate is not a proven route until the canonical route tracer returns a directed path that crosses this object.</p><div class="p2h-trace-candidates">${candidates.map((item, index) => `<button type="button" data-p2h-trace="${index}"><span>${hEsc(item.from?.display_name || item.from?.entity_id || "Upstream")}</span><b>→</b><span>${hEsc(item.to?.display_name || item.to?.entity_id || "Downstream")}</span><small>Verify canonical path</small></button>`).join("")}</div><div id="p2hTraceResult" class="p2h-trace-result" hidden></div></section>`;
}

function renderImpact() {
  const body = h$("objectWorkspaceBody");
  if (!body) return;
  if (phase2hState.error) {
    body.innerHTML = `<div class="p2h-empty"><strong>Impact context unavailable</strong><span>${hEsc(phase2hState.error)}</span></div>`;
    return;
  }
  const data = phase2hState.impact;
  if (!data) {
    body.innerHTML = `<div class="p2h-empty"><strong>Loading topology-aware impact…</strong><span>Reading the current canonical delivery context.</span></div>`;
    return;
  }
  const [coverageTitle, coverageNote] = coverageCopy(data.coverage_state);
  const entity = data.entity || phase2hState.canonical?.entity || {};

  body.innerHTML = `<div class="p2h-impact">
    <section class="p2h-boundary"><div><span>Topology-aware impact boundary</span><h3>${hEsc(coverageTitle)}</h3><p>${hEsc(coverageNote)}</p></div><aside><span>Application / service impact</span><strong>Not established</strong><small>Operational findings remain attached to the investigated canonical object unless additional evidence supports wider impact.</small></aside></section>
    <div class="p2h-flow-grid">
      ${relationColumn("Upstream", "Producer / access context", data.upstream || [], "No upstream delivery-facing relationship is established.")}
      <section class="p2h-focus"><span>Investigated object</span><strong>${hEsc(entity.display_name || entity.identity_key || entity.entity_id || "Current object")}</strong><small>${hEsc(hType(entity.semantic_type))}</small><div>${hEvidence(entity.evidence_classes)}</div></section>
      ${relationColumn("Downstream", "Consumer / resolution context", data.downstream || [], "No downstream delivery-facing relationship is established.")}
    </div>
    ${transportHtml(data.transport || [])}
    ${traceCandidateHtml(data.trace_candidates || [])}
    ${contextHtml(data.context || [])}
    ${unresolvedHtml(data.unresolved || [])}
    <section class="p2h-semantics"><strong>How OSI constrains this view</strong><p>Runtime open handles prove access mode, not PUT/GET activity. Structural and cluster relationships are context, not message-path proof. Missing downstream evidence is not treated as disconnection. Route candidates are verified only through the existing canonical route query.</p></section>
  </div>`;

  body.querySelectorAll("[data-p2h-neighbor]").forEach((button) => button.addEventListener("click", () => {
    const entityId = button.dataset.p2hNeighbor;
    if (entityId) window.osiOpenInvestigationWorkspace?.(entityId, true);
  }));
  body.querySelectorAll("[data-p2h-trace]").forEach((button) => button.addEventListener("click", () => runTraceCandidate(Number(button.dataset.p2hTrace))));
}

function modeCopy(mode) {
  if (mode === "observed_activity") return "Observed activity path";
  if (mode === "runtime_access") return "Runtime access path";
  return "Configured semantic path";
}

async function runTraceCandidate(index) {
  const result = h$("p2hTraceResult");
  const candidate = phase2hState.impact?.trace_candidates?.[index];
  if (!result || !candidate?.from?.entity_id || !candidate?.to?.entity_id) return;
  result.hidden = false;
  result.innerHTML = `<span>Verifying canonical path…</span>`;
  try {
    const data = await hApi(`/api/v2/routes/trace?from=${encodeURIComponent(candidate.from.entity_id)}&to=${encodeURIComponent(candidate.to.entity_id)}&max_depth=12`);
    if (!data.found) {
      result.innerHTML = `<strong>No supported directed path found</strong><p>${hEsc(data.explanation || "Current evidence does not support this end-to-end path.")}</p><small>This is an evidence gap, not proof of disconnection.</small>`;
      return;
    }
    const crosses = (data.nodes || []).some((node) => node.entity_id === phase2hState.entityId);
    const nodes = data.nodes || [];
    const steps = data.steps || [];
    let journey = "";
    nodes.forEach((node, nodeIndex) => {
      if (nodeIndex > 0) {
        const step = steps[nodeIndex - 1] || {};
        journey += `<div class="p2h-trace-edge"><span>${hEsc(step.label || step.semantic_type || "relationship")}</span>${hEvidence(step.evidence_classes)}</div>`;
      }
      journey += `<div class="p2h-trace-node ${node.entity_id === phase2hState.entityId ? "focus" : ""}"><span>${hEsc(hType(node.semantic_type))}</span><strong>${hEsc(node.display_name || node.identity_key || node.entity_id)}</strong></div>`;
    });
    const warnings = [...new Set(steps.map((step) => step.semantic_warning).filter(Boolean))];
    result.innerHTML = `<header><div><span>Canonical route verification</span><strong>${crosses ? "Supported path crosses this object" : "Supported path does not cross this object"}</strong></div><b>${hEsc(modeCopy(data.mode))}</b></header><div class="p2h-trace-journey">${journey}</div>${warnings.length ? `<div class="p2h-trace-warnings">${warnings.map((warning) => `<p>${hEsc(warning)}</p>`).join("")}</div>` : ""}<footer>${crosses ? "This establishes a canonical semantic path through the investigated object; it does not by itself establish application/service impact." : "No impact correlation is asserted because the supported path does not traverse the investigated object."}</footer>`;
  } catch (error) {
    result.innerHTML = `<strong>Route verification unavailable</strong><p>${hEsc(error instanceof Error ? error.message : String(error))}</p>`;
  }
}

function installImpactTab() {
  const tabs = h$("objectWorkspaceTabs");
  if (!tabs) return;
  let button = tabs.querySelector('[data-p2f-tab="Impact"]');
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.dataset.p2fTab = "Impact";
    button.textContent = "Impact";
    const monitor = tabs.querySelector('[data-p2f-tab="Monitor"]');
    if (monitor) monitor.after(button); else tabs.appendChild(button);
    button.addEventListener("click", () => {
      tabs.querySelectorAll("button").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      renderImpact();
    });
  }
}

function refineSynopsisHeadline() {
  const workspace = h$("objectWorkspace");
  if (!workspace || workspace.hidden) return;
  const synopsis = workspace.querySelector(".p2g-synopsis h3");
  const why = [...workspace.querySelectorAll(".p2g-question-grid article")].find((article) => article.querySelector("b")?.textContent?.trim() === "Why was this raised?");
  const summaries = why ? [...why.querySelectorAll("p")].map((item) => item.textContent.trim()).filter(Boolean) : [];
  if (synopsis && summaries.length > 1) synopsis.textContent = summaries.join("; ");
}

async function loadImpact(canonical) {
  const entityId = canonical?.entity?.entity_id;
  if (!entityId) return;
  const sequence = ++phase2hState.sequence;
  phase2hState.entityId = entityId;
  phase2hState.canonical = canonical;
  phase2hState.impact = null;
  phase2hState.error = "";
  installImpactTab();
  refineSynopsisHeadline();
  try {
    const data = await hApi(`/api/v2/routes/impact?entity_id=${encodeURIComponent(entityId)}`);
    if (sequence !== phase2hState.sequence || phase2hState.entityId !== entityId) return;
    phase2hState.impact = data;
  } catch (error) {
    if (sequence !== phase2hState.sequence) return;
    phase2hState.error = error instanceof Error ? error.message : String(error);
  }
  installImpactTab();
  refineSynopsisHeadline();
  const active = h$("objectWorkspaceTabs")?.querySelector("button.active")?.dataset.p2fTab;
  if (active === "Impact") renderImpact();
}

if (typeof basePhase2HEnhance === "function") {
  window.osiEnhanceObjectWorkspace = async (canonicalData) => {
    await basePhase2HEnhance(canonicalData);
    try { await loadImpact(canonicalData); } catch (error) { console.warn("Phase 2H impact enhancement failed", error); }
  };
}

document.addEventListener("click", (event) => {
  const tab = event.target.closest("#objectWorkspaceTabs button")?.dataset.p2fTab;
  if (tab === "Summary") setTimeout(refineSynopsisHeadline, 0);
  if (tab === "Impact") setTimeout(renderImpact, 0);
});

installPhase2HStyles();
