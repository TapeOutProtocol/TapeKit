// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {Test} from "forge-std/Test.sol";
import {DeWebHub} from "../src/DeWebHub.sol";
import {MainnetAddresses as M} from "../script/MainnetAddresses.sol";

/// 审计：主网 v2 → 当前源码 v3 升级后，v2 期间写下的全部信箱条目、发件目录、公钥记录逐字不变
contract ForkUpgradeStorage is Test {
    DeWebHub constant HUB = DeWebHub(0xe61A9C7213a6Aa616C246a2B569e555B417b25ee);
    function test_fork_v2EntriesSurviveUpgrade() public {
        if (block.chainid != 56) { vm.skip(true); return; }
        address circuits0 = 0x0000000000000000000000000000000000000000;
        (bool ok, bytes memory r) = M.FACTORY.staticcall(abi.encodeWithSignature("cpuAt(uint256)", 0));
        require(ok); circuits0 = abi.decode(r, (address));
        address c = HUB.accountOf(circuits0, 4246);
        bytes32 ep = HUB.endpointOf(c);
        uint256 n = HUB.inboxCount(ep);
        uint256 m = HUB.outboxCount(c);
        emit log_named_uint("v2 inboxCount(#4246@0)", n);
        emit log_named_uint("v2 outboxCount(#4246@0)", m);
        DeWebHub.Entry[] memory before = HUB.inboxPage(ep, 0, 200);
        DeWebHub.OutEntry[] memory obefore = HUB.outboxPage(c, 0, 200);
        DeWebHub.KeyView memory kb = HUB.keyFor(circuits0, 4246);
        DeWebHub.KeyRecord memory rb = HUB.keyOf(c);
        DeWebHub v3 = new DeWebHub(56, M.REGISTRY, M.IMPLEMENTATION, M.FACTORY, M.PAYMENTS, M.CIRCUIT_BEACON, M.CIRCUIT_IMPLEMENTATION, M.CIRCUIT_CODEHASH);
        vm.prank(M.FACTORY_OWNER);
        HUB.upgradeToAndCall(address(v3), "");
        assertEq(HUB.selfAddress(), address(v3));
        assertEq(HUB.inboxCount(ep), n);
        assertEq(HUB.outboxCount(c), m);
        assertEq(keccak256(abi.encode(HUB.inboxPage(ep, 0, 200))), keccak256(abi.encode(before)));
        assertEq(keccak256(abi.encode(HUB.outboxPage(c, 0, 200))), keccak256(abi.encode(obefore)));
        assertEq(keccak256(abi.encode(HUB.keyFor(circuits0, 4246))), keccak256(abi.encode(kb)));
        assertEq(keccak256(abi.encode(HUB.keyOf(c))), keccak256(abi.encode(rb)));
    }
}
