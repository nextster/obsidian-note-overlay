const { webContents } = require('electron');
const pending = new Map();
exports.arm = function (id) {
  exports.disarm(id);
  const wc = webContents.fromId(id);
  const original = wc?._windowOpenHandler;
  if (typeof original !== 'function') throw new Error('Unsupported Obsidian popup handler');
  const wrapper = details => {
    const result = original.call(wc, details);
    if (details.url !== 'about:blank' || !details.features?.startsWith('popup')) return result;
    exports.disarm(id);
    if (result?.action !== 'allow') return result;
    return { ...result, overrideBrowserWindowOptions: {
      ...result.overrideBrowserWindowOptions,
      type: 'panel', alwaysOnTop: true, fullscreenable: false, skipTaskbar: true,
      width: 700, height: 560, minWidth: 420, minHeight: 300
    }};
  };
  const timer = setTimeout(() => exports.disarm(id), 2000);
  pending.set(id, { wc, original, wrapper, timer });
  wc.setWindowOpenHandler(wrapper);
};
exports.disarm = function (id) {
  const state = pending.get(id);
  if (!state) return;
  clearTimeout(state.timer);
  if (!state.wc.isDestroyed() && state.wc._windowOpenHandler === state.wrapper)
    state.wc.setWindowOpenHandler(state.original);
  pending.delete(id);
};
