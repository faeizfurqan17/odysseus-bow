/**
 * input.js — two independent readers.
 *
 * TapTracker turns spacebar keydowns into a taps/sec figure.
 * ZoomGesture collapses five different browser gesture dialects into one signed
 * scalar, so nothing downstream has to care which device produced it.
 */

/* ------------------------------------------------------------------ *
 * Tap cadence
 * ------------------------------------------------------------------ */

export function createTapTracker({ window: win = window, historySize = 8 } = {}) {
  const deltas = [];
  let lastTap = 0;
  let rate = 0;
  const listeners = [];

  function onKeyDown(e) {
    if (e.code !== 'Space') return;
    // Holding the key down auto-repeats. Without this you could just lean on the
    // spacebar and the OS would play the game for you.
    if (e.repeat) return;
    e.preventDefault();

    const now = performance.now();
    if (lastTap > 0) {
      const dt = now - lastTap;
      // Ignore double-fires and absurd gaps; they'd poison the median.
      if (dt > 18 && dt < 2000) {
        deltas.push(dt);
        if (deltas.length > historySize) deltas.shift();
      } else if (dt >= 2000) {
        deltas.length = 0;   // they stopped; start the read fresh
      }
    }
    lastTap = now;
    for (const fn of listeners) fn(now);
  }

  win.addEventListener('keydown', onKeyDown, { passive: false });

  return {
    /** Taps/sec, from the median gap — one hesitation shouldn't tank the read. */
    get rate() { return rate; },
    get msSinceTap() { return lastTap ? performance.now() - lastTap : Infinity; },
    onTap(fn) { listeners.push(fn); },

    update() {
      if (deltas.length === 0) { rate = 0; return rate; }

      const sorted = [...deltas].sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      const median = sorted.length % 2
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;

      let r = 1000 / median;

      // A median computed from stale taps would keep reporting a healthy rate
      // long after the player stopped. Decay it against real elapsed time.
      const since = performance.now() - lastTap;
      if (since > median * 1.5) {
        r *= Math.max(0, 1 - (since - median * 1.5) / 600);
      }
      rate = r;
      return rate;
    },

    reset() {
      deltas.length = 0;
      lastTap = 0;
      rate = 0;
    },

    dispose() {
      win.removeEventListener('keydown', onKeyDown);
    },
  };
}

/* ------------------------------------------------------------------ *
 * Zoom-out gesture
 *
 * Sources, all normalised to "positive means zoom out / pull back":
 *   wheel + ctrlKey    trackpad pinch on Chrome, Edge, Firefox — the browser
 *                      synthesises a ctrl-wheel for pinch
 *   gesturechange      Safari's own pinch events (non-standard, WebKit only)
 *   wheel              plain scroll; scrolling down reads as pulling back
 *   two pointers       touch: fingers moving apart
 *   one pointer drag   mouse-only fallback, so nobody is locked out
 * ------------------------------------------------------------------ */

/**
 * `allowDrag(event)` lets the caller veto the single-pointer drag fallback for a
 * given pointerdown — used so that grabbing the string plucks it instead of
 * starting a draw. Wheel and pinch are unaffected.
 */
export function createZoomGesture(target, { window: win = window, allowDrag = () => true } = {}) {
  let delta = 0;          // accumulated this frame
  let active = false;     // is a continuous gesture in progress
  let lastReleaseAt = 0;
  const releaseListeners = [];
  const pointers = new Map();
  let pinchStart = 0;
  let dragLast = null;
  let idleTimer = null;

  function markActive() {
    active = true;
    clearTimeout(idleTimer);
    // Wheel events have no "end", so a gesture is considered finished once the
    // events stop arriving.
    idleTimer = setTimeout(() => {
      if (active) {
        active = false;
        fireRelease();
      }
    }, 180);
  }

  function fireRelease() {
    lastReleaseAt = performance.now();
    for (const fn of releaseListeners) fn();
  }

  /* --- wheel: pinch and scroll both arrive here --- */
  function onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey) {
      // Pinch. Fingers apart produces a negative deltaY, which is "zoom out".
      delta += -e.deltaY * 0.020;
    } else {
      // Plain scroll. Scrolling down (positive deltaY) pulls the camera back.
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
      delta += e.deltaY * scale * 0.0022;
    }
    markActive();
  }

  /* --- Safari's gesture events --- */
  function onGestureStart(e) {
    e.preventDefault();
    pinchStart = e.scale || 1;
    active = true;
    clearTimeout(idleTimer);
  }
  function onGestureChange(e) {
    e.preventDefault();
    const s = e.scale || 1;
    // Scale below 1 means the fingers came together... but WebKit reports pinch
    // *out* as scale > 1, and zoom-out here is the pinch-out direction.
    delta += (s - pinchStart) * 2.4;
    pinchStart = s;
    clearTimeout(idleTimer);
    active = true;
  }
  function onGestureEnd(e) {
    e.preventDefault();
    active = false;
    fireRelease();
  }

  /* --- pointers: two-finger spread, and single-drag fallback --- */
  function pinchDistance() {
    const pts = [...pointers.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  function onPointerDown(e) {
    // A vetoed drag is not a gesture at all — don't capture the pointer or mark
    // the gesture active, or releasing it would fire a spurious loose.
    if (pointers.size === 0 && !allowDrag(e)) return;

    target.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) pinchStart = pinchDistance();
    if (pointers.size === 1) dragLast = e.clientY;
    active = true;
    clearTimeout(idleTimer);
  }

  function onPointerMove(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size >= 2) {
      const d = pinchDistance();
      if (pinchStart > 0) delta += (d - pinchStart) * 0.006;
      pinchStart = d;
      dragLast = null;
    } else if (dragLast !== null) {
      // Dragging down pulls back, matching the scroll direction.
      delta += (e.clientY - dragLast) * 0.0055;
      dragLast = e.clientY;
    }
  }

  function onPointerUp(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    target.releasePointerCapture?.(e.pointerId);
    if (pointers.size < 2) pinchStart = 0;
    if (pointers.size === 0) {
      dragLast = null;
      active = false;
      fireRelease();
    }
  }

  target.addEventListener('wheel', onWheel, { passive: false });
  target.addEventListener('gesturestart', onGestureStart, { passive: false });
  target.addEventListener('gesturechange', onGestureChange, { passive: false });
  target.addEventListener('gestureend', onGestureEnd, { passive: false });
  target.addEventListener('pointerdown', onPointerDown);
  win.addEventListener('pointermove', onPointerMove);
  win.addEventListener('pointerup', onPointerUp);
  win.addEventListener('pointercancel', onPointerUp);

  return {
    get isActive() { return active; },
    get msSinceRelease() { return lastReleaseAt ? performance.now() - lastReleaseAt : Infinity; },
    onRelease(fn) { releaseListeners.push(fn); },

    /** Consume and clear the accumulated delta for this frame. */
    consume() {
      const d = delta;
      delta = 0;
      return d;
    },

    reset() {
      delta = 0;
      active = false;
      pointers.clear();
      pinchStart = 0;
      dragLast = null;
    },

    dispose() {
      clearTimeout(idleTimer);
      target.removeEventListener('wheel', onWheel);
      target.removeEventListener('gesturestart', onGestureStart);
      target.removeEventListener('gesturechange', onGestureChange);
      target.removeEventListener('gestureend', onGestureEnd);
      target.removeEventListener('pointerdown', onPointerDown);
      win.removeEventListener('pointermove', onPointerMove);
      win.removeEventListener('pointerup', onPointerUp);
      win.removeEventListener('pointercancel', onPointerUp);
    },
  };
}
