const PHASE2D_REVISION = "20260911-1";
const FINDING_PAGE_SIZE = 200;

const phase2dState = {
  controller: null,
  timer: null,
  observerTimer: null,
  suppressSummaryObserver: false,
};

const p2 = (id) => document.getElementById(id);
const p2esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

function installPhase2DStyles() {
  if (document.querySelector('link[data-phase2d-evidence-semantics]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `/phase2d-evidence-semantics.css?v=${PHASE2D_REVISION}`;
  link.dataset.phase2dEvidenceSemantics = "true";
  document.head.appendChild(link);
}

async function phase2dApi(path, signal) {
  const response = await fetch(path, { headers: { accept: "application/json" }, signal });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) throw new Error(body.detail || `Request failed (${response.status})`);
  return body;
}

function phase2dCurrentView() {
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
  return Number.isNaN(date.getTime()) ? "Unknown timestamp" : date.toLocaleString();
}

function isObservabilityLimitation(finding) {
  return String(finding?.rule_id || "").startsWith("mq.observability.");
}

async function fetchInformationalFindings(status, signal) {
  const findings = [];
  let offset = 0;
  while (true) {
    const params = new URLSearchParams({ status, severity: "info", limit: String(FINDING_PAGE_SIZE), offset: String(offset) });
    const data = await phase2dApi(`/api/v2/findings/current?${params}`, signal);
    findings.push(...(data.findings || []));
    const next = data?.page?.next_offset;
    if (next == null) return findings;
    offset = Number(next);
    if (!Number.isFinite(offset) || offset < 0) return findings;
  }
}

function ensureEvidenceStateStrip() {
  const summary = p2("operationalAttentionSummary");
  if (!summary) return null;
  let strip = p2("operationalEvidenceState");
  if (!strip) {
    strip = document.createElement("div");
    strip.id = "operationalEvidenceState";
    strip.className = "phase2d-evidence-state";
    summary.insertAdjacentElement("afterend", strip);
  }
  return strip;
}

function patchCanonicalEvidenceTerminology() {
  const stats = p2("overviewStats");
  if (stats) {
    for (const card of stats.querySelectorAll(":scope > .stat")) {
      const label = card.querySelector(":scope > span");
      if (label?.textContent?.trim() === "Unresolved") {
        label.textContent = "Evidence gaps";
        const note = card.querySelector(":scope > small");
        if (note) note.textContent = "unresolved references / missing evidence";
      }
    }
  }
  const gaps = p2("placementGaps");
  const heading = gaps?.closest(".panel")?.querySelector("h2");
  if (heading?.textContent?.trim() === "Unresolved infrastructure") heading.textContent = "Unresolved evidence";
}

function patchAttentionCopy() {
  const copy = p2("operationalAttentionCopy");
  if (!copy) return;
  const next = copy.textContent
    .replaceAll("current operational source", "latest published operational source")
    .replaceAll("current operational evaluation", "latest published operational evaluation");
  if (next !== copy.textContent) copy.textContent = next;
}

function patchSummaryDimensions() {
  const summary = p2("operationalAttentionSummary");
  if (!summary || summary.querySelector(".operational-loading")) return;
  phase2dState.suppressSummaryObserver = true;
  try {
    summary.classList.add("phase2d-severity-summary");
    for (const card of summary.querySelectorAll(":scope > .operational-summary-card")) {
      const label = card.querySelector(":scope > span")?.textContent?.trim();
      if (label === "Coverage gaps") card.remove();
    }
  } finally {
    phase2dState.suppressSummaryObserver = false;
  }
}

function patchVisibleLimitationCards(limitations) {
  const ids = new Set(limitations.map((finding) => String(finding.finding_id || "")).filter(Boolean));
  for (const card of document.querySelectorAll("[data-operational-finding]")) {
    const isLimitation = ids.has(card.dataset.operationalFinding || "");
    card.classList.toggle("phase2d-observability-finding", isLimitation);
    const topline = card.querySelector(".operational-finding-topline");
    let badge = card.querySelector(".phase2d-observability-badge");
    if (isLimitation && topline && !badge) {
      badge = document.createElement("b");
      badge.className = "phase2d-observability-badge";
      badge.textContent = "Observability limitation";
      const context = topline.querySelector("small");
      topline.insertBefore(badge, context || null);
    } else if (!isLimitation) {
      badge?.remove();
    }
  }

  for (const finding of document.querySelectorAll(".object-finding")) {
    const rule = finding.querySelector(".object-finding-copy small")?.textContent?.trim() || "";
    finding.classList.toggle("phase2d-observability-finding", rule.startsWith("mq.observability."));
  }
}

function renderEvidenceState({ statusData, latestObservation, limitations }) {
  const strip = ensureEvidenceStateStrip();
  if (!strip) return;
  const currentSources = Number(statusData?.current_sources || 0);
  if (!currentSources) {
    strip.innerHTML = `
      <div class="phase2d-evidence-card wide"><span>Operational freshness</span><strong>Unknown</strong><small>No operational evaluation is published.</small></div>
      <div class="phase2d-evidence-card"><span>Collection gaps</span><strong>${Number(statusData?.current_coverage_gaps || 0).toLocaleString()}</strong><small>Partial / failed / not collected samples</small></div>
      <div class="phase2d-evidence-card"><span>Observability limitations</span><strong>0</strong><small>No published evaluation to assess</small></div>`;
    return;
  }

  const observedAt = latestObservation?.observed_at || "";
  const evaluatedAt = latestObservation?.evaluation?.evaluated_at || "";
  const sourceHost = latestObservation?.evaluation?.source_host || latestObservation?.source?.source_host || "";
  const collectionGaps = Number(statusData?.current_coverage_gaps || 0);
  const evidenceValue = observedAt ? relativeAge(observedAt) : "Timestamp unavailable";
  const evidenceNote = observedAt
    ? `Observed ${absoluteTime(observedAt)}${sourceHost ? ` · ${sourceHost}` : ""}`
    : "Published evidence has no readable observation timestamp.";
  const evaluationNote = evaluatedAt ? `Evaluation produced ${relativeAge(evaluatedAt)} (${absoluteTime(evaluatedAt)}).` : "Evaluation timestamp unavailable.";

  strip.innerHTML = `
    <div class="phase2d-evidence-card wide">
      <span>Latest evidence age</span>
      <strong>${p2esc(evidenceValue)}</strong>
      <small>${p2esc(evidenceNote)}</small>
      <em>${p2esc(evaluationNote)} Age is factual; no freshness SLA is assumed.</em>
    </div>
    <div class="phase2d-evidence-card ${collectionGaps ? "attention" : ""}">
      <span>Collection gaps</span>
      <strong>${collectionGaps.toLocaleString()}</strong>
      <small>Partial / failed / not collected samples</small>
    </div>
    <div class="phase2d-evidence-card limitation ${limitations.length ? "active" : ""}">
      <span>Observability limitations</span>
      <strong>${limitations.length.toLocaleString()}</strong>
      <small>Signals unavailable despite successful collection</small>
    </div>`;
}

async function refreshPhase2DSemantics() {
  patchCanonicalEvidenceTerminology();
  patchAttentionCopy();
  patchSummaryDimensions();
  if (phase2dCurrentView() !== "overview") return;

  phase2dState.controller?.abort();
  const controller = new AbortController();
  phase2dState.controller = controller;
  try {
    const [statusData, latestObservationData, openInfo, acknowledgedInfo] = await Promise.all([
      phase2dApi("/api/v2/operations/status", controller.signal),
      phase2dApi("/api/v2/operations/current/observations?limit=1&offset=0", controller.signal),
      fetchInformationalFindings("OPEN", controller.signal),
      fetchInformationalFindings("ACKNOWLEDGED", controller.signal),
    ]);
    if (controller.signal.aborted) return;
    const limitations = [...openInfo, ...acknowledgedInfo].filter(isObservabilityLimitation);
    patchCanonicalEvidenceTerminology();
    patchAttentionCopy();
    patchSummaryDimensions();
    patchVisibleLimitationCards(limitations);
    renderEvidenceState({ statusData, latestObservation: latestObservationData?.observations?.[0], limitations });
  } catch (error) {
    if (error?.name === "AbortError") return;
    const strip = ensureEvidenceStateStrip();
    if (strip) strip.innerHTML = `<div class="phase2d-evidence-error"><strong>Evidence freshness unavailable</strong><span>${p2esc(error instanceof Error ? error.message : String(error))}</span></div>`;
  } finally {
    if (phase2dState.controller === controller) phase2dState.controller = null;
  }
}

function scheduleRefresh(delay = 80) {
  clearTimeout(phase2dState.observerTimer);
  phase2dState.observerTimer = setTimeout(() => void refreshPhase2DSemantics(), delay);
}

function bindPhase2DObservers() {
  const summary = p2("operationalAttentionSummary");
  if (summary) {
    const observer = new MutationObserver(() => {
      if (!phase2dState.suppressSummaryObserver) scheduleRefresh(100);
    });
    observer.observe(summary, { childList: true });
  }
  const stats = p2("overviewStats");
  if (stats) {
    const observer = new MutationObserver(() => patchCanonicalEvidenceTerminology());
    observer.observe(stats, { childList: true });
  }
  document.addEventListener("click", (event) => {
    const view = event.target.closest("[data-view], [data-go]")?.dataset.view || event.target.closest("[data-go]")?.dataset.go;
    if (view === "overview") scheduleRefresh(220);
  }, true);
}

function initPhase2D() {
  installPhase2DStyles();
  bindPhase2DObservers();
  patchCanonicalEvidenceTerminology();
  scheduleRefresh(120);
  clearInterval(phase2dState.timer);
  phase2dState.timer = setInterval(() => {
    if (document.visibilityState === "visible" && phase2dCurrentView() === "overview") void refreshPhase2DSemantics();
  }, 60_000);
}

window.osiRefreshEvidenceSemantics = refreshPhase2DSemantics;
initPhase2D();
