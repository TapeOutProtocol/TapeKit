// Offline unit tests for wallet/src/idle.js: the popup hub closes itself when there is nothing left to do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdleCloser } from '../src/idle.js';

/** Deterministic clock: timers fire only when advance() passes them. */
function fakeClock() {
  let t = 0, seq = 0;
  let timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers = new Map(timers).set(id, { at: t + ms, fn }); return id; },
    clearTimer: (id) => { const next = new Map(timers); next.delete(id); timers = next; },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const next = new Map(timers); next.delete(due[0]); timers = next;
        t = due[1].at;
        due[1].fn();
      }
      t = end;
    },
  };
}

function setup(opts = {}) {
  const clock = fakeClock();
  let closed = 0;
  const closer = createIdleCloser({ delayMs: 3000, close: () => { closed += 1; }, setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now, ...opts });
  return { clock, closer, closed: () => closed };
}

test('closes 3 s after the last piece of work finishes', () => {
  const { clock, closer, closed } = setup();
  closer.busy();
  clock.advance(10_000);
  assert.equal(closed(), 0, 'never while busy');
  closer.done();
  clock.advance(2999);
  assert.equal(closed(), 0);
  clock.advance(1);
  assert.equal(closed(), 1);
  clock.advance(10_000);
  assert.equal(closed(), 1, 'only once');
});

test('new work cancels a pending close', () => {
  const { clock, closer, closed } = setup();
  closer.start();
  clock.advance(2000);
  closer.busy();
  clock.advance(5000);
  closer.done();
  clock.advance(2000);
  assert.equal(closed(), 0);
  clock.advance(1000);
  assert.equal(closed(), 1);
});

test('hold keeps the window open at least that long (the 5 s connect notice)', () => {
  const { clock, closer, closed } = setup();
  closer.busy();
  closer.hold(5000);
  closer.done();
  clock.advance(4999);
  assert.equal(closed(), 0);
  clock.advance(1);
  assert.equal(closed(), 1);
});

test('start uses the initial hold so a slow first request is not cut off', () => {
  const { clock, closer, closed } = setup({ initialHoldMs: 15_000 });
  closer.start();
  clock.advance(14_999);
  assert.equal(closed(), 0);
  clock.advance(1);
  assert.equal(closed(), 1);
});

test('disable stops auto-closing for good (e.g. install guidance is shown)', () => {
  const { clock, closer, closed } = setup();
  closer.start();
  closer.disable();
  closer.busy();
  closer.done();
  clock.advance(60_000);
  assert.equal(closed(), 0);
});

test('done without busy does not go negative', () => {
  const { clock, closer, closed } = setup();
  closer.done();
  closer.done();
  closer.busy();
  clock.advance(10_000);
  assert.equal(closed(), 0, 'one busy() still holds the window open');
});
