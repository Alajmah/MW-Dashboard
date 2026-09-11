const PHASE2F_REVISION = "20260911-1";

const phase2fState = {
  entityId: "",
  canonical: null,
  findings: [],
  observations: [],
  coverage: [],
  activeTab: "Summary",
  sequence: 0,
};

const p2f = (id) => document.getElementById(id);
const p2fEsc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const P2F_SEVERITY = { critical: 0, warning: 1, info: 2 };
const P2F_METRICS = {
  "mq.queue.depth.current": { label: "Queue depth", short: "Depth", unit: "messages" },
  "mq.queue.message.age.oldest_seconds": { label: "Oldest message age", short: "Oldest age", unit: "seconds" },
  "mq.queue.process.input_count": { label: "Input processes", short: "IPPROCS", unit: "processes" },
  "mq.queue.process.output_count": { label: "Output processes", short: "OPPROCS", unit: "processes" },
};

function installPhase2FStyles() {
  if (document.querySelector('link[data-phase2f-workbench]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `/phase2f-investigation-workbench.css?v=${PHASE2F_REVISION}`;
  link.dataset.phase2fWorkbench = "true";
  document.head.appendChild(link);
}

async function p2fApi(path) {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) throw new Error(body.detail || `Request failed (${response.status})`);
  return body;
}

function relativeAge(value) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "unknown age";
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

function absoluteTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "timestamp unavailable" : date.toLocaleString();
}

function formatValue(value, unit = "") {
  if (value == null || value === "") return "—";
  if (typeof value === "number") return `${value.toLocaleString()}${unit ? ` ${unit}` : ""}`;
  return `${String(value)}${unit && unit !== "state" ? ` ${unit}` : ""}`;
}

function propertyValue(entity, key) {
  const properties = entity?.properties && typeof entity.properties === "object" ? entity.properties : {};
  const match = Object.entries(properties).find(([name]) => name.toLowerCase() === key.toLowerCase());
  const value = match?.[1];
  if (Array.isArray(value)) return value.join(", ");
  return value == null || value === "" ? "" : String(value);
}

function latestTimestamp() {
  const values = [
    ...phase2fState.findings.map((item) => item.last_seen),
    ...phase2fState.observations.map((item) => item.observed_at),
    ...phase2fState.coverage.map((item) => item.observed_at),
  ].filter(Boolean).map((value) => new Date(value).getTime()).filter(Number.isFinite);
  return values.length ? new Date(Math.max(...values)).toISOString() : "";
}

function deriveQueueManager() {
  for (const observation of phase2fState.observations) if (observation?.source?.queue_manager) return String(observation.source.queue_manager);
  for (const finding of phase2fState.findings) if (finding?.details?.queue_manager) return String(finding.details.queue_manager);
  return propertyValue(phase2fState.canonical?.entity, "QUEUE_MANAGER");
}

function deriveSourceHost() {
  for (const observation of phase2fState.observations) if (observation?.source?.source_host) return String(observation.source.source_host);
  return "";
}

function metricSeries(type) {
  return phase2fState.observations
    .filter((item) => item.observation_type === type && typeof item.value === "number")
    .sort((a, b) => new Date(a.observed_at || 0) - new Date(b.observed_at || 0));
}

