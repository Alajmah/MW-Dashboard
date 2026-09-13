#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const SCHEMA_VERSION = 'osi.observation.bundle/v2';
const ADAPTER_VERSION = '0.1.0';
// The semantic import API currently gates the Observation Bundle v2 contract at 3.1.0.
// Adapter identity remains explicit in collector_version + run.metadata.
const SEMANTIC_NORMALIZER_VERSION = '3.1.0';

function fail(message) { throw new Error(message); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function stableRef(prefix, ...parts) { return `${prefix}_${sha256(parts.join('|')).slice(0, 20)}`; }
function uniq(values) { return [...new Set(values.filter(Boolean))]; }
function currentOnly(items) { return items.filter((x) => x?.time_scope === 'current'); }
function objectById(items) { return new Map(items.map((x) => [x.id, x])); }
function evidenceRef(item) { return item?.evidence_refs?.[0] ?? null; }
function evidenceRefs(item) { return uniq(item?.evidence_refs ?? []); }

class Builder {
  constructor(run) {
    this.bundle = { schema_version: SCHEMA_VERSION, run, coverage: [], entities: [], relations: [], unresolved_references: [] };
    this.entityByKey = new Map();
    this.entityType = new Map();
  }
  entity(semantic_type, hints, display_name, observed_at, evidence_class, { evidence_ref=null, status=null, properties={} }={}) {
    const cleanHints = Object.fromEntries(Object.entries(hints).filter(([,v]) => v !== null && v !== undefined && v !== ''));
    const key = JSON.stringify([semantic_type, cleanHints, evidence_class, evidence_ref]);
    if (this.entityByKey.has(key)) return this.entityByKey.get(key);
    const ref = stableRef('ent', key);
    const item = { ref, semantic_type, identity: { hints: cleanHints }, display_name, observed_at, evidence_class, properties };
    if (status) item.status = status;
    if (evidence_ref) item.evidence_ref = evidence_ref;
    this.bundle.entities.push(item); this.entityByKey.set(key, ref); this.entityType.set(ref, semantic_type); return ref;
  }
  relation(semantic_type, source_ref, target_ref, observed_at, evidence_class, { evidence_ref=null, properties={}, derivation_method=null, deterministic=null, confidence=null }={}) {
    if (!this.entityType.has(source_ref) || !this.entityType.has(target_ref)) fail(`relation endpoint missing: ${semantic_type}`);
    const ref = stableRef('rel', semantic_type, source_ref, target_ref, evidence_class, evidence_ref ?? '');
    const item = { ref, semantic_type, source_ref, target_ref, observed_at, evidence_class, properties };
    if (evidence_ref) item.evidence_ref = evidence_ref;
    if (derivation_method) item.derivation_method = derivation_method;
    if (deterministic !== null) item.deterministic = Boolean(deterministic);
    if (confidence !== null) item.confidence = Number(confidence);
    this.bundle.relations.push(item); return ref;
  }
  coverage(scope_type, scope_key, object_class, mode, { evidence_ref=null, error=null, properties={} }={}) {
    const item = { scope_type, scope_key, object_class, mode, properties };
    if (evidence_ref) item.evidence_ref = evidence_ref;
    if (error) item.error = error;
    this.bundle.coverage.push(item);
  }
  finish() {
    this.bundle.coverage.sort((a,b)=>`${a.scope_type}|${a.scope_key}|${a.object_class}`.localeCompare(`${b.scope_type}|${b.scope_key}|${b.object_class}`));
    this.bundle.entities.sort((a,b)=>`${a.semantic_type}|${a.display_name}|${a.ref}`.localeCompare(`${b.semantic_type}|${b.display_name}|${b.ref}`));
    this.bundle.relations.sort((a,b)=>`${a.semantic_type}|${a.source_ref}|${a.target_ref}|${a.ref}`.localeCompare(`${b.semantic_type}|${b.source_ref}|${b.target_ref}|${b.ref}`));
    return this.bundle;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i=2;i<argv.length;i++) {
    const key=argv[i]; if (!key.startsWith('--')) fail(`unexpected argument: ${key}`);
    const value=argv[++i]; if (!value) fail(`missing value for ${key}`); args[key.slice(2)] = value;
  }
  for (const key of ['graph','route','evidence','output']) if (!args[key]) fail(`--${key} is required`);
  return args;
}

function findRuntimeHostForAppliance(graph, hostName) {
  return graph.entities.find((x) => x.kind === 'physical_host' && x.name === hostName && x.time_scope === 'current');
}

function routeEvidenceDetails(route, evidenceIndex) {
  const byId = new Map((evidenceIndex.evidence ?? []).map((x) => [x.id, x]));
  return route.evidence_refs.map((id) => byId.get(id)).filter(Boolean).map((ev) => ({
    id: ev.id, class: ev.class, artifact: ev.artifact, internal_path: ev.internal_path ?? null,
  }));
}

function normalize({ graph, route, evidenceIndex, sourceName, environment='prod' }) {
  if (route.time_scope !== 'current' || route.status !== 'qualified') fail('qualified current route is required');
  if (!String(route.route_uri_literal ?? '').startsWith('dpmq://')) fail('only qualified dpmq route is supported by this adapter version');
  const entities = objectById(currentOnly(graph.entities ?? []));
  const edges = currentOnly(graph.edges ?? []);
  const completedAt = graph.generated_at || new Date().toISOString();
  const sourceId = sourceName || 'osi-integrated-mq-ace-datapower';
  const run = {
    run_id: `integrated:${sha256(`${sourceId}|${completedAt}|${route.id}`).slice(0,24)}`,
    environment,
    collector: 'osi-integrated-evidence-projection',
    collector_version: ADAPTER_VERSION,
    normalizer_version: SEMANTIC_NORMALIZER_VERSION,
    completed_at: completedAt,
    source: { kind: 'osi_integrated_projection', id: sourceId, display_name: 'OSI MQ + ACE + DataPower integrated projection' },
    metadata: {
      projection_profile: 'mq-ace-datapower/current-route-v1',
      route_id: route.id,
      excludes_historical: true,
      adapter_version: ADAPTER_VERSION,
      epistemic_policy: 'derived route facts remain configured evidence with explicit deterministic derivation metadata; runtime corroboration remains observed',
    },
  };
  const b = new Builder(run);
  const refByIntegratedId = new Map();

  // Current ACE integration nodes + their physical hosts.
  for (const ace of [...entities.values()].filter((x) => x.kind === 'ace_integration_node')) {
    const hostName = ace.attributes?.physical_host;
    const host = findRuntimeHostForAppliance(graph, hostName);
    if (!host) continue;
    let hostRef = refByIntegratedId.get(host.id);
    if (!hostRef) {
      hostRef = b.entity('infra.host', { name: host.name, primary_ip: host.attributes?.ip ?? undefined }, host.name, completedAt, 'observed', {
        evidence_ref: evidenceRef(host), status: host.status, properties: { ...host.attributes, evidence_refs: evidenceRefs(host) },
      });
      refByIntegratedId.set(host.id, hostRef);
    }
    const aceRef = b.entity('ace.integration_node', { canonical_key: ace.id, name: ace.name }, ace.name, completedAt, 'observed', {
      evidence_ref: evidenceRef(ace), status: ace.status, properties: { ...ace.attributes, integrated_entity_id: ace.id, evidence_refs: evidenceRefs(ace) },
    });
    refByIntegratedId.set(ace.id, aceRef);
    b.relation('runs_on', aceRef, hostRef, completedAt, 'observed', { evidence_ref: evidenceRef(ace), properties: { evidence_refs: evidenceRefs(ace) } });
  }

  // MQ route anchors deliberately use the same identity hints as the native MQ normalizer.
  const qmgrStep = route.steps.find((step) => entities.get(step.entity)?.kind === 'mq_queue_manager');
  const qmgr = entities.get(qmgrStep?.entity);
  const queueStep = route.steps.find((step) => entities.get(step.entity)?.kind === 'mq_queue');
  const queue = entities.get(queueStep?.entity) || [...entities.values()].find((x) => x.kind === 'mq_queue' && x.name === route.queue);
  if (!qmgr || !queue) fail('route queue-manager/queue anchors are missing');
  const qmgrRef = b.entity('mq.queue_manager', { name: qmgr.name }, qmgr.name, completedAt, 'configured', {
    evidence_ref: evidenceRef(qmgr), status: qmgr.status, properties: { ...qmgr.attributes, queue_manager: qmgr.name, integrated_entity_id: qmgr.id, evidence_refs: evidenceRefs(qmgr) },
  });
  const queueRef = b.entity('mq.queue', { queue_manager_key: qmgr.name, name: queue.name }, queue.name, completedAt, 'configured', {
    evidence_ref: evidenceRef(queue), status: queue.status, properties: { ...queue.attributes, queue_manager: qmgr.name, route_target: true, integrated_entity_id: queue.id, evidence_refs: evidenceRefs(queue) },
  });
  b.relation('contains', qmgrRef, queueRef, completedAt, 'configured', { evidence_ref: evidenceRef(queue), properties: { queue_manager: qmgr.name, evidence_refs: evidenceRefs(queue) } });

  const runtimeEdges = edges.filter((x) => route.runtime_corroboration_edges.includes(x.id));
  if (!runtimeEdges.length) fail('runtime corroboration is required');
  const commonChannelName = runtimeEdges.flatMap((x) => x.attributes?.channels ?? []).find(Boolean) ?? null;
  const channel = [...entities.values()].find((x) => x.kind === 'mq_channel' && (!commonChannelName || x.name === commonChannelName)) ?? null;
  if (channel) {
    const channelRef = b.entity('mq.channel', { queue_manager_key: qmgr.name, name: channel.name }, channel.name, completedAt, 'configured', {
      evidence_ref: evidenceRef(channel), status: channel.status, properties: { queue_manager: qmgr.name, integrated_entity_id: channel.id, evidence_refs: evidenceRefs(channel) },
    });
    b.relation('contains', qmgrRef, channelRef, completedAt, 'configured', { evidence_ref: evidenceRef(channel), properties: { queue_manager: qmgr.name } });
  }

  const routeServiceId = route.steps.find((s) => entities.get(s.entity)?.kind === 'datapower_service')?.entity;
  const routeService = entities.get(routeServiceId);
  const routeHandler = entities.get(route.steps.find((s) => entities.get(s.entity)?.kind === 'datapower_front_handler')?.entity);
  const routeDomain = entities.get(route.steps.find((s) => entities.get(s.entity)?.kind === 'datapower_domain')?.entity);
  const routeResource = entities.get(route.steps.find((s) => entities.get(s.entity)?.kind === 'static_route_resource')?.entity);
  const routeGroup = entities.get(route.steps.find((s) => entities.get(s.entity)?.kind === 'datapower_mq_manager_group')?.entity);
  if (!routeService || !routeHandler || !routeDomain || !routeResource || !routeGroup) fail('qualified DataPower route components are incomplete');

  const routeEvidence = routeEvidenceDetails(route, evidenceIndex);
  const routeChain = route.steps.map((step) => ({ entity_id: step.entity, label: step.label, epistemic: step.epistemic }));

  // One logical route service per appliance. This respects the existing registry's appliance/domain/service identity rules.
  for (const runtimeEdge of runtimeEdges) {
    const host = entities.get(runtimeEdge.source);
    if (!host || host.kind !== 'physical_host') continue;
    const runtime = [...entities.values()].find((x) => x.kind === 'datapower_runtime' && x.attributes?.management_endpoint && x.id.endsWith(`:${host.name}`));
    if (!runtime) fail(`DataPower runtime missing for ${host.name}`);
    const hostRef = b.entity('infra.host', { name: host.name, primary_ip: host.attributes?.ip ?? runtimeEdge.attributes?.client_ip }, host.name, completedAt, 'observed', {
      evidence_ref: evidenceRef(host), status: host.status, properties: { ...host.attributes, evidence_refs: evidenceRefs(host) },
    });
    const applianceKey = `datapower:${host.name}`;
    const applianceRef = b.entity('datapower.appliance', { canonical_key: applianceKey, name: host.name }, `DataPower ${host.name}`, completedAt, 'observed', {
      evidence_ref: evidenceRef(runtime), status: runtime.status, properties: { ...runtime.attributes, physical_host: host.name, integrated_entity_id: runtime.id, evidence_refs: evidenceRefs(runtime) },
    });
    b.relation('runs_on', applianceRef, hostRef, completedAt, 'observed', { evidence_ref: evidenceRef(runtime), properties: { physical_host: host.name } });

    const domainKey = `${applianceKey}|${routeDomain.name}`;
    b.entity('datapower.domain', { appliance_key: applianceKey, name: routeDomain.name }, routeDomain.name, completedAt, 'configured', {
      evidence_ref: evidenceRef(routeDomain), status: routeDomain.status, properties: { appliance_key: applianceKey, physical_host: host.name, integrated_entity_id: routeDomain.id, evidence_refs: evidenceRefs(routeDomain) },
    });
    const serviceKey = `${domainKey}|${routeService.name}`;
    const serviceRef = b.entity('datapower.service', { domain_key: domainKey, name: routeService.name }, routeService.name, completedAt, 'configured', {
      evidence_ref: evidenceRef(routeService), status: routeService.status,
      properties: {
        domain: routeDomain.name, domain_key: domainKey, appliance_key: applianceKey, physical_host: host.name,
        frontend_handler: routeHandler.name, frontend_address: routeHandler.attributes?.local_address ?? null, frontend_port: routeHandler.attributes?.local_port ?? null,
        backend_group: routeGroup.name, integrated_entity_id: routeService.id, evidence_refs: evidenceRefs(routeService),
      },
    });
    const backendRef = b.entity('datapower.backend_endpoint', { service_key: serviceKey, name: routeGroup.name }, routeGroup.name, completedAt, 'configured', {
      evidence_ref: evidenceRef(routeGroup), status: routeGroup.status,
      properties: { service_key: serviceKey, queue_manager: qmgr.name, channel: channel?.name ?? null, physical_host: host.name, evidence_refs: evidenceRefs(routeGroup) },
    });

    const routeProps = {
      qualified_route: true,
      epistemic: 'derived',
      derivation_method: 'deterministic_static_route_projection',
      deterministic: true,
      route_id: route.id,
      route_uri_literal: route.route_uri_literal,
      queue_manager: qmgr.name,
      queue: queue.name,
      backend_group: routeGroup.name,
      channel: channel?.name ?? null,
      static_resource: routeResource.attributes?.resource_path ?? routeResource.name,
      static_resource_sha256: routeResource.attributes?.sha256_by_node?.[host.name] ?? null,
      qualified_route_chain: routeChain,
      evidence_refs: route.evidence_refs,
      evidence_details: routeEvidence,
      runtime_corroboration: [{
        physical_host: host.name,
        client_ip: runtimeEdge.attributes?.client_ip ?? host.attributes?.ip ?? null,
        application_tags: runtimeEdge.attributes?.application_tags ?? [],
        channels: runtimeEdge.attributes?.channels ?? [],
        sample_connection_count: runtimeEdge.attributes?.sample_connection_count ?? null,
        evidence_refs: evidenceRefs(runtimeEdge),
      }],
      semantic_warning: 'Configured/static DataPower route evidence does not prove a specific message traversal. MQ runtime evidence independently corroborates DataPower client connectivity to the target queue manager.',
    };
    b.relation('integration.routes_to', serviceRef, queueRef, completedAt, 'configured', {
      evidence_ref: evidenceRef(routeResource), properties: routeProps,
      derivation_method: 'deterministic_static_route_projection', deterministic: true, confidence: 1.0,
    });
    b.relation('network.connects_to', backendRef, qmgrRef, completedAt, 'configured', {
      evidence_ref: evidenceRef(routeGroup), properties: { queue_manager: qmgr.name, backend_group: routeGroup.name, channel: channel?.name ?? null, evidence_refs: evidenceRefs(routeGroup) },
    });
    b.relation('network.connects_to', backendRef, qmgrRef, completedAt, 'observed', {
      evidence_ref: evidenceRef(runtimeEdge), properties: {
        queue_manager: qmgr.name, backend_group: routeGroup.name, client_ip: runtimeEdge.attributes?.client_ip ?? null,
        application_tags: runtimeEdge.attributes?.application_tags ?? [], channels: runtimeEdge.attributes?.channels ?? [],
        evidence_refs: evidenceRefs(runtimeEdge), runtime_corroboration: true,
      },
    });
  }

  b.coverage('projection', sourceId, 'ace.integration_node', 'point_in_time', { properties: { historical_excluded: true } });
  b.coverage('projection', sourceId, 'datapower.service', 'complete', { evidence_ref: evidenceRef(routeService), properties: { qualified_route_id: route.id } });
  b.coverage('projection', sourceId, 'relation:integration.routes_to', 'complete', { evidence_ref: evidenceRef(routeResource), properties: { qualified_route_id: route.id, deterministic: true } });
  b.coverage('projection', sourceId, 'relation:network.connects_to', 'point_in_time', { properties: { runtime_corroboration_count: runtimeEdges.length } });
  return b.finish();
}

const args = parseArgs(process.argv);
const [graphRaw, routeRaw, evidenceRaw] = await Promise.all([readFile(args.graph,'utf8'), readFile(args.route,'utf8'), readFile(args.evidence,'utf8')]);
const graph = JSON.parse(graphRaw), route = JSON.parse(routeRaw), evidenceIndex = JSON.parse(evidenceRaw);
const bundle = normalize({ graph, route, evidenceIndex, sourceName: args['source-id'], environment: args.environment || 'prod' });
await writeFile(args.output, JSON.stringify(bundle, null, 2) + '\n');
console.log(JSON.stringify({ output: args.output, run_id: bundle.run.run_id, counts: { coverage: bundle.coverage.length, entities: bundle.entities.length, relations: bundle.relations.length, unresolved: bundle.unresolved_references.length } }, null, 2));