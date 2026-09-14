#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const INPUT_SCHEMA = 'osi.ftp.projection/v1';
const OUTPUT_SCHEMA = 'osi.observation.bundle/v2';
const ADAPTER_VERSION = '0.2.0';
const NORMALIZER_VERSION = '3.1.0';
const IMPORT_COVERAGE_MODES = new Set(['complete', 'point_in_time', 'partial', 'failed', 'not_collected']);
const FORBIDDEN_INPUT_KEY = /(password|passwd|secret|token|credential|private[_-]?key|certificate[_-]?content|service[_-]?account|command[_-]?line)/i;

function fail(message) { throw new Error(message); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function stableRef(prefix, ...parts) { return `${prefix}_${sha256(parts.join('|')).slice(0, 20)}`; }
function cleanObject(value) { return Object.fromEntries(Object.entries(value ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== '')); }

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}
function stableStringify(value) { return JSON.stringify(canonicalize(value)); }
function sortByKey(items) { return [...items].sort((a, b) => String(a?.key ?? '').localeCompare(String(b?.key ?? ''))); }

function assertSafeInput(value, path='root') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeInput(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_INPUT_KEY.test(key)) fail(`forbidden sensitive input key at ${path}.${key}`);
    assertSafeInput(child, `${path}.${key}`);
  }
}

class Builder {
  constructor(run) {
    this.bundle = { schema_version: OUTPUT_SCHEMA, run, coverage: [], entities: [], relations: [], unresolved_references: [] };
    this.entityByKey = new Map();
    this.entityType = new Map();
  }
  entity(semanticType, hints, displayName, observedAt, evidenceClass, { evidenceRef=null, status=null, properties={} }={}) {
    const cleanHints = cleanObject(hints);
    const key = stableStringify([semanticType, cleanHints, evidenceClass, evidenceRef]);
    if (this.entityByKey.has(key)) return this.entityByKey.get(key);
    const ref = stableRef('ent', key);
    const item = {
      ref,
      semantic_type: semanticType,
      identity: { hints: cleanHints },
      display_name: displayName,
      observed_at: observedAt,
      evidence_class: evidenceClass,
      properties,
    };
    if (status) item.status = status;
    if (evidenceRef) item.evidence_ref = evidenceRef;
    this.bundle.entities.push(item);
    this.entityByKey.set(key, ref);
    this.entityType.set(ref, semanticType);
    return ref;
  }
  relation(semanticType, sourceRef, targetRef, observedAt, evidenceClass, { evidenceRef=null, properties={} }={}) {
    if (!this.entityType.has(sourceRef) || !this.entityType.has(targetRef)) fail(`relation endpoint missing: ${semanticType}`);
    const ref = stableRef('rel', semanticType, sourceRef, targetRef, evidenceClass, evidenceRef ?? '');
    const item = {
      ref,
      semantic_type: semanticType,
      source_ref: sourceRef,
      target_ref: targetRef,
      observed_at: observedAt,
      evidence_class: evidenceClass,
      properties,
    };
    if (evidenceRef) item.evidence_ref = evidenceRef;
    this.bundle.relations.push(item);
    return ref;
  }
  unresolved(sourceRef, semanticType, state, evidenceClass, properties={}) {
    if (!this.entityType.has(sourceRef)) fail(`unresolved source endpoint missing: ${semanticType}`);
    const ref = stableRef('unr', sourceRef, semanticType, state, stableStringify(properties));
    this.bundle.unresolved_references.push({
      ref,
      source_ref: sourceRef,
      semantic_type: semanticType,
      state,
      evidence_class: evidenceClass,
      properties,
    });
    return ref;
  }
  coverage(objectClass, mode, properties={}, evidenceRef=null) {
    if (!IMPORT_COVERAGE_MODES.has(mode)) fail(`unsupported import coverage mode: ${mode}`);
    const item = {
      scope_type: 'projection',
      scope_key: this.bundle.run.source.id,
      object_class: objectClass,
      mode,
      properties,
    };
    if (evidenceRef) item.evidence_ref = evidenceRef;
    this.bundle.coverage.push(item);
  }
  finish() {
    this.bundle.coverage.sort((a,b)=>`${a.object_class}|${a.mode}`.localeCompare(`${b.object_class}|${b.mode}`));
    this.bundle.entities.sort((a,b)=>`${a.semantic_type}|${a.display_name}|${a.ref}`.localeCompare(`${b.semantic_type}|${b.display_name}|${b.ref}`));
    this.bundle.relations.sort((a,b)=>`${a.semantic_type}|${a.source_ref}|${a.target_ref}|${a.ref}`.localeCompare(`${b.semantic_type}|${b.source_ref}|${b.target_ref}|${b.ref}`));
    this.bundle.unresolved_references.sort((a,b)=>`${a.semantic_type}|${a.source_ref}|${a.ref}`.localeCompare(`${b.semantic_type}|${b.source_ref}|${b.ref}`));
    return this.bundle;
  }
}

