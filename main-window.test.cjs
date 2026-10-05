'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function event() {
  return { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
}

function fixture() {
  const app = new EventEmitter();
  const autoUpdater = new EventEmitter();
  const windows = new Map();
  class Contents extends EventEmitter {
    constructor() { super(); this.destroyed = false; this.throttling = true; }
    isDestroyed() { return this.destroyed; }
    getBackgroundThrottling() { return this.throttling; }
    setBackgroundThrottling(value) { this.throttling = value; }
  }
  class Window extends EventEmitter {
    constructor(id) {
      super(); this.id = id; this.visible = true; this.destroyed = false;
      this.minimized = false; this.focused = false; this.hostCloseCount = 0;
      this.webContents = new Contents(); windows.set(id, this);
      this.hostClose = () => { this.closing = true; this.hostCloseCount++; };
      this.on('close', this.hostClose);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; }
    hide() { this.visible = false; this.emit('hide'); }
    show() { this.visible = true; this.emit('show'); }
    focus() { this.focused = true; }
    close() {
      const e = event(); this.emit('close', e);
      if (!e.defaultPrevented) {
        const unload = event();
        this.beforeUnload?.(unload);
        if (!unload.defaultPrevented) this.destroy();
      }
      return e;
    }
    destroy() {
      this.destroyed = true; this.webContents.destroyed = true;
      this.webContents.emit('destroyed'); this.emit('closed');
      if (!app.quitting && [...windows.values()].every(win => win.destroyed)) {
        app.emit('window-all-closed');
      }
    }
  }
  app.quit = () => {
    app.quitCalls = (app.quitCalls || 0) + 1;
    const e = event(); app.emit('before-quit', e);
    if (!e.defaultPrevented) {
      app.quitting = true;
      for (const win of windows.values()) if (!win.destroyed) win.close();
      if ([...windows.values()].every(win => win.destroyed)) {
        const willQuit = event(); app.emit('will-quit', willQuit);
        if (!willQuit.defaultPrevented) { app.exited = true; app.emit('quit'); }
      } else app.quitting = false;
    }
    return e;
  };
  const main = new Window(1);
  const other = new Window(2);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'main-window.cjs'), 'utf8'), {
    module, exports: module.exports, queueMicrotask, setImmediate, clearImmediate,
    require(name) {
      assert.equal(name, 'electron');
      return { app, autoUpdater, BrowserWindow: {
        fromId: id => windows.get(id),
        getAllWindows: () => [...windows.values()].filter(win => !win.destroyed)
      } };
    }
  });
  return { helper: module.exports, app, autoUpdater, main, other };
}

test('closing the retained main window preserves its renderer and host handler', () => {
  const { helper, main, other } = fixture();
  helper.install(main.id);
  const e = main.close();
  assert.equal(e.defaultPrevented, true);
  assert.equal(main.visible, false);
  assert.equal(main.destroyed, false);
  assert.equal(main.webContents.destroyed, false);
  assert.equal(main.closing, false);
  assert.equal(main.hostCloseCount, 1);
  assert.equal(main.listeners('close').includes(main.hostClose), true);
  assert.equal(main.webContents.throttling, false);
  other.close();
  assert.equal(other.destroyed, true);
});

test('a normal app quit closes the retained window and removes helper listeners', () => {
  const { helper, main, app, autoUpdater } = fixture();
  helper.install(main.id); main.close();
  app.quit();
  assert.equal(main.destroyed, true);
  assert.equal(main.closing, true);
  assert.equal(helper.status(main.id).retained, false);
  assert.equal(app.listenerCount('before-quit'), 0);
  assert.equal(app.listenerCount('activate'), 0);
  assert.equal(autoUpdater.listenerCount('before-quit-for-update'), 0);
  assert.equal(app.listenerCount('window-all-closed'), 0);
  assert.equal(app.listenerCount('will-quit'), 0);
  assert.equal(app.exited, true);
});

test('updater quit bypasses close interception even before app before-quit', () => {
  const { helper, main, other, app, autoUpdater } = fixture();
  helper.install(main.id);
  autoUpdater.emit('before-quit-for-update');
  assert.equal(helper.status(main.id).pendingQuit, false);
  assert.equal(app.listenerCount('window-all-closed'), 0);
  assert.equal(main.close().defaultPrevented, false);
  assert.equal(main.destroyed, true);
  other.destroy();
  app.emit('will-quit');
  assert.equal(app.listenerCount('window-all-closed'), 0);
});

test('a canceled before-quit resets protection after the complete event dispatch', async () => {
  const { helper, main, app } = fixture();
  helper.install(main.id);
  app.on('before-quit', e => e.preventDefault());
  assert.equal(app.quit().defaultPrevented, true);
  await Promise.resolve();
  assert.equal(helper.status(main.id).quitting, false);
  assert.equal(helper.status(main.id).pendingQuit, false);
  assert.equal(app.listenerCount('window-all-closed'), 0);
  assert.equal(app.listenerCount('will-quit'), 0);
  assert.equal(main.close().defaultPrevented, true);
  assert.equal(main.destroyed, false);
});

