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
assert(view.includes('data-view-panel = "filetransfer"') || view.includes('dataset.viewPanel = "filetransfer"'), 'File Transfer view panel is not installed');
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
assert(css.includes('.ft-route-lane'), 'File Transfer lane styling is missing');
assert(css.includes('@media'), 'File Transfer view must include responsive behavior');

console.log('File Transfer operator workspace checks passed.');
