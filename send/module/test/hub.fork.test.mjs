// 端到端（BNB 主网分叉）：本机 anvil 分叉主网 → 按部署页同样的方式部署第三版正式实现 → owner 把中枢升级上去 →
// 真实电路 15324@30 的持有人发布公钥、发两条消息 → 用本模块（createTapeSendChain）读回并逐项核对。
// 需要本机有 anvil、cast，并先在 send/contracts 里 forge build（读 out/ 里的编译产物）。缺任何一样就跳过。
// 只在本机分叉上发交易，不碰主网。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { createRpc } from '../../../kernel/src/rpc.js';
import { createTapeSendChain, normalizeReceipt, endpointId, HUB_MAINNET, HUB_IMPLEMENTATIONS } from '../src/chain.js';
import { bytesToHex, hexToBytes } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(here, '../../contracts/out/DeWebHub.sol/DeWebHub.json');
const FORK_URL = process.env.BSC_FORK_URL || 'https://bsc-dataseed.bnbchain.org';
const PORT = 18000 + Math.floor(Math.random() * 1000);
const L = `http://127.0.0.1:${PORT}`;

const DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
const OWNER = '0x571d447f4f24688eC35Ccf07f1D6993655F6aF15';
const V3 = '0x80afe7b77f2dfd08e9feab7675780bac34a7ee85';
const CPU30 = '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C';
const TOKEN_ID = 15324n;
// 部署页里 BNB 链的构造参数（与 script/deploy-page.mjs 一致）
const T = {
  registry: '0x000000006551c19487814612e58FE06813775758',
  implementation: '0xAf4E78a2257C9c5480c2F8310E3b00437260751d',
  factory: '0x68224F668083c29e9800Be2a646d42d18cedF7e2',
  payments: '0xc0C643eb9820eF208Ea38bb2c8E8377047D9fa4c',
  circuitBeacon: '0xf8D6d8EB894d6971c8976Ad8b4971cbEFE028156',
  circuitImplementation: '0x8E1D125Def6d3826C278299273a0760D47626068',
  circuitCodehash: '0xd8c4b0216e0aadd615fbd134465b6af060a11769edc7c844d8f14d1b8a783992',
};

