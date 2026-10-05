const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installResize, resizeBounds, nearestCorner, moveBounds } = require('./panel-resize.cjs');

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
  const startMove = () => event('keydown', { altKey: true, key: 'Alt' });
  const tick = () => { for (const fn of [...intervals.values()]) fn(); };
  return { doc, domWindow, native, classes, styles, intervals, cursor, errors, options, interaction, event, start, startMove, tick,
    cursorReads: () => cursorReads };
}

test('each corner follows the pointer one-to-one while the opposite corner stays fixed', () => {
  const bounds = { x: -80, y: 30, width: 700, height: 560 };
  const cases = [
    ['nw', { x: -30, y: 70, width: 650, height: 520 }],
    ['ne', { x: -80, y: 70, width: 750, height: 520 }],
    ['sw', { x: -30, y: 30, width: 650, height: 600 }],
    ['se', { x: -80, y: 30, width: 750, height: 600 }],
  ];
  for (const [corner, expected] of cases) assert.deepEqual(resizeBounds(bounds, 50, 40, [420, 300], [0, 0], corner), expected);
  assert.deepEqual(bounds, { x: -80, y: 30, width: 700, height: 560 });
});

test('native limits keep the opposite corner anchored even when dragged past it', () => {
  const bounds = { x: -80, y: 30, width: 700, height: 560 };
  const cases = [
    ['nw', -1000, -1000, { x: -280, y: -410, width: 900, height: 1000 }],
    ['ne', -1000, 1000, { x: -80, y: 290, width: 420, height: 300 }],
    ['sw', 1000, -1000, { x: 200, y: 30, width: 420, height: 300 }],
    ['se', 1000, 1000, { x: -80, y: 30, width: 900, height: 1000 }],
  ];
  for (const [corner, dx, dy, expected] of cases) assert.deepEqual(resizeBounds(bounds, dx, dy, [420, 300], [900, 1000], corner), expected);
  assert.deepEqual(resizeBounds(bounds, -800, 2000, [0, 0], [0, 0]), { x: -80, y: 30, width: 1, height: 2560 });
  assert.deepEqual(resizeBounds(bounds, -800, -800), { x: -80, y: 30, width: 420, height: 300 });
  assert.deepEqual(resizeBounds({ x: 5, y: 15, width: 701, height: 561 }, 0.7, 0.7), { x: 5, y: 15, width: 702, height: 562 });
});

test('nearest corner works outside the rectangle, at negative coordinates, and at center ties', () => {
  const bounds = { x: -900, y: -800, width: 400, height: 200 };
  const cases = [
    [{ x: -2000, y: -2000 }, 'nw'],
    [{ x: 1000, y: -2000 }, 'ne'],
    [{ x: -2000, y: 1000 }, 'sw'],
    [{ x: 1000, y: 1000 }, 'se'],
    [{ x: -700, y: -700 }, 'se'],
    [{ x: -700, y: -701 }, 'ne'],
    [{ x: -701, y: -700 }, 'sw'],
  ];
  for (const [cursor, expected] of cases) assert.equal(nearestCorner(bounds, cursor), expected);
});

