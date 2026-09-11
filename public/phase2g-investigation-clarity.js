const PHASE2G_REVISION = "20260911-1";
const baseEnhanceObjectWorkspace = window.osiEnhanceObjectWorkspace;

const p2gState = {
  entityId: "",
  canonical: null,
  findings: [],
  observations: [],
  coverage: [],
  neighbors: new Map(),
  sequence: 0,
};

const g$ = (id) => document.getElementById(id);
const gEsc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

function installPhase2GStyles() {
  if (document.querySelector('link[data-phase2g-clarity]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `/phase2g-investigation-clarity.css?v=${PHASE2G_REVISION}`;
  link.dataset.phase2gClarity = "true";
  document.head.appendChild(link);
}

async function gApi(path) {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) throw new Error(body.detail || `Request failed (${response.status})`);
  return body;
}

function relAge(value) {
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return "unknown age";
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}

function absTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "timestamp unavailable" : date.toLocaleString();
}

function entityProperty(key) {
  const properties = p2gState.canonical?.entity?.properties || {};
  const found = Object.entries(properties).find(([name]) => name.toLowerCase() === key.toLowerCase());
  return found ? found[1] : undefined;
}

function queueManagerName() {
  for (const item of p2gState.observations) if (item?.source?.queue_manager) return String(item.source.queue_manager);
  for (const item of p2gState.findings) if (item?.details?.queue_manager) return String(item.details.queue_manager);
  return String(entityProperty("QUEUE_MANAGER") || "");
}

function sampleGroups() {
  const groups = new Map();
  for (const observation of p2gState.observations) {
    const sample = observation?.source?.sample_id || observation.observed_at || "sample";
    if (!groups.has(sample)) groups.set(sample, { sample, observedAt: observation.observed_at, observations: [], findingRefs: [], coverage: [] });
    const group = groups.get(sample);
    group.observedAt = group.observedAt || observation.observed_at;
    group.observations.push(observation);
  }
  for (const finding of p2gState.findings) {
    for (const ref of finding.evidence || []) {
      const sample = ref.sample_id || ref.observed_at || "configuration";
      if (!groups.has(sample)) groups.set(sample, { sample, observedAt: ref.observed_at, observations: [], findingRefs: [], coverage: [] });
      groups.get(sample).findingRefs.push({ ...ref, finding });
    }
  }
  for (const coverage of p2gState.coverage) {
    const sample = coverage.sample_id || coverage.observed_at || "sample";
    if (!groups.has(sample)) groups.set(sample, { sample, observedAt: coverage.observed_at, observations: [], findingRefs: [], coverage: [] });
    groups.get(sample).coverage.push(coverage);
  }
  return [...groups.values()].sort((a, b) => new Date(a.observedAt || 0) - new Date(b.observedAt || 0));
}

function metric(type) {
  return p2gState.observations.filter((item) => item.observation_type === type).sort((a, b) => new Date(a.observed_at || 0) - new Date(b.observed_at || 0));
}

function numericDelta(type) {
  const rows = metric(type).filter((item) => typeof item.value === "number");
  if (rows.length < 2) return null;
  return { first: Number(rows[0].value), last: Number(rows.at(-1).value), delta: Number(rows.at(-1).value) - Number(rows[0].value), count: rows.length, unit: rows.at(-1).unit || "" };
}

function valueWithUnit(value, unit) {
  if (value == null || value === "") return "—";
  const formatted = typeof value === "number" ? value.toLocaleString() : String(value);
  return `${formatted}${unit && unit !== "state" ? ` ${unit}` : ""}`;
}

function activeTab() {
  return g$("objectWorkspaceTabs")?.querySelector("button.active")?.dataset.p2fTab || "Summary";
}

function updateTabSemantics() {
  const tabs = g$("objectWorkspaceTabs");
  if (!tabs) return;
  const samples = sampleGroups().filter((group) => group.observations.length || group.findingRefs.length).length;
  tabs.querySelectorAll("button").forEach((button) => {
    const name = button.dataset.p2fTab || button.textContent.trim().split(/\s+/)[0];
    if (name === "Monitor" || name === "Evidence") {
      button.innerHTML = `${name} <span>${samples.toLocaleString()} samples</span>`;
    }
  });
}

function simplifyHeader() {
  const workspace = g$("objectWorkspace");
  if (!workspace) return;
  workspace.classList.add("phase2g-clarity");
  const close = workspace.querySelector('.object-workspace-actions [data-workspace-close]');
  if (close) close.hidden = true;
  const find = g$("objectWorkspaceFind");
  if (find) find.textContent = "Locate in Objects";
}

