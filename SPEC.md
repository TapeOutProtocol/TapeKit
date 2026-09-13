# tape:// On-Chain Website Specification v0.2 (Draft)

> This English text is the normative version. A Chinese translation is kept in [SPEC.zh.md](SPEC.zh.md); if the two differ, this version prevails.

- Status: draft v0.2, 2026-09-13 (v0.1 same day: first version; v0.2: host name carries `.tape`, `web+tape://` alias, Service Worker gateway, contract interface appendix, change rules)
- Chain: BNB Smart Chain mainnet (chainId 56)
- License: this specification text is dedicated to the public domain under CC0 (see `LICENSE-SPEC`); the reference implementations (`kernel/`, `viewer/`, `extension/`, `sw-gateway/`) are open source under MIT (see `LICENSE`)
- Key words: **MUST**, **MUST NOT**, **SHOULD**, **MAY** are to be interpreted as in RFC 2119

## 0. What this specification covers

The files of a TapeOut website already live in full on BNB Chain (the SiteRegistry contract, under the name of a TapeOut circuit container). Until now, reaching them meant "domain name → DNS TXT record → gateway". This specification defines the other path: **the client reads the chain directly, with no DNS and no gateway of ours in between**.

It covers exactly four things:

1. **URL format**: how to write the address of an on-chain website (§2);
2. **Resolution**: how to get from an address to the container and its files (§3, §4);
3. **Verification**: how to confirm that every byte read matches the chain (§5, §6);
4. **Site isolation**: how a client must run these sites so they cannot harm each other or the user (§7).

It does **not** cover how files are uploaded (SiteRegistry already does that), how ordinary browsers reach sites through domain names (the gateway and domain binding already exist), or how any particular wallet is implemented.

## 1. Terms

