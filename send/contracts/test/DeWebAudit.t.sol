// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeWebHub} from "../src/DeWebHub.sol";
import {DeWebAdmin} from "../src/DeWebAdmin.sol";
import {DeWebAdminBoot} from "../src/DeWebAdminBoot.sol";
import {DeWebBoot} from "../src/DeWebBoot.sol";
import {DeWebProxy} from "../src/DeWebProxy.sol";
import {MockFactory, MockBeacon, MockCircuits, MockPayments, MockRegistry} from "./Mocks.sol";

/// 与 MockCircuits 存储布局相同、字节码不同
contract MockCircuitsV2 is MockCircuits {
    function extra() external pure returns (uint256) {
        return 2;
    }
}

/// proxiableUUID 返回 64 字节，前 32 字节是正确的槽
contract LongUUID {
    function proxiableUUID() external pure returns (bytes32, uint256) {
        return (0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc, 0);
    }
}

contract NotUUPSImpl {}

// 升级检查的变异测试用：各自只在一个地方不合规，其余都"像"一个合法实现
bytes32 constant UUPS_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
/// selfAddress 合法，但没有 proxiableUUID
contract SelfOnlyImpl {
    function selfAddress() external view returns (address) { return address(this); }
}
/// selfAddress 合法，proxiableUUID 返回别的槽位
contract WrongUuidImpl {
    function selfAddress() external view returns (address) { return address(this); }
    function proxiableUUID() external pure returns (bytes32) { return bytes32(uint256(1)); }
}
/// proxiableUUID 返回 64 字节（前 32 字节是正确槽位）
contract LongUuidImpl {
    function selfAddress() external view returns (address) { return address(this); }
    function proxiableUUID() external pure returns (bytes32, bytes32) { return (UUPS_SLOT, bytes32(0)); }
}
/// selfAddress 返回 64 字节（前 32 字节是自己）
contract LongSelfImpl {
    function selfAddress() external view returns (address, address) { return (address(this), address(this)); }
    function proxiableUUID() external pure returns (bytes32) { return UUPS_SLOT; }
}
/// selfAddress 回滚，但回滚数据恰好是 32 字节的自己地址
contract RevertingSelfImpl {
    function selfAddress() external view returns (address) {
        address me = address(this);
        assembly { mstore(0, me) revert(0, 32) }
    }
    function proxiableUUID() external pure returns (bytes32) { return UUPS_SLOT; }
}

/// 用普通 call（不是 delegatecall）转发一切调用的合约：proxiableUUID 会原样转发回来，
/// 只有 selfAddress 的"等于自己"检查能拦住它
contract CallForwarder {
    address public immutable target;
    constructor(address t) { target = t; }
    fallback(bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        require(ok);
        return ret;
    }
}

