// Auto-close for the popup hub (design §10.1/§10.2): once nothing is pending, wait `delayMs` (3 s) and close.
// `hold(ms)` keeps the window open at least that long from now (the 5 s connect notice); `disable()` stops
// auto-closing for good (e.g. when install guidance must stay on screen). Timers and clock are injectable.

/**
 * @param {{ delayMs?: number, initialHoldMs?: number, close: () => void,
 *           setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout, now?: () => number }} opts
 */
export function createIdleCloser({ delayMs = 3000, initialHoldMs = 0, close, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now } = {}) {
  if (typeof close !== 'function') throw new TypeError('idle: close is required');
  let busy = 0;
  let timer = null;
  let holdUntil = now() + initialHoldMs;
  let off = false;

  function cancel() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function schedule() {
    cancel();
    if (off || busy > 0) return;
    timer = setTimer(fire, Math.max(delayMs, holdUntil - now()));
  }

  function fire() {
    timer = null;
    if (off || busy > 0) return;
    if (now() < holdUntil) { schedule(); return; }
    off = true;
    close();
  }

  return Object.freeze({
    /** Start counting (call once the hub is ready for requests). */
    start: schedule,
    busy() { busy += 1; cancel(); },
    done() { busy = Math.max(0, busy - 1); schedule(); },
    hold(ms) { holdUntil = Math.max(holdUntil, now() + ms); if (timer !== null) schedule(); },
    disable() { off = true; cancel(); },
  });
}