function requireArray(input, name) {
  if (!Array.isArray(input[name])) fail(`${name} must be an array`);
  return input[name];
}
function byKey(items, name) {
  const map = new Map();
  for (const item of items) {
    if (!item?.key) fail(`${name} item key is required`);
    if (map.has(item.key)) fail(`duplicate ${name} key: ${item.key}`);
    map.set(item.key, item);
  }
  return map;
}
function requireEvidence(item, label) {
  if (!item?.evidence_ref || typeof item.evidence_ref !== 'string') fail(`${label} evidence_ref is required`);
  return item.evidence_ref;
}
function requireCurrentObserved(item, label) {
  if (item?.time_scope !== 'current') fail(`${label} must set time_scope=current`);
  if (item?.evidence_class !== 'observed') fail(`${label} must use evidence_class=observed`);
}
function requireHistoricalObserved(item, label) {
  if (item?.time_scope !== 'historical') fail(`${label} must set time_scope=historical`);
  if (item?.evidence_class !== 'observed') fail(`${label} must use evidence_class=observed`);
}
function requirePort(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) fail(`${label} must be an integer TCP port 1-65535`);
}

export function normalizeProjection(input, { sourceId=null, environment=null }={}) {
  if (!input || input.schema_version !== INPUT_SCHEMA) fail(`expected ${INPUT_SCHEMA}`);
  assertSafeInput(input);

  const generatedAt = input.generated_at;
  if (!generatedAt || Number.isNaN(Date.parse(generatedAt))) fail('generated_at must be an ISO timestamp');
  const source = sourceId || input.source_id || 'osi-ftp-evidence';
  const env = environment || input.environment || 'prod';

  const hosts = requireArray(input, 'hosts');
  const servers = requireArray(input, 'servers');
  const sites = requireArray(input, 'sites');
  const routes = requireArray(input, 'routes');
  const storagePaths = requireArray(input, 'storage_paths');
  const mftAgents = requireArray(input, 'mft_agents');
  const gaps = Array.isArray(input.gaps) ? input.gaps : [];

  const hostByKey = byKey(hosts, 'host');
  const serverByKey = byKey(servers, 'server');
  const siteByKey = byKey(sites, 'site');
  byKey(routes, 'route');
  byKey(storagePaths, 'storage path');
  byKey(mftAgents, 'MFT agent');

  const runFingerprint = stableStringify({
    adapterVersion: ADAPTER_VERSION,
    normalizerVersion: NORMALIZER_VERSION,
    source,
    environment: env,
    generatedAt,
    hosts: sortByKey(hosts),
    servers: sortByKey(servers),
    sites: sortByKey(sites),
    routes: sortByKey(routes),
    storagePaths: sortByKey(storagePaths),
    mftAgents: sortByKey(mftAgents),
    gaps: sortByKey(gaps),
  });
  const run = {
    run_id: `ftp:${sha256(runFingerprint).slice(0,24)}`,
    environment: env,
    collector: 'osi-ftp-evidence-projection',
    collector_version: ADAPTER_VERSION,
    normalizer_version: NORMALIZER_VERSION,
    completed_at: generatedAt,
    source: { kind: 'osi_ftp_projection', id: source, display_name: 'OSI EFT + DMZ Gateway + MQ MFT projection' },
    metadata: {
      projection_profile: 'eft-dmz-mft/current-topology-v2',
      adapter_version: ADAPTER_VERSION,
      historical_logs_promoted_to_runtime: false,
      epistemic_policy: 'current Site/listener/PNC observations may be composed with historical Site-access evidence only as an inferred topology route; completed file transfer remains unproven',
    },
  };
  const b = new Builder(run);

  const hostRefs = new Map();
  for (const host of hosts) {
    requireCurrentObserved(host, `host ${host.key}`);
    const evidenceRef = requireEvidence(host, `host ${host.key}`);
    const ref = b.entity('infra.host', {
      fqdn: host.fqdn,
      primary_ip: host.primary_ip,
      name: host.name,
    }, host.name, generatedAt, 'observed', {
      evidenceRef,
      status: host.status ?? 'current',
      properties: cleanObject({ os: host.os, role: host.role, source_key: host.key }),
    });
    hostRefs.set(host.key, ref);
  }

  const serverRefs = new Map();
  for (const server of servers) {
    requireCurrentObserved(server, `server ${server.key}`);
    const evidenceRef = requireEvidence(server, `server ${server.key}`);
    const host = hostByKey.get(server.host_key);
    if (!host) fail(`server ${server.key} references unknown host ${server.host_key}`);
    const hostRef = hostRefs.get(server.host_key);
    const ref = b.entity('filetransfer.server', {
      canonical_key: server.key,
      name: server.name,
    }, server.name, generatedAt, 'observed', {
      evidenceRef,
      status: server.status ?? 'running',
      properties: cleanObject({
        product: server.product,
        version: server.version,
        role: server.role,
        physical_host: host.name,
        data_root: server.data_root,
        source_key: server.key,
      }),
    });
    b.relation('runs_on', ref, hostRef, generatedAt, 'observed', {
      evidenceRef,
      properties: { placement: 'current' },
    });
    serverRefs.set(server.key, ref);
  }

  const siteRefs = new Map();
  for (const site of sites) {
    requireCurrentObserved(site, `site ${site.key}`);
    const evidenceRef = requireEvidence(site, `site ${site.key}`);
    const server = serverByKey.get(site.server_key);
    if (!server) fail(`site ${site.key} references unknown server ${site.server_key}`);
    if (server.role !== 'eft_backend') fail(`site ${site.key} must reference an EFT backend server`);
    const ref = b.entity('filetransfer.endpoint', {
      server_key: site.server_key,
      name: site.name,
    }, site.name, generatedAt, 'observed', {
      evidenceRef,
      status: site.status ?? 'started',
      properties: {
        endpoint_kind: 'eft_site',
        server_key: site.server_key,
        site_name: site.name,
        site_started: site.status !== 'stopped',
        runtime_sample: site.runtime_sample ?? {},
        listener_resolution: site.listener_resolution ?? 'unresolved',
        historical_context: site.historical_context ?? {},
      },
    });
    siteRefs.set(site.key, ref);
  }

  const networkEndpointRefs = new Map();
  const fileEndpointRefs = new Map();
  function ensureGatewayEndpoint({ serverKey, name, host, port, endpointKind, evidenceRef }) {
    const server = serverByKey.get(serverKey);
    const serverRef = serverRefs.get(serverKey);
    if (!server || !serverRef) fail(`gateway endpoint references unknown server ${serverKey}`);
    if (server.role !== 'dmz_gateway') fail(`gateway endpoint server ${serverKey} must have role=dmz_gateway`);
    const cacheKey = `${serverKey}|${name}|${host}|${port}`;
    if (fileEndpointRefs.has(cacheKey)) return {
      fileRef: fileEndpointRefs.get(cacheKey),
      networkRef: networkEndpointRefs.get(`${host}|${port}`),
    };
    const fileRef = b.entity('filetransfer.endpoint', {
      server_key: serverKey,
      name,
    }, name, generatedAt, 'observed', {
      evidenceRef,
      properties: { endpoint_kind: endpointKind, host, port },
    });
    const networkKey = `${host}|${port}`;
    let networkRef = networkEndpointRefs.get(networkKey);
    if (!networkRef) {
      networkRef = b.entity('infra.network_endpoint', { host, port }, `${host}:${port}`, generatedAt, 'observed', {
        evidenceRef,
        properties: { host, port },
      });
      networkEndpointRefs.set(networkKey, networkRef);
      b.relation('network.endpoint_for', networkRef, serverRef, generatedAt, 'observed', {
        evidenceRef,
        properties: { endpoint_kind: endpointKind },
      });
    }
    b.relation('network.listens_on', fileRef, networkRef, generatedAt, 'observed', {
      evidenceRef,
      properties: { endpoint_kind: endpointKind },
    });
    fileEndpointRefs.set(cacheKey, fileRef);
    return { fileRef, networkRef };
  }

  const resolvedSiteKeys = new Set();
  for (const route of routes) {
    const site = siteByKey.get(route.site_key);
    if (!site) fail(`route ${route.key} references unknown site ${route.site_key}`);
    const gateway = serverByKey.get(route.gateway_server_key);
    if (!gateway) fail(`route ${route.key} references unknown gateway ${route.gateway_server_key}`);
    if (gateway.role !== 'dmz_gateway') fail(`route ${route.key} gateway must have role=dmz_gateway`);

    requireCurrentObserved(route.listener, `route ${route.key} listener`);
    const listenerEvidenceRef = requireEvidence(route.listener, `route ${route.key} listener`);
    if (!route.listener?.host) fail(`route ${route.key} listener host is required`);
    requirePort(route.listener?.port, `route ${route.key} listener port`);

    requireHistoricalObserved(route.site_access, `route ${route.key} Site access`);
    const siteAccessEvidenceRef = requireEvidence(route.site_access, `route ${route.key} Site access`);

    requireCurrentObserved(route.pnc, `route ${route.key} PNC`);
    const pncEvidenceRef = requireEvidence(route.pnc, `route ${route.key} PNC`);
    if (!route.pnc?.host) fail(`route ${route.key} PNC host is required`);
    requirePort(route.pnc?.port, `route ${route.key} PNC port`);
    if (route.pnc.independently_corroborated !== true) fail(`route ${route.key} requires independently corroborated PNC connectivity`);

    const listener = ensureGatewayEndpoint({
      serverKey: route.gateway_server_key,
      name: `${site.name} listener`,
      host: route.listener.host,
      port: route.listener.port,
      endpointKind: 'client_listener',
      evidenceRef: listenerEvidenceRef,
    });
    const pnc = ensureGatewayEndpoint({
      serverKey: route.gateway_server_key,
      name: `PNC ${route.pnc.host}:${route.pnc.port}`,
      host: route.pnc.host,
      port: route.pnc.port,
      endpointKind: 'peer_notification_channel',
      evidenceRef: pncEvidenceRef,
    });

    const evidenceRefs = [
      listenerEvidenceRef,
      siteAccessEvidenceRef,
      pncEvidenceRef,
      site.evidence_ref,
    ];
    const flowRef = b.entity('filetransfer.flow', {
      canonical_key: route.key,
      name: route.name,
    }, route.name, generatedAt, 'inferred', {
      evidenceRef: siteAccessEvidenceRef,
      status: route.status ?? 'qualified',
      properties: {
        flow_kind: 'eft_inbound_site_path',
        site_name: site.name,
        gateway_server_key: route.gateway_server_key,
        listener: `${route.listener.host}:${route.listener.port}`,
        site_access_time_scope: 'historical',
        activity_window_start: route.site_access.activity_window_start ?? null,
        activity_window_end: route.site_access.activity_window_end ?? null,
        granted_access_records: Number(route.site_access.granted_access_records ?? 0),
        denied_access_records: Number(route.site_access.denied_access_records ?? 0),
        evidence_refs: evidenceRefs,
        runtime_transfer_completion: false,
      },
    });
    b.relation('network.connects_to', flowRef, listener.fileRef, generatedAt, 'inferred', {
      evidenceRef: siteAccessEvidenceRef,
      properties: {
        role: 'client_ingress_topology',
        site_name: site.name,
        epistemic: 'inferred',
        evidence_refs: evidenceRefs,
      },
    });
    b.relation('integration.routes_to', flowRef, siteRefs.get(route.site_key), generatedAt, 'inferred', {
      evidenceRef: siteAccessEvidenceRef,
      properties: {
        qualified_route: true,
        epistemic: 'inferred',
        route_kind: 'eft_inbound_site_path',
        deterministic: true,
        site_access_evidence: {
          time_scope: 'historical',
          evidence_class: 'observed',
          evidence_ref: siteAccessEvidenceRef,
          activity_window_start: route.site_access.activity_window_start ?? null,
          activity_window_end: route.site_access.activity_window_end ?? null,
        },
        runtime_corroboration: [{
          kind: 'eft_dmz_pnc',
          time_scope: 'current',
          evidence_class: 'observed',
          gateway_server_key: route.gateway_server_key,
          endpoint: `${route.pnc.host}:${route.pnc.port}`,
          independently_corroborated: true,
          evidence_ref: pncEvidenceRef,
        }],
        current_listener_evidence: {
          time_scope: 'current',
          evidence_class: 'observed',
          endpoint: `${route.listener.host}:${route.listener.port}`,
          evidence_ref: listenerEvidenceRef,
        },
        evidence_refs: evidenceRefs,
        runtime_transfer_completion: false,
        semantic_warning: 'This is an inferred topology route composed from historical Site-access evidence plus current listener and independently corroborated PNC observations. It is not current Site traversal or completed file transfer proof.',
      },
    });

    const pncFlow = b.entity('filetransfer.flow', {
      canonical_key: `${route.key}:pnc`,
      name: `${site.name} PNC bridge`,
    }, `${site.name} PNC bridge`, generatedAt, 'observed', {
      evidenceRef: pncEvidenceRef,
      status: 'connected',
      properties: {
        flow_kind: 'eft_dmz_pnc',
        target_gateway_server_key: route.gateway_server_key,
        runtime_transfer_completion: false,
      },
    });
    b.relation('network.connects_to', pncFlow, pnc.networkRef, generatedAt, 'observed', {
      evidenceRef: pncEvidenceRef,
      properties: {
        role: 'peer_notification_channel',
        independently_corroborated: true,
        runtime_transfer_completion: false,
      },
    });
    resolvedSiteKeys.add(route.site_key);
  }

  for (const path of storagePaths) {
    requireCurrentObserved(path, `storage path ${path.key}`);
    const evidenceRef = requireEvidence(path, `storage path ${path.key}`);
    if (!serverByKey.has(path.server_key)) fail(`storage path ${path.key} references unknown server ${path.server_key}`);
    b.entity('filetransfer.endpoint', {
      server_key: path.server_key,
      name: path.path,
    }, path.path, generatedAt, 'observed', {
      evidenceRef,
      properties: {
        endpoint_kind: 'filesystem_path',
        path: path.path,
        exists: path.exists === true,
        backing_volume: path.backing_volume ?? null,
        backing_filesystem: path.backing_filesystem ?? null,
        provider_name: path.provider_name ?? null,
        nfs_relationship: path.nfs_relationship ?? 'unresolved',
        contents_enumerated: false,
      },
    });
  }

  const mftAgentRefs = [];
  for (const agent of mftAgents) {
    requireCurrentObserved(agent, `MFT agent ${agent.key}`);
    const evidenceRef = requireEvidence(agent, `MFT agent ${agent.key}`);
    if (!hostRefs.has(agent.host_key)) fail(`MFT agent ${agent.key} references unknown host ${agent.host_key}`);
    if (!agent.agent_queue_manager || !agent.coordination_queue_manager) fail(`MFT agent ${agent.key} queue-manager identities are required`);
    const appRef = b.entity('app.application_instance', {
      host_key: agent.host_key,
      name: agent.name,
    }, agent.name, generatedAt, 'observed', {
      evidenceRef,
      status: agent.status ?? 'running',
      properties: {
        component_class: 'ibm_mq_mft_agent',
        agent_name: agent.name,
        agent_queue_manager: agent.agent_queue_manager,
        coordination_queue_manager: agent.coordination_queue_manager,
        service_name: agent.service_name ?? null,
        transfer_completion_proven: false,
        command_line_collected: false,
      },
    });
    b.relation('runs_on', appRef, hostRefs.get(agent.host_key), generatedAt, 'observed', {
      evidenceRef,
      properties: { component_class: 'ibm_mq_mft_agent' },
    });

    for (const [role, qmgrName] of [
      ['agent_queue_manager', agent.agent_queue_manager],
      ['coordination_queue_manager', agent.coordination_queue_manager],
    ]) {
      const qmgrRef = b.entity('mq.queue_manager', { name: qmgrName }, qmgrName, generatedAt, 'configured', {
        evidenceRef,
        properties: { anchor_role: `mft_${role}`, evidence_source: 'MFT agent configuration' },
      });
      b.relation('network.connects_to', appRef, qmgrRef, generatedAt, 'configured', {
        evidenceRef,
        properties: {
          dependency_role: role,
          network_endpoint_observed: false,
          semantic_warning: 'Logical MFT configuration association; host/port/channel connectivity and completed transfer are not proven by this relation.',
        },
      });
    }
    mftAgentRefs.push(appRef);
  }

  const unresolvedSites = sites.filter(site => !resolvedSiteKeys.has(site.key));
  for (const site of unresolvedSites) {
    const siteRef = siteRefs.get(site.key);
    b.unresolved(siteRef, 'filetransfer.endpoint', 'unresolved', 'observed', {
      unresolved_kind: 'site_listener_mapping',
      site_name: site.name,
      reason: gaps.find(g => g.site_key === site.key)?.reason ?? 'No current listener/gateway mapping is supported by the supplied evidence.',
    });
  }

  b.coverage('filetransfer.server', 'point_in_time', {
    eft_server_count: servers.filter(x=>x.role==='eft_backend').length,
    dmz_gateway_count: servers.filter(x=>x.role==='dmz_gateway').length,
  });
  b.coverage('filetransfer.endpoint', unresolvedSites.length ? 'partial' : 'point_in_time', {
    eft_site_count: sites.length,
    qualified_site_path_count: resolvedSiteKeys.size,
    unresolved_site_listener_routes: unresolvedSites.map(site=>site.name),
  });
  b.coverage('filetransfer.flow', 'partial', {
    qualified_inbound_path_count: routes.length,
    route_epistemic: 'inferred',
    historical_event_logs_promoted_to_runtime: false,
  });
  b.coverage('app.application_instance', 'point_in_time', {
    mq_mft_agent_count: mftAgentRefs.length,
    transfer_completion_proven: false,
  });
  b.coverage('filetransfer.storage', 'point_in_time', {
    path_count: storagePaths.length,
    nfs_inference_forbidden: true,
  });
  if (gaps.length) b.coverage('filetransfer.coverage_gap', 'partial', {
    gaps: gaps.map(g=>({ key:g.key, state:g.state ?? 'unknown', reason:g.reason })),
  });

  const bundle = b.finish();
  validateBundle(bundle);
  return bundle;
}

