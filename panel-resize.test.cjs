const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installResize, resizeBounds } = require('./panel-resize.cjs');

class Target extends EventTarget {
  constructor() { super(); this.listeners = new Map(); }
  addEventListener(name, handler, options) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(handler);
    super.addEventListener(name, handler, options);
  }
  removeEventListener(name, handler, options) {
    this.listeners.get(name)?.delete(handler);
    super.removeEventListener(name, handler, options);
  }
  listenerCount() { return [...this.listeners.values()].reduce((count, handlers) => count + handlers.size, 0); }
}

function harness({ minimum = [420, 300], maximum = [0, 0], existingReady = false, tabClick } = {}) {
  const doc = new Target();
  const domWindow = new Target();
  const classes = new Set(existingReady ? ['note-panel-modifier-resize-ready'] : []);
  const captures = new Set();
  const styles = [];
  const frames = new Map();
  const timers = new Map();
  let nextId = 0;
  doc.body = {
    classList: {
      contains: name => classes.has(name),
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
    },
    setPointerCapture: id => captures.add(id),
    releasePointerCapture: id => captures.delete(id),
  };
  doc.head = { appendChild: style => styles.push(style) };
  doc.createElement = () => ({ textContent: '', remove() { styles.splice(styles.indexOf(this), 1); } });
  domWindow.document = doc;
  domWindow.requestAnimationFrame = fn => { const id = ++nextId; frames.set(id, fn); return id; };
  domWindow.cancelAnimationFrame = id => frames.delete(id);
  domWindow.setTimeout = fn => { const id = ++nextId; timers.set(id, fn); return id; };
  domWindow.clearTimeout = id => timers.delete(id);
  const native = new EventEmitter();
  native.bounds = { x: -80, y: 30, width: 700, height: 560 };
  native.sizes = [];
  native.getBounds = () => ({ ...native.bounds });
  native.getMinimumSize = () => minimum;
  native.getMaximumSize = () => maximum;
  native.isDestroyed = () => Boolean(native.destroyed);
  native.setSize = (width, height, animate) => {
    native.sizes.push([width, height, animate]);
    Object.assign(native.bounds, { width, height });
  };
  const errors = [];
  if (tabClick) doc.addEventListener('click', tabClick, true);
  const interaction = installResize(domWindow, native, error => errors.push(error));
  const event = (target, name, fields = {}) => {
    const value = new Event(name, { cancelable: true });
    Object.assign(value, { pointerId: 7, button: 0, detail: 1, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, screenX: 100, screenY: 100 }, fields);
    if (target === doc) domWindow.dispatchEvent(value);
    if (!value.cancelBubble) target.dispatchEvent(value);
    return value;
  };
  const run = queue => { const pending = [...queue.values()]; queue.clear(); for (const fn of pending) fn(); };
  return { doc, domWindow, native, classes, captures, styles, frames, timers, errors, interaction, event,
    frame: () => run(frames), expire: () => run(timers) };
}

const modifiers = { shiftKey: true, altKey: true };

test('resizing anchors the top-left corner and respects each native limit', () => {
  const bounds = { x: -80, y: 30, width: 700, height: 560 };
  assert.deepEqual(resizeBounds(bounds, 400, -800, [420, 300], [900, 1000]), { x: -80, y: 30, width: 900, height: 300 });
  assert.deepEqual(resizeBounds(bounds, -800, 2000, [0, 0], [0, 0]), { x: -80, y: 30, width: 1, height: 2560 });
  assert.deepEqual(resizeBounds(bounds, -800, -800), { x: -80, y: 30, width: 420, height: 300 });
  assert.deepEqual(bounds, { x: -80, y: 30, width: 700, height: 560 });
});

