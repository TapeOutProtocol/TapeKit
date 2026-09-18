// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeWebHub} from "../src/DeWebHub.sol";
import {DeWebAdmin} from "../src/DeWebAdmin.sol";
import {DeWebBoot} from "../src/DeWebBoot.sol";
import {DeWebProxy} from "../src/DeWebProxy.sol";
import {MockFactory, MockBeacon, MockCircuits, MockPayments, MockRegistry} from "./Mocks.sol";

/// @dev 第二版实现：多一个函数，用来确认升级后旧存储还在
contract HubV2 is DeWebHub {
    constructor(uint256 c, address r, address i, address f, address p, address b, address ci, bytes32 ch)
        DeWebHub(c, r, i, f, p, b, ci, ch)
    {}

    function version() external pure returns (string memory) {
        return "v2";
    }
}

contract NotAnImplementation {}

contract DeWebUpgradeTest is Test {
    MockFactory factory;
    MockBeacon beacon;
    MockCircuits circuits;
    MockPayments payments;
    MockRegistry registry;
    address circuitImpl = address(0xC1);
    address accountImpl = address(0xA1);

    DeWebBoot boot;
    DeWebHub logic;
    DeWebHub hub; // 代理
    address owner = address(0x0117);
    address holder = address(0xB0B);
    uint256 constant ID = 4246;
    bytes32 constant SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    function setUp() public {
        factory = new MockFactory();
        beacon = new MockBeacon(circuitImpl);
        circuits = new MockCircuits();
        payments = new MockPayments();
        registry = new MockRegistry();
        vm.etch(circuitImpl, hex"600160005260206000f3");
        vm.etch(accountImpl, hex"600160005260206000f3");

        boot = new DeWebBoot();
        hub = DeWebHub(address(new DeWebProxy(address(boot), abi.encodeCall(DeWebAdmin.initialize, (owner)))));
        logic = _logic();
        vm.prank(owner);
        DeWebAdmin(address(hub)).upgradeToAndCall(address(logic), "");

        factory.set(address(circuits), true);
        circuits.setOwner(ID, holder);
        payments.set(hub.accountOf(address(circuits), ID), true);
    }

    function _logic() internal returns (DeWebHub) {
        return new DeWebHub(block.chainid, 
            address(registry), accountImpl, address(factory), address(payments), address(beacon), circuitImpl, address(circuits).codehash
        );
    }

    function _implementationOf(address proxy) internal view returns (address) {
        return address(uint160(uint256(vm.load(proxy, SLOT))));
    }

    function _ep(address a) internal view returns (bytes32) {
        return bytes32((block.chainid << 160) | uint256(uint160(a)));
    }

    // ---------------------------------------------------------------- 启动阶段

    function test_bootPhase_onlyAdmin() public {
        DeWebHub fresh = DeWebHub(address(new DeWebProxy(address(boot), abi.encodeCall(DeWebAdmin.initialize, (owner)))));
        assertEq(fresh.owner(), owner);
        assertEq(_implementationOf(address(fresh)), address(boot));
        // 收发消息的函数在启动实现里不存在：必须回滚
        vm.prank(holder);
        vm.expectRevert();
        fresh.send(address(circuits), ID, _ep(holder), 0, hex"01");
        vm.expectRevert();
        fresh.inboxCount(_ep(holder));
        // 启动阶段不能封印
        vm.prank(owner);
        vm.expectRevert(DeWebBoot.NotReady.selector);
        fresh.seal();
        // 只有 owner 能升级到正式实现
        vm.prank(holder);
        vm.expectRevert(DeWebAdmin.NotOwner.selector);
        fresh.upgradeToAndCall(address(logic), "");
        vm.prank(owner);
        fresh.upgradeToAndCall(address(logic), "");
        assertEq(fresh.inboxCount(_ep(holder)), 0);
        assertEq(fresh.owner(), owner, "owner carried over from boot to hub");
    }

    function test_proxyAddressIndependentOfChainImplementation() public {
        // 代理的初始化代码只含启动实现地址和 owner —— 与各链不同的正式实现无关，所以各链代理地址相同
        bytes memory initA = abi.encodePacked(
            type(DeWebProxy).creationCode, abi.encode(address(boot), abi.encodeCall(DeWebAdmin.initialize, (owner)))
        );
        vm.chainId(8453);
        bytes memory initB = abi.encodePacked(
            type(DeWebProxy).creationCode, abi.encode(address(boot), abi.encodeCall(DeWebAdmin.initialize, (owner)))
        );
        assertEq(keccak256(initA), keccak256(initB));
        // 启动实现冻结：创建代码必须与 2026-09-18 部署到 BNB 主网的那份逐字节相同，
        // 否则以后在新链上算出的中枢地址就不再是 0xe61A…25ee
        assertEq(keccak256(type(DeWebBoot).creationCode), 0xed89cfaf4a27b4d60f50087a615d16d4e3e17176fc5dec7910eed3592ac2f51c, "DeWebBoot bytecode is frozen");
    }

    // ---------------------------------------------------------------- 初始化

    function test_proxySetsOwnerOnce() public view {
        assertEq(hub.owner(), owner);
        assertFalse(hub.isSealed());
        assertEq(_implementationOf(address(hub)), address(logic));
    }

    function test_cannotInitializeTwice() public {
        vm.expectRevert(DeWebAdmin.AlreadyInitialized.selector);
        hub.initialize(address(0xDEAD));
    }

    function test_implementationsCannotBeInitialized() public {
        vm.expectRevert(DeWebAdmin.AlreadyInitialized.selector);
        logic.initialize(address(0xDEAD));
        vm.expectRevert(DeWebAdmin.AlreadyInitialized.selector);
        boot.initialize(address(0xDEAD));
        assertEq(logic.owner(), address(0));
        assertEq(boot.owner(), address(0));
    }

    function test_proxyRejectsZeroOwner() public {
        vm.expectRevert(DeWebAdmin.ZeroAddress.selector);
        new DeWebProxy(address(boot), abi.encodeCall(DeWebAdmin.initialize, (address(0))));
    }

    function test_proxyRejectsNonContractImplementation() public {
        vm.expectRevert(DeWebProxy.NotAContract.selector);
        new DeWebProxy(address(0xBEEF), "");
    }

    // ---------------------------------------------------------------- 权限

    function test_onlyOwnerCanUpgrade() public {
        HubV2 v2 = _v2();
        vm.prank(holder);
        vm.expectRevert(DeWebAdmin.NotOwner.selector);
        hub.upgradeToAndCall(address(v2), "");
    }

    function test_onlyOwnerCanSealOrTransfer() public {
        vm.prank(holder);
        vm.expectRevert(DeWebAdmin.NotOwner.selector);
        hub.seal();
        vm.prank(holder);
        vm.expectRevert(DeWebAdmin.NotOwner.selector);
        hub.transferOwnership(holder);
    }

    function test_upgradeRejectsZeroAndEOA() public {
        vm.startPrank(owner);
        vm.expectRevert(DeWebAdmin.ZeroAddress.selector);
        hub.upgradeToAndCall(address(0), "");
        vm.expectRevert(DeWebAdmin.NotAContract.selector);
        hub.upgradeToAndCall(address(0xDEAD), "");
        vm.stopPrank();
    }

    function test_transferOwnershipIsTwoStep() public {
        vm.prank(owner);
        hub.transferOwnership(holder);
        assertEq(hub.owner(), owner, "owner unchanged until accepted");
        assertEq(hub.pendingOwner(), holder);

        vm.prank(address(0xDEAD));
        vm.expectRevert(DeWebAdmin.NotPendingOwner.selector);
        hub.acceptOwnership();

        vm.prank(holder);
        hub.acceptOwnership();
        assertEq(hub.owner(), holder);
        assertEq(hub.pendingOwner(), address(0));
        vm.prank(owner);
        vm.expectRevert(DeWebAdmin.NotOwner.selector);
        hub.seal();
    }

    function test_transferToWrongAddressDoesNotLockSeal() public {
        vm.prank(owner);
        hub.transferOwnership(address(0xBADBAD));
        vm.prank(owner);
        hub.seal();
        assertTrue(hub.isSealed());
        assertEq(hub.pendingOwner(), address(0), "pending cleared by seal");
        vm.prank(address(0xBADBAD));
        vm.expectRevert(DeWebAdmin.Sealed.selector);
        hub.acceptOwnership();
    }

    function test_upgradeRejectsNonUUPSImplementation() public {
        NotAnImplementation bad = new NotAnImplementation();
        vm.prank(owner);
        vm.expectRevert(DeWebAdmin.NotUUPS.selector);
        hub.upgradeToAndCall(address(bad), "");
        assertFalse(hub.isSealed());
        assertEq(hub.owner(), owner);
    }

    function test_upgradeRejectsProxyItself() public {
        vm.prank(owner);
        vm.expectRevert(DeWebAdmin.NotUUPS.selector);
        hub.upgradeToAndCall(address(hub), "");
    }

    function test_proxyRevertsWhenImplementationHasNoCode() public {
        vm.store(address(hub), SLOT, bytes32(0));
        (bool ok,) = address(hub).call(abi.encodeWithSignature("isSealed()"));
        assertFalse(ok, "call must revert, not silently succeed");
    }

    function test_proxiableUUID() public {
        assertEq(logic.proxiableUUID(), SLOT);
        assertEq(boot.proxiableUUID(), SLOT);
        // 经代理调用必须回滚：否则另一个代理也能冒充"合法实现"
        vm.expectRevert(DeWebAdmin.NotDelegated.selector);
        hub.proxiableUUID();
    }

    function test_selfAddressIsImplementationEvenThroughProxy() public view {
        // 直接调用和经代理调用都返回实现合约自己的地址（immutable），而不是 address(this)
        assertEq(DeWebAdmin(address(logic)).selfAddress(), address(logic));
        assertEq(DeWebAdmin(address(hub)).selfAddress(), address(logic));
        assertEq(DeWebAdmin(address(hub)).selfAddress(), _implementationOf(address(hub)));
    }

    function test_upgradeRejectsAnotherProxy() public {
        // 审计发现：升级到另一个代理会让两个代理互相转发、永久砖掉。现在必须在检查阶段就被拒绝
        DeWebHub other = DeWebHub(address(new DeWebProxy(address(boot), abi.encodeCall(DeWebAdmin.initialize, (owner)))));
        vm.prank(owner);
        other.upgradeToAndCall(address(logic), "");
        vm.prank(owner);
        vm.expectRevert(DeWebAdmin.NotUUPS.selector);
        hub.upgradeToAndCall(address(other), "");
        assertEq(hub.owner(), owner, "hub still works");
        assertEq(_implementationOf(address(hub)), address(logic));
    }

    function test_implementationCannotBeUsedDirectly() public {
        // 审计发现：直接调用实现合约会形成一个"影子中枢"。写函数必须只能经代理调用
        circuits.setOwner(ID, holder);
        payments.set(logic.accountOf(address(circuits), ID), true);
        vm.prank(holder, holder);
        vm.expectRevert(DeWebAdmin.NotProxy.selector);
        logic.publishKey(address(circuits), ID, 1, 0, keccak256("k"), 1);
        vm.prank(holder);
        vm.expectRevert(DeWebAdmin.NotProxy.selector);
        logic.send(address(circuits), ID, _ep(address(0xCAFE)), bytes32(0), hex"01");
        vm.prank(holder);
        vm.expectRevert(DeWebAdmin.NotProxy.selector);
        logic.revokeKey(address(circuits), ID);
    }

    function test_constructorRejectsWrongChain() public {
        vm.expectRevert(DeWebHub.WrongChain.selector);
        new DeWebHub(
            block.chainid + 1, address(registry), accountImpl, address(factory), address(payments), address(beacon), circuitImpl, address(circuits).codehash
        );
    }

    // ---------------------------------------------------------------- 升级

    function test_upgradeKeepsStorage() public {
        vm.prank(holder, holder);
        hub.publishKey(address(circuits), ID, 1, 0, keccak256("key"), 1);
        vm.prank(holder);
        hub.send(address(circuits), ID, _ep(address(0xCAFE)), bytes32(0), hex"5453");
        address c = hub.accountOf(address(circuits), ID);
        DeWebHub.KeyRecord memory before = hub.keyOf(c);

        HubV2 v2 = _v2();
        vm.prank(owner);
        hub.upgradeToAndCall(address(v2), "");

        assertEq(_implementationOf(address(hub)), address(v2));
        assertEq(HubV2(address(hub)).version(), "v2");
        DeWebHub.KeyRecord memory afterUp = hub.keyOf(c);
        assertEq(afterUp.key, before.key);
        assertEq(afterUp.version, before.version);
        assertEq(afterUp.chains, before.chains);
        assertEq(hub.inboxCount(_ep(address(0xCAFE))), 1, "inbox kept");
        assertEq(hub.outboxCount(c), 1, "outbox kept");
        assertEq(hub.owner(), owner, "owner kept");
    }

    function test_upgradeWithCallRuns() public {
        HubV2 v2 = _v2();
        vm.prank(owner);
        vm.expectRevert(DeWebAdmin.AlreadyInitialized.selector);
        hub.upgradeToAndCall(address(v2), abi.encodeCall(DeWebAdmin.initialize, (holder)));
        assertEq(_implementationOf(address(hub)), address(logic), "implementation unchanged");
    }

    // ---------------------------------------------------------------- 封印

    function test_sealClosesUpgradeForever() public {
        HubV2 v2 = _v2();
        vm.prank(owner);
        hub.seal();
        assertTrue(hub.isSealed());
        assertEq(hub.owner(), address(0));

        vm.prank(owner);
        vm.expectRevert(DeWebAdmin.Sealed.selector);
        hub.upgradeToAndCall(address(v2), "");
        vm.prank(owner);
        vm.expectRevert(DeWebAdmin.Sealed.selector);
        hub.seal();
        vm.prank(owner);
        vm.expectRevert(DeWebAdmin.Sealed.selector);
        hub.transferOwnership(owner);
    }

    function test_sealedHubStillWorks() public {
        vm.prank(owner);
        hub.seal();
        vm.prank(holder, holder);
        hub.publishKey(address(circuits), ID, 1, 0, keccak256("key"), 1);
        assertTrue(hub.keyFor(address(circuits), ID).usable);
        vm.prank(holder);
        hub.send(address(circuits), ID, _ep(address(0xCAFE)), bytes32(0), hex"5453");
        assertEq(hub.inboxCount(_ep(address(0xCAFE))), 1);
    }

    // ---------------------------------------------------------------- 代理转发

    function test_proxyForwardsRevertData() public {
        vm.prank(holder);
        vm.expectRevert(DeWebHub.EmptyPayload.selector);
        hub.send(address(circuits), ID, _ep(address(0xCAFE)), bytes32(0), "");
    }

    function test_implementationStorageIsSeparate() public {
        vm.prank(holder, holder);
        hub.publishKey(address(circuits), ID, 1, 0, keccak256("key"), 1);
        address c = hub.accountOf(address(circuits), ID);
        assertEq(hub.keyOf(c).suite, 1);
        assertEq(logic.keyOf(c).suite, 0, "implementation storage untouched");
    }

    function _v2() internal returns (HubV2) {
        return new HubV2(
            block.chainid, address(registry), accountImpl, address(factory), address(payments), address(beacon), circuitImpl, address(circuits).codehash
        );
    }
}
