// Binance Wallet adapter (facts: research/wallets.md §2, static read of Binance Wallet 1.26.1).
// - EIP-6963 rdns `com.binance.wallet`; fallback global `window.binancew3w.ethereum`.
// - Throws `Error`, sometimes without `code` (e.g. "Not supported" for wallet_requestPermissions);
//   common.js classifies those by text. Connect with eth_requestAccounts only.
// - Has wallet_revokePermissions (disconnects the hub origin).
// - 56 and 8453 are built in; 196 (X Layer) is not in the bundled list, so ensureChain may have to add it.
//   Whether Binance accepts that is unverified until the manual test (prd Known Risks).
import { createAdapter } from './common.js';

export const binance = createAdapter({
  id: 'binance',
  rdns: 'com.binance.wallet',
  label: 'Binance Wallet',
  storeUrl: 'https://chromewebstore.google.com/detail/binance-wallet/cadiboklkpojfamcoggejbbdjcoiljjk',
  fallback: (win) => win.binancew3w && win.binancew3w.ethereum,
  revoke: async (call, provider) => {
    await call(provider, { method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] });
    return { revoked: true };
  },
});