test('Dock activation restores only the window hidden by this helper', () => {
  const { helper, main, other, app } = fixture();
  helper.install(main.id); main.close();
  main.minimized = true; other.focused = false;
  app.emit('activate');
  assert.equal(main.visible, true);
  assert.equal(main.minimized, false);
  assert.equal(main.focused, true);
  assert.equal(other.focused, false);
  assert.equal(helper.status(main.id).hiddenByClose, false);
});

test('release restores background throttling, shows a hidden owner, and preserves host listeners', () => {
  const { helper, main, app, autoUpdater } = fixture();
  helper.install(main.id); main.close();
  assert.equal(helper.release(main.id), true);
  assert.equal(main.visible, true);
  assert.equal(main.webContents.throttling, true);
  assert.equal(main.listenerCount('close'), 1);
  assert.equal(main.listeners('close')[0], main.hostClose);
  assert.equal(main.listenerCount('closed'), 0);
  assert.equal(main.webContents.listenerCount('destroyed'), 0);
  assert.equal(app.listenerCount('before-quit'), 0);
  assert.equal(app.listenerCount('activate'), 0);
  assert.equal(autoUpdater.listenerCount('before-quit-for-update'), 0);
  assert.equal(helper.release(main.id), false);
  assert.equal(main.close().defaultPrevented, false);
});

test('repeat installation has exactly one listener and release may preserve visibility', () => {
  const { helper, main, app } = fixture();
  helper.install(main.id); main.close(); helper.install(main.id);
  assert.equal(main.listenerCount('close'), 2);
  assert.equal(app.listenerCount('before-quit'), 1);
  assert.equal(app.listenerCount('activate'), 1);
  assert.equal(helper.status(main.id).hiddenByClose, true);
  helper.release(main.id, { showHidden: false });
  assert.equal(main.visible, false);
  assert.equal(main.webContents.throttling, true);
});

test('an earlier close cancellation is respected without hiding the window', () => {
  const { helper, main } = fixture();
  main.on('close', e => e.preventDefault());
  helper.install(main.id);
  main.close();
  assert.equal(main.visible, true);
  assert.equal(helper.status(main.id).hiddenByClose, false);
});

test('async renderer saving may cancel initial quit; retry finishes after all windows close', async () => {
  const { helper, main, app } = fixture();
  helper.install(main.id);
  let firstUnload = true;
  main.beforeUnload = e => {
    if (!firstUnload) return;
    firstUnload = false;
    e.preventDefault();
    queueMicrotask(() => main.close());
  };
  const exited = new Promise(resolve => app.once('quit', resolve));
  app.quit();
  assert.equal(main.destroyed, false);
  assert.equal(app.exited, undefined);
  await exited;
  assert.equal(main.destroyed, true);
  assert.equal(helper.status(main.id).retained, false);
  assert.equal(app.quitCalls, 2);
  assert.equal(app.listenerCount('window-all-closed'), 0);
  assert.equal(app.listenerCount('before-quit'), 0);
  assert.equal(app.listenerCount('activate'), 0);
  assert.equal(app.listenerCount('will-quit'), 0);
});

test('an unsaved-work refusal leaves every window intact and waits for user action', async () => {
  const { helper, main, app } = fixture();
  helper.install(main.id);
  main.beforeUnload = e => e.preventDefault();
  app.quit();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(main.destroyed, false);
  assert.equal(app.quitCalls, 1);
  assert.equal(app.exited, undefined);
  app.emit('activate');
  assert.equal(helper.status(main.id).quitting, false);
  assert.equal(helper.status(main.id).pendingQuit, false);
  assert.equal(app.listenerCount('window-all-closed'), 0);
  helper.release(main.id);
  assert.equal(app.listenerCount('activate'), 0);
  assert.equal(app.listenerCount('before-quit'), 0);
});

test('a newly opened vault window between all-closed and retry is never closed', async () => {
  const { helper, main, other, app } = fixture();
  helper.install(main.id);
  main.beforeUnload = e => e.preventDefault();
  app.quit();
  main.destroy();
  // Simulate another vault opening before the deferred quit continuation.
  other.destroyed = false;
  other.webContents.destroyed = false;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(other.destroyed, false);
  assert.equal(app.quitCalls, 1);
  assert.equal(app.listenerCount('window-all-closed'), 0);
  assert.equal(app.listenerCount('before-quit'), 0);
});

test('canceling the one deferred retry removes continuation and never loops', async () => {
  const { helper, main, app } = fixture();
  helper.install(main.id);
  main.beforeUnload = e => e.preventDefault();
  app.quit();
  app.on('before-quit', e => e.preventDefault());
  main.destroy();
  await new Promise(resolve => setImmediate(resolve));
  await Promise.resolve();
  assert.equal(app.quitCalls, 2);
  assert.equal(app.listenerCount('window-all-closed'), 0);
  assert.equal(app.listenerCount('activate'), 0);
  assert.equal(app.listenerCount('will-quit'), 0);
  app.emit('window-all-closed');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.quitCalls, 2);
});
