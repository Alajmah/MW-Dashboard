const PHASE2E_REVISION = "20260911-2";
const PHASE2E_PAGE_SIZE = 200;

const phase2eState = {
  controller: null,
  timer: null,
  observerTimer: null,
  placementGaps: [],
};

const p2e = (id) => document.getElementById(id);
const p2eEsc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };
const STATUS_RANK = { OPEN: 0, ACKNOWLEDGED: 1, RESOLVED: 2 };

function installPhase2EStyles() {
  if (document.querySelector('link[data-phase2e-triage]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `/phase2e-triage-compression.css?v=${PHASE2E_REVISION}`;
  link.dataset.phase2eTriage = "true";
  document.head.appendChild(link);
}

async function phase2eApi(path, signal) {
  const response = await fetch(path, { headers: { accept: "application/json" }, signal });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) throw new Error(body.detail || `Request failed (${response.status})`);
  return body;
}

function phase2eCurrentView() {
  return document.querySelector(".nav-item.active")?.dataset.view || "overview";
}

function relativeAge(value) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "unknown";
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

function isObservabilityLimitation(finding) {
  return String(finding?.rule_id || "").startsWith("mq.observability.");
}

async function fetchAllFindings(status, signal) {
  const findings = [];
  let offset = 0;
  for (let page = 0; page < 20; page += 1) {
    const params = new URLSearchParams({ status, limit: String(PHASE2E_PAGE_SIZE), offset: String(offset) });
    const data = await phase2eApi(`/api/v2/findings/current?${params}`, signal);
    findings.push(...(data.findings || []));
    const next = data?.page?.next_offset;
    if (next == null) break;
    offset = Number(next);
    if (!Number.isFinite(offset) || offset < 0) break;
  }
  return findings;
}

function findingSignal(finding) {
  return String(finding.summary || finding.diagnosis || finding.rule_id || "Operational finding");
}

function groupByEntity(findings) {
  const groups = new Map();
  for (const finding of findings) {
    const key = String(finding.entity_id || finding.finding_id || "unknown");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(finding);
  }
  return [...groups.entries()].map(([entityId, rows]) => {
    rows.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9)
      || (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)
      || new Date(b.last_seen || 0).getTime() - new Date(a.last_seen || 0).getTime());
    const representative = rows[0];
    const signals = [...new Set(rows.map(findingSignal))];
    const lastSeen = rows.reduce((latest, row) => new Date(row.last_seen || 0) > new Date(latest || 0) ? row.last_seen : latest, rows[0]?.last_seen || "");
    return { entityId, rows, representative, signals, lastSeen };
  }).sort((a, b) => (SEVERITY_RANK[a.representative?.severity] ?? 9) - (SEVERITY_RANK[b.representative?.severity] ?? 9)
    || (STATUS_RANK[a.representative?.status] ?? 9) - (STATUS_RANK[b.representative?.status] ?? 9)
    || new Date(b.lastSeen || 0).getTime() - new Date(a.lastSeen || 0).getTime()
    || String(a.representative?.display_name || "").localeCompare(String(b.representative?.display_name || "")));
}

function groupLimitations(findings) {
  const groups = new Map();
  for (const finding of findings) {
    const key = String(finding.rule_id || finding.summary || "observability");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(finding);
  }
  return [...groups.entries()].map(([ruleId, rows]) => ({
    ruleId,
    rows: rows.sort((a, b) => String(a.display_name || "").localeCompare(String(b.display_name || ""))),
    representative: rows[0],
  }));
}

function severityLabel(value) {
  return value === "critical" ? "Critical" : value === "warning" ? "Warning" : "Information";
}

