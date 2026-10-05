const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
if (!/^[a-z0-9-]+$/.test(manifest.id)) throw new Error('Invalid plugin id');
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Invalid plugin version');

function copyRuntime(destination) {
  fs.mkdirSync(destination, { recursive: true });
  const helpers = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.cjs') && !entry.name.endsWith('.test.cjs'))
    .map(entry => entry.name);
  for (const file of ['main.js', 'manifest.json', ...helpers]) {
    fs.copyFileSync(path.join(root, file), path.join(destination, file));
  }
}

module.exports = { root, manifest, copyRuntime };
