const byId = (id) => document.getElementById(id);
const state = { result: null, busy: false };
const COLLECTIONS = [
  ["coverage", "coverage"],
  ["entities", "entities"],
  ["relations", "relations"],
  ["unresolved_references", "unresolved"],
];

function setBusy(value) {
  state.busy = value;
  byId("analyzeButton").disabled = value;
  byId("publishButton").disabled = value || !state.result?.quality?.valid;
  byId("archiveFile").disabled = value;
}

function status(message, detail = "", tone = "neutral") {
  byId("statusTitle").textContent = message;
  byId("statusDetail").textContent = detail;
  byId("statusPanel").dataset.tone = tone;
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function shortHash(value) {
  return value ? `${value.slice(0, 12)}…${value.slice(-8)}` : "—";
}

async function responseJson(response) {
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(body.detail || `Request failed (${response.status})`);
    error.details = body.errors;
    throw error;
  }
  return body;
}

async function api(path, token, options = {}) {
  const headers = new Headers(options.headers || {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return responseJson(await fetch(path, { ...options, headers }));
}

function renderResult(result) {
  const run = result.bundle.run || {};
  const quality = result.quality;
  byId("resultPanel").hidden = false;
  byId("sourceValue").textContent = run.source?.display_name || run.source?.id || "—";
  byId("runValue").textContent = run.run_id || "—";
  byId("normalizerValue").textContent = run.normalizer_version || "—";
  byId("archiveHashValue").textContent = shortHash(result.archive_sha256);
  byId("bundleHashValue").textContent = shortHash(result.bundle_sha256);
  byId("coverageCount").textContent = formatNumber(quality.counts.coverage);
  byId("entityCount").textContent = formatNumber(quality.counts.entities);
  byId("relationCount").textContent = formatNumber(quality.counts.relations);
  byId("unresolvedCount").textContent = formatNumber(quality.counts.unresolved);
  byId("failedCoverageCount").textContent = formatNumber(quality.counts.failed_coverage);
  byId("qmCount").textContent = formatNumber(quality.invariants.queue_managers);
  byId("channelCount").textContent = formatNumber(quality.invariants.channels);
  byId("hostCount").textContent = formatNumber(quality.invariants.physical_hosts);
  byId("activityCount").textContent = formatNumber(quality.invariants.activity_relations);

  const issues = byId("qualityIssues");
  issues.replaceChildren();
  const messages = [
    ...quality.errors.map((text) => ({ text, kind: "error" })),
    ...quality.warnings.map((text) => ({ text, kind: "warning" })),
  ];
  if (!messages.length) messages.push({ text: "Schema, registry contracts, relation endpoints, and archive digest are valid.", kind: "success" });
  for (const item of messages.slice(0, 12)) {
    const li = document.createElement("li");
    li.dataset.kind = item.kind;
    li.textContent = item.text;
    issues.append(li);
  }

  if (quality.valid) {
    status("Ready to publish", "The normalized source revision passed local semantic validation.", "success");
  } else {
    status("Validation failed", `${quality.errors.length} blocking semantic issue(s) detected. Nothing has been uploaded.`, "error");
  }
  byId("publishButton").disabled = !quality.valid;
}

async function analyze() {
  const file = byId("archiveFile").files?.[0];
  if (!file) {
    status("Select an MQ collector archive", "Choose mq-topology-*.tar.gz before analysis.", "warning");
    return;
  }
  if (!/\.tar\.gz$/i.test(file.name)) {
    status("Unsupported file", "The importer currently accepts mq-topology-*.tar.gz archives only.", "error");
    return;
  }

  state.result = null;
  byId("resultPanel").hidden = true;
  setBusy(true);
  status("Reading collector archive", "The archive stays in this browser during normalization.");
  const worker = new Worker("/import-worker.js");
  try {
    const archive = await file.arrayBuffer();
    const result = await new Promise((resolve, reject) => {
      worker.onmessage = (event) => {
        const message = event.data || {};
        if (message.type === "progress") status(message.message, message.detail || "");
        if (message.type === "result") resolve(message);
        if (message.type === "error") reject(new Error(message.message || "Normalization failed"));
      };
      worker.onerror = (event) => reject(new Error(event.message || "Import worker failed"));
      worker.postMessage({
        type: "normalize",
        archive,
        filename: file.name,
        environment: byId("environmentInput").value.trim() || "prod",
      }, [archive]);
    });
    state.result = result;
    renderResult(result);
  } catch (error) {
    status("Analysis failed", error instanceof Error ? error.message : String(error), "error");
  } finally {
    worker.terminate();
    setBusy(false);
  }
}

function manifestFor(result) {
  const run = result.bundle.run || {};
  return {
    schema_version: result.bundle.schema_version,
    run_id: run.run_id,
    environment: run.environment,
    collector: run.collector,
    collector_version: run.collector_version || null,
    normalizer_version: run.normalizer_version,
    completed_at: run.completed_at,
    source: run.source,
    archive: {
      filename: result.filename,
      sha256: result.archive_sha256,
      size_bytes: result.archive_size_bytes,
    },
    bundle_sha256: result.bundle_sha256,
    counts: {
      coverage: result.quality.counts.coverage,
      entities: result.quality.counts.entities,
      relations: result.quality.counts.relations,
      unresolved: result.quality.counts.unresolved,
    },
    quality: {
      valid: result.quality.valid,
      warnings: result.quality.warnings,
      entities_by_type: result.quality.entities_by_type,
      relations_by_type: result.quality.relations_by_type,
      unresolved_by_state: result.quality.unresolved_by_state,
      invariants: result.quality.invariants,
    },
  };
}

async function publish() {
  if (!state.result?.quality?.valid) return;
  const token = byId("adminToken").value.trim();
  if (!token) {
    status("Admin token required", "Enter ADMIN_IMPORT_TOKEN to publish. The token is kept only in this page memory.", "warning");
    byId("adminToken").focus();
    return;
  }

  setBusy(true);
  try {
    status("Creating staged source revision", "No active semantic source data will change until activation succeeds.");
    const created = await api("/api/v2/import/revisions", token, {
      method: "POST",
      body: JSON.stringify(manifestFor(state.result)),
    });
    const revisionId = created.revision_id;
    const chunkSize = Number(created.chunk_size || 75);
    let totalSent = 0;
    const totalItems = COLLECTIONS.reduce((sum, [bundleKey]) => sum + (state.result.bundle[bundleKey]?.length || 0), 0);

    for (const [bundleKey, endpoint] of COLLECTIONS) {
      const items = state.result.bundle[bundleKey] || [];
      for (let start = 0; start < items.length; start += chunkSize) {
        const chunk = items.slice(start, start + chunkSize);
        status(
          `Uploading ${endpoint}`,
          `${formatNumber(Math.min(totalSent + chunk.length, totalItems))} of ${formatNumber(totalItems)} semantic records`,
        );
        await api(`/api/v2/import/revisions/${encodeURIComponent(revisionId)}/${endpoint}`, token, {
          method: "POST",
          body: JSON.stringify({ start, items: chunk }),
        });
        totalSent += chunk.length;
      }
    }

    status("Validating staged revision", "Cloudflare is checking counts and relation endpoint integrity before activation.");
    const activated = await api(`/api/v2/import/revisions/${encodeURIComponent(revisionId)}/activate`, token, {
      method: "POST",
      body: "{}",
    });
    status(
      "Source revision activated",
      `${activated.source_id} is now current. Previous source revision: ${activated.previous_revision_id || "none"}.`,
      "success",
    );
    byId("publishResult").hidden = false;
    byId("publishResult").textContent = `Revision ${activated.revision_id} activated with ${formatNumber(activated.counts.entities)} entity observations and ${formatNumber(activated.counts.relations)} relation observations.`;
    await refreshPlatformStatus();
  } catch (error) {
    const detail = error?.details ? ` ${JSON.stringify(error.details)}` : "";
    status("Publish failed", `${error instanceof Error ? error.message : String(error)}${detail}`, "error");
  } finally {
    setBusy(false);
  }
}

async function refreshPlatformStatus() {
  try {
    const data = await api("/api/v2/import/status", "", { method: "GET" });
    byId("platformState").textContent = data.database_ready
      ? `${data.enabled ? "Import enabled" : "Analysis only"} · ${formatNumber(data.current_sources)} current source(s)`
      : "Semantic D1 migration not applied";
    byId("platformState").dataset.ready = data.database_ready ? "true" : "false";
  } catch {
    byId("platformState").textContent = "Unable to read platform status";
  }
}

byId("analyzeButton").addEventListener("click", analyze);
byId("publishButton").addEventListener("click", publish);
byId("archiveFile").addEventListener("change", () => {
  const file = byId("archiveFile").files?.[0];
  byId("selectedFile").textContent = file ? `${file.name} · ${formatNumber(file.size)} bytes` : "No archive selected";
});
refreshPlatformStatus();
