// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {DeWebHub} from "../src/DeWebHub.sol";
import {DeWebAdmin} from "../src/DeWebAdmin.sol";
import {MainnetAddresses as M} from "../script/MainnetAddresses.sol";
import {Deploy} from "../script/Deploy.s.sol";

interface IOpener {
    function accountOf(address circuits, uint256 tokenId) external view returns (address);
    function isOpened(address circuits, uint256 tokenId) external view returns (bool);
}

interface IFactory {
    function cpuAt(uint256 i) external view returns (address);
    function circuitBeacon() external view returns (address);
    function upgradeCircuits(address newImpl) external;
}

interface IERC721 {
    function ownerOf(uint256) external view returns (address);
}

interface IBeacon {
    function implementation() external view returns (address);
}

/// @dev 模拟恶意升级：ownerOf 对 hub 返回攻击者
contract EvilCircuits {
    address public immutable attacker;

    constructor(address a) {
        attacker = a;
    }

    function ownerOf(uint256) external view returns (address) {
        return attacker;
    }
}

/// @notice BSC 主网分叉：按部署页的三步经确定性部署器部署，然后用真实电路走完整流程。
///         运行：`forge test --match-contract Fork --fork-url bsc`。不带 --fork-url 时整组跳过。
contract DeWebHubForkTest is Test {
    address constant OWNER = 0x571d447f4f24688eC35Ccf07f1D6993655F6aF15;
    DeWebHub hub;
    Deploy d;
    address cpu0;
    address cpu30;

    function setUp() public {
        if (block.chainid != 56) {
            vm.skip(true);
            return;
        }
        d = new Deploy();
        // 主网上已经部署过的步骤跳过（2026-09-18 已部署启动实现、代理和第一版实现），没部署的按部署页的顺序补上
        if (d.predictedBoot().code.length == 0) {
            (bool ok1,) = M.CREATE2_DEPLOYER.call(abi.encodePacked(keccak256("DeWEB Boot v1"), d.bootInitCode()));
            require(ok1 && d.predictedBoot().code.length > 0, "boot");
        }
        if (d.predictedHub(OWNER).code.length == 0) {
            (bool ok2,) = M.CREATE2_DEPLOYER.call(abi.encodePacked(keccak256("DeWEB Hub v1"), d.proxyInitCode(OWNER)));
            require(ok2 && d.predictedHub(OWNER).code.length > 0, "proxy");
        }
        if (d.predictedBscHubImpl().code.length == 0) {
            (bool ok3,) = M.CREATE2_DEPLOYER.call(abi.encodePacked(keccak256("DeWEB Hub impl v2"), d.bscHubInitCode()));
            require(ok3 && d.predictedBscHubImpl().code.length > 0, "impl");
        }
        // 先算好地址：vm.prank 只作用于下一次外部调用，调用 d.predictedHub 会把它用掉
        address proxy = d.predictedHub(OWNER);
        address impl = d.predictedBscHubImpl();
        vm.prank(OWNER);
        DeWebAdmin(proxy).upgradeToAndCall(impl, "");

        hub = DeWebHub(proxy);
        cpu0 = IFactory(M.FACTORY).cpuAt(0);
        cpu30 = IFactory(M.FACTORY).cpuAt(30);
    }

    function _ep(uint256 chain, address a) internal pure returns (bytes32) {
        return bytes32((chain << 160) | uint256(uint160(a)));
    }

    function test_fork_deployedAsPredicted() public view {
        assertEq(hub.owner(), OWNER);
        assertFalse(hub.isSealed());
        assertEq(
            address(uint160(uint256(vm.load(address(hub), 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc)))),
            d.predictedBscHubImpl()
        );
        assertEq(hub.registry(), M.REGISTRY);
        assertEq(hub.accountImplementation(), M.IMPLEMENTATION);
        assertEq(hub.factory(), M.FACTORY);
        assertEq(hub.payments(), M.PAYMENTS);
        assertEq(hub.circuitBeacon(), M.CIRCUIT_BEACON);
        assertEq(hub.circuitImplementation(), M.CIRCUIT_IMPLEMENTATION);
        assertEq(hub.circuitCodehash(), M.CIRCUIT_CODEHASH);
        assertEq(IFactory(M.FACTORY).circuitBeacon(), M.CIRCUIT_BEACON);
        assertEq(IBeacon(M.CIRCUIT_BEACON).implementation(), M.CIRCUIT_IMPLEMENTATION);
        assertEq(cpu30.codehash, M.CIRCUIT_CODEHASH);
    }

    function test_fork_accountOfMatchesOpener() public view {
        uint256[5] memory ids = [uint256(1), 1006, 4246, 15324, 999_999];
        address[2] memory cpus = [cpu0, cpu30];
        for (uint256 c = 0; c < 2; c++) {
            for (uint256 i = 0; i < ids.length; i++) {
                assertEq(hub.accountOf(cpus[c], ids[i]), IOpener(M.OPENER).accountOf(cpus[c], ids[i]));
            }
        }
    }

    /// 用户的真实电路 15324 号（30 号处理器）：发布公钥、发给自己、发给 Base 上的端点，信箱读得出来
    function test_fork_realCircuit15324Flow() public {
        uint256 id = 15324;
        assertTrue(IOpener(M.OPENER).isOpened(cpu30, id), "#15324@30 is opened on mainnet");
        address holder = IERC721(cpu30).ownerOf(id);
        address container = IOpener(M.OPENER).accountOf(cpu30, id);
        bytes32 me = _ep(56, container);
        uint256 treasuryBefore = M.TREASURY.balance;

        vm.prank(holder, holder);
        hub.publishKey(cpu30, id, 1, 0, keccak256("fork key"), 0x7);
        DeWebHub.KeyView memory v = hub.keyFor(cpu30, id);
        assertEq(v.container, container);
        assertEq(v.endpoint, me);
        assertTrue(v.opened);
        assertEq(v.current, holder);
        assertTrue(v.usable);
        assertEq(v.chains, 0x7);

        bytes32 baseFriend = _ep(8453, address(0xBA5E));
        // 主网上这个信箱里已经有真实消息：按"发送前后的差值"断言
        uint256 inBefore = hub.inboxCount(me);
        uint256 outBefore = hub.outboxCount(container);
        uint256 friendBefore = hub.inboxCount(baseFriend);
        vm.startPrank(holder);
        hub.send(cpu30, id, me, bytes32(0), hex"5453010000");
        hub.send(cpu30, id, baseFriend, bytes32(uint256(1)), hex"5453010001");
        vm.stopPrank();

        assertEq(hub.inboxCount(me), inBefore + 1);
        DeWebHub.Entry memory e = hub.inboxAt(me, inBefore);
        assertEq(e.from, container);
        assertEq(e.blockNumber, block.number);
        assertEq(e.digest, hub.digestOf(bytes32(0), hex"5453010000"));
        assertEq(hub.inboxCount(baseFriend), friendBefore + 1);
        DeWebHub.OutEntry[] memory out = hub.outboxPage(container, outBefore, 10);
        assertEq(hub.outboxCount(container), outBefore + 2);
        assertEq(out.length, 2);
        assertEq(out[0].to, me);
        assertEq(out[1].to, baseFriend);
        assertEq(M.TREASURY.balance, treasuryBefore, "no protocol fee is taken");
    }

    function test_fork_circuitsUpgradeCannotImpersonate() public {
        uint256 id = 4246;
        address holder = IERC721(cpu0).ownerOf(id);
        vm.prank(holder, holder);
        hub.publishKey(cpu0, id, 1, 0, keccak256("real key"), 1);

        address attacker = makeAddr("attacker");
        EvilCircuits evil = new EvilCircuits(attacker);
        vm.prank(M.FACTORY_OWNER);
        IFactory(M.FACTORY).upgradeCircuits(address(evil));
        assertEq(IERC721(cpu0).ownerOf(id), attacker, "upgrade took effect on the fork");

        vm.prank(attacker);
        vm.expectRevert(DeWebHub.CircuitsChanged.selector);
        hub.send(cpu0, id, _ep(56, address(1)), bytes32(0), hex"01");
        vm.prank(attacker, attacker);
        vm.expectRevert(DeWebHub.CircuitsChanged.selector);
        hub.publishKey(cpu0, id, 1, 0, keccak256("attacker key"), 1);
        assertFalse(hub.keyFor(cpu0, id).usable);
    }

    function test_fork_strangerCannotSendAsContainer() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(DeWebHub.NotHolder.selector);
        hub.send(cpu30, 15324, _ep(56, address(1)), bytes32(0), hex"01");
    }

    function test_fork_unopenedCannotSend() public {
        uint256 id = 1;
        assertFalse(IOpener(M.OPENER).isOpened(cpu0, id));
        address holder = IERC721(cpu0).ownerOf(id);
        vm.prank(holder);
        vm.expectRevert(DeWebHub.NotOpened.selector);
        hub.send(cpu0, id, _ep(56, address(1)), bytes32(0), hex"01");
    }

    function test_fork_nonCPUContractRejected() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(DeWebHub.NotCPU.selector);
        hub.send(M.PAYMENTS, 1, _ep(56, address(1)), bytes32(0), hex"01");
    }

    function test_fork_containerHolderCannotPublishKey() public {
        address outerContainer = IOpener(M.OPENER).accountOf(cpu30, 1006);
        uint256 id = 4246;
        address holder = IERC721(cpu0).ownerOf(id);
        vm.prank(holder);
        (bool ok,) = cpu0.call(abi.encodeWithSignature("transferFrom(address,address,uint256)", holder, outerContainer, id));
        assertTrue(ok);
        vm.prank(outerContainer);
        vm.expectRevert(DeWebHub.ContractHolder.selector);
        hub.publishKey(cpu0, id, 1, 0, keccak256("k"), 1);
    }

    function test_fork_gasOnMainnet() public {
        uint256 id = 15324;
        address holder = IERC721(cpu30).ownerOf(id);
        address container = IOpener(M.OPENER).accountOf(cpu30, id);
        bytes memory payload = new bytes(1000);
        vm.startPrank(holder);
        uint256 g = gasleft();
        hub.send(cpu30, id, _ep(56, container), bytes32(0), payload);
        emit log_named_uint("mainnet fork: send 1KB, first to recipient (execution)", g - gasleft());
        g = gasleft();
        hub.send(cpu30, id, _ep(56, container), bytes32(0), payload);
        emit log_named_uint("mainnet fork: send 1KB, later (execution)", g - gasleft());
        vm.stopPrank();
    }
}
