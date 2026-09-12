#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(".phase2m-d1");
const tmp = resolve(".phase2m-tmp");
const wrangler = process.platform === "win32" ? "npx.cmd" : "npx";

rmSync(root, { recursive: true, force: true });
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

function parseJson(stdout) {
  const cleaned = stdout.replace(/\x1b\[[0-9;]*m/g, "").trim();
  for (const marker of ["[", "{"]) {
    const index = cleaned.indexOf(marker);
    if (index >= 0) {
      try { return JSON.parse(cleaned.slice(index)); } catch {}
    }
  }
  throw new Error(`wrangler did not return JSON: ${cleaned.slice(0, 800)}`);
}

function d1(args) {
  const result = spawnSync(wrangler, ["wrangler", "d1", "execute", "DB", "--local", "--persist-to", root, "--json", ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (result.status !== 0) {
    throw new Error(`wrangler d1 failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  return parseJson(result.stdout);
}

function metaRows(result) {
  const items = Array.isArray(result) ? result : [result];
  let read = 0;
  let written = 0;
  let sawMeta = false;
  for (const item of items) {
    const meta = item?.meta ?? item?.result?.meta;
    if (!meta) continue;
    sawMeta = true;
    read += Number(meta.rows_read ?? 0);
    written += Number(meta.rows_written ?? 0);
  }
  return { saw_meta: sawMeta, rows_read: read, rows_written: written };
}

function scalar(sql) {
  const result = d1(["--command", sql]);
  const items = Array.isArray(result) ? result : [result];
  const row = items[0]?.results?.[0] ?? items[0]?.result?.results?.[0];
  if (!row) throw new Error(`scalar query returned no row: ${sql}`);
  const first = Object.values(row)[0];
  return Number(first);
}

function execute(name, sql) {
  const result = d1(["--command", sql]);
  return { name, local_meta: metaRows(result) };
}

function requireCount(label, sql, expected) {
  const actual = scalar(sql);
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
  return actual;
}

// Candidate schema only: deliberately not under migrations/.
d1(["--file", resolve("design/telemetry/phase2m-telemetry-persistence.sql")]);

const seedSql = `
WITH RECURSIVE seq(n) AS (
  SELECT 1
  UNION ALL SELECT n + 1 FROM seq WHERE n < 5000
)
INSERT INTO telemetry_latest_observation
(entity_id, observation_type, dimensions_key, observed_at, value_json, unit, source_id, delivery_id, quality_json)
SELECT
  'cent_' || printf('%024x', n),
  'mq.queue.depth.current',
  '',
  '2026-09-11T08:00:00Z',
  CAST(n AS TEXT),
  'messages',
  'mq-seed.example',
  'tdel_seed',
  '{"coverage":"point_in_time"}'
FROM seq;
`;
const seedPath = resolve(tmp, "seed.sql");
writeFileSync(seedPath, seedSql);
d1(["--file", seedPath]);
requireCount("seed latest-state rows", "SELECT COUNT(*) AS count FROM telemetry_latest_observation", 5000);

const operations = [];
operations.push(execute(
  "delivery_ledger_miss",
  "SELECT delivery_id, content_sha256, source_id FROM telemetry_delivery_ledger WHERE delivery_id = 'tdel_000000000000000000000001' LIMIT 1",
));
operations.push(execute(
  "delivery_ledger_insert",
  "INSERT INTO telemetry_delivery_ledger (delivery_id, content_sha256, source_id, first_received_at, last_received_at, receipt_count, status) VALUES ('tdel_000000000000000000000001', printf('%064x', 1), 'mq-a.example', '2026-09-11T08:00:00Z', '2026-09-11T08:00:00Z', 1, 'accepted')",
));
requireCount("delivery ledger logical writes", "SELECT COUNT(*) AS count FROM telemetry_delivery_ledger", 1);
operations.push(execute(
  "delivery_ledger_hit",
  "SELECT delivery_id, content_sha256, source_id FROM telemetry_delivery_ledger WHERE delivery_id = 'tdel_000000000000000000000001' LIMIT 1",
));
operations.push(execute(
  "source_state_upsert",
  `INSERT INTO telemetry_source_state
   (source_id, last_delivery_id, last_received_at, last_observed_at, state, accepted_count, duplicate_count, quarantine_count, last_error)
   VALUES ('mq-a.example', 'tdel_000000000000000000000001', '2026-09-11T08:01:00Z', '2026-09-11T08:01:00Z', 'healthy', 1, 0, 0, NULL)
   ON CONFLICT(source_id) DO UPDATE SET
     last_delivery_id=excluded.last_delivery_id,
     last_received_at=excluded.last_received_at,
     last_observed_at=excluded.last_observed_at,
     state=excluded.state,
     accepted_count=telemetry_source_state.accepted_count + 1,
     last_error=NULL`,
));
requireCount("source-state logical writes", "SELECT COUNT(*) AS count FROM telemetry_source_state", 1);
operations.push(execute(
  "latest_state_upsert_200",
  `WITH RECURSIVE seq(n) AS (
     SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 200
   )
   INSERT INTO telemetry_latest_observation
   (entity_id, observation_type, dimensions_key, observed_at, value_json, unit, source_id, delivery_id, quality_json)
   SELECT 'cent_' || printf('%024x', n), 'mq.queue.depth.current', '', '2026-09-11T08:01:00Z', CAST(10000+n AS TEXT), 'messages', 'mq-a.example', 'tdel_000000000000000000000001', '{}'
   FROM seq
   WHERE 1
   ON CONFLICT(entity_id, observation_type, dimensions_key) DO UPDATE SET
     observed_at=excluded.observed_at,
     value_json=excluded.value_json,
     unit=excluded.unit,
     source_id=excluded.source_id,
     delivery_id=excluded.delivery_id,
     quality_json=excluded.quality_json
   WHERE excluded.observed_at >= telemetry_latest_observation.observed_at`,
));
requireCount(
  "latest-state logical writes",
  "SELECT COUNT(*) AS count FROM telemetry_latest_observation WHERE delivery_id = 'tdel_000000000000000000000001'",
  200,
);
operations.push(execute(
  "quarantine_insert_20",
  `WITH RECURSIVE seq(n) AS (
     SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 20
   )
   INSERT INTO telemetry_quarantine
   (quarantine_id, delivery_id, observation_id, source_id, semantic_type, display_name, reason, candidate_entity_ids_json, observed_at, created_at)
   SELECT 'tq_' || printf('%024x', n), 'tdel_000000000000000000000001', 'tobs_' || printf('%024x', n), 'mq-a.example', 'mq.queue', 'Q.' || n, 'scoped_identity_not_found', '[]', '2026-09-11T08:01:00Z', '2026-09-11T08:01:01Z'
   FROM seq`,
));
requireCount("quarantine logical writes", "SELECT COUNT(*) AS count FROM telemetry_quarantine", 20);

const planResult = d1(["--command", "EXPLAIN QUERY PLAN SELECT delivery_id FROM telemetry_delivery_ledger WHERE delivery_id = 'tdel_000000000000000000000001'"]);
const planText = JSON.stringify(planResult);
if (!/SEARCH.*telemetry_delivery_ledger/i.test(planText)) {
  throw new Error(`delivery ledger lookup is not indexed: ${planText}`);
}

const localMetaNonzero = operations.some((item) => item.local_meta.rows_read > 0 || item.local_meta.rows_written > 0);
const output = {
  harness: "phase2m-d1-budget/v2",
  seed_latest_rows: 5000,
  indexed_delivery_lookup: true,
  logical_write_guardrail: {
    delivery_ledger_rows: 1,
    source_state_rows: 1,
    latest_observation_rows_touched: 200,
    quarantine_rows: 20,
  },
  local_d1_meta: {
    nonzero_counters_available: localMetaNonzero,
    operations,
    note: localMetaNonzero
      ? "Local Wrangler exposed non-zero rows_read/rows_written counters; treat them as regression telemetry, not a Cloudflare billing forecast."
      : "Local Wrangler returned zero rows_read/rows_written counters for these operations. Phase 2M therefore does not pretend to have measured remote billable row reads/writes; query-plan and logical-cardinality guardrails are enforced instead.",
  },
  next_gate: "Phase 2N must measure the full accepted and duplicate request paths against a non-production remote D1 before continuous ingestion is enabled.",
};
console.log(JSON.stringify(output, null, 2));
