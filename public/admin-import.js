const byId = (id) => document.getElementById(id);
const state = { result: null, busy: false };
const COLLECTIONS = [
  ["coverage", "coverage"],
  ["entities", "entities"],
  ["relations", "relations"],
  ["unresolved_references", "unresolved"],
];
const ESTATE_COLLECTIONS = ["entities", "relations", "unresolved"];

function setBusy(value) {
  state.busy = value;
  byId("analyzeButton").disabled = value;
  byId("verifyTokenButton").disabled = value;
  byId("reconcileButton").disabled = value;
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

function tokenValue() {
  return byId("adminToken").value.trim();
}

function requireToken() {
  const token = tokenValue();
  if (!token) {
    status("Admin token required", "Enter ADMIN_IMPORT_TOKEN for protected import or reconciliation operations.", "warning");
    byId("adminToken").focus();
    return null;
  }
  return token;
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
  const worker = new Worker("/import-worker.js", { type: "module" });
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

async function verifyToken() {
  const token = requireToken();
  if (!token) return;
  setBusy(true);
  try {
    const data = await api("/api/v2/import/sources", token, { method: "GET" });
    status("Admin token verified", `Protected import API accepted the token. ${formatNumber(data.sources?.length || 0)} current source(s) are active.`, "success");
  } catch (error) {
    status("Token verification failed", error instanceof Error ? error.message : String(error), "error");
  } finally {
    setBusy(false);
  }
}

async function publish() {
  if (!state.result?.quality?.valid) return;
  const token = requireToken();
  if (!token) return;

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
      `${activated.source_id} is now current. Reconcile the current source set to refresh the canonical estate.`,
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

async function fetchAllCurrent(collection, token) {
  const items = [];
  let offset = 0;
  while (offset != null) {
    status(`Reading current ${collection}`, `${formatNumber(items.length)} observation(s) loaded so far.`);
    const page = await api(`/api/v2/observations/current/${collection}?limit=100&offset=${offset}`, token, { method: "GET" });
    items.push(...(page.items || []));
    offset = page.next_offset;
  }
  return items;
}

async function reconcileEstate() {
  const token = requireToken();
  if (!token) return;
  setBusy(true);
  byId("estateResult").hidden = true;
  try {
    status("Reading current source set", "Canonical reconciliation uses only source revisions that are current now.");
    const sourceData = await api("/api/v2/import/sources", token, { method: "GET" });
    const sources = sourceData.sources || [];
    if (!sources.length) throw new Error("No current semantic source revisions are available to reconcile");

    const entities = await fetchAllCurrent("entities", token);
    const relations = await fetchAllCurrent("relations", token);
    const unresolved = await fetchAllCurrent("unresolved", token);
    status("Applying canonical identity rules", `${formatNumber(entities.length)} entity observations across ${formatNumber(sources.length)} source(s).`);

    const registryResponse = await fetch("/import-runtime/semantic-registry-v1.json");
    if (!registryResponse.ok) throw new Error(`Semantic registry failed to load (${registryResponse.status})`);
    const registry = await registryResponse.json();
    const { buildCanonicalEstate } = await import("/estate-builder.js");
    const estate = await buildCanonicalEstate({ sources, entities, relations, unresolved, registry });

    status(
      "Staging canonical estate",
      `${formatNumber(entities.length)} entity observations → ${formatNumber(estate.entities.length)} canonical entities; ${formatNumber(relations.length)} relation observations → ${formatNumber(estate.relations.length)} canonical relations.`,
    );

    const created = await api("/api/v2/estate/revisions", token, {
      method: "POST",
      body: JSON.stringify({
        source_revision_ids: estate.source_revision_ids,
        source_set_hash: estate.source_set_hash,
        counts: {
          entities: estate.entities.length,
          relations: estate.relations.length,
          unresolved: estate.unresolved.length,
        },
        quality: estate.quality,
      }),
    });
    const estateRevisionId = created.estate_revision_id;
    const chunkSize = Number(created.chunk_size || 75);
    const total = estate.entities.length + estate.relations.length + estate.unresolved.length;
    let sent = 0;

    for (const collection of ESTATE_COLLECTIONS) {
      const items = estate[collection] || [];
      for (let start = 0; start < items.length; start += chunkSize) {
        const chunk = items.slice(start, start + chunkSize);
        status(
          `Uploading canonical ${collection}`,
          `${formatNumber(Math.min(sent + chunk.length, total))} of ${formatNumber(total)} canonical records`,
        );
        await api(`/api/v2/estate/revisions/${encodeURIComponent(estateRevisionId)}/${collection}`, token, {
          method: "POST",
          body: JSON.stringify({ items: chunk }),
        });
        sent += chunk.length;
      }
    }

    status("Activating canonical estate", "Cloudflare is re-checking the source-set fingerprint, counts, and canonical relation endpoints.");
    const activated = await api(`/api/v2/estate/revisions/${encodeURIComponent(estateRevisionId)}/activate`, token, {
      method: "POST",
      body: "{}",
    });

    const conflictText = estate.quality.conflicted_entities
      ? ` ${formatNumber(estate.quality.conflicted_entities)} canonical identity conflict(s) were preserved explicitly.`
      : "";
    status(
      "Canonical estate activated",
      `Estate ${activated.estate_revision_id} is current across ${formatNumber(activated.source_revision_ids.length)} source(s).${conflictText}`,
      estate.quality.conflicted_entities ? "warning" : "success",
    );
    byId("estateResult").hidden = false;
    byId("estateResult").textContent = `${formatNumber(estate.entities.length)} canonical entities · ${formatNumber(estate.relations.length)} canonical relations · ${formatNumber(estate.unresolved.length)} unresolved references. Source set ${shortHash(estate.source_set_hash)}.`;
    await refreshPlatformStatus();
  } catch (error) {
    const detail = error?.details ? ` ${JSON.stringify(error.details)}` : "";
    status("Estate reconciliation failed", `${error instanceof Error ? error.message : String(error)}${detail}`, "error");
  } finally {
    setBusy(false);
  }
}

async function refreshPlatformStatus() {
  try {
    const [importData, estateData] = await Promise.all([
      api("/api/v2/import/status", "", { method: "GET" }),
      api("/api/v2/estate/status", "", { method: "GET" }),
    ]);
    const estateLabel = estateData.current_estate
      ? (estateData.estate_fresh ? "estate current" : "estate stale")
      : "estate pending";
    byId("platformState").textContent = importData.database_ready
      ? `${importData.enabled ? "Import enabled" : "Analysis only"} · ${formatNumber(importData.current_sources)} source(s) · ${estateLabel}`
      : "Semantic D1 migration not applied";
    byId("platformState").dataset.ready = importData.database_ready && estateData.database_ready ? "true" : "false";
  } catch {
    byId("platformState").textContent = "Unable to read platform status";
  }
}

byId("analyzeButton").addEventListener("click", analyze);
byId("verifyTokenButton").addEventListener("click", verifyToken);
byId("publishButton").addEventListener("click", publish);
byId("reconcileButton").addEventListener("click", reconcileEstate);
byId("archiveFile").addEventListener("change", () => {
  const file = byId("archiveFile").files?.[0];
  byId("selectedFile").textContent = file ? `${file.name} · ${formatNumber(file.size)} bytes` : "No archive selected";
});
refreshPlatformStatus();
