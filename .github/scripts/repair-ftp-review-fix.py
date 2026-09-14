from pathlib import Path

p = Path('.github/scripts/ftp-review-fix.py')
s = p.read_text()

start = s.index("old_validate = '''")
end = s.index("p.write_text(s)", start)
replacement = '''old_validate = \'\'\'  for (const unresolved of bundle.unresolved_references) {
    if (!refs.has(unresolved.source_ref)) fail(`unresolved source missing ${unresolved.ref}`);
    if (!unresolvedStates.has(unresolved.state)) fail(`unsupported unresolved state ${unresolved.state}`);
    if (unresolved.evidence_class && !evidenceClasses.has(unresolved.evidence_class)) fail(`unsupported unresolved evidence class ${unresolved.evidence_class}`);
  }
\'\'\'
new_validate = \'\'\'  for (const unresolved of bundle.unresolved_references) {
    if (!refs.has(unresolved.source_ref)) fail(`unresolved source missing ${unresolved.ref}`);
    if (!unresolvedStates.has(unresolved.state)) fail(`unsupported unresolved state ${unresolved.state}`);
    if (unresolved.evidence_class && !evidenceClasses.has(unresolved.evidence_class)) fail(`unsupported unresolved evidence class ${unresolved.evidence_class}`);
    if (typeof unresolved.reason !== 'string' || !unresolved.reason.trim()) fail(`unresolved reason missing ${unresolved.ref}`);
  }
\'\'\'
s = replace_once(s, old_validate, new_validate, "unresolved validator")

old_route_validate = \'\'\'      const corroborationRefs = uniqStrings(corroboration?.evidence_refs);
      if (corroborationRefs.length < 2) fail('FTP PNC corroboration requires at least two distinct evidence refs');
      if (corroborationRefs.includes(relation.properties?.site_access_evidence?.evidence_ref)) fail('FTP PNC corroboration must remain independent of Site-access evidence');
\'\'\'
new_route_validate = \'\'\'      if (!Array.isArray(corroboration.sources) || corroboration.sources.length < 2) fail('FTP route PNC corroboration requires provenance-bearing sources');
      const sourceKinds = new Set();
      const pncEvidenceRefs = new Set();
      for (const source of corroboration.sources) {
        if (source?.kind !== 'pnc_runtime_connectivity') fail('FTP route PNC source kind is invalid');
        if (source?.time_scope !== 'current' || source?.evidence_class !== 'observed') fail('FTP route PNC source provenance is invalid');
        if (!source?.source_kind || !source?.evidence_ref) fail('FTP route PNC source metadata is incomplete');
        if (source.evidence_ref === relation.properties?.site_access_evidence?.evidence_ref) fail('FTP PNC corroboration must remain independent of Site-access evidence');
        sourceKinds.add(source.source_kind);
        pncEvidenceRefs.add(source.evidence_ref);
      }
      if (sourceKinds.size < 2 || pncEvidenceRefs.size < 2) fail('FTP route PNC corroboration is not independent');
\'\'\'
s = replace_once(s, old_route_validate, new_route_validate, "PNC output validator")
'''
s = s[:start] + replacement + s[end:]
p.write_text(s)
