#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { normalizeProjection, validateBundle } from './normalize-ftp-evidence.mjs';

function assert(condition, message) { if (!condition) throw new Error(message); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function rejectedWith(input, pattern) {
  try { normalizeProjection(input); }
  catch (error) { return pattern.test(String(error)); }
  return false;
}

const fixtureUrl = new URL('./fixtures/ftp-projection-sanitized.json', import.meta.url);
const raw = await readFile(fixtureUrl, 'utf8');
const fixture = JSON.parse(raw);

for (const forbidden of [/SJEDITB/i, /10\.132\./, /217\.12\./, /SVFTA/i, /SVFTC/i, /SVFTP/i]) {
  assert(!forbidden.test(raw), `sanitized fixture contains a real-estate marker: ${forbidden}`);
}

const first = normalizeProjection(fixture);
const second = normalizeProjection(clone(fixture));
assert(validateBundle(first) === true, 'bundle validation failed');
assert(JSON.stringify(first) === JSON.stringify(second), 'normalization is not deterministic');
assert(first.schema_version === 'osi.observation.bundle/v2', 'wrong output schema');
assert(first.run.normalizer_version === '3.1.0', 'wrong normalizer version');
assert(first.run.collector_version === '0.2.0', 'wrong adapter version');
assert(first.run.metadata?.historical_logs_promoted_to_runtime === false, 'historical evidence promotion guard missing');

const entities = first.entities;
const relations = first.relations;
const byRef = new Map(entities.map(x=>[x.ref,x]));

assert(entities.length === 37, `expected 37 entities, got ${entities.length}`);
assert(relations.length === 30, `expected 30 relations, got ${relations.length}`);
assert(new Set(relations.map(x=>x.ref)).size === relations.length, 'duplicate relation refs exist');
assert(first.unresolved_references.length === 2, `expected 2 unresolved references, got ${first.unresolved_references.length}`);
assert(first.unresolved_references.every(x=>x.state==='unresolved' && x.properties?.unresolved_kind==='site_listener_mapping'), 'unresolved Site mappings are malformed');

const importCoverageModes = new Set(['complete','point_in_time','partial','failed','not_collected']);
assert(first.coverage.every(x=>importCoverageModes.has(x.mode)), 'bundle contains a coverage mode rejected by semantic-import');
assert(first.coverage.some(x=>x.object_class==='filetransfer.endpoint' && x.mode==='partial'), 'endpoint coverage should remain partial while Sites are unresolved');

const sites = entities.filter(x=>x.semantic_type==='filetransfer.endpoint' && x.properties?.endpoint_kind==='eft_site');
assert(sites.length === 5, `expected 5 EFT Site endpoints, got ${sites.length}`);

const qualified = relations.filter(x=>x.semantic_type==='integration.routes_to');
assert(qualified.length === 3, `expected 3 qualified inbound Site paths, got ${qualified.length}`);
for (const route of qualified) {
  assert(route.evidence_class === 'inferred', 'qualified FTP topology route must remain inferred');
  assert(route.properties?.qualified_route === true, 'qualified_route flag missing');
  assert(route.properties?.epistemic === 'inferred', 'FTP route epistemic must be inferred');
  assert(route.properties?.runtime_transfer_completion === false, 'Site path was promoted to transfer completion');
  assert(route.properties?.deterministic === true, 'route derivation must be deterministic');
  assert(route.properties?.site_access_evidence?.time_scope === 'historical', 'historical Site-access time scope was flattened');
  assert(route.properties?.site_access_evidence?.evidence_class === 'observed', 'historical Site-access evidence class changed');
  assert(route.properties?.current_listener_evidence?.time_scope === 'current', 'listener evidence is not current');
  assert(route.properties?.current_listener_evidence?.evidence_class === 'observed', 'listener evidence is not observed');
  assert(Array.isArray(route.properties?.runtime_corroboration) && route.properties.runtime_corroboration.length === 1, 'PNC corroboration missing');
  const pnc = route.properties.runtime_corroboration[0];
  assert(pnc.time_scope === 'current', 'PNC corroboration time scope is not current');
  assert(pnc.evidence_class === 'observed', 'PNC corroboration is not observed');
  assert(pnc.independently_corroborated === true, 'PNC corroboration is not independently supported');
  assert(Array.isArray(pnc.evidence_refs) && new Set(pnc.evidence_refs).size >= 2, 'PNC corroboration lacks two independent evidence refs');
  assert(!pnc.evidence_refs.includes(route.properties.site_access_evidence.evidence_ref), 'PNC evidence reuses the historical Site-access evidence');
  assert(route.properties?.semantic_warning, 'semantic warning missing');
  assert(byRef.get(route.source_ref)?.semantic_type === 'filetransfer.flow', 'qualified route source is not filetransfer.flow');
  assert(byRef.get(route.target_ref)?.semantic_type === 'filetransfer.endpoint', 'qualified route target is not filetransfer.endpoint');
}

for (const unresolvedName of ['External FTPS','Internal User']) {
  const site = sites.find(x=>x.display_name===unresolvedName);
  assert(site, `missing unresolved Site ${unresolvedName}`);
  assert(site.properties?.listener_resolution === 'unresolved', `${unresolvedName} was silently resolved`);
  assert(!qualified.some(x=>x.target_ref===site.ref), `${unresolvedName} was promoted to a qualified route`);
  assert(first.unresolved_references.some(x=>x.source_ref===site.ref), `${unresolvedName} is not represented as an unresolved reference`);
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

const unsafe = clone(fixture);
unsafe.mft_agents[0].password = 'should-never-pass';
assert(rejectedWith(unsafe, /forbidden sensitive input key/), 'sensitive input guard did not fail closed');

const missingTimeScope = clone(fixture);
delete missingTimeScope.hosts[0].time_scope;
assert(rejectedWith(missingTimeScope, /must set time_scope=current/), 'missing current time scope was silently promoted');

const missingEvidenceClass = clone(fixture);
delete missingEvidenceClass.sites[0].evidence_class;
assert(rejectedWith(missingEvidenceClass, /must use evidence_class=observed/), 'missing observed evidence class was silently promoted');

const badPnc = clone(fixture);
badPnc.routes[0].pnc.independently_corroborated = false;
assert(rejectedWith(badPnc, /independently corroborated PNC/), 'uncorroborated PNC route was accepted');

const onePncSource = clone(fixture);
onePncSource.routes[0].pnc.corroboration_evidence_refs = ['ev:pnc-a1-dmz'];
assert(rejectedWith(onePncSource, /at least two distinct corroboration_evidence_refs/), 'single-source PNC evidence was accepted as independent corroboration');

const reusedSiteAccess = clone(fixture);
reusedSiteAccess.routes[0].pnc.corroboration_evidence_refs = ['ev:pnc-a1-dmz', 'ev:site-access-external-user'];
assert(rejectedWith(reusedSiteAccess, /independent of Site-access evidence/), 'PNC corroboration reused Site-access evidence');

const historicalPnc = clone(fixture);
historicalPnc.routes[0].pnc.time_scope = 'historical';
assert(rejectedWith(historicalPnc, /PNC must set time_scope=current/), 'historical PNC evidence was promoted to current runtime corroboration');

const currentSiteAccess = clone(fixture);
currentSiteAccess.routes[0].site_access.time_scope = 'current';
assert(rejectedWith(currentSiteAccess, /Site access must set time_scope=historical/), 'Site-access historical boundary was lost');

const badGatewayRole = clone(fixture);
badGatewayRole.routes[0].gateway_server_key = 'eft:EFT01';
assert(rejectedWith(badGatewayRole, /gateway must have role=dmz_gateway/), 'route was allowed to attach a gateway listener to a non-DMZ server');

const mutatedContent = clone(fixture);
mutatedContent.routes[0].listener.port = 2222;
const mutatedBundle = normalizeProjection(mutatedContent);
assert(mutatedBundle.run.run_id !== first.run.run_id, 'run_id did not change when semantic content changed');

const reordered = clone(fixture);
for (const name of ['hosts','servers','sites','routes','storage_paths','mft_agents','gaps']) reordered[name].reverse();
const reorderedBundle = normalizeProjection(reordered);
assert(reorderedBundle.run.run_id === first.run.run_id, 'run_id changed only because top-level keyed arrays were reordered');
assert(JSON.stringify(reorderedBundle) === JSON.stringify(first), 'bundle bytes changed only because top-level keyed arrays were reordered');

const sameQm = clone(fixture);
sameQm.mft_agents[0].coordination_queue_manager = sameQm.mft_agents[0].agent_queue_manager;
const sameQmBundle = normalizeProjection(sameQm);
const sameQmEntities = new Map(sameQmBundle.entities.map(x=>[x.ref,x]));
const prodAgent = sameQmBundle.entities.find(x=>x.semantic_type==='app.application_instance' && x.display_name==='MFTPROD.AGENT01');
const sameQmDeps = sameQmBundle.relations.filter(x=>x.semantic_type==='network.connects_to' && x.source_ref===prodAgent.ref && sameQmEntities.get(x.target_ref)?.semantic_type==='mq.queue_manager');
assert(sameQmDeps.length === 2, 'same-QM MFT agent lost one dependency role');
assert(new Set(sameQmDeps.map(x=>x.ref)).size === 2, 'same-QM MFT dependency relations share an identity');
assert(new Set(sameQmDeps.map(x=>x.properties?.dependency_role)).size === 2, 'same-QM MFT dependency roles were collapsed');

console.log(JSON.stringify({
  status: 'PASS',
  run_id: first.run.run_id,
  entities: first.entities.length,
  relations: first.relations.length,
  unresolved: first.unresolved_references.length,
  qualified_inbound_paths: qualified.length,
  route_epistemic: 'inferred',
  unresolved_sites: 2,
  pnc_endpoints: pncEndpoints.length,
  mft_agents: mftAgents.length,
}, null, 2));
