// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeWebHub} from "../src/DeWebHub.sol";
import {DeWebAdmin} from "../src/DeWebAdmin.sol";
import {DeWebBoot} from "../src/DeWebBoot.sol";
import {DeWebProxy} from "../src/DeWebProxy.sol";
import {MockFactory, MockBeacon, MockCircuits, MockPayments, MockRegistry, SmartWallet} from "./Mocks.sol";

/// 审计（测试充分性）补充：有状态模糊测试的操作者。
/// 所有调用都经它发出；成功的写入同步记进"影子账本"，失败的必须回滚且不改变任何可观察状态。
contract Handler is Test {
    DeWebHub public hub;
    MockCircuits public circuits;
    MockFactory public factory;
    MockPayments public payments;
    MockBeacon public beacon;
    address public circuitImpl;

    uint256 public constant NTOK = 4;
    address[5] public actors; // 0..2 普通账户，3 = EIP-7702 账户，4 = 合约钱包
    uint256[NTOK] public ids = [uint256(11), 22, 33, 44];
    address[NTOK] public containers;
    bytes32[] public endpoints; // 所有可能的收件端点（本链容器 + 外链端点）

    // 影子账本
    mapping(bytes32 => DeWebHub.Entry[]) internal gIn;
    mapping(address => bytes32[]) internal gOutTo;
    mapping(address => uint256[]) internal gOutIdx;
    mapping(address => uint32) public gVersion;
    uint256 public gTotal;
    uint256 public calls;
    uint256 public successes;
    uint256 public unauthorizedRejected;

    constructor(DeWebHub h, MockCircuits c, MockFactory f, MockPayments p, MockBeacon b, address ci, SmartWallet w) {
        hub = h;
        circuits = c;
        factory = f;
        payments = p;
        beacon = b;
        circuitImpl = ci;
        actors[0] = makeAddr("a0");
        actors[1] = makeAddr("a1");
        actors[2] = makeAddr("a2");
        actors[3] = makeAddr("d7702");
        vm.etch(actors[3], abi.encodePacked(hex"ef0100", address(0x1234)));
        actors[4] = address(w);
        for (uint256 k = 0; k < NTOK; k++) {
            containers[k] = hub.accountOf(address(c), ids[k]);
            endpoints.push(hub.endpointOf(containers[k]));
        }
        endpoints.push(bytes32((uint256(8453) << 160) | uint160(containers[0]))); // 同地址、别的链
        endpoints.push(bytes32((uint256(type(uint64).max) << 160) | uint160(address(0xBEEF))));
        endpoints.push(bytes32((uint256(196) << 160) | uint160(address(0xCAFE))));
    }

    function endpointCount() external view returns (uint256) {
        return endpoints.length;
    }

    function gInLen(bytes32 to) external view returns (uint256) {
        return gIn[to].length;
    }

    function gInAt(bytes32 to, uint256 i) external view returns (DeWebHub.Entry memory) {
        return gIn[to][i];
    }

    function gOutLen(address from) external view returns (uint256) {
        return gOutTo[from].length;
    }

    function gOutAt(address from, uint256 j) external view returns (bytes32, uint256) {
        return (gOutTo[from][j], gOutIdx[from][j]);
    }

    function _isHolderOk(uint256 t, address caller) internal view returns (bool) {
        (bool ok, bytes memory r) = address(circuits).staticcall(abi.encodeCall(MockCircuits.ownerOf, (ids[t])));
        return ok && abi.decode(r, (address)) == caller && factory.isCPU(address(circuits)) && beacon.implementation() == circuitImpl
            && payments.paid(containers[t]);
    }

    function _snap(uint256 t) internal view returns (bytes32) {
        bytes32 h;
        for (uint256 e = 0; e < endpoints.length; e++) h = keccak256(abi.encode(h, hub.inboxCount(endpoints[e])));
        for (uint256 k = 0; k < NTOK; k++) {
            h = keccak256(abi.encode(h, hub.outboxCount(containers[k]), hub.keyOf(containers[k])));
        }
        return keccak256(abi.encode(h, t));
    }

    // ---------------------------------------------------------------- 写操作

    function _payload(uint16 len, uint8 fill) internal pure returns (bytes memory payload) {
        uint256 size = len % 600 + 1;
        payload = new bytes(size);
        for (uint256 i = 0; i < size; i++) payload[i] = bytes1(uint8(fill + i));
    }

    function _doSend(uint256 a, uint256 t, bytes32 to, bytes32 ref, bytes memory payload) internal returns (bool ok) {
        address caller = actors[a];
        bytes memory data = abi.encodeCall(DeWebHub.send, (address(circuits), ids[t], to, ref, payload));
        if (a == 4) {
            try SmartWallet(caller).call(address(hub), data) returns (bytes memory ret) {
                ok = true;
                assertEq(abi.decode(ret, (uint256)), gIn[to].length, "returned index == previous count");
            } catch {}
        } else {
            vm.prank(caller);
            (ok,) = address(hub).call(data);
        }
    }

    /// a >= 5 时改用这枚电路的当前持有人（提高成功路径的比例）
    function _pick(uint256 a, uint256 t, uint256 maxA) internal view returns (uint256) {
        a = bound(a, 0, 9);
        if (a <= maxA) return a;
        if (a <= 4) return a % (maxA + 1);
        address o = circuits.ownerOf(ids[t]);
        for (uint256 k = 0; k <= maxA; k++) if (actors[k] == o) return k;
        return 0;
    }

    function send(uint256 a, uint256 t, uint256 e, bytes32 ref, uint16 len, uint8 fill) external {
        calls++;
        t = bound(t, 0, NTOK - 1);
        a = _pick(a, t, 4);
        bytes32 to = endpoints[bound(e, 0, endpoints.length - 1)];
        bytes memory payload = _payload(len, fill);
        bool expectOk = _isHolderOk(t, actors[a]);
        bytes32 before = _snap(t);
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 3);
        bool ok = _doSend(a, t, to, ref, payload);
        assertEq(ok, expectOk, "send succeeds iff genuine holder of an opened container");
        if (!ok) {
            assertEq(_snap(t), before, "failed send changes nothing");
            unauthorizedRejected++;
            return;
        }
        successes++;
        address from = containers[t];
        gOutTo[from].push(to);
        gOutIdx[from].push(gIn[to].length);
        gIn[to].push(
            DeWebHub.Entry({
                from: from,
                blockNumber: uint56(block.number),
                timestamp: uint40(block.timestamp),
                digest: keccak256(abi.encodePacked(ref, keccak256(payload)))
            })
        );
        gTotal++;
    }

    function publishKey(uint256 a, uint256 t, uint16 keyIndex, bytes32 key, uint64 chains) external {
        calls++;
        t = bound(t, 0, NTOK - 1);
        a = _pick(a, t, 4);
        if (key == bytes32(0)) key = bytes32(uint256(1));
        if (chains == 0) chains = 1;
        address caller = actors[a];
        bool expectOk = _isHolderOk(t, caller) && a != 4 && (caller.code.length == 0 || caller.code.length == 23);
        bytes32 before = _snap(t);
        bool ok;
        if (a == 4) {
            try SmartWallet(caller).call(
                address(hub), abi.encodeCall(DeWebHub.publishKey, (address(circuits), ids[t], 1, keyIndex, key, chains))
            ) {
                ok = true;
            } catch {}
        } else {
            vm.prank(caller, a == 3 ? actors[0] : caller); // 7702 账户走代付，普通账户自己发
            try hub.publishKey(address(circuits), ids[t], 1, keyIndex, key, chains) {
                ok = true;
            } catch {}
        }
        assertEq(ok, expectOk, "publishKey succeeds iff holder is a plain account");
        if (!ok) {
            assertEq(_snap(t), before, "failed publish changes nothing");
            unauthorizedRejected++;
            return;
        }
        successes++;
        gVersion[containers[t]]++;
        DeWebHub.KeyRecord memory r = hub.keyOf(containers[t]);
        assertEq(r.key, key);
        assertEq(r.holder, caller);
        assertEq(r.keyIndex, keyIndex);
        assertEq(r.chains, chains);
    }

    function revokeKey(uint256 a, uint256 t) external {
        calls++;
        t = bound(t, 0, NTOK - 1);
        a = _pick(a, t, 3);
        address caller = actors[a];
        bool expectOk = _isHolderOk(t, caller) && hub.keyOf(containers[t]).suite != 0;
        bytes32 before = _snap(t);
        vm.prank(caller);
        bool ok;
        try hub.revokeKey(address(circuits), ids[t]) {
            ok = true;
        } catch {}
        assertEq(ok, expectOk, "revoke succeeds iff holder and a key exists");
        if (!ok) {
            assertEq(_snap(t), before, "failed revoke changes nothing");
            return;
        }
        gVersion[containers[t]]++;
        DeWebHub.KeyRecord memory r = hub.keyOf(containers[t]);
        assertTrue(r.key == bytes32(0) && r.holder == address(0) && r.suite == 0 && r.keyIndex == 0 && r.chains == 0, "revoke clears");
    }

    // ---------------------------------------------------------------- 环境变化（不经过中枢）

    function transfer(uint256 t, uint256 a) external {
        t = bound(t, 0, NTOK - 1);
        circuits.setOwner(ids[t], actors[bound(a, 0, 4)]);
    }

    function setPaid(uint256 t, uint8 x) external {
        t = bound(t, 0, NTOK - 1);
        payments.set(containers[t], x % 6 != 0);
    }

    function setCPU(uint8 x) external {
        factory.set(address(circuits), x % 6 != 0);
    }

    function swapBeacon(uint8 x) external {
        beacon.upgradeTo(x % 6 != 0 ? circuitImpl : address(0xE7E7));
    }

    function holderBecomesContract(uint256 a, uint8 x) external {
        a = bound(a, 0, 2);
        vm.etch(actors[a], x % 4 != 0 ? bytes("") : bytes(hex"6001600155"));
    }

    // ---------------------------------------------------------------- 未授权者
    function strangerAdmin(address s, uint8 which, address arg) external {
        vm.assume(s != address(0x0117));
        vm.prank(s);
        bool ok;
        if (which % 5 == 0) (ok,) = address(hub).call(abi.encodeCall(DeWebAdmin.upgradeToAndCall, (arg, "")));
        else if (which % 5 == 1) (ok,) = address(hub).call(abi.encodeCall(DeWebAdmin.seal, ()));
        else if (which % 5 == 2) (ok,) = address(hub).call(abi.encodeCall(DeWebAdmin.transferOwnership, (arg)));
        else if (which % 5 == 3) (ok,) = address(hub).call(abi.encodeCall(DeWebAdmin.acceptOwnership, ()));
        else (ok,) = address(hub).call(abi.encodeCall(DeWebAdmin.initialize, (arg)));
        assertFalse(ok, "stranger admin call must revert");
    }
}

