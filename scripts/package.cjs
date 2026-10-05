const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildNative, buildDir } = require('./build-native.cjs');
const { manifest, copyRuntime } = require('./runtime.cjs');

async function packagePlugin() {
  const args = process.argv.slice(2);
  let native;
  while (args.length) {
    if (args.shift() !== '--native' || native) throw new Error('Usage: npm run package -- [--native /path/to/panel_bridge.node]');
    native = args.shift();
    if (!native || native.startsWith('--')) throw new Error('--native requires a file path');
  }
  if (process.platform !== 'darwin') throw new Error('Packaging requires macOS');
  native = native ? path.resolve(native) : await buildNative();
  const releaseDir = path.join(buildDir, 'releases');
  fs.mkdirSync(releaseDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(releaseDir, 'package-'));
  const destination = path.join(staging, manifest.id);
  const archive = path.join(releaseDir, `note-panel-${manifest.version}.zip`);
  try {
    copyRuntime(destination);
    fs.copyFileSync(native, path.join(destination, 'panel_bridge.node'));
    fs.rmSync(archive, { force: true });
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--norsrc', '--noextattr', '--noqtn', '--noacl', destination, archive], { stdio: 'inherit' });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return archive;
}

packagePlugin().then(archive => console.log(archive)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
