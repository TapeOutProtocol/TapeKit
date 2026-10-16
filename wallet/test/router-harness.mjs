// Test harness for wallet/src/router.js: a fake EIP-1193 wallet, an in-memory store that deep-freezes
// what it is given (so any mutation by the router throws), a fake kernel, a scripted UI and an event log.
import assert from 'node:assert/strict';
import { createRouter } from '../src/router.js';
import { createIdentityResolver } from '../src/identity.js';
import { okx } from '../src/adapters/okx.js';

export const HUB = 'https://tapekit.org/.tape/wallet/';
export const A = 'https://4246-0.tapekit.org';     // BNB site
export const B = 'https://1-2-344.tapekit.org';    // X Layer site
export const C = 'https://1-0.tapekit.org';        // resolves as not-opened
export const X = '0x' + 'aa'.repeat(20);
export const Y = '0x' + 'bb'.repeat(20);
export const CONTAINER = '0x' + '12'.repeat(20);
export const H1 = '0x' + '1f'.repeat(20);   // circuit holder
export const H2 = '0x' + '2e'.repeat(20);   // the next holder after the circuit changes hands

export const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
};
export const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
export const tick = () => new Promise((r) => setTimeout(r, 0));
export const rejectsWith = (p, code) => assert.rejects(p, (e) => { assert.equal(e.code, code, e.message); return true; });

function fakeWallet({ accounts, connected, chain, known, signResult, ignoreSwitch }) {
  const calls = [];
  const state = { accounts: connected ? [...accounts] : [], chain, known: new Set(known) };
  const sign = () => signResult;
  const handlers = {
    eth_accounts: () => [...state.accounts],
    eth_requestAccounts: () => { state.accounts = [...accounts]; return [...state.accounts]; },
    eth_chainId: () => state.chain,
    wallet_switchEthereumChain: ([{ chainId }]) => {
      if (!state.known.has(chainId)) throw { code: 4902, message: 'Unrecognized chain ID' };
      if (!ignoreSwitch) state.chain = chainId;   // ignoreSwitch: OKX outside a focused tab answers null, no switch
      return null;
    },
    wallet_addEthereumChain: ([p]) => { state.known.add(p.chainId); return null; },
    personal_sign: sign, eth_signTypedData_v4: sign, eth_sendTransaction: sign,
  };
  return {
    calls, state,
    count: (method) => calls.filter((c) => c.method === method).length,
    async request({ method, params }) {
      calls.push({ method, params });
      if (!handlers[method]) throw { code: 4200, message: 'unsupported' };
      return handlers[method](params);
    },
  };
}

export function setup(opts = {}) {
  const {
    accounts = [X], connected = true, chain = '0x38', known = ['0x38', '0xc4', '0x2105'], signResult = '0xsig',
    siteDecision = 'ok', signDecision = 'ok', statuses = { '1.0.tape': 'not-opened' }, holders = {}, withWallet = true,
    ignoreSwitch = false, canPrompt,
  } = opts;
  const wallet = fakeWallet({ accounts, connected, chain, known, signResult, ignoreSwitch });
  let perms = deepFreeze({});
  const store = { get: () => perms, set: (p) => { perms = deepFreeze(p); } };
  const kernelCalls = [];
  const kernel = {
    async resolve(name) {
      kernelCalls.push(name);
      if (statuses[name] === 'throw') throw new Error('nodes disagree');
      const holder = name in holders ? holders[name] : H1;
      return { name, cpuName: 'Seed CPU', container: CONTAINER, holder, status: statuses[name] || 'ok', chainId: name.split('.').length === 4 ? 196 : 56 };
    },
  };
  const ui = {
    notices: [], sites: [], cards: [],
    notice(info) { ui.notices.push(info); return new Promise(() => {}); },   // never settles: the router must not wait
    async confirmSite(info) { ui.sites.push(info); return typeof siteDecision === 'function' ? siteDecision(info) : siteDecision; },
    async confirmSign(card) { ui.cards.push(card); return typeof signDecision === 'function' ? signDecision(card) : signDecision; },
  };
  const identity = createIdentityResolver({ kernel });
  const events = [];
  const reads = [];
  const errors = [];
  const router = createRouter({
    hubLocation: HUB,
    adapter: withWallet ? okx : null,
    provider: withWallet ? wallet : null,
    store,
    identity,
    ui,
    rpc: async (chainHex, method, params) => { reads.push([chainHex, method, params]); return '0x10'; },
    emit: (origin, event, data) => events.push([origin, event, data]),
    now: () => 1000,
    onError: (e, where) => errors.push([where, e]),
    ...(canPrompt ? { canPrompt } : {}),
  });
  const call = (origin, method, params, gesture = false) => router.handle({ origin, method, params, gesture });
  return { router, wallet, ui, identity, events, reads, errors, call, kernelCalls, get perms() { return perms; } };
}

/** Grant `origin` with a gesture and clear the logs. */
export async function granted(h, ...origins) {
  for (const o of origins) await h.call(o, 'eth_requestAccounts', [], true);
  h.events.length = 0;
  h.ui.notices.length = 0;
  h.wallet.calls.length = 0;
}
