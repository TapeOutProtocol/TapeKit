// OKX Wallet adapter (facts: research/wallets.md §1, static read of OKX 4.18.1).
// - EIP-6963 rdns `com.okex.wallet`; fallback global `window.okxwallet` (non-writable, set by OKX itself).
// - Rejects with plain objects that carry `code` (normalized in common.js).
// - Has no wallet_revokePermissions: "disconnect wallet" in the hub only clears TapeKit's own state and
//   tells the user to remove tapekit.org from OKX's connected sites by hand.
// - 56, 196 and 8453 are all built in.
// - 4.19.0 (read 2026-10-16, research/manual-test.md): connect, transactions and wallet_switchEthereumChain only
//   work from the active tab of the focused normal window. Elsewhere connect and eth_sendTransaction fail 4001
//   with no prompt and the switch answers null without switching; a plain personal_sign (no params[2]
//   .isSilentSign) and eth_signTypedData_v4 still go through. The hub therefore runs those steps in a tab, message
//   signatures may run in a small window (design §10.3, 2026-10-16 and 2026-10-17), and ensureChain (common.js)
//   re-reads the chain after every switch.
import { createAdapter } from './common.js';

export const okx = createAdapter({
  id: 'okx',
  rdns: 'com.okex.wallet',
  label: 'OKX Wallet',
  storeUrl: 'https://chromewebstore.google.com/detail/okx-wallet/mcohilncbfahbmgdjkbpemcciiolgcge',
  fallback: (win) => win.okxwallet,
  revoke: async () => ({ revoked: false }),
});
