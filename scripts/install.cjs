const fs = require('node:fs');
const path = require('node:path');
const { buildNative, nativePath } = require('./build-native.cjs');
const { manifest, copyRuntime } = require('./runtime.cjs');

async function install() {
  const args = process.argv.slice(2);
  const vault = args.shift();
  if (!vault || vault.startsWith('--')) throw new Error('Usage: npm run install:plugin -- /path/to/vault [--native /path/to/panel_bridge.node | --skip-native]');
  let source;
  let skipNative = false;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--native') {
      source = args.shift();
      if (!source || source.startsWith('--')) throw new Error('--native requires a file path');
    } else if (arg === '--skip-native') skipNative = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (source && skipNative) throw new Error('Choose either --native or --skip-native');
  if (process.platform !== 'darwin') throw new Error('Note Panel supports macOS only');
  const vaultPath = path.resolve(vault);
  if (!fs.statSync(vaultPath).isDirectory() || !fs.existsSync(path.join(vaultPath, '.obsidian'))) {
    throw new Error('Expected an existing Obsidian vault with a .obsidian directory');
  }
  const destination = path.join(vaultPath, '.obsidian/plugins', manifest.id);
  const nativeDestination = path.join(destination, 'panel_bridge.node');
  if (skipNative) {
    if (!fs.existsSync(nativeDestination)) throw new Error('--skip-native requires an already installed native bridge');
  } else {
    source = source ? path.resolve(source) : await buildNative();
    if (!fs.statSync(source).isFile()) throw new Error('Native bridge file not found');
  }
  copyRuntime(destination);
  if (!skipNative) fs.copyFileSync(source || nativePath, nativeDestination);
  console.log(`Installed Note Panel ${manifest.version}: ${destination}`);
  console.log('Enable Note Panel in Obsidian Community plugins, or reload the existing plugin. Settings in data.json are preserved.');
}

install().catch(error => { console.error(error.message); process.exitCode = 1; });
