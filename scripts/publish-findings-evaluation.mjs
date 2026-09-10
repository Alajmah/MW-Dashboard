#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

function usage() {
  console.error(`Usage:
  node scripts/publish-findings-evaluation.mjs <evaluation.json> --environment <name> [--endpoint <url>] [--token <token>]

Environment variables:
  ADMIN_IMPORT_TOKEN   administrative import credential
  OSI_API_URL          API base URL (default: https://mw-dashboard.saeedm309.workers.dev)
  OSI_ENVIRONMENT      environment name when --environment is omitted`);
}

function parseArgs(argv) {
  const args = [...argv];
  const filename = args.shift();
  if (!filename || filename.startsWith("-")) return null;
  const options = {};
  while (args.length) {
    const flag = args.shift();
    if (!["--environment", "--endpoint", "--token"].includes(flag)) {
      throw new Error(`Unknown argument: ${flag}`);
    }
    const value = args.shift();
    if (!value) throw new Error(`${flag} requires a value`);
    options[flag.slice(2)] = value;
  }
  return { filename, options };
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function requestJson(url, token, method = "GET", body = undefined) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(url, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let payload;
      try { payload = text ? JSON.parse(text) : {}; }
      catch { payload = { raw: text }; }
      if (response.ok) return payload;
      const error = new Error(`${method} ${url} -> ${response.status}: ${payload.detail ?? text}`);
      error.status = response.status;
      error.payload = payload;
      if (response.status < 500 || attempt === 4) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (error?.status && error.status < 500) throw error;
      if (attempt === 4) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 500));
  }
  throw lastError;
}

async function uploadCollection(base, token, revisionId, collection, items, chunkSize) {
  for (let start = 0; start < items.length; start += chunkSize) {
    const chunk = items.slice(start, start + chunkSize);
    await requestJson(
      `${base}/api/v2/operations/evaluations/${encodeURIComponent(revisionId)}/${collection}`,
      token,
      "POST",
      { start, items: chunk },
    );
    process.stdout.write(`\r${collection}: ${Math.min(start + chunk.length, items.length)}/${items.length}`);
  }
  if (items.length) process.stdout.write("\n");
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    usage();
    process.exitCode = 2;
    return;
  }

  const endpoint = String(parsed.options.endpoint ?? process.env.OSI_API_URL ?? "https://mw-dashboard.saeedm309.workers.dev").replace(/\/+$/, "");
  const environment = parsed.options.environment ?? process.env.OSI_ENVIRONMENT;
  const token = parsed.options.token ?? process.env.ADMIN_IMPORT_TOKEN;
  if (!environment) throw new Error("--environment or OSI_ENVIRONMENT is required; operational evidence must not be assigned a silent default environment");
  if (!token) throw new Error("--token or ADMIN_IMPORT_TOKEN is required");

  const bytes = fs.readFileSync(parsed.filename);
  const result = JSON.parse(bytes.toString("utf8"));
  if (result.schema_version !== "osi.findings.evaluation/v1") {
    throw new Error(`Unsupported evaluation schema: ${result.schema_version}`);
  }
  if (!result.evaluation || typeof result.evaluation !== "object") throw new Error("evaluation metadata is missing");
  if (!Array.isArray(result.operational_observations) || !Array.isArray(result.coverage) || !Array.isArray(result.findings)) {
    throw new Error("evaluation must contain operational_observations, coverage, and findings arrays");
  }

  const meta = result.evaluation;
  const archiveSha = String(meta.source_archive_sha256 ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(archiveSha)) throw new Error("evaluation.source_archive_sha256 must be a SHA-256 digest");

  const manifest = {
    schema_version: result.schema_version,
    source: {
      id: String(meta.source_id ?? ""),
      host: String(meta.source_host ?? ""),
    },
    environment,
    evaluator: String(meta.evaluator ?? "evaluate_findings_v1.py"),
    evaluator_version: String(meta.evaluator_version ?? ""),
    evaluated_at: String(meta.evaluated_at ?? ""),
    artifact: {
      filename: String(meta.source_archive ?? ""),
      sha256: archiveSha,
    },
    result_sha256: sha256(bytes),
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
      published_from: path.basename(parsed.filename),
    },
  };

  const created = await requestJson(`${endpoint}/api/v2/operations/evaluations`, token, "POST", manifest);
  const revisionId = created.evaluation_revision_id;
  const chunkSize = Number(created.chunk_size ?? 75);
  if (!revisionId) throw new Error("Server did not return evaluation_revision_id");
  console.log(`staging revision: ${revisionId}`);

  await uploadCollection(endpoint, token, revisionId, "observations", result.operational_observations, chunkSize);
  await uploadCollection(endpoint, token, revisionId, "coverage", result.coverage, chunkSize);
  await uploadCollection(endpoint, token, revisionId, "findings", result.findings, chunkSize);

  const activated = await requestJson(
    `${endpoint}/api/v2/operations/evaluations/${encodeURIComponent(revisionId)}/activate`,
    token,
    "POST",
    {},
  );
  console.log(JSON.stringify({
    endpoint,
    environment,
    evaluation_revision_id: revisionId,
    source_id: manifest.source.id,
    counts: manifest.counts,
    status: activated.status,
    activated_at: activated.activated_at,
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.message ?? error);
  if (error?.payload) console.error(JSON.stringify(error.payload, null, 2));
  process.exitCode = 1;
});