function entityGroupRow(group) {
  const finding = group.representative || {};
  const qmgr = finding?.details?.queue_manager || "";
  const status = group.rows.some((row) => row.status === "OPEN") ? "OPEN" : "ACKNOWLEDGED";
  return `<button type="button" class="phase2e-object-row severity-${p2eEsc(finding.severity || "info")}" data-operational-entity="${p2eEsc(group.entityId)}" data-operational-finding="${p2eEsc(finding.finding_id || "")}">
    <span class="phase2e-object-rail"></span>
    <span class="phase2e-object-main">
      <span class="phase2e-object-top"><b>${p2eEsc(severityLabel(finding.severity))}</b><i>${p2eEsc(status)}</i><small>${p2eEsc(finding.semantic_type === "mq.queue" ? "Queue" : finding.semantic_type === "mq.queue_manager" ? "Queue manager" : finding.semantic_type || "Object")}${qmgr ? ` · ${p2eEsc(qmgr)}` : ""}</small></span>
      <strong>${p2eEsc(finding.display_name || group.entityId)}</strong>
      <span class="phase2e-signal-list">${group.signals.map((signal) => `<em>${p2eEsc(signal)}</em>`).join("")}</span>
      <small class="phase2e-object-meta">${group.rows.length} finding${group.rows.length === 1 ? "" : "s"} · latest supporting evidence ${p2eEsc(relativeAge(group.lastSeen))}</small>
    </span>
    <span class="phase2e-object-open">Inspect object →</span>
  </button>`;
}

function limitationRow(group) {
  const finding = group.representative || {};
  const names = [...new Set(group.rows.map((row) => row.display_name || row.entity_id).filter(Boolean))];
  return `<article class="phase2e-limitation-row">
    <div class="phase2e-limitation-copy">
      <span>Observability limitation</span>
      <strong>${p2eEsc(finding.summary || finding.diagnosis || group.ruleId)}</strong>
      <small>${names.length} affected object${names.length === 1 ? "" : "s"} · this is a diagnostic capability limitation, not a health failure</small>
    </div>
    <div class="phase2e-limitation-entities">${group.rows.slice(0, 8).map((row) => `<button type="button" data-operational-entity="${p2eEsc(row.entity_id)}" data-operational-finding="${p2eEsc(row.finding_id || "")}">${p2eEsc(row.display_name || row.entity_id)}</button>`).join("")}</div>
  </article>`;
}

function renderCompressedAttention(findings) {
  const list = p2e("operationalAttentionList");
  const copy = p2e("operationalAttentionCopy");
  if (!list || !copy) return;
  const limitations = findings.filter(isObservabilityLimitation);
  const actionable = findings.filter((finding) => !isObservabilityLimitation(finding));
  const entityGroups = groupByEntity(actionable);
  const limitationGroups = groupLimitations(limitations);
  const affectedObjects = new Set(findings.map((finding) => finding.entity_id).filter(Boolean)).size;

  copy.textContent = findings.length
    ? `${findings.length.toLocaleString()} unresolved finding${findings.length === 1 ? "" : "s"} consolidated into ${affectedObjects.toLocaleString()} affected object${affectedObjects === 1 ? "" : "s"} across the latest published operational evidence.`
    : "No unresolved findings are present in the latest published operational evidence. Evidence age and coverage remain separate questions.";

  if (!findings.length) return;
  list.innerHTML = `
    <div class="phase2e-triage-block">
      <div class="phase2e-triage-heading"><div><span>Actionable objects</span><strong>${entityGroups.length}</strong></div><small>Each object appears once; related findings are grouped into signals.</small></div>
      <div class="phase2e-object-list">${entityGroups.map(entityGroupRow).join("")}</div>
    </div>
    ${limitationGroups.length ? `<div class="phase2e-triage-block limitations"><div class="phase2e-triage-heading"><div><span>Diagnostic limitations</span><strong>${limitations.length}</strong></div><small>Grouped separately so missing diagnostic capability is not confused with service health.</small></div><div class="phase2e-limitation-list">${limitationGroups.map(limitationRow).join("")}</div></div>` : ""}
    <p class="operational-coverage-note">Finding severity, confidence, lifecycle state, evidence coverage, and diagnostic capability are independent. Absence of a finding is not proof of recovery.</p>`;
}