function renderSummaryClarity() {
  const body = g$("objectWorkspaceBody");
  if (!body) return;
  const entity = p2gState.canonical?.entity || {};
  const findings = p2gState.findings;
  const groups = sampleGroups().filter((group) => group.observations.length);
  const depth = numericDelta("mq.queue.depth.current");
  const age = numericDelta("mq.queue.message.age.oldest_seconds");
  const input = metric("mq.queue.process.input_count");
  const output = metric("mq.queue.process.output_count");
  const allInputZero = input.length > 0 && input.every((item) => Number(item.value) === 0);
  const anyOutput = output.some((item) => Number(item.value) > 0);
  const qmgr = queueManagerName();
  const host = p2gState.observations.find((item) => item?.source?.source_host)?.source?.source_host || "";

  const changed = [];
  if (depth) changed.push(`Queue depth ${depth.delta === 0 ? `remained at ${depth.last.toLocaleString()} messages` : `moved from ${depth.first.toLocaleString()} to ${depth.last.toLocaleString()} messages (${depth.delta > 0 ? "+" : ""}${depth.delta.toLocaleString()})`}.`);
  if (age) changed.push(`Oldest-message age increased from ${age.first.toLocaleString()} to ${age.last.toLocaleString()} seconds (${age.delta > 0 ? "+" : ""}${age.delta.toLocaleString()}).`);
  if (allInputZero) changed.push(`No input process was observed in any of the ${input.length} stored samples.`);
  if (output.length) changed.push(anyOutput ? "At least one output process was observed in the sampled window." : `No output process was observed in the ${output.length} stored samples.`);

  const raised = findings.length ? findings.map((item) => item.summary).filter(Boolean) : ["No current evidence-linked finding is attached to this object."];
  const boundaries = [];
  if (findings.some((item) => item?.details?.sla_breach === "not_asserted")) boundaries.push("No business-SLA breach is asserted by the evaluator.");
  if (findings.some((item) => item?.details?.impact === "not_established")) boundaries.push("Application or service impact is not established by this evidence.");
  if (!boundaries.length) boundaries.push("Interpretation remains bounded by the currently published evidence window; absence of a finding is not proof of health.");

  body.innerHTML = `<div class="p2g-summary">
    <section class="p2g-synopsis ${findings.length ? "has-findings" : ""}">
      <span>Investigation synopsis</span>
      <h3>${gEsc(findings[0]?.summary || "No current operational finding")}</h3>
      <div class="p2g-question-grid">
        <article><b>What changed?</b>${changed.length ? changed.map((item) => `<p>${gEsc(item)}</p>`).join("") : `<p>No multi-sample queue sequence is available.</p>`}</article>
        <article><b>Why was this raised?</b>${raised.map((item) => `<p>${gEsc(item)}</p>`).join("")}</article>
        <article><b>What can OSI conclude?</b><p>${groups.length ? `OSI has ${groups.length} stored sample${groups.length === 1 ? "" : "s"} for this object in the current operational evaluation.` : "OSI has no stored operational sample sequence for this object."}</p><p>${findings.length ? `The evaluator produced ${findings.length} current finding${findings.length === 1 ? "" : "s"} from that evidence.` : "The current evaluator produced no finding for this object."}</p></article>
        <article><b>What is not concluded?</b>${boundaries.map((item) => `<p>${gEsc(item)}</p>`).join("")}</article>
      </div>
    </section>
    <section class="p2g-context-row">
      <div><span>Queue manager</span><strong>${gEsc(qmgr || "Not established")}</strong></div>
      <div><span>Physical host</span><strong>${gEsc(host || "Not established")}</strong></div>
      <div><span>Findings</span><strong>${findings.length} current</strong></div>
      <div><span>Evidence window</span><strong>${groups.length} sample${groups.length === 1 ? "" : "s"}</strong>${groups.length ? `<small>${gEsc(absTime(groups[0].observedAt))} → ${gEsc(absTime(groups.at(-1).observedAt))}</small>` : ""}</div>
      <div><span>Identity</span><strong>${gEsc(entity.identity_state || "unknown")}</strong><small>${gEsc(entity.identity_rule || "")}</small></div>
    </section>
    <section class="p2g-path"><span>Investigation path</span><div><button type="button" data-p2g-tab="Findings">Review conclusions</button><button type="button" data-p2g-tab="Monitor">Inspect sample sequence</button><button type="button" data-p2g-tab="Evidence">Trace exact proof</button></div></section>
  </div>`;
  body.querySelectorAll("[data-p2g-tab]").forEach((button) => button.addEventListener("click", () => selectTab(button.dataset.p2gTab)));
}

