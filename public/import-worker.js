const PYODIDE_VERSION = "314.0.6";
const PYODIDE_INDEX = `${self.location.origin}/import-runtime/pyodide/`;
const PYODIDE_MODULE = "/import-runtime/pyodide/pyodide.mjs";
const RUNTIME_FILES = [
  "normalize_mq_topology.py",
  "_normalize_mq_observations_impl.py",
  "mq_cluster_semantics.py",
  "normalize_mq_observations.py",
];
const COVERAGE_MODES = new Set(["complete", "point_in_time", "partial", "failed", "not_collected"]);

let pyodidePromise;
let registryPromise;

function progress(message, detail = "") {
  self.postMessage({ type: "progress", message, detail });
}

async function sha256Hex(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getRegistry() {
  if (!registryPromise) {
    registryPromise = fetch("/import-runtime/semantic-registry-v1.json", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error(`Unable to load semantic registry (${response.status})`);
      return response.json();
    });
  }
  return registryPromise;
}

async function getPyodide() {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      progress("Loading local normalization engine", `Pyodide ${PYODIDE_VERSION}`);
      const module = await import(PYODIDE_MODULE);
      if (typeof module.loadPyodide !== "function") throw new Error("Pyodide module failed to initialize");
      const pyodide = await module.loadPyodide({ indexURL: PYODIDE_INDEX });
      const runtimeDir = "/home/pyodide/mq-normalizer";
      pyodide.FS.mkdirTree(runtimeDir);
      progress("Loading IBM MQ semantic normalizer", "Normalizer 3.1.0");
      const sources = await Promise.all(RUNTIME_FILES.map(async (name) => {
        const response = await fetch(`/import-runtime/${name}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`Unable to load ${name} (${response.status})`);
        return [name, await response.text()];
      }));
      for (const [name, source] of sources) pyodide.FS.writeFile(`${runtimeDir}/${name}`, source);
      await pyodide.runPythonAsync(`
import importlib, sys
runtime_dir = ${JSON.stringify(runtimeDir)}
if runtime_dir not in sys.path:
    sys.path.insert(0, runtime_dir)
importlib.invalidate_caches()
`);
      return pyodide;
    })();
  }
  return pyodidePromise;
}

function semanticQuality(bundle, registry, archiveSha) {
  const errors = [];
  const warnings = [];
  const entities = Array.isArray(bundle.entities) ? bundle.entities : [];
  const relations = Array.isArray(bundle.relations) ? bundle.relations : [];
  const coverage = Array.isArray(bundle.coverage) ? bundle.coverage : [];
  const unresolved = Array.isArray(bundle.unresolved_references) ? bundle.unresolved_references : [];
  const evidenceClasses = new Set(registry.evidence_classes || []);
  const entityTypes = new Set((registry.entities || []).map((item) => item.type));
  const relationContracts = new Map((registry.relationships || []).map((item) => [item.type, item]));
  const entityByRef = new Map();
  const relationRefs = new Set();

  if (bundle.schema_version !== "osi.observation.bundle/v2") errors.push(`Unexpected schema version: ${bundle.schema_version || "missing"}`);
  if (bundle?.run?.normalizer_version !== "3.1.0") errors.push(`Unexpected normalizer version: ${bundle?.run?.normalizer_version || "missing"}`);
  if ((bundle?.run?.artifact?.sha256 || "").toLowerCase() !== archiveSha.toLowerCase()) {
    errors.push("Archive SHA-256 does not match the normalizer artifact digest");
  }

  for (const entity of entities) {
    if (!entity?.ref || entityByRef.has(entity.ref)) errors.push(`Duplicate or missing entity ref: ${entity?.ref || "<missing>"}`);
    else entityByRef.set(entity.ref, entity);
    if (!entityTypes.has(entity?.semantic_type)) errors.push(`Unknown entity type: ${entity?.semantic_type || "<missing>"}`);
    if (!evidenceClasses.has(entity?.evidence_class)) errors.push(`Invalid entity evidence class: ${entity?.evidence_class || "<missing>"}`);
  }

  for (const relation of relations) {
    if (!relation?.ref || relationRefs.has(relation.ref)) errors.push(`Duplicate or missing relation ref: ${relation?.ref || "<missing>"}`);
    else relationRefs.add(relation.ref);
    const contract = relationContracts.get(relation?.semantic_type);
    const source = entityByRef.get(relation?.source_ref);
    const target = entityByRef.get(relation?.target_ref);
    if (!source || !target) {
      errors.push(`Dangling relation: ${relation?.ref || "<missing>"}`);
      continue;
    }
    if (!contract) {
      errors.push(`Unknown relation type: ${relation?.semantic_type || "<missing>"}`);
      continue;
    }
    if (!(contract.source_types || []).includes(source.semantic_type)) errors.push(`Invalid source type for ${relation.semantic_type}: ${source.semantic_type}`);
    if (!(contract.target_types || []).includes(target.semantic_type)) errors.push(`Invalid target type for ${relation.semantic_type}: ${target.semantic_type}`);
    if (!(contract.evidence_classes || []).includes(relation.evidence_class)) errors.push(`Invalid evidence class for ${relation.semantic_type}: ${relation.evidence_class}`);
  }

  for (const item of coverage) {
    if (!COVERAGE_MODES.has(item?.mode)) errors.push(`Invalid coverage mode: ${item?.mode || "<missing>"}`);
  }

  for (const item of unresolved) {
    if (!entityByRef.has(item?.source_ref)) errors.push(`Unresolved reference has missing source: ${item?.ref || "<missing>"}`);
    for (const ref of item?.candidate_refs || []) {
      if (!entityByRef.has(ref)) errors.push(`Unresolved candidate does not exist: ${ref}`);
    }
  }

  const failedCoverage = coverage.filter((item) => item.mode === "failed").length;
  if (failedCoverage) warnings.push(`${failedCoverage} coverage scope(s) failed during collection`);

  const byType = {};
  for (const entity of entities) byType[entity.semantic_type] = (byType[entity.semantic_type] || 0) + 1;
  const relationByType = {};
  for (const relation of relations) relationByType[relation.semantic_type] = (relationByType[relation.semantic_type] || 0) + 1;
  const unresolvedByState = {};
  for (const item of unresolved) unresolvedByState[item.state] = (unresolvedByState[item.state] || 0) + 1;

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    counts: {
      coverage: coverage.length,
      entities: entities.length,
      relations: relations.length,
      unresolved: unresolved.length,
      failed_coverage: failedCoverage,
    },
    entities_by_type: byType,
    relations_by_type: relationByType,
    unresolved_by_state: unresolvedByState,
    invariants: {
      dangling_relations: errors.filter((item) => item.startsWith("Dangling relation")).length,
      activity_relations: relations.filter((item) => String(item.semantic_type || "").startsWith("activity.")).length,
      physical_hosts: byType["infra.host"] || 0,
      queue_managers: byType["mq.queue_manager"] || 0,
      channels: byType["mq.channel"] || 0,
    },
  };
}

async function normalizeArchive(message) {
  const archiveBuffer = message.archive;
  const filename = String(message.filename || "mq-topology.tar.gz");
  const environment = String(message.environment || "").trim();
  if (!(archiveBuffer instanceof ArrayBuffer)) throw new Error("Archive bytes are missing");

  progress("Fingerprinting collector archive", filename);
  const archiveSha = await sha256Hex(archiveBuffer);
  const [pyodide, registry] = await Promise.all([getPyodide(), getRegistry()]);
  const safeName = filename.replace(/[^A-Za-z0-9._-]/g, "_");
  const archivePath = `/tmp/${Date.now()}-${safeName}`;
  pyodide.FS.writeFile(archivePath, new Uint8Array(archiveBuffer));

  try {
    progress("Normalizing IBM MQ evidence", "This happens locally in your browser");
    pyodide.globals.set("osi_archive_path", archivePath);
    pyodide.globals.set("osi_environment", environment);
    const bundleJson = await pyodide.runPythonAsync(`
import importlib, json
import normalize_mq_observations
importlib.reload(normalize_mq_observations)
bundle = normalize_mq_observations.normalize(osi_archive_path, osi_environment or None)
json.dumps(bundle, separators=(",", ":"), ensure_ascii=False)
`);
    const bundleSha = await sha256Hex(bundleJson);
    const bundle = JSON.parse(bundleJson);
    progress("Validating semantic registry contracts", `${bundle.entities?.length || 0} entity observations`);
    const quality = semanticQuality(bundle, registry, archiveSha);
    self.postMessage({
      type: "result",
      filename,
      archive_sha256: archiveSha,
      archive_size_bytes: archiveBuffer.byteLength,
      bundle_sha256: bundleSha,
      bundle,
      quality,
    });
  } finally {
    try { pyodide.FS.unlink(archivePath); } catch {}
  }
}

self.onmessage = async (event) => {
  if (event.data?.type !== "normalize") return;
  try {
    await normalizeArchive(event.data);
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
