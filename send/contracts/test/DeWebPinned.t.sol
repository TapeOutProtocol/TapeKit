// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";

/// 客户端认可名单（send/module/src/chain.js 的 HUB_IMPLEMENTATIONS）里的地址必须等于当前源码算出的确定性地址：
/// 源码只要改一行，这条就会失败，提醒同时更新名单和部署页，名单不会悄悄失效。
contract DeWebPinnedTest is Test {
    function test_clientAllowListMatchesSource() public {
        Deploy d = new Deploy();
        assertEq(d.predictedBoot(), 0xC0D28CA8689248B0bed26cC0aa328CF16Aa4401e);
        assertEq(d.predictedHub(0x571d447f4f24688eC35Ccf07f1D6993655F6aF15), 0xe61A9C7213a6Aa616C246a2B569e555B417b25ee);
        assertEq(d.predictedBscHubImpl(), 0x80aFE7B77F2dFD08e9feab7675780baC34a7EE85);
    }
}
