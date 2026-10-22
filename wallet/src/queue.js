// One global FIFO for everything that reaches the wallet or the hub UI (design §5.3): only one request is
// in flight at a time, so site A cannot switch the real wallet's chain under site B's queued transaction
// (research/prior-art.md §9 item 6). Each key (site origin) may hold at most `limitPerKey` pending
// requests, so a site cannot flood the user with prompts (design §5.2).
import { rpcError, ERR } from './protocol.js';

const noop = () => {};

export function createQueue(limitPerKey) {
  let tail = Promise.resolve();
  const counts = new Map();   // key → pending (queued + in flight)

  function release(key) {
    const n = (counts.get(key) || 1) - 1;
    if (n > 0) counts.set(key, n);
    else counts.delete(key);
  }

  /**
   * @param {string} key  site origin
   * @param {() => Promise<any>} task
   * @param {{ limited?: boolean }} [opts]  limited:false for hub-initiated work (e.g. a revoke button)
   */
  function run(key, task, { limited = true } = {}) {
    const n = counts.get(key) || 0;
    if (limited && n >= limitPerKey) return Promise.reject(rpcError(ERR.LIMIT_EXCEEDED, undefined, { pending: n }));
    counts.set(key, n + 1);
    const result = tail.then(() => task());
    tail = result.then(noop, noop);
    return result.finally(() => release(key));
  }

  return { run, pending: (key) => counts.get(key) || 0 };
}
