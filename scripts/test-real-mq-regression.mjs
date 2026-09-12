import assert from "node:assert/strict";
import fs from "node:fs";

const fixturePath = new URL("../fixtures/regression/mq-real-shape-v1.json", import.meta.url);
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

assert.equal(fixture.schema_version, "osi.regression.mq-real-shape/v1");
assert.equal(fixture.provenance.sanitized, true);
assert.equal(fixture.provenance.sample_count, 5);
assert.equal(fixture.provenance.sample_interval_seconds_declared, 60);

const serialized = JSON.stringify(fixture).toLowerCase();
const forbiddenProductionTokens = [
  "sjeditb",
  "saudia-prj",
  "svhub",
  "svrep",
  "svfta",
  "svftc",
  "paxdatantfyrq",
  "tmsntfy",
];
for (const token of forbiddenProductionTokens) {
  assert.equal(serialized.includes(token), false, `fixture leaked production token: ${token}`);
}
assert.equal(/(?:\d{1,3}\.){3}\d{1,3}/.test(serialized), false, "fixture must not contain IPv4 addresses");

const samples = fixture.samples;
assert.equal(samples.length, 5);
for (let i = 1; i < samples.length; i += 1) {
  assert.ok(Date.parse(samples[i].observed_at) > Date.parse(samples[i - 1].observed_at), "samples must be ordered oldest to newest");
  assert.ok(samples[i].queue_depth >= samples[i - 1].queue_depth, "queue depth must not decrease in this regression sequence");
  assert.ok(samples[i].oldest_message_age_seconds > samples[i - 1].oldest_message_age_seconds, "oldest-message age must increase in this regression sequence");
}

const first = samples[0];
const last = samples.at(-1);
assert.equal(last.queue_depth - first.queue_depth, fixture.expected_evidence_facts.queue_depth_delta);
assert.equal(last.oldest_message_age_seconds - first.oldest_message_age_seconds, fixture.expected_evidence_facts.oldest_message_age_delta_seconds);
assert.equal(samples.every((sample) => sample.input_processes === 0), true);
assert.equal(samples.every((sample) => sample.output_processes > 0), true);
assert.equal(fixture.expected_evidence_facts.input_process_zero_in_all_samples, true);
assert.equal(fixture.expected_evidence_facts.output_process_present_in_all_samples, true);

const rules = new Set(fixture.expected_findings.map((finding) => finding.rule_id));
assert.equal(rules.has("mq.queue.oldest_message_aging.v1"), true);
assert.equal(rules.has("mq.queue.backlog_no_input_process.v1"), true);
assert.equal(fixture.semantic_boundaries.business_sla_breach, "not_established");
assert.equal(fixture.semantic_boundaries.application_or_service_impact, "not_established");
assert.equal(fixture.semantic_boundaries.runtime_access_is_message_activity, false);
assert.equal(fixture.semantic_boundaries.cluster_visibility_is_message_traversal, false);

console.log("Sanitized real-shaped IBM MQ regression fixture OK");
console.log(`Depth: ${first.queue_depth} -> ${last.queue_depth} (+${last.queue_depth - first.queue_depth})`);
console.log(`Oldest age: ${first.oldest_message_age_seconds} -> ${last.oldest_message_age_seconds} (+${last.oldest_message_age_seconds - first.oldest_message_age_seconds}s)`);
console.log("IPPROCS=0 in all 5 samples; OPPROCS>0 in all 5 samples");
