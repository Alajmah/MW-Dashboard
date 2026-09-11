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

function rows(result) {
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
  if (!sawMeta) throw new Error("D1 local result did not expose rows_read/rows_written metadata");
  return { rows_read: read, rows_written: written };
}

function measure(name, sql, budget) {
  const result = d1(["--command", sql]);
  const actual = rows(result);
  const record = { name, ...actual, budget };
  if (actual.rows_read > budget.rows_read || actual.rows_written > budget.rows_written) {
    throw new Error(`${name} exceeded budget: ${JSON.stringify(record)}`);
  }
  return record;
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

const report = [];
report.push(measure(
  "delivery_ledger_miss",
  "SELECT delivery_id, content_sha256, source_id FROM telemetry_delivery_ledger WHERE delivery_id = 'tdel_000000000000000000000001' LIMIT 1",
  { rows_read: 2, rows_written: 0 },
));
report.push(measure(
  "delivery_ledger_insert",
  "INSERT INTO telemetry_delivery_ledger (delivery_id, content_sha256, source_id, first_received_at, last_received_at, receipt_count, status) VALUES ('tdel_000000000000000000000001', printf('%064x', 1), 'mq-a.example', '2026-09-11T08:00:00Z', '2026-09-11T08:00:00Z', 1, 'accepted')",
  { rows_read: 2, rows_written: 2 },
));
report.push(measure(
  "delivery_ledger_hit",
  "SELECT delivery_id, content_sha256, source_id FROM telemetry_delivery_ledger WHERE delivery_id = 'tdel_000000000000000000000001' LIMIT 1",
  { rows_read: 2, rows_written: 0 },
));
report.push(measure(
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
  { rows_read: 4, rows_written: 2 },
));
report.push(measure(
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
  { rows_read: 500, rows_written: 250 },
));
report.push(measure(
  "quarantine_insert_20",
  `WITH RECURSIVE seq(n) AS (
     SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 20
   )
   INSERT INTO telemetry_quarantine
   (quarantine_id, delivery_id, observation_id, source_id, semantic_type, display_name, reason, candidate_entity_ids_json, observed_at, created_at)
   SELECT 'tq_' || printf('%024x', n), 'tdel_000000000000000000000001', 'tobs_' || printf('%024x', n), 'mq-a.example', 'mq.queue', 'Q.' || n, 'scoped_identity_not_found', '[]', '2026-09-11T08:01:00Z', '2026-09-11T08:01:01Z'
   FROM seq`,
  { rows_read: 40, rows_written: 40 },
));

const planResult = d1(["--command", "EXPLAIN QUERY PLAN SELECT delivery_id FROM telemetry_delivery_ledger WHERE delivery_id = 'tdel_000000000000000000000001'"]);
const planText = JSON.stringify(planResult);
if (!/SEARCH.*telemetry_delivery_ledger/i.test(planText)) {
  throw new Error(`delivery ledger lookup is not indexed: ${planText}`);
}

const total = report.reduce((acc, item) => ({
  rows_read: acc.rows_read + item.rows_read,
  rows_written: acc.rows_written + item.rows_written,
}), { rows_read: 0, rows_written: 0 });

const output = {
  harness: "phase2m-d1-budget/v1",
  seed_latest_rows: 5000,
  operations: report,
  measured_total: total,
  interpretation: "Local D1 cost guardrail for one representative accepted telemetry batch path; identity snapshot reads are intentionally measured separately in Phase 2N against the active canonical estate.",
};
console.log(JSON.stringify(output, null, 2));
