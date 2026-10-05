const READY_CLASS = 'note-panel-modifier-resize-ready';
const DRAG_CLASS = 'note-panel-modifier-resizing';
const NESW_CLASS = 'note-panel-modifier-resize-nesw';
const DEFAULT_MINIMUM = [420, 300];
const hasModifiers = event => event.shiftKey && event.altKey && !event.ctrlKey && !event.metaKey;

function nearestCorner(bounds, cursor) {
  const vertical = cursor.y < bounds.y + bounds.height / 2 ? 'n' : 's';
  const horizontal = cursor.x < bounds.x + bounds.width / 2 ? 'w' : 'e';
  return vertical + horizontal;
}

function resizeBounds(bounds, deltaX, deltaY, minimum = DEFAULT_MINIMUM, maximum = [0, 0], corner = 'se') {
  const dimension = (value, delta, index) => {
    const min = Number.isFinite(minimum?.[index]) && minimum[index] > 0 ? minimum[index] : 1;
    const max = Number.isFinite(maximum?.[index]) && maximum[index] > 0 ? Math.max(min, maximum[index]) : Infinity;
    return Math.round(Math.min(max, Math.max(min, value + delta)));
  };
  const west = corner.endsWith('w');
  const north = corner.startsWith('n');
  const width = dimension(bounds.width, west ? -deltaX : deltaX, 0);
  const height = dimension(bounds.height, north ? -deltaY : deltaY, 1);
  return {
    x: west ? bounds.x + bounds.width - width : bounds.x,
    y: north ? bounds.y + bounds.height - height : bounds.y,
    width,
    height,
  };
}

function installResize(domWindow, nativeWindow, onError = () => {}, { getCursor } = {}) {
  const doc = domWindow.document;
  const body = doc.body;
  const classNames = [READY_CLASS, DRAG_CLASS, NESW_CLASS];
  const originalClasses = new Set(classNames.filter(name => body.classList.contains(name)));
  const style = doc.createElement('style');
  style.textContent = `
    body.${READY_CLASS}, body.${READY_CLASS} *,
    body.${DRAG_CLASS}, body.${DRAG_CLASS} * { cursor: nwse-resize !important; }
    body.${NESW_CLASS}, body.${NESW_CLASS} * { cursor: nesw-resize !important; }
  `;
  doc.head.appendChild(style);

  let disposed = false;
  let chordHeld = false;
  let gesture = null;
  let interval = null;
  const setActiveClass = (active, corner) => {
    for (const name of classNames) {
      const enabled = active && (name !== NESW_CLASS || corner === 'ne' || corner === 'sw');
      body.classList.toggle(name, enabled || originalClasses.has(name));
    }
  };
  const cancel = () => {
    if (interval !== null) domWindow.clearInterval(interval);
    interval = null;
    gesture = null;
    setActiveClass(false);
  };
  const canResize = () => !nativeWindow.isDestroyed?.() && nativeWindow.isFocused() && nativeWindow.isVisible();
  const cursorPoint = () => {
    if (typeof getCursor !== 'function') throw new TypeError('Note panel resize requires a screen cursor provider');
    const point = getCursor();
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) throw new TypeError('Invalid screen cursor position');
    return point;
  };
  const tick = () => {
    if (!gesture) return;
    try {
      if (!canResize()) { cancel(); return; }
      const active = gesture;
      const cursor = cursorPoint();
      const next = resizeBounds(active.bounds, cursor.x - active.cursor.x, cursor.y - active.cursor.y, active.minimum, active.maximum, active.corner);
      if (['x', 'y', 'width', 'height'].every(name => next[name] === active.applied[name])) return;
      nativeWindow.setBounds(next, false);
      active.applied = next;
    } catch (error) {
      cancel();
      onError(error);
    }
  };
  const start = () => {
    if (disposed || gesture) return;
    try {
      if (!canResize()) return;
      const cursor = cursorPoint();
      const bounds = nativeWindow.getBounds();
      gesture = {
        cursor: { ...cursor }, bounds, applied: bounds, corner: nearestCorner(bounds, cursor),
        minimum: nativeWindow.getMinimumSize?.() || DEFAULT_MINIMUM,
        maximum: nativeWindow.getMaximumSize?.() || [0, 0],
      };
      setActiveClass(true, gesture.corner);
      interval = domWindow.setInterval(tick, 16);
    } catch (error) {
      cancel();
      onError(error);
    }
  };
  const onKey = event => {
    const modifierKey = event.key === 'Shift' || event.key === 'Alt';
    const held = hasModifiers(event) && !(event.type === 'keyup' && modifierKey);
    if (held && !chordHeld && event.type === 'keydown' && modifierKey && !event.repeat) start();
    if (!held) cancel();
    // Keep the latch after blur/hide. A new modifier chord is needed to restart;
    // key repeats and ordinary typing must not establish a new cursor origin.
    chordHeld = held;
  };
  const dispose = () => {
    if (disposed) return;
    cancel();
    disposed = true;
    domWindow.removeEventListener('keydown', onKey, true);
    domWindow.removeEventListener('keyup', onKey, true);
    domWindow.removeEventListener('blur', cancel, true);
    nativeWindow.removeListener('blur', cancel);
    nativeWindow.removeListener('hide', cancel);
    nativeWindow.removeListener('closed', onClosed);
    style.remove();
  };
  const onClosed = () => dispose();
  domWindow.addEventListener('keydown', onKey, true);
  domWindow.addEventListener('keyup', onKey, true);
  domWindow.addEventListener('blur', cancel, true);
  nativeWindow.on('blur', cancel);
  nativeWindow.on('hide', cancel);
  nativeWindow.on('closed', onClosed);
  return { cancel, dispose };
}

module.exports = { installResize, resizeBounds, nearestCorner };