function renderFindingsClarity() {
  const body = g$("objectWorkspaceBody");
  if (!body) return;
  const findings = p2gState.findings;
  if (!findings.length) {
    body.innerHTML = `<div class="p2g-empty"><strong>No current findings for this object</strong><span>No evaluator occurrence is attached to this canonical entity in the latest published operational evidence.</span></div>`;
    return;
  }
  body.innerHTML = `<div class="p2g-findings">${findings.map((finding) => `<article class="p2g-finding severity-${gEsc(finding.severity)}">
    <header><div><span>${gEsc(String(finding.severity || "info").toUpperCase())}</span><i>${gEsc(finding.status || "OPEN")}</i></div><code>${gEsc(finding.rule_id || "")}</code></header>
    <h3>${gEsc(finding.summary || "Operational finding")}</h3>
    <p>${gEsc(finding.diagnosis || "No evaluator diagnosis text was supplied.")}</p>
    <div class="p2g-finding-facts"><div><span>Confidence</span><strong>${gEsc(finding?.confidence?.level || "unknown")}${Number.isFinite(Number(finding?.confidence?.score)) ? ` · ${Math.round(Number(finding.confidence.score) * 100)}%` : ""}</strong></div><div><span>Coverage</span><strong>${gEsc(finding.coverage_state || "unknown")}</strong></div><div><span>First seen</span><strong>${gEsc(relAge(finding.first_seen))}</strong><small>${gEsc(absTime(finding.first_seen))}</small></div><div><span>Last seen</span><strong>${gEsc(relAge(finding.last_seen))}</strong><small>${gEsc(absTime(finding.last_seen))}</small></div></div>
    ${(finding.evidence || []).length ? `<section class="p2g-proof"><span>Supporting samples</span><div class="p2g-proof-table"><div class="head"><b>Sample</b><b>Observed</b><b>Evidence source</b><b>Signals</b></div>${finding.evidence.map((ref) => `<div><b>${gEsc(ref.sample_id || "sample")}</b><span>${gEsc(absTime(ref.observed_at))}</span><code title="${gEsc(ref.evidence_ref || "")}">${gEsc(ref.evidence_ref || "—")}</code><span>${gEsc((ref.observation_types || []).join(" · "))}</span></div>`).join("")}</div></section>` : ""}
    ${findings.length > 1 ? `<footer><span>Related conclusions on this object</span>${findings.filter((other) => other.finding_id !== finding.finding_id).map((other) => `<b>${gEsc(other.summary)}</b>`).join("")}</footer>` : ""}
  </article>`).join("")}</div>`;
}

function neighborId(relation, entityId) {
  return relation.neighbor_entity_id || (relation.source_entity_id === entityId ? relation.target_entity_id : relation.source_entity_id);
}

function humanType(type) {
  const labels = { "mq.queue_manager": "Queue Manager", "mq.queue": "Queue", "mq.channel": "Channel", "mq.listener": "Listener", "mq.cluster": "MQ Cluster", "infra.host": "Physical Host", "runtime.process": "Runtime Process", "network.endpoint": "Endpoint" };
  return labels[type] || String(type || "Entity").replaceAll(".", " · ");
}

function relationLabel(type) {
  const labels = { contains: "contains", member_of: "member of", "mq.cluster_discovers": "cluster discovers", runs_on: "runs on", has_instance: "has instance", "runtime.opens_for_input": "opens for input", "runtime.opens_for_output": "opens for output" };
  return labels[type] || String(type || "relationship").replaceAll("_", " ").replaceAll(".", " · ");
}

function renderRelationshipsClarity() {
  const body = g$("objectWorkspaceBody");
  if (!body) return;
  const entity = p2gState.canonical?.entity || {};
  const relations = p2gState.canonical?.relations || [];
  if (!relations.length) {
    body.innerHTML = `<div class="p2g-empty"><strong>No canonical relationships</strong><span>No semantic relationships were returned for this entity.</span></div>`;
    return;
  }
  const outgoing = relations.filter((item) => item.source_entity_id === entity.entity_id).length;
  body.innerHTML = `<div class="p2g-relation-head"><span><b>${outgoing}</b> outgoing</span><span><b>${relations.length - outgoing}</b> incoming</span><span><b>${relations.length}</b> total</span></div><div class="p2g-relations">${relations.map((relation) => {
    const id = neighborId(relation, entity.entity_id);
    const neighbor = p2gState.neighbors.get(id);
    const isOutgoing = relation.source_entity_id === entity.entity_id;
    const name = neighbor?.display_name || relation.neighbor_display_name || relation.neighbor_identity_key || id;
    const type = neighbor?.semantic_type || relation.neighbor_semantic_type || "entity";
    return `<button type="button" data-p2g-neighbor="${gEsc(id)}"><span>${isOutgoing ? "→" : "←"} ${gEsc(relationLabel(relation.semantic_type))}</span><strong>${gEsc(name)}</strong><small>${gEsc(humanType(type))} · ${gEsc((relation.evidence_classes || []).join(" · ") || "evidence-backed")}</small><code>${gEsc(id)}</code></button>`;
  }).join("")}</div>`;
  body.querySelectorAll("[data-p2g-neighbor]").forEach((button) => button.addEventListener("click", () => window.osiOpenInvestigationWorkspace?.(button.dataset.p2gNeighbor, true)));
}