/// 不变量测试：处理合约里的断言失败本身就是回滚，必须 fail-on-revert，否则失败会被悄悄吞掉
/// forge-config: default.invariant.fail-on-revert = true
/// forge-config: default.invariant.runs = 128
/// forge-config: default.invariant.depth = 100
contract DeWebInvariantTest is Test {
    DeWebHub hub;
    Handler h;
    MockCircuits circuits;
    MockFactory factory;
    MockPayments payments;
    MockBeacon beacon;
    address constant OWNER = address(0x0117);
    address circuitImpl = address(0xC1C1);
    address accountImpl = address(0xA11CE);
    address logicAddr;

    function setUp() public {
        vm.etch(circuitImpl, hex"00");
        vm.etch(accountImpl, hex"00");
        factory = new MockFactory();
        circuits = new MockCircuits();
        payments = new MockPayments();
        MockRegistry registry = new MockRegistry();
        beacon = new MockBeacon(circuitImpl);
        DeWebBoot boot = new DeWebBoot();
        hub = DeWebHub(address(new DeWebProxy(address(boot), abi.encodeCall(DeWebAdmin.initialize, (OWNER)))));
        DeWebHub logic = new DeWebHub(
            block.chainid, address(registry), accountImpl, address(factory), address(payments), address(beacon), circuitImpl,
            address(circuits).codehash
        );
        logicAddr = address(logic);
        vm.prank(OWNER);
        hub.upgradeToAndCall(address(logic), "");
        factory.set(address(circuits), true);
        SmartWallet w = new SmartWallet();
        h = new Handler(hub, circuits, factory, payments, beacon, circuitImpl, w);
        for (uint256 k = 0; k < 4; k++) {
            circuits.setOwner(h.ids(k), h.actors(k % 4 == 3 ? 3 : k));
            payments.set(h.containers(k), true);
        }
        targetContract(address(h));
    }

    /// 收件信箱：计数 == 影子账本；每一条从写入起一字不变（只增不改）
    function invariant_inboxAppendOnlyAndExact() public view {
        for (uint256 e = 0; e < h.endpointCount(); e++) {
            bytes32 to = h.endpoints(e);
            uint256 n = hub.inboxCount(to);
            assertEq(n, h.gInLen(to), "inboxCount");
            for (uint256 i = 0; i < n; i++) {
                DeWebHub.Entry memory a = hub.inboxAt(to, i);
                DeWebHub.Entry memory g = h.gInAt(to, i);
                assertEq(a.from, g.from);
                assertEq(a.blockNumber, g.blockNumber);
                assertEq(a.timestamp, g.timestamp);
                assertEq(a.digest, g.digest);
            }
            if (n > 0) {
                // inboxPage 与 inboxAt 一致
                DeWebHub.Entry[] memory p = hub.inboxPage(to, 0, n);
                assertEq(p.length, n > 200 ? 200 : n);
                for (uint256 i = 0; i < p.length; i++) assertEq(p[i].digest, hub.inboxAt(to, i).digest);
                // 任意起点的第二页（客户端从后往前翻页时 start > 0）
                for (uint256 st = 1; st < n; st++) {
                    DeWebHub.Entry[] memory q = hub.inboxPage(to, st, 2);
                    assertEq(q.length, n - st >= 2 ? 2 : 1);
                    assertEq(q[0].digest, h.gInAt(to, st).digest);
                    assertEq(q[0].from, h.gInAt(to, st).from);
                }
            }
        }
    }

    /// 发件目录与收件信箱互相指向：outboxPage[j] 指向的 inbox 条目的发件人就是自己
    function invariant_outboxPointsIntoInbox() public view {
        uint256 total;
        for (uint256 k = 0; k < 4; k++) {
            address c = h.containers(k);
            uint256 n = hub.outboxCount(c);
            assertEq(n, h.gOutLen(c), "outboxCount");
            total += n;
            if (n == 0) continue;
            DeWebHub.OutEntry[] memory out = hub.outboxPage(c, 0, n);
            for (uint256 j = 0; j < out.length; j++) {
                (bytes32 gto, uint256 gidx) = h.gOutAt(c, j);
                assertEq(out[j].to, gto);
                assertEq(out[j].inboxIndex, gidx);
                DeWebHub.Entry memory e = hub.inboxAt(out[j].to, out[j].inboxIndex);
                assertEq(e.from, c, "outbox entry points at a message from this container");
                assertEq(e.digest, out[j].digest);
                assertEq(e.blockNumber, out[j].blockNumber);
                assertEq(e.timestamp, out[j].timestamp);
                DeWebHub.OutEntry memory o1 = hub.outboxPage(c, j, 1)[0];
                assertEq(o1.to, gto);
                assertEq(o1.inboxIndex, gidx);
            }
        }
        assertEq(total, h.gTotal(), "sum(outbox) == number of successful sends");
        uint256 inTotal;
        for (uint256 e = 0; e < h.endpointCount(); e++) inTotal += hub.inboxCount(h.endpoints(e));
        assertEq(inTotal, h.gTotal(), "sum(inbox) == number of successful sends");
    }

    /// keyFor.usable ⇒ 当前持有人 == 发布者、是普通账户、电路真实、记录完整
    function invariant_usableImpliesSound() public view {
        for (uint256 k = 0; k < 4; k++) {
            DeWebHub.KeyView memory v = hub.keyFor(address(circuits), h.ids(k));
            DeWebHub.KeyRecord memory r = hub.keyOf(v.container);
            assertEq(r.version, h.gVersion(v.container), "version counts every publish/revoke");
            if (!v.usable) {
                assertEq(v.chains, 0, "chains hidden when unusable");
                continue;
            }
            assertEq(v.current, r.holder, "usable => current == publisher");
            assertTrue(v.current != address(0));
            uint256 sz = v.current.code.length;
            assertTrue(sz == 0 || sz == 23, "usable => plain account");
            assertEq(v.suite, 1);
            assertTrue(v.key != bytes32(0));
            assertTrue(v.chains != 0);
            assertEq(beacon.implementation(), circuitImpl);
            assertTrue(factory.isCPU(address(circuits)));
        }
    }

    /// 管理状态不会被非 owner 改变；中枢不持有任何资产
    function invariant_adminUntouched() public view {
        assertEq(hub.owner(), OWNER);
        assertFalse(hub.isSealed());
        assertEq(hub.pendingOwner(), address(0));
        assertEq(
            address(uint160(uint256(vm.load(address(hub), 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc)))),
            logicAddr
        );
        assertEq(address(hub).balance, 0);
    }

    function afterInvariant() external {
        // 确认模糊器确实走到了成功路径和拒绝路径
        emit log_named_uint("calls", h.calls());
        emit log_named_uint("successes", h.successes());
        emit log_named_uint("rejected", h.unauthorizedRejected());
    }
}

