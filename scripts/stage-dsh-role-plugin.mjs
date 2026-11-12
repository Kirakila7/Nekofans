import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workbench = fileURLToPath(new URL('../apps/neko-workbench/', import.meta.url));
const source = path.join(workbench, 'vendor', 'dsh-bili-whale');
if (process.argv.length !== 3) throw Error('Usage: node scripts/stage-dsh-role-plugin.mjs <new output directory>');
const target = path.resolve(process.argv[2]);
if (fs.existsSync(target)) throw Error('Choose a new output directory.');
fs.mkdirSync(target);
for (const name of ['lib', 'tools', 'deps', 'README.md', 'LICENSE', 'NOTICE.md', 'cordis.patch.yml', 'package.json']) {
  fs.cpSync(path.join(source, name), path.join(target, name), { recursive: true });
}
for (const name of ['fish-care.cjs', 'account-route.cjs']) {
  fs.copyFileSync(path.join(workbench, name), path.join(target, 'lib', name));
}
const entry = path.join(target, 'lib', 'index.js');
fs.writeFileSync(entry, fs.readFileSync(entry, 'utf8')
  .replace('../../../fish-care.cjs', './fish-care.cjs')
  .replace('../../../account-route.cjs', './account-route.cjs'));
const packageFile = path.join(target, 'package.json');
const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
pkg.version += '-nekofans.1';
pkg.files = ['lib', 'tools', 'deps', 'README.md', 'LICENSE', 'NOTICE.md', 'cordis.patch.yml'];
delete pkg.dependencies.qrcode; // The plugin already uses deps/qrcode.cjs.
fs.writeFileSync(packageFile, JSON.stringify(pkg, null, 2) + '\n');
console.log(target);
