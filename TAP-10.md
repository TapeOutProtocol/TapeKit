---
tap: 10
title: TapeSend — DeWEB Messaging Between Circuit Containers
author: TapeOutProtocol
status: Draft
type: Standards Track
version: 1.0
created: 2026-09-17
updated: 2026-09-18
requires: tape:// specification v0.2 (SPEC.md)
license: CC0-1.0
---

# TAP-10: TapeSend — DeWEB Messaging Between Circuit Containers

**English** (normative) · [中文](TAP-10.zh.md)

- Status: **Draft**, version **1.0**, 2026-09-18. It stays a draft until the hub is sealed (§3.7), after which it becomes Final. Replaces draft v0.5 (2026-09-17), which described a single-chain hub, an indexer and payload format `0x01`; none of those are in use. See Appendix A for what changed.
- Deployed on BNB Smart Chain (chainId 56). Other chains are listed in §2.1 but not active.
- Depends on: the tape:// specification v0.2 ([SPEC.md](SPEC.md)) for names, resolution and node agreement.
- License: this text is dedicated to the public domain under CC0 (`LICENSE-SPEC`); reference implementations are MIT (`LICENSE`).
- Key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, **MAY** are to be interpreted as in RFC 2119.
- **Not independently audited.** All reviews so far were internal.

## 0. Scope

A TapeOut circuit container is an ERC-6551 account bound to a circuit NFT. SPEC.md makes it the address of a website. This specification makes the same container an **endpoint** that sends and receives messages across chains:

1. endpoints and the chain table (§2);
2. the **DeWEB hub** contract, which authorizes senders and keeps an on-chain inbox and outbox (§3);
3. encryption keys derived from a wallet signature (§4);
4. the payload and content formats, including attachments (§5, §6);
5. message identity, finality, reading and sending (§7–§10).

A message is written to the hub **on the sender's chain**. A recipient reads its inbox on every chain it has declared (§4.3). There is no bridge, no indexer and no server in the message path; every client verifies what it reads against the chain.

Sending and publishing a key cost gas only. The sender's container must be opened (its one-time opening fee paid); the recipient's need not be.

## 1. Terms and notation

| Term | Meaning |
|---|---|
| Processor, processor number, #ID, container | As in SPEC.md §1 |
| Processor contract | The circuit NFT contract of a processor: `factory.cpuAt(processor number)` |
| Holder | The current `ownerOf(#ID)` of the circuit NFT |
| Plain account | An address with no code, or whose code is exactly an EIP-7702 delegation designator (`0xef0100` followed by 20 bytes, 23 bytes in total) |
| Opened | `payments.paid(container)` is true |
| Endpoint, endpoint ID | §2.2 |
| Hub | The DeWEB hub contract on one chain (§3). It has the same address on every chain |
| Home chain | The chain a container lives on; a container's key is published on the hub of its home chain |
| Entry | One record in an inbox (§3.6) |
| Payload | The bytes carried by a message (§5) |
| Content | The JSON object inside a payload (§6) |
| Pinned block | §8.2 |
| Answer | A well-formed JSON-RPC result, including `null` and an execution revert. Transport errors, other JSON-RPC errors, timeouts and malformed results are not answers |
| Strict agreement | A read sent to every configured node and adopted only when every answer agrees after normalization and the agreeing answers come from at least max(2, min(3, number of configured operators)) different operators. Any disagreement means rejection; too few answers means `unavailable`. Each node carries an operator label, and agreement counts operators, not URLs |

Notation: `‖` is byte concatenation. `uint256(x)` is the 32-byte big-endian encoding of `x`; `uint64(x)` and `uint32(x)` are 8- and 4-byte big-endian. An address in a byte string is its 20 raw bytes. ASCII labels such as `"TAP-10/key/v2"` are used as their raw bytes, without a terminator. Hex is lowercase and `0x`-prefixed unless stated otherwise.

## 2. Chains and endpoints

### 2.1 Chain table

The chain table is part of this specification. Each chain has a fixed **index**, used as the bit position in the receiving-chains bitmap (§4.3).

| Index | Chain | chainId | Short name | Status |
|---|---|---|---|---|
| 0 | BNB Smart Chain | 56 | `bnb` | Active (hub deployed with a reviewed implementation) |
| 1 | Base | 8453 | `base` | Listed, not active |
| 2 | X Layer | 196 | `xlayer` | Listed, not active |

A chain becomes active when the TapeOut circuit protocol and a reviewed hub implementation are deployed on it and its implementation is added to §3.2. Indexes are never reused or renumbered; new chains are appended.

### 2.2 Endpoint ID

```
endpoint ID = uint32(0) ‖ uint64(chainId) ‖ container      (32 bytes)
```

- The top 4 bytes **MUST** be zero, `chainId` **MUST** be non-zero and the container address **MUST** be non-zero. The hub rejects anything else with `BadEndpoint` (§3.5);
- The endpoint ID is globally unique: the same container address on two chains gives two different endpoints;
- Clients **MUST** reject endpoint IDs whose `chainId` exceeds 2^53 − 1 (such chains are not supported).

### 2.3 Display form and input

```
#<#ID>@<processor number>                  on BNB Smart Chain
#<#ID>@<processor number>.<short name>     on any other chain
```

- Both numbers are decimal ASCII without leading zeros (except `0`); 1 ≤ #ID ≤ 10^18, 0 ≤ processor number ≤ 10^9. Example: `#4246@0`, `#15324@30.base`;
- A chain not in §2.1 is shown as `.chain<chainId>`;
- On BNB Smart Chain, `#4246@0` and `4246.0.tape` (SPEC.md §2.2) denote the same container, and a client **MUST** produce identical resolution results for both;
- `#` is the URL fragment delimiter, so the display form is only for display and typing; in a URL write `4246.0` or `4246.0.tape`.

A client **SHOULD** accept every input form of SPEC.md §2.4 and display the form above after resolution. Anything else **MUST** be rejected; the client **MUST NOT** guess.

### 2.4 Resolution

All reads are made at one pinned block (§8.2) under strict agreement:

- Name forms: SPEC.md §3.2 steps 1–4; address forms: SPEC.md §3.3 steps 1–4, then SPEC.md §3.2 step 4;
- Then `hub.keyFor(processor contract, #ID)` (§3.5). The `container` it returns **MUST** equal the resolved container, and its `endpoint` **MUST** equal `endpointID(chainId, container)` for the chain being read; otherwise the client **MUST** stop (`hub-mismatch`);
- The client **MUST** confirm with `eth_chainId`, under strict agreement, that the nodes are on the expected chain (`wrong-chain` otherwise). The chain ID of an endpoint is taken only from the client's configuration, never from data.