function patchEvidenceChronology(latestObservation) {
  const card = document.querySelector("#operationalEvidenceState .phase2d-evidence-card.wide");
  if (!card || !latestObservation) return;
  const observedAt = latestObservation.observed_at || "";
  const evaluatedAt = latestObservation?.evaluation?.evaluated_at || "";
  const host = latestObservation?.evaluation?.source_host || latestObservation?.source?.source_host || "";
  card.classList.add("phase2e-evidence-chronology");
  card.innerHTML = `
    <span>Evidence chronology</span>
    <strong>${observedAt ? `Observed ${p2eEsc(relativeAge(observedAt))}` : "Observation timestamp unavailable"}</strong>
    <small>Canonical topology: current · Evaluation published ${evaluatedAt ? p2eEsc(relativeAge(evaluatedAt)) : "at an unknown time"}${host ? ` · Source ${p2eEsc(host)}` : ""}</small>
    <em>${observedAt ? `Observation: ${p2eEsc(absoluteTime(observedAt))}. ` : ""}${evaluatedAt ? `Evaluation: ${p2eEsc(absoluteTime(evaluatedAt))}. ` : ""}Age is factual; no freshness SLA is assumed.</em>`;
}

function compressQmgrLedger() {
  const ledger = document.querySelector("#overviewQmgrs .qmgr-ledger");
  if (!ledger || ledger.classList.contains("phase2e-compressed")) return;
  const rows = [...ledger.querySelectorAll(".qmgr-ledger-row")].map((row) => ({
    name: row.querySelector("strong")?.textContent?.trim() || "Unknown queue manager",
    gap: row.classList.contains("gap"),
  }));
  if (!rows.length) return;
  const confirmed = rows.filter((row) => !row.gap);
  const gaps = rows.filter((row) => row.gap);
  phase2eState.placementGaps = gaps.map((row) => row.name);
  ledger.classList.add("phase2e-compressed");
  ledger.innerHTML = `
    <div class="phase2e-qmgr-rollup">
      <div class="phase2e-qmgr-metrics"><span><strong>${confirmed.length}</strong> placement confirmed</span><span class="needs-evidence"><strong>${gaps.length}</strong> placement gaps</span><span><strong>${rows.length}</strong> logical queue managers</span></div>
      <div class="phase2e-qmgr-bands">
        <div><span>Observed on collected host evidence</span><p>${confirmed.map((row) => `<b>${p2eEsc(row.name)}</b>`).join("") || "<em>None</em>"}</p></div>
        <div class="needs-evidence"><span>Host evidence still needed</span><p>${gaps.map((row) => `<b>${p2eEsc(row.name)}</b>`).join("") || "<em>None</em>"}</p></div>
      </div>
    </div>`;
  const section = ledger.closest(".section-block");
  const description = section?.querySelector(".section-heading p:not(.section-kicker)");
  if (description) description.textContent = `${confirmed.length} queue manager${confirmed.length === 1 ? "" : "s"} have confirmed physical placement; ${gaps.length} still require host evidence. Full inventory is in Queue Managers.`;
}

function patchEvidenceGapPanel(estateSummary) {
  const stats = p2e("overviewStats");
  const unresolved = estateSummary?.unresolved_by_state || {};
  const parts = Object.entries(unresolved).filter(([, count]) => Number(count) > 0);
  if (stats && parts.length) {
    for (const card of stats.querySelectorAll(":scope > .stat")) {
      const label = card.querySelector(":scope > span")?.textContent?.trim();
      if (label === "Evidence gaps") {
        const note = card.querySelector("small");
        if (note) note.textContent = parts.map(([state, count]) => `${Number(count).toLocaleString()} ${String(state).replaceAll("_", " ")}`).join(" + ");
      }
    }
  }

  const gaps = p2e("placementGaps");
  const panel = gaps?.closest(".panel");
  if (!gaps || !panel) return;
  panel.querySelector(".phase2e-next-evidence")?.remove();
  const unknownNames = [...gaps.querySelectorAll(".gap-row")]
    .filter((row) => row.querySelector(".pill.remote"))
    .map((row) => row.querySelector("span")?.textContent?.trim())
    .filter(Boolean);
  if (!unknownNames.length) return;
  const banner = document.createElement("div");
  banner.className = "phase2e-next-evidence";
  banner.innerHTML = `<div><span>Next evidence action</span><strong>Collect peer MQ hosts</strong><small>${unknownNames.length} logical queue manager${unknownNames.length === 1 ? "" : "s"} still lack physical placement evidence: ${p2eEsc(unknownNames.join(", "))}.</small></div><button type="button">Open Collection</button>`;
  banner.querySelector("button")?.addEventListener("click", () => window.osiNavigateProduct?.("snapshots"));
  gaps.insertAdjacentElement("beforebegin", banner);
}

