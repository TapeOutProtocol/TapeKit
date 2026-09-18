// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DeWebHub} from "../src/DeWebHub.sol";

contract MockFactory {
    mapping(address => bool) public isCPU;

    function set(address cpu, bool v) external {
        isCPU[cpu] = v;
    }
}

contract MockBeacon {
    address public implementation;

    constructor(address impl) {
        implementation = impl;
    }

    function upgradeTo(address impl) external {
        implementation = impl;
    }
}

contract MockCircuits {
    mapping(uint256 => address) internal _owner;
    uint256 public burn;

    function setOwner(uint256 id, address o) external {
        _owner[id] = o;
    }

    function setBurn(uint256 b) external {
        burn = b;
    }

    function ownerOf(uint256 id) external view returns (address) {
        // 模拟真实合约的读取开销，用来确认 READ_GAS 留够了余量
        uint256 x;
        for (uint256 i = 0; i < burn; i++) {
            x += i;
        }
        address o = _owner[id];
        require(o != address(0), "no such token");
        return o;
    }
}

contract MockPayments {
    mapping(address => bool) public paid;

    function set(address a, bool v) external {
        paid[a] = v;
    }
}

/// @dev 与 ERC-6551 v0.3 注册表同一套地址公式（真注册表的一致性由 fork 测试核对）。
contract MockRegistry {
    function account(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId)
        external
        view
        returns (address)
    {
        bytes memory code = abi.encodePacked(
            hex"3d60ad80600a3d3981f3363d3d373d3d3d363d73",
            implementation,
            hex"5af43d82803e903d91602b57fd5bf3",
            abi.encode(salt, chainId, tokenContract, tokenId)
        );
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(code))))));
    }
}

/// @dev 各种不守规矩的只读目标。
contract Weird {
    uint256 public mode;

    function setMode(uint256 m) external {
        mode = m;
    }

    fallback(bytes calldata) external returns (bytes memory) {
        uint256 m = mode;
        if (m == 0) revert("nope");
        if (m == 1) return abi.encode(true, true); // 64 字节
        if (m == 2) return new bytes(1_000_000); // 返回数据炸弹
        if (m == 3) {
            while (true) {} // 耗尽 gas
        }
        if (m == 4) return abi.encode(uint256(2)); // 非法 bool
        if (m == 5) return abi.encode(uint256(type(uint256).max)); // 高位非零的“地址”
        return "";
    }
}

/// @dev 用来当“合约持有人”
contract SmartWallet {
    function call(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }
}

/// @dev 构造函数里调用 publishKey（此时自己还没有代码）
contract ConstructorPublisher {
    constructor(DeWebHub hub, address circuits, uint256 id) {
        hub.publishKey(circuits, id, 1, 0, keccak256("from constructor"), 1);
    }
}

contract ZeroRegistry {
    function account(address, bytes32, uint256, address, uint256) external pure returns (address) {
        return address(0);
    }
}

