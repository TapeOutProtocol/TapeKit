// OKX Wallet adapter (facts: research/wallets.md §1, static read of OKX 4.18.1).
// - EIP-6963 rdns `com.okex.wallet`; fallback global `window.okxwallet` (non-writable, set by OKX itself).
// - Rejects with plain objects that carry `code` (normalized in common.js).
// - Has no wallet_revokePermissions: "disconnect wallet" in the hub only clears TapeKit's own state and
//   tells the user to remove tapekit.org from OKX's connected sites by hand.
// - 56, 196 and 8453 are all built in.
import { createAdapter } from './common.js';

export const okx = createAdapter({
  id: 'okx',
  rdns: 'com.okex.wallet',
  label: 'OKX Wallet',
  storeUrl: 'https://chromewebstore.google.com/detail/okx-wallet/mcohilncbfahbmgdjkbpemcciiolgcge',
  fallback: (win) => win.okxwallet,
  revoke: async () => ({ revoked: false }),
});
