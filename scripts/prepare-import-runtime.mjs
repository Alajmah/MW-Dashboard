import { mkdir, copyFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, "public", "import-runtime");
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });

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

console.log(`Prepared ${copies.length} browser import runtime files in ${target}`);
