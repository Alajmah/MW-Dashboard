from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, got {count}")
    return text.replace(old, new, 1)


normalizer = Path('scripts/normalize-ftp-evidence.mjs')
s = normalizer.read_text()

s = replace_once(s, "const ADAPTER_VERSION = '0.3.0';", "const ADAPTER_VERSION = '0.4.0';", 'adapter version')
s = replace_once(
    s,
    "function requireEvidence(item, label) {\n  if (!item?.evidence_ref || typeof item.evidence_ref !== 'string') fail(`${label} evidence_ref is required`);\n  return item.evidence_ref;\n}\n",
    "function requireEvidence(item, label) {\n  if (typeof item?.evidence_ref !== 'string' || !item.evidence_ref.trim()) fail(`${label} evidence_ref is required`);\n  return item.evidence_ref.trim();\n}\n",
    'evidence reference validation',
)
s = replace_once(
    s,
    "    const evidenceRef = requireEvidence(site, `site ${site.key}`);\n    const server = serverByKey.get(site.server_key);",
    "    const evidenceRef = requireEvidence(site, `site ${site.key}`);\n    if (!['started','stopped'].includes(site.status)) fail(`site ${site.key} status must be started or stopped`);\n    const server = serverByKey.get(site.server_key);",
    'site status validation',
)
s = replace_once(s, "      status: site.status ?? 'started',", "      status: site.status,", 'site status projection')
s = replace_once(s, "        site_started: site.status !== 'stopped',", "        site_started: site.status === 'started',", 'site started truth')
s = replace_once(s, "  for (const route of routes) {", "  for (const route of sortByKey(routes)) {", 'deterministic route processing')
s = replace_once(
    s,
    "    if (site.listener_resolution === 'unresolved') fail(`route ${route.key} cannot qualify Site ${site.name} while listener_resolution=unresolved`);",
    "    if (site.listener_resolution !== 'qualified-inferred') fail(`route ${route.key} cannot qualify Site ${site.name} unless listener_resolution=qualified-inferred`);",
    'qualified listener resolution guard',
)
s = replace_once(s, "      projection_profile: 'eft-dmz-mft/current-topology-v3',", "      projection_profile: 'eft-dmz-mft/current-topology-v4',", 'projection profile')
s = replace_once(
    s,
    "      epistemic_policy: 'current started-Site/listener observations may be composed with historical Site-access evidence only as an inferred topology route; PNC qualification requires provenance-bearing current runtime corroboration from at least two distinct source kinds; completed file transfer remains unproven',",
    "      epistemic_policy: 'current explicitly started Sites with listener_resolution=qualified-inferred may be composed with current listener observations and historical Site-access evidence only as an inferred topology route; PNC qualification requires provenance-bearing current runtime corroboration from at least two distinct source kinds; completed file transfer remains unproven',",
    'epistemic policy',
)
normalizer.write_text(s)


