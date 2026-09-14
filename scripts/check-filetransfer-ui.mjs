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
assert(css.includes('.ft-route-lane'), 'File Transfer lane styling is missing');
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
