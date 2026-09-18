# @tapekit/send

Reference implementation of TAP-10, the DeWEB messaging layer: keys, payloads, content and attachments, endpoint IDs, and strict chain reads. Built on the TapeKit identity core (`kernel/src/identity.js`) and kept separate from the tape:// page kernel on purpose: key handling never shares a package with code that renders other people's websites.

TAP-10（DeWEB 消息层）的参考实现：公钥、载荷、内容与附件、端点号、多节点严格一致读链。建立在 TapeKit 核心的身份解析之上，并刻意与网页内核分开：私钥逻辑绝不和"运行陌生人的网页"放在同一个包里。

## Crypto and format / 加密与格式

```js
import {
  keyDerivationText, isDeterministic, deriveKeyPair,          // §4.2
  seal, openPayload, encodePublic, assertValidPublicKey,     // §5
  encodeContent, decodeContent, displayText, messageId,       // §6, §7
} from '@tapekit/send';

// chainId is the container's home chain; `endpoint` values are 32-byte endpoint IDs (TAP-10 §2.2)
const text = keyDerivationText({ tokenId, cpuIndex, container, holder, hub, chainId: 56, keyIndex: 0 });
const s1 = await wallet.signMessage(text);
const s2 = await wallet.signMessage(text);
if (!isDeterministic(s1, s2)) throw new Error('wallet is not deterministic');
const { secretKey, publicKey } = deriveKeyPair({ tokenId, cpuIndex, container, holder, hub, chainId: 56, signature: s1 });

const content = encodeContent({ subject, body, attachments });            // attachments: TAP-10 §6.1
const payload = seal({ content, recipients: [theirKey, publicKey], to: theirEndpoint, from: myEndpoint, hub, ref });
const opened = openPayload({ payload, secretKey, to: theirEndpoint, from: myEndpoint, hub, ref });
const message = decodeContent(opened.content); // render message.body with displayText(), as plain text only
```

## Chain / 链上

```js
import { createTapeSendChain } from '@tapekit/send/src/chain.js';

const chain = createTapeSendChain();                  // default public nodes, strict agreement
const me = await chain.resolveEndpoint('#15324@30');  // identity, key view, factory and hub seal status
const page = await chain.inbox(me.endpoint, { limit: 50 });          // on-chain inbox, newest first
const { payload, ref, txHint } = await chain.fetchMessage(page.items[0]); // checked against the stored digest
const F = await chain.finalizedBlock();               // smallest `finalized` height across nodes (TAP-10 §7)
const tx = chain.encodeSend({ circuits: me.circuits, tokenId: me.tokenId, to: recipient.endpoint, ref, payload });
```

Every read that decides where a message goes, who sent it or whether it is real uses strict agreement: all configured nodes are asked, any disagreement rejects, and the agreeing answers must come from at least three operators (or every operator if fewer are configured), never fewer than two (TAP-10 §1). A payload may come from any single node; it is accepted only if it matches the digest stored in the hub.

凡是决定"消息发给谁""是谁发的""是不是真的"的读取都用严格一致：问所有节点，任何分歧都拒绝，一致的回答至少来自三家运营方（配置不足三家时要全部一致），任何情况下不少于两家（TAP-10 §1）。载荷可以从任意一个节点取回，但必须与中枢里存的内容指纹一致才采用。

## Tests / 测试

| Command | What |
|---|---|
| `npm test` | Offline: crypto, content, attachments, endpoint rules and all test vectors |
| `npm run test:mainnet` | Read-only against the live hub on BSC: resolution, key view, inbox, payload fetch, finality |
| `npm run test:fork` | End to end on a local anvil fork of BSC: deploy the current implementation, upgrade the hub, publish a key, send, read back. Needs `anvil`, `cast` and `forge build` in `send/contracts` |
| `npm run vectors` | Regenerate `test/vectors.json` (self-checks every intermediate value) |