test('the key chord starts without a click and polls the global cursor outside the panel', () => {
  const h = harness();
  assert.equal(h.cursorReads(), 0);
  h.start();
  assert.equal(h.intervals.size, 1);
  assert.equal(h.cursorReads(), 1);
  assert.equal(h.classes.has('note-panel-modifier-resizing'), true);
  h.tick();
  assert.deepEqual(h.native.changes, []);
  // No DOM mouse event is sent: only the screen cursor provider changes.
  Object.assign(h.cursor, { x: 1100, y: -200 });
  h.tick();
  assert.deepEqual(h.native.changes, [[{ x: 200, y: -270, width: 420, height: 860 }, false]]);
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
    [{ x: -30, y: 70, width: 650, height: 520 }, false],
    [{ x: 0, y: 90, width: 620, height: 500 }, false],
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
  assert.deepEqual(h.native.changes, [[{ x: -40, y: 60, width: 660, height: 530 }, false]]);
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

test('Alt release, DOM/native blur, hide, and cancellation stop both modes immediately', () => {
  const h = harness();
  const resetters = [
    () => h.event('keyup', { key: 'Alt' }),
    () => h.event('blur'),
    () => h.native.emit('blur'),
    () => h.native.emit('hide'),
    () => h.interaction.cancel(),
  ];
  for (const start of [h.start, h.startMove]) {
    for (const reset of resetters) {
      start();
      assert.equal(h.intervals.size, 1);
      reset();
      assert.equal(h.intervals.size, 0);
      assert.equal(h.classes.size, 0);
    }
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
  assert.deepEqual(h.native.changes, [[{ x: -30, y: 70, width: 650, height: 520 }, false]]);
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

test('the initial cursor picks every corner and shows the matching diagonal cursor', () => {
  const cases = [
    [{ x: 100, y: 100 }, { x: -50, y: 50, width: 670, height: 540 }, false],
    [{ x: 500, y: 100 }, { x: -80, y: 50, width: 730, height: 540 }, true],
    [{ x: 100, y: 500 }, { x: -50, y: 30, width: 670, height: 580 }, true],
    [{ x: 500, y: 500 }, { x: -80, y: 30, width: 730, height: 580 }, false],
  ];
  for (const [cursor, expected, nesw] of cases) {
    const h = harness();
    Object.assign(h.cursor, cursor);
    h.start();
    assert.equal(h.classes.has('note-panel-modifier-resize-nesw'), nesw);
    Object.assign(h.cursor, { x: cursor.x + 30, y: cursor.y + 20 });
    h.tick();
    assert.deepEqual(h.native.changes, [[expected, false]]);
    h.interaction.cancel();
    assert.equal(h.classes.size, 0);
    h.interaction.dispose();
  }
});

test('crossing the window center never switches the selected corner or its original anchor', () => {
  const h = harness();
  h.start();
  Object.assign(h.cursor, { x: 500, y: 500 });
  h.tick();
  assert.deepEqual(h.native.changes, [[{ x: 200, y: 290, width: 420, height: 300 }, false]]);
  Object.assign(h.cursor, { x: 180, y: 180 });
  h.tick();
  assert.deepEqual(h.native.changes[1], [{ x: 0, y: 110, width: 620, height: 480 }, false]);
  h.interaction.dispose();
});

test('moving changes only the origin and preserves the initial size', () => {
  const bounds = { x: -80, y: 30, width: 700, height: 560 };
  assert.deepEqual(moveBounds(bounds, 25, -40), { x: -55, y: -10, width: 700, height: 560 });
  assert.deepEqual(moveBounds(bounds, -1000, 2000), { x: -1080, y: 2030, width: 700, height: 560 });
  assert.deepEqual(bounds, { x: -80, y: 30, width: 700, height: 560 });
});

test('Option alone starts moving without clicks and stops polling when released', () => {
  const h = harness();
  assert.equal(h.cursorReads(), 0);
  h.startMove();
  assert.equal(h.intervals.size, 1);
  assert.equal(h.classes.has('note-panel-modifier-moving'), true);
  assert.equal(h.classes.has('note-panel-modifier-resizing'), false);
  assert.equal(h.classes.has('note-panel-modifier-resize-ready'), false);
  h.tick();
  assert.deepEqual(h.native.changes, []);
  Object.assign(h.cursor, { x: 1100, y: -200 });
  h.tick();
  assert.deepEqual(h.native.changes, [[{ x: 920, y: -270, width: 700, height: 560 }, false]]);
  const reads = h.cursorReads();
  h.event('keydown', { altKey: true, key: 'Alt' });
  assert.equal(h.cursorReads(), reads);
  h.event('keyup', { key: 'Alt' });
  assert.equal(h.intervals.size, 0);
  assert.equal(h.classes.size, 0);
  h.tick();
  assert.equal(h.cursorReads(), reads);
  h.interaction.dispose();
});

test('Option then Shift switches move to resize and back without jumping', () => {
  const h = harness();
  h.startMove();
  Object.assign(h.cursor, { x: 150, y: 140 });
  h.tick();
  assert.deepEqual(h.native.changes, [[{ x: -30, y: 70, width: 700, height: 560 }, false]]);
  h.event('keydown', { ...modifiers, key: 'Shift' });
  assert.equal(h.intervals.size, 1);
  assert.equal(h.classes.has('note-panel-modifier-moving'), false);
  assert.equal(h.classes.has('note-panel-modifier-resizing'), true);
  h.tick();
  assert.equal(h.native.changes.length, 1);
  Object.assign(h.cursor, { x: 170, y: 160 });
  h.tick();
  assert.deepEqual(h.native.changes[1], [{ x: -10, y: 90, width: 680, height: 540 }, false]);
  assert.equal(h.native.bounds.x + h.native.bounds.width, 670);
  assert.equal(h.native.bounds.y + h.native.bounds.height, 630);
  h.event('keyup', { altKey: true, key: 'Shift' });
  assert.equal(h.classes.has('note-panel-modifier-moving'), true);
  assert.equal(h.classes.has('note-panel-modifier-resizing'), false);
  h.tick();
  assert.equal(h.native.changes.length, 2);
  Object.assign(h.cursor, { x: 190, y: 170 });
  h.tick();
  assert.deepEqual(h.native.changes[2], [{ x: 10, y: 100, width: 680, height: 540 }, false]);
  h.event('keyup', { key: 'Alt' });
  assert.equal(h.intervals.size, 0);
  h.interaction.dispose();
});

test('Shift then Option starts directly in resize without entering move mode', () => {
  const h = harness();
  h.event('keydown', { shiftKey: true, key: 'Shift' });
  assert.equal(h.intervals.size, 0);
  assert.equal(h.cursorReads(), 0);
  h.event('keydown', { ...modifiers, key: 'Alt' });
  assert.equal(h.classes.has('note-panel-modifier-moving'), false);
  assert.equal(h.classes.has('note-panel-modifier-resizing'), true);
  Object.assign(h.cursor, { x: 150, y: 140 });
  h.tick();
  assert.deepEqual(h.native.changes, [[{ x: -30, y: 70, width: 650, height: 520 }, false]]);
  h.interaction.dispose();
});

test('canceled Option moving requires a fresh modifier press, even after a missed keyup', () => {
  const h = harness();
  h.startMove();
  h.native.focused = false;
  h.native.emit('blur');
  h.native.focused = true;
  h.event('focus');
  h.event('keydown', { altKey: true, key: 'a' });
  h.event('keydown', { altKey: true, key: 'Alt', repeat: true });
  h.event('keyup', { altKey: true, key: 'Shift' });
  assert.equal(h.intervals.size, 0);
  Object.assign(h.cursor, { x: 200, y: 200 });
  h.startMove();
  assert.equal(h.intervals.size, 1);
  Object.assign(h.cursor, { x: 240, y: 230 });
  h.tick();
  assert.deepEqual(h.native.changes, [[{ x: -40, y: 60, width: 700, height: 560 }, false]]);
  h.interaction.dispose();
  assert.equal(h.classes.size, 0);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.domWindow.listenerCount(), 0);
});

test('Control and Command cancel moving and their release cannot restart it', () => {
  const h = harness();
  for (const [key, modifier] of [['Control', 'ctrlKey'], ['Meta', 'metaKey']]) {
    h.startMove();
    assert.equal(h.intervals.size, 1);
    h.event('keydown', { altKey: true, key, [modifier]: true });
    assert.equal(h.intervals.size, 0);
    assert.equal(h.classes.size, 0);
    h.event('keyup', { altKey: true, key });
    h.event('keydown', { altKey: true, key: 'a' });
    assert.equal(h.intervals.size, 0);
  }
  h.interaction.dispose();
});