SPEC.md §3.2 steps 5–7 and §4.3 do **not** apply to messaging: an unpaid on-chain name, a changed site-store implementation or a site blocklist entry **MUST NOT** prevent messaging.

The result is (chain, processor contract, processor number, #ID, container, endpoint ID, holder, opened, key view). Only the **sender** must be opened; the hub enforces it.

## 3. The DeWEB hub

### 3.1 Properties

- An ERC-1967 proxy over a UUPS implementation. Until it is **sealed** its owner can replace the implementation (§3.7); after `seal()` there is no owner and no upgrade path;
- The implementation has no payable function, no `receive` and no `fallback`, so every call carrying BNB reverts; the hub holds no assets and has no function that moves assets;
- It makes no state-changing call elsewhere. It reads other contracts only through bounded `staticcall`s: 100,000 gas each, return data never copied beyond 32 bytes, exactly 32 bytes required. A failed or malformed read counts as "not authorized" (a revert, no code, return data that is not 32 bytes, a boolean other than 0 or 1, or an address word with non-zero upper 96 bits). A failed registry read, or a zero registry answer, reverts `RegistryFailed`;
- An under-gassed transaction reverts with an authorization error rather than running out of gas (63/64 rule). Wallets **MUST** use gas estimation;
- It does not parse payloads.

### 3.2 Deployment

All three contracts are deployed through the deterministic CREATE2 deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C`, so every address can be recomputed from source.

| Item | Value |
|---|---|
| Build | solc 0.8.28, optimizer on, 10,000 runs, EVM `shanghai`, legacy pipeline (no via-IR), `bytecode_hash = none`, `cbor_metadata = false` |
| Boot implementation | salt `keccak256("DeWEB Boot v1")`; creation code of `DeWebBoot`, no arguments. Address **`0xC0D28CA8689248B0bed26cC0aa328CF16Aa4401e`**, the same on every chain |
| Hub (proxy) | salt `keccak256("DeWEB Hub v1")`; `DeWebProxy` creation code ‖ `abi.encode(boot, abi.encodeCall(initialize, (owner)))`. With owner `0x571d447f4f24688eC35Ccf07f1D6993655F6aF15` the address is **`0xe61A9C7213a6Aa616C246a2B569e555B417b25ee`**, the same on every chain |
| Implementation | salt `keccak256("DeWEB Hub impl v2")`; `DeWebHub` creation code ‖ `abi.encode(uint256 expectedChainId, registry, accountImplementation, factory, payments, circuitBeacon, circuitImplementation, circuitCodehash)`. Its address differs per chain because the arguments do |

The boot implementation only allows its owner to upgrade (it cannot be sealed); it exists so that the hub address does not depend on any chain's TapeOut addresses.

**Reviewed implementations on BNB Smart Chain** (a client **MUST** accept the hub only while its implementation slot holds a listed address, §3.8):

| Version | Address | State |
|---|---|---|
| v3 | `0x80aFE7B77F2dFD08e9feab7675780baC34a7EE85` | **Current**, since block 122623031 (2026-09-18) |
| v2 | `0x7dF03218910E0F37FC3A8DA8792831ab7580340F` | Replaced; no longer accepted (it allowed an upgrade to a proxy still in its boot phase) |
| v1 | `0xf5f18e3fe811b9b382C90539d14440654E789d92` | Replaced the same day; no longer accepted |

Constructor arguments of the BNB Smart Chain implementation, immutable:

| Argument | Value |
|---|---|
| `expectedChainId` | `56` (the constructor reverts `WrongChain` on any other chain, and `BadEndpoint` if the chain ID is 0 or above 2^64 − 1) |
| `registry` | `0x000000006551c19487814612e58FE06813775758` (ERC-6551 registry) |
| `accountImplementation` | `0xAf4E78a2257C9c5480c2F8310E3b00437260751d` (container implementation) |
| `factory` | `0x68224F668083c29e9800Be2a646d42d18cedF7e2` (processor factory, UUPS proxy) |
| `payments` | `0xc0C643eb9820eF208Ea38bb2c8E8377047D9fa4c` (container payments table) |
| `circuitBeacon` | `0xf8D6d8EB894d6971c8976Ad8b4971cbEFE028156` |
| `circuitImplementation` | `0x8E1D125Def6d3826C278299273a0760D47626068` (processor implementation pinned at deployment) |
| `circuitCodehash` | `0xd8c4b0216e0aadd615fbd134465b6af060a11769edc7c844d8f14d1b8a783992` (runtime code hash of every processor proxy) |

### 3.3 Storage

Two ERC-7201 namespaces, so records survive upgrades:

- `deweb.admin.v1` at `0x736671d3d7aa7b8c7f898557852b1cc8f6b8b590d42594c0a8eca138259d9100`: `owner`, `sealed`, `initialized`, `pendingOwner`;
- `deweb.hub.v1` at `0x52508d06499dccc2446f87bf89abfddc2d85f3e5a1bdd29ea2bc99cdfd6b2000`: key records, inbox counts and entries, outbox counts and entries.

A future implementation **MUST** keep both namespaces and their layouts.

### 3.4 Authorization

Every write names a circuit as `(processor contract, #ID)`. The hub checks, in this order:

1. `circuitBeacon.implementation()` equals `circuitImplementation`, otherwise `CircuitsChanged`;
2. the code hash of the processor contract equals `circuitCodehash`, otherwise `NotCPU`;
3. `factory.isCPU(processor contract)` is true, otherwise `NotCPU`;
4. `processor contract.ownerOf(#ID)` returns `msg.sender`, otherwise `NotHolder`;
5. the container is `registry.account(accountImplementation, 0, block.chainid, processor contract, #ID)`; a failed read reverts `RegistryFailed`;
6. `payments.paid(container)` is true, otherwise `NotOpened`.

The container is then the author. Consequences:

- only the current holder of an opened circuit on a registered processor can write for its container; after a transfer the new holder speaks for the same container;
- `send` and `revokeKey` accept **any** holder, including contracts. A contract the holder approved for the circuit NFT (for example a marketplace) can therefore take the NFT, write as the container and return it within one transaction. The hub cannot see this; clients detect it (§8.6);
- a lasting replacement of the processor implementation stops every write and makes every key unusable; a new hub would be needed;
- the pin cannot detect a **temporary** replacement by whoever controls an unsealed factory (§3.8).

### 3.5 Interface

**Writes** (each reverts `NotProxy` when called on the implementation directly):

| Function | Selector | Behaviour, in order |
|---|---|---|
| `send(address circuits, uint256 tokenId, bytes32 to, bytes32 ref, bytes payload) returns (uint256 inboxIndex)` | `0xa181b579` | `BadEndpoint` unless `to` is a valid endpoint ID (§2.2); `EmptyPayload` if empty; `PayloadTooLarge(size, 16000)` if longer than 16,000 bytes; §3.4; `BoxFull` if the recipient's inbox or the sender's outbox already holds 2^32 − 1 entries; appends an inbox entry and an outbox entry (§3.6); emits `Sent`. `to` may be on any chain and need not be opened |
| `publishKey(address circuits, uint256 tokenId, uint8 suite, uint16 keyIndex, bytes32 key, uint64 chains)` | `0x23e0bbc6` | `BadSuite` unless `suite == 1`; `EmptyKey` if `key == 0`; `NoChains` if `chains == 0`; §3.4; `ContractHolder` unless `msg.sender` is a plain account, and also when `msg.sender` has no code but is not `tx.origin`; stores the record with `holder = msg.sender` and `publishedAt = block.timestamp`, increments `version`; emits `KeyPublished` |
| `revokeKey(address circuits, uint256 tokenId)` | `0x08394925` | §3.4; `NoKey` if there is no key; zeroes `key`, `holder`, `suite`, `keyIndex`, `chains`, sets `publishedAt`, increments `version`; emits `KeyRevoked` |

**Reads:**

| Function | Selector | Returns |
|---|---|---|
| `keyFor(address circuits, uint256 tokenId)` | `0x3145c6cb` | `KeyView(address container, bytes32 endpoint, bool opened, address current, uint8 suite, uint16 keyIndex, bytes32 key, bool usable, uint32 version, uint64 chains)`. `current` is `ownerOf` or 0 if that read fails. `usable` is true only when a key exists, `current != 0`, the stored holder equals `current`, `current` is a plain account, and the processor is genuine (§3.4 steps 1–3). **When `usable` is false, `suite`, `keyIndex`, `key` and `chains` are returned as 0**; `version` is always returned. Reverts only `RegistryFailed` |
| `keyOf(address container)` | `0xfa073d76` | The raw record `(bytes32 key, address holder, uint40 publishedAt, uint8 suite, uint16 keyIndex, uint32 version, uint64 chains)`, unchecked. Clients **MUST NOT** use it to decide whether to encrypt |
| `inboxCount(bytes32 to)` | `0x9343ecd9` | Number of entries in `inbox[to]` on this chain |
| `inboxAt(bytes32 to, uint256 i)` | `0x3e605450` | `Entry`; reverts `OutOfRange` if `i ≥ inboxCount(to)` |
| `inboxPage(bytes32 to, uint256 start, uint256 n)` | `0x2eec4913` | `Entry[]` from `start`, oldest first, at most `min(n, 200)` entries; empty when `start ≥ count` |
| `outboxCount(address from)` | `0xf0549006` | Number of messages sent by container `from` on this chain |
| `outboxPage(address from, uint256 start, uint256 n)` | `0xcf082720` | `OutEntry[]` as for `inboxPage` |
| `digestOf(bytes32 ref, bytes payload)` | `0x120950e3` | `keccak256(ref ‖ keccak256(payload))` |
| `endpointOf(address container)` | `0x4b893642` | The endpoint ID of `container` on this chain |
| `accountOf(address circuits, uint256 tokenId)` | `0x0c1905e5` | The container address (does not check that `circuits` is a processor) |
| `MAX_PAYLOAD()`, `MAX_PAGE()`, `SUITE_X25519()` | `0xcfdd2b73`, `0x69fc09b9`, `0xda582a0e` | `16000`, `200`, `1` |
| `registry()`, `accountImplementation()`, `factory()`, `payments()`, `circuitBeacon()`, `circuitImplementation()`, `circuitCodehash()` | | The constructor arguments |

`version` is per container, starts at 0, increases by exactly 1 on every publish and revoke, and never resets. `keyIndex` is not forced to increase; clients use `version` to detect change. If the NFT returns to the holder who published the current record, `usable` becomes true again without re-publishing.

**Events:**

| Event | topic0 |
|---|---|
| `Sent(bytes32 indexed to, address indexed from, bytes32 indexed ref, uint256 inboxIndex, uint256 outboxIndex, bytes payload)` | `0xd75bb8082dd3ae8bb88682115ee1412a8e8051cc81d0e4c01dc3b06c0cf61020` |
| `KeyPublished(address indexed container, address indexed holder, uint8 suite, uint16 keyIndex, bytes32 key, uint32 version, uint64 chains)` | `0x3508619c70f595e587bda151c8e0d612b9b2bb7b2e9f7d35696ff38cbdf0f85d` |
| `KeyRevoked(address indexed container, address indexed holder, uint32 version)` | `0xd360cbf79f51b9effe9910886c31cb5727df68b64e1cadc0be214931a7fb84c9` |
| `Upgraded(address indexed implementation)` | `0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b` |
| `OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)` | `0x38d16b8cac22d99fc7c124b9cd0de2d3fa1faef420bfe791d8c362d765e22700` |
| `OwnerChanged(address indexed previousOwner, address indexed newOwner)` | `0xb532073b38c83145e3e5135377a08bf9aab55bc0fd7c1179cd4fb995d2a5159c` |
| `HubSealed()` | `0xa38d24a530434d3ab8b3f3f3f3a54ea1f987dddceba505bd3bd1f05dfa2106ad` |

For `Sent`: topic1 = `to`, topic2 = `from` (low 20 bytes), topic3 = `ref`; `data` is the ABI encoding of `(uint256 inboxIndex, uint256 outboxIndex, bytes payload)`.

**Errors:** `BadEndpoint` `0xd98d0ab4`, `EmptyPayload` `0x2e3f1f34`, `PayloadTooLarge(uint256,uint256)` `0x04247564`, `BoxFull` `0x12b9de4e`, `BadSuite` `0xe9b6829d`, `EmptyKey` `0x3cd69fac`, `NoChains` `0xa41d7dc9`, `NoKey` `0x80246e7f`, `ContractHolder` `0xc21b8423`, `NotCPU` `0x853f2907`, `NotHolder` `0x7623fb52`, `NotOpened` `0x6d36408a`, `CircuitsChanged` `0x2ffa540a`, `RegistryFailed` `0x06215c9b`, `OutOfRange` `0x7db3aba7`, `WrongChain` `0x10dfc033` (constructor), `NotAContract` `0x09ee12d5`, `ZeroAddress` `0xd92e233d`, `NotProxy` `0xbf10dd3a`, `NotOwner` `0x30cd7471`, `NotPendingOwner` `0x1853971c`, `Sealed` `0x1b2d71eb`, `NotUUPS` `0xf2fc2b29`, `NotDelegated` `0x9ccd6d76`, `AlreadyInitialized` `0x0dc149f0`.

### 3.6 Inbox and outbox

For each message, `send` stores:

```
Entry    { address from; uint56 blockNumber; uint40 timestamp; bytes32 digest }      in inbox[to][inboxIndex]
outbox[from][outboxIndex] = uint256(to) << 32 | inboxIndex
digest   = keccak256(ref ‖ keccak256(payload))
```

`outboxPage` returns `OutEntry { bytes32 to; uint32 inboxIndex; uint56 blockNumber; uint40 timestamp; bytes32 digest }`, joined with the inbox entry it points to. Both lists only grow; entries are never changed or removed.

`inboxPage` returns a static-struct array: `offset (= 0x20) ‖ length ‖ length × 4 words`; `outboxPage` uses 5 words per element. A client **MUST** reject a result whose length word exceeds 200, whose byte length does not match, or whose fields exceed their widths (addresses 160 bits, `blockNumber` 56, `timestamp` 40, `inboxIndex` 32).

The payload itself is **not** stored; it is only in the `Sent` event. The digest binds the payload and `ref` to the entry; it does not bind sender, recipient or index, so a client **MUST NOT** match a log to an entry by digest alone (§8.4).

### 3.7 Administration

| Function | Selector | Behaviour |
|---|---|---|
| `owner()`, `pendingOwner()`, `isSealed()` | `0x8da5cb5b`, `0xe30c3978`, `0x631f9852` | Current values |
| `transferOwnership(address)` | `0xf2fde38b` | Owner only; `ZeroAddress` for 0; sets `pendingOwner` |
| `acceptOwnership()` | `0x79ba5097` | The pending owner only; `Sealed` after sealing |
| `upgradeToAndCall(address impl, bytes data)` | `0x4f1ef286` | Owner only and not sealed; `ZeroAddress`, `NotAContract`; `NotUUPS` if `impl` is the proxy itself, if `impl.proxiableUUID()` does not return exactly 32 bytes equal to the ERC-1967 slot, or if `impl.selfAddress()` does not return exactly 32 bytes equal to `impl`; sets the slot, emits `Upgraded`, then delegatecalls `data` if non-empty |
| `seal()` | `0x3fb27b85` | Owner only; clears `pendingOwner` and `owner`, sets `sealed`; emits `OwnerChanged(owner, 0)` and `HubSealed()`. Irreversible. The boot implementation cannot be sealed |
| `proxiableUUID()` | `0x52d1902d` | The ERC-1967 slot when called on an implementation; reverts `NotDelegated` through a proxy |
| `selfAddress()` | `0x12e905b0` | The implementation's own address, also through the proxy |

Every future implementation **MUST** satisfy the two checks above and keep the storage of §3.3. Because v2 and the boot implementation lack `selfAddress`, the hub cannot be downgraded from v3.

`seal()` does not itself check that the TapeOut factory is sealed. The factory **MUST** be sealed first (§3.8); otherwise a later lasting change of the processor implementation stops the sealed hub for good.

### 3.8 Seal status and trust

At the pinned block and under strict agreement, a client **MUST** read:

1. **Factory:** `factory.isSealed()`, the factory's ERC-1967 implementation slot, `circuitBeacon.owner()` and `circuitBeacon.implementation()`. The factory seal is in effect only when `isSealed()` returns exactly 1, the factory implementation is `0xa68ccf4931d98ad0a4be15ee40542edc0dec6422`, the beacon's owner is the factory, and the beacon's implementation is `circuitImplementation`;
2. **Hub:** `hub.isSealed()`, `hub.owner()` and the hub's ERC-1967 implementation slot. The hub is **accepted** only when the slot holds an implementation listed as current for that chain in §3.2 (`hub-changed` otherwise). The hub seal is in effect only when, in addition, `isSealed()` is 1 and `owner()` is 0.

Any revert, any non-canonical word (upper 96 bits of an address word non-zero) or any other value counts as not in effect.

- If `circuitBeacon.implementation()` is not `circuitImplementation`, messaging on that hub has stopped (`circuits-changed`); the client **MUST NOT** send and **MUST** keep this status even if later reads show the pinned value again;
- If the hub is not accepted, the client **MUST NOT** send;
- While either seal is not in effect, whoever controls the factory or the hub owner can impersonate endpoints and replace keys. A client **SHOULD** indicate this wherever it shows sender identities or encrypts. A client that has once seen the factory seal in effect and later sees it not in effect at a block not earlier than the first **MUST** keep treating the seal as lost;
- An upgrade can rewrite storage within one transaction and restore an accepted implementation, leaving only an `Upgraded` log. When log-capable nodes are available, a client **SHOULD** read every `Upgraded` log of the hub and accept the hub only if every implementation it names is the boot implementation or listed in §3.2 (current or replaced).

The seals are recorded per chain and per hub address; sticky statuses of one chain **MUST NOT** affect another.

## 4. Keys

### 4.1 Suite

Suite `1`: X25519 (RFC 7748), HKDF-SHA256 (RFC 5869), XChaCha20-Poly1305 (32-byte key, 24-byte nonce, 16-byte tag), SHA-256. Public keys are the 32-byte RFC 7748 encoding, stored byte for byte in `bytes32 key`.

### 4.2 Deriving the key from the wallet

The private key is never stored on chain or on a server. It is derived from a wallet signature over a fixed text.

1. Build the text `T` (EIP-4361 form): ASCII, exactly these 14 lines, single `0x0A` separators, no trailing newline. `<holder>`, `<container>` and `<hub>` are EIP-55 checksummed; numbers are decimal without leading zeros; `<chainId>` is the **home chain** of the container; `#<#ID>` is one `#` followed by the decimal #ID.

```
www.tapesend.com wants you to sign in with your Ethereum account:
<holder>

Create the TapeSend encryption key for #<#ID>@<processor number>. Anyone who obtains this signature can read your messages. Only sign this on www.tapesend.com or in the official TapeSend app.

URI: https://www.tapesend.com
Version: 1
Chain ID: <chainId>
Nonce: tapesendkey<k>
Issued At: 2026-09-17T00:00:00Z
Resources:
- tapesend:container:<container>
- tapesend:hub:<hub>
- tapesend:key-index:<k>
```

2. Ask the holder's wallet for `personal_sign` of `T` (EIP-191). The signature is 65 bytes `r ‖ s ‖ v`; `v` **MUST** be 0, 1, 27 or 28.
3. Reject if `r` or `s` is 0 or ≥ n (secp256k1 order). Recover the signer from the signature as given and require it to equal the holder.
4. If `s > n/2`, replace `s` with `n − s`. `v` is discarded.
5. ```
   seed = HKDF-SHA256(salt = "TAP-10/key/v2", IKM = r ‖ s,
                      info = endpointID(chainId, container) ‖ uint256(k) ‖ hub, L = 32)
   ```
6. The X25519 private key is `seed`; the public key is `X25519(seed, 9)`.

The fixed domain makes EIP-4361-aware wallets warn when any other site asks for this signature. This protection is partial (not every wallet checks; WalletConnect origins are self-declared). Therefore the official web client **MUST** be served only from `https://www.tapesend.com`, that origin **MUST NOT** run any other EIP-4361 sign-in, and the signature and derived key **MUST NOT** leave the device.

**Determinism.** Derivation requires deterministic signatures (RFC 6979). Before publishing a new key a client **MUST** obtain two signatures of `T` with equal normalized `r ‖ s`. Whenever it derives a key while `keyFor` reports a usable key with the connected wallet as holder and the same `keyIndex`, it **MUST** compare the derived public key with the on-chain key and **MUST NOT** use or publish on a mismatch. A client **MAY** skip the second signature when that comparison succeeds. Smart-contract wallets cannot derive a key (§3.5 refuses them).

### 4.3 Publishing and receiving chains

The holder calls `publishKey(processor contract, #ID, 1, k, publicKey, chains)` on the hub of the container's home chain. `chains` is the **receiving-chains bitmap**: bit `i` set means the holder reads its inbox on the chain with index `i` in §2.1. It **MUST NOT** be 0. A client **SHOULD** publish all active chains and **SHOULD NOT** set bits of chains it does not read.

A client **SHOULD** skip the transaction when `keyFor` already reports the same key and `keyIndex` as usable, and **SHOULD NOT** publish twice for one request (for example after a wallet timeout it **MUST** re-read `keyFor` before trying again).

### 4.4 Using a recipient's key

Before sealing to an endpoint, a client **MUST**:

1. resolve it (§2.4) on its home chain and read `keyFor` at a fresh pinned block under strict agreement;
2. require `suite == 1` and `usable == true`;
3. reject the key if byte 31 has its top bit set, if its little-endian value is ≥ 2^255 − 19, or if it is a low-order point (u = 0, 1, 325606250916557431795983626356110631294008115727848805560023387167927233504, 39382357235489614581723060781553021112529911719440698176882885853963445705823, or p − 1). Any X25519 error or an all-zero shared secret also means rejection;
4. require that the recipient's bitmap has the bit of the **sending chain** set, judged on the raw bitmap (an unknown bit does not count). Otherwise the recipient does not read that chain and the client **MUST NOT** send (`wrong-chain`).

When an endpoint has no usable key, a client **MAY** send a public message (§5.2) only after telling the sender in plain words that everyone can read it, and **MUST NOT** fall back silently. A recipient without a usable key is assumed to read only its home chain.

### 4.5 Key lifetime and rotation

- A key record is tied to the holder that published it; after a transfer `usable` is false until the new holder publishes;
- The same holder derives the same key for the same container, chain, hub and `k`;
- To rotate, publish with a higher `k`. Messages sealed to the old key remain readable by whoever holds it;
- `k` is 0..65535. A client **SHOULD** use `k = 0` first and, when rotating, `max(version, keyIndex + 1)` (using `keyIndex + 1` only when the current record is the holder's own usable key);
- A client opening older messages **MAY** try earlier `k` values of the same holder; a derived key is used only if its fingerprint matches a slot.

## 5. Payload

### 5.1 Header

| Offset | Size | Field |
|---|---|---|
| 0 | 2 | Magic `0x54 0x53` (`TS`) |
| 2 | 1 | Format version `0x02` |
| 3 | 1 | Kind: `0x00` public, `0x01` sealed |

A payload with another magic, version (including `0x01` of draft v0.5) or kind, shorter than 4 bytes or longer than 16,000 bytes is `unsupported` and **MUST NOT** be interpreted further.

### 5.2 Public payload (kind `0x00`)

Bytes 4.. are the content (§6), in the clear.

### 5.3 Sealed payload (kind `0x01`)

| Offset | Size | Field |
|---|---|---|
| 4 | 32 | `E`: ephemeral X25519 public key |
| 36 | 24 | `N`: nonce |
| 60 | 32 | `D`: key commitment `SHA-256("TAP-10/commit/v2" ‖ K)` |
| 92 | 1 | `n`: number of key slots, 1 ≤ n ≤ 16 |
| 93 | 56·n | Slots, each `fingerprint (8) ‖ wrapped key (48)` |
| 93 + 56·n | rest | `C`: encrypted content including its 16-byte tag |

Let `P` be the first 93 bytes and

```
X = "TAP-10/X/v2" ‖ endpointID(to) ‖ endpointID(from) ‖ ref ‖ hub
```

where `to` is the recipient endpoint ID given to `send`, `from` the sender's endpoint ID (its chain is the sending chain), `ref` the 32-byte `ref` and `hub` the hub address.

**Sealing:**

1. Generate `e` (32 bytes), `E = X25519(e, 9)`, `N` (24 bytes) and `K` (32 bytes) from a cryptographically secure generator, fresh for every message;
2. Key list: the recipient's usable key (§4.4), then **SHOULD** also the sender container's own usable key if it belongs to the connected wallet, so the sender can read its sent messages. Keys **MUST** be distinct and pass §4.4 step 3;
3. `D = SHA-256("TAP-10/commit/v2" ‖ K)`; `P = 0x54 ‖ 0x53 ‖ 0x02 ‖ 0x01 ‖ E ‖ N ‖ D ‖ n`;
4. For each key `R` in order: `ss = X25519(e, R)` (reject all zero); `kek = HKDF-SHA256(salt = "TAP-10/wrap/v2", IKM = ss, info = E ‖ R ‖ X, L = 32)`; `wrapped = XChaCha20-Poly1305-Encrypt(kek, N, K, aad = P ‖ X)`; slot = `SHA-256(R)[0..8) ‖ wrapped`;
5. `S` = the slots; `C = XChaCha20-Poly1305-Encrypt(K, N, content, aad = P ‖ S ‖ X)`;
6. Payload = `P ‖ S ‖ C`, at most 16,000 bytes (content up to 15,835 bytes with one slot, 15,779 with two).

**Opening** (private key `r`, public key `R`; `to`, `from`, `ref` from the verified entry and event):

1. `damaged` if shorter than 93 bytes, `n` outside 1..16, shorter than `93 + 56·n + 16`, or `E` fails §4.4 step 3;
2. For each slot whose fingerprint equals `SHA-256(R)[0..8)`: derive `kek` and decrypt `wrapped`; the slot yields `K` only if decryption succeeds and `SHA-256("TAP-10/commit/v2" ‖ K) = D`;
3. No slot yields `K`: `damaged` if some fingerprint matched, otherwise `not-for-key`;
4. Decrypt `C` with `aad = P ‖ S ‖ X`; failure is `damaged` and nothing may be shown.

A client holding several keys tries each: `ok` if any opens, else `damaged` if any gave `damaged`, else `not-for-key`.

Because `to`, `from` (and so both chains), `ref` and the hub are bound into `X`, a payload does not open when replayed from another sender, to another recipient, with another `ref`, on another chain or through another hub. The commitment makes every reader obtain the same content. The sender can re-emit the same payload as a new message; clients show identical `(from, to, digest)` messages once (§8.5).

## 6. Content

Content is a UTF-8 JSON object (RFC 8259); surrounding whitespace is allowed.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `v` | number | yes | `1` |
| `kind` | string | yes | `"message"` |
| `subject` | string | no | At most 200 code points |
| `body` | string | yes | May be empty |
| `ts` | number | no | Sender-claimed milliseconds since the Unix epoch; informational |
| `attachments` | array | no | At most 4 attachments (§6.1) |

**Decoding**, in this order:

- `damaged` if not valid UTF-8, starts with `EF BB BF`, is not a JSON object, nests deeper than 32 levels, has a duplicate member name at any depth (after unescaping), or has an unpaired surrogate escape in any string or member name;
- `unsupported` if `v` is a number other than 1 or `kind` is a string other than `"message"`;
- `damaged` if `v` or `kind` is missing or of another type, `body` is missing or not a string, or `subject` is not a string;
- otherwise a message: `subject` is cut to 200 code points; a `ts` that is not an integer in 0..2^53−1 is ignored; unknown members are ignored.

**Attachments** never make a message `damaged`. Only the first 4 elements of an `attachments` array are considered; each that fails §6.1 is dropped, and the client **MUST** tell the reader how many were dropped (elements beyond the fourth count as dropped; a non-array `attachments` counts as one).

**Rendering:** `subject` and `body` **MUST** be rendered as plain text, never as HTML or markup. Bidirectional controls (U+061C, U+202A–U+202E, U+2066–U+2069), U+200B, U+200E, U+200F, U+2028, U+2029, U+2060–U+2064, U+FEFF, U+115F, U+180E, U+3164, U+FFA0 and C0/C1 controls other than line feed and tab **MUST** be made visible or removed. A client **MUST** show a full URL before opening it. The time of a message is its block time, not `ts`.

### 6.1 Attachment formats

| `type` | Fields | Rules |
|---|---|---|
| `image` | `mime`, `data`, `w`, `h` | `mime` is `image/webp`, `image/jpeg` or `image/png`; `data` is standard base64 with padding (length a multiple of 4) of 1..11,000 bytes whose leading bytes match the declared format; the **real** width and height read from the file header **MUST** be 1..2048 and **MUST** equal `w` and `h`. Rejected: animated PNG (an `acTL` chunk before `IDAT`), WebP `VP8X` with the animation flag (0x02), and JPEG other than baseline (the first SOF marker must be SOF0 or SOF1) |
| `native` | `chainId`, `amount`, `tx` | The chain's native coin sent to the recipient's container |
| `erc20` | `chainId`, `token`, `amount`, `tx` | A token transfer to the recipient's container |
| `erc721` | `chainId`, `token`, `tokenId`, `tx` | An NFT transfer to the recipient's container |

`chainId` is a safe integer > 0; `tx` a 32-byte transaction hash; `token` a 20-byte address; `amount` a non-zero decimal string without leading zeros (at most 78 digits); `tokenId` a decimal string (0 allowed). Hex is compared in lowercase.

An asset attachment is only a **claim**: the assets move in a separate transaction from the sender's wallet directly to the recipient's container; the hub never touches assets. The recipient's client verifies the claim (§9). A client **MUST NOT** offer a circuit NFT (a contract for which `factory.isCPU` is true, read under strict agreement; a failed read counts as true) as an attachment.

## 7. Message identity, order, replies and finality

- **Message ID** = `keccak256("TAP-10/msg/v2" ‖ uint256(chainId) ‖ hub ‖ endpointID(to) ‖ uint256(inboxIndex))`, where `chainId` is the chain whose hub holds the entry. It depends only on values read from storage under strict agreement;
- **Order:** by block time, then chain, then block number, then index;
- **Replies:** `ref` is chosen by the sender, public and unverified; a client **MUST NOT** assume the referenced message exists or involves the same parties, and groups conversations by the pair of endpoints, not by `ref`;
- **Finality:** a message is `pending` while its block is above the finalized height `F`. `F` is obtained by asking every node for `eth_getBlockByNumber("finalized")`, requiring answers from at least 3 nodes, and taking the **smallest**. When `F` cannot be obtained, messages within 30 blocks of the pinned block are `pending`. A reorganization can change which message holds an inbox index, and therefore its ID. For a `pending` message a client **MUST NOT** verify attachments, record anything persistent about it, or offer it as a reply target;
- `from` identifies a container, not a person; it proves only that the holder at that block, or a contract acting as holder (§3.4), controlled it.

## 8. Reading

### 8.1 Sources

The only source of messages is the inbox and outbox storage of a hub at the configured address, read with `eth_call`, plus `Sent` logs of that same address for payloads. Logs of any other address are not messages. No indexer is used or needed.

### 8.2 Pinned block and freshness

A client pins a block that at least the default quorum of nodes have reached, two blocks below the quorum-th highest head, waiting up to 1.5 seconds for every node's head. For every pinned block used for resolution, keys and sending, it **MUST** read the header under strict agreement and reject it as `stale-block` if its time is more than 300 seconds before the client clock, or `clock-skew` if more than 60 seconds after it.

### 8.3 Listing

For its endpoint, on every active chain whose bit is set in its own bitmap, a client reads under strict agreement at one pinned block:

- `inboxCount(endpoint)` and `inboxPage(endpoint, start, n)`, newest page first;
- `outboxCount(container)` and `outboxPage(container, start, n)` for sent messages (on its home chain).

Every entry **MUST** belong to the mailbox being read (the inbox entry's `to` is the reader's endpoint; the outbox entry's `from` is the reader's container); anything else is dropped and reported. A client **MAY** poll `inboxCount` and `outboxCount` with ordinary (non-strict) reads to detect new messages, but **MUST** reload through strict reads before showing anything, and **SHOULD** back off when counts keep changing.

### 8.4 Fetching payloads

For an entry at block `b`, a client asks **any one** node for the `Sent` logs of the hub in block `b` (`eth_getLogs` with `fromBlock = toBlock = b`, address = hub, topics `[Sent, to]`), or, if that node does not serve logs, for `eth_getBlockReceipts(b)`. It accepts a log only if it decodes as `Sent` from the hub with the entry's `to`, `from` and `inboxIndex`, and `keccak256(ref ‖ keccak256(payload))` equals the entry's digest. Otherwise it tries the next node. Only `ref` and `payload` are taken from the node.

The log's transaction hash is only a **hint** (`txHint`). Whoever uses it (§8.6, §9) **MUST** confirm it under strict agreement. A client **MUST NOT** cache a payload without a hint, and **MUST** drop a cached hint that failed confirmation, so that the next load asks another node.

### 8.5 Showing messages

- Messages from muted senders are not fetched;
- Messages with the same `(from, to, digest)` are the same payload sent again; a client shows one and **MAY** show the count;
- If the inbox and outbox reads give the same message ID with different digests, a reorganization happened between them: the client keeps one, marks it `pending` and reloads;
- To limit flooding, a client **SHOULD** fetch at most a few messages per page (the reference: 3) from each sender it has never written to, count the rest as folded, and let the user show them.

### 8.6 The sending wallet

The wallet that sent a message is determined from the message's own transaction, never from the circuit's current holder:

1. Read the receipt of `txHint` under strict agreement; require status 1, its block equal to the entry's block, and a `Sent` log from the hub with the entry's `to`, `from`, `inboxIndex`, `ref` and payload;
2. If the same receipt contains any ERC-721 `Transfer` log (topic0 `0xddf252ad…`, 4 topics), the sender is **indirect**;
3. Read the transaction under strict agreement. If `tx.to` is the hub, or `tx.to == tx.from` (an EIP-7702 account calling itself), the sending wallet is `tx.from`; otherwise the sender is **indirect**.

An indirect message may have been written by a contract the holder approved (§3.4). A client **SHOULD** say so next to the message. When the sending wallet of a correspondent changes, or differs from the one recorded for that correspondent on first contact, a client **SHOULD** show that the circuit changed hands.

### 8.7 Status codes

| Status | Meaning |
|---|---|
| `ok` | Public, or sealed and opened, and content decoded |
| `unsupported` | §5.1 or §6 unsupported |
| `damaged` | §5.3 or §6 damaged |
| `not-for-key` | No slot opens with any key the client holds |
| `pending` | Above the finalized height (§7) |
| `unavailable` | Answers disagreed, too few nodes answered, or no node returned a payload matching the digest; retry later |
| `stale-block`, `clock-skew` | §8.2 |
| `wrong-chain` | Nodes are not on the expected chain, or the recipient does not read the sending chain (§4.4) |
| `hub-mismatch` | The hub's container or endpoint differs from the resolved one (§2.4) |
| `hub-missing` | No hub at the configured address |
| `hub-changed` | The hub implementation is not accepted (§3.8) |
| `circuits-changed` | The processor implementation changed (§3.8) |
| `no-key`, `key-stale`, `bad-key` | No key; key not usable; key fails §4.4 step 3 |
| `key-changed` | The recipient's key or holder differs from the last exchange (§10 step 3) |

Status codes are only ever added.

## 9. Asset attachment verification

A client verifies every asset attachment of message `m` on the chain named by its `chainId`; an attachment for a chain the client does not read is shown as unverified (`other-chain`). All reads are under strict agreement. The checks run in this order and the first that applies is the result:

1. `pending` — `m` is pending (§7);
2. `mismatch` — every node agrees that there is neither a receipt nor a transaction for `tx`;
3. `unavailable` — the receipt or the transaction could not be read under strict agreement;
4. `mismatch` — the receipt status is not 1;
5. `unverifiable` — `native` only: `tx.to` is not the recipient's container (an internal transfer from a contract wallet cannot be seen);
6. `mismatch` — no matching transfer: for `native`, `tx.value ≠ amount`; for `erc20`, no `Transfer` log emitted by `token` to the container with exactly 3 topics and data equal to `amount`; for `erc721`, no `Transfer` log emitted by `token` to the container with 4 topics and topic3 equal to `tokenId`;
7. `late` — the transfer's block is later than `m`'s block;
8. `unavailable` — the sending wallet of `m` (§8.6) could not be determined;
9. `indirect` — the sender of `m` is indirect (§8.6);
10. `third-party` — the payer is not the sending wallet. The payer is `tx.from` for `native` and the `Transfer` log's `from` for tokens; a transfer out of the sender's own container counts as paid by the sender only if `tx.from` is the sending wallet;
11. `unavailable` — the transfer's block time could not be read;
12. `stale` — the transfer's block time is more than 3,600 seconds before `m`'s block time;
13. `crowded` — walking the same inbox backwards from `m`, more than 60 entries lie at or after the transfer's block;
14. `not-first` — one of those earlier entries is from the same sending container, or its message (§8.6) has the same sending wallet (an earlier entry whose wallet cannot be determined makes the result `unavailable`);
15. `ok` — otherwise.

Only `ok` proves that the sender paid this recipient for this message. A client **SHOULD** show `ok` as positive only for tokens on its list of known contracts; any other token is shown neutrally, and a token whose symbol contains non-ASCII characters or imitates a known symbol **SHOULD** be flagged as a possible fake. Within one message, a second attachment with the same `tx` is a repeat and **MUST NOT** be counted again. `mismatch`, `not-first` and repeats **SHOULD** be shown as warnings.

## 10. Sending

1. Resolve the recipient (§2.4) at a fresh pinned block and apply §4.4;
2. Resolve the sender's own endpoint; require `opened` and `holder` equal to the connected wallet; require the hub to be accepted and the processor implementation unchanged (§3.8);
3. If the client has exchanged messages with this recipient before, compare the recipient's key, `keyIndex` and holder with what it recorded; on any difference show `key-changed` and require confirmation. After a successful exchange, record them;
4. If attaching assets: send each transfer from the holder's wallet directly to the recipient's container and record its hash locally **immediately**, before waiting for inclusion. A recorded transfer **MUST NOT** be sent again; it is removed only when every node agrees the transaction reverted, or that it was cancelled (a different transaction with the same nonce was included). If the wallet speeds it up, the replacement's hash replaces the recorded one. Recorded transfers go with the next message to the same recipient, and **SHOULD** be sent within an hour (§9 `stale`);
5. Build the content (§6) and payload (§5) with `to` = the recipient's endpoint ID, `from` = the sender's endpoint ID and the `ref` passed to `send`;
6. Immediately before signing, read the recipient's `keyFor` again; if `version` changed, go back to step 1;
7. Call `send(sender processor contract, sender #ID, recipient endpoint ID, ref, payload)` from the holder's wallet;
8. If the outcome is unknown (timeout, wallet error), record the transaction hash and **MUST NOT** allow another send from the same container and wallet until the transaction is confirmed or every node agrees it will not be included.

## 11. Security considerations

- **Metadata is public and permanent.** Who wrote to whom, when, how much, and which chains are used are visible to everyone. Only sealed content is protected; lengths are not padded; slot fingerprints reveal which key a message was sealed to;
- **No forward secrecy.** Whoever later obtains a private key, or the signature it came from, can open every message sealed to it;
- **The signature is the key.** Anyone holding the §4.2 signature holds the key. Clients that inject a wallet into pages (tape:// shells) **MUST** refuse raw-hash signing and any `personal_sign` text containing `tapesend:hub:`. The official client **MUST NOT** be served from a domain that serves user sites;
- **Hub owner until sealed.** The owner can replace the implementation and, within one upgrade transaction, rewrite key records or inbox entries and restore an accepted implementation (§3.8). Checking the implementation address alone cannot prove storage was untouched. Seal as early as the protocol allows, after the factory;
- **Factory until sealed.** Whoever controls the factory can temporarily replace the processor implementation, write as any container and revoke keys without a trace the hub can see. State planted before the factory seal can still move circuits later, as ordinary transfers;
- **Approved contracts.** A contract approved for a circuit NFT can write as its container within one transaction and revoke its key (§3.4). Clients flag such messages (§8.6). Holders **SHOULD** approve only single tokens and revoke approvals after use;
- **Flooding.** Anyone with an opened container can append to any inbox, and entries are never removed. At 0.05 gwei and BNB at 725 USD one message costs about 0.004 USD. Clients rely on stranger limits and muting (§8.5); a full scan of a flooded inbox costs one `eth_call` per 200 entries;
- **Colluding nodes.** Identity, keys, inbox entries, receipts and seal status use strict agreement, so forging them requires every answering node. A single node can only make reads `unavailable` or withhold a payload;
- **Asset claims.** An attachment proves a transfer, not intent. §9 binds it to the wallet that sent the message, in time and to the first message; it cannot prove what the payment was for, and it does not cover payments made by contract wallets;
- **Transfers of circuits.** A buyer inherits the container and its correspondents. §10 step 3 and §8.6 make the change visible; a message sealed just before a sale can still be readable by the seller;
- **Look-alike endpoints and chains.** Only the processor number and the chain suffix distinguish endpoints; clients **MUST** always show both;
- **Rendering and randomness.** Content is attacker-controlled (§6). Reusing `(kek, N)` or `(K, N)` breaks confidentiality.

## 12. Test vectors

`send/module/test/vectors.json` contains, and every implementation **MUST** reproduce:

1. §4.2 for `#4246@0`, container `0x86DDaEF00401E3F10418398D67D7189fc458eA95`, a fixed test wallet and a test hub, with `k = 0` and `k = 1`: the text, its bytes, length and SHA-256, the signed hash, the signature, normalized `r ‖ s`, the HKDF info, the seed and the public key;
2. §5.3 with fixed `e`, `N`, `K`, two recipient keys, `to`, `from`, `ref` and hub: `E`, `D`, `X`, `P`, per slot the shared secret, `kek`, fingerprint and wrapped key, `C` and the payload;
3. §5.2 for the same content;
4. §7 message IDs, including one for a chain other than 56;
5. §6 decoding cases (valid; duplicate member, plain and escaped; invalid UTF-8; byte order mark; unpaired surrogate in a value and in a member name; missing `v`; `v` as a string; future `v`; other `kind`; missing `body`; depth 32 and 33; surrounding whitespace; long `subject`);
6. §5.3 opening results, including an old version-1 payload (`unsupported`);
7. §4.4 rejected keys and §4.2 signature variants.

`send/module/test/crypto.test.mjs` additionally covers attachment rules (§6.1) including image headers for PNG, WebP (VP8, VP8L, VP8X) and JPEG, animated and progressive rejection, and endpoint validation.

## 13. Change rules

For format version `0x02` the following will not change: the endpoint ID of §2.2; the chain indexes of §2.1; the text, labels and steps of §4.2; the payload layout, labels and steps of §5; the message ID of §7; the hub's write interface, events, storage layout and authorization rule. New chains are appended to §2.1 and their implementations to §3.2. Anything else that must differ gets a new format version, suite or hub, and clients keep reading the old ones.

Planned: activation of Base and X Layer, reading keys across chains, group conversations, receiving rules enforced by the hub.

## 14. Reference implementations

| Component | Location |
|---|---|
| Hub contracts | `send/contracts/` — `DeWebHub`, `DeWebAdmin`, `DeWebProxy`, `DeWebBoot`; unit, fuzz, invariant, fork and pinned-address tests; deployment page |
| Protocol module | `send/module/` — keys, payload, content and attachments, endpoints, strict chain reads, finality; test vectors; mainnet read-only and fork end-to-end tests |
| Identity core | `kernel/src/identity.js` — shared with the tape:// kernel |
| Client | `apps/tapesend/` — web, desktop (Electron) and iOS/Android (Capacitor); implements §8–§10 including attachment verification, stranger folding and indirect-sender flags. It blocks sending when the hub is not accepted or the processor implementation changed |

## Appendix A. Changes from draft v0.5

- The single-chain `TapeSendHub` with an address `to` is replaced by the DeWEB hub: endpoint IDs carry the chain ID; the hub keeps an on-chain inbox and outbox; `send` returns the inbox index; `publishKey` takes a receiving-chains bitmap; `keyFor` returns the endpoint and bitmap and zeroes key fields when unusable;
- The hub has the same address on every chain (boot implementation + proxy) and is upgradeable until sealed, with `selfAddress` and `proxiableUUID` checks;
- Payload format `0x02`: all labels are `v2`, and `X` binds endpoint IDs instead of addresses and a separate chain ID;
- Key derivation binds the endpoint ID; `Chain ID` in the text is the container's home chain;
- Message ID is computed from storage (`chainId`, hub, `to`, inbox index) instead of the transaction hash and log index;
- Content gains `attachments` (images and asset claims) with the verification rules of §9;
- Finality, the sending wallet, indirect senders and stranger folding are specified;
- The indexer and notification interfaces (v0.5 §10, §11) are removed.