export function validateBundle(bundle) {
  const supportedTypes = new Set(['infra.host','infra.network_endpoint','filetransfer.server','filetransfer.endpoint','filetransfer.flow','app.application_instance','mq.queue_manager']);
  const evidenceClasses = new Set(['observed','configured','declared','inferred']);
  const unresolvedStates = new Set(['unresolved','ambiguous','dynamic','stale','conflicted','resolved']);
  const relationRules = new Map([
    ['runs_on', [new Set(['filetransfer.server','app.application_instance']), new Set(['infra.host'])]],
    ['network.listens_on', [new Set(['filetransfer.endpoint']), new Set(['infra.network_endpoint'])]],
    ['network.endpoint_for', [new Set(['infra.network_endpoint']), new Set(['filetransfer.server'])]],
    ['network.connects_to', [new Set(['filetransfer.flow','app.application_instance']), new Set(['filetransfer.endpoint','infra.network_endpoint','mq.queue_manager'])]],
    ['integration.routes_to', [new Set(['filetransfer.flow']), new Set(['filetransfer.endpoint'])]],
  ]);
  const refs = new Map(bundle.entities.map(entity=>[entity.ref,entity]));
  if (refs.size !== bundle.entities.length) fail('duplicate entity refs');
  for (const coverage of bundle.coverage) {
    if (!IMPORT_COVERAGE_MODES.has(coverage.mode)) fail(`unsupported coverage mode ${coverage.mode}`);
  }
  for (const entity of bundle.entities) {
    if (!supportedTypes.has(entity.semantic_type)) fail(`unsupported entity type ${entity.semantic_type}`);
    if (!evidenceClasses.has(entity.evidence_class)) fail(`unsupported entity evidence class ${entity.evidence_class}`);
  }
  for (const relation of bundle.relations) {
    const source = refs.get(relation.source_ref);
    const target = refs.get(relation.target_ref);
    if (!source || !target) fail(`missing relation endpoint ${relation.ref}`);
    if (!evidenceClasses.has(relation.evidence_class)) fail(`unsupported relation evidence class ${relation.evidence_class}`);
    const rule = relationRules.get(relation.semantic_type);
    if (!rule) fail(`unsupported relation ${relation.semantic_type}`);
    if (!rule[0].has(source.semantic_type) || !rule[1].has(target.semantic_type)) {
      fail(`illegal relation ${relation.semantic_type}: ${source.semantic_type} -> ${target.semantic_type}`);
    }
    if (relation.semantic_type === 'integration.routes_to') {
      if (relation.evidence_class !== 'inferred') fail('FTP qualified topology route must remain inferred evidence');
      if (relation.properties?.qualified_route !== true) fail('FTP route must set qualified_route=true');
      if (relation.properties?.epistemic !== 'inferred') fail('FTP route epistemic must be inferred');
      if (relation.properties?.runtime_transfer_completion !== false) fail('FTP Site path must not be promoted to transfer completion');
      if (relation.properties?.site_access_evidence?.time_scope !== 'historical') fail('FTP route must preserve historical Site-access time scope');
      if (relation.properties?.site_access_evidence?.evidence_class !== 'observed') fail('FTP Site-access component must remain observed evidence');
      if (!Array.isArray(relation.properties?.runtime_corroboration) || relation.properties.runtime_corroboration.length !== 1) fail('FTP route requires one PNC runtime corroboration record');
      const corroboration = relation.properties.runtime_corroboration[0];
      if (corroboration?.time_scope !== 'current' || corroboration?.evidence_class !== 'observed' || corroboration?.independently_corroborated !== true) {
        fail('FTP PNC corroboration must remain current observed independently corroborated evidence');
      }
      if (relation.properties?.current_listener_evidence?.time_scope !== 'current' || relation.properties?.current_listener_evidence?.evidence_class !== 'observed') {
        fail('FTP listener component must remain current observed evidence');
      }
    }
  }
  for (const unresolved of bundle.unresolved_references) {
    if (!refs.has(unresolved.source_ref)) fail(`unresolved source missing ${unresolved.ref}`);
    if (!unresolvedStates.has(unresolved.state)) fail(`unsupported unresolved state ${unresolved.state}`);
    if (unresolved.evidence_class && !evidenceClasses.has(unresolved.evidence_class)) fail(`unsupported unresolved evidence class ${unresolved.evidence_class}`);
  }
  const serialized = JSON.stringify(bundle).toLowerCase();
  for (const token of ['password','passwd','mftcredentials.xml','command_line":"','service_account']) {
    if (serialized.includes(token)) fail(`disallowed sensitive material in bundle: ${token}`);
  }
  return true;
}

function parseArgs(argv) {
  const args={};
  for (let i=2;i<argv.length;i++) {
    const key=argv[i];
    if (!key.startsWith('--')) fail(`unexpected argument: ${key}`);
    const value=argv[++i];
    if (!value) fail(`missing value for ${key}`);
    args[key.slice(2)] = value;
  }
  if (!args.input || !args.output) fail('--input and --output are required');
  return args;
}

async function main() {
  const args=parseArgs(process.argv);
  const input=JSON.parse(await readFile(args.input,'utf8'));
  const bundle=normalizeProjection(input,{sourceId:args['source-id']??null,environment:args.environment??null});
  await writeFile(args.output,JSON.stringify(bundle,null,2)+'\n','utf8');
  console.log(JSON.stringify({
    output: args.output,
    run_id: bundle.run.run_id,
    entities: bundle.entities.length,
    relations: bundle.relations.length,
    unresolved: bundle.unresolved_references.length,
    coverage: bundle.coverage.length,
  },null,2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error)=>{ console.error(error.stack || String(error)); process.exit(1); });
}
