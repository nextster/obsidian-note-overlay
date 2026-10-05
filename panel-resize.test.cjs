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

const modifiers = { shiftKey: true, altKey: true };

function harness({ minimum = [420, 300], maximum = [0, 0], existingReady = false } = {}) {
  const domWindow = new Target();
  const classes = new Set(existingReady ? ['note-panel-modifier-resize-ready'] : []);
  const styles = [];
  const intervals = new Map();
  let nextId = 0;
  const doc = {
    body: { classList: {
      contains: name => classes.has(name),
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
    } },
    head: { appendChild: style => styles.push(style) },
    createElement: () => ({ textContent: '', remove() { styles.splice(styles.indexOf(this), 1); } }),
  };
  domWindow.document = doc;
  domWindow.setInterval = (fn, delay) => { assert.equal(delay, 16); const id = ++nextId; intervals.set(id, fn); return id; };
  domWindow.clearInterval = id => intervals.delete(id);
  const native = new EventEmitter();
  native.bounds = { x: -80, y: 30, width: 700, height: 560 };
  native.focused = true;
  native.visible = true;
  native.changes = [];
  native.getBounds = () => ({ ...native.bounds });
  native.getMinimumSize = () => minimum;
  native.getMaximumSize = () => maximum;
  native.isDestroyed = () => Boolean(native.destroyed);
  native.isFocused = () => native.focused;
  native.isVisible = () => native.visible;
  native.setBounds = (bounds, animate) => {
    native.changes.push([{ ...bounds }, animate]);
    native.bounds = { ...bounds };
  };
  const cursor = { x: 100, y: 100 };
  const errors = [];
  let cursorReads = 0;
  const options = { getCursor: () => { cursorReads++; return cursor; } };
  const interaction = installResize(domWindow, native, error => errors.push(error), options);
  const event = (name, fields = {}) => {
    const value = new Event(name, { cancelable: true });
    Object.assign(value, { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }, fields);
    domWindow.dispatchEvent(value);
    return value;
  };
  const start = () => {
    event('keydown', { shiftKey: true, key: 'Shift' });
    event('keydown', { ...modifiers, key: 'Alt' });
  };
  const tick = () => { for (const fn of [...intervals.values()]) fn(); };
  return { doc, domWindow, native, classes, styles, intervals, cursor, errors, options, interaction, event, start, tick,
    cursorReads: () => cursorReads };
}

test('horizontal resizing is symmetric around the initial center while its top remains fixed', () => {
  const bounds = { x: -80, y: 30, width: 700, height: 560 };
  assert.deepEqual(resizeBounds(bounds, 50, 40), { x: -130, y: 30, width: 800, height: 600 });
  assert.deepEqual(resizeBounds(bounds, -50, -40), { x: -30, y: 30, width: 600, height: 520 });
  assert.deepEqual(bounds, { x: -80, y: 30, width: 700, height: 560 });
});

test('native limits clamp both dimensions without moving the center or top', () => {
  const bounds = { x: -80, y: 30, width: 700, height: 560 };
  assert.deepEqual(resizeBounds(bounds, 400, -800, [420, 300], [900, 1000]), { x: -180, y: 30, width: 900, height: 300 });
  assert.deepEqual(resizeBounds(bounds, -800, 2000, [0, 0], [0, 0]), { x: 270, y: 30, width: 1, height: 2560 });
  assert.deepEqual(resizeBounds(bounds, -800, -800), { x: 60, y: 30, width: 420, height: 300 });
  assert.deepEqual(resizeBounds({ x: 5, y: 15, width: 701, height: 561 }, 0.3, 0.4), { x: 5, y: 15, width: 702, height: 561 });
});

test('the key chord starts without a click and polls the global cursor outside the panel', () => {
  const h = harness();
  assert.equal(h.cursorReads(), 0);
  h.start();
  assert.equal(h.intervals.size, 1);
  assert.equal(h.cursorReads(), 1);
  assert.equal(h.classes.has('note-panel-modifier-resizing'), true);
  // No DOM mouse event is sent: only the screen cursor provider changes.
  Object.assign(h.cursor, { x: 1100, y: -200 });
  h.tick();
  assert.deepEqual(h.native.changes, [[{ x: -1080, y: 30, width: 2700, height: 300 }, false]]);
  h.tick();
  assert.equal(h.native.changes.length, 1);
  h.event('keyup', { shiftKey: true, key: 'Alt' });
  assert.equal(h.intervals.size, 0);
  assert.equal(h.classes.size, 0);
  Object.assign(h.cursor, { x: 2000, y: 2000 });
  h.tick();
  assert.equal(h.native.changes.length, 1);
  h.interaction.dispose();
});

test('key repeat keeps the original cursor anchor and does not add polling loops', () => {
  const h = harness();
  h.start();
  Object.assign(h.cursor, { x: 150, y: 140 });
  h.tick();
  h.event('keydown', { ...modifiers, key: 'Alt', repeat: true });
  Object.assign(h.cursor, { x: 180, y: 160 });
  h.tick();
  assert.equal(h.intervals.size, 1);
  assert.deepEqual(h.native.changes, [
    [{ x: -130, y: 30, width: 800, height: 600 }, false],
    [{ x: -160, y: 30, width: 860, height: 620 }, false],
  ]);
  h.interaction.dispose();
});

