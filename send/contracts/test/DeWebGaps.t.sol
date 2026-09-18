// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DeWebAuditTest, UUPS_SLOT} from "./DeWebAudit.t.sol";
import {DeWebHub} from "../src/DeWebHub.sol";
import {DeWebAdmin} from "../src/DeWebAdmin.sol";
import {DeWebProxy} from "../src/DeWebProxy.sol";

/// proxiableUUID 回滚，回滚数据恰好是 32 字节的正确槽位；selfAddress 合法
contract RevertingUuidImpl {
    function selfAddress() external view returns (address) { return address(this); }
    function proxiableUUID() external pure returns (bytes32) {
        assembly { mstore(0, 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc) revert(0, 32) }
    }
}

/// 测试充分性审计（2026-09-18，第 5 角色）补的测试：每条杀死一个存活变异
contract DeWebGapsTest is DeWebAuditTest {
    event KeyPublished(address indexed container, address indexed holder, uint8 suite, uint16 keyIndex, bytes32 key, uint32 version, uint64 chains);

    function _ep(uint256 chain, address a) internal pure returns (bytes32) {
        return bytes32((chain << 160) | uint256(uint160(a)));
    }

    // 杀 H-outboxPage-idx（outboxPage 用 k 代替 start + k）：客户端翻第二页时 start > 0
    function test_outboxPage_offsetReturnsTheRightEntries() public {
        address c = hub.accountOf(address(circuits), ID);
        vm.startPrank(alice);
        for (uint256 k = 0; k < 5; k++) hub.send(address(circuits), ID, _ep(56 + k, address(0xB0B)), bytes32(k), abi.encodePacked(uint8(k)));
        vm.stopPrank();
        DeWebHub.OutEntry[] memory p = hub.outboxPage(c, 3, 10);
        assertEq(p.length, 2);
        for (uint256 j = 0; j < 2; j++) {
            assertEq(p[j].to, _ep(59 + j, address(0xB0B)));
            assertEq(p[j].inboxIndex, 0);
            assertEq(p[j].digest, hub.digestOf(bytes32(3 + j), abi.encodePacked(uint8(3 + j))));
        }
    }

    // 杀 A-req-owner-or-pending：两步转让里"待接受"的地址在接受之前没有任何权限
    function test_pendingOwnerHasNoPowerBeforeAccepting() public {
        vm.prank(owner);
        hub.transferOwnership(alice);
        DeWebHub v2 = _logic();
        vm.startPrank(alice);
        vm.expectRevert(DeWebAdmin.NotOwner.selector);
        hub.upgradeToAndCall(address(v2), "");
        vm.expectRevert(DeWebAdmin.NotOwner.selector);
        hub.seal();
        vm.expectRevert(DeWebAdmin.NotOwner.selector);
        hub.transferOwnership(alice);
        vm.stopPrank();
        assertEq(hub.owner(), owner);
        assertFalse(hub.isSealed());
    }

    // 杀 A-up-uuidOk：proxiableUUID 回滚但回滚数据恰好是正确槽位
    function test_upgradeRejectsRevertingUuid() public {
        RevertingUuidImpl bad = new RevertingUuidImpl();
        vm.prank(owner);
        vm.expectRevert(DeWebAdmin.NotUUPS.selector);
        hub.upgradeToAndCall(address(bad), "");
    }

    // 杀 A-init-event：代理直接指向正式实现时，initialize 也要发 OwnerChanged(0, owner)
    function test_initializeEmitsOwnerChanged() public {
        vm.expectEmit(true, true, true, true);
        emit OwnerChanged(address(0), owner);
        new DeWebProxy(address(logic), abi.encodeCall(DeWebAdmin.initialize, (owner)));
    }

    // 杀 H-pub-event-origin：代付的 EIP-7702 发布，事件里的持有人是 7702 账户本身，不是代付人
    function test_relayedPublish_eventNamesHolderNotRelayer() public {
        address delegated = makeAddr("d7702");
        address relayer = makeAddr("relayer");
        vm.etch(delegated, abi.encodePacked(hex"ef0100", address(0x1234)));
        circuits.setOwner(ID, delegated);
        address c = hub.accountOf(address(circuits), ID);
        vm.expectEmit(true, true, true, true, address(hub));
        emit KeyPublished(c, delegated, 1, 2, keccak256("k"), 1, 1);
        vm.prank(delegated, relayer);
        hub.publishKey(address(circuits), ID, 1, 2, keccak256("k"), 1);
    }

    // 杀 H-ep-uint152：容器地址只有最高字节非 0 也是合法端点
    function test_endpoint_containerWithOnlyHighByte() public {
        bytes32 to = _ep(56, address(uint160(1) << 152));
        vm.prank(alice);
        hub.send(address(circuits), ID, to, 0, hex"01");
        assertEq(hub.inboxCount(to), 1);
    }

    // 杀 H-ctor-chainmax-ge：链号恰好 2^64-1 可以部署
    function test_constructor_acceptsMaxUint64ChainId() public {
        vm.chainId(type(uint64).max);
        DeWebHub h = new DeWebHub(
            type(uint64).max, address(registry), accountImpl, address(factory), address(payments), address(beacon), circuitImpl, address(circuits).codehash
        );
        assertEq(uint256(h.endpointOf(address(1))) >> 160, type(uint64).max);
    }

    // 数据与逻辑审计 L-1：电路换了主人（公钥不可用）时，keyFor 不再返回前任的公钥、套件、序号、收信链
    function test_keyFor_unusableReturnsNoStaleKey() public {
        vm.prank(alice, alice);
        hub.publishKey(address(circuits), ID, 1, 7, keccak256("old"), 3);
        DeWebHub.KeyView memory v = hub.keyFor(address(circuits), ID);
        assertTrue(v.usable);
        assertEq(v.key, keccak256("old"));
        uint32 ver = v.version;
        circuits.setOwner(ID, makeAddr("newHolder"));
        v = hub.keyFor(address(circuits), ID);
        assertFalse(v.usable);
        assertEq(v.key, bytes32(0));
        assertEq(v.suite, 0);
        assertEq(v.keyIndex, 0);
        assertEq(v.chains, 0);
        assertEq(v.version, ver); // 版本号照常返回：客户端用它判断记录变没变
    }
}
