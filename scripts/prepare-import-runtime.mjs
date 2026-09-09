import { mkdir, copyFile, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, "public", "import-runtime");
const pyodideTarget = join(target, "pyodide");
await rm(target, { recursive: true, force: true });
await mkdir(pyodideTarget, { recursive: true });

const copies = [
  ["collectors/ibm-mq/normalize_mq_topology.py", "normalize_mq_topology.py"],
  ["collectors/ibm-mq/_normalize_mq_observations_impl.py", "_normalize_mq_observations_impl.py"],
  ["collectors/ibm-mq/mq_cluster_semantics.py", "mq_cluster_semantics.py"],
  ["collectors/ibm-mq/normalize_mq_observations.py", "normalize_mq_observations.py"],
  ["services/core/registry/v1.json", "semantic-registry-v1.json"],
  ["contracts/v2/observation-bundle.schema.json", "observation-bundle.schema.json"],
];

for (const [source, name] of copies) {
  await copyFile(join(root, source), join(target, name));
}

const pyodideRoot = join(root, "node_modules", "pyodide");
const pyodideFiles = [
  "pyodide.js",
  "pyodide.asm.mjs",
  "pyodide.asm.wasm",
  "python_stdlib.zip",
  "pyodide-lock.json",
];

for (const name of pyodideFiles) {
  const source = join(pyodideRoot, name);
  const info = await stat(source);
  if (!info.isFile() || info.size === 0) throw new Error(`Invalid Pyodide runtime asset: ${source}`);
  await copyFile(source, join(pyodideTarget, name));
}

const importWorker = await readFile(join(root, "public", "import-worker.js"), "utf8");
if (importWorker.includes("cdn.jsdelivr.net")) {
  throw new Error("Browser import worker must not depend on jsDelivr at runtime");
}
if (!importWorker.includes("/import-runtime/pyodide/")) {
  throw new Error("Browser import worker must load Pyodide from same-origin /import-runtime/pyodide/");
}

console.log(`Prepared ${copies.length} semantic runtime files and ${pyodideFiles.length} self-hosted Pyodide assets in ${target}`);
