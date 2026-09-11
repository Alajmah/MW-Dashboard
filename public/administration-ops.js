const ADMIN_OPS_REVISION = "20260911-1";
const aq = (id) => document.getElementById(id);
const aesc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

const adminOpsState = {
  parsed: null,
  bytes: null,
  filename: "",
  resultSha256: "",
  busy: false,
};

function installAdminOpsStyles() {
  if (document.querySelector('link[data-administration-ops]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `/administration-ops.css?v=${ADMIN_OPS_REVISION}`;
  link.dataset.administrationOps = "true";
  document.head.appendChild(link);
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function shortHash(value) {
  const text = String(value || "");
  return text.length > 24 ? `${text.slice(0, 12)}…${text.slice(-8)}` : text || "—";
}

function setStatus(message, detail = "", tone = "neutral") {
  const node = aq("opsAdminStatus");
  if (!node) return;
  node.dataset.tone = tone;
  node.innerHTML = `<strong>${aesc(message)}</strong>${detail ? `<span>${aesc(detail)}</span>` : ""}`;
}

function setBusy(value) {
  adminOpsState.busy = value;
  ["opsEvaluationFile", "opsEnvironment", "opsAdminToken", "opsVerifyToken", "opsPublishEvaluation"].forEach((id) => {
    const node = aq(id);
    if (node) node.disabled = value;
  });
  const publish = aq("opsPublishEvaluation");
  if (publish) publish.disabled = value || !adminOpsState.parsed;
}

function tokenValue() {
  return aq("opsAdminToken")?.value.trim() || "";
}

async function responseJson(response) {
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(body.detail || `Request failed (${response.status})`);
    error.status = response.status;
    error.details = body.errors;
    throw error;
  }
  return body;
}

async function adminApi(path, { token = "", method = "GET", body } = {}) {
  const headers = new Headers({ accept: "application/json" });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return responseJson(await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateEvaluation(result) {
  if (!result || typeof result !== "object") throw new Error("The selected file is not a JSON object.");
  if (result.schema_version !== "osi.findings.evaluation/v1") {
    if (result.schema_version) throw new Error(`This file is ${result.schema_version}, not an OSI Findings v1 evaluation.`);
    throw new Error("Missing schema_version. Choose the OSI Findings v1 evaluation JSON, not topology JSON or the raw collector archive.");
  }
  if (!result.evaluation || typeof result.evaluation !== "object") throw new Error("Evaluation metadata is missing.");
  for (const [key, label] of [["operational_observations", "operational observations"], ["coverage", "coverage"], ["findings", "findings"]]) {
    if (!Array.isArray(result[key])) throw new Error(`Evaluation ${label} collection is missing.`);
  }
  const archiveSha = String(result.evaluation.source_archive_sha256 || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(archiveSha)) throw new Error("Evaluation source archive SHA-256 is invalid or missing.");
  const sourceId = String(result.evaluation.source_id || "").trim();
  const sourceHost = String(result.evaluation.source_host || "").trim();
  if (!sourceId || !sourceHost) throw new Error("Evaluation source identity is incomplete.");
  return result;
}

function evaluationSummary(result) {
  const meta = result.evaluation;
  const summary = result.summary || {};
  return `
    <div class="ops-admin-file-head">
      <div><span>Validated evaluation</span><strong>${aesc(adminOpsState.filename)}</strong></div>
      <span class="ops-admin-schema">${aesc(result.schema_version)}</span>
    </div>
    <div class="ops-admin-facts">
      <div><span>Source</span><strong>${aesc(meta.source_host || meta.source_id)}</strong><small>${aesc(meta.source_id)}</small></div>
      <div><span>Observations</span><strong>${formatNumber(result.operational_observations.length)}</strong><small>persisted runtime samples</small></div>
      <div><span>Coverage</span><strong>${formatNumber(result.coverage.length)}</strong><small>collection evidence records</small></div>
      <div><span>Findings</span><strong>${formatNumber(result.findings.length)}</strong><small>${formatNumber(summary.critical)} critical · ${formatNumber(summary.warning)} warning · ${formatNumber(summary.info)} info</small></div>
      <div><span>Evaluator</span><strong>${aesc(meta.evaluator_version || "—")}</strong><small>${aesc(meta.evaluator || "—")}</small></div>
      <div><span>Source archive</span><strong>${shortHash(meta.source_archive_sha256)}</strong><small>${aesc(meta.source_archive || "—")}</small></div>
    </div>`;
}

async function readEvaluationFile(file) {
  adminOpsState.parsed = null;
  adminOpsState.bytes = null;
  adminOpsState.filename = file?.name || "";
  adminOpsState.resultSha256 = "";
  const preview = aq("opsEvaluationPreview");
  const publish = aq("opsPublishEvaluation");
  if (publish) publish.disabled = true;
  if (!file) {
    if (preview) preview.innerHTML = `<div class="ops-admin-empty">Choose an <code>osi.findings.evaluation/v1</code> JSON file.</div>`;
    return;
  }
  setStatus("Reading evaluation", "Validating schema and computing the artifact digest.");
  try {
    const bytes = await file.arrayBuffer();
    const text = new TextDecoder().decode(bytes);
    const result = validateEvaluation(JSON.parse(text));
    adminOpsState.parsed = result;
    adminOpsState.bytes = bytes;
    adminOpsState.resultSha256 = await sha256Hex(bytes);
    if (preview) preview.innerHTML = evaluationSummary(result);
    if (publish) publish.disabled = false;
    setStatus("Evaluation ready", "The file is valid. Activation is still protected and atomic.", "success");
  } catch (error) {
    if (preview) preview.innerHTML = `<div class="ops-admin-empty error">${aesc(error instanceof Error ? error.message : String(error))}</div>`;
    setStatus("Evaluation rejected locally", error instanceof Error ? error.message : String(error), "error");
  }
}

function evaluationManifest(result) {
  const meta = result.evaluation;
  const environment = aq("opsEnvironment")?.value.trim() || "";
  if (!environment) throw new Error("Environment is required; operational evidence cannot use a silent default.");
  return {
    schema_version: result.schema_version,
    source: { id: String(meta.source_id || ""), host: String(meta.source_host || "") },
    environment,
    evaluator: String(meta.evaluator || "evaluate_findings_v1.py"),
    evaluator_version: String(meta.evaluator_version || ""),
    evaluated_at: String(meta.evaluated_at || ""),
    artifact: {
      filename: String(meta.source_archive || ""),
      sha256: String(meta.source_archive_sha256 || "").toLowerCase(),
    },
    result_sha256: adminOpsState.resultSha256,
    counts: {
      observations: result.operational_observations.length,
      coverage: result.coverage.length,
      findings: result.findings.length,
    },
    metadata: {
      collector_version: meta.collector_version ?? null,
      sample_count_declared: meta.sample_count_declared ?? null,
      sample_interval_seconds_declared: meta.sample_interval_seconds_declared ?? null,
      policy: meta.policy ?? {},
      queue_manager_count: Array.isArray(result.queue_managers) ? result.queue_managers.length : null,
      evaluation_summary: result.summary ?? {},
      published_from: adminOpsState.filename,
    },
  };
}

async function uploadCollection(token, revisionId, endpoint, items, chunkSize, progress) {
  for (let start = 0; start < items.length; start += chunkSize) {
    const chunk = items.slice(start, start + chunkSize);
    setStatus(`Uploading ${endpoint}`, `${formatNumber(progress.sent + chunk.length)} of ${formatNumber(progress.total)} operational records staged.`);
    await adminApi(`/api/v2/operations/evaluations/${encodeURIComponent(revisionId)}/${endpoint}`, {
      token,
      method: "POST",
      body: { start, items: chunk },
    });
    progress.sent += chunk.length;
  }
}

async function publishEvaluation() {
  if (!adminOpsState.parsed || adminOpsState.busy) return;
  const token = tokenValue();
  if (!token) {
    setStatus("Admin token required", "Enter ADMIN_IMPORT_TOKEN locally in this browser. It is held in memory only and is never stored by the page.", "warning");
    aq("opsAdminToken")?.focus();
    return;
  }
  setBusy(true);
  try {
    const manifest = evaluationManifest(adminOpsState.parsed);
    setStatus("Creating staged evaluation", "Current operational evidence remains active until the new revision passes count validation and activation.");
    const created = await adminApi("/api/v2/operations/evaluations", { token, method: "POST", body: manifest });
    const revisionId = created.evaluation_revision_id;
    const chunkSize = Number(created.chunk_size || 75);
    if (!revisionId) throw new Error("Server did not return an evaluation revision ID.");

    const progress = { sent: 0, total: manifest.counts.observations + manifest.counts.coverage + manifest.counts.findings };
    await uploadCollection(token, revisionId, "observations", adminOpsState.parsed.operational_observations, chunkSize, progress);
    await uploadCollection(token, revisionId, "coverage", adminOpsState.parsed.coverage, chunkSize, progress);
    await uploadCollection(token, revisionId, "findings", adminOpsState.parsed.findings, chunkSize, progress);

    setStatus("Activating evaluation", "Server-side validation is checking staged counts before the revision becomes current.");
    const activated = await adminApi(`/api/v2/operations/evaluations/${encodeURIComponent(revisionId)}/activate`, { token, method: "POST", body: {} });
    setStatus("Operational evaluation activated", `${revisionId} is current for ${manifest.source.host}. Overview and Object Detail can now project this evidence.`, "success");
    const result = aq("opsPublishResult");
    if (result) {
      result.hidden = false;
      result.innerHTML = `<strong>${aesc(activated.status || "active")}</strong><span>${formatNumber(manifest.counts.observations)} observations · ${formatNumber(manifest.counts.coverage)} coverage records · ${formatNumber(manifest.counts.findings)} findings</span><small>Activated ${aesc(activated.activated_at || "now")}</small>`;
    }
    await refreshOperationalStatus();
    window.osiRefreshOperationalIntelligence?.();
  } catch (error) {
    const detail = error?.details ? ` ${JSON.stringify(error.details)}` : "";
    setStatus("Operational publish failed", `${error instanceof Error ? error.message : String(error)}${detail}`, "error");
  } finally {
    setBusy(false);
  }
}

async function verifyToken() {
  const token = tokenValue();
  if (!token) {
    setStatus("Admin token required", "Enter ADMIN_IMPORT_TOKEN locally. The token is not saved in localStorage or sessionStorage.", "warning");
    aq("opsAdminToken")?.focus();
    return;
  }
  setBusy(true);
  try {
    await adminApi("/api/v2/import/sources", { token });
    setStatus("Admin token verified", "Protected ingestion APIs accepted this credential. It remains only in the current page memory.", "success");
  } catch (error) {
    setStatus("Token verification failed", error instanceof Error ? error.message : String(error), "error");
  } finally {
    setBusy(false);
  }
}

async function refreshOperationalStatus() {
  try {
    const data = await adminApi("/api/v2/operations/status");
    const target = aq("opsCurrentStatus");
    if (!target) return;
    target.innerHTML = `
      <div><span>Operational sources</span><strong>${formatNumber(data.current_sources)}</strong></div>
      <div><span>Current observations</span><strong>${formatNumber(data.current_observations)}</strong></div>
      <div><span>Current findings</span><strong>${formatNumber(data.current_findings)}</strong></div>
      <div><span>Coverage gaps</span><strong>${formatNumber(data.current_coverage_gaps)}</strong></div>`;
  } catch (error) {
    const target = aq("opsCurrentStatus");
    if (target) target.innerHTML = `<div class="ops-admin-empty error">Operational status unavailable: ${aesc(error instanceof Error ? error.message : String(error))}</div>`;
  }
}

function renderAdministration() {
  const root = aq("view-administration");
  if (!root || root.dataset.opsAdmin === "true") return;
  root.dataset.opsAdmin = "true";
  root.innerHTML = `
    <section class="ops-admin-access panel">
      <div>
        <p class="section-kicker">Protected administration</p>
        <h2>Evidence ingestion</h2>
        <p>Topology evidence and operational evaluations are different contracts and activate independently. Select the lane that matches the file schema.</p>
      </div>
      <div class="ops-admin-auth">
        <label><span>Admin token</span><input id="opsAdminToken" type="password" autocomplete="off" spellcheck="false" placeholder="ADMIN_IMPORT_TOKEN" /></label>
        <button id="opsVerifyToken" class="ghost" type="button">Verify token</button>
        <small>Credential is used only for protected API calls in this page and is not persisted by the UI.</small>
      </div>
    </section>

    <section class="ops-admin-status panel">
      <div class="section-heading compact-heading"><div><p class="section-kicker">Current operational state</p><h2>Published evidence</h2></div><button id="opsRefreshStatus" class="ghost" type="button">Refresh</button></div>
      <div id="opsCurrentStatus" class="ops-admin-current"><div class="ops-admin-empty">Loading operational persistence status…</div></div>
    </section>

    <section class="ops-admin-lanes">
      <article class="panel ops-admin-lane primary">
        <div class="ops-admin-lane-head"><div><p class="section-kicker">Operational intelligence</p><h2>Publish Findings evaluation</h2><p>Use the output of the OSI Findings v1 evaluator. This updates runtime observations, collection coverage, and evidence-linked findings; it does not replace topology.</p></div><span>osi.findings.evaluation/v1</span></div>
        <label class="ops-admin-field"><span>Environment</span><input id="opsEnvironment" value="prod" autocomplete="off" /></label>
        <label class="file-drop ops-admin-drop" for="opsEvaluationFile"><input id="opsEvaluationFile" type="file" accept="application/json,.json" /><strong>Choose operational evaluation JSON</strong><span>Example: osi-findings-sjeditb18703-…json</span></label>
        <div id="opsEvaluationPreview" class="ops-admin-preview"><div class="ops-admin-empty">Choose an <code>osi.findings.evaluation/v1</code> JSON file.</div></div>
        <button id="opsPublishEvaluation" type="button" disabled>Stage, validate & activate operational evidence</button>
        <div id="opsPublishResult" class="ops-admin-result" hidden></div>
      </article>

      <article class="panel ops-admin-lane">
        <div class="ops-admin-lane-head"><div><p class="section-kicker">Canonical topology</p><h2>Publish topology source</h2><p>Topology ingestion has its own semantic normalization, source revision, and estate reconciliation workflow. Operational evaluation JSON does not belong in this lane.</p></div><span>osi.observation.bundle/v2</span></div>
        <div class="ops-admin-topology-flow"><div><strong>1</strong><span>MQ collector archive</span></div><i>→</i><div><strong>2</strong><span>Normalize & validate</span></div><i>→</i><div><strong>3</strong><span>Activate source</span></div><i>→</i><div><strong>4</strong><span>Reconcile estate</span></div></div>
        <a class="ops-admin-link-button" href="/admin-import.html">Open topology ingestion workspace</a>
        <p class="ops-admin-note">The previous “Import normalized topology” control used the legacy v1 snapshot endpoint. It is intentionally retired from this screen so findings cannot be sent to a topology importer.</p>
      </article>
    </section>
    <div id="opsAdminStatus" class="ops-admin-message" data-tone="neutral"><strong>Ready</strong><span>Select an ingestion lane. No active evidence changes until validation and activation succeed.</span></div>`;

  aq("opsEvaluationFile")?.addEventListener("change", (event) => void readEvaluationFile(event.target.files?.[0]));
  aq("opsVerifyToken")?.addEventListener("click", () => void verifyToken());
  aq("opsPublishEvaluation")?.addEventListener("click", () => void publishEvaluation());
  aq("opsRefreshStatus")?.addEventListener("click", () => void refreshOperationalStatus());
  void refreshOperationalStatus();
}

function initAdministrationOps() {
  installAdminOpsStyles();
  renderAdministration();
  document.addEventListener("click", (event) => {
    const view = event.target.closest("[data-view], [data-go]")?.dataset.view || event.target.closest("[data-go]")?.dataset.go;
    if (view === "administration") {
      setTimeout(() => {
        renderAdministration();
        void refreshOperationalStatus();
      }, 0);
    }
  }, true);
}

window.osiRenderAdministrationOps = renderAdministration;
void initAdministrationOps();
