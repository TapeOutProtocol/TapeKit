// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DeWebAdminBoot} from "./DeWebAdminBoot.sol";

/// @title DeWebBoot —— DeWEB 中枢的启动实现
/// @notice 没有构造参数，所以经 CREATE2 在每条链上得到同一个地址；代理先指向它，
///         于是代理地址 = f(部署器, 盐, 启动实现, owner)，在所有链上相同。
///         之后 owner 把代理升级到该链的正式实现（DeWebHub，各链构造参数不同）。
///
///         启动阶段中枢只有管理函数，收发消息的调用一律回滚。
///         启动阶段不允许封印：否则这条链的中枢会永久停在"什么都做不了"的状态。
contract DeWebBoot is DeWebAdminBoot {
    error NotReady();

    function seal() external pure override {
        revert NotReady();
    }
}
