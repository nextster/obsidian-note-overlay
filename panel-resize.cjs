const READY_CLASS = 'note-panel-modifier-resize-ready';
const DRAG_CLASS = 'note-panel-modifier-resizing';
const DEFAULT_MINIMUM = [420, 300];

const hasModifiers = event => event.shiftKey && event.altKey && !event.ctrlKey && !event.metaKey;

function resizeBounds(bounds, deltaX, deltaY, minimum = DEFAULT_MINIMUM, maximum = [0, 0]) {
  const dimension = (value, delta, index) => {
    const min = Number.isFinite(minimum?.[index]) && minimum[index] > 0 ? minimum[index] : 1;
    const max = Number.isFinite(maximum?.[index]) && maximum[index] > 0 ? Math.max(min, maximum[index]) : Infinity;
    return Math.round(Math.min(max, Math.max(min, value + delta)));
  };
  return {
    x: bounds.x,
    y: bounds.y,
    width: dimension(bounds.width, deltaX, 0),
    height: dimension(bounds.height, deltaY, 1),
  };
}

function installResize(domWindow, nativeWindow, onError = () => {}) {
  const doc = domWindow.document;
  const body = doc.body;
  const originalClasses = new Set([READY_CLASS, DRAG_CLASS].filter(name => body.classList.contains(name)));
  const style = doc.createElement('style');
  style.textContent = `
    body.${READY_CLASS}, body.${READY_CLASS} *,
    body.${DRAG_CLASS}, body.${DRAG_CLASS} * {
      cursor: nwse-resize !important;
      -webkit-app-region: no-drag !important;
    }
    body.${DRAG_CLASS}, body.${DRAG_CLASS} * { user-select: none !important; }
  `;
  doc.head.appendChild(style);

  const listeners = [];
  let disposed = false;
  let drag = null;
  let consumed = null;
  let frame = null;
  let terminalTimer = null;

  const listen = (target, name, handler) => {
    target.addEventListener(name, handler, true);
    listeners.push(() => target.removeEventListener(name, handler, true));
  };
  const setClass = (name, enabled) => body.classList.toggle(name, enabled || originalClasses.has(name));
  const setReady = enabled => setClass(READY_CLASS, enabled);
  const consume = event => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const clearTerminalTimer = () => {
    if (terminalTimer !== null) domWindow.clearTimeout(terminalTimer);
    terminalTimer = null;
  };
  const releaseCapture = () => {
    if (!consumed?.captured) return;
    consumed.captured = false;
    try { body.releasePointerCapture(consumed.pointerId); } catch { /* The OS may already have released it. */ }
  };
  const clearConsumed = () => {
    clearTerminalTimer();
    releaseCapture();
    consumed = null;
  };
  const cancelFrame = () => {
    if (frame !== null) domWindow.cancelAnimationFrame(frame);
    frame = null;
  };
  const flush = () => {
    cancelFrame();
    if (!drag?.pending) return;
    const next = drag.pending;
    drag.pending = null;
    if (next.width === drag.applied.width && next.height === drag.applied.height) return;
    try {
      if (nativeWindow.isDestroyed?.()) return;
      nativeWindow.setSize(next.width, next.height, false);
      drag.applied = next;
    } catch (error) {
      cancel();
      onError(error);
    }
  };
  const stopResize = () => {
    flush();
    drag = null;
    setClass(DRAG_CLASS, false);
  };
  const cancel = () => {
    stopResize();
    clearConsumed();
    setReady(false);
  };
  const updateSize = event => {
    if (!drag || !Number.isFinite(event.screenX) || !Number.isFinite(event.screenY)) return;
    drag.pending = resizeBounds(drag.bounds, event.screenX - drag.x, event.screenY - drag.y, drag.minimum, drag.maximum);
  };
  const samePointer = event => consumed && event.pointerId === consumed.pointerId;

  listen(domWindow, 'pointerdown', event => {
    if (disposed) return;
    setReady(hasModifiers(event));
    if (event.button !== 0 || !hasModifiers(event)) {
      // A later ordinary click must never inherit suppression from a resize.
      if (!drag) clearConsumed();
      return;
    }
    cancel();
    let bounds, minimum, maximum;
    try {
      if (nativeWindow.isDestroyed?.()) return;
      bounds = nativeWindow.getBounds();
      minimum = nativeWindow.getMinimumSize?.() || DEFAULT_MINIMUM;
      maximum = nativeWindow.getMaximumSize?.() || [0, 0];
    } catch (error) { onError(error); return; }
    drag = { bounds, minimum, maximum, x: event.screenX, y: event.screenY, applied: bounds, pending: null };
    consumed = { pointerId: event.pointerId, down: true, captured: false };
    consume(event);
    setReady(true);
    setClass(DRAG_CLASS, true);
    // A stable owner keeps capture when an editor replaces its DOM nodes.
    try { body.setPointerCapture(event.pointerId); consumed.captured = true; } catch { /* Document listeners still cover the panel. */ }
  });
  listen(domWindow, 'pointermove', event => {
    setReady(hasModifiers(event));
    if (!samePointer(event) || !consumed.down) return;
    consume(event);
    if (typeof event.buttons === 'number' && !(event.buttons & 1)) {
      // Chorded mouse buttons can release the left button without pointerup.
      // Keep consuming until the other buttons are released as well.
      if (event.buttons === 0) finishPointer(event);
      else stopResize();
      return;
    }
    if (!hasModifiers(event)) { stopResize(); return; }
    updateSize(event);
    if (drag && frame === null) frame = domWindow.requestAnimationFrame(flush);
  });
  const finishPointer = event => {
    if (!samePointer(event)) return;
    consume(event);
    if (event.type === 'pointerup' && hasModifiers(event)) updateSize(event);
    stopResize();
    if (!consumed) return;
    consumed.down = false;
    releaseCapture();
    clearTerminalTimer();
    // preventDefault(pointerdown) does not suppress the trailing click.
    // The next ordinary pointerdown also clears this short suppression window.
    terminalTimer = domWindow.setTimeout(clearConsumed, 250);
  };
  listen(domWindow, 'pointerup', finishPointer);
  listen(domWindow, 'pointercancel', finishPointer);
  listen(domWindow, 'lostpointercapture', event => {
    if (samePointer(event) && consumed.captured) cancel();
  });
  // Window capture runs before Obsidian's existing document-level tab handlers.
  for (const name of ['click', 'auxclick', 'contextmenu']) listen(domWindow, name, event => {
    if (!consumed) return;
    if (event.pointerId !== undefined && event.pointerId !== consumed.pointerId) return;
    if (name === 'click' && event.detail === 0) return;
    consume(event);
  });
  const onKey = event => {
    const modifiers = hasModifiers(event) && !(event.type === 'keyup' && (event.key === 'Shift' || event.key === 'Alt'));
    setReady(modifiers);
    if (!modifiers) stopResize();
  };
  listen(domWindow, 'keydown', onKey);
  listen(domWindow, 'keyup', onKey);
  listen(domWindow, 'blur', cancel);
  const dispose = () => {
    if (disposed) return;
    cancel();
    disposed = true;
    for (const remove of listeners) remove();
    nativeWindow.removeListener('hide', cancel);
    nativeWindow.removeListener('closed', onClosed);
    style.remove();
  };
  const onClosed = () => dispose();
  nativeWindow.on('hide', cancel);
  nativeWindow.on('closed', onClosed);

  return { cancel, dispose };
}

module.exports = { installResize, resizeBounds };