test_file = Path('scripts/test-ftp-observation-bundle.mjs')
t = test_file.read_text()
t = replace_once(t, "assert(first.run.collector_version === '0.3.0', 'wrong adapter version');", "assert(first.run.collector_version === '0.4.0', 'wrong adapter version');", 'test adapter version')
anchor = """const missingEvidenceClass = clone(fixture);\ndelete missingEvidenceClass.sites[0].evidence_class;\nassert(rejectedWith(missingEvidenceClass, /must use evidence_class=observed/), 'missing observed evidence class was silently promoted');\n\n"""
insert = anchor + """const blankEvidenceRef = clone(fixture);\nblankEvidenceRef.routes[0].listener.evidence_ref = '   ';\nassert(rejectedWith(blankEvidenceRef, /evidence_ref is required/), 'blank evidence reference was accepted');\n\nconst missingUnroutedSiteStatus = clone(fixture);\ndelete missingUnroutedSiteStatus.sites.find(x=>x.key==='site-internal-user').status;\nassert(rejectedWith(missingUnroutedSiteStatus, /status must be started or stopped/), 'missing Site status was promoted to started');\n\nconst unknownUnroutedSiteStatus = clone(fixture);\nunknownUnroutedSiteStatus.sites.find(x=>x.key==='site-internal-user').status = 'unknown';\nassert(rejectedWith(unknownUnroutedSiteStatus, /status must be started or stopped/), 'unknown Site status was promoted to started');\n\nconst stoppedUnroutedSite = clone(fixture);\nstoppedUnroutedSite.sites.find(x=>x.key==='site-internal-user').status = 'stopped';\nconst stoppedUnroutedBundle = normalizeProjection(stoppedUnroutedSite);\nconst stoppedUnroutedEntity = stoppedUnroutedBundle.entities.find(x=>x.semantic_type==='filetransfer.endpoint' && x.display_name==='Internal User');\nassert(stoppedUnroutedEntity?.status === 'stopped' && stoppedUnroutedEntity?.properties?.site_started === false, 'explicit stopped Site state was not preserved');\n\nconst missingListenerResolution = clone(fixture);\ndelete missingListenerResolution.sites.find(x=>x.key==='site-external-user').listener_resolution;\nassert(rejectedWith(missingListenerResolution, /listener_resolution=qualified-inferred/), 'missing listener resolution was accepted as qualified');\n\nconst unsupportedListenerResolution = clone(fixture);\nunsupportedListenerResolution.sites.find(x=>x.key==='site-external-user').listener_resolution = 'resolved';\nassert(rejectedWith(unsupportedListenerResolution, /listener_resolution=qualified-inferred/), 'unsupported listener resolution was accepted as qualified');\n\n"""
t = replace_once(t, anchor, insert, 'new fail-closed regressions')
anchor2 = """const nestedOnlyReordered = clone(fixture);\nnestedOnlyReordered.routes[0].pnc.corroboration.reverse();\nconst nestedOnlyBundle = normalizeProjection(nestedOnlyReordered);\nassert(nestedOnlyBundle.run.run_id === first.run.run_id, 'run_id changed because nested PNC corroboration order changed');\nassert(JSON.stringify(nestedOnlyBundle) === JSON.stringify(first), 'bundle bytes changed because nested PNC corroboration order changed');\n\n"""
insert2 = anchor2 + """const sharedGatewayEndpoint = clone(fixture);\nconst sharedRouteA = sharedGatewayEndpoint.routes[0];\nconst sharedRouteB = sharedGatewayEndpoint.routes[1];\nsharedRouteB.gateway_server_key = sharedRouteA.gateway_server_key;\nsharedRouteB.listener.host = sharedRouteA.listener.host;\nsharedRouteB.listener.port = sharedRouteA.listener.port;\nsharedRouteB.pnc.host = sharedRouteA.pnc.host;\nsharedRouteB.pnc.port = sharedRouteA.pnc.port;\nfor (const source of sharedRouteB.pnc.corroboration) {\n  source.endpoint_host = sharedRouteA.pnc.host;\n  source.endpoint_port = sharedRouteA.pnc.port;\n}\nconst sharedGatewayBundle = normalizeProjection(sharedGatewayEndpoint);\nconst sharedGatewayReordered = clone(sharedGatewayEndpoint);\nsharedGatewayReordered.routes.reverse();\nconst sharedGatewayReorderedBundle = normalizeProjection(sharedGatewayReordered);\nassert(sharedGatewayReorderedBundle.run.run_id === sharedGatewayBundle.run.run_id, 'shared gateway endpoint run_id changed only because route input order changed');\nassert(JSON.stringify(sharedGatewayReorderedBundle) === JSON.stringify(sharedGatewayBundle), 'shared gateway endpoint provenance changed only because route input order changed');\n\n"""
t = replace_once(t, anchor2, insert2, 'shared gateway endpoint regression')
test_file.write_text(t)


doc = Path('docs/phase-ftp-evidence-integration.md')
d = doc.read_text()
d = replace_once(
    d,
    "The production boundary is fail-closed: a stopped Site cannot qualify a route; an unresolved Site-to-listener mapping cannot qualify a route; PNC qualification requires provenance-bearing current observations from at least two distinct runtime source kinds; and each unresolved Site reference carries its reason in the top-level semantic-import contract field as well as operator-facing properties.",
    "The production boundary is fail-closed: every Site must carry an explicit `started` or `stopped` state; only an explicitly `started` Site with `listener_resolution = qualified-inferred` can qualify a route; blank evidence references are rejected; PNC qualification requires provenance-bearing current observations from at least two distinct runtime source kinds; shared gateway endpoints are projected in deterministic route-key order; and each unresolved Site reference carries its reason in the top-level semantic-import contract field as well as operator-facing properties.",
    'documentation hardening',
)
doc.write_text(d)
