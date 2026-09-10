const OPERATIONAL_UI_REVISION = "20260910-1";

const operationalState = {
  overviewController: null,
  detailController: null,
  detailSequence: 0,
  currentEntityId: "",
  currentEntityName: "",
  refreshTimer: null,
};

const oq = (id) => document.getElementById(id);
const oesc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const TYPE_LABELS = {
  "mq.queue_manager": "Queue manager",
  "mq.queue": "Queue",
  "mq.channel": "Channel",
  "mq.listener": "Listener",
  "mq.cluster": "Cluster",
  "infra.host": "Host",
  "infra.network_endpoint": "Network endpoint",
  "app.application": "Application",
  "app.application_instance": "Application instance",
};
const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };
const STATUS_ORDER = { OPEN: 0, ACKNOWLEDGED: 1, RESOLVED: 2 };

function installOperationalStyles() {
  if (document.querySelector('link[data-operational-intelligence]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `/operational-intelligence.css?v=${OPERATIONAL_UI_REVISION}`;
  link.dataset.operationalIntelligence = "true";
  document.head.appendChild(link);
}

async function operationalApi(path, { signal } = {}) {
  const response = await fetch(path, { headers: { accept: "application/json" }, signal });
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

function relativeAge(value) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "unknown time";
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}

function severityLabel(value) {
  return value === "critical" ? "Critical" : value === "warning" ? "Warning" : "Information";
}

function confidenceLabel(confidence) {
  const level = confidence?.level || "unknown";
  const score = Number(confidence?.score);
  return Number.isFinite(score) ? `${level} · ${Math.round(score * 100)}%` : level;
}

function findingSort(a, b) {
  return (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9)
    || (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
    || new Date(b.last_seen || 0).getTime() - new Date(a.last_seen || 0).getTime()
    || String(a.display_name || "").localeCompare(String(b.display_name || ""));
}

function ensureOverviewAttention() {
  const overview = oq("view-overview");
  if (!overview) return null;
  let section = oq("operationalAttention");
  if (section) return section;
  section = document.createElement("section");
  section.id = "operationalAttention";
  section.className = "operational-attention section-block";
  section.innerHTML = `
    <div class="operational-attention-head">
      <div>
        <p class="section-kicker">Operational findings</p>
        <h2>What requires attention?</h2>
        <p id="operationalAttentionCopy">Loading evidence-linked findings…</p>
      </div>
      <div class="operational-attention-authority"><span></span><strong>Derived from OSI evidence</strong></div>
    </div>
    <div id="operationalAttentionSummary" class="operational-attention-summary" aria-live="polite"></div>
    <div id="operationalAttentionList" class="operational-attention-list"></div>`;
  overview.insertBefore(section, overview.firstElementChild);
  return section;
}

function summaryCard(label, value, tone, note) {
  return `<div class="operational-summary-card ${tone}"><span>${oesc(label)}</span><strong>${Number(value || 0).toLocaleString()}</strong><small>${oesc(note)}</small></div>`;
}

function findingCard(finding) {
  const qmgr = finding?.details?.queue_manager || finding?.representative_source?.source_host || "";
  const evidenceCount = Array.isArray(finding.evidence) ? finding.evidence.length : 0;
  const status = finding.status || "OPEN";
  return `<button type="button" class="operational-finding-card severity-${oesc(finding.severity)}" data-operational-entity="${oesc(finding.entity_id)}" data-operational-finding="${oesc(finding.finding_id)}">
    <span class="operational-finding-rail"></span>
    <span class="operational-finding-body">
      <span class="operational-finding-topline"><b class="operational-severity">${oesc(severityLabel(finding.severity))}</b><b class="operational-status status-${oesc(String(status).toLowerCase())}">${oesc(status)}</b><small>${oesc(typeLabel(finding.semantic_type))}${qmgr ? ` · ${oesc(qmgr)}` : ""}</small></span>
      <strong>${oesc(finding.display_name || finding.entity_id)}</strong>
      <span class="operational-finding-summary">${oesc(finding.summary || finding.diagnosis || "Evidence-linked operational finding")}</span>
      <span class="operational-finding-meta">${oesc(confidenceLabel(finding.confidence))} confidence · ${oesc(finding.coverage_state || "unknown")} coverage · ${evidenceCount} evidence reference${evidenceCount === 1 ? "" : "s"} · ${oesc(relativeAge(finding.last_seen))}</span>
    </span>
    <span class="operational-finding-open">Inspect object →</span>
  </button>`;
}

async function countFindings(status, severity, signal) {
  const params = new URLSearchParams({ status, severity, limit: "1", offset: "0" });
  const data = await operationalApi(`/api/v2/findings/current?${params}`, { signal });
  return Number(data?.page?.total || 0);
}

async function refreshOverviewAttention() {
  const section = ensureOverviewAttention();
  if (!section || currentView() !== "overview") return;
  operationalState.overviewController?.abort();
  const controller = new AbortController();
  operationalState.overviewController = controller;
  const summary = oq("operationalAttentionSummary");
  const list = oq("operationalAttentionList");
  const copy = oq("operationalAttentionCopy");
  summary.innerHTML = `<div class="operational-loading">Reading current operational evidence…</div>`;
  list.innerHTML = "";
  try {
    const [statusData, openData, acknowledgedData, criticalOpen, criticalAck, warningOpen, warningAck] = await Promise.all([
      operationalApi("/api/v2/operations/status", { signal: controller.signal }),
      operationalApi("/api/v2/findings/current?status=OPEN&limit=12&offset=0", { signal: controller.signal }),
      operationalApi("/api/v2/findings/current?status=ACKNOWLEDGED&limit=12&offset=0", { signal: controller.signal }),
      countFindings("OPEN", "critical", controller.signal),
      countFindings("ACKNOWLEDGED", "critical", controller.signal),
      countFindings("OPEN", "warning", controller.signal),
      countFindings("ACKNOWLEDGED", "warning", controller.signal),
    ]);
    if (controller.signal.aborted) return;
    const currentSources = Number(statusData.current_sources || 0);
    const openTotal = Number(openData?.page?.total || 0);
    const acknowledgedTotal = Number(acknowledgedData?.page?.total || 0);
    const unresolvedTotal = openTotal + acknowledgedTotal;
    const criticalTotal = criticalOpen + criticalAck;
    const warningTotal = warningOpen + warningAck;
    const infoTotal = Math.max(0, unresolvedTotal - criticalTotal - warningTotal);
    const gaps = Number(statusData.current_coverage_gaps || 0);
    const observations = Number(statusData.current_observations || 0);

    if (!currentSources) {
      copy.textContent = "No operational evaluation is currently published. Canonical inventory remains valid, but operational health is unknown until evidence-linked observations and findings are activated.";
      summary.innerHTML = [
        summaryCard("Operational sources", 0, "neutral", "No current evaluation"),
        summaryCard("Current observations", observations, "neutral", "No active operational source"),
        summaryCard("Unresolved findings", 0, "neutral", "Not equivalent to healthy"),
        summaryCard("Coverage gaps", gaps, gaps ? "warning" : "neutral", "Collection quality records"),
      ].join("");
      list.innerHTML = `<div class="operational-empty"><strong>Operational status is unknown</strong><span>OSI will not infer a green state from missing runtime evidence. Publish a qualified findings evaluation to populate this layer.</span></div>`;
      return;
    }

    copy.textContent = unresolvedTotal
      ? `${unresolvedTotal.toLocaleString()} unresolved evidence-linked finding${unresolvedTotal === 1 ? "" : "s"} across ${currentSources.toLocaleString()} current operational source${currentSources === 1 ? "" : "s"}.`
      : `No unresolved findings are present in the ${currentSources.toLocaleString()} current operational source${currentSources === 1 ? "" : "s"}. Coverage remains a separate question.`;
    summary.innerHTML = [
      summaryCard("Critical", criticalTotal, criticalTotal ? "critical" : "neutral", "Unresolved"),
      summaryCard("Warnings", warningTotal, warningTotal ? "warning" : "neutral", "Unresolved"),
      summaryCard("Information", infoTotal, infoTotal ? "info" : "neutral", "Unresolved coverage / diagnostic state"),
      summaryCard("Acknowledged", acknowledgedTotal, acknowledgedTotal ? "ack" : "neutral", "Still current, not resolved"),
      summaryCard("Coverage gaps", gaps, gaps ? "warning" : "neutral", "Partial / failed / not collected samples"),
    ].join("");

    const combined = [...(openData.findings || []), ...(acknowledgedData.findings || [])]
      .sort(findingSort)
      .slice(0, 12);
    list.innerHTML = combined.length
      ? `<div class="operational-finding-grid">${combined.map(findingCard).join("")}</div><p class="operational-coverage-note">Finding severity, confidence, lifecycle state, and evidence coverage are independent. A coverage gap is not a health failure, and absence of a finding is not proof of recovery.</p>`
      : `<div class="operational-empty"><strong>No unresolved findings in current operational evaluations</strong><span>${gaps ? `${gaps.toLocaleString()} coverage gap record${gaps === 1 ? " remains" : "s remain"}; incomplete evidence must still be treated separately.` : "Current evaluations contain no unresolved findings. This statement is bounded by the published evidence coverage."}</span></div>`;
  } catch (error) {
    if (error?.name === "AbortError") return;
    copy.textContent = "Operational findings could not be loaded.";
    summary.innerHTML = "";
    list.innerHTML = `<div class="operational-empty error"><strong>Operational intelligence unavailable</strong><span>${oesc(error instanceof Error ? error.message : String(error))}</span></div>`;
  } finally {
    if (operationalState.overviewController === controller) operationalState.overviewController = null;
  }
}

function selectedDetailEntityId() {
  const inspectorIds = [...document.querySelectorAll("#exploreIdentityInspector [data-copy-value]")]
    .map((node) => node.dataset.copyValue || "")
    .filter((value) => /^cent_[0-9a-f]{24}$/.test(value));
  if (inspectorIds[0]) return inspectorIds[0];
  const selected = document.querySelector('tr[data-estate-entity-id].selected, tr[data-estate-entity-id][aria-selected="true"]');
  return selected?.dataset.estateEntityId || operationalState.currentEntityId || "";
}

function currentDetailName() {
  return oq("detailName")?.textContent?.trim() || operationalState.currentEntityName || "Canonical entity";
}

function ensureDetailOperationsSection() {
  const detail = oq("detailContent");
  if (!detail || detail.hidden) return null;
  let section = oq("objectOperationalIntelligence");
  if (section) return section;
  section = document.createElement("section");
  section.id = "objectOperationalIntelligence";
  section.className = "detail-section object-operational-intelligence";
  section.innerHTML = `
    <div class="object-operational-head">
      <div><span>Operational intelligence</span><h3>Evidence-linked runtime view</h3></div>
      <span id="objectOperationalFreshness" class="object-operational-freshness">Loading…</span>
    </div>
    <div class="object-operational-tabs" role="tablist" aria-label="Operational object views">
      <button type="button" class="active" role="tab" aria-selected="true" data-operational-tab="findings">Findings <span id="objectFindingCount">—</span></button>
      <button type="button" role="tab" aria-selected="false" data-operational-tab="monitor">Monitor <span id="objectObservationCount">—</span></button>
      <button type="button" role="tab" aria-selected="false" data-operational-tab="evidence">Evidence <span id="objectEvidenceCount">—</span></button>
    </div>
    <div id="objectOperationalBody" class="object-operational-body" aria-live="polite"></div>`;
  const identity = oq("exploreIdentityInspector");
  if (identity) identity.insertAdjacentElement("afterend", section);
  else oq("detailFacts")?.insertAdjacentElement("afterend", section);
  section.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-operational-tab]");
    if (!tab) return;
    section.querySelectorAll("[data-operational-tab]").forEach((button) => {
      const active = button === tab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    renderActiveDetailTab(tab.dataset.operationalTab || "findings");
  });
  return section;
}

function observationGroup(observations) {
  const groups = new Map();
  for (const observation of observations || []) {
    const type = observation.observation_type || "observation";
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(observation);
  }
  for (const rows of groups.values()) rows.sort((a, b) => new Date(b.observed_at || 0) - new Date(a.observed_at || 0));
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function humanObservationType(type) {
  return String(type || "observation")
    .replace(/^mq\./, "")
    .replaceAll(".", " · ")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatObservationValue(observation) {
  const value = observation?.value;
  const unit = observation?.unit || "";
  if (value == null || value === "") return "—";
  return `${String(value)}${unit && !["state"].includes(unit) ? ` ${unit}` : ""}`;
}

function renderFindingList(findings) {
  if (!findings.length) {
    return `<div class="object-operational-empty"><strong>No current findings for this object</strong><span>This means no current evaluator occurrence is attached to this canonical entity. It is not a universal health guarantee.</span></div>`;
  }
  return `<div class="object-finding-list">${findings.sort(findingSort).map((finding) => {
    const evidence = Array.isArray(finding.evidence) ? finding.evidence : [];
    return `<details class="object-finding severity-${oesc(finding.severity)}">
      <summary>
        <span class="object-finding-indicator"></span>
        <span class="object-finding-copy"><span><b>${oesc(severityLabel(finding.severity))}</b><em>${oesc(finding.status || "OPEN")}</em><small>${oesc(finding.rule_id)}</small></span><strong>${oesc(finding.summary)}</strong><span>${oesc(confidenceLabel(finding.confidence))} confidence · ${oesc(finding.coverage_state)} coverage · last seen ${oesc(relativeAge(finding.last_seen))}</span></span>
        <span class="object-finding-chevron">⌄</span>
      </summary>
      <div class="object-finding-detail"><p>${oesc(finding.diagnosis || "No diagnosis text was supplied.")}</p><dl><div><dt>Finding ID</dt><dd>${oesc(finding.finding_id)}</dd></div><div><dt>Lifecycle</dt><dd>${oesc(finding.status || "OPEN")}${finding.lifecycle?.note ? ` · ${oesc(finding.lifecycle.note)}` : ""}</dd></div><div><dt>First seen</dt><dd>${oesc(finding.first_seen || "—")}</dd></div><div><dt>Last seen</dt><dd>${oesc(finding.last_seen || "—")}</dd></div></dl>${evidence.length ? `<div class="object-evidence-inline"><strong>Evidence references</strong>${evidence.map((item) => `<span><b>${oesc(item.sample_id || "sample")}</b><code>${oesc(item.evidence_ref || "")}</code><small>${oesc((item.observation_types || []).join(" · "))}</small></span>`).join("")}</div>` : ""}</div>
    </details>`;
  }).join("")}</div>`;
}

function renderMonitor(observations) {
  if (!observations.length) {
    return `<div class="object-operational-empty"><strong>No operational observations for this object</strong><span>OSI has no current sampled runtime facts attached to this canonical entity.</span></div>`;
  }
  return `<div class="object-monitor-grid">${observationGroup(observations).map(([type, rows]) => {
    const latest = rows[0];
    const numeric = rows.filter((row) => typeof row.value === "number");
    const history = rows.slice(0, 5).reverse().map((row) => formatObservationValue(row)).join(" → ");
    const range = numeric.length > 1 ? `${Math.min(...numeric.map((row) => Number(row.value)))}–${Math.max(...numeric.map((row) => Number(row.value)))} ${latest.unit || ""}` : "";
    return `<article class="object-monitor-card"><span>${oesc(humanObservationType(type))}</span><strong>${oesc(formatObservationValue(latest))}</strong><small>${oesc(relativeAge(latest.observed_at))} · ${rows.length} sample${rows.length === 1 ? "" : "s"}${range ? ` · range ${oesc(range)}` : ""}</small>${rows.length > 1 ? `<div class="object-monitor-history" title="Oldest to newest among the latest five samples">${oesc(history)}</div>` : ""}<div class="object-monitor-source">${oesc(latest?.source?.queue_manager || "")}${latest?.source?.source_host ? ` · ${oesc(latest.source.source_host)}` : ""}</div></article>`;
  }).join("")}</div><p class="object-operational-note">Monitor shows stored OSI operational observations only. The browser does not infer findings, thresholds, causality, or missing runtime activity.</p>`;
}

function dedupeEvidence(findings, observations, coverage) {
  const items = new Map();
  function add(key, item) {
    if (!key) return;
    if (!items.has(key)) items.set(key, item);
  }
  for (const finding of findings || []) {
    for (const evidence of finding.evidence || []) {
      const key = `finding|${evidence.evidence_ref}|${evidence.sample_id}|${evidence.observed_at}`;
      add(key, { kind: "Finding evidence", ref: evidence.evidence_ref, sample: evidence.sample_id, observed: evidence.observed_at, state: finding.coverage_state, context: (evidence.observation_types || []).join(" · "), error: evidence.error || "" });
    }
  }
  for (const observation of observations || []) {
    const source = observation.source || {};
    const key = `observation|${source.evidence_ref}|${source.sample_id}|${observation.observed_at}`;
    add(key, { kind: "Observation evidence", ref: source.evidence_ref, sample: source.sample_id, observed: observation.observed_at, state: observation?.quality?.coverage || "point_in_time", context: observation.observation_type, error: "" });
  }
  for (const item of coverage || []) {
    const key = `coverage|${item.evidence_ref}|${item.sample_id}|${item.observed_at}|${item.observation_family}`;
    add(key, { kind: "Coverage", ref: item.evidence_ref, sample: item.sample_id, observed: item.observed_at, state: item.state, context: `${item.scope_key} · ${item.observation_family}`, error: item.error || "" });
  }
  return [...items.values()].sort((a, b) => new Date(b.observed || 0) - new Date(a.observed || 0));
}

function renderEvidence(findings, observations, coverage) {
  const items = dedupeEvidence(findings, observations, coverage);
  if (!items.length) {
    return `<div class="object-operational-empty"><strong>No exact operational evidence references</strong><span>No finding, observation, or matching queue-manager coverage record is attached to this object in the current operational evaluations.</span></div>`;
  }
  return `<div class="object-evidence-table"><div class="object-evidence-header"><span>Class</span><span>Evidence reference</span><span>Coverage</span><span>Observed</span></div>${items.map((item) => `<div class="object-evidence-row"><span><b>${oesc(item.kind)}</b><small>${oesc(item.context || "")}</small></span><code>${oesc(item.ref || "—")}</code><span class="coverage-state coverage-${oesc(item.state)}">${oesc(item.state || "unknown")}${item.error ? `<small>${oesc(item.error)}</small>` : ""}</span><span title="${oesc(item.observed || "")}">${oesc(relativeAge(item.observed))}<small>${oesc(item.sample || "")}</small></span></div>`).join("")}</div><p class="object-operational-note">Coverage records describe whether OSI could support a claim. Failed or missing collection is preserved as evidence and must not be translated into a healthy state.</p>`;
}

function renderActiveDetailTab(tab) {
  const body = oq("objectOperationalBody");
  const section = oq("objectOperationalIntelligence");
  if (!body || !section) return;
  const findings = section._operationalFindings || [];
  const observations = section._operationalObservations || [];
  const coverage = section._operationalCoverage || [];
  if (tab === "monitor") body.innerHTML = renderMonitor(observations);
  else if (tab === "evidence") body.innerHTML = renderEvidence(findings, observations, coverage);
  else body.innerHTML = renderFindingList(findings);
}

function deriveQueueManager(findings, observations) {
  for (const observation of observations || []) {
    if (observation?.source?.queue_manager) return String(observation.source.queue_manager);
  }
  for (const finding of findings || []) {
    if (finding?.details?.queue_manager) return String(finding.details.queue_manager);
  }
  return "";
}

async function refreshCurrentDetailOperations() {
  const detail = oq("detailContent");
  if (!detail || detail.hidden || oq("detailName")?.textContent === "Loading…") return;
  const entityId = selectedDetailEntityId();
  if (!entityId) return;
  operationalState.currentEntityId = entityId;
  operationalState.currentEntityName = currentDetailName();
  const section = ensureDetailOperationsSection();
  if (!section) return;
  const sequence = ++operationalState.detailSequence;
  operationalState.detailController?.abort();
  const controller = new AbortController();
  operationalState.detailController = controller;
  const body = oq("objectOperationalBody");
  body.innerHTML = `<div class="operational-loading">Loading findings and operational observations…</div>`;
  try {
    const [findingsData, observationsData] = await Promise.all([
      operationalApi(`/api/v2/findings/current?entity_id=${encodeURIComponent(entityId)}&limit=200&offset=0`, { signal: controller.signal }),
      operationalApi(`/api/v2/operations/current/observations?entity_id=${encodeURIComponent(entityId)}&limit=200&offset=0`, { signal: controller.signal }),
    ]);
    if (controller.signal.aborted || sequence !== operationalState.detailSequence || entityId !== selectedDetailEntityId()) return;
    const findings = findingsData.findings || [];
    const observations = observationsData.observations || [];
    const qmgr = deriveQueueManager(findings, observations);
    let coverage = [];
    if (qmgr) {
      try {
        const coverageData = await operationalApi(`/api/v2/operations/current/coverage?scope_key=${encodeURIComponent(qmgr)}&limit=200&offset=0`, { signal: controller.signal });
        coverage = coverageData.coverage || [];
      } catch (error) {
        if (error?.name === "AbortError") throw error;
      }
    }
    if (controller.signal.aborted || sequence !== operationalState.detailSequence) return;
    section._operationalFindings = findings;
    section._operationalObservations = observations;
    section._operationalCoverage = coverage;
    oq("objectFindingCount").textContent = String(findings.length);
    oq("objectObservationCount").textContent = String(observations.length);
    oq("objectEvidenceCount").textContent = String(dedupeEvidence(findings, observations, coverage).length);
    const timestamps = [
      ...findings.map((item) => item.last_seen),
      ...observations.map((item) => item.observed_at),
      ...coverage.map((item) => item.observed_at),
    ].filter(Boolean).map((value) => new Date(value).getTime()).filter(Number.isFinite);
    const latest = timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : "";
    oq("objectOperationalFreshness").textContent = latest ? `Latest evidence ${relativeAge(latest)}` : "No operational evidence";
    oq("objectOperationalFreshness").title = latest || "";
    const active = section.querySelector("[data-operational-tab].active")?.dataset.operationalTab || "findings";
    renderActiveDetailTab(active);
  } catch (error) {
    if (error?.name === "AbortError") return;
    body.innerHTML = `<div class="object-operational-empty error"><strong>Operational data unavailable</strong><span>${oesc(error instanceof Error ? error.message : String(error))}</span></div>`;
    oq("objectOperationalFreshness").textContent = "Unavailable";
  } finally {
    if (operationalState.detailController === controller) operationalState.detailController = null;
  }
}

async function openCanonicalEntity(entityId) {
  if (!entityId) return;
  if (typeof window.osiOpenObjectWorkspace === "function") {
    await window.osiOpenObjectWorkspace(entityId, true);
    setTimeout(refreshCurrentDetailOperations, 180);
    return;
  }
  try {
    const detail = await operationalApi(`/api/v2/estate/current/entities/${encodeURIComponent(entityId)}?relation_limit=1`);
    await window.osiNavigateProduct?.("inventory");
    const search = oq("inventorySearch");
    const type = oq("inventoryType");
    if (type && detail?.entity?.semantic_type && [...type.options].some((option) => option.value === detail.entity.semantic_type)) {
      type.value = detail.entity.semantic_type;
      type.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (search) {
      search.value = detail?.entity?.display_name || detail?.entity?.identity_key || entityId;
      search.dispatchEvent(new Event("input", { bubbles: true }));
    }
    setTimeout(() => {
      const row = document.querySelector(`tr[data-estate-entity-id="${CSS.escape(entityId)}"]`);
      row?.click();
      row?.scrollIntoView({ block: "center" });
    }, 650);
  } catch {
    await window.osiNavigateProduct?.("inventory");
  }
}

function bindOperationalInteractions() {
  document.addEventListener("click", (event) => {
    const finding = event.target.closest("[data-operational-entity]");
    if (finding) {
      event.preventDefault();
      void openCanonicalEntity(finding.dataset.operationalEntity || "");
      return;
    }
    const row = event.target.closest("tr[data-estate-entity-id]");
    if (row) {
      operationalState.currentEntityId = row.dataset.estateEntityId || "";
      operationalState.currentEntityName = row.children?.[1]?.textContent?.trim() || "";
      setTimeout(refreshCurrentDetailOperations, 120);
    }
    const view = event.target.closest("[data-view], [data-go]")?.dataset.view || event.target.closest("[data-go]")?.dataset.go;
    if (view === "overview") setTimeout(refreshOverviewAttention, 80);
  }, true);

  const detail = oq("detailContent");
  if (detail) {
    const observer = new MutationObserver(() => {
      if (detail.hidden) {
        operationalState.detailSequence += 1;
        operationalState.detailController?.abort();
        oq("objectOperationalIntelligence")?.remove();
        return;
      }
      setTimeout(refreshCurrentDetailOperations, 80);
    });
    observer.observe(detail, { attributes: true, attributeFilter: ["hidden"] });
  }

  const detailName = oq("detailName");
  if (detailName) {
    const observer = new MutationObserver(() => {
      if (detailName.textContent && detailName.textContent !== "Loading…") setTimeout(refreshCurrentDetailOperations, 80);
    });
    observer.observe(detailName, { childList: true, subtree: false });
  }
}

function schedulePeriodicRefresh() {
  clearInterval(operationalState.refreshTimer);
  operationalState.refreshTimer = setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (currentView() === "overview") void refreshOverviewAttention();
    if (!oq("detailContent")?.hidden) void refreshCurrentDetailOperations();
  }, 60_000);
}

function refreshOperationalIntelligence() {
  ensureOverviewAttention();
  if (currentView() === "overview") void refreshOverviewAttention();
  if (!oq("detailContent")?.hidden) void refreshCurrentDetailOperations();
}

function initOperationalIntelligence() {
  installOperationalStyles();
  ensureOverviewAttention();
  bindOperationalInteractions();
  schedulePeriodicRefresh();
  refreshOperationalIntelligence();
}

window.osiRefreshOperationalIntelligence = refreshOperationalIntelligence;
window.osiOpenOperationalEntity = openCanonicalEntity;
initOperationalIntelligence();