test('ordinary editor input and modified non-left clicks remain untouched', () => {
  const h = harness();
  for (const fields of [{}, { shiftKey: true }, { altKey: true }, { ...modifiers, ctrlKey: true }, { ...modifiers, metaKey: true }, { ...modifiers, button: 2 }]) {
    assert.equal(h.event(h.doc, 'pointerdown', fields).defaultPrevented, false);
    assert.equal(h.event(h.doc, 'pointerup', fields).defaultPrevented, false);
    assert.equal(h.event(h.doc, 'click', fields).defaultPrevented, false);
  }
  assert.equal(h.captures.size, 0);
  assert.deepEqual(h.native.sizes, []);
  h.interaction.dispose();
});

test('a modified drag anywhere batches moves and flushes its final outside position', () => {
  const h = harness();
  h.event(h.domWindow, 'keydown', { ...modifiers, key: 'Alt' });
  assert.equal(h.classes.has('note-panel-modifier-resize-ready'), true);
  assert.match(h.styles[0].textContent, /-webkit-app-region: no-drag !important/);
  assert.equal(h.event(h.doc, 'pointerdown', modifiers).defaultPrevented, true);
  assert.deepEqual([...h.captures], [7]);
  h.event(h.doc, 'pointermove', { ...modifiers, screenX: 200, screenY: 160 });
  h.event(h.doc, 'pointermove', { ...modifiers, screenX: 300, screenY: 200 });
  assert.equal(h.frames.size, 1);
  assert.deepEqual(h.native.sizes, []);
  h.frame();
  assert.deepEqual(h.native.sizes, [[900, 660, false]]);
  // Pointer capture delivers this even when the pointer has left the panel.
  h.event(h.doc, 'pointerup', { ...modifiers, screenX: 400, screenY: 250 });
  assert.deepEqual(h.native.sizes, [[900, 660, false], [1000, 710, false]]);
  assert.deepEqual(h.native.bounds, { x: -80, y: 30, width: 1000, height: 710 });
  assert.equal(h.captures.size, 0);
  assert.equal(h.event(h.doc, 'click', modifiers).defaultPrevented, true);
  assert.equal(h.event(h.doc, 'contextmenu', modifiers).defaultPrevented, true);
  assert.equal(h.event(h.doc, 'pointerdown').defaultPrevented, false);
  assert.equal(h.event(h.doc, 'click').defaultPrevented, false);
  h.interaction.dispose();
});

test('releasing a modifier stops size changes while consuming the original drag click', () => {
  const h = harness();
  h.event(h.doc, 'pointerdown', modifiers);
  h.event(h.doc, 'pointermove', { ...modifiers, screenX: 160, screenY: 140 });
  h.event(h.domWindow, 'keyup', { shiftKey: true, key: 'Alt' });
  assert.deepEqual(h.native.sizes, [[760, 600, false]]);
  assert.equal(h.classes.has('note-panel-modifier-resizing'), false);
  assert.equal(h.classes.has('note-panel-modifier-resize-ready'), false);
  h.event(h.doc, 'pointermove', { shiftKey: true, screenX: 500, screenY: 500 });
  h.event(h.doc, 'pointerup', { shiftKey: true, screenX: 500, screenY: 500 });
  assert.deepEqual(h.native.sizes, [[760, 600, false]]);
  assert.equal(h.captures.size, 0);
  assert.equal(h.event(h.doc, 'click').defaultPrevented, true);
  h.expire();
  assert.equal(h.event(h.doc, 'contextmenu').defaultPrevented, false);
  h.interaction.dispose();
});

test('canceled pointers finish pending size changes and then allow ordinary editing', () => {
  const h = harness({ maximum: [750, 600] });
  h.event(h.doc, 'pointerdown', modifiers);
  h.event(h.doc, 'pointermove', { ...modifiers, screenX: 400, screenY: 400 });
  h.event(h.doc, 'pointercancel', modifiers);
  assert.deepEqual(h.native.sizes, [[750, 600, false]]);
  assert.equal(h.captures.size, 0);
  assert.equal(h.classes.has('note-panel-modifier-resizing'), false);
  h.event(h.doc, 'pointerdown');
  assert.equal(h.event(h.doc, 'click').defaultPrevented, false);
  h.frame();
  assert.equal(h.native.sizes.length, 1);
  h.interaction.dispose();
});

