// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Base（chainId 8453）与 X Layer（chainId 196）上 DeWebHub 依赖的 TapeOut 合约。
/// 两条链由同一部署者按同样的 nonce 顺序部署，地址完全相同；2026-09-19 只读核对 66 项通过。
library L2Addresses {
    address internal constant REGISTRY = 0x000000006551c19487814612e58FE06813775758;
    /// 电路容器实现（AccountBeaconProxy，开通器 implementation）
    address internal constant IMPLEMENTATION = 0xAC4F791353eE9F06e2C50Ae4C34680D28Ea52a57;
    address internal constant FACTORY = 0x1f09DAeFA827f02CBb40967cc91b259763760761;
    address internal constant PAYMENTS = 0x13b8AFa4Fd1b29B09D23A57A75ba8D3078d44858;
    address internal constant CIRCUIT_BEACON = 0xf70d1ed4f62CF3780157B0b421b7E2F45bD0991C;
    address internal constant CIRCUIT_IMPLEMENTATION = 0x977f217887E085D298Cb3819cDAD5A0ee35F29B2;
    /// 处理器代理运行时代码哈希：在两条链的主网分叉上用本链工厂真实创建处理器实测（二层工厂另行编译，代码末尾的编译器元数据与 BNB 不同，不能由 BNB 处理器代码推算）
    bytes32 internal constant CIRCUIT_CODEHASH = 0x57aa306fd0be97087da3534e03398f5ff4efd533b5be4e45a405ce86fa6717d5;
    address internal constant OPENER = 0x536adD8F30f03b69f6fbF29d425A816A0dC50106;
}
