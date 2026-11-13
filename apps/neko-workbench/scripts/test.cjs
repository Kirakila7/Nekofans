'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const base = path.resolve(__dirname, '..');
const tests = path.resolve(base, '../../tests/neko-workbench');
const files = fs.readdirSync(tests).filter(name => /\.test\.(?:cjs|mjs)$/.test(name)).map(name => path.join(tests, name));
const references = path.join(base, 'framework/tests');
files.push(...fs.readdirSync(references).filter(name => name.endsWith('.test.mjs')).map(name => path.join(references, name)));
// DOM tests resolve jsdom/react through NEKO_DOM_DEPS; default to this checkout when installed.
const domDeps = process.env.NEKO_DOM_DEPS || (fs.existsSync(path.resolve(base, '../../node_modules/jsdom')) ? path.resolve(base, '../..') : null);
if (!domDeps) console.warn('[test:neko-workbench] jsdom not found; DOM tests will be skipped. Run npm ci or set NEKO_DOM_DEPS.');
const environment = { ...process.env };
if (domDeps) environment.NEKO_DOM_DEPS = domDeps;
const result = spawnSync(process.execPath, ['--test', ...files.sort()], { stdio: 'inherit', env: environment });
process.exitCode = result.status ?? 1;
