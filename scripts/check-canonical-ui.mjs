import fs from 'node:fs';

const html = fs.readFileSync('public/index.html', 'utf8');
const shell = fs.readFileSync('public/shell.js', 'utf8');
const estate = fs.readFileSync('public/estate-ui.js', 'utf8');

const mustContain = [
  [html, 'src="/shell.js"'],
  [html, 'src="/estate-ui.js"'],
  [html, 'data-view="inventory">Explore<'],
  [estate, '/api/v2/estate/current/summary'],
  [estate, '/api/v2/estate/current/entities'],
  [estate, 'Current / observed server'],
  [estate, 'has_instance'],
  [estate, 'runs_on'],
  [shell, 'import("/app.js")'],
  [shell, 'import("/routes-v2.js")'],
];
for (const [text, value] of mustContain) {
  if (!text.includes(value)) throw new Error(`missing canonical UI contract: ${value}`);
}
for (const value of ['src="/app.js"', 'src="/routes-v2.js"', 'src="/inventory-v2.js"']) {
  if (html.includes(value)) throw new Error(`legacy module is still eager: ${value}`);
}
if (shell.includes('/api/v1/topology/current') || estate.includes('/api/v1/topology/current')) {
  throw new Error('canonical initial modules may not fetch the legacy full graph');
}
console.log('canonical UI static acceptance checks passed');
