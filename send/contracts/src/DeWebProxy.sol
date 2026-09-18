// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title DeWebProxy —— DeWEB 中枢的 ERC-1967 代理
/// @notice 只做两件事：把实现地址存在 ERC-1967 标准槽里、把所有调用 delegatecall 给实现。
///         升级与封印的权限逻辑全部在实现里（UUPS）；封印之后实现里的升级入口永久拒绝，代理就变成不可升级的合约。
contract DeWebProxy {
    /// @dev ERC-1967 实现槽：keccak256("eip1967.proxy.implementation") - 1
    bytes32 private constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    error ZeroAddress();
    error NotAContract();

    event Upgraded(address indexed implementation);

    /// @param implementation 第一版实现（各链都是同一个启动实现 DeWebBoot）
    /// @param data           部署时在实现上 delegatecall 的初始化数据（initialize(owner)）
    constructor(address implementation, bytes memory data) {
        if (implementation == address(0)) revert ZeroAddress();
        if (implementation.code.length == 0) revert NotAContract();
        assembly {
            sstore(IMPLEMENTATION_SLOT, implementation)
        }
        emit Upgraded(implementation);
        if (data.length != 0) {
            (bool ok, bytes memory ret) = implementation.delegatecall(data);
            if (!ok) {
                assembly { revert(add(ret, 0x20), mload(ret)) }
            }
        }
    }

    fallback() external payable {
        assembly {
            let impl := sload(IMPLEMENTATION_SLOT)
            // 实现槽为 0 或指向没有代码的地址时，delegatecall 会"静默成功"：宁可回滚，也不让调用方以为写成功了
            if iszero(extcodesize(impl)) { revert(0, 0) }
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}