test('focus loss, native hiding, and explicit cancellation reset the modifier mode', () => {
  const h = harness();
  const resetters = [() => h.event(h.domWindow, 'blur'), () => h.native.emit('hide'), () => h.interaction.cancel()];
  for (const reset of resetters) {
    h.event(h.doc, 'pointerdown', modifiers);
    h.event(h.doc, 'pointermove', { ...modifiers, screenX: 120, screenY: 130 });
    reset();
    assert.equal(h.captures.size, 0);
    assert.equal(h.classes.size, 0);
    assert.equal(h.frames.size, 0);
    assert.equal(h.timers.size, 0);
    assert.equal(h.event(h.doc, 'click').defaultPrevented, false);
  }
  h.native.destroyed = true;
  h.native.emit('closed');
  assert.deepEqual(h.errors, []);
  h.interaction.dispose();
});

test('disposal is repeatable, preserves existing styles, and removes every listener', () => {
  const h = harness({ existingReady: true });
  const userStyle = { textContent: 'body { cursor: text; }' };
  h.styles.push(userStyle);
  h.event(h.doc, 'pointerdown', modifiers);
  h.event(h.doc, 'pointermove', { ...modifiers, screenX: 150, screenY: 150 });
  h.interaction.dispose();
  h.interaction.dispose();
  assert.deepEqual([...h.classes], ['note-panel-modifier-resize-ready']);
  assert.deepEqual(h.styles, [userStyle]);
  assert.equal(h.captures.size, 0);
  assert.equal(h.doc.listenerCount(), 0);
  assert.equal(h.domWindow.listenerCount(), 0);
  assert.equal(h.native.listenerCount('hide'), 0);
  assert.equal(h.native.listenerCount('closed'), 0);
  assert.equal(h.frames.size, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.event(h.doc, 'pointerdown', modifiers).defaultPrevented, false);
});

test('native errors terminate the gesture and are reported once', () => {
  const h = harness();
  const error = new Error('Native panel became unavailable');
  h.native.setSize = () => { throw error; };
  h.event(h.doc, 'pointerdown', modifiers);
  h.event(h.doc, 'pointermove', { ...modifiers, screenX: 200, screenY: 200 });
  h.frame();
  assert.deepEqual(h.errors, [error]);
  assert.equal(h.captures.size, 0);
  assert.equal(h.classes.size, 0);
  h.event(h.doc, 'pointermove', { ...modifiers, screenX: 300, screenY: 300 });
  h.frame();
  assert.deepEqual(h.errors, [error]);
  h.interaction.dispose();
});

test('a resize begun on a tab blocks its existing document-level click action', () => {
  let selectedTabs = 0;
  const h = harness({ tabClick: () => { selectedTabs++; } });
  h.event(h.doc, 'pointerdown', modifiers);
  h.event(h.doc, 'pointermove', { ...modifiers, screenX: 160, screenY: 140 });
  h.event(h.doc, 'pointerup', { ...modifiers, screenX: 160, screenY: 140 });
  h.event(h.doc, 'click', modifiers);
  assert.equal(selectedTabs, 0);
  h.event(h.doc, 'pointerdown');
  h.event(h.doc, 'click');
  assert.equal(selectedTabs, 1);
  h.interaction.dispose();
});

test('modified resize input cannot reach a document-level editor pointer handler', () => {
  const h = harness();
  let editorInput = 0;
  h.doc.addEventListener('pointerdown', () => { editorInput++; }, true);
  h.event(h.doc, 'pointerdown', modifiers);
  h.event(h.doc, 'pointerup', modifiers);
  assert.equal(editorInput, 0);
  h.event(h.doc, 'pointerdown');
  assert.equal(editorInput, 1);
  h.interaction.dispose();
});

