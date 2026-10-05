const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ruby = process.env.RUBY || (fs.existsSync('/usr/bin/ruby') ? '/usr/bin/ruby' : 'ruby');
const rubyAvailable = spawnSync(ruby, ['--version'], { encoding: 'utf8' }).status === 0;
const ID = 'panel-micro-demo';
const RECEIPT = '.note-panel-receipt.json';

function fixture(t) {
  // Resolve macOS's /var symlink so the state-path checks see the actual directories.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'note-panel-homebrew-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const distribution = path.join(root, 'distribution');
  const payload = path.join(distribution, ID);
  const script = path.join(distribution, 'note-panel');
  const state = path.join(root, 'state');
  fs.mkdirSync(payload, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'scripts/note-panel'), script);
  fs.chmodSync(script, 0o755);
  const writePayload = (version = '0.6.0') => {
    fs.writeFileSync(path.join(payload, 'manifest.json'), JSON.stringify({ id: ID, version }));
    fs.writeFileSync(path.join(payload, 'main.js'), `version ${version}`);
    fs.writeFileSync(path.join(payload, 'panel_bridge.node'), `native ${version}`);
    fs.writeFileSync(path.join(payload, 'session-layout.cjs'), `helper ${version}`);
    fs.writeFileSync(path.join(payload, 'main.test.cjs'), 'not a runtime helper');
    fs.writeFileSync(path.join(payload, 'data.json'), 'not distributed settings');
  };
  writePayload();
  const vault = (name = 'Vault with spaces') => {
    const destination = path.join(root, name);
    fs.mkdirSync(path.join(destination, '.obsidian'), { recursive: true });
    fs.writeFileSync(path.join(destination, 'Note.md'), 'User note remains unchanged.');
    fs.writeFileSync(path.join(destination, '.obsidian/community-plugins.json'), '["another-plugin"]');
    fs.writeFileSync(path.join(destination, '.obsidian/hotkeys.json'), '{"custom":true}');
    return destination;
  };
  const plugin = target => path.join(target, '.obsidian/plugins', ID);
  const command = (...args) => spawnSync(ruby, [script, ...args], {
    env: { ...process.env, NOTE_PANEL_STATE_DIR: state }, encoding: 'utf8', timeout: 15_000,
  });
  const ok = (...args) => {
    const result = command(...args);
    assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
    return result;
  };
  const fail = (...args) => {
    const result = command(...args);
    assert.equal(result.status, 1, `Expected failure: ${result.stdout} ${result.stderr}`);
    return result;
  };
  const registry = () => JSON.parse(fs.readFileSync(path.join(state, 'vaults.json'), 'utf8')).vaults;
  return { root, distribution, payload, script, state, writePayload, vault, plugin, command, ok, fail, registry };
}

const regression = (name, body) => test(name, { skip: !rubyAvailable && 'Ruby is unavailable' }, body);