const CONFIG_GROUPS = [
  ["Queue behavior", ["GET", "PUT", "DEFBIND", "DEFPERSIST", "USAGE"]],
  ["Capacity", ["MAXDEPTH", "MAXMSGL"]],
  ["Cluster", ["CLUSNL", "CLUSTER", "CLWLPRTY", "CLWLRANK", "CLWLUSEQ"]],
  ["Ownership", ["QUEUE_MANAGER", "QUEUE_TYPE", "SYSTEM"]],
];

function renderConfigurationClarity() {
  const body = g$("objectWorkspaceBody");
  if (!body) return;
  const properties = p2gState.canonical?.entity?.properties || {};
  const entries = Object.entries(properties).sort(([a], [b]) => a.localeCompare(b));
  const map = new Map(entries.map(([key, value]) => [key.toUpperCase(), { key, value }]));
  const grouped = CONFIG_GROUPS.map(([name, keys]) => [name, keys.map((key) => map.get(key)).filter(Boolean)]).filter(([, values]) => values.length);
  body.innerHTML = `<div class="p2g-config"><div class="p2g-config-groups">${grouped.map(([name, values]) => `<section><h3>${gEsc(name)}</h3><dl>${values.map(({ key, value }) => `<div><dt>${gEsc(key)}</dt><dd>${gEsc(Array.isArray(value) ? value.join(", ") : value)}</dd></div>`).join("")}</dl></section>`).join("")}</div><details class="p2g-raw-config"><summary>Raw MQ attributes · ${entries.length} fields</summary><dl>${entries.map(([key, value]) => `<div><dt>${gEsc(key)}</dt><dd>${gEsc(Array.isArray(value) ? value.join(", ") : value)}</dd></div>`).join("")}</dl></details></div>`;
}

function observationLabel(type) {
  const labels = { "mq.queue.depth.current": "Queue depth", "mq.queue.message.age.oldest_seconds": "Oldest message age", "mq.queue.process.input_count": "Input processes", "mq.queue.process.output_count": "Output processes" };
  return labels[type] || String(type || "observation").replace(/^mq\./, "").replaceAll(".", " · ").replaceAll("_", " ");
}

function renderEvidenceClarity() {
  const body = g$("objectWorkspaceBody");
  if (!body) return;
  const groups = sampleGroups().filter((group) => group.observations.length || group.findingRefs.length);
  const entity = p2gState.canonical?.entity || {};
  body.innerHTML = `<div class="p2g-evidence-intro"><div><span>Operational proof layer</span><h3>Exact queue evidence behind this investigation</h3></div><small>${groups.length} sample group${groups.length === 1 ? "" : "s"}</small></div><div class="p2g-evidence-groups">${groups.map((group) => {
    const queueRefs = [...new Set([...group.observations.map((item) => item?.source?.evidence_ref), ...group.findingRefs.map((item) => item.evidence_ref)].filter(Boolean))];
    const signals = group.observations.map((item) => `<div><span>${gEsc(observationLabel(item.observation_type))}</span><strong>${gEsc(valueWithUnit(item.value, item.unit))}</strong></div>`).join("");
    return `<article><header><strong>${gEsc(group.sample)}</strong><span>${gEsc(absTime(group.observedAt))}</span><small>${gEsc(relAge(group.observedAt))}</small></header><div class="p2g-signal-grid">${signals || `<span>No object-level observation value in this sample.</span>`}</div>${queueRefs.length ? `<div class="p2g-source-refs">${queueRefs.map((ref) => `<code title="${gEsc(ref)}">${gEsc(ref)}</code>`).join("")}</div>` : ""}${group.coverage.length ? `<details><summary>Collection context · ${group.coverage.length} coverage record${group.coverage.length === 1 ? "" : "s"}</summary><div class="p2g-coverage-list">${group.coverage.map((item) => `<span><b>${gEsc(item.observation_family || "coverage")}</b><em>${gEsc(item.state || "unknown")}</em><code title="${gEsc(item.evidence_ref || "")}">${gEsc(item.evidence_ref || "—")}</code></span>`).join("")}</div></details>` : ""}</article>`;
  }).join("")}</div><section class="p2g-canonical-proof"><span>Canonical provenance</span><h3>Why OSI knows this object</h3><dl><div><dt>Entity ID</dt><dd>${gEsc(entity.entity_id || "—")}</dd></div><div><dt>Identity key</dt><dd>${gEsc(entity.identity_key || "—")}</dd></div><div><dt>Identity rule</dt><dd>${gEsc(entity.identity_rule || "—")}</dd></div><div><dt>Evidence classes</dt><dd>${gEsc((entity.evidence_classes || []).join(" · ") || "—")}</dd></div><div><dt>Source authorities</dt><dd>${(entity.source_ids || []).map((id) => gEsc(id)).join(" · ") || "—"}</dd></div></dl></section>`;
}

