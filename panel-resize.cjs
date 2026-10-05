const READY_CLASS = 'note-panel-modifier-resize-ready';
const DRAG_CLASS = 'note-panel-modifier-resizing';
const NESW_CLASS = 'note-panel-modifier-resize-nesw';
const MOVE_CLASS = 'note-panel-modifier-moving';
const DEFAULT_MINIMUM = [420, 300];
const modeForModifiers = event => event.shiftKey && !event.ctrlKey && !event.metaKey ? (event.altKey ? 'resize' : 'move') : null;

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

function moveBounds(bounds, deltaX, deltaY) {
  return { x: Math.round(bounds.x + deltaX), y: Math.round(bounds.y + deltaY), width: bounds.width, height: bounds.height };
}

function installResize(domWindow, nativeWindow, onError = () => {}, { getCursor } = {}) {
  const doc = domWindow.document;
  const body = doc.body;
  const classNames = [READY_CLASS, DRAG_CLASS, NESW_CLASS, MOVE_CLASS];
  const originalClasses = new Set(classNames.filter(name => body.classList.contains(name)));
  const style = doc.createElement('style');
  style.textContent = `
    body.${READY_CLASS}, body.${READY_CLASS} *,
    body.${DRAG_CLASS}, body.${DRAG_CLASS} * { cursor: nwse-resize !important; }
    body.${NESW_CLASS}, body.${NESW_CLASS} * { cursor: nesw-resize !important; }
    body.${MOVE_CLASS}, body.${MOVE_CLASS} * { cursor: move !important; }
  `;
  doc.head.appendChild(style);

  let disposed = false;
  let gesture = null;
  let interval = null;
  const setModeClasses = (mode, corner) => {
    for (const name of classNames) {
      const enabled = name === MOVE_CLASS ? mode === 'move' : mode === 'resize' && (name !== NESW_CLASS || corner === 'ne' || corner === 'sw');
      body.classList.toggle(name, enabled || originalClasses.has(name));
    }
  };
  const cancel = () => {
    if (interval !== null) domWindow.clearInterval(interval);
    interval = null;
    gesture = null;
    setModeClasses(null);
  };
  const canInteract = () => !nativeWindow.isDestroyed?.() && nativeWindow.isFocused() && nativeWindow.isVisible();
  const cursorPoint = () => {
    if (typeof getCursor !== 'function') throw new TypeError('Note panel resize requires a screen cursor provider');
    const point = getCursor();
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) throw new TypeError('Invalid screen cursor position');
    return point;
  };
  const tick = () => {
    if (!gesture) return;
    try {
      if (!canInteract()) { cancel(); return; }
      const active = gesture;
      const cursor = cursorPoint();
      const dx = cursor.x - active.cursor.x;
      const dy = cursor.y - active.cursor.y;
      const next = active.mode === 'move' ? moveBounds(active.bounds, dx, dy) : resizeBounds(active.bounds, dx, dy, active.minimum, active.maximum, active.corner);
      if (['x', 'y', 'width', 'height'].every(name => next[name] === active.applied[name])) return;
      nativeWindow.setBounds(next, false);
      active.applied = next;
    } catch (error) {
      cancel();
      onError(error);
    }
  };
  const start = mode => {
    if (disposed || gesture) return;
    try {
      if (!canInteract()) return;
      const cursor = cursorPoint();
      const bounds = nativeWindow.getBounds();
      gesture = {
        mode, cursor: { ...cursor }, bounds, applied: bounds,
        corner: mode === 'resize' ? nearestCorner(bounds, cursor) : null,
        minimum: mode === 'resize' ? nativeWindow.getMinimumSize?.() || DEFAULT_MINIMUM : null,
        maximum: mode === 'resize' ? nativeWindow.getMaximumSize?.() || [0, 0] : null,
      };
      setModeClasses(mode, gesture.corner);
      interval = domWindow.setInterval(tick, 16);
    } catch (error) {
      cancel();
      onError(error);
    }
  };
  const onKey = event => {
    const modifierKey = event.key === 'Shift' || event.key === 'Alt';
    const released = event.type === 'keyup';
    const modifiers = { altKey: event.altKey, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey };
    if (released && event.key === 'Alt') modifiers.altKey = false;
    if (released && event.key === 'Shift') modifiers.shiftKey = false;
    const mode = modeForModifiers(modifiers);
    if (!mode) { cancel(); return; }
    const freshPress = modifierKey && event.type === 'keydown' && !event.repeat;
    // A modifier release can switch an active resize back to moving. Once a
    // gesture was canceled, only a fresh modifier press can start another one.
    const switchRelease = modifierKey && released && Boolean(gesture);
    if ((freshPress || switchRelease) && (!gesture || gesture.mode !== mode)) {
      cancel();
      start(mode);
    }
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

module.exports = { installResize, resizeBounds, nearestCorner, moveBounds };
