import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildCanonicalEstate } from "../public/estate-builder.js";

const registry = JSON.parse(await readFile(new URL("../services/core/registry/v1.json", import.meta.url), "utf8"));

const sources = [
  { revision_id: "src-host-a", source_id: "host-a" },
  { revision_id: "src-host-b", source_id: "host-b" },
];

const entities = [
  {
    revision_id: "src-host-a", source_id: "host-a", ref: "qa", semantic_type: "mq.queue_manager",
    display_name: "QM1", evidence_class: "observed", observed_at: "2026-09-09T00:00:00Z",
    identity: { hints: { name: "QM1", qmid: "QM1_2026-01-01_00.00.00" } }, properties: { role: "full_repository" },
  },
  {
    revision_id: "src-host-a", source_id: "host-a", ref: "q1a", semantic_type: "mq.queue",
    display_name: "Q.SHARED", evidence_class: "configured", observed_at: "2026-09-09T00:00:00Z",
    identity: { hints: { queue_manager_key: "QM1", name: "Q.SHARED" } }, properties: { qtype: "QLOCAL" },
  },
  {
    revision_id: "src-host-b", source_id: "host-b", ref: "qb", semantic_type: "mq.queue_manager",
    display_name: "QM1", evidence_class: "configured", observed_at: "2026-09-09T00:01:00Z",
    identity: { hints: { name: "QM1" } }, properties: { reference_only: true },
  },
  {
    revision_id: "src-host-b", source_id: "host-b", ref: "q1b", semantic_type: "mq.queue",
    display_name: "Q.SHARED", evidence_class: "configured", observed_at: "2026-09-09T00:01:00Z",
    identity: { hints: { queue_manager_key: "QM1", name: "Q.SHARED" } }, properties: { cluster_visible: true },
  },
];

const relations = [
  {
    revision_id: "src-host-a", source_id: "host-a", ref: "ra", semantic_type: "contains",
    source_ref: "qa", target_ref: "q1a", evidence_class: "configured", observed_at: "2026-09-09T00:00:00Z", properties: {},
  },
  {
    revision_id: "src-host-b", source_id: "host-b", ref: "rb", semantic_type: "contains",
    source_ref: "qb", target_ref: "q1b", evidence_class: "configured", observed_at: "2026-09-09T00:01:00Z", properties: {},
  },
];

const estate = await buildCanonicalEstate({ sources, entities, relations, unresolved: [], registry });
assert.deepEqual(estate.source_revision_ids, ["src-host-a", "src-host-b"]);
assert.equal(estate.entities.length, 2, "same logical QM and queue must canonicalize across hosts");
assert.equal(estate.relations.length, 1, "same contains relationship must canonicalize across hosts");

const qmgr = estate.entities.find((item) => item.semantic_type === "mq.queue_manager");
const queue = estate.entities.find((item) => item.semantic_type === "mq.queue");
assert(qmgr);
assert(queue);
assert.equal(qmgr.identity_rule, "qmid", "name-only QM evidence should attach to the unique observed QMID");
assert.equal(qmgr.source_count, 2);
assert.equal(qmgr.evidence_count, 2);
assert.equal(queue.source_count, 2);
assert.equal(queue.evidence_count, 2);
assert.deepEqual(qmgr.source_ids, ["host-a", "host-b"]);
assert.deepEqual(queue.source_ids, ["host-a", "host-b"]);

const contains = estate.relations[0];
assert.equal(contains.source_entity_id, qmgr.entity_id);
assert.equal(contains.target_entity_id, queue.entity_id);
assert.equal(contains.source_count, 2);
assert.equal(contains.evidence_count, 2);

const conflicting = await buildCanonicalEstate({
  sources,
  entities: [
    { ...entities[0], ref: "qa1", identity: { hints: { name: "QM1", qmid: "QM1_A" } } },
    { ...entities[2], ref: "qb1", evidence_class: "observed", identity: { hints: { name: "QM1", qmid: "QM1_B" } } },
  ],
  relations: [],
  unresolved: [],
  registry,
});
assert.equal(conflicting.entities.length, 2, "different QMIDs with the same name must never be silently collapsed");

console.log(JSON.stringify({
  source_count: estate.quality.source_count,
  canonical_entities: estate.entities.length,
  canonical_relations: estate.relations.length,
  qmgr_sources: qmgr.source_count,
  conflict_entities: conflicting.entities.length,
}, null, 2));