function patchGlobalSearchAccessibility() {
  const input = p2e("globalSemanticSearch");
  if (!input) return;
  input.placeholder = "Search estate…";
  const label = input.closest("label");
  const hidden = label?.querySelector(".sr-only");
  if (hidden) hidden.setAttribute("aria-hidden", "true");
}

function schedulePhase2EDomPass() {
  clearTimeout(phase2eState.observerTimer);
  phase2eState.observerTimer = setTimeout(() => {
    if (phase2eCurrentView() !== "overview") return;
    compressQmgrLedger();
    patchGlobalSearchAccessibility();
  }, 40);
}

async function refreshPhase2E() {
  installPhase2EStyles();
  patchGlobalSearchAccessibility();
  if (phase2eCurrentView() !== "overview") return;
  phase2eState.controller?.abort();
  const controller = new AbortController();
  phase2eState.controller = controller;
  try {
    const [open, acknowledged, latestObservationData, estateSummary] = await Promise.all([
      fetchAllFindings("OPEN", controller.signal),
      fetchAllFindings("ACKNOWLEDGED", controller.signal),
      phase2eApi("/api/v2/operations/current/observations?limit=1&offset=0", controller.signal),
      phase2eApi("/api/v2/estate/current/summary", controller.signal),
    ]);
    if (controller.signal.aborted) return;
    const findings = [...open, ...acknowledged];
    renderCompressedAttention(findings);
    patchEvidenceChronology(latestObservationData?.observations?.[0] || null);
    compressQmgrLedger();
    patchEvidenceGapPanel(estateSummary);
  } catch (error) {
    if (error?.name === "AbortError") return;
    console.warn("Phase 2E triage compression unavailable", error);
  } finally {
    if (phase2eState.controller === controller) phase2eState.controller = null;
  }
}

function scheduleRefresh(delay = 160) {
  clearTimeout(phase2eState.timer);
  phase2eState.timer = setTimeout(() => void refreshPhase2E(), delay);
}

installPhase2EStyles();
const phase2eObserver = new MutationObserver((mutations) => {
  if (phase2eCurrentView() !== "overview") return;
  let shouldRefresh = false;
  for (const mutation of mutations) {
    if (mutation.type !== "childList") continue;
    const target = mutation.target;
    if (target?.id === "operationalAttentionList" && !target.querySelector?.(".phase2e-triage-block")) shouldRefresh = true;
    if (target?.id === "overviewQmgrs" && target.querySelector?.(".qmgr-ledger:not(.phase2e-compressed)")) shouldRefresh = true;
    if (target?.id === "placementGaps" && !target.closest?.(".panel")?.querySelector(".phase2e-next-evidence")) shouldRefresh = true;
    if (target?.id === "operationalEvidenceState" && !target.querySelector?.(".phase2e-evidence-chronology")) shouldRefresh = true;
  }
  if (shouldRefresh) scheduleRefresh(220);
  schedulePhase2EDomPass();
});
phase2eObserver.observe(document.body, { childList: true, subtree: true });

window.osiRefreshTriageCompression = () => scheduleRefresh(180);
scheduleRefresh(260);