function sparkline(type) {
  const rows = metricSeries(type);
  if (rows.length < 2) return "";
  const values = rows.map((row) => Number(row.value));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values.map((value, index) => {
    const x = values.length === 1 ? 50 : (index / (values.length - 1)) * 100;
    const y = 36 - ((value - min) / span) * 28;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return `<svg class="p2f-sparkline" viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label="${p2fEsc(P2F_METRICS[type]?.label || type)} trend"><polyline points="${points}" fill="none" vector-effect="non-scaling-stroke"></polyline>${values.map((value, index) => {
    const x = values.length === 1 ? 50 : (index / (values.length - 1)) * 100;
    const y = 36 - ((value - min) / span) * 28;
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.6"></circle>`;
  }).join("")}</svg>`;
}

function metricTrendCard(type) {
  const rows = metricSeries(type);
  if (!rows.length) return "";
  const meta = P2F_METRICS[type] || { label: type, unit: rows.at(-1)?.unit || "" };
  const first = rows[0];
  const last = rows.at(-1);
  const delta = Number(last.value) - Number(first.value);
  return `<article class="p2f-trend-card"><div><span>${p2fEsc(meta.label)}</span><strong>${p2fEsc(formatValue(last.value, last.unit || meta.unit))}</strong><small>${rows.length} samples · ${delta === 0 ? "no net change" : `${delta > 0 ? "+" : ""}${delta.toLocaleString()} net change`}</small></div>${sparkline(type)}<footer><span>${p2fEsc(formatValue(first.value, first.unit || meta.unit))}</span><span>${p2fEsc(formatValue(last.value, last.unit || meta.unit))}</span></footer></article>`;
}

function sampleRows() {
  const groups = new Map();
  for (const observation of phase2fState.observations) {
    const sample = observation?.source?.sample_id || observation.observed_at || "sample";
    if (!groups.has(sample)) groups.set(sample, { sample, observedAt: observation.observed_at, evidenceRef: observation?.source?.evidence_ref || "", collectionMethod: observation?.source?.collection_method || "", values: {} });
    const row = groups.get(sample);
    row.observedAt = row.observedAt || observation.observed_at;
    row.evidenceRef = row.evidenceRef || observation?.source?.evidence_ref || "";
    row.collectionMethod = row.collectionMethod || observation?.source?.collection_method || "";
    row.values[observation.observation_type] = observation;
  }
  return [...groups.values()].sort((a, b) => new Date(a.observedAt || 0) - new Date(b.observedAt || 0));
}

function severityLabel(value) {
  return value === "critical" ? "Critical" : value === "warning" ? "Warning" : "Information";
}

function findingConfidence(finding) {
  const level = finding?.confidence?.level || "unknown";
  const score = Number(finding?.confidence?.score);
  return Number.isFinite(score) ? `${level} · ${Math.round(score * 100)}%` : level;
}

function renderSummary() {
  const entity = phase2fState.canonical?.entity || {};
  const findings = [...phase2fState.findings].sort((a, b) => (P2F_SEVERITY[a.severity] ?? 9) - (P2F_SEVERITY[b.severity] ?? 9));
  const latest = latestTimestamp();
  const qmgr = deriveQueueManager();
  const host = deriveSourceHost();
  const summaries = [...new Set(findings.map((item) => item.summary).filter(Boolean))];
  const inputSeries = metricSeries("mq.queue.process.input_count");
  const outputSeries = metricSeries("mq.queue.process.output_count");
  const inputLatest = inputSeries.at(-1);
  const outputLatest = outputSeries.at(-1);
  const lead = summaries.length
    ? summaries.map((text) => `<strong>${p2fEsc(text)}</strong>`).join("")
    : `<strong>No current evidence-linked finding is attached to this object.</strong>`;

  return `<div class="p2f-summary">
    <section class="p2f-diagnosis ${findings.length ? "has-findings" : ""}"><span>Operational assessment</span>${lead}<p>${findings.length ? "These statements are derived from the currently published OSI evaluation and remain bounded by its evidence window." : "The absence of a current finding is not a universal health guarantee."}</p></section>
    <div class="p2f-context-grid">
      <article><span>Queue manager</span><strong>${p2fEsc(qmgr || "Not established")}</strong></article>
      <article><span>Physical host</span><strong>${p2fEsc(host || "Not established by operational evidence")}</strong></article>
      <article><span>Findings</span><strong>${findings.length.toLocaleString()} unresolved</strong></article>
      <article><span>Latest operational evidence</span><strong>${latest ? p2fEsc(relativeAge(latest)) : "No operational evidence"}</strong><small>${latest ? p2fEsc(absoluteTime(latest)) : ""}</small></article>
      <article><span>Identity</span><strong>${p2fEsc(entity.identity_state || "unknown")}</strong><small>${p2fEsc(entity.identity_rule || "rule unavailable")}</small></article>
      <article><span>Canonical sources</span><strong>${Number(entity.source_count || 0).toLocaleString()}</strong></article>
    </div>
    ${entity.semantic_type === "mq.queue" ? `<section class="p2f-section"><div class="p2f-section-head"><div><span>Five-sample evidence</span><h3>Queue behavior</h3></div><small>Stored OSI observations only</small></div><div class="p2f-trend-grid">${metricTrendCard("mq.queue.depth.current")}${metricTrendCard("mq.queue.message.age.oldest_seconds")}</div><div class="p2f-process-strip"><div><span>Latest input processes</span><strong>${inputLatest ? p2fEsc(formatValue(inputLatest.value, inputLatest.unit)) : "—"}</strong></div><div><span>Latest output processes</span><strong>${outputLatest ? p2fEsc(formatValue(outputLatest.value, outputLatest.unit)) : "—"}</strong></div><div><span>Observation window</span><strong>${sampleRows().length.toLocaleString()} samples</strong></div></div></section>` : ""}
    <section class="p2f-section"><div class="p2f-section-head"><div><span>Investigation path</span><h3>Supporting evidence</h3></div></div><div class="p2f-next-steps"><button type="button" data-p2f-tab="Findings">Review ${findings.length} finding${findings.length === 1 ? "" : "s"}</button><button type="button" data-p2f-tab="Monitor">Inspect ${phase2fState.observations.length} observations</button><button type="button" data-p2f-tab="Evidence">Trace source evidence</button></div></section>
  </div>`;
}

function renderFindings() {
  const findings = [...phase2fState.findings].sort((a, b) => (P2F_SEVERITY[a.severity] ?? 9) - (P2F_SEVERITY[b.severity] ?? 9) || new Date(b.last_seen || 0) - new Date(a.last_seen || 0));
  if (!findings.length) return `<div class="p2f-empty"><strong>No current findings for this object</strong><span>No evaluator occurrence is attached to this canonical entity in the latest published operational evidence.</span></div>`;
  return `<div class="p2f-finding-list">${findings.map((finding) => {
    const evidence = finding.evidence || [];
    const related = findings.filter((item) => item.finding_id !== finding.finding_id);
    return `<article class="p2f-finding severity-${p2fEsc(finding.severity)}"><header><div><span>${p2fEsc(severityLabel(finding.severity))}</span><i>${p2fEsc(finding.status || "OPEN")}</i><small>${p2fEsc(finding.rule_id || "")}</small></div><strong>${p2fEsc(finding.summary || "Operational finding")}</strong></header><p>${p2fEsc(finding.diagnosis || "No diagnosis text was supplied.")}</p><dl><div><dt>Confidence</dt><dd>${p2fEsc(findingConfidence(finding))}</dd></div><div><dt>Coverage</dt><dd>${p2fEsc(finding.coverage_state || "unknown")}</dd></div><div><dt>First seen</dt><dd>${p2fEsc(relativeAge(finding.first_seen))}<small>${p2fEsc(absoluteTime(finding.first_seen))}</small></dd></div><div><dt>Last seen</dt><dd>${p2fEsc(relativeAge(finding.last_seen))}<small>${p2fEsc(absoluteTime(finding.last_seen))}</small></dd></div></dl>${evidence.length ? `<section><span>Exact evidence references</span>${evidence.map((item) => `<div class="p2f-evidence-ref"><b>${p2fEsc(item.sample_id || "sample")}</b><code>${p2fEsc(item.evidence_ref || "—")}</code><small>${p2fEsc((item.observation_types || []).join(" · "))}</small></div>`).join("")}</section>` : ""}${related.length ? `<footer><span>Related finding${related.length === 1 ? "" : "s"} on this object</span>${related.map((item) => `<b>${p2fEsc(item.summary)}</b>`).join("")}</footer>` : ""}</article>`;
  }).join("")}</div>`;
}

function renderQueueMonitor() {
  const rows = sampleRows();
  if (!rows.length) return `<div class="p2f-empty"><strong>No queue observations</strong><span>No current sampled runtime facts are attached to this queue.</span></div>`;
  const metricOrder = ["mq.queue.depth.current", "mq.queue.message.age.oldest_seconds", "mq.queue.process.input_count", "mq.queue.process.output_count"];
  return `<div class="p2f-monitor-intro"><div><span>Five-sample sequence</span><h3>What changed across the observation window?</h3></div><small>Oldest → newest</small></div><div class="p2f-monitor-table-wrap"><table class="p2f-monitor-table"><thead><tr><th>Sample</th><th>Observed</th>${metricOrder.map((type) => `<th>${p2fEsc(P2F_METRICS[type].short)}</th>`).join("")}<th>Evidence</th></tr></thead><tbody>${rows.map((row) => `<tr><td><strong>${p2fEsc(row.sample)}</strong></td><td><span>${p2fEsc(new Date(row.observedAt).toLocaleTimeString())}</span><small>${p2fEsc(new Date(row.observedAt).toLocaleDateString())}</small></td>${metricOrder.map((type) => { const item = row.values[type]; return `<td>${item ? `<strong>${p2fEsc(formatValue(item.value, item.unit))}</strong>` : "—"}</td>`; }).join("")}<td><code>${p2fEsc(row.evidenceRef || "—")}</code><small>${p2fEsc(row.collectionMethod || "")}</small></td></tr>`).join("")}</tbody></table></div><div class="p2f-trend-grid monitor">${metricTrendCard("mq.queue.depth.current")}${metricTrendCard("mq.queue.message.age.oldest_seconds")}</div><p class="p2f-note">Monitor is a direct projection of persisted OSI observations. It does not add thresholds, causality, or health claims in the browser.</p>`;
}

function renderGenericMonitor() {
  if (!phase2fState.observations.length) return `<div class="p2f-empty"><strong>No operational observations</strong><span>No current sampled runtime facts are attached to this canonical entity.</span></div>`;
  const groups = new Map();
  for (const item of phase2fState.observations) {
    if (!groups.has(item.observation_type)) groups.set(item.observation_type, []);
    groups.get(item.observation_type).push(item);
  }
  return `<div class="p2f-generic-monitor">${[...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([type, rows]) => {
    rows.sort((a, b) => new Date(a.observed_at || 0) - new Date(b.observed_at || 0));
    const latest = rows.at(-1);
    return `<article><span>${p2fEsc(type.replaceAll(".", " · "))}</span><strong>${p2fEsc(formatValue(latest.value, latest.unit))}</strong><small>${rows.length} sample${rows.length === 1 ? "" : "s"} · latest ${p2fEsc(relativeAge(latest.observed_at))}</small></article>`;
  }).join("")}</div>`;
}

function relationNeighbor(relation, entityId) {
  const outgoing = relation.source_entity_id === entityId;
  return { outgoing, id: relation.neighbor_entity_id || (outgoing ? relation.target_entity_id : relation.source_entity_id), name: relation.neighbor_display_name || relation.neighbor_identity_key || relation.neighbor_entity_id || (outgoing ? relation.target_entity_id : relation.source_entity_id), type: relation.neighbor_semantic_type || "entity" };
}

function renderRelationships() {
  const entity = phase2fState.canonical?.entity || {};
  const relations = phase2fState.canonical?.relations || [];
  if (!relations.length) return `<div class="p2f-empty"><strong>No canonical relationships</strong><span>No semantic relationships were returned for this entity.</span></div>`;
  return `<div class="p2f-relation-summary"><span><strong>${relations.filter((item) => item.source_entity_id === entity.entity_id).length}</strong> outgoing</span><span><strong>${relations.filter((item) => item.source_entity_id !== entity.entity_id).length}</strong> incoming</span><span><strong>${relations.length}</strong> total</span></div><div class="p2f-relation-grid">${relations.map((relation) => {
    const neighbor = relationNeighbor(relation, entity.entity_id);
    return `<button type="button" data-p2f-neighbor="${p2fEsc(neighbor.id)}"><span>${neighbor.outgoing ? "→" : "←"} ${p2fEsc(relation.semantic_type || "relationship")}</span><strong>${p2fEsc(neighbor.name)}</strong><small>${p2fEsc(neighbor.type)} · ${p2fEsc((relation.evidence_classes || []).join(" · ") || "evidence")}</small></button>`;
  }).join("")}</div>`;
}

function renderConfiguration() {
  const properties = phase2fState.canonical?.entity?.properties || {};
  const entries = Object.entries(properties).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  if (!entries.length) return `<div class="p2f-empty"><strong>No canonical configuration properties</strong></div>`;
  return `<dl class="p2f-property-grid">${entries.map(([key, value]) => `<div><dt>${p2fEsc(key)}</dt><dd>${p2fEsc(Array.isArray(value) ? value.join(", ") : value && typeof value === "object" ? JSON.stringify(value) : value ?? "—")}</dd></div>`).join("")}</dl>`;
}

function evidenceSamples() {
  const map = new Map();
  const add = (sample, observedAt, ref, type, detail, method = "") => {
    const key = sample || observedAt || ref || "evidence";
    if (!map.has(key)) map.set(key, { sample: key, observedAt, refs: new Map(), types: new Set(), methods: new Set() });
    const row = map.get(key);
    if (!row.observedAt && observedAt) row.observedAt = observedAt;
    if (ref) row.refs.set(ref, detail || type || "evidence");
    if (type) row.types.add(type);
    if (method) row.methods.add(method);
  };
  for (const observation of phase2fState.observations) add(observation?.source?.sample_id, observation.observed_at, observation?.source?.evidence_ref, observation.observation_type, observation.observation_type, observation?.source?.collection_method);
  for (const finding of phase2fState.findings) for (const item of finding.evidence || []) add(item.sample_id, item.observed_at, item.evidence_ref, (item.observation_types || []).join(" · "), finding.summary);
  for (const item of phase2fState.coverage) add(item.sample_id, item.observed_at, item.evidence_ref, `coverage.${item.observation_family}`, `${item.state} coverage${item.error ? ` · ${item.error}` : ""}`);
  return [...map.values()].sort((a, b) => new Date(a.observedAt || 0) - new Date(b.observedAt || 0));
}

function renderEvidence() {
  const entity = phase2fState.canonical?.entity || {};
  const samples = evidenceSamples();
  return `<div class="p2f-evidence-intro"><div><span>Operational proof layer</span><h3>Exact collected samples behind this investigation</h3></div><small>${samples.length} sample group${samples.length === 1 ? "" : "s"}</small></div>${samples.length ? `<div class="p2f-sample-evidence">${samples.map((sample) => `<article><header><div><span>${p2fEsc(sample.sample)}</span><strong>${p2fEsc(sample.observedAt ? absoluteTime(sample.observedAt) : "Timestamp unavailable")}</strong></div><small>${p2fEsc(sample.observedAt ? relativeAge(sample.observedAt) : "")}</small></header><div class="p2f-sample-types">${[...sample.types].map((type) => `<span>${p2fEsc(type)}</span>`).join("")}</div>${[...sample.refs.entries()].map(([ref, detail]) => `<div class="p2f-sample-ref"><code>${p2fEsc(ref)}</code><small>${p2fEsc(detail)}</small></div>`).join("")}${sample.methods.size ? `<footer>${[...sample.methods].map((method) => `<span>${p2fEsc(method)}</span>`).join("")}</footer>` : ""}</article>`).join("")}</div>` : `<div class="p2f-empty"><strong>No operational evidence references</strong></div>`}<section class="p2f-canonical-proof"><div class="p2f-section-head"><div><span>Canonical provenance</span><h3>Why OSI knows this object</h3></div></div><dl><div><dt>Entity ID</dt><dd>${p2fEsc(entity.entity_id || "—")}</dd></div><div><dt>Identity key</dt><dd>${p2fEsc(entity.identity_key || "—")}</dd></div><div><dt>Identity rule</dt><dd>${p2fEsc(entity.identity_rule || "—")}</dd></div><div><dt>Evidence classes</dt><dd>${p2fEsc((entity.evidence_classes || []).join(" · ") || "none")}</dd></div><div><dt>Source authorities</dt><dd>${(entity.source_ids || []).map((source) => `<span>${p2fEsc(source)}</span>`).join("") || "—"}</dd></div></dl></section>`;
}

function renderTab(tab) {
  const body = p2f("objectWorkspaceBody");
  if (!body || phase2fState.entityId !== phase2fState.canonical?.entity?.entity_id) return;
  phase2fState.activeTab = tab;
  p2f("objectWorkspaceTabs")?.querySelectorAll("[data-p2f-tab]").forEach((button) => button.classList.toggle("active", button.dataset.p2fTab === tab));
  if (tab === "Findings") body.innerHTML = renderFindings();
  else if (tab === "Monitor") body.innerHTML = phase2fState.canonical?.entity?.semantic_type === "mq.queue" ? renderQueueMonitor() : renderGenericMonitor();
  else if (tab === "Relationships") body.innerHTML = renderRelationships();
  else if (tab === "Configuration") body.innerHTML = renderConfiguration();
  else if (tab === "Evidence") body.innerHTML = renderEvidence();
  else body.innerHTML = renderSummary();
  body.querySelectorAll("[data-p2f-tab]").forEach((button) => button.addEventListener("click", () => renderTab(button.dataset.p2fTab || "Summary")));
  body.querySelectorAll("[data-p2f-neighbor]").forEach((button) => button.addEventListener("click", () => window.osiOpenInvestigationWorkspace?.(button.dataset.p2fNeighbor, true)));
}

function installTabs() {
  const tabs = p2f("objectWorkspaceTabs");
  if (!tabs) return;
  const items = [
    ["Summary", ""],
    ["Findings", phase2fState.findings.length],
    ["Monitor", phase2fState.observations.length],
    ["Relationships", phase2fState.canonical?.relations?.length || 0],
    ["Configuration", ""],
    ["Evidence", evidenceSamples().length],
  ];
  tabs.innerHTML = items.map(([name, count], index) => `<button type="button" class="${index === 0 ? "active" : ""}" data-p2f-tab="${name}">${name}${count === "" ? "" : ` <span>${Number(count).toLocaleString()}</span>`}</button>`).join("");
  tabs.querySelectorAll("[data-p2f-tab]").forEach((button) => button.addEventListener("click", () => renderTab(button.dataset.p2fTab || "Summary")));
}

function updateHeader() {
  const entity = phase2fState.canonical?.entity || {};
  const latest = latestTimestamp();
  const qmgr = deriveQueueManager();
  const host = deriveSourceHost();
  const type = p2f("objectWorkspaceType");
  const scope = p2f("objectWorkspaceScope");
  if (type) type.textContent = entity.semantic_type === "mq.queue" ? "Queue investigation" : `${String(entity.semantic_type || "Canonical entity").replaceAll(".", " · ")} investigation`;
  if (scope) scope.innerHTML = `<span>${p2fEsc(entity.identity_state || "unknown")} identity</span>${qmgr ? `<span>QM ${p2fEsc(qmgr)}</span>` : ""}${host ? `<span>Host ${p2fEsc(host)}</span>` : ""}<span>${phase2fState.findings.length} finding${phase2fState.findings.length === 1 ? "" : "s"}</span><span>${latest ? `Evidence ${p2fEsc(relativeAge(latest))}` : "No operational evidence"}</span>`;
  const find = p2f("objectWorkspaceFind");
  if (find) find.textContent = "Find in Objects";
}

async function enhanceObjectWorkspace(canonicalData) {
  const entityId = canonicalData?.entity?.entity_id;
  if (!entityId) return;
  const sequence = ++phase2fState.sequence;
  phase2fState.entityId = entityId;
  phase2fState.canonical = canonicalData;
  phase2fState.findings = [];
  phase2fState.observations = [];
  phase2fState.coverage = [];
  phase2fState.activeTab = "Summary";
  const body = p2f("objectWorkspaceBody");
  if (body) body.innerHTML = `<div class="p2f-empty"><strong>Loading investigation evidence…</strong><span>Resolving findings, observations and coverage for this canonical object.</span></div>`;
  try {
    const [findingsData, observationsData] = await Promise.all([
      p2fApi(`/api/v2/findings/current?entity_id=${encodeURIComponent(entityId)}&limit=200&offset=0`),
      p2fApi(`/api/v2/operations/current/observations?entity_id=${encodeURIComponent(entityId)}&limit=200&offset=0`),
    ]);
    if (sequence !== phase2fState.sequence || entityId !== phase2fState.entityId) return;
    phase2fState.findings = findingsData.findings || [];
    phase2fState.observations = observationsData.observations || [];
    const qmgr = deriveQueueManager();
    if (qmgr) {
      try {
        const coverageData = await p2fApi(`/api/v2/operations/current/coverage?scope_key=${encodeURIComponent(qmgr)}&limit=200&offset=0`);
        if (sequence === phase2fState.sequence) phase2fState.coverage = coverageData.coverage || [];
      } catch {}
    }
    if (sequence !== phase2fState.sequence || entityId !== phase2fState.entityId) return;
    updateHeader();
    installTabs();
    renderTab("Summary");
  } catch (error) {
    if (sequence !== phase2fState.sequence) return;
    updateHeader();
    installTabs();
    if (body) body.innerHTML = `<div class="p2f-empty error"><strong>Operational investigation data unavailable</strong><span>${p2fEsc(error instanceof Error ? error.message : String(error))}</span><small>Canonical identity and relationships remain available.</small></div>`;
  }
}

async function openInvestigationWorkspace(entityId, pushHistory = true) {
  if (!entityId || typeof window.osiOpenObjectWorkspace !== "function") return;
  await window.osiOpenObjectWorkspace(entityId, pushHistory);
}

function removeLegacyDuplicateEvidenceAction() {
  const panel = p2f("placementGaps");
  if (!panel) return;
  [...panel.querySelectorAll(".gap-row")].forEach((row) => {
    const label = row.querySelector("span")?.textContent?.trim().toLowerCase();
    if (label === "next evidence action") row.remove();
  });
}

installPhase2FStyles();
window.osiEnhanceObjectWorkspace = enhanceObjectWorkspace;
window.osiOpenInvestigationWorkspace = openInvestigationWorkspace;
setTimeout(removeLegacyDuplicateEvidenceAction, 600);
window.addEventListener("popstate", () => setTimeout(removeLegacyDuplicateEvidenceAction, 300));
