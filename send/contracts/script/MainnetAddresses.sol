// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice BNB Smart Chain 主网（chainId 56）上 TapeSendHub 依赖的合约，2026-09-17 只读核实（处理器数 896）。
library MainnetAddresses {
    /// ERC-6551 注册表（公开、不可升级）
    address internal constant REGISTRY = 0x000000006551c19487814612e58FE06813775758;
    /// 电路容器实现（CircuitAccountOpener.implementation）
    address internal constant IMPLEMENTATION = 0xAf4E78a2257C9c5480c2F8310E3b00437260751d;
    /// TapeOut 处理器工厂（UUPS 代理）
    address internal constant FACTORY = 0x68224F668083c29e9800Be2a646d42d18cedF7e2;
    /// 容器付费表（无 owner、不可升级）
    address internal constant PAYMENTS = 0xc0C643eb9820eF208Ea38bb2c8E8377047D9fa4c;
    /// 所有处理器合约共用的 beacon（地址写在代理字节码里）
    address internal constant CIRCUIT_BEACON = 0xf8D6d8EB894d6971c8976Ad8b4971cbEFE028156;
    /// 部署时钉住的电路合约实现（beacon.implementation()）
    address internal constant CIRCUIT_IMPLEMENTATION = 0x8E1D125Def6d3826C278299273a0760D47626068;
    /// 处理器代理合约的运行时代码哈希（896 个处理器相同）
    bytes32 internal constant CIRCUIT_CODEHASH = 0xd8c4b0216e0aadd615fbd134465b6af060a11769edc7c844d8f14d1b8a783992;
    /// 工厂 owner（只在测试里用来模拟"升级电路合约"）
    address internal constant FACTORY_OWNER = 0x571d447f4f24688eC35Ccf07f1D6993655F6aF15;
    /// 容器开通器（只在测试里用来交叉核对）
    address internal constant OPENER = 0x021745DE2f42A7839d96f2d3634d0294487D81F1;
    /// 容器协议费收款钱包（只在测试里用来证明发消息不收费）
    address internal constant TREASURY = 0xE2f77062c6060503e0289c6638D1B0A7C76cBB9d;
    /// Arachnid 确定性部署器（CREATE2），BSC 主网已存在
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
}
