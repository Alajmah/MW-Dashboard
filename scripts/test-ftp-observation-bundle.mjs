#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { normalizeProjection, validateBundle } from './normalize-ftp-evidence.mjs';

function assert(condition, message) { if (!condition) throw new Error(message); }

const fixtureUrl = new URL('./fixtures/ftp-projection-sanitized.json', import.meta.url);
const raw = await readFile(fixtureUrl, 'utf8');
const fixture = JSON.parse(raw);

for (const forbidden of [/SJEDITB/i, /10\.132\./, /217\.12\./, /SVFTA/i, /SVFTC/i, /SVFTP/i]) {
  assert(!forbidden.test(raw), `sanitized fixture contains a real-estate marker: ${forbidden}`);
}

const first = normalizeProjection(fixture);
const second = normalizeProjection(JSON.parse(raw));
assert(validateBundle(first) === true, 'bundle validation failed');
assert(JSON.stringify(first) === JSON.stringify(second), 'normalization is not deterministic');
assert(first.schema_version === 'osi.observation.bundle/v2', 'wrong output schema');
assert(first.run.normalizer_version === '3.1.0', 'wrong normalizer version');

const entities = first.entities;
const relations = first.relations;
const byRef = new Map(entities.map(x=>[x.ref,x]));

const sites = entities.filter(x=>x.semantic_type==='filetransfer.endpoint' && x.properties?.endpoint_kind==='eft_site');
assert(sites.length === 5, `expected 5 EFT Site endpoints, got ${sites.length}`);

const qualified = relations.filter(x=>x.semantic_type==='integration.routes_to');
assert(qualified.length === 3, `expected 3 qualified inbound Site routes, got ${qualified.length}`);
for (const route of qualified) {
  assert(route.evidence_class === 'observed', 'qualified FTP route must remain observed');
  assert(route.properties?.qualified_route === true, 'qualified_route flag missing');
  assert(route.properties?.epistemic === 'observed', 'FTP route epistemic must be observed');
  assert(route.properties?.runtime_transfer_completion === false, 'Site access was promoted to transfer completion');
  assert(route.properties?.deterministic === true, 'route derivation must be deterministic');
  assert(Array.isArray(route.properties?.runtime_corroboration) && route.properties.runtime_corroboration.length === 1, 'PNC corroboration missing');
  assert(route.properties.runtime_corroboration[0].independently_corroborated === true, 'PNC corroboration is not independently supported');
  assert(route.properties?.semantic_warning, 'semantic warning missing');
  assert(byRef.get(route.source_ref)?.semantic_type === 'filetransfer.flow', 'qualified route source is not filetransfer.flow');
  assert(byRef.get(route.target_ref)?.semantic_type === 'filetransfer.endpoint', 'qualified route target is not filetransfer.endpoint');
}

for (const unresolvedName of ['External FTPS','Internal User']) {
  const site = sites.find(x=>x.display_name===unresolvedName);
  assert(site, `missing unresolved Site ${unresolvedName}`);
  assert(site.properties?.listener_resolution === 'unresolved', `${unresolvedName} was silently resolved`);
  assert(!qualified.some(x=>x.target_ref===site.ref), `${unresolvedName} was promoted to a qualified route`);
}

const pncEndpoints = entities.filter(x=>x.semantic_type==='filetransfer.endpoint' && x.properties?.endpoint_kind==='peer_notification_channel');
assert(pncEndpoints.length === 3, `expected 3 PNC endpoints, got ${pncEndpoints.length}`);

const mftAgents = entities.filter(x=>x.semantic_type==='app.application_instance' && x.properties?.component_class==='ibm_mq_mft_agent');
assert(mftAgents.length === 2, `expected 2 MFT agents, got ${mftAgents.length}`);
for (const agent of mftAgents) {
  assert(agent.evidence_class === 'observed', 'MFT agent should be observed current state');
  assert(agent.properties?.transfer_completion_proven === false, 'MFT agent projected transfer completion');
  assert(agent.properties?.command_line_collected === false, 'MFT command line should not be retained');
  const deps = relations.filter(x=>x.semantic_type==='network.connects_to' && x.source_ref===agent.ref && byRef.get(x.target_ref)?.semantic_type==='mq.queue_manager');
  assert(deps.length === 2, `expected agent+coordination QM anchors for ${agent.display_name}`);
  assert(deps.every(x=>x.evidence_class==='configured'), 'MFT QM association must remain configured');
  assert(deps.every(x=>x.properties?.network_endpoint_observed===false), 'MFT logical dependency was promoted to observed network connectivity');
}

const storage = entities.filter(x=>x.semantic_type==='filetransfer.endpoint' && x.properties?.endpoint_kind==='filesystem_path');
assert(storage.length === 2, `expected 2 storage paths, got ${storage.length}`);
assert(storage.every(x=>x.properties?.nfs_relationship==='unresolved'), 'local storage was incorrectly promoted to NFS');
assert(storage.every(x=>x.properties?.contents_enumerated===false), 'payload directory enumeration claim is wrong');

const serialized = JSON.stringify(first).toLowerCase();
for (const forbidden of ['password','passwd','mftcredentials.xml','service_account','command_line":"']) {
  assert(!serialized.includes(forbidden), `bundle contains disallowed sensitive material: ${forbidden}`);
}

const unsafe = JSON.parse(raw);
unsafe.mft_agents[0].password = 'should-never-pass';
let rejected = false;
try { normalizeProjection(unsafe); } catch (error) { rejected = /forbidden sensitive input key/.test(String(error)); }
assert(rejected, 'sensitive input guard did not fail closed');

const invalidCorroboration = JSON.parse(raw);
invalidCorroboration.routes[0].pnc.independently_corroborated = false;
rejected = false;
try { normalizeProjection(invalidCorroboration); } catch (error) { rejected = /independently corroborated PNC/.test(String(error)); }
assert(rejected, 'uncorroborated PNC route was accepted');

const historicalRoute = JSON.parse(raw);
historicalRoute.routes[0].time_scope = 'historical';
rejected = false;
try { normalizeProjection(historicalRoute); } catch (error) { rejected = /must be current/.test(String(error)); }
assert(rejected, 'historical route was promoted to current canonical topology');

console.log(JSON.stringify({
  status: 'PASS',
  run_id: first.run.run_id,
  entities: first.entities.length,
  relations: first.relations.length,
  qualified_inbound_routes: qualified.length,
  unresolved_sites: 2,
  pnc_endpoints: pncEndpoints.length,
  mft_agents: mftAgents.length,
}, null, 2));
