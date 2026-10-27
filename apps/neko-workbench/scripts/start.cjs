'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
const launcher = path.resolve(__dirname, '../../..', 'scripts/start-neko-workbench.mjs');
const child = spawn(process.execPath, [launcher, ...process.argv.slice(2)], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
