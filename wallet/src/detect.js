// Wallet discovery in the hub (R1, design §8). Wallets announce themselves with EIP-6963 when asked
// (eip6963:requestProvider); the hub listens for a short while, then falls back to each wallet's own global
// (adapters/*). window.ethereum is never used.
import { pickAdapters } from './adapters/index.js';

const DEFAULT_WAIT_MS = 300;

const validDetail = (d) => !!d && typeof d === 'object' && !!d.info && typeof d.info === 'object'
  && typeof d.info.rdns === 'string' && !!d.provider && typeof d.provider.request === 'function';

/**
 * @param {Window} win  the hub window
 * @param {{ waitMs?: number }} [opts]
 * @returns {Promise<ReadonlyArray<{ adapter: object, provider: object }>>}  in ADAPTERS order
 */
export async function detectWallets(win, { waitMs = DEFAULT_WAIT_MS } = {}) {
  let announced = [];   // replaced, never edited in place
  const onAnnounce = (event) => {
    const detail = event && event.detail;
    if (validDetail(detail)) announced = [...announced, { info: detail.info, provider: detail.provider }];
  };
  win.addEventListener('eip6963:announceProvider', onAnnounce);
  try {
    const Ev = win.CustomEvent || globalThis.CustomEvent;
    win.dispatchEvent(new Ev('eip6963:requestProvider'));
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  } finally {
    win.removeEventListener('eip6963:announceProvider', onAnnounce);
  }
  return pickAdapters(announced, win);
}

/**
 * Which wallet to use: exactly one found → that one (R1); several → the remembered choice if it is still
 * installed, otherwise the user must pick; none → null (the hub shows install guidance).
 * @param {ReadonlyArray<{ adapter: { id: string } }>} found  @param {string|null} rememberedId
 */
export function chooseWallet(found, rememberedId) {
  if (!found.length) return { selected: null, needsPick: false };
  if (found.length === 1) return { selected: found[0], needsPick: false };
  const remembered = found.find((x) => x.adapter.id === rememberedId);
  return remembered ? { selected: remembered, needsPick: false } : { selected: null, needsPick: true };
}
