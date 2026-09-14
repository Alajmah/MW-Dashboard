#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const [view, shell, css] = await Promise.all([
  readFile('public/filetransfer-view.js', 'utf8'),
  readFile('public/shell.js', 'utf8'),
  readFile('public/filetransfer-view.css', 'utf8'),
]);

assert(shell.includes('filetransfer: ["File Transfer"'), 'product shell is missing File Transfer copy');
assert(shell.includes('osiRenderFileTransfer'), 'product shell does not render the File Transfer workspace');
assert(shell.includes('/filetransfer-view.js?v='), 'File Transfer module is not loaded by the shell');
assert(view.includes('dataset.viewPanel = "filetransfer"'), 'File Transfer view panel is not installed');
assert(view.includes('/api/v2/estate/current/entities'), 'workspace must read canonical entities');
assert(view.includes('/api/v2/estate/current/relations'), 'workspace must read canonical relations');
assert(view.includes('/api/v2/estate/current/unresolved'), 'workspace must surface canonical unresolved references');
assert(!view.includes('/api/v2/observations/current'), 'workspace must not bypass the canonical estate with source observations');
assert(!view.includes('ADMIN_IMPORT_TOKEN'), 'public workspace must not depend on administrative import credentials');
assert(view.includes('transfer completion not proven'), 'workspace must preserve transfer-completion boundary');
assert(view.includes('historical Site access'), 'workspace must preserve historical Site-access framing');
assert(view.includes('unknown remains unknown'), 'workspace must keep unresolved evidence explicit');
assert(view.includes('ibm_mq_mft_agent'), 'workspace must recognize MQ MFT agents semantically');
assert(view.includes('nfs_relationship'), 'workspace must preserve storage/NFS uncertainty');
assert(view.includes('eft_inbound_site_path'), 'workspace must recognize qualified FTP topology paths semantically');
assert(view.includes('eft_dmz_pnc'), 'workspace must distinguish PNC bridges from client listener paths');

// Review-hardening: a rendered workspace must belong to exactly one canonical revision.
assert(view.includes('ESTATE_REVISION_CHANGED'), 'workspace must detect cross-revision canonical reads');
assert(view.includes('requireEstateRevision(page, revisionId'), 'paginated reads must enforce the anchored estate revision');
assert(view.includes('requireEstateRevision(finalSummary, revisionId'), 'workspace must re-check the estate revision before rendering');
assert(view.includes('attempt <= 3'), 'workspace must retry a complete load when the estate changes mid-read');

// Review-hardening: unresolved Site mappings must paginate and remain Site-scoped.
assert(view.includes('fetchAll("/api/v2/estate/current/unresolved?semantic_type=filetransfer.endpoint"'), 'unresolved File Transfer references must use the pagination loop');
assert(view.includes('siteIds.has(item.source_entity_id)'), 'unresolved endpoint references must be filtered to EFT Sites before UI counts/status');

// Review-hardening: discover MFT semantically rather than by a naming convention.
assert(view.includes('fetchEntities("app.application_instance", revisionId)'), 'MFT discovery must start from all application instances');
assert(!view.includes('fetchEntities("app.application_instance", "AGENT"'), 'MFT discovery must not require AGENT in the display name');
assert(view.includes('component_class") === "ibm_mq_mft_agent"'), 'MFT discovery must filter on the semantic component class');

// Review-hardening: preserve explicit stopped state and parallel MQ dependencies.
assert(view.includes('return "Site stopped"'), 'explicitly stopped EFT Sites must render as stopped');
assert(view.includes('ft-dependency-branch'), 'MFT agent-QM and coordination-QM associations must render as sibling dependencies');
assert(view.includes('Agent QM</span>') && view.includes('Coordination QM</span>'), 'both configured MFT dependency roles must be visible');

// Review-hardening: failed refreshes must never fall back to cached canonical data.
assert(view.includes('ftState.loaded = false') && view.includes('ftState.data = null'), 'failed refresh must invalidate cached canonical data');
assert(view.includes('No cached estate is being shown'), 'all panels must expose a fail-closed refresh error state');

assert(css.includes('.ft-route-lane'), 'File Transfer lane styling is missing');
assert(css.includes('.ft-dependency-branch'), 'parallel MFT dependency styling is missing');
assert(css.includes('.ft-error-state'), 'fail-closed load-error styling is missing');
assert(css.includes('@media'), 'File Transfer view must include responsive behavior');

const referencedIds = new Set([...view.matchAll(/\bfq\("([A-Za-z0-9_-]+)"\)/g)].map((match) => match[1]));
const declaredIds = new Set([...view.matchAll(/\bid=["']([A-Za-z0-9_-]+)["']/g)].map((match) => match[1]));
for (const id of referencedIds) {
  assert(declaredIds.has(id), `File Transfer module references dynamic id without declaring it: ${id}`);
}

const sizes = [...css.matchAll(/font-size:\s*([0-9.]+)px/g)].map((match) => Number(match[1]));
assert(sizes.length > 0, 'File Transfer stylesheet has no explicit font sizes');
assert(Math.min(...sizes) >= 10, `File Transfer operational text falls below 10px: ${Math.min(...sizes)}px`);

console.log(`File Transfer operator workspace checks passed: ${referencedIds.size} dynamic ids, minimum font size ${Math.min(...sizes)}px.`);