| Term | Meaning |
|---|---|
| Processor | A CPU in TapeOut; on chain it is an independent circuit NFT contract (`Circuits`) |
| Processor number | The processor's index in the factory contract's `cpus` array: `factory.cpuAt(number)`. Starts at **0**, in creation order, **append-only and never reused**. Number 0 is the Genesis CPU |
| #ID | A circuit's number within its processor (the NFT tokenId); **every processor numbers from 1 independently** |
| Container | The ERC-6551 account bound to that circuit; its address is uniquely derived from (chain, processor contract, #ID) via `opener.accountOf(processor, #ID)`. One container, one website |
| Site store | The `SiteRegistry` contract, storing files by (container, path); every file carries a SHA-256 |
| Payment contract | The `DomainBinding` contract, recording until when "some name × some container" is paid |
| Kernel | The library that reads the chain, resolves, and verifies (reference implementation `kernel/`). It neither renders nor connects wallets |
| Shell | An application built on the kernel that actually displays sites: web viewer, browser extension, desktop or mobile app, a wallet's dapp browser, a Service Worker gateway |

## 2. On-chain names and URLs

### 2.1 Why the name must carry the processor number

Every processor numbers its #IDs from 1, so "#12" exists once on processor 0 and once on processor 7: two entirely different circuits with two different containers. **A #ID alone cannot identify a circuit.**

What identifies a circuit is "processor + #ID". Processor names are not unique (the factory does not check for duplicates) and processor contract addresses are too long, so the name uses the **processor number**.

### 2.2 On-chain name (canonical form)

```
<#ID>.<processor number>.tape
```

- Both parts are decimal, **MUST NOT** have leading zeros (except `0` itself), all lowercase;
- #ID ≥ 1, processor number ≥ 0;
- Example: `4246.0.tape` = circuit #4246 on processor 0 (Genesis CPU).

This name is also, character for character, the name registered in the payment contract (§3.4).

### 2.3 URL

```
tape://<#ID>.<processor number>.tape/<path>
```

Example: `tape://4246.0.tape/index.html`. Path rules are in §6. `tape://` is the scheme for shells; **the host name is the complete on-chain name, including the `.tape` suffix**, so that a site's origin is exactly `tape://4246.0.tape`.

> Why the suffix cannot be dropped from the host: Chromium applies IPv4 parsing to the host of every "standard" scheme. `4246.0` is rejected as an invalid address (4246 exceeds 255) and `1.0` is rewritten to `1.0.0.0`. With `.tape` appended the last label is not numeric and the host is treated as an ordinary host name. (Measured on Electron 43, 2026-09-13.) A shell's address bar **SHOULD** still accept the suffix-less form `tape://4246.0/` (§2.4) and display the canonical URL with the suffix after resolution.

**The `web+tape://` alias**: `tape://` is the canonical form; `web+tape://` is its alias for web environments, with identical host and path: `web+tape://4246.0.tape/index.html` and `tape://4246.0.tape/index.html` point to the same file. The alias exists because browsers only let web pages claim schemes that start with `web+` (through `navigator.registerProtocolHandler`); an unprefixed `tape://` can only be registered by a program installed on the operating system. Every shell (gateway, extension, desktop app) **MUST** accept both forms; for display, `tape://` **SHOULD** be used.

### 2.4 Input forms the address bar should accept

A shell's address bar **SHOULD** accept the following forms and, after resolution, display the canonical name of §2.2:

| Form | Example | Meaning |
|---|---|---|
| Canonical name | `4246.0.tape` | |
| Without suffix | `4246.0` | same |
| URL | `tape://4246.0.tape/docs/` or `tape://4246.0/docs/` | with path |
| Web alias | `web+tape://4246.0.tape/docs/` | same (§2.3) |
| Shorthand | `#4246@0` or `4246@0` | #ID @ processor number |
| Container address | `0x86DD…eA95` | reverse-resolved to a name (§3.2) |
| Processor contract#ID | `0x50A9…9DD9#4246` | reverse-resolved to a processor number (§3.3) |

Any other form **MUST** be rejected with an error; the shell **MUST NOT** guess.

## 3. Resolution rules

### 3.1 Mainnet constants

| Item | Address |
|---|---|
| Processor factory | `0x68224F668083c29e9800Be2a646d42d18cedF7e2` |
| Container opener | `0x021745DE2f42A7839d96f2d3634d0294487D81F1` |
| ERC-6551 registry | `0x000000006551c19487814612e58FE06813775758` |
| Container implementation | `0xAf4E78a2257C9c5480c2F8310E3b00437260751d` |
| Site store, SiteRegistry (proxy) | `0xd006ffdd5Ae313B17729621A00999cD3C71CE5e6` |
| Payment contract, DomainBinding (proxy) | `0x861EE183de2BBE4a6ecf9D15812C123b566a3DB7` |

Clients must pin the **implementation addresses** behind the two proxies; see §4.3.

### 3.2 Name → container

All of the following calls are executed at the same pinned block (§4.2):

1. `factory.cpuCount()`; processor number ≥ count → status `no-such-cpu`;
2. `factory.cpuAt(processor number)` gives the processor contract;
3. `opener.accountOf(processor contract, #ID)` gives the container address;
4. `processor contract.ownerOf(#ID)` reverts → status `no-such-token`; on success it gives the current holder;
5. `opener.isOpened(processor contract, #ID)` is false → status `not-opened`;
6. Blocklist hit → status `blocked` (§9);
7. Activation check (§3.4): not activated → `unpaid`; activated → `ok`.

### 3.3 Container address / processor contract#ID → name

Container address input:

1. `container.token()` returns (chainId, processor contract, #ID); if the call fails or chainId ≠ 56 → `not-tapeout`;
2. `factory.isCPU(processor contract)` is false → `not-tapeout` (not a TapeOut processor);
3. Reverse-look up the processor number with `cpuAt` (the factory has no reverse table; the client scans by index in batches and caches);
4. `opener.accountOf(processor contract, #ID)` **MUST** equal the input container address, otherwise `not-tapeout`. This step defends against a contract that merely claims to be a container;
5. Continue with steps 4–7 of §3.2.

"Processor contract#ID" input: do steps 2 and 3 first, then continue as in §3.2.

### 3.4 Activation (payment) check

- Criteria; satisfying either one means activated. In both, "the container" is the one **derived** from the name, never one reported by anyone:
  1. `DomainBinding.isLive(canonical name, container)` is true: this on-chain name has been paid for and has not expired;
  2. `DomainBinding.isContainerLive(container)` is true: this container has paid for **any** name or domain and has not expired. In other words, one payment per container activates both its bound domain and its on-chain name. This function exists from the implementation of 2026-09-13; on older implementations the call reverts, and clients **MUST** treat a revert as false;
- Hence no name squatting: if someone pays for `4246.0.tape` with their own container, clients ignore it, because the container derived from the name is not theirs;
- Paying: the effective holder of the container (holds the circuit NFT, container opened, no open market listing) calls `DomainBinding.bind(name or domain, container, months)` with `msg.value = months × monthlyFee`. The current fee is 0.08 BNB per 30 days, prepayable up to 10 years ahead, non-refundable;
- Historical payments: payments made before the new implementation went live were recorded only on "domain × container". Anyone may call `DomainBinding.syncContainer(domain, container)` to copy that existing record's expiry into the container-level record. The function only reads existing records; it cannot set arbitrary values;
- When the circuit NFT changes hands, the payment record follows the container; the new holder keeps the benefit;
- This uses the same contract and the same price as the existing domain binding; **no new contract is needed**.

**Client behaviour:**

- Official shells **MUST** display only sites in state `ok`. For `unpaid` they show "this on-chain name is not activated" and tell the holder how to activate it;
- On-chain data is public and anyone can read it. The fee is enforced by "the official kernel and compliant shells display only activated sites", not by any technical read block. Documentation **SHOULD** state this plainly.

### 3.5 Status codes

| Status | Meaning | Shell behaviour |
|---|---|---|
| `ok` | Activated | Display |
| `unpaid` | Name not paid for, or expired | Do not display content; explain how to activate |
| `not-opened` | The circuit has not opened its container | Do not display |
| `no-such-cpu` | No processor with this number | Error |
| `no-such-token` | This processor has no such circuit | Error |
| `not-tapeout` | Not a TapeOut circuit container | Error |
| `blocked` | Blocked by this client | Show the block notice |
| `store-changed` | The store contract's implementation does not match the pinned one | Refuse to read (§4.3) |

## 4. Nodes and consistency

### 4.1 Multi-node agreement

- Every chain read **MUST** be adopted only when at least 2 mutually independent nodes return **exactly the same** result. "Independent" means **different operators**: several nodes run by one operator count as one;
- If any two nodes disagree, the client **MUST** reject the read; it **MUST NOT** take a majority vote;
- If a node errors or times out, the client **MAY** move on to the next node;
- Clients **SHOULD** let users switch to nodes they trust, including self-hosted ones.

Default public nodes of the reference implementation (all pass browser CORS preflight, support batch requests, and belong to 4 different operators): `bsc-dataseed.bnbchain.org` (BNB Chain), `bsc-rpc.publicnode.com` (Allnodes), `bsc-dataseed1.defibit.io` (Defibit), `bsc-dataseed1.ninicoin.io` (Ninicoin).

### 4.2 Pinned block

- All reads for one site open **MUST** be pinned to a single block height, so that a site owner updating files mid-read cannot produce a mix of old and new content;
- Reference approach: take the second-highest head among the nodes, then go back 2 blocks.

### 4.3 Pinned store implementations

Both proxy contracts are upgradeable. Clients **MUST** read the ERC-1967 implementation slot (`0x3608…2bbc`; do not call the contract's own `implementation()`: after an upgrade, the new code is the one answering) and compare it with the client's built-in list of "audited implementations". If it is not on the list, return `store-changed` and refuse to read until the client updates its list.

Current list:

- SiteRegistry implementation: `0x1d279D138A4D803378a7d4557c056f1beD53c261`
- DomainBinding implementation: `0xaa226181a6588d3f9AC0035e5f3dBaF311039bCE` (upgraded 2026-09-13, adds container-level payment); the previous implementation `0x4E8684EaEA48b524245B2191DeE451eAa1c1cA94` stays on the list in case of rollback

## 5. Reading and verification

1. `SiteRegistry.fileInfo(container, path)` returns (size, contentType, sha256, updatedAt, chunkCount); chunkCount 0 means the file does not exist;
2. Files larger than 8,400,000 bytes (350 chunks × 24,000 bytes) **MUST NOT** be read;
3. Files up to 96 KB are read in one `read(container, path)` call; larger ones with `readRange` in 96 KB segments, all pinned to the same block;
4. After reading, both conditions **MUST** hold: the length equals the declared size, and the SHA-256 of the actual bytes equals the on-chain `sha256Hash`. If either fails, the file is treated as "uploading or corrupted" and **MUST NOT** be displayed as a normal file;
5. An on-chain `sha256Hash` of all zeros means the site owner declared no hash. Shells **MAY** display such files but **MUST** mark them "unverified"; official shells **SHOULD** mark the whole site as unverified;
6. content-type may only contain ordinary characters (letters, digits, `. + / ; = -` and space); anything else is treated as `application/octet-stream`.

## 6. Path rules

1. Strip everything from `?` and `#` onward, percent-decode (a malformed `%xx` → invalid), Unicode NFC normalize (macOS file names are NFD, browsers send NFC), collapse consecutive `/`;
2. Control characters, a `.` segment or a `..` segment → invalid;
3. Empty path, `/`, or a path ending in `/` → append `index.html`; strip the leading `/`;
4. Landing order:
   1. Exact match;
   2. If the last segment has no extension, try `<path>/index.html`;
   3. Still nothing and no extension: fall back to the site owner's `fallbackPath` (for single-page application routing);
   4. Otherwise 404.

## 7. Site isolation requirements

This section is the security floor. An on-chain site may be malicious; a shell **MUST** ensure it cannot harm the user, other sites, or the shell itself.

### 7.1 One independent origin per site

Site code **MUST** run in one of these environments:

- **A real, independent origin**: a native app or desktop shell registers the `tape://` scheme and uses the canonical name `<#ID>.<processor number>.tape` as the host name, one origin per site, e.g. `tape://4246.0.tape`. Only this environment may persist data and connect wallets (§7.4);
- **An opaque origin (preview mode)**: a sandboxed iframe **without** `allow-same-origin`. The site cannot read or write any persistent storage and cannot touch the shell page;
- **A Service Worker gateway (a real origin carried by a domain)**: an ordinary https domain, one subdomain per site, `<#ID>-<processor number>.<gateway domain>` (a hyphen, because wildcard certificates cover only one label). The server returns the same bootstrap page for every subdomain and every path; once the bootstrap page has installed the Service Worker, every request under that origin is read, cross-checked and verified against the chain inside the user's browser, and the server never handles content again. This is the only way an ordinary browser (Chrome, Edge, Firefox, Safari, no extension, no app) can obtain a real origin: the site can persist data and use the wallet extension the user already has. Reference implementation `sw-gateway/`; see §7.8.

Two sites of different containers **MUST NOT** share an origin; a site and the shell page **MUST NOT** share an origin.

### 7.2 No site code in privileged contexts

Site code **MUST NOT** run in extension pages (`chrome-extension://…` with access to extension APIs), an app's bridge page, the viewer's own page, or any similarly privileged context. Browser extensions **MUST** render through a sandbox page declared in the manifest.

### 7.3 Storage

Under a real origin, localStorage, IndexedDB, cookies and caches are isolated per origin (that is, per container). After a circuit changes hands, the old data under the same origin is still there; shells **SHOULD** offer "clear this site's data".

### 7.4 Wallets

- A wallet (e.g. `window.ethereum`) **MAY** be injected only under a real, independent origin; preview mode **MUST NOT** inject one;
- For every connection or signing request, the wallet UI **MUST** show the canonical name (e.g. `4246.0.tape`), the processor name and the container address; it **MUST NOT** show only the page's own title;
- Wallet permissions **MUST** be recorded per origin (per container); a permission granted to one site must not be usable by another.

### 7.5 Network requests

- In preview mode, the Content Security Policy **MUST** allow only `blob:`, `data:` and the RPC nodes configured by the shell; everything else is blocked;
- Shells **SHOULD** list blocked requests to the user (this is also the runtime evidence of "fully on-chain", see §8);
- Under a real origin, shells **SHOULD** block off-chain requests by default as well, letting the user allow them site by site.

### 7.6 Navigation and pop-ups

- A site **MUST NOT** navigate the shell's top-level page;
- In-site links open inside the shell; links to off-chain destinations **MUST** open in a new window with a notice that the user is leaving the on-chain site;
- Pop-ups, notifications and downloads **MUST** require user confirmation.

### 7.7 Displaying identity

The shell's address bar or title bar **MUST** always show the canonical name, together with the activation status and the verification status (§5). The page's own `<title>` may only be a subtitle.

### 7.8 Additional requirements for Service Worker gateways

- **Trust boundary**: the bootstrap files (`index.html`, `sw.js` and its imports) are the only download that needs to be trusted in this mode. They **MUST** be open source and contain no external resources, and anyone must be able to run their own gateway from the same files; the official extension **MAY** pin the bootstrap by hash. Once the Service Worker has taken over, the server never handles content again, and on-chain files are still verified one by one under §5;
- **Nodes do not belong to the gateway**: reads happen in the user's browser, with the public nodes of §4.1 as defaults. A gateway operator may add its own node in the configuration, but it still counts as a single operator's vote; the agreement rule is unchanged. Users can switch to their own nodes on the status page, and settings live only in the user's browser. Node URLs carrying API keys **MUST NOT** be written into public files such as the bootstrap;
- **Off-chain requests**: the Service Worker sees every fetch, XHR, image, script, stylesheet and iframe request the page makes; it **MUST** block and record them by default, node URLs excepted, and let the user allow them per site on the status page. WebSocket and WebRTC do not pass through Service Workers and cannot be blocked; documentation **SHOULD** say so;
- **Identity display**: the gateway has no address bar of its own; the canonical name is carried in the subdomain (`4246-0` is `4246.0.tape`). Every site **MUST** provide a status page at `/.tape/status` (identity, activation, verification, off-chain references, blocked requests, node statistics, settings); the status page and all notice pages **MUST NOT** contain scripts; responses **SHOULD** carry the headers `x-tape-name`, `x-tape-status`, `x-tape-sha256`, `x-tape-verified`. Wallet extensions record permissions per origin, one subdomain per permission, which satisfies §7.4;
- **Reserved paths**: `/sw.js` and the `/.tape/` prefix belong to the gateway; files under those names in a site are never read;
- **Sibling subdomains**: cookies can be set on the parent domain and thus leak between siblings (localStorage and IndexedDB are isolated per exact host and are not affected). Production deployments **SHOULD** submit the gateway domain to the Public Suffix List so that every subdomain is also an independent "site" with its own process and storage partition;
- **Hard reload** (Shift+Reload) bypasses the Service Worker once; the bootstrap page must explain this to the user, and a normal reload restores it.

## 8. The "fully on-chain" badge

A site may be badged "100% on-chain" only when both hold:

1. **Static scan**: the HTML and CSS contain no references to off-chain resources (`http(s)://`, `//host` in src, href, `url()`, `@import`, meta refresh, and so on);
2. **Runtime**: during loading and execution, no off-chain request was blocked under §7.5.

Only then is "100% on-chain" shown; otherwise the shell shows "references off-chain resources" and lists the addresses.

## 9. Blocking and reporting

- Nothing on chain can be deleted, but the shell is the party doing the displaying, so it **MUST** support a blocklist (by container address or canonical name), returning `blocked` on a hit;
- List format: plain text, one container address or canonical name per line, lines starting with `#` are comments;
- Official shells **SHOULD** provide a way to report a site and publish their blocking rules;
- Blocking affects only shells that follow this specification; it changes nothing on chain and nothing in other shells.

## 10. Caching and updates

- File cache keys **MUST** include (container, path, on-chain sha256); when the on-chain hash changes the cache naturally expires;
- Resolution results (name → container, activation status) **SHOULD NOT** be cached for more than 60 seconds;
- Shells **MAY** listen to `SiteRegistry`'s `FileSet` and `FileRemoved` events to invalidate caches early. Most public nodes do not offer event queries (`eth_getLogs`), so the reference implementation instead periodically re-reads `fileInfo`, `pathCount` and `fallbackPath` of known files with ordinary calls, treating any change as an update;
- File caches **SHOULD** be content-addressed by on-chain sha256 and may be persisted locally (IndexedDB / a directory); entries need not be re-verified on read;
- The processor number table (number ↔ contract address) **MAY** be cached persistently: numbers are append-only, so the cache never expires and only new numbers need scanning;
- Shells **SHOULD** offer both Chinese and English interface text; all status and error text of the reference kernel is bilingual.

## 11. Security considerations

- **Lying nodes**: the multi-node agreement of §4.1 defeats a single lying node; it cannot defeat all nodes lying together. Shells seeking stronger guarantees **SHOULD** support self-hosted nodes or verify state proofs against block headers with `eth_getProof`;
- **Malicious store upgrade**: §4.3 pins the implementation and fails closed;
- **A malicious site owner**: "verified" only means the bytes match the chain; it does not mean the site is trustworthy. That is why the name must always be visible (§7.7) and wallet requests must show it (§7.4);
- **Listing freeze**: while a circuit is listed on the market, its owner cannot change the site; buyers get exactly what they saw. Reading is unaffected;
- **Phishing**: names are all digits, so there are no look-alike letters. `4246.0` and `4264.0` can still be misread, so shells **SHOULD** also show the processor name and the holder;
- **The fee can be bypassed**: see the last point of §3.4; state it plainly.

## 12. Relationship to other specifications

- **BEP draft "Verifiable on-chain front ends"** (`../docs/BEP-verifiable-frontend.md` in the HashPort repository): that specification governs "a web page under an ordinary domain matches the on-chain bytes"; this one governs "reading the chain directly without a domain". Both share the same site store and the same hashes;
- **ERC-4804 / ERC-6860 (`web3://`)**: `web3://` fetches pages through contract calls and requires the store contract to implement the ERC-5219 `request()` interface. The current SiteRegistry does not. A read-only adapter contract can be deployed later without affecting this specification.

## 13. Reference implementations

| Component | Location | Notes |
|---|---|---|
| Kernel | `kernel/` | Zero-dependency ES module for browsers and Node ≥ 18; multi-node agreement, pinned block, pinned implementations, SHA-256 verification |
| Web viewer | `viewer/` | Preview-mode shell (sandboxed iframe, opaque origin, strict CSP); shows identity, activation, verification and on-chain status |
| Browser extension | `extension/` | Address-bar keyword `tape`, renders through a sandbox page; the popup can verify that the current https page matches the on-chain bytes |
| Service Worker gateway | `sw-gateway/` | A real origin for ordinary browsers with nothing installed: subdomain = on-chain name, the bootstrap installs a Service Worker and all chain reads happen locally; status page `/.tape/status`; off-chain requests blocked by default (§7.8) |
| Desktop browser | (planned) | Electron registering the `tape://` scheme. Measured: the host must carry the `.tape` suffix (§2.3); not started |
| HashPort gateway (not in this repository) | the hashport.org service | The path for ordinary browsers through domain names (in production) |

## 14. Test vectors

| Input | Expected |
|---|---|
| `4246.0.tape` | processor 0 (Genesis CPU), #4246, container `0x86DDaEF00401E3F10418398D67D7189fc458eA95` |
| `0x86DDaEF00401E3F10418398D67D7189fc458eA95` | reverse-resolves to `4246.0.tape` |
| file list of `4246.0.tape` | only `index.html`, fallback `index.html` |
| `index.html` | 756 bytes, SHA-256 `0xec444c899bd9229f9173082fff362da66dd297179482a58b30b6f53ce9f7a0b6` |
| `tape://4246.0.tape/some/route` | lands on `index.html` (§6 step 4.3) |
| `tape://4246.0.tape/missing.png` | 404 (has an extension, no fallback) |
| `1.999999` | `no-such-cpu` |
| `999999999.0` | `no-such-token` |
| `0x000000000000000000000000000000000000dEaD` | `not-tapeout` |
| `04246.0`, `0.0.tape`, `4246` | input error |

`4246.0.tape` is currently `ok` (container paid, `paidVia: container`, since 2026-09-13). The vector corresponds to the file as updated on chain at 2026-09-13 09:44 UTC; when the owner updates it again, update this table and `kernel/test/mainnet.test.mjs` together.

## 15. Change rules

This section answers "if I build on this specification, what will change, what will not, and how will I find out".

### 15.1 Promises that never change

The following are the foundation of the specification and **will not change in any version**. Changing them would not be tape:// any more but a different specification:

1. The format and meaning of the on-chain name `<#ID>.<processor number>.tape`; the `.tape` suffix is never replaced;
2. Processor number = the index of `cpuAt(i)` in the factory, starting at 0, append-only; #ID is the circuit NFT's tokenId;
3. The name → container derivation (§3.2): the container address is only ever computed from "processor contract + #ID"; a client never accepts a self-reported container;
4. The verification rule (§5): if either the length or the SHA-256 does not match, the file is not displayed;
5. Multi-node agreement (§4.1): disagreement means rejection; there is never a majority vote;
6. The names and meanings of the status codes (§3.5). Status codes are only ever **added**; existing ones are never changed or removed;
7. The URL host name is the complete on-chain name (§2.3).

### 15.2 What changes, and how

| What changes | Who changes it | How it is announced | What clients do |
|---|---|---|---|
| The pinned implementation list (§4.3) | The contract owner upgrades the contract; the specification maintainers update the list | A new repository release (tag) updating §4.3 and `kernel/src/config.js`; the release notes state the old and new implementation addresses and where the audit report is | Update the client; a client that has not updated returns `store-changed` for the new implementation (fail-closed). **This is by design**, not a fault |
| The default public node list | The specification maintainers | Same as above | Updating is optional; users can switch to their own nodes at any time |
| The monthly fee (`monthlyFee`) | The contract owner | The on-chain `FeeChanged` event | Clients do not depend on the amount; they read it from the chain |
| Input forms (§2.4), shell requirements (§7), caching advice (§10) | The specification maintainers | A new version | Backwards compatible: a new version may only loosen input forms and tighten security requirements |
| A new site store contract version (the `registries` list) | The contract owner and the specification maintainers | A new version; old store addresses stay on the list forever | Look up in order, first hit wins (§3.1) |

**The list never updates itself.** Clients **MUST NOT** fetch the implementation list or the node list dynamically from any server; that would replace the chain of trust with trust in that server. The list travels only with the client version; users get the new list by updating the client.

### 15.3 Version numbers

- The specification uses `vX.Y`: `Y` increments for backwards-compatible additions (new status codes, new input forms, new appendices); `X` increments for changes that require clients to change code to keep working correctly (for example a new verification rule). The items of §15.1 do not change under any `X`;
- Every version states its date and a summary of changes at the top;
- Contract implementation addresses are not tied to specification versions; see §15.2.

### 15.4 Who maintains it

The specification text is maintained in the [TapeOutProtocol/TapeKit](https://github.com/TapeOutProtocol/TapeKit) repository, and changes are discussed publicly as pull requests. The contract owner and the specification maintainers are two separate roles: the owner can upgrade the contracts, but only implementations on the §4.3 list are accepted by compliant clients. If the owner upgrades to an implementation that is not on the list, compliant clients collectively refuse to read until the audit and the list update are complete.

## Appendix A: Shell compliance checklist

- [ ] The address bar accepts the forms of §2.4 and displays the canonical name
- [ ] At least 2 nodes agree; any disagreement is rejected
- [ ] All reads of one site open are pinned to the same block
- [ ] Store implementations are pinned; a mismatch is rejected
- [ ] Every file's length and SHA-256 are verified
- [ ] Only sites in state `ok` are displayed
- [ ] One independent origin per site, or an opaque origin for preview
- [ ] Site code never runs in a privileged context
- [ ] No wallet in preview mode; under a real origin, wallet requests show the canonical name
- [ ] Off-chain requests are blocked and listed; "100% on-chain" requires both the static and the runtime check
- [ ] Blocklist and reporting are supported
- [ ] (Service Worker gateways) bootstrap is open source with no external resources; status pages have no scripts; `/sw.js` and `/.tape/` are reserved; the domain is on the Public Suffix List

## Appendix B: Contract interfaces

Writing your own kernel needs only the **read-only** functions below. Everything is on BNB Smart Chain mainnet (chainId 56); addresses are in §3.1. Function selector = first 4 bytes of `keccak256(signature)`; the reference implementation hard-codes them in `kernel/src/selectors.js` and the unit tests recompute and check them.

### B.1 Processor factory (`factory`)

| Function | Returns | Notes |
|---|---|---|
| `cpuCount()` | `uint256` | Number of processors |
| `cpuAt(uint256 i)` | `address` | The circuit NFT contract of processor i; reverts when i ≥ count |
| `isCPU(address)` | `bool` | Whether the address is a processor created by this factory |

### B.2 Container opener (`opener`)

| Function | Returns | Notes |
|---|---|---|
| `accountOf(address circuits, uint256 tokenId)` | `address` | The circuit's container address (deterministic ERC-6551 computation; works even before the container is deployed) |
| `isOpened(address circuits, uint256 tokenId)` | `bool` | Whether the container has been opened |

### B.3 Processor contract (one per processor, ERC-721)

| Function | Returns | Notes |
|---|---|---|
| `ownerOf(uint256 tokenId)` | `address` | The holder; reverts when the #ID does not exist → `no-such-token` |
| `name()` | `string` | The processor's name (not unique; display only) |

### B.4 Container (ERC-6551 account)

| Function | Returns | Notes |
|---|---|---|
| `token()` | `(uint256 chainId, address tokenContract, uint256 tokenId)` | The circuit bound to the container. Used for reverse resolution from a container address (§3.3); the result must be recomputed with `accountOf` and compared |

### B.5 Site store `SiteRegistry` (UUPS proxy)

Read-only:

| Function | Returns | Notes |
|---|---|---|
| `fileInfo(address container, string path)` | `(uint32 size, string contentType, bytes32 sha256Hash, uint40 updatedAt, uint256 chunkCount)` | `chunkCount == 0` means the file does not exist; an all-zero `sha256Hash` means the owner declared no hash |
| `read(address container, string path)` | `bytes` | The whole file; reverts with `NoSuchFile()` if absent. Use `readRange` above 96 KB |
| `readRange(address container, string path, uint256 offset, uint256 len)` | `bytes` | Segment read; `offset ≥ size` returns empty; `len` is clipped to the end of the file |
| `pathCount(address container)` | `uint256` | Number of paths |
| `pathsRange(address container, uint256 from, uint256 n)` | `string[]` | Paged path list |
| `paths(address container)` | `string[]` | All paths (avoid on large sites) |
| `fallbackPath(address container)` | `string` | Single-page application fallback (§6) |
| `isOpenedContainer(address container)` | `bool` | Whether the address is an opened TapeOut container |
| `implementation()` | `address` | **Do not use for pinning** (after an upgrade the new code answers); read the ERC-1967 slot instead |

Write (for site owners; `onlyEditor`: the holder or an operator set with `setOperator`):

| Function | Notes |
|---|---|
| `putFile(address container, string path, string contentType, bytes32 sha256Hash, bytes data)` | Writes the first chunk (≤ 24,000 bytes); replaces the whole file if it exists |
| `appendChunk(address container, string path, uint256 expectIndex, bytes data)` | Appends a chunk; `expectIndex` must equal the current chunk count, preventing duplicate appends |
| `removeFile(address container, string path)` | Deletes |
| `setFallback(address container, string path)` | Sets the fallback path |
| `setOperator(address container, address op, uint256 ttl)` | Authorizes an operator for `ttl` seconds |

Events: `FileSet(address indexed container, string path, uint32 size, bytes32 sha256Hash, string contentType)`, `FileRemoved(address indexed container, string path)`, `FallbackSet(address indexed container, string path)`, `OperatorSet(address indexed container, address operator, address setBy, uint40 until)`.

Constants: `CHUNK_MAX = 24,000` bytes per chunk; a file is at most 350 chunks = 8,400,000 bytes (§5). File bytes are stored as the code of per-chunk contracts (byte 0 is a STOP prefix, already stripped by `read`).

### B.6 Payment contract `DomainBinding` (UUPS proxy)

| Function | Returns | Notes |
|---|---|---|
| `isLive(string name, address container)` | `bool` | This name × this container is paid and not expired |
| `paidUntil(bytes32 nameHash, address container)` | `uint40` | Expiry timestamp; `nameHash = keccak256(name)` |
| `isContainerLive(address container)` | `bool` | This container has paid for any name or domain and is not expired (available from the 2026-09-13 implementation; older implementations revert → treat as false) |
| `containerPaidUntil(address container)` | `uint40` | Container-level expiry timestamp |
| `monthlyFee()` | `uint256` | Fee per 30 days, in wei |
| `bind(string name, address container, uint256 months)` `payable` | — | Pay or renew: `months` 1–120, `msg.value = months × monthlyFee`, at most 10 years ahead; only the container's effective holder may call; the name must be lowercase and contain at least one dot |
| `syncContainer(string name, address container)` | — | Anyone may call: copies an existing `paidUntil` into `containerPaidUntil`; can only raise, never lower |
| `unbind(string name, address container)` | — | Stops this name (no refund; does not lower the container-level expiry) |

Events: `Bound(bytes32 indexed domainHash, string domain, address indexed container, uint40 paidUntil, uint256 paid)`, `ContainerPaid(address indexed container, uint40 paidUntil)`, `Unbound(bytes32 indexed domainHash, address indexed container)`, `FeeChanged(uint256 monthlyFee)`.

### B.7 The pinned implementation list (same as §4.3, machine-readable)

```json
{
  "chainId": 56,
  "0xd006ffdd5ae313b17729621a00999cd3c71ce5e6": ["0x1d279d138a4d803378a7d4557c056f1bed53c261"],
  "0x861ee183de2bbe4a6ecf9d15812c123b566a3db7": ["0xaa226181a6588d3f9ac0035e5f3dbaf311039bce", "0x4e8684eaea48b524245b2191dee451eaa1c1ca94"]
}
```

Keys are proxy addresses; values are audited implementation addresses (lowercase). Read the ERC-1967 implementation slot `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc` to get the current implementation; if it is not in the list → `store-changed`.
