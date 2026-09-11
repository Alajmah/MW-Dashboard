#!/usr/bin/env node
import assert from "node:assert/strict";

const calls = new Map();
const increment = (key) => calls.set(key, (calls.get(key) || 0) + 1);
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
});

const openFindings = [
  { finding_id: "find_aaaaaaaaaaaaaaaaaaaaaaaa", severity: "critical", status: "OPEN", display_name: "Q.A" },
  { finding_id: "find_bbbbbbbbbbbbbbbbbbbbbbbb", severity: "warning", status: "OPEN", display_name: "Q.B" },
  { finding_id: "find_cccccccccccccccccccccccc", severity: "info", status: "OPEN", display_name: "QM.A" },
];
const acknowledgedFindings = [
  { finding_id: "find_dddddddddddddddddddddddd", severity: "warning", status: "ACKNOWLEDGED", display_name: "Q.C" },
  { finding_id: "find_eeeeeeeeeeeeeeeeeeeeeeee", severity: "info", status: "ACKNOWLEDGED", display_name: "QM.B" },
];

const originalFetch = async (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost/");
  const method = String(init.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
  const key = `${method} ${url.pathname}${url.search}`;
  increment(key);

  if (method !== "GET") return json({ changed: true });
  if (url.pathname === "/api/v2/operations/status") {
    return json({ current_sources: 1, current_findings: 5, current_observations: 20, current_coverage_gaps: 0 });
  }
  if (url.pathname === "/api/v2/operations/current/observations") {
    return json({ observations: [{ observed_at: "2026-09-11T08:00:00Z" }], page: { total: 20, limit: 1, offset: 0, next_offset: 1 } });
  }
  if (url.pathname === "/api/v2/estate/current/summary") {
    return json({ counts: { entities: 924, relations: 1867, unresolved: 26 } });
  }
  if (url.pathname === "/api/v2/findings/current") {
    const status = url.searchParams.get("status");
    const findings = status === "OPEN" ? openFindings : acknowledgedFindings;
    assert.equal(url.searchParams.get("limit"), "200", "broker must load one bounded superset page");
    assert.equal(url.searchParams.get("offset"), "0");
    return json({
      schema_version: "osi.findings.read/v1",
      page: { total: findings.length, limit: 200, offset: 0, next_offset: null },
      findings,
    });
  }
  return json({ passthrough: true });
};

globalThis.window = globalThis;
window.location = { origin: "http://localhost", href: "http://localhost/" };
window.fetch = originalFetch;

await import(new URL(`../public/phase2i-overview-read-broker.js?test=${Date.now()}`, import.meta.url));

const [statusA, statusB, statusC] = await Promise.all([
  fetch("/api/v2/operations/status", { headers: { accept: "application/json" } }),
  fetch("/api/v2/operations/status", { headers: { accept: "application/json" } }),
  fetch("/api/v2/operations/status", { headers: { accept: "application/json" } }),
]);
assert.equal((await statusA.json()).current_sources, 1);
assert.equal((await statusB.json()).current_findings, 5);
assert.equal((await statusC.json()).current_observations, 20);
assert.equal(calls.get("GET /api/v2/operations/status"), 1, "identical status reads should coalesce");

const findingResponses = await Promise.all([
  fetch("/api/v2/findings/current?status=OPEN&limit=12&offset=0"),
  fetch("/api/v2/findings/current?status=OPEN&severity=critical&limit=1&offset=0"),
  fetch("/api/v2/findings/current?status=OPEN&severity=warning&limit=1&offset=0"),
  fetch("/api/v2/findings/current?status=OPEN&severity=info&limit=200&offset=0"),
  fetch("/api/v2/findings/current?status=ACKNOWLEDGED&limit=12&offset=0"),
  fetch("/api/v2/findings/current?status=ACKNOWLEDGED&severity=warning&limit=1&offset=0"),
]);
const findingBodies = await Promise.all(findingResponses.map((response) => response.json()));
assert.equal(findingBodies[0].page.total, 3);
assert.equal(findingBodies[1].page.total, 1);
assert.equal(findingBodies[2].page.total, 1);
assert.equal(findingBodies[3].page.total, 1);
assert.equal(findingBodies[4].page.total, 2);
assert.equal(findingBodies[5].page.total, 1);
assert.equal(calls.get("GET /api/v2/findings/current?status=OPEN&limit=200&offset=0"), 1, "OPEN findings should load once");
assert.equal(calls.get("GET /api/v2/findings/current?status=ACKNOWLEDGED&limit=200&offset=0"), 1, "ACK findings should load once");

await Promise.all([
  fetch("/api/v2/operations/current/observations?limit=1&offset=0"),
  fetch("/api/v2/operations/current/observations?limit=1&offset=0"),
]);
assert.equal(calls.get("GET /api/v2/operations/current/observations?limit=1&offset=0"), 1, "latest observation reads should coalesce");

await Promise.all([
  fetch("/api/v2/estate/current/summary"),
  fetch("/api/v2/estate/current/summary"),
  fetch("/api/v2/estate/current/summary"),
]);
assert.equal(calls.get("GET /api/v2/estate/current/summary"), 1, "canonical summary should be cached");

await fetch("/api/v2/findings/find_aaaaaaaaaaaaaaaaaaaaaaaa/lifecycle", { method: "POST", body: "{}" });
await fetch("/api/v2/operations/status");
assert.equal(calls.get("GET /api/v2/operations/status"), 2, "API mutations must invalidate current-state cache");

console.log(JSON.stringify({
  harness: "phase2i-overview-read-broker/v1",
  backend_reads: Object.fromEntries([...calls].filter(([key]) => key.startsWith("GET "))),
  assertions: {
    status_requests_coalesced: true,
    finding_filters_served_from_status_snapshots: true,
    latest_observation_coalesced: true,
    estate_summary_cached: true,
    mutation_invalidates_cache: true,
  },
}, null, 2));
