// 主网只读（DeWEB 中枢 v2 已部署）：端点解析、公钥读取、信箱读取、按指纹取回载荷、交易线索核对、最终性高度。
// 需要联网；读的是真实链上数据，结果会随新消息增加，所以只断言不变量。
import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { createTapeSendChain, normalizeReceipt, endpointId, endpointLabel, HUB_MAINNET, HUB_SIG, HUB_SEL, HUB_TOPIC, chainsFromBitmap } from '../src/chain.js';
import { bytesToHex, hexToBytes } from '../src/index.js';

const chain = createTapeSendChain();
const hex = (s) => bytesToHex(keccak_256(new TextEncoder().encode(s)));

test('selectors and topics are derived from the signatures', () => {
  for (const k of ['send', 'publishKey', 'inboxCount', 'inboxPage', 'outboxCount', 'outboxPage', 'keyFor']) {
    assert.equal(HUB_SEL[k], hex(HUB_SIG[k]).slice(0, 10), k);
  }
  assert.equal(HUB_TOPIC.Sent, hex(HUB_SIG.Sent));
  assert.equal(chain.hub, HUB_MAINNET);
});

test('resolves #4246@0 and reads its key with a bitmap that includes BNB', async () => {
  const r = await chain.resolveEndpoint('#4246@0');
  assert.equal(r.status, 'ok');
  assert.equal(r.container.toLowerCase(), '0x86ddaef00401e3f10418398d67d7189fc458ea95');
  assert.equal(r.endpoint, endpointId(56, r.container));
  assert.equal(endpointLabel(4246n, 0n), '#4246@0');
  if (r.key.usable) {
    assert.ok(r.key.chainsBits > 0n);
    assert.deepEqual(r.key.chains, chainsFromBitmap(r.key.chainsBits));
    assert.ok(r.key.chains.includes(56));
  }
});

test('inbox entries fetch a payload matching the on-chain digest, and the tx hint checks out', async (t) => {
  const r = await chain.resolveEndpoint('#4246@0');
  const page = await chain.inbox(r.endpoint, { limit: 3 });
  if (!page.items.length) return t.skip('inbox is empty');
  for (const e of page.items) {
    assert.equal(e.to, r.endpoint);
    const got = await chain.fetchMessage(e);
    const digest = bytesToHex(keccak_256(new Uint8Array([...hexToBytes(got.ref), ...keccak_256(got.payload)])));
    assert.equal(digest, e.digest.toLowerCase());
    // 交易线索：多节点读回执，里面必须有这条 Sent（区块、收件端点、发件容器、序号、载荷都一致）
    assert.match(got.txHint, /^0x[0-9a-f]{64}$/);
    const [rc] = await chain.rpc.many([{ method: 'eth_getTransactionReceipt', params: [got.txHint], normalize: normalizeReceipt }], { all: true });
    assert.ok(rc.ok && rc.raw);
    assert.equal(BigInt(rc.raw.blockNumber), BigInt(e.blockNumber));
    const sent = rc.raw.logs.map((l) => { try { return chain.decodeSentLog(l); } catch { return null; } }).filter(Boolean);
    assert.ok(sent.some((d) => d.to === e.to && d.from === e.from.toLowerCase() && d.inboxIndex === BigInt(e.index) && bytesToHex(d.payload) === bytesToHex(got.payload)));
  }
});

test('a digest that does not match is refused', async (t) => {
  const r = await chain.resolveEndpoint('#4246@0');
  const page = await chain.inbox(r.endpoint, { limit: 1 });
  if (!page.items.length) return t.skip('inbox is empty');
  const e = { ...page.items[0], digest: '0x' + '0'.repeat(64) };
  await assert.rejects(chain.fetchMessage(e), (err) => err.code === 'unavailable');
});

test('finalized block is at or below the latest block', async () => {
  const f = await chain.finalizedBlock();
  assert.ok(f !== null, 'at least 3 nodes answer finalized');
  const latest = BigInt(await chain.rpc.pinBlock());
  assert.ok(f <= latest + 5n);
  assert.ok(latest - f < 1000n, 'finalized is recent');
});