/// @notice 变异测试审计（2026-09-18）补的测试：每一条都能杀死一个原本存活的变异。
contract DeWebAuditTest is Test {
    MockFactory factory;
    MockBeacon beacon;
    MockCircuits circuits;
    MockPayments payments;
    MockRegistry registry;
    address circuitImpl = address(0xC1);
    address accountImpl = address(0xA1);
    DeWebBoot boot;
    DeWebHub logic;
    DeWebHub hub;
    address owner = address(0x0117);
    address alice = makeAddr("alice");
    uint256 constant ID = 4246;
    bytes32 constant SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    event Upgraded(address indexed implementation);
    event OwnerChanged(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed pendingOwner);
    event HubSealed();

    function setUp() public {
        factory = new MockFactory();
        beacon = new MockBeacon(circuitImpl);
        circuits = new MockCircuits();
        payments = new MockPayments();
        registry = new MockRegistry();
        vm.etch(circuitImpl, hex"00");
        vm.etch(accountImpl, hex"00");
        boot = new DeWebBoot();
        hub = DeWebHub(address(new DeWebProxy(address(boot), abi.encodeCall(DeWebAdmin.initialize, (owner)))));
        logic = _logic();
        vm.prank(owner);
        hub.upgradeToAndCall(address(logic), "");
        factory.set(address(circuits), true);
        circuits.setOwner(ID, alice);
        payments.set(hub.accountOf(address(circuits), ID), true);
    }

    function _logic() internal returns (DeWebHub) {
        return new DeWebHub(
            block.chainid, address(registry), accountImpl, address(factory), address(payments), address(beacon), circuitImpl, address(circuits).codehash
        );
    }

    // ---- H40：keyFor 的 codehash 条件（现有 test_keyFor_registeredButWrongCodehashUnusable 名不符实）
    function test_keyFor_unusableWhenCircuitsCodeDiffers() public {
        vm.prank(alice, alice);
        hub.publishKey(address(circuits), ID, 1, 0, keccak256("k"), 1);
        assertTrue(hub.keyFor(address(circuits), ID).usable);
        // 同一地址换成另一份代码：存储保留（ownerOf 仍是 alice）、工厂登记仍在、beacon 未变
        vm.etch(address(circuits), address(new MockCircuitsV2()).code);
        assertTrue(address(circuits).codehash != hub.circuitCodehash());
        DeWebHub.KeyView memory v = hub.keyFor(address(circuits), ID);
        assertEq(v.current, alice, "only the codehash differs");
        assertFalse(v.usable, "codehash mismatch must make the key unusable");
    }

    // ---- H63 / H64 / H66：_keyCapable 必须是"恰好 23 字节且前缀 ef0100"
    function test_keyCapable_exactDesignatorOnly() public {
        // 只放 EVM 里真能存在的代码（0xef 开头的只有合法的 7702 委托标记能写进去，其余 Foundry 也拒绝写入）：
        // 逐个覆盖"长度对、前缀错"与"前缀对不上、长度不对"的分支，任何一个写不进去都算测试失败，不再悄悄跳过
        bytes[5] memory codes = [
            abi.encodePacked(hex"600100", address(0x1234)),          // 23 字节，前缀不是 ef0100
            abi.encodePacked(hex"60ef0100", address(0x1234)),        // 24 字节，里面夹着委托前缀
            abi.encodePacked(hex"6001", address(0x1234)),            // 22 字节
            bytes(hex"00"),                                           // 1 字节
            abi.encodePacked(hex"60", bytes22(0))                     // 23 字节，全零尾
        ];
        for (uint256 i = 0; i < codes.length; i++) {
            address h = address(uint160(0xD000 + i));
            circuits.setOwner(ID, h);
            vm.prank(h, h);
            hub.publishKey(address(circuits), ID, 1, 0, keccak256(abi.encode(i)), 1);
            vm.etch(h, codes[i]);
            assertFalse(hub.keyFor(address(circuits), ID).usable);
            vm.prank(h, h);
            vm.expectRevert(DeWebHub.ContractHolder.selector);
            hub.publishKey(address(circuits), ID, 1, 0, keccak256("again"), 1);
        }
    }

    function etchExt(address h, bytes memory c) external { vm.etch(h, c); }

    // ---- H70：链号 0 的构造检查
    function test_constructor_rejectsChainIdZero() public {
        vm.chainId(0);
        vm.expectRevert(DeWebHub.BadEndpoint.selector);
        new DeWebHub(0, address(registry), accountImpl, address(factory), address(payments), address(beacon), circuitImpl, address(circuits).codehash);
    }

    // ---- A05 / A04：零地址
    function test_transferOwnership_rejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(DeWebAdmin.ZeroAddress.selector);
        hub.transferOwnership(address(0));
    }

    function test_acceptOwnership_zeroSenderRejected() public {
        vm.prank(address(0));
        vm.expectRevert(DeWebAdmin.NotPendingOwner.selector);
        hub.acceptOwnership();
    }

    // ---- A08：UUID 返回长度必须恰好 32
    function test_upgradeRejectsLongUUID() public {
        LongUUID l = new LongUUID();
        vm.prank(owner);
        vm.expectRevert(DeWebAdmin.NotUUPS.selector);
        hub.upgradeToAndCall(address(l), "");
    }

    // ---- A18 / A19 / A20 / seal 的 OwnerChanged：事件
    function test_adminEvents() public {
        DeWebHub v2 = _logic();
        vm.expectEmit(true, true, true, true, address(hub));
        emit Upgraded(address(v2));
        vm.prank(owner);
        hub.upgradeToAndCall(address(v2), "");

        vm.expectEmit(true, true, true, true, address(hub));
        emit OwnershipTransferStarted(owner, alice);
        vm.prank(owner);
        hub.transferOwnership(alice);

        vm.expectEmit(true, true, true, true, address(hub));
        emit OwnerChanged(owner, alice);
        vm.prank(alice);
        hub.acceptOwnership();

        vm.expectEmit(true, true, true, true, address(hub));
        emit OwnerChanged(alice, address(0));
        vm.expectEmit(true, true, true, true, address(hub));
        emit HubSealed();
        vm.prank(alice);
        hub.seal();
    }

    // ---- A15 / A17：代理直接指向正式实现时，DeWebAdmin.initialize 这条路径
    function test_proxyDirectlyOnHub_initializeOnce() public {
        vm.expectRevert(DeWebAdmin.ZeroAddress.selector);
        new DeWebProxy(address(logic), abi.encodeCall(DeWebAdmin.initialize, (address(0))));
        DeWebHub direct = DeWebHub(address(new DeWebProxy(address(logic), abi.encodeCall(DeWebAdmin.initialize, (owner)))));
        assertEq(direct.owner(), owner);
        vm.expectRevert(DeWebAdmin.AlreadyInitialized.selector);
        direct.initialize(alice);
    }

    // ---- AB2 / AB6 / AB5：启动阶段的升级与转让
    function test_bootPhase_upgradeChecksAndTransfer() public {
        DeWebHub fresh = DeWebHub(address(new DeWebProxy(address(boot), abi.encodeCall(DeWebAdmin.initialize, (owner)))));
        NotUUPSImpl bad = new NotUUPSImpl();
        vm.startPrank(owner);
        vm.expectRevert(DeWebAdminBoot.NotUUPS.selector);
        fresh.upgradeToAndCall(address(bad), "");
        vm.expectRevert(DeWebAdminBoot.NotUUPS.selector);
        fresh.upgradeToAndCall(address(fresh), "");
        fresh.transferOwnership(alice);
        vm.stopPrank();
        vm.prank(alice);
        fresh.acceptOwnership();
        assertEq(fresh.owner(), alice);
        assertEq(fresh.pendingOwner(), address(0));
    }

    // ---- 新发现：升级目标是"仍在启动阶段的另一个代理"
    ///  DeWebAdminBoot.proxiableUUID 没有 NotDelegated 防护，经代理调用也返回正确的槽，
    ///  所以 test_upgradeRejectsAnotherProxy 的修复只挡住了"已升级到正式实现"的代理。
    function test_upgradeRejectsProxyStillInBootPhase() public {
        DeWebHub other = DeWebHub(address(new DeWebProxy(address(boot), abi.encodeCall(DeWebAdmin.initialize, (owner)))));
        vm.prank(owner);
        try hub.upgradeToAndCall(address(other), "") {
            // 如果升级成功，确认中枢是否已经砖掉
            (bool ok,) = address(hub).call(abi.encodeWithSignature("owner()"));
            assertTrue(ok, "hub bricked: upgraded to a boot-phase proxy");
            fail();
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), DeWebAdmin.NotUUPS.selector);
        }
    }

    function test_upgradeRejectsCallForwarder() public {
        // 变异测试发现：把 selfAddress 的等式检查去掉，其余测试照样全过。这条专门覆盖它
        CallForwarder fwd = new CallForwarder(address(logic));
        vm.prank(owner);
        vm.expectRevert(DeWebAdmin.NotUUPS.selector);
        hub.upgradeToAndCall(address(fwd), "");
        assertEq(address(uint160(uint256(vm.load(address(hub), 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc)))), address(logic));
    }

    function test_upgradeChecksEachStandOnTheirOwn() public {
        // 变异测试发现：两道检查（proxiableUUID、selfAddress）互相掩盖，单删其中一道测试照样全过。逐个只违反一处
        address[5] memory bad = [
            address(new SelfOnlyImpl()), address(new WrongUuidImpl()), address(new LongUuidImpl()),
            address(new LongSelfImpl()), address(new RevertingSelfImpl())
        ];
        for (uint256 i = 0; i < bad.length; i++) {
            vm.prank(owner);
            vm.expectRevert(DeWebAdmin.NotUUPS.selector);
            hub.upgradeToAndCall(bad[i], "");
        }
        assertEq(address(uint160(uint256(vm.load(address(hub), UUPS_SLOT)))), address(logic));
    }
}
