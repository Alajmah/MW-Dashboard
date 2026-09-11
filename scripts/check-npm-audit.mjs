#!/usr/bin/env node
import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: node scripts/check-npm-audit.mjs <npm-audit.json>");
  process.exit(2);
}

const report = JSON.parse(readFileSync(path, "utf8"));
const vulnerabilities = report.vulnerabilities ?? {};
const rows = Object.entries(vulnerabilities).map(([name, value]) => {
  const via = Array.isArray(value.via)
    ? value.via.map((item) => typeof item === "string" ? item : item?.title).filter(Boolean)
    : [];
  return {
    name,
    severity: value.severity,
    direct: Boolean(value.isDirect),
    range: value.range,
    via,
    fixAvailable: value.fixAvailable,
  };
});

const severityRank = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
rows.sort((a, b) => (severityRank[b.severity] ?? -1) - (severityRank[a.severity] ?? -1) || a.name.localeCompare(b.name));

console.log(JSON.stringify({
  metadata: report.metadata?.vulnerabilities ?? {},
  vulnerabilities: rows,
}, null, 2));

const blocking = rows.filter((row) => row.severity === "high" || row.severity === "critical");
if (blocking.length) {
  console.error(`npm audit policy failed: ${blocking.length} high/critical vulnerable package entries remain`);
  process.exit(1);
}