test('closing a native panel removes its interaction and allows a clean replacement', () => {
  const h = harness();
  h.event(h.doc, 'pointerdown', { ...modifiers, buttons: 1 });
  h.event(h.doc, 'pointermove', { ...modifiers, buttons: 1, screenX: 160, screenY: 140 });
  h.native.destroyed = true;
  h.native.emit('closed');
  assert.equal(h.domWindow.listenerCount(), 0);
  assert.equal(h.native.listenerCount('hide'), 0);
  assert.equal(h.native.listenerCount('closed'), 0);
  assert.equal(h.styles.length, 0);
  assert.equal(h.classes.size, 0);
  assert.equal(h.captures.size, 0);
  assert.equal(h.frames.size, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.event(h.doc, 'pointerdown', modifiers).defaultPrevented, false);
  assert.deepEqual(h.native.sizes, []);

  const replacement = new EventEmitter();
  replacement.getBounds = () => ({ x: 30, y: 40, width: 700, height: 560 });
  replacement.getMinimumSize = () => [420, 300];
  replacement.getMaximumSize = () => [0, 0];
  replacement.isDestroyed = () => false;
  replacement.sizes = [];
  replacement.setSize = (...size) => replacement.sizes.push(size);
  const interaction = installResize(h.domWindow, replacement, error => h.errors.push(error));
  h.event(h.doc, 'pointerdown', modifiers);
  h.event(h.doc, 'pointerup', { ...modifiers, screenX: 150, screenY: 130 });
  assert.deepEqual(replacement.sizes, [[750, 590, false]]);
  assert.deepEqual(h.native.sizes, []);
  assert.deepEqual(h.errors, []);
  interaction.dispose();
  h.interaction.dispose();
  assert.equal(h.domWindow.listenerCount(), 0);
  assert.equal(h.styles.length, 0);
});

test('releasing left while right stays down stops resizing and consumes the remaining gesture', () => {
  const h = harness();
  h.event(h.doc, 'pointerdown', { ...modifiers, buttons: 1 });
  h.event(h.doc, 'pointermove', { ...modifiers, buttons: 3, screenX: 140, screenY: 120 });
  h.event(h.doc, 'pointermove', { ...modifiers, buttons: 2, screenX: 200, screenY: 180 });
  assert.deepEqual(h.native.sizes, [[740, 580, false]]);
  assert.equal(h.classes.has('note-panel-modifier-resizing'), false);
  assert.deepEqual([...h.captures], [7]);
  h.event(h.doc, 'pointermove', { ...modifiers, buttons: 2, screenX: 400, screenY: 400 });
  h.event(h.doc, 'pointerup', { ...modifiers, button: 2, buttons: 0, screenX: 400, screenY: 400 });
  assert.deepEqual(h.native.sizes, [[740, 580, false]]);
  assert.equal(h.captures.size, 0);
  assert.equal(h.event(h.doc, 'auxclick', { ...modifiers, button: 2, buttons: 0 }).defaultPrevented, true);
  h.event(h.doc, 'pointerdown', { buttons: 1 });
  assert.equal(h.event(h.doc, 'click', { buttons: 0 }).defaultPrevented, false);
  h.interaction.dispose();
});

test('a move with no pressed buttons recovers from a missed pointerup', () => {
  const h = harness();
  h.event(h.doc, 'pointerdown', { ...modifiers, buttons: 1 });
  h.event(h.doc, 'pointermove', { ...modifiers, buttons: 1, screenX: 130, screenY: 140 });
  h.event(h.doc, 'pointermove', { ...modifiers, buttons: 0, screenX: 500, screenY: 500 });
  assert.deepEqual(h.native.sizes, [[730, 600, false]]);
  assert.equal(h.captures.size, 0);
  assert.equal(h.classes.has('note-panel-modifier-resizing'), false);
  h.event(h.doc, 'pointermove', { ...modifiers, buttons: 0, screenX: 600, screenY: 600 });
  h.frame();
  assert.deepEqual(h.native.sizes, [[730, 600, false]]);
  h.expire();
  assert.equal(h.event(h.doc, 'click').defaultPrevented, false);
  h.interaction.dispose();
});