regression('install and update replace runtime atomically while preserving notes, settings and unrelated files', t => {
  const f = fixture(t), vault = f.vault(), plugin = f.plugin(vault);
  f.ok('install', vault);
  assert.deepEqual(f.registry(), [vault]);
  assert.equal(fs.statSync(f.state).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(f.state, 'vaults.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(plugin, RECEIPT)).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(plugin, 'main.test.cjs')), false);
  assert.equal(fs.existsSync(path.join(plugin, 'data.json')), false);
  fs.writeFileSync(path.join(plugin, 'data.json'), '{"tabs":["Note.md"]}');
  fs.writeFileSync(path.join(plugin, 'unrelated.cjs'), 'user-owned');
  const fd = fs.openSync(path.join(plugin, 'panel_bridge.node'), 'r');
  try {
    f.writePayload('0.6.1');
    fs.unlinkSync(path.join(f.payload, 'session-layout.cjs'));
    f.ok('install', vault);
    assert.equal(fs.readFileSync(fd, 'utf8'), 'native 0.6.0', 'an already mapped native addon retains its old inode');
    assert.equal(fs.readFileSync(path.join(plugin, 'panel_bridge.node'), 'utf8'), 'native 0.6.1');
  } finally { fs.closeSync(fd); }
  assert.equal(fs.existsSync(path.join(plugin, 'session-layout.cjs')), false, 'obsolete receipt-listed runtime is removed');
  assert.equal(fs.readFileSync(path.join(plugin, 'data.json'), 'utf8'), '{"tabs":["Note.md"]}');
  assert.equal(fs.readFileSync(path.join(plugin, 'unrelated.cjs'), 'utf8'), 'user-owned');
  assert.equal(fs.readFileSync(path.join(vault, 'Note.md'), 'utf8'), 'User note remains unchanged.');
  assert.equal(fs.readFileSync(path.join(vault, '.obsidian/community-plugins.json'), 'utf8'), '["another-plugin"]');
  assert.equal(fs.readFileSync(path.join(vault, '.obsidian/hotkeys.json'), 'utf8'), '{"custom":true}');
  assert.deepEqual(f.registry(), [vault], 'reinstallation deduplicates registrations');
});

regression('explicit install adopts only the matching manual plugin', t => {
  const f = fixture(t), vault = f.vault(), plugin = f.plugin(vault);
  fs.mkdirSync(plugin, { recursive: true });
  fs.writeFileSync(path.join(plugin, 'manifest.json'), JSON.stringify({ id: ID, version: '0.2.0' }));
  fs.writeFileSync(path.join(plugin, 'data.json'), 'manual settings');
  f.ok('install', vault);
  assert.equal(fs.readFileSync(path.join(plugin, 'data.json'), 'utf8'), 'manual settings');
  const wrongVault = f.vault('Other vault'), wrongPlugin = f.plugin(wrongVault);
  fs.mkdirSync(wrongPlugin, { recursive: true });
  const original = JSON.stringify({ id: 'different-plugin', version: '1.0.0' });
  fs.writeFileSync(path.join(wrongPlugin, 'manifest.json'), original);
  assert.match(f.fail('install', wrongVault).stderr, /unexpected plugin ID/);
  assert.equal(fs.readFileSync(path.join(wrongPlugin, 'manifest.json'), 'utf8'), original);
  assert.equal(fs.existsSync(path.join(wrongPlugin, 'main.js')), false);
  const unknownVault = f.vault('Unknown installation'), unknownPlugin = f.plugin(unknownVault);
  fs.mkdirSync(unknownPlugin, { recursive: true });
  fs.writeFileSync(path.join(unknownPlugin, 'data.json'), 'unknown ownership');
  fs.writeFileSync(path.join(unknownPlugin, 'main.js'), 'unknown runtime ownership');
  f.fail('install', unknownVault);
  assert.equal(fs.readFileSync(path.join(unknownPlugin, 'main.js'), 'utf8'), 'unknown runtime ownership');
});

regression('cask uninstall keeps markers and registrations for reinstall across several vaults', t => {
  const f = fixture(t), first = f.vault('First vault'), second = f.vault('Second vault');
  for (const vault of [first, second]) {
    f.ok('install', vault);
    fs.writeFileSync(path.join(f.plugin(vault), 'data.json'), `settings ${vault}`);
  }
  f.ok('uninstall', '--all', '--keep-registry');
  assert.deepEqual(f.registry(), [first, second]);
  for (const vault of [first, second]) {
    assert.equal(fs.existsSync(path.join(f.plugin(vault), 'main.js')), false);
    assert.equal(fs.existsSync(path.join(f.plugin(vault), RECEIPT)), true);
  }
  f.writePayload('0.6.1');
  f.ok('install', '--registered');
  for (const vault of [first, second]) {
    assert.equal(fs.readFileSync(path.join(f.plugin(vault), 'main.js'), 'utf8'), 'version 0.6.1');
    assert.equal(fs.readFileSync(path.join(f.plugin(vault), 'data.json'), 'utf8'), `settings ${vault}`);
  }
  f.ok('uninstall', first);
  assert.deepEqual(f.registry(), [second]);
  assert.equal(fs.existsSync(path.join(f.plugin(first), RECEIPT)), false);
  f.ok('uninstall', '--all');
  assert.deepEqual(f.registry(), []);
  assert.equal(fs.existsSync(path.join(f.plugin(second), RECEIPT)), false);
  assert.equal(fs.readFileSync(path.join(f.plugin(second), 'data.json'), 'utf8'), `settings ${second}`);
  f.ok('install', second);
  assert.equal(fs.readFileSync(path.join(f.plugin(second), 'data.json'), 'utf8'), `settings ${second}`, 'explicit reinstall accepts retained settings after uninstall');
});

regression('uninstall removes only managed files and removes the plugin directory only when empty', t => {
  const f = fixture(t), vault = f.vault();
  f.ok('install', vault);
  f.ok('uninstall', vault);
  assert.equal(fs.existsSync(f.plugin(vault)), false);
  f.ok('install', vault);
  fs.writeFileSync(path.join(f.plugin(vault), 'unrelated.cjs'), 'keep');
  f.ok('uninstall', vault);
  assert.equal(fs.readFileSync(path.join(f.plugin(vault), 'unrelated.cjs'), 'utf8'), 'keep');
});

regression('invalid and missing vaults never create vault directories', t => {
  const f = fixture(t), missing = path.join(f.root, 'Missing');
  assert.match(f.fail('install', missing).stderr, /missing or unavailable/);
  assert.equal(fs.existsSync(missing), false);
  const ordinary = path.join(f.root, 'Ordinary directory');
  fs.mkdirSync(ordinary);
  assert.match(f.fail('install', ordinary).stderr, /existing Obsidian vault/);
  assert.equal(fs.existsSync(path.join(ordinary, '.obsidian')), false);
  f.fail('install', '--unexpected');
  f.fail('uninstall', '--keep-registry');
  f.fail('uninstall', '--all', 'extra');
});

regression('missing registered vaults are skipped without losing registration or recreating a vault', t => {
  const f = fixture(t), vault = f.vault(), offline = path.join(f.root, 'Offline vault');
  f.ok('install', vault);
  fs.renameSync(vault, offline);
  assert.match(f.ok('install', '--registered').stderr, /Skipping registered vault/);
  assert.deepEqual(f.registry(), [vault]);
  assert.equal(fs.existsSync(vault), false);
  assert.match(f.ok('uninstall', '--all').stderr, /Skipping registered vault/);
  assert.deepEqual(f.registry(), [vault]);
  fs.renameSync(offline, vault);
  f.ok('install', '--registered');
});

regression('registered install does not adopt a replacement vault or a manually removed plugin', t => {
  const f = fixture(t), vault = f.vault(), plugin = f.plugin(vault);
  f.ok('install', vault);
  fs.rmSync(plugin, { recursive: true });
  assert.match(f.ok('install', '--registered').stderr, /marker is missing/);
  assert.equal(fs.existsSync(plugin), false);
  assert.deepEqual(f.registry(), [vault]);
  // A new vault reusing the same path also has no ownership marker.
  fs.renameSync(vault, path.join(f.root, 'Previous vault'));
  f.vault();
  assert.match(f.ok('install', '--registered').stderr, /marker is missing/);
  assert.equal(fs.existsSync(plugin), false);
  f.ok('install', vault);
  const receiptPath = path.join(plugin, RECEIPT);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  receipt.vault = path.join(f.root, 'Different vault');
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  f.writePayload('0.6.1');
  assert.match(f.ok('install', '--registered').stderr, /Invalid installation receipt/);
  assert.equal(fs.readFileSync(path.join(plugin, 'main.js'), 'utf8'), 'version 0.6.0');
});

regression('malicious receipt names fail before any managed or unrelated file is deleted', t => {
  const f = fixture(t), vault = f.vault(), plugin = f.plugin(vault);
  f.ok('install', vault);
  const receiptPath = path.join(plugin, RECEIPT);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  fs.writeFileSync(path.join(plugin, 'data.json'), 'important settings');
  fs.writeFileSync(path.join(plugin, 'unrelated.cjs'), 'user-owned helper');
  for (const forbidden of ['../Note.md', 'data.json', 'unrelated.cjs', 'helper.test.cjs', '/tmp/anything.cjs', 'nested/helper.cjs']) {
    fs.writeFileSync(receiptPath, JSON.stringify({ ...receipt, files: ['main.js', forbidden] }));
    assert.match(f.fail('uninstall', vault).stderr, /Invalid installation receipt/);
    assert.match(f.fail('install', vault).stderr, /Invalid installation receipt/);
    assert.equal(fs.readFileSync(path.join(plugin, 'main.js'), 'utf8'), 'version 0.6.0');
    assert.equal(fs.readFileSync(path.join(plugin, 'data.json'), 'utf8'), 'important settings');
    assert.equal(fs.readFileSync(path.join(plugin, 'unrelated.cjs'), 'utf8'), 'user-owned helper');
  }
});

regression('unknown release helpers fail before installation or update changes any runtime', t => {
  const f = fixture(t), vault = f.vault(), plugin = f.plugin(vault);
  fs.writeFileSync(path.join(f.payload, 'future-helper.cjs'), 'requires an explicit installer allowlist update');
  assert.match(f.fail('install', vault).stderr, /unsupported runtime helpers/);
  assert.equal(fs.existsSync(plugin), false);
  fs.unlinkSync(path.join(f.payload, 'future-helper.cjs'));
  f.ok('install', vault);
  fs.writeFileSync(path.join(plugin, 'unrelated.cjs'), 'user-owned');
  f.writePayload('0.6.1');
  fs.writeFileSync(path.join(f.payload, 'future-helper.cjs'), 'not trusted');
  assert.match(f.fail('install', vault).stderr, /unsupported runtime helpers/);
  assert.equal(fs.readFileSync(path.join(plugin, 'main.js'), 'utf8'), 'version 0.6.0');
  assert.equal(fs.readFileSync(path.join(plugin, 'unrelated.cjs'), 'utf8'), 'user-owned');
  assert.equal(JSON.parse(fs.readFileSync(path.join(plugin, RECEIPT), 'utf8')).version, '0.6.0');
});

regression('symlinks in plugin parents, managed files, and receipts are refused', t => {
  const f = fixture(t), outside = path.join(f.root, 'Outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'main.js'), 'external file');
  for (const parent of ['.obsidian', '.obsidian/plugins', `.obsidian/plugins/${ID}`]) {
    const vault = f.vault(`Symlink ${parent.replaceAll('/', '-')}`);
    const target = path.join(vault, parent);
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(outside, target, 'dir');
    assert.match(f.fail('install', vault).stderr, /Refusing symlink/);
  }
  for (const file of ['main.js', 'manifest.json', 'panel_bridge.node', RECEIPT]) {
    const vault = f.vault(`Symlink file ${file}`), plugin = f.plugin(vault);
    f.ok('install', vault);
    fs.unlinkSync(path.join(plugin, file));
    fs.symlinkSync(path.join(outside, 'main.js'), path.join(plugin, file));
    assert.match(f.fail('install', vault).stderr, /Refusing symlink/);
    assert.match(f.fail('uninstall', vault).stderr, /Refusing symlink/);
  }
  assert.equal(fs.readFileSync(path.join(outside, 'main.js'), 'utf8'), 'external file');
});

regression('symlinked state directory, parent, registry, and source runtime are refused', t => {
  const f = fixture(t), vault = f.vault(), outside = path.join(f.root, 'Outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, f.state, 'dir');
  assert.match(f.fail('install', vault).stderr, /Refusing symlink/);
  assert.equal(fs.existsSync(f.plugin(vault)), false);
  fs.unlinkSync(f.state);
  const parentLink = path.join(f.root, 'State parent');
  fs.symlinkSync(outside, parentLink, 'dir');
  const parentResult = spawnSync(ruby, [f.script, 'install', vault], {
    env: { ...process.env, NOTE_PANEL_STATE_DIR: path.join(parentLink, 'Nested') }, encoding: 'utf8',
  });
  assert.equal(parentResult.status, 1);
  assert.match(parentResult.stderr, /Refusing symlink/);
  fs.mkdirSync(f.state);
  const registryTarget = path.join(outside, 'registry.json');
  fs.writeFileSync(registryTarget, '{"version":1,"vaults":[]}');
  fs.symlinkSync(registryTarget, path.join(f.state, 'vaults.json'));
  assert.match(f.fail('install', vault).stderr, /Refusing symlink/);
  fs.unlinkSync(path.join(f.state, 'vaults.json'));
  fs.unlinkSync(path.join(f.payload, 'main.js'));
  fs.symlinkSync(registryTarget, path.join(f.payload, 'main.js'));
  assert.match(f.fail('install', vault).stderr, /Refusing symlink/);
  assert.equal(fs.existsSync(f.plugin(vault)), false);
});

regression('a Homebrew-style executable symlink locates the sibling payload without Node', t => {
  const f = fixture(t), vault = f.vault(), binary = path.join(f.root, 'bin/note-panel');
  fs.mkdirSync(path.dirname(binary));
  fs.symlinkSync(f.script, binary);
  const result = spawnSync(binary, ['install', vault], {
    env: { ...process.env, NOTE_PANEL_STATE_DIR: f.state, PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(f.plugin(vault), 'main.js'), 'utf8'), 'version 0.6.0');
});

regression('initial registered install is noninteractive and empty registry needs no payload or state writes', t => {
  const f = fixture(t);
  fs.rmSync(f.payload, { recursive: true });
  assert.match(f.ok('install', '--registered').stdout, /note-panel install/);
  assert.equal(fs.existsSync(f.state), false);
  assert.match(f.ok('--help').stdout, /--keep-registry/);
  f.ok('uninstall', '--all', '--keep-registry');
  assert.equal(fs.existsSync(f.state), false);
});
