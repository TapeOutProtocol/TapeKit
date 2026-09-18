// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {DeWebHub} from "../src/DeWebHub.sol";
import {DeWebAdmin} from "../src/DeWebAdmin.sol";
import {DeWebBoot} from "../src/DeWebBoot.sol";
import {DeWebProxy} from "../src/DeWebProxy.sol";
import {
    MockFactory,
    MockBeacon,
    MockCircuits,
    MockPayments,
    MockRegistry,
    Weird,
    SmartWallet,
    ConstructorPublisher,
    ZeroRegistry
} from "./Mocks.sol";

contract DeWebHubTest is Test {
    DeWebHub hub;
    MockFactory factory;
    MockCircuits circuits;
    MockPayments payments;
    MockRegistry registry;
    MockBeacon beacon;
    address impl = address(0xA11CE);
    address circuitImpl = address(0xC1C1);

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    uint256 constant ID = 4246;
    uint256 constant BOB_ID = 7;
    uint64 constant BASE = 8453;
    uint64 constant ALL = 1;
    address container;
    address bobContainer;

    event KeyPublished(
        address indexed container, address indexed holder, uint8 suite, uint16 keyIndex, bytes32 key, uint32 version, uint64 chains
    );
    event KeyRevoked(address indexed container, address indexed holder, uint32 version);
    event Sent(
        bytes32 indexed to, address indexed from, bytes32 indexed ref, uint256 inboxIndex, uint256 outboxIndex, bytes payload
    );

    /// @dev 和主网一样经 启动实现 → 代理 → 升级到正式实现 运行
    function _hub(address r, address f, address p, address b, address ci, bytes32 ch) internal returns (DeWebHub) {
        DeWebBoot boot = new DeWebBoot();
        address proxy = address(new DeWebProxy(address(boot), abi.encodeCall(DeWebAdmin.initialize, (address(this)))));
        DeWebHub logic = new DeWebHub(block.chainid, r, impl, f, p, b, ci, ch);
        DeWebAdmin(proxy).upgradeToAndCall(address(logic), "");
        return DeWebHub(proxy);
    }

    function _ep(address a) internal view returns (bytes32) {
        return bytes32((block.chainid << 160) | uint256(uint160(a)));
    }

    function _epOn(uint64 chain, address a) internal pure returns (bytes32) {
        return bytes32((uint256(chain) << 160) | uint256(uint160(a)));
    }

    function setUp() public {
        vm.etch(impl, hex"00");
        vm.etch(circuitImpl, hex"00");
        factory = new MockFactory();
        circuits = new MockCircuits();
        payments = new MockPayments();
        registry = new MockRegistry();
        beacon = new MockBeacon(circuitImpl);
        hub = _hub(address(registry), address(factory), address(payments), address(beacon), circuitImpl, address(circuits).codehash);
        factory.set(address(circuits), true);
        circuits.setOwner(ID, alice);
        circuits.setOwner(BOB_ID, bob);
        container = hub.accountOf(address(circuits), ID);
        bobContainer = hub.accountOf(address(circuits), BOB_ID);
        payments.set(container, true);
        payments.set(bobContainer, true);
    }

    // ---------------------------------------------------------------- 构造

    function test_constructor_rejectsZero() public {
        bytes32 ch = address(circuits).codehash;
        address r = address(registry);
        address f = address(factory);
        address p = address(payments);
        address b = address(beacon);
        vm.expectRevert(DeWebAdmin.ZeroAddress.selector);
        new DeWebHub(block.chainid, address(0), impl, f, p, b, circuitImpl, ch);
        vm.expectRevert(DeWebAdmin.ZeroAddress.selector);
        new DeWebHub(block.chainid, r, address(0), f, p, b, circuitImpl, ch);
        vm.expectRevert(DeWebAdmin.ZeroAddress.selector);
        new DeWebHub(block.chainid, r, impl, address(0), p, b, circuitImpl, ch);
        vm.expectRevert(DeWebAdmin.ZeroAddress.selector);
        new DeWebHub(block.chainid, r, impl, f, address(0), b, circuitImpl, ch);
        vm.expectRevert(DeWebAdmin.ZeroAddress.selector);
        new DeWebHub(block.chainid, r, impl, f, p, address(0), circuitImpl, ch);
        vm.expectRevert(DeWebAdmin.ZeroAddress.selector);
        new DeWebHub(block.chainid, r, impl, f, p, b, address(0), ch);
        vm.expectRevert(DeWebAdmin.ZeroAddress.selector);
        new DeWebHub(block.chainid, r, impl, f, p, b, circuitImpl, bytes32(0));
    }

    function test_constructor_rejectsCodeless() public {
        bytes32 ch = address(circuits).codehash;
        address r = address(registry);
        address f = address(factory);
        address p = address(payments);
        address b = address(beacon);
        address eoa = makeAddr("eoa");
        vm.expectRevert(DeWebAdmin.NotAContract.selector);
        new DeWebHub(block.chainid, eoa, impl, f, p, b, circuitImpl, ch);
        vm.expectRevert(DeWebAdmin.NotAContract.selector);
        new DeWebHub(block.chainid, r, eoa, f, p, b, circuitImpl, ch);
        vm.expectRevert(DeWebAdmin.NotAContract.selector);
        new DeWebHub(block.chainid, r, impl, eoa, p, b, circuitImpl, ch);
        vm.expectRevert(DeWebAdmin.NotAContract.selector);
        new DeWebHub(block.chainid, r, impl, f, eoa, b, circuitImpl, ch);
        vm.expectRevert(DeWebAdmin.NotAContract.selector);
        new DeWebHub(block.chainid, r, impl, f, p, eoa, circuitImpl, ch);
        vm.expectRevert(DeWebAdmin.NotAContract.selector);
        new DeWebHub(block.chainid, r, impl, f, p, b, eoa, ch);
    }

    function test_accountOf_matchesRegistry() public view {
        assertEq(container, registry.account(impl, bytes32(0), block.chainid, address(circuits), ID));
    }

    function test_endpointOf_layout() public view {
        bytes32 e = hub.endpointOf(container);
        assertEq(uint256(e) >> 224, 0, "top 32 bits zero");
        assertEq(uint64(uint256(e) >> 160), block.chainid, "chain id");
        assertEq(address(uint160(uint256(e))), container, "container");
        assertEq(e, _ep(container));
    }

    // ---------------------------------------------------------------- send：端点号

    function test_send_emitsAndStores() public {
        bytes32 to = _ep(bobContainer);
        bytes memory payload = hex"54530100aabbcc";
        bytes32 ref = bytes32(uint256(7));
        vm.roll(1234);
        vm.warp(1_800_000_000);
        vm.expectEmit(true, true, true, true, address(hub));
        emit Sent(to, container, ref, 0, 0, payload);
        vm.prank(alice);
        uint256 i = hub.send(address(circuits), ID, to, ref, payload);
        assertEq(i, 0);

        assertEq(hub.inboxCount(to), 1);
        DeWebHub.Entry memory e = hub.inboxAt(to, 0);
        assertEq(e.from, container);
        assertEq(e.blockNumber, 1234);
        assertEq(e.timestamp, 1_800_000_000);
        assertEq(e.digest, keccak256(abi.encodePacked(ref, keccak256(payload))));
        assertEq(e.digest, hub.digestOf(ref, payload));

        assertEq(hub.outboxCount(container), 1);
        DeWebHub.OutEntry[] memory out = hub.outboxPage(container, 0, 10);
        assertEq(out.length, 1);
        assertEq(out[0].to, to);
        assertEq(out[0].inboxIndex, 0);
        assertEq(out[0].blockNumber, 1234);
        assertEq(out[0].timestamp, 1_800_000_000);
        assertEq(out[0].digest, e.digest);
    }

    function test_send_toOtherChainEndpoint() public {
        // 收件人在 Base：本链中枢照样记进 inbox[Base 端点号]
        address baseContainer = makeAddr("baseContainer");
        bytes32 to = _epOn(BASE, baseContainer);
        vm.prank(alice);
        hub.send(address(circuits), ID, to, 0, hex"01");
        assertEq(hub.inboxCount(to), 1);
        assertEq(hub.inboxCount(_ep(baseContainer)), 0, "same address on this chain is a different endpoint");
        assertEq(hub.inboxAt(to, 0).from, container);
        assertEq(hub.outboxPage(container, 0, 1)[0].to, to);
    }

    function test_send_badEndpointRejected() public {
        bytes32[5] memory bad = [
            bytes32(0),
            _epOn(0, bob), // 链号 0
            _epOn(56, address(0)), // 容器 0
            bytes32((uint256(1) << 224) | (uint256(56) << 160) | uint160(bob)), // 保留位非 0
            bytes32(type(uint256).max)
        ];
        for (uint256 k = 0; k < bad.length; k++) {
            vm.prank(alice);
            vm.expectRevert(DeWebHub.BadEndpoint.selector);
            hub.send(address(circuits), ID, bad[k], 0, hex"01");
        }
    }

    function test_send_maxChainIdEndpointAccepted() public {
        bytes32 to = _epOn(type(uint64).max, bob);
        vm.prank(alice);
        hub.send(address(circuits), ID, to, 0, hex"01");
        assertEq(hub.inboxCount(to), 1);
        assertEq(hub.outboxPage(container, 0, 1)[0].to, to, "packing keeps the full 224-bit endpoint");
    }

    function test_send_indicesAdvance() public {
        bytes32 toBob = _ep(bobContainer);
        bytes32 toX = _epOn(BASE, makeAddr("x"));
        vm.startPrank(alice);
        assertEq(hub.send(address(circuits), ID, toBob, 0, hex"01"), 0);
        assertEq(hub.send(address(circuits), ID, toX, 0, hex"02"), 0);
        assertEq(hub.send(address(circuits), ID, toBob, 0, hex"03"), 1);
        vm.stopPrank();
        vm.prank(bob);
        assertEq(hub.send(address(circuits), BOB_ID, toBob, 0, hex"04"), 2, "sending to yourself works");

        assertEq(hub.inboxCount(toBob), 3);
        assertEq(hub.outboxCount(container), 3);
        assertEq(hub.outboxCount(bobContainer), 1);
        DeWebHub.OutEntry[] memory out = hub.outboxPage(container, 0, 10);
        assertEq(out[0].to, toBob);
        assertEq(out[0].inboxIndex, 0);
        assertEq(out[1].to, toX);
        assertEq(out[1].inboxIndex, 0);
        assertEq(out[2].to, toBob);
        assertEq(out[2].inboxIndex, 1);
        assertEq(out[2].digest, hub.digestOf(0, hex"03"));
        assertEq(hub.inboxAt(toBob, 2).from, bobContainer);
    }

    function test_send_eventCarriesIndices() public {
        bytes32 to = _ep(bobContainer);
        vm.prank(alice);
        hub.send(address(circuits), ID, _epOn(BASE, bob), 0, hex"01");
        vm.recordLogs();
        vm.prank(alice);
        hub.send(address(circuits), ID, to, bytes32(uint256(9)), hex"0203");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[1], to);
        assertEq(address(uint160(uint256(logs[0].topics[2]))), container);
        assertEq(logs[0].topics[3], bytes32(uint256(9)));
        (uint256 i, uint256 j, bytes memory payload) = abi.decode(logs[0].data, (uint256, uint256, bytes));
        assertEq(i, 0);
        assertEq(j, 1);
        assertEq(payload, hex"0203");
    }

    function test_send_toUnopenedContainerAllowed() public {
        address unopened = hub.accountOf(address(circuits), 999);
        vm.prank(alice);
        hub.send(address(circuits), ID, _ep(unopened), 0, hex"01");
    }

    function test_send_contractHolderMaySend() public {
        SmartWallet w = new SmartWallet();
        circuits.setOwner(ID, address(w));
        vm.recordLogs();
        w.call(address(hub), abi.encodeCall(DeWebHub.send, (address(circuits), ID, _ep(bob), bytes32(0), hex"01")));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(address(uint160(uint256(logs[0].topics[2]))), container);
    }

    // ---------------------------------------------------------------- send：授权（与 v0.5 相同）

    function test_send_notHolder() public {
        vm.prank(bob);
        vm.expectRevert(DeWebHub.NotHolder.selector);
        hub.send(address(circuits), ID, _ep(bob), 0, hex"01");
    }

    function test_send_nonexistentToken() public {
        vm.prank(alice);
        vm.expectRevert(DeWebHub.NotHolder.selector);
        hub.send(address(circuits), 12345, _ep(bob), 0, hex"01");
    }

    function test_send_notCPU() public {
        factory.set(address(circuits), false);
        vm.prank(alice);
        vm.expectRevert(DeWebHub.NotCPU.selector);
        hub.send(address(circuits), ID, _ep(bob), 0, hex"01");
    }

    function test_send_registeredButWrongCodehash() public {
        Weird w = new Weird();
        factory.set(address(w), true);
        vm.prank(alice);
        vm.expectRevert(DeWebHub.NotCPU.selector);
        hub.send(address(w), ID, _ep(bob), 0, hex"01");
    }

    function test_send_sameCodeButNotRegistered() public {
        MockCircuits clone = new MockCircuits();
        clone.setOwner(ID, bob);
        assertEq(address(clone).codehash, address(circuits).codehash);
        vm.prank(bob);
        vm.expectRevert(DeWebHub.NotCPU.selector);
        hub.send(address(clone), ID, _ep(alice), 0, hex"01");
    }

    function test_send_circuitsImplementationChanged() public {
        beacon.upgradeTo(address(0xE7E7));
        vm.prank(alice);
        vm.expectRevert(DeWebHub.CircuitsChanged.selector);
        hub.send(address(circuits), ID, _ep(bob), 0, hex"01");
        vm.prank(alice);
        vm.expectRevert(DeWebHub.CircuitsChanged.selector);
        hub.publishKey(address(circuits), ID, 1, 0, keccak256("k"), ALL);
        vm.prank(alice);
        vm.expectRevert(DeWebHub.CircuitsChanged.selector);
        hub.revokeKey(address(circuits), ID);
    }

    function test_send_notOpened() public {
        payments.set(container, false);
        vm.prank(alice);
        vm.expectRevert(DeWebHub.NotOpened.selector);
        hub.send(address(circuits), ID, _ep(bob), 0, hex"01");
    }

    function test_send_emptyPayload() public {
        vm.prank(alice);
        vm.expectRevert(DeWebHub.EmptyPayload.selector);
        hub.send(address(circuits), ID, _ep(bob), 0, "");
    }

    function test_send_maxPayloadBoundary() public {
        assertEq(hub.MAX_PAYLOAD(), 16_000);
        bytes memory ok = new bytes(hub.MAX_PAYLOAD());
        vm.prank(alice);
        hub.send(address(circuits), ID, _ep(bob), 0, ok);

        bytes memory tooBig = new bytes(hub.MAX_PAYLOAD() + 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DeWebHub.PayloadTooLarge.selector, tooBig.length, hub.MAX_PAYLOAD()));
        hub.send(address(circuits), ID, _ep(bob), 0, tooBig);
    }

    function test_send_afterTransfer_newHolderSendsOldCannot() public {
        circuits.setOwner(ID, bob);
        vm.prank(alice);
        vm.expectRevert(DeWebHub.NotHolder.selector);
        hub.send(address(circuits), ID, _ep(bob), 0, hex"01");

        vm.recordLogs();
        vm.prank(bob);
        hub.send(address(circuits), ID, _ep(alice), 0, hex"01");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(address(uint160(uint256(logs[0].topics[2]))), container, "same container identity after transfer");
    }

    function test_send_hasNoPayableEntry() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(hub).call{value: 1 wei}(
            abi.encodeCall(DeWebHub.send, (address(circuits), ID, _ep(bob), bytes32(0), hex"01"))
        );
        assertFalse(ok, "send must not accept value");
        vm.prank(alice);
        (ok,) = address(hub).call{value: 1 wei}("");
        assertFalse(ok, "hub must not accept plain BNB");
        assertEq(address(hub).balance, 0);
    }

    function test_send_realisticReadCostFitsGasCap() public {
        circuits.setBurn(300);
        vm.prank(alice);
        hub.send(address(circuits), ID, _ep(bob), 0, hex"01");
        circuits.setBurn(20_000);
        vm.prank(alice);
        vm.expectRevert(DeWebHub.NotHolder.selector);
        hub.send(address(circuits), ID, _ep(bob), 0, hex"01");
    }

    function test_send_failedSendLeavesBoxesUntouched() public {
        vm.prank(bob);
        vm.expectRevert(DeWebHub.NotHolder.selector);
        hub.send(address(circuits), ID, _ep(bob), 0, hex"01");
        assertEq(hub.inboxCount(_ep(bob)), 0);
        assertEq(hub.outboxCount(container), 0);
    }

    function testFuzz_send_onlyHolderOfOpenedCPU(address caller, uint256 id, bool cpu, bool paid, bool intact) public {
        vm.assume(caller != address(0));
        circuits.setOwner(id, alice);
        factory.set(address(circuits), cpu);
        if (!intact) beacon.upgradeTo(address(0xE7E7));
        address c = hub.accountOf(address(circuits), id);
        payments.set(c, paid);
        bool shouldPass = intact && cpu && caller == alice && paid;
        vm.prank(caller);
        if (!shouldPass) vm.expectRevert();
        hub.send(address(circuits), id, _ep(bob), 0, hex"01");
    }

    function testFuzz_endpointFormat(uint256 raw) public {
        bytes32 to = bytes32(raw);
        bool valid = raw >> 224 == 0 && (raw >> 160) != 0 && uint160(raw) != 0;
        vm.prank(alice);
        if (!valid) vm.expectRevert(DeWebHub.BadEndpoint.selector);
        hub.send(address(circuits), ID, to, 0, hex"01");
        if (valid) {
            assertEq(hub.inboxCount(to), 1);
            assertEq(hub.outboxPage(container, 0, 1)[0].to, to);
        }
    }

    // ---------------------------------------------------------------- 信箱分页

    function test_inboxPage_bounds() public {
        bytes32 to = _ep(bobContainer);
        vm.startPrank(alice);
        for (uint256 k = 0; k < 5; k++) {
            vm.roll(100 + k);
            hub.send(address(circuits), ID, to, 0, abi.encodePacked(uint8(k + 1)));
        }
        vm.stopPrank();

        DeWebHub.Entry[] memory all = hub.inboxPage(to, 0, 100);
        assertEq(all.length, 5);
        for (uint256 k = 0; k < 5; k++) {
            assertEq(all[k].blockNumber, 100 + k);
            assertEq(all[k].digest, hub.digestOf(0, abi.encodePacked(uint8(k + 1))));
        }
        assertEq(hub.inboxPage(to, 3, 100).length, 2);
        assertEq(hub.inboxPage(to, 3, 1).length, 1);
        assertEq(hub.inboxPage(to, 3, 1)[0].blockNumber, 103);
        assertEq(hub.inboxPage(to, 5, 10).length, 0, "start == count");
        assertEq(hub.inboxPage(to, 99, 10).length, 0, "start past end");
        assertEq(hub.inboxPage(to, type(uint256).max, type(uint256).max).length, 0, "no overflow");
        assertEq(hub.inboxPage(to, 0, 0).length, 0);
        assertEq(hub.inboxPage(_ep(alice), 0, 10).length, 0, "empty inbox");
        assertEq(hub.outboxPage(container, 4, type(uint256).max).length, 1);
        assertEq(hub.outboxPage(container, type(uint256).max, 1).length, 0);
    }

    function test_inboxAt_outOfRange() public {
        vm.expectRevert(DeWebHub.OutOfRange.selector);
        hub.inboxAt(_ep(bob), 0);
    }

    function test_page_cappedAtMaxPage() public {
        bytes32 to = _ep(bobContainer);
        vm.startPrank(alice);
        for (uint256 k = 0; k < 205; k++) {
            hub.send(address(circuits), ID, to, 0, hex"01");
        }
        vm.stopPrank();
        assertEq(hub.MAX_PAGE(), 200);
        assertEq(hub.inboxPage(to, 0, 1000).length, 200);
        assertEq(hub.inboxPage(to, 200, 1000).length, 5);
        assertEq(hub.outboxPage(container, 0, 1000).length, 200);
    }

    function test_boxFull_reverts() public {
        // 直接把计数写到上限，确认序号不会溢出进打包的高位
        bytes32 to = _ep(bobContainer);
        bytes32 hubSlot = 0x52508d06499dccc2446f87bf89abfddc2d85f3e5a1bdd29ea2bc99cdfd6b2000;
        bytes32 inboxCountSlot = keccak256(abi.encode(to, uint256(hubSlot) + 1));
        vm.store(address(hub), inboxCountSlot, bytes32(uint256(type(uint32).max)));
        assertEq(hub.inboxCount(to), type(uint32).max, "slot layout as expected");
        vm.prank(alice);
        vm.expectRevert(DeWebHub.BoxFull.selector);
        hub.send(address(circuits), ID, to, 0, hex"01");

        vm.store(address(hub), inboxCountSlot, bytes32(uint256(type(uint32).max - 1)));
        vm.prank(alice);
        assertEq(hub.send(address(circuits), ID, to, 0, hex"01"), type(uint32).max - 1);
        assertEq(hub.outboxPage(container, 0, 1)[0].inboxIndex, type(uint32).max - 1);
        assertEq(hub.outboxPage(container, 0, 1)[0].to, to);

        bytes32 outboxCountSlot = keccak256(abi.encode(container, uint256(hubSlot) + 3));
        vm.store(address(hub), outboxCountSlot, bytes32(uint256(type(uint32).max)));
        vm.prank(alice);
        vm.expectRevert(DeWebHub.BoxFull.selector);
        hub.send(address(circuits), ID, _ep(alice), 0, hex"01");
    }

    // ---------------------------------------------------------------- 公钥

    function test_publishKey_storesAndEmits() public {
        bytes32 k = keccak256("k1");
        vm.expectEmit(true, true, true, true, address(hub));
        emit KeyPublished(container, alice, 1, 3, k, 1, 0x5);
        vm.warp(1_800_000_000);
        vm.prank(alice, alice);
        hub.publishKey(address(circuits), ID, 1, 3, k, 0x5);

        DeWebHub.KeyRecord memory r = hub.keyOf(container);
        assertEq(r.suite, 1);
        assertEq(r.keyIndex, 3);
        assertEq(r.key, k);
        assertEq(r.holder, alice);
        assertEq(r.publishedAt, 1_800_000_000);
        assertEq(r.version, 1);
        assertEq(r.chains, 0x5);

        DeWebHub.KeyView memory v = hub.keyFor(address(circuits), ID);
        assertEq(v.container, container);
        assertEq(v.endpoint, _ep(container));
        assertTrue(v.opened);
        assertEq(v.current, alice);
        assertEq(v.suite, 1);
        assertEq(v.keyIndex, 3);
        assertEq(v.key, k);
        assertTrue(v.usable);
        assertEq(v.version, 1);
        assertEq(v.chains, 0x5);
    }

    function test_publishKey_replaceIncrementsVersionAndChains() public {
        vm.startPrank(alice, alice);
        hub.publishKey(address(circuits), ID, 1, 0, keccak256("k1"), 1);
        hub.publishKey(address(circuits), ID, 1, 0, keccak256("k2"), 3);
        vm.stopPrank();
        DeWebHub.KeyRecord memory r = hub.keyOf(container);
        assertEq(r.key, keccak256("k2"));
        assertEq(r.version, 2);
        assertEq(r.chains, 3);
    }

    function test_publishKey_rejectsBadInput() public {
        vm.startPrank(alice, alice);
        vm.expectRevert(DeWebHub.BadSuite.selector);
        hub.publishKey(address(circuits), ID, 0, 0, keccak256("k"), ALL);
        vm.expectRevert(DeWebHub.BadSuite.selector);
        hub.publishKey(address(circuits), ID, 2, 0, keccak256("k"), ALL);
        vm.expectRevert(DeWebHub.EmptyKey.selector);
        hub.publishKey(address(circuits), ID, 1, 0, bytes32(0), ALL);
        vm.expectRevert(DeWebHub.NoChains.selector);
        hub.publishKey(address(circuits), ID, 1, 0, keccak256("k"), 0);
        vm.stopPrank();
    }

    function test_publishKey_requiresHolderCPUAndOpened() public {
        vm.prank(bob);
        vm.expectRevert(DeWebHub.NotHolder.selector);
        hub.publishKey(address(circuits), ID, 1, 0, keccak256("k"), ALL);

        payments.set(container, false);
        vm.prank(alice);
        vm.expectRevert(DeWebHub.NotOpened.selector);
        hub.publishKey(address(circuits), ID, 1, 0, keccak256("k"), ALL);

        payments.set(container, true);
        factory.set(address(circuits), false);
        vm.prank(alice);
        vm.expectRevert(DeWebHub.NotCPU.selector);
        hub.publishKey(address(circuits), ID, 1, 0, keccak256("k"), ALL);
    }

    function test_publishKey_contractHolderRejected() public {
        SmartWallet w = new SmartWallet();
        circuits.setOwner(ID, address(w));
        vm.expectRevert(DeWebHub.ContractHolder.selector);
        w.call(address(hub), abi.encodeCall(DeWebHub.publishKey, (address(circuits), ID, 1, 0, keccak256("k"), ALL)));
    }

    function test_publishKey_eip7702HolderAllowed() public {
        address delegated = makeAddr("delegated");
        vm.etch(delegated, abi.encodePacked(hex"ef0100", address(0x1234)));
        circuits.setOwner(ID, delegated);
        vm.prank(delegated, delegated);
        hub.publishKey(address(circuits), ID, 1, 0, keccak256("k"), ALL);
        assertTrue(hub.keyFor(address(circuits), ID).usable);

        vm.etch(delegated, abi.encodePacked(hex"ef0200", address(0x1234)));
        assertFalse(hub.keyFor(address(circuits), ID).usable);
    }

    function test_publishKey_relayedEip7702Allowed() public {
        address delegated = makeAddr("delegated7702");
        address relayer = makeAddr("relayer");
        vm.etch(delegated, abi.encodePacked(hex"ef0100", address(0x1234)));
        circuits.setOwner(ID, delegated);
        vm.prank(delegated, relayer);
        hub.publishKey(address(circuits), ID, 1, 0, keccak256("sponsored"), ALL);
        DeWebHub.KeyView memory v = hub.keyFor(address(circuits), ID);
        assertEq(v.key, keccak256("sponsored"));
        assertTrue(v.usable);
        assertEq(hub.keyOf(container).holder, delegated);
    }

    function test_keyFor_registeredButWrongCodehashUnusable() public {
        vm.prank(alice, alice);
        hub.publishKey(address(circuits), ID, 1, 0, keccak256("k"), ALL);
        DeWebHub other =
            _hub(address(registry), address(factory), address(payments), address(beacon), circuitImpl, keccak256("other code"));
        vm.prank(alice, alice);
        vm.expectRevert(DeWebHub.NotCPU.selector);
        other.publishKey(address(circuits), ID, 1, 0, keccak256("k"), ALL);
        assertFalse(other.keyFor(address(circuits), ID).usable);
    }

    function test_keyFor_staleAfterTransfer() public {
        vm.prank(alice, alice);
        hub.publishKey(address(circuits), ID, 1, 0, keccak256("alice"), ALL);
        circuits.setOwner(ID, bob);
        DeWebHub.KeyView memory v = hub.keyFor(address(circuits), ID);
        assertEq(v.current, bob);
        assertFalse(v.usable, "previous holder's key must not be usable");

        vm.prank(bob, bob);
        hub.publishKey(address(circuits), ID, 1, 0, keccak256("bob"), ALL);
        v = hub.keyFor(address(circuits), ID);
        assertTrue(v.usable);
        assertEq(v.key, keccak256("bob"));
        assertEq(v.version, 2);

        circuits.setOwner(ID, alice);
        assertFalse(hub.keyFor(address(circuits), ID).usable);
    }

    function test_keyFor_unusableWhenCircuitsChangedOrUnregistered() public {
        vm.prank(alice, alice);
        hub.publishKey(address(circuits), ID, 1, 0, keccak256("k"), ALL);
        beacon.upgradeTo(address(0xE7E7));
        assertFalse(hub.keyFor(address(circuits), ID).usable, "circuits implementation changed");
        beacon.upgradeTo(circuitImpl);
        factory.set(address(circuits), false);
        assertFalse(hub.keyFor(address(circuits), ID).usable, "not a registered processor");
    }

    function test_keyFor_unusableWhenHolderBecameContract() public {
        vm.prank(alice, alice);
        hub.publishKey(address(circuits), ID, 1, 0, keccak256("k"), ALL);
        vm.etch(alice, hex"6001600155");
        assertFalse(hub.keyFor(address(circuits), ID).usable);
    }

    function test_keyFor_noKeyAndUnopened() public view {
        DeWebHub.KeyView memory v = hub.keyFor(address(circuits), 777);
        assertEq(v.container, hub.accountOf(address(circuits), 777));
        assertEq(v.endpoint, _ep(v.container));
        assertFalse(v.opened);
        assertEq(v.current, address(0));
        assertEq(v.suite, 0);
        assertEq(v.keyIndex, 0);
        assertEq(v.key, bytes32(0));
        assertFalse(v.usable);
        assertEq(v.version, 0);
        assertEq(v.chains, 0);
    }

    function test_keyFor_chainsHiddenWhenUnusable() public {
        vm.prank(alice, alice);
        hub.publishKey(address(circuits), ID, 1, 0, keccak256("k"), 0x6);
        assertEq(hub.keyFor(address(circuits), ID).chains, 0x6);
        circuits.setOwner(ID, bob);
        DeWebHub.KeyView memory v = hub.keyFor(address(circuits), ID);
        assertFalse(v.usable);
        assertEq(v.chains, 0, "a previous holder's chain choice must not be reused");
        assertEq(hub.keyOf(container).chains, 0x6, "raw record keeps it");
    }

    function test_timestampPastYear2106() public {
        vm.warp(uint256(type(uint32).max) + 5);
        vm.roll(uint256(type(uint32).max) + 7);
        vm.prank(alice);
        hub.send(address(circuits), ID, _ep(bob), 0, hex"01");
        DeWebHub.Entry memory e = hub.inboxAt(_ep(bob), 0);
        assertEq(e.timestamp, uint256(type(uint32).max) + 5, "no truncation");
        assertEq(e.blockNumber, uint256(type(uint32).max) + 7);
    }

    function test_keyFor_openedDoesNotAffectUsable() public {
        vm.prank(alice, alice);
        hub.publishKey(address(circuits), ID, 1, 0, keccak256("k"), ALL);
        payments.set(container, false);
        DeWebHub.KeyView memory v = hub.keyFor(address(circuits), ID);
        assertFalse(v.opened);
        assertTrue(v.usable);
    }

    function test_revokeKey() public {
        vm.warp(1_800_000_000);
        vm.prank(alice, alice);
        hub.publishKey(address(circuits), ID, 1, 4, keccak256("k"), 7);
        vm.warp(1_800_000_500);
        vm.expectEmit(true, true, true, true, address(hub));
        emit KeyRevoked(container, alice, 2);
        vm.prank(alice);
        hub.revokeKey(address(circuits), ID);
        DeWebHub.KeyRecord memory r = hub.keyOf(container);
        assertEq(r.suite, 0);
        assertEq(r.keyIndex, 0);
        assertEq(r.key, bytes32(0));
        assertEq(r.holder, address(0));
        assertEq(r.publishedAt, 1_800_000_500);
        assertEq(r.version, 2);
        assertEq(r.chains, 0);
        assertFalse(hub.keyFor(address(circuits), ID).usable);

        vm.prank(alice);
        vm.expectRevert(DeWebHub.NoKey.selector);
        hub.revokeKey(address(circuits), ID);
    }

    function test_revokeKey_onlyCurrentHolder() public {
        vm.prank(alice, alice);
        hub.publishKey(address(circuits), ID, 1, 0, keccak256("k"), ALL);
        circuits.setOwner(ID, bob);
        vm.prank(alice);
        vm.expectRevert(DeWebHub.NotHolder.selector);
        hub.revokeKey(address(circuits), ID);
        vm.prank(bob);
        hub.revokeKey(address(circuits), ID);
    }

    function test_publishKey_fromConstructorRejected() public {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        circuits.setOwner(ID, predicted);
        vm.expectRevert(DeWebHub.ContractHolder.selector);
        new ConstructorPublisher(hub, address(circuits), ID);
    }

    function test_keyCapable_prefixAndSizeVariants() public {
        address h = makeAddr("h");
        circuits.setOwner(ID, h);
        vm.prank(h, h);
        hub.publishKey(address(circuits), ID, 1, 0, keccak256("k"), ALL);
        bytes[4] memory codes = [
            abi.encodePacked(hex"ee0100", address(0x1234)),
            abi.encodePacked(hex"000100", address(0x1234)),
            bytes(hex"00"),
            bytes(hex"6001")
        ];
        for (uint256 i = 0; i < codes.length; i++) {
            vm.etch(h, codes[i]);
            assertFalse(hub.keyFor(address(circuits), ID).usable, "not a plain account");
            vm.prank(h, h);
            vm.expectRevert(DeWebHub.ContractHolder.selector);
            hub.publishKey(address(circuits), ID, 1, 0, keccak256("k2"), ALL);
        }
    }

    function test_revertOrder_inputChecksBeforeAuthorization() public {
        address stranger = makeAddr("stranger");
        vm.prank(stranger, stranger);
        vm.expectRevert(DeWebHub.BadEndpoint.selector);
        hub.send(address(circuits), ID, bytes32(0), 0, hex"01");
        vm.prank(stranger, stranger);
        vm.expectRevert(DeWebHub.EmptyPayload.selector);
        hub.send(address(circuits), ID, _ep(bob), 0, "");
        vm.prank(stranger, stranger);
        vm.expectRevert(DeWebHub.BadSuite.selector);
        hub.publishKey(address(circuits), ID, 2, 0, keccak256("k"), ALL);
        vm.prank(stranger, stranger);
        vm.expectRevert(DeWebHub.EmptyKey.selector);
        hub.publishKey(address(circuits), ID, 1, 0, bytes32(0), ALL);
        vm.prank(stranger, stranger);
        vm.expectRevert(DeWebHub.NoChains.selector);
        hub.publishKey(address(circuits), ID, 1, 0, keccak256("k"), 0);
        SmartWallet w = new SmartWallet();
        vm.expectRevert(DeWebHub.NotHolder.selector);
        w.call(address(hub), abi.encodeCall(DeWebHub.publishKey, (address(circuits), ID, 1, 0, keccak256("k"), ALL)));
        vm.prank(stranger);
        vm.expectRevert(DeWebHub.NotHolder.selector);
        hub.revokeKey(address(circuits), ID);
    }

    function test_registryReturningZero_reverts() public {
        ZeroRegistry z = new ZeroRegistry();
        DeWebHub h = _hub(address(z), address(factory), address(payments), address(beacon), circuitImpl, address(circuits).codehash);
        vm.expectRevert(DeWebHub.RegistryFailed.selector);
        h.accountOf(address(circuits), ID);
        vm.expectRevert(DeWebHub.RegistryFailed.selector);
        h.keyFor(address(circuits), ID);
        vm.prank(alice);
        vm.expectRevert(DeWebHub.RegistryFailed.selector);
        h.send(address(circuits), ID, _ep(bob), 0, hex"01");
    }

    // ---------------------------------------------------------------- 外部读的防御

    function test_weirdFactory_failsClosed() public {
        Weird w = new Weird();
        DeWebHub h = _hub(address(registry), address(w), address(payments), address(beacon), circuitImpl, address(circuits).codehash);
        payments.set(h.accountOf(address(circuits), ID), true);
        for (uint256 m = 0; m <= 6; m++) {
            if (m == 3) continue;
            w.setMode(m);
            vm.prank(alice);
            vm.expectRevert(DeWebHub.NotCPU.selector);
            h.send(address(circuits), ID, _ep(bob), 0, hex"01");
        }
    }

    function test_weirdFactory_gasBomb_failsClosedWithinBudget() public {
        Weird w = new Weird();
        w.setMode(3);
        DeWebHub h = _hub(address(registry), address(w), address(payments), address(beacon), circuitImpl, address(circuits).codehash);
        vm.prank(alice);
        vm.expectRevert(DeWebHub.NotCPU.selector);
        h.send{gas: 600_000}(address(circuits), ID, _ep(bob), 0, hex"01");
    }

    function test_returnDataBomb_isNotCopied() public {
        Weird w = new Weird();
        w.setMode(2);
        DeWebHub h = _hub(address(registry), address(w), address(payments), address(beacon), circuitImpl, address(circuits).codehash);
        uint256 before = gasleft();
        vm.prank(alice);
        try h.send(address(circuits), ID, _ep(bob), 0, hex"01") {
            fail();
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), DeWebHub.NotCPU.selector);
        }
        assertLt(before - gasleft(), 400_000, "1 MB return data must not be copied into memory");
    }

    function test_weirdCircuits_failsClosed() public {
        Weird w = new Weird();
        factory.set(address(w), true);
        DeWebHub h = _hub(address(registry), address(factory), address(payments), address(beacon), circuitImpl, address(w).codehash);
        payments.set(h.accountOf(address(w), ID), true);
        for (uint256 m = 0; m <= 6; m++) {
            if (m == 3) continue;
            w.setMode(m);
            vm.prank(alice);
            vm.expectRevert(DeWebHub.NotHolder.selector);
            h.send(address(w), ID, _ep(bob), 0, hex"01");
        }
    }

    function test_weirdPayments_failsClosed() public {
        Weird w = new Weird();
        DeWebHub h = _hub(address(registry), address(factory), address(w), address(beacon), circuitImpl, address(circuits).codehash);
        for (uint256 m = 0; m <= 6; m++) {
            if (m == 3) continue;
            w.setMode(m);
            vm.prank(alice);
            vm.expectRevert(DeWebHub.NotOpened.selector);
            h.send(address(circuits), ID, _ep(bob), 0, hex"01");
        }
    }

    function test_weirdBeacon_failsClosed() public {
        Weird w = new Weird();
        DeWebHub h = _hub(address(registry), address(factory), address(payments), address(w), circuitImpl, address(circuits).codehash);
        for (uint256 m = 0; m <= 6; m++) {
            if (m == 3) continue;
            w.setMode(m);
            vm.prank(alice);
            vm.expectRevert(DeWebHub.CircuitsChanged.selector);
            h.send(address(circuits), ID, _ep(bob), 0, hex"01");
        }
    }

    function test_weirdRegistry_reverts() public {
        Weird w = new Weird();
        DeWebHub h = _hub(address(w), address(factory), address(payments), address(beacon), circuitImpl, address(circuits).codehash);
        w.setMode(0);
        vm.prank(alice);
        vm.expectRevert(DeWebHub.RegistryFailed.selector);
        h.send(address(circuits), ID, _ep(bob), 0, hex"01");
        w.setMode(5);
        vm.prank(alice);
        vm.expectRevert(DeWebHub.RegistryFailed.selector);
        h.send(address(circuits), ID, _ep(bob), 0, hex"01");
    }

    function test_codelessCircuits_notCPU() public {
        address codeless = makeAddr("codeless");
        factory.set(codeless, true);
        vm.prank(alice);
        vm.expectRevert(DeWebHub.NotCPU.selector);
        hub.send(codeless, ID, _ep(bob), 0, hex"01");
    }

    // ---------------------------------------------------------------- gas

    function test_gas_send() public {
        bytes memory payload = new bytes(1000);
        bytes32 to = _ep(bobContainer);
        vm.prank(alice);
        uint256 g = gasleft();
        hub.send(address(circuits), ID, to, 0, payload);
        emit log_named_uint("send 1KB, first message to this recipient (execution only)", g - gasleft());
        vm.prank(alice);
        g = gasleft();
        hub.send(address(circuits), ID, to, 0, payload);
        emit log_named_uint("send 1KB, later message (execution only)", g - gasleft());
    }
}
