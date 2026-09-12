const PHASE2O_REVISION = "20260912-1";
const STATUS_TTL_MS = 60_000;

let lastStatusAt = 0;
let statusPromise = null;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function installStyles() {
  if (document.querySelector('link[data-phase2o-demo-mode]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `/phase2o-demo-manual-mode.css?v=${PHASE2O_REVISION}`;
  link.dataset.phase2oDemoMode = "true";
  document.head.appendChild(link);
}

async function fetchJson(path) {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) throw new Error(body.detail || `${path} failed (${response.status})`);
  return body;
}

function readinessCard(label, value, detail, tone = "neutral") {
  return `<div class="phase2o-readiness-card" data-tone="${escapeHtml(tone)}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></div>`;
}

function renderStatus({ estate, operations, telemetry }) {
  const target = document.getElementById("phase2oReadiness");
  if (!target) return;

  const estateCurrent = Boolean(estate?.current_estate);
  const operationalCount = Number(operations?.current_observations || 0);
  const findingCount = Number(operations?.current_findings || 0);
  const directEnabled = Boolean(telemetry?.ingress_enabled);

  target.innerHTML = [
    readinessCard(
      "Canonical estate",
      estateCurrent ? "Available" : "Not ready",
      estateCurrent
        ? (estate.estate_fresh === false ? "Current estate exists; source reconciliation is due." : "Current canonical topology is available.")
        : "Import topology and reconcile the current source set.",
      estateCurrent ? (estate.estate_fresh === false ? "warning" : "success") : "warning",
    ),
    readinessCard(
      "Operational evidence",
      `${formatNumber(operationalCount)} observations`,
      `${formatNumber(findingCount)} current finding(s) from manually published OSI evaluations.`,
      operationalCount > 0 ? "success" : "warning",
    ),
    readinessCard(
      "Demo delivery mode",
      "Manual OSI handoff",
      "Transferred artifacts are selected and published by an operator in Administration.",
      "success",
    ),
    readinessCard(
      "Direct telemetry ingress",
      directEnabled ? "Enabled" : "Disabled",
      directEnabled
        ? "Unexpected for demo policy. Disable continuous ingress before the demonstration."
        : "Expected demo state; the dashboard does not require a direct middleware connection.",
      directEnabled ? "error" : "success",
    ),
  ].join("");

  const banner = document.getElementById("phase2oModeBanner");
  if (banner) {
    banner.dataset.tone = directEnabled ? "warning" : "success";
    banner.querySelector("strong").textContent = directEnabled
      ? "Demo policy mismatch: direct telemetry is enabled"
      : "Demo mode: manual OSI evidence transfer";
    banner.querySelector("span").textContent = directEnabled
      ? "The demonstration is defined as disconnected. Disable continuous telemetry before using this environment for the demo."
      : "Topology and operational evidence arrive as transferred OSI artifacts. Evidence timestamps remain authoritative; connection status is not inferred.";
  }
}

function renderStatusError(error) {
  const target = document.getElementById("phase2oReadiness");
  if (!target) return;
  target.innerHTML = `<div class="phase2o-readiness-error">Demo readiness could not be refreshed: ${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`;
}

async function refreshStatus(force = false) {
  const now = Date.now();
  if (!force && now - lastStatusAt < STATUS_TTL_MS) return;
  if (statusPromise) return statusPromise;
  statusPromise = Promise.all([
    fetchJson("/api/v2/estate/status"),
    fetchJson("/api/v2/operations/status"),
    fetchJson("/api/v2/telemetry/status"),
  ]).then(([estate, operations, telemetry]) => {
    lastStatusAt = Date.now();
    renderStatus({ estate, operations, telemetry });
  }).catch(renderStatusError).finally(() => {
    statusPromise = null;
  });
  return statusPromise;
}

function decorateAdministration() {
  installStyles();
  const root = document.getElementById("view-administration");
  if (!root) return;

  const access = root.querySelector(".ops-admin-access");
  if (!access) return;

  const heading = access.querySelector("h2");
  const copy = access.querySelector("p:not(.section-kicker)");
  if (heading) heading.textContent = "Manual OSI evidence handoff";
  if (copy) copy.textContent = "During the demo, OSI evidence is transferred manually into this dashboard. Topology and operational evaluations remain separate contracts, and no direct connection from Cloudflare to middleware is required.";

  if (!document.getElementById("phase2oDemoMode")) {
    access.insertAdjacentHTML("afterend", `
      <section id="phase2oDemoMode" class="panel phase2o-demo-mode">
        <div id="phase2oModeBanner" class="phase2o-mode-banner" data-tone="neutral">
          <div><p class="section-kicker">Demo delivery policy</p><strong>Checking manual-transfer readiness…</strong><span>Reading current evidence state without opening a connection to middleware.</span></div>
          <button id="phase2oRefresh" class="ghost" type="button">Refresh readiness</button>
        </div>
        <div class="phase2o-flow" aria-label="Manual OSI evidence flow">
          <div><b>1</b><span>Source environment</span><small>MQ / middleware evidence</small></div><i>→</i>
          <div><b>2</b><span>OSI collect & evaluate</span><small>Read-only artifacts</small></div><i>→</i>
          <div><b>3</b><span>Manual transfer</span><small>No network integration required</small></div><i>→</i>
          <div><b>4</b><span>Administration import</span><small>Protected operator action</small></div><i>→</i>
          <div><b>5</b><span>OSI investigation</span><small>Canonical + operational projections</small></div>
        </div>
        <div id="phase2oReadiness" class="phase2o-readiness"><div class="phase2o-readiness-error">Loading demo readiness…</div></div>
        <div class="phase2o-contract">
          <div><strong>Topology artifact</strong><span>Use the MQ collector archive in the topology ingestion workspace, then reconcile the canonical estate.</span></div>
          <div><strong>Operational artifact</strong><span>Use <code>osi.findings.evaluation/v1</code> here to publish runtime observations, coverage, and findings.</span></div>
          <div><strong>Freshness semantics</strong><span>“Latest” means latest manually published evidence. OSI continues to show factual evidence age and does not imply a live connection.</span></div>
        </div>
      </section>`);
    document.getElementById("phase2oRefresh")?.addEventListener("click", () => void refreshStatus(true));
  }

  if (root.classList.contains("active")) void refreshStatus(false);
}

const previousRender = window.osiRenderAdministrationOps;
window.osiRenderAdministrationOps = function phase2oRenderAdministration(...args) {
  const result = previousRender?.(...args);
  queueMicrotask(() => {
    decorateAdministration();
    void refreshStatus(false);
  });
  return result;
};

window.osiRefreshDemoMode = () => refreshStatus(true);

document.addEventListener("click", (event) => {
  const view = event.target.closest("[data-view]")?.dataset.view || event.target.closest("[data-go]")?.dataset.go;
  if (view === "administration") {
    setTimeout(() => {
      decorateAdministration();
      void refreshStatus(false);
    }, 0);
  }
}, true);

decorateAdministration();
