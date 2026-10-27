'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const base = path.resolve(__dirname, '..');
const excluded = new Set(['data', 'runtime', 'workspaces', 'evidence', 'node_modules', '.git']);
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (excluded.has(entry.name) || entry.isSymbolicLink()) return [];
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? files(target) : /\.(?:js|cjs|mjs)$/.test(entry.name) ? [target] : [];
  });
}
const sources = files(base).sort();
for (const target of sources) {
  const result = spawnSync(process.execPath, ['--check', target], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Syntax checked ${sources.length} workbench source files; no service started.`);
for (const script of ['embedded-dsh/check-skin-patch.cjs',
  'embedded-dsh/b0-skin/packages/dsh-client-ui-skin/scripts/smoke.mjs',
  'embedded-dsh/b0-skin/packages/dsh-client-ui-white-label/scripts/smoke.mjs']) {
  const result = spawnSync(process.execPath, [path.join(base, script)], { stdio: 'inherit', cwd: os.tmpdir() });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
