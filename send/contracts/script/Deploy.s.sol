// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {DeWebHub} from "../src/DeWebHub.sol";
import {DeWebAdmin} from "../src/DeWebAdmin.sol";
import {DeWebBoot} from "../src/DeWebBoot.sol";
import {DeWebProxy} from "../src/DeWebProxy.sol";
import {MainnetAddresses as M} from "./MainnetAddresses.sol";

/// @notice 只计算，不广播。打印 CREATE2 预测地址。真正的部署由持有人在浏览器钱包里签名（deploy-page.mjs）。
///
///   OWNER=0x... forge script script/Deploy.s.sol --fork-url bsc
///
/// 三步（每条链相同的前两步，保证中枢地址在所有链上一样）：
///   1. 启动实现 DeWebBoot：没有构造参数 → 各链地址相同
///   2. 代理 DeWebProxy(启动实现, initialize(owner)) → 各链地址相同（只取决于 owner）
///   3. 该链的正式实现 DeWebHub(本链 TapeOut 合约地址…)，然后 owner 调用 upgradeToAndCall 切过去
/// 没有部署 TapeOut 电路协议的链只能做前两步（占住同一个地址，暂时收发不了消息）。
contract Deploy is Script {
    bytes32 internal constant SALT_BOOT = keccak256("DeWEB Boot v1");
    bytes32 internal constant SALT_PROXY = keccak256("DeWEB Hub v1");
    bytes32 internal constant SALT_HUB_IMPL = keccak256("DeWEB Hub impl v2");

    function bootInitCode() public pure returns (bytes memory) {
        return type(DeWebBoot).creationCode;
    }

    function proxyInitCode(address owner) public pure returns (bytes memory) {
        return abi.encodePacked(
            type(DeWebProxy).creationCode, abi.encode(predictedBoot(), abi.encodeCall(DeWebAdmin.initialize, (owner)))
        );
    }

    /// @notice BNB Smart Chain 主网的正式实现。其他链在 TapeOut 电路协议部署之后再加。
    function bscHubInitCode() public pure returns (bytes memory) {
        return abi.encodePacked(
            type(DeWebHub).creationCode,
            abi.encode(
                uint256(56), M.REGISTRY, M.IMPLEMENTATION, M.FACTORY, M.PAYMENTS, M.CIRCUIT_BEACON, M.CIRCUIT_IMPLEMENTATION, M.CIRCUIT_CODEHASH
            )
        );
    }

    function _create2(bytes32 salt, bytes memory code) internal pure returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), M.CREATE2_DEPLOYER, salt, keccak256(code)))))
        );
    }

    function predictedBoot() public pure returns (address) {
        return _create2(SALT_BOOT, bootInitCode());
    }

    function predictedHub(address owner) public pure returns (address) {
        return _create2(SALT_PROXY, proxyInitCode(owner));
    }

    function predictedBscHubImpl() public pure returns (address) {
        return _create2(SALT_HUB_IMPL, bscHubInitCode());
    }

    function run() external view {
        address owner = vm.envOr("OWNER", address(0));
        console2.log("boot salt");
        console2.logBytes32(SALT_BOOT);
        console2.log("boot initCode keccak256");
        console2.logBytes32(keccak256(bootInitCode()));
        console2.log("predicted boot (same on every chain)", predictedBoot());
        console2.log("BSC hub implementation initCode keccak256");
        console2.logBytes32(keccak256(bscHubInitCode()));
        console2.log("predicted BSC hub implementation", predictedBscHubImpl());
        if (owner != address(0)) {
            console2.log("owner", owner);
            console2.log("proxy initCode keccak256");
            console2.logBytes32(keccak256(proxyInitCode(owner)));
            console2.log("predicted hub (same on every chain)", predictedHub(owner));
            console2.log("hub deployed on this chain", predictedHub(owner).code.length > 0);
        } else {
            console2.log("set OWNER=0x... to also compute the hub address");
        }
        require(M.CREATE2_DEPLOYER.code.length > 0, "CREATE2 deployer missing on this chain");
    }
}