function renderCurrentClarity() {
  updateTabSemantics();
  const tab = activeTab();
  if (tab === "Summary") renderSummaryClarity();
  else if (tab === "Findings") renderFindingsClarity();
  else if (tab === "Relationships") renderRelationshipsClarity();
  else if (tab === "Configuration") renderConfigurationClarity();
  else if (tab === "Evidence") renderEvidenceClarity();
}

function selectTab(name) {
  const button = [...(g$("objectWorkspaceTabs")?.querySelectorAll("button") || [])].find((item) => item.dataset.p2fTab === name);
  button?.click();
}

async function resolveNeighbors(canonical, sequence) {
  const entityId = canonical?.entity?.entity_id;
  const relations = canonical?.relations || [];
  const ids = [...new Set(relations.map((relation) => neighborId(relation, entityId)).filter(Boolean))];
  const results = await Promise.all(ids.map(async (id) => {
    try {
      const data = await gApi(`/api/v2/estate/current/entities/${encodeURIComponent(id)}?relation_limit=1`);
      return [id, data.entity || null];
    } catch {
      return [id, null];
    }
  }));
  if (sequence !== p2gState.sequence) return;
  p2gState.neighbors = new Map(results.filter(([, entity]) => entity));
}

async function loadClarityState(canonical) {
  const entityId = canonical?.entity?.entity_id;
  if (!entityId) return;
  const sequence = ++p2gState.sequence;
  p2gState.entityId = entityId;
  p2gState.canonical = canonical;
  p2gState.findings = [];
  p2gState.observations = [];
  p2gState.coverage = [];
  p2gState.neighbors = new Map();

  const [findingsData, observationsData] = await Promise.all([
    gApi(`/api/v2/findings/current?entity_id=${encodeURIComponent(entityId)}&limit=200&offset=0`),
    gApi(`/api/v2/operations/current/observations?entity_id=${encodeURIComponent(entityId)}&limit=200&offset=0`),
  ]);
  if (sequence !== p2gState.sequence) return;
  p2gState.findings = findingsData.findings || [];
  p2gState.observations = observationsData.observations || [];
  const qmgr = queueManagerName();
  if (qmgr) {
    try {
      const coverageData = await gApi(`/api/v2/operations/current/coverage?scope_key=${encodeURIComponent(qmgr)}&limit=200&offset=0`);
      if (sequence === p2gState.sequence) p2gState.coverage = coverageData.coverage || [];
    } catch {}
  }
  await resolveNeighbors(canonical, sequence);
  if (sequence !== p2gState.sequence) return;
  simplifyHeader();
  renderCurrentClarity();
}

if (typeof baseEnhanceObjectWorkspace === "function") {
  window.osiEnhanceObjectWorkspace = async (canonicalData) => {
    await baseEnhanceObjectWorkspace(canonicalData);
    try { await loadClarityState(canonicalData); } catch (error) { console.warn("Phase 2G clarity enhancement failed", error); }
  };
}

// Phase 2F owns the primary tab renderer. Re-project clarity after its synchronous tab render.
document.addEventListener("click", (event) => {
  if (event.target.closest("#objectWorkspaceTabs button, [data-p2f-tab]")) {
    setTimeout(() => {
      if (!g$("objectWorkspace")?.hidden && p2gState.entityId) renderCurrentClarity();
    }, 0);
  }
});

installPhase2GStyles();
