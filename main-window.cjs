'use strict';

// Loaded with @electron/remote.require(), so all listeners live in the main
// process. A normal window close hides the owning vault window and preserves
// its renderer, workspace, plugin, and local shortcut server. App quit and
// updater quit keep Obsidian's ordinary save/unload lifecycle.
//
// Obsidian 1.13.7 sets BrowserWindow.closing before the close event can be
// cancelled. Reset that private flag only when we cancel a close; otherwise a
// later renderer reload can incorrectly enter Obsidian's quit/save path.
// This needs re-verification when Obsidian changes its private window lifecycle.

const { app, BrowserWindow, autoUpdater } = require('electron');
const retained = new Map();
let pendingQuit = null;

function clearQuitIntent(resume = false) {
  const quit = pendingQuit;
  if (!quit) return;
  pendingQuit = null;
  if (quit.retryTimer) clearImmediate(quit.retryTimer);
  app.removeListener('before-quit', quit.onBeforeQuit);
  app.removeListener('window-all-closed', quit.onAllClosed);
  app.removeListener('will-quit', quit.onWillQuit);
  app.removeListener('activate', quit.onActivate);
  if (resume) for (const state of retained.values()) state.quitting = false;
}

function rememberQuitIntent(event) {
  if (pendingQuit) {
    pendingQuit.onBeforeQuit(event);
    return;
  }
  const quit = { retried: false, retryTimer: null };
  quit.onBeforeQuit = quitEvent => {
    // Observe cancellation after every listener, including during our retry.
    queueMicrotask(() => {
      if (pendingQuit === quit && quitEvent?.defaultPrevented) clearQuitIntent(true);
    });
  };
  quit.onAllClosed = () => {
    if (quit.retried || quit.retryTimer) return;
    // Obsidian can cancel the initial quit while its renderer saves or closes
    // popouts, then close its windows asynchronously. macOS otherwise keeps the
    // process running. Continue only that explicit quit, after every window is
    // gone; never close another vault window or bypass its beforeunload prompt.
    quit.retryTimer = setImmediate(() => {
      quit.retryTimer = null;
      if (pendingQuit !== quit || quit.retried) return;
      if (BrowserWindow.getAllWindows().some(win => !win.isDestroyed())) {
        clearQuitIntent(true);
        return;
      }
      quit.retried = true;
      app.quit();
    });
  };
  quit.onWillQuit = () => clearQuitIntent();
  quit.onActivate = () => clearQuitIntent(true);
  pendingQuit = quit;
  app.on('before-quit', quit.onBeforeQuit);
  app.on('window-all-closed', quit.onAllClosed);
  app.on('will-quit', quit.onWillQuit);
  app.on('activate', quit.onActivate);
  quit.onBeforeQuit(event);
}

function release(windowId, { showHidden = true } = {}) {
  const state = retained.get(windowId);
  if (!state) return false;
  retained.delete(windowId);
  const { win, contents } = state;
  win.removeListener('close', state.onClose);
  win.removeListener('closed', state.onClosed);
  win.removeListener('show', state.onShow);
  contents.removeListener('destroyed', state.onDestroyed);
  app.removeListener('before-quit', state.onBeforeQuit);
  app.removeListener('activate', state.onActivate);
  autoUpdater?.removeListener('before-quit-for-update', state.onBeforeQuitForUpdate);
  if (!contents.isDestroyed()) {
    contents.setBackgroundThrottling(state.backgroundThrottling);
  }
  // Disabling the plugin must not strand a hidden main window. The caller may
  // suppress this when replacing a plugin instance without changing visibility.
  if (showHidden && state.hiddenByClose && !state.quitting && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  return true;
}

function install(windowId) {
  if (retained.has(windowId)) return windowId;
  const win = BrowserWindow.fromId(windowId);
  if (!win || win.isDestroyed()) throw new Error('Owning Obsidian window was not found');
  const contents = win.webContents;
  if (contents.isDestroyed()) throw new Error('Owning Obsidian renderer was not found');
  const state = {
    win, contents, hiddenByClose: false, quitting: false, updating: false,
    backgroundThrottling: contents.getBackgroundThrottling()
  };

  state.onBeforeQuit = event => {
    state.quitting = true;
    if (state.updating) {
      // The updater owns its own window shutdown and restart sequence.
      queueMicrotask(() => {
        if (retained.get(windowId) === state && event?.defaultPrevented) {
          state.quitting = false;
          state.updating = false;
        }
      });
      return;
    }
    rememberQuitIntent(event);
  };
  state.onBeforeQuitForUpdate = () => {
    state.quitting = true;
    state.updating = true;
    clearQuitIntent();
  };
  state.onClose = event => {
    if (state.quitting || win.isDestroyed() || event.defaultPrevented) return;
    event.preventDefault();
    if (win.closing === true) win.closing = false;
    state.hiddenByClose = true;
    win.hide();
  };
  state.onActivate = () => {
    // Electron has no general quit-cancelled event. A later explicit Dock/app
    // activation also resumes protection after a DOM beforeunload cancellation.
    state.quitting = false;
    state.updating = false;
    if (!state.hiddenByClose || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };
  state.onShow = () => { state.hiddenByClose = false; };
  state.onClosed = () => release(windowId, { showHidden: false });
  state.onDestroyed = () => release(windowId, { showHidden: false });

  retained.set(windowId, state);
  contents.setBackgroundThrottling(false);
  // Append after Obsidian's listener. Do not replace or remove host listeners.
  win.on('close', state.onClose);
  win.on('closed', state.onClosed);
  win.on('show', state.onShow);
  contents.on('destroyed', state.onDestroyed);
  app.on('before-quit', state.onBeforeQuit);
  app.on('activate', state.onActivate);
  autoUpdater?.on('before-quit-for-update', state.onBeforeQuitForUpdate);
  return windowId;
}

function status(windowId) {
  const state = retained.get(windowId);
  const win = state?.win || BrowserWindow.fromId(windowId);
  return {
    id: windowId, retained: !!state, hiddenByClose: !!state?.hiddenByClose,
    quitting: !!state?.quitting, exists: !!win && !win.isDestroyed(),
    visible: !!win && !win.isDestroyed() && win.isVisible(),
    closing: !!win && !win.isDestroyed() && win.closing === true,
    pendingQuit: !!pendingQuit
  };
}

module.exports = { install, release, status };