/// 无状态模糊测试
contract DeWebFuzzTest is Test {
    DeWebHub hub;
    MockCircuits circuits;
    MockPayments payments;
    MockFactory factory;
    address alice = makeAddr("alice");
    uint256 constant ID = 4246;
    address container;
    bytes32 constant HUB_SLOT = 0x52508d06499dccc2446f87bf89abfddc2d85f3e5a1bdd29ea2bc99cdfd6b2000;

    function setUp() public {
        address circuitImpl = address(0xC1C1);
        address accountImpl = address(0xA11CE);
        vm.etch(circuitImpl, hex"00");
        vm.etch(accountImpl, hex"00");
        factory = new MockFactory();
        circuits = new MockCircuits();
        payments = new MockPayments();
        MockRegistry registry = new MockRegistry();
        MockBeacon beacon = new MockBeacon(circuitImpl);
        DeWebBoot boot = new DeWebBoot();
        hub = DeWebHub(address(new DeWebProxy(address(boot), abi.encodeCall(DeWebAdmin.initialize, (address(this))))));
        DeWebHub logic = new DeWebHub(
            block.chainid, address(registry), accountImpl, address(factory), address(payments), address(beacon), circuitImpl,
            address(circuits).codehash
        );
        hub.upgradeToAndCall(address(logic), "");
        factory.set(address(circuits), true);
        circuits.setOwner(ID, alice);
        container = hub.accountOf(address(circuits), ID);
        payments.set(container, true);
    }

    function _setInboxCount(bytes32 to, uint256 n) internal {
        vm.store(address(hub), keccak256(abi.encode(to, uint256(HUB_SLOT) + 1)), bytes32(n));
    }

    function _setOutboxCount(address from, uint256 n) internal {
        vm.store(address(hub), keccak256(abi.encode(from, uint256(HUB_SLOT) + 3)), bytes32(n));
    }

    /// 分页长度 == min(n, MAX_PAGE, max(count - start, 0))，并且第 k 条就是 inboxAt(start + k)
    function testFuzz_inboxPageLength(uint256 count, uint256 start, uint256 n) public {
        bytes32 to = hub.endpointOf(address(0xB0B));
        count = bound(count, 0, 1000);
        _setInboxCount(to, count);
        uint256 want = start >= count ? 0 : count - start;
        uint256 cap = n > 200 ? 200 : n;
        if (want > cap) want = cap;
        DeWebHub.Entry[] memory p = hub.inboxPage(to, start, n);
        assertEq(p.length, want);
        DeWebHub.OutEntry[] memory q = hub.outboxPage(address(0xB0B), start, n);
        assertEq(q.length, 0);
        _setOutboxCount(address(0xB0B), count);
        assertEq(hub.outboxPage(address(0xB0B), start, n).length, want);
    }

    /// outbox 打包：任意合法端点 + 任意 32 位序号都能原样解回（包括序号的最高位）
    function testFuzz_outboxPackingRoundTrip(uint64 chain, address c, uint32 idx) public {
        vm.assume(chain != 0 && c != address(0) && idx < type(uint32).max);
        bytes32 to = bytes32((uint256(chain) << 160) | uint160(c));
        _setInboxCount(to, idx);
        vm.prank(alice);
        assertEq(hub.send(address(circuits), ID, to, bytes32(uint256(idx)), hex"01"), idx);
        DeWebHub.OutEntry memory o = hub.outboxPage(container, 0, 1)[0];
        assertEq(o.to, to);
        assertEq(o.inboxIndex, idx);
        assertEq(o.digest, hub.inboxAt(to, idx).digest);
        assertEq(o.digest, hub.digestOf(bytes32(uint256(idx)), hex"01"));
    }

    /// digest 与客户端公式一致：keccak256(ref ‖ keccak256(payload))，与 abi.encode(ref, h) 恰好相同
    function testFuzz_digestFormula(bytes32 ref, bytes calldata payload) public view {
        bytes32 d = hub.digestOf(ref, payload);
        assertEq(d, keccak256(abi.encodePacked(ref, keccak256(payload))));
        assertTrue(d != keccak256(abi.encodePacked(keccak256(payload), ref)) || ref == keccak256(payload));
    }

    /// _keyCapable：只有"没有代码"或"恰好 23 字节且前缀 ef0100"的持有人可以发布、usable 才为 true
    function testFuzz_keyCapableExact(bytes memory code) public {
        vm.assume(code.length <= 64);
        address hld = makeAddr("holderX");
        circuits.setOwner(ID, hld);
        bool plain = code.length == 0 || (code.length == 23 && code[0] == 0xef && code[1] == 0x01 && code[2] == 0x00);
        try this.etchExt(hld, code) {} catch { return; }
        vm.prank(hld, hld);
        (bool ok,) = address(hub).call(abi.encodeCall(DeWebHub.publishKey, (address(circuits), ID, 1, 0, keccak256("k"), 1)));
        assertEq(ok, plain, "publish accepted iff plain account");
        if (ok) assertTrue(hub.keyFor(address(circuits), ID).usable);
    }

    function etchExt(address a, bytes memory c) external {
        vm.etch(a, c);
    }

    /// 端点号检查与客户端 parseEndpointId 同一规则（高 4 字节 0、链号 ≠ 0、容器 ≠ 0）
    function testFuzz_endpointRoundTrip(address c) public view {
        vm.assume(c != address(0));
        bytes32 e = hub.endpointOf(c);
        assertEq(uint256(e) >> 224, 0);
        assertEq(uint64(uint256(e) >> 160), block.chainid);
        assertEq(address(uint160(uint256(e))), c);
    }

    /// 单个未授权调用者：send / publishKey / revokeKey 全部回滚，且计数、公钥记录都不变
    function testFuzz_strangerChangesNothing(address s, bytes32 to, bytes32 ref, bytes32 key, uint64 chains, uint16 ki) public {
        vm.assume(s != alice && s != address(0));
        to = bytes32((uint256(56) << 160) | uint160(uint256(to)));
        if (uint160(uint256(to)) == 0) to = bytes32(uint256(to) | 1);
        vm.prank(alice, alice);
        hub.publishKey(address(circuits), ID, 1, 7, keccak256("orig"), 3);
        bytes32 before = keccak256(abi.encode(hub.keyOf(container), hub.inboxCount(to), hub.outboxCount(container)));
        vm.startPrank(s, s);
        (bool a,) = address(hub).call(abi.encodeCall(DeWebHub.send, (address(circuits), ID, to, ref, hex"01")));
        (bool b,) = address(hub).call(abi.encodeCall(DeWebHub.publishKey, (address(circuits), ID, 1, ki, key, chains)));
        (bool c,) = address(hub).call(abi.encodeCall(DeWebHub.revokeKey, (address(circuits), ID)));
        vm.stopPrank();
        assertFalse(a || b || c);
        assertEq(keccak256(abi.encode(hub.keyOf(container), hub.inboxCount(to), hub.outboxCount(container))), before);
    }
}

contract DeWebHandlerSmoke is DeWebInvariantTest {
    function test_smoke() public {
        h.send(0, 0, 1, bytes32(0), 5, 1);
        h.send(3, 3, 0, bytes32(0), 5, 1);
        h.publishKey(0, 0, 1, bytes32(uint256(5)), 1);
        h.publishKey(3, 3, 1, bytes32(uint256(5)), 1);
        emit log_named_uint("successes", h.successes());
        invariant_inboxAppendOnlyAndExact();
        invariant_outboxPointsIntoInbox();
        invariant_usableImpliesSound();
    }
}