const has = (bin) => { try { execFileSync(bin, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } };
const word = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const cast = (...args) => execFileSync('cast', [...args, '--rpc-url', L], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sendAs = (from, ...args) => {
  const out = cast('send', ...args, '--from', from, '--unlocked', '--json');
  const r = JSON.parse(out);
  assert.equal(r.status, '0x1', `tx failed: ${args[1] ?? args[0]}`);
  return r;
};

const skip = !has('anvil') || !has('cast') || !existsSync(ARTIFACT);

test('DeWEB hub v3 end-to-end on a BNB mainnet fork', { skip: skip && 'needs anvil, cast and forge build output', timeout: 180_000 }, async () => {
  const anvil = spawn('anvil', ['--fork-url', FORK_URL, '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  anvil.stdout.on('data', (d) => { log += d; });
  anvil.stderr.on('data', (d) => { log += d; });
  try {
    // 等 anvil 起来（它要先从主网取分叉点的状态）
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      await new Promise((r) => setTimeout(r, 500));
      up = log.includes('Listening on');
    }
    assert.ok(up, `anvil did not start: ${log.slice(-500)}`);

    // 1. 按部署页的方式部署第三版：确定性部署器 + 盐 "DeWEB Hub impl v2" + 创建代码‖构造参数
    const creation = JSON.parse(readFileSync(ARTIFACT, 'utf8')).bytecode.object.replace(/^0x/, '');
    const args = [word('0x38'), word(T.registry), word(T.implementation), word(T.factory), word(T.payments), word(T.circuitBeacon), word(T.circuitImplementation), word(T.circuitCodehash)].join('');
    const salt = bytesToHex(keccak_256(new TextEncoder().encode('DeWEB Hub impl v2'))).slice(2);
    const funder = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
    for (const a of [funder, OWNER]) {
      cast('rpc', 'anvil_impersonateAccount', a);
      cast('rpc', 'anvil_setBalance', a, '0xde0b6b3a7640000');
    }
    const code = cast('code', V3);
    if (code === '0x') sendAs(funder, DEPLOYER, `0x${salt}${creation}${args}`, '--gas-limit', '8000000');
    assert.notEqual(cast('code', V3), '0x', 'v3 is at the predicted address (source matches the client allow-list)');

    // 2. owner 升级（主网上现在是 v2；若将来已是 v3 就跳过）
    const slot = cast('storage', HUB_MAINNET, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc');
    if (!slot.toLowerCase().endsWith(V3.slice(2))) sendAs(OWNER, HUB_MAINNET, 'upgradeToAndCall(address,bytes)', V3, '0x');

    // 3. 真实电路 15324@30 的持有人发布公钥、发两条消息（一条给自己、一条给 Base 上的端点）
    const holder = cast('call', CPU30, 'ownerOf(uint256)(address)', TOKEN_ID.toString());
    cast('rpc', 'anvil_impersonateAccount', holder);
    cast('rpc', 'anvil_setBalance', holder, '0xde0b6b3a7640000');
    const pub = '0x' + '11'.repeat(32);
    sendAs(holder, HUB_MAINNET, 'publishKey(address,uint256,uint8,uint16,bytes32,uint64)', CPU30, TOKEN_ID.toString(), '1', '3', pub, '7');

    const rpc = createRpc({ urls: [L], strictQuorum: 1, quorum: 1 });
    const chain = createTapeSendChain({ rpc });
    const me = await chain.resolveEndpoint('#15324@30');
    assert.equal(me.status, 'ok');
    const container = me.container.toLowerCase();
    assert.equal(me.endpoint, endpointId(56, container));
    const base = '0x' + '0'.repeat(8) + (8453).toString(16).padStart(16, '0') + '0'.repeat(36) + '0ba5';

    // 模块读的是"最新往前几块"的钉住区块：每次读之前先多挖几块，让刚发的交易落在钉住区块之内
    const mine = () => cast('rpc', 'anvil_mine', '0x5');
    mine();
    const inBefore = (await chain.inbox(me.endpoint, { limit: 1 })).count;
    const outBefore = (await chain.outbox(container, { limit: 1 })).count;
    const ref = '0x' + '0'.repeat(62) + 'ab';
    const payload1 = '0x5453010000aa';
    const r1 = sendAs(holder, HUB_MAINNET, 'send(address,uint256,bytes32,bytes32,bytes)', CPU30, TOKEN_ID.toString(), me.endpoint, ref, payload1);
    sendAs(holder, HUB_MAINNET, 'send(address,uint256,bytes32,bytes32,bytes)', CPU30, TOKEN_ID.toString(), base, '0x' + '0'.repeat(64), '0x5453010001');

    // 4. 模块读回
    mine();
    const block = await rpc.pinBlock();
    const hs = await chain.hubStatus(block);
    assert.equal(hs.implementation.toLowerCase(), V3);
    assert.ok(HUB_IMPLEMENTATIONS.includes(V3));
    assert.equal(hs.expectedImplementation, true);

    const key = await chain.keyFor(CPU30, TOKEN_ID, block);
    assert.equal(key.usable, true);
    assert.equal(key.key, pub);
    assert.equal(key.chainsBits, 7n);
    assert.deepEqual(key.chains, [56, 8453, 196]);

    const ib = await chain.inbox(me.endpoint, { block });
    assert.equal(ib.count, inBefore + 1);
    const e = ib.items[0];
    assert.equal(e.index, inBefore);
    assert.equal(e.from.toLowerCase(), container);
    const got = await chain.fetchMessage(e);
    assert.equal(bytesToHex(got.payload), payload1);
    assert.equal(got.ref, ref);
    const digest = bytesToHex(keccak_256(new Uint8Array([...hexToBytes(got.ref), ...keccak_256(got.payload)])));
    assert.equal(digest, e.digest.toLowerCase());
    // 交易线索就是那笔发送交易，回执里有这条 Sent
    assert.equal(got.txHint, r1.transactionHash.toLowerCase());
    const [rc] = await rpc.many([{ method: 'eth_getTransactionReceipt', params: [got.txHint], normalize: normalizeReceipt }], { all: true });
    assert.ok(rc.raw.logs.some((l) => { try { const d = chain.decodeSentLog(l); return d && d.to === me.endpoint && d.inboxIndex === BigInt(e.index); } catch { return false; } }));

    const ob = await chain.outbox(container, { block, limit: 5 });
    assert.equal(ob.count, outBefore + 2);
    assert.equal(ob.items[0].to, base);
    assert.equal(ob.items[1].to, me.endpoint);

    // 内容指纹不对的一律拒绝
    await assert.rejects(chain.fetchMessage({ ...e, digest: '0x' + '0'.repeat(64) }), (err) => err.code === 'unavailable');
  } finally {
    anvil.kill();
  }
});
