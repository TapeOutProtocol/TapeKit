// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title DeWebAdmin —— DeWEB 中枢的升级与封印逻辑（UUPS）
/// @notice 启动实现（DeWebBoot）和正式实现（DeWebHub）共用这一套管理逻辑和同一块存储，
///         所以代理可以先指向启动实现、再升级到正式实现，管理权一路不变。
///
/// 封印（seal）之前，owner 可以升级实现——**控制 owner 的人可以改写身份核对逻辑**，客户端必须显示警告。
/// seal() 之后放弃 owner，升级路径永久关闭。
abstract contract DeWebAdmin {
    /// @custom:storage-location erc7201:deweb.admin.v1
    struct AdminStorage {
        address owner;         // 可升级期间的管理者；封印后为 0
        bool sealed_;          // true = 永久不可升级
        bool initialized;      // 代理只初始化一次；实现合约在构造时就置位，自身无法被初始化
        address pendingOwner;  // 两步转让：新地址必须自己来接受
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("deweb.admin.v1")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant ADMIN_STORAGE = 0x736671d3d7aa7b8c7f898557852b1cc8f6b8b590d42594c0a8eca138259d9100;
    /// @dev ERC-1967 实现槽
    bytes32 internal constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    error ZeroAddress();
    error NotAContract();
    error NotOwner();
    error Sealed();
    error AlreadyInitialized();
    error NotUUPS();
    error NotPendingOwner();
    error NotDelegated();
    error NotProxy();

    event Upgraded(address indexed implementation);
    event OwnerChanged(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed pendingOwner);
    event HubSealed();

    /// @dev 实现合约自己的地址：用来区分"经代理调用"和"直接调用实现"
    address internal immutable __self = address(this);

    constructor() {
        // 实现合约自身不可被初始化：只能作为代理背后的逻辑使用
        _admin().initialized = true;
    }

    /// @dev 只允许经代理调用（直接调用实现合约会写进实现自己的存储，形成一个"影子中枢"）
    function _onlyProxy() internal view {
        if (address(this) == __self) revert NotProxy();
    }

    function _admin() private pure returns (AdminStorage storage $) {
        bytes32 slot = ADMIN_STORAGE;
        assembly { $.slot := slot }
    }

    /// @notice 代理部署时调用一次，设定可升级期间的管理者。
    function initialize(address owner_) external {
        AdminStorage storage $ = _admin();
        if ($.initialized) revert AlreadyInitialized();
        if (owner_ == address(0)) revert ZeroAddress();
        $.initialized = true;
        $.owner = owner_;
        emit OwnerChanged(address(0), owner_);
    }

    /// @notice 可升级期间的管理者；封印后永远是 0。
    function owner() external view returns (address) {
        return _admin().owner;
    }

    /// @notice 是否已封印（true = 永久不可升级，且没有 owner）。
    function isSealed() external view returns (bool) {
        return _admin().sealed_;
    }

    /// @notice 待接受的新管理者（没有则为 0）。
    function pendingOwner() external view returns (address) {
        return _admin().pendingOwner;
    }

    /// @notice 发起管理权转让（两步）。新地址必须调用 acceptOwnership 才生效。
    function transferOwnership(address newOwner) external {
        AdminStorage storage $ = _requireOwner();
        if (newOwner == address(0)) revert ZeroAddress();
        $.pendingOwner = newOwner;
        emit OwnershipTransferStarted($.owner, newOwner);
    }

    /// @notice 接受管理权。只有 transferOwnership 指定的地址可以调用。
    function acceptOwnership() external {
        AdminStorage storage $ = _admin();
        if ($.sealed_) revert Sealed();
        if (msg.sender != $.pendingOwner || msg.sender == address(0)) revert NotPendingOwner();
        emit OwnerChanged($.owner, msg.sender);
        $.owner = msg.sender;
        $.pendingOwner = address(0);
    }

    /// @notice UUPS 标识：返回 ERC-1967 实现槽。升级时用它确认新实现也是本套逻辑。
    ///         经代理调用时回滚：否则另一个代理也能通过升级检查，升上去之后两个代理互相转发、合约永久砖掉。
    function proxiableUUID() external view returns (bytes32) {
        if (address(this) != __self) revert NotDelegated();
        return IMPLEMENTATION_SLOT;
    }

    /// @notice 实现合约自己的地址。升级时要求新实现返回的值恰好等于它自己的地址：
    ///         经代理转调（不管那个代理处在启动阶段还是已升级）都拿不到这个结果，于是代理不能被当成实现。
    function selfAddress() external view returns (address) {
        return __self;
    }

    /// @notice 永久关闭升级并放弃 owner。不可撤销。
    function seal() external virtual {
        _seal();
    }

    function _seal() internal {
        AdminStorage storage $ = _requireOwner();
        $.sealed_ = true;
        $.pendingOwner = address(0);
        emit OwnerChanged($.owner, address(0));
        $.owner = address(0);
        emit HubSealed();
    }

    /// @notice 升级实现（UUPS）。只有 owner、且未封印时可用。
    /// @param data 非空时在新实现上 delegatecall 一次（迁移用）
    function upgradeToAndCall(address newImplementation, bytes calldata data) external {
        _requireOwner();
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0) revert NotAContract();
        // 指向代理自己会形成无限 delegatecall，合约直接砖掉
        if (newImplementation == address(this)) revert NotUUPS();
        // 新实现必须也是本套 UUPS 逻辑：否则升上去之后连升级入口都没有了
        (bool uuidOk, bytes memory uuid) = newImplementation.staticcall(abi.encodeWithSelector(this.proxiableUUID.selector));
        if (!uuidOk || uuid.length != 32 || abi.decode(uuid, (bytes32)) != IMPLEMENTATION_SLOT) revert NotUUPS();
        // 仍在启动阶段的代理会把 proxiableUUID 转给冻结的启动实现（那里没有 NotDelegated 防护），所以还要这一道：
        // 新实现必须报出"我就是我自己"。启动实现没有这个函数，已升级的代理报出的是它背后实现的地址
        (bool selfOk, bytes memory self_) = newImplementation.staticcall(abi.encodeWithSelector(this.selfAddress.selector));
        if (!selfOk || self_.length != 32 || abi.decode(self_, (address)) != newImplementation) revert NotUUPS();
        assembly {
            sstore(IMPLEMENTATION_SLOT, newImplementation)
        }
        emit Upgraded(newImplementation);
        if (data.length != 0) {
            (bool ok, bytes memory ret) = newImplementation.delegatecall(data);
            if (!ok) {
                assembly { revert(add(ret, 0x20), mload(ret)) }
            }
        }
    }

    function _requireOwner() private view returns (AdminStorage storage $) {
        $ = _admin();
        if ($.sealed_) revert Sealed();
        if (msg.sender != $.owner) revert NotOwner();
    }
}