test('ordinary editor keys, clicks, and mouse events remain untouched', () => {
  const h = harness();
  let editorEvents = 0;
  for (const name of ['keydown', 'pointerdown', 'pointermove', 'pointerup', 'click', 'contextmenu']) {
    h.domWindow.addEventListener(name, () => { editorEvents++; });
  }
  for (const fields of [{}, { shiftKey: true }, { altKey: true }, { ...modifiers, ctrlKey: true }, { ...modifiers, metaKey: true }]) {
    assert.equal(h.event('keydown', fields).defaultPrevented, false);
  }
  assert.equal(h.intervals.size, 0);
  h.start();
  for (const name of ['pointerdown', 'pointermove', 'pointerup', 'click', 'contextmenu']) {
    assert.equal(h.event(name, { ...modifiers, button: 0, buttons: 1 }).defaultPrevented, false);
  }
  assert.equal(editorEvents, 12);
  assert.deepEqual(h.native.changes, []);
  h.interaction.dispose();
});

test('focus loss stops polling and key repeat cannot resume without a new chord', () => {
  const h = harness();
  h.start();
  Object.assign(h.cursor, { x: 200, y: 200 });
  h.native.focused = false;
  h.tick();
  assert.equal(h.intervals.size, 0);
  assert.equal(h.classes.size, 0);
  assert.deepEqual(h.native.changes, []);
  h.native.focused = true;
  h.event('keydown', { ...modifiers, key: 'Alt', repeat: true });
  h.event('keydown', { ...modifiers, key: 'a' });
  assert.equal(h.intervals.size, 0);
  h.start();
  Object.assign(h.cursor, { x: 240, y: 230 });
  h.tick();
  assert.deepEqual(h.native.changes, [[{ x: -120, y: 30, width: 780, height: 590 }, false]]);
  h.interaction.dispose();
});

test('a hidden or unfocused panel never starts and visibility loss cancels an active resize', () => {
  const h = harness();
  h.native.focused = false;
  h.start();
  assert.equal(h.intervals.size, 0);
  assert.equal(h.cursorReads(), 0);
  h.native.focused = true;
  h.native.visible = false;
  h.start();
  assert.equal(h.intervals.size, 0);
  h.native.visible = true;
  h.start();
  h.native.visible = false;
  Object.assign(h.cursor, { x: 500, y: 500 });
  h.tick();
  assert.equal(h.intervals.size, 0);
  assert.equal(h.classes.size, 0);
  assert.deepEqual(h.native.changes, []);
  h.interaction.dispose();
});

test('keyup, DOM/native blur, native hide, and explicit cancellation stop the gesture immediately', () => {
  const h = harness();
  const resetters = [
    () => h.event('keyup', { altKey: true, key: 'Shift' }),
    () => h.event('blur'),
    () => h.native.emit('blur'),
    () => h.native.emit('hide'),
    () => h.interaction.cancel(),
  ];
  for (const reset of resetters) {
    h.start();
    assert.equal(h.intervals.size, 1);
    reset();
    assert.equal(h.intervals.size, 0);
    assert.equal(h.classes.size, 0);
  }
  h.interaction.dispose();
});

test('native close disposes every listener and style before a replacement is installed', () => {
  const h = harness();
  h.start();
  h.native.destroyed = true;
  h.native.emit('closed');
  assert.equal(h.domWindow.listenerCount(), 0);
  assert.equal(h.native.listenerCount('blur'), 0);
  assert.equal(h.native.listenerCount('hide'), 0);
  assert.equal(h.native.listenerCount('closed'), 0);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.styles.length, 0);
  assert.equal(h.classes.size, 0);
  h.native.destroyed = false;
  const replacement = installResize(h.domWindow, h.native, error => h.errors.push(error), h.options);
  h.start();
  Object.assign(h.cursor, { x: 150, y: 140 });
  h.tick();
  assert.deepEqual(h.native.changes, [[{ x: -130, y: 30, width: 800, height: 600 }, false]]);
  replacement.dispose();
  h.interaction.dispose();
  assert.equal(h.domWindow.listenerCount(), 0);
  assert.equal(h.styles.length, 0);
});

test('repeat disposal preserves existing classes and user styles', () => {
  const h = harness({ existingReady: true });
  const userStyle = { textContent: 'body { cursor: text; }' };
  h.styles.push(userStyle);
  h.start();
  h.interaction.dispose();
  h.interaction.dispose();
  assert.deepEqual([...h.classes], ['note-panel-modifier-resize-ready']);
  assert.deepEqual(h.styles, [userStyle]);
  assert.equal(h.domWindow.listenerCount(), 0);
  assert.equal(h.native.listenerCount('blur'), 0);
  assert.equal(h.native.listenerCount('hide'), 0);
  assert.equal(h.native.listenerCount('closed'), 0);
  assert.equal(h.intervals.size, 0);
});

test('native bounds failures stop polling and report the error once', () => {
  const h = harness();
  const error = new Error('Native panel became unavailable');
  h.native.setBounds = () => { throw error; };
  h.start();
  Object.assign(h.cursor, { x: 200, y: 200 });
  h.tick();
  assert.deepEqual(h.errors, [error]);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.classes.size, 0);
  h.tick();
  assert.deepEqual(h.errors, [error]);
  h.interaction.dispose();
});
