// Supported wallets. Adding a wallet = one adapter file + one entry here (design §8, R5).
// The order is the display order and the tie-break when several wallets are installed.
import { okx } from './okx.js';
import { binance } from './binance.js';

export const ADAPTERS = Object.freeze([okx, binance]);

export const adapterById = (id) => ADAPTERS.find((a) => a.id === id) || null;

/**
 * Wallets present on this page, in ADAPTERS order. When exactly one is found the hub selects it
 * without asking (R1).
 * @param {Array<{info: {rdns: string}, provider: any}>} announced  EIP-6963 details collected by the hub
 * @param {any} win  the hub's window (for the dedicated globals)
 * @returns {ReadonlyArray<{adapter: typeof okx, provider: any}>}
 */
export function pickAdapters(announced, win) {
  return Object.freeze(
    ADAPTERS.map((adapter) => ({ adapter, provider: adapter.detect({ announced, win }) }))
      .filter((x) => x.provider)
      .map((x) => Object.freeze(x)),
  );
}
