const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const buildDir = path.join(os.homedir(), 'Library/Developer/Xcode/DerivedData/ObsidianNotePanel');
const nativePath = path.join(buildDir, 'native/panel_bridge.node');
const pinnedHeadersVersion = '26.10.0';

function hasHeaders(dir) {
  return typeof dir === 'string' && fs.existsSync(path.join(dir, 'node_api.h'));
}

async function downloadHeaders(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid NODE_HEADERS_VERSION');
  const base = `https://nodejs.org/dist/v${version}/`;
  const archiveName = `node-v${version}-headers.tar.gz`;
  const cache = path.join(buildDir, 'headers', version);
  const include = path.join(cache, `node-v${version}`, 'include/node');
  if (hasHeaders(include)) return include;
  fs.mkdirSync(cache, { recursive: true });
  const checksumsResponse = await fetch(base + 'SHASUMS256.txt', { signal: AbortSignal.timeout(30000) });
  if (!checksumsResponse.ok) throw new Error(`Cannot download official header checksums: ${checksumsResponse.status}`);
  const checksums = await checksumsResponse.text();
  const expected = checksums.split('\n').map(line => line.trim().split(/\s+/))
    .find(([, name]) => name === archiveName)?.[0];
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Official header checksum not found');
  const archiveResponse = await fetch(base + archiveName, { signal: AbortSignal.timeout(30000) });
  if (!archiveResponse.ok) throw new Error(`Cannot download official Node headers: ${archiveResponse.status}`);
  const bytes = Buffer.from(await archiveResponse.arrayBuffer());
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Node header checksum mismatch');
  const archive = path.join(cache, archiveName);
  fs.writeFileSync(archive, bytes);
  try {
    execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', cache], { stdio: 'inherit' });
  } finally {
    fs.rmSync(archive, { force: true });
  }
  if (!hasHeaders(include)) throw new Error('Downloaded Node headers are incomplete');
  return include;
}

async function findHeaders() {
  if (process.env.NODE_INCLUDE_DIR) {
    const requested = path.resolve(process.env.NODE_INCLUDE_DIR);
    if (!hasHeaders(requested)) throw new Error('NODE_INCLUDE_DIR must contain node_api.h');
    return requested;
  }
  const executable = fs.realpathSync(process.execPath);
  const prefix = path.dirname(path.dirname(executable));
  const candidates = [
    path.join(prefix, 'include/node'),
    '/opt/homebrew/include/node',
    '/usr/local/include/node',
  ];
  return candidates.find(hasHeaders) || downloadHeaders(process.env.NODE_HEADERS_VERSION || pinnedHeadersVersion);
}

async function buildNative() {
  if (process.platform !== 'darwin') throw new Error('The native panel requires macOS and Xcode Command Line Tools');
  execFileSync('/usr/bin/xcrun', ['--find', 'clang'], { stdio: 'ignore' });
  const headers = await findHeaders();
  fs.mkdirSync(path.dirname(nativePath), { recursive: true });
  execFileSync('/usr/bin/xcrun', ['clang',
    '-std=c11', '-fobjc-arc', '-bundle', '-undefined', 'dynamic_lookup',
    '-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=13.0',
    '-DNAPI_VERSION=8', '-I', headers, '-framework', 'AppKit',
    path.join(root, 'panel_bridge.m'), '-o', nativePath,
  ], { stdio: 'inherit' });
  const architectures = execFileSync('/usr/bin/xcrun', ['lipo', nativePath, '-archs'], { encoding: 'utf8' }).trim().split(/\s+/);
  if (!['arm64', 'x86_64'].every(arch => architectures.includes(arch))) throw new Error('Native bridge must contain arm64 and x86_64');
  const bridge = require(nativePath);
  if (typeof bridge.inspect !== 'function') throw new Error('Native bridge export missing');
  try {
    bridge.inspect(Buffer.alloc(0));
    throw new Error('Native bridge accepted an invalid window handle');
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
  return nativePath;
}

module.exports = { buildNative, nativePath, buildDir };
if (require.main === module) {
  buildNative().then(output => console.log(output)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
