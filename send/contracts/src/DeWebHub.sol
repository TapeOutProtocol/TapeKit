// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DeWebAdmin} from "./DeWebAdmin.sol";

/// @title DeWebHub —— DeWEB 跨链消息层的中枢（每条链一份，地址相同）
/// @notice 电路容器之间收发消息。发消息、发布公钥都不收协议费，只花 gas。
///
/// 跨链怎么做到：
///   - 每个端点用 32 字节**端点号**表示：uint32(0) ‖ uint64(chainId) ‖ address(容器)，全网唯一；
///   - 发件人永远在**自己容器所在的链**上调用 send，本合约只在本链核对身份，不依赖任何别的链；
///   - 收件人可以在任何链上：`to` 是端点号，本合约把消息记进 `inbox[to]`；
///   - 收件人的客户端读各条链中枢的 inbox[自己]，合并成一个列表。没有跨链桥、没有索引器。
///
/// 链上信箱：每条消息在存储里记下（发件容器、区块号、时间、digest），digest = keccak256(ref ‖ keccak256(payload))。
///   列表用 eth_call 分页读取；打开消息时从任意节点取该区块的 Sent 日志，用 digest 核对载荷和 ref。
///   计数让客户端能确认"一条不漏"。
///
/// 身份怎么认（与 TAP-10 v0.5 相同）：调用者给出 (处理器合约, #ID)，合约在链上核对——
///   1. 电路合约的实现没有被换过（处理器 beacon 的实现 = 部署时钉住的实现）
///   2. 处理器合约是那个 beacon 的代理（代码哈希 = 钉住的代理代码哈希），且工厂登记过（factory.isCPU）
///   3. 调用者是这枚电路的当前持有人（ownerOf）
///   4. 这枚电路的容器已付费开通（payments.paid）
///
/// 刻意做到最小：不收也不持有任何资产、没有任何写外部状态的调用（只有 staticcall）；不解析消息内容。
/// 升级与封印见 DeWebAdmin。
contract DeWebHub is DeWebAdmin {
    /// @notice 单条消息载荷上限（字节）。
    uint256 public constant MAX_PAYLOAD = 16_000;
    /// @notice 目前唯一的公钥套件：X25519。
    uint8 public constant SUITE_X25519 = 1;
    /// @notice 分页读取一次最多返回的条数。
    uint256 public constant MAX_PAGE = 200;

    /// @dev ERC-6551 容器用的 salt，与开通器 CircuitAccountOpener.SALT 一致，永远是 0。
    bytes32 private constant SALT = bytes32(0);
    /// @dev 外部只读调用的 gas 上限，防止耗尽 gas；返回数据只复制 32 字节，防止返回数据炸弹。
    uint256 private constant READ_GAS = 100_000;
    /// @dev 每个信箱最多 2^32 - 1 条（序号在 outbox 里按 32 位打包）。
    uint256 private constant MAX_BOX = type(uint32).max;

    /// @notice ERC-6551 注册表（公开、不可升级）。
    address public immutable registry;
    /// @notice 电路容器（ERC-6551 账户）的实现地址，与开通器 implementation 一致。
    ///         不叫 implementation()：那个名字（EIP-897）按惯例表示代理背后的逻辑合约，容易被工具和人误读。
    address public immutable accountImplementation;
    /// @notice TapeOut 处理器工厂。
    address public immutable factory;
    /// @notice 容器付费表（无 owner、不可升级）。
    address public immutable payments;
    /// @notice 所有处理器合约共用的 beacon。
    address public immutable circuitBeacon;
    /// @notice 部署时钉住的电路合约实现。
    address public immutable circuitImplementation;
    /// @notice 处理器代理合约的运行时代码哈希（beacon 地址写在代理代码里，所以它同时钉住了 beacon）。
    bytes32 public immutable circuitCodehash;

    struct KeyRecord {
        bytes32 key;          // X25519 公钥（RFC 7748 编码，原样存放）
        address holder;       // 发布时的持有人；持有人一变，这把钥匙就不可用
        uint40 publishedAt;   // 最近一次发布或撤销的区块时间
        uint8 suite;          // 0 = 没有公钥（从未发布或已撤销）
        uint16 keyIndex;      // 这把钥匙的派生序号，换钥匙时加 1
        uint32 version;       // 每次发布或撤销加 1
        uint64 chains;        // 收信链位图：位 k = 规范链表第 k 条链；持有人声明自己读哪些链的消息
    }

    /// @notice 收件信箱里的一条。
    struct Entry {
        address from;         // 发件容器（本链）
        uint56 blockNumber;   // 消息所在区块
        uint40 timestamp;     // 区块时间
        bytes32 digest;       // keccak256(ref ‖ keccak256(payload))
    }

    /// @notice 发件目录里的一条（连同它在对方信箱里的记录一起返回）。
    struct OutEntry {
        bytes32 to;           // 收件端点号
        uint32 inboxIndex;    // 这条消息在本链 inbox[to] 里的序号
        uint56 blockNumber;
        uint40 timestamp;
        bytes32 digest;
    }

    /// @notice keyFor 的返回值。
    struct KeyView {
        address container;    // 容器地址
        bytes32 endpoint;     // 端点号
        bool opened;          // 容器是否已付费开通
        address current;      // 当前持有人（读不到为 0）
        uint8 suite;          // 公钥套件，0 = 没有公钥；usable 为 false 时为 0
        uint16 keyIndex;      // 公钥的派生序号；usable 为 false 时为 0
        bytes32 key;          // 公钥；usable 为 false 时为 0（不返回前任持有人的公钥）
        bool usable;          // 只有 true 才能加密给它
        uint32 version;       // 公钥记录版本
        uint64 chains;        // 收信链位图；usable 为 false 时为 0（不能沿用前任持有人的设置）
    }

    /// @custom:storage-location erc7201:deweb.hub.v1
    struct HubStorage {
        mapping(address container => KeyRecord) keys;
        mapping(bytes32 to => uint256) inboxCount;
        mapping(bytes32 to => mapping(uint256 => Entry)) inbox;
        mapping(address from => uint256) outboxCount;
        mapping(address from => mapping(uint256 => uint256)) outbox; // uint256(to) << 32 | inboxIndex
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("deweb.hub.v1")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant HUB_STORAGE = 0x52508d06499dccc2446f87bf89abfddc2d85f3e5a1bdd29ea2bc99cdfd6b2000;

    function _s() private pure returns (HubStorage storage $) {
        bytes32 slot = HUB_STORAGE;
        assembly { $.slot := slot }
    }

    event KeyPublished(
        address indexed container,
        address indexed holder,
        uint8 suite,
        uint16 keyIndex,
        bytes32 key,
        uint32 version,
        uint64 chains
    );
    event KeyRevoked(address indexed container, address indexed holder, uint32 version);
    /// @notice to 是收件端点号（任何链）；from 是本链发件容器。inboxIndex / outboxIndex 是它在两个信箱里的序号。
    event Sent(
        bytes32 indexed to, address indexed from, bytes32 indexed ref, uint256 inboxIndex, uint256 outboxIndex, bytes payload
    );

    error CircuitsChanged();
    error NotCPU();
    error NotHolder();
    error NotOpened();
    error ContractHolder();
    error EmptyPayload();
    error PayloadTooLarge(uint256 size, uint256 max);
    error BadSuite();
    error EmptyKey();
    error NoKey();
    error NoChains();
    error BadEndpoint();
    error BoxFull();
    error OutOfRange();
    error RegistryFailed();
    error WrongChain();

    /// @param expectedChainId 这份实现要部署到的链；构造时核对，防止把一条链的参数部署到另一条链上
    constructor(
        uint256 expectedChainId,
        address registry_,
        address implementation_,
        address factory_,
        address payments_,
        address circuitBeacon_,
        address circuitImplementation_,
        bytes32 circuitCodehash_
    ) {
        if (
            registry_ == address(0) || implementation_ == address(0) || factory_ == address(0) || payments_ == address(0)
                || circuitBeacon_ == address(0) || circuitImplementation_ == address(0) || circuitCodehash_ == bytes32(0)
        ) revert ZeroAddress();
        if (
            registry_.code.length == 0 || implementation_.code.length == 0 || factory_.code.length == 0
                || payments_.code.length == 0 || circuitBeacon_.code.length == 0 || circuitImplementation_.code.length == 0
        ) revert NotAContract();
        if (block.chainid != expectedChainId) revert WrongChain();
        // 端点号里链号占 8 字节
        if (block.chainid == 0 || block.chainid > type(uint64).max) revert BadEndpoint();
        registry = registry_;
        accountImplementation = implementation_;
        factory = factory_;
        payments = payments_;
        circuitBeacon = circuitBeacon_;
        circuitImplementation = circuitImplementation_;
        circuitCodehash = circuitCodehash_;
    }

    // ------------------------------------------------------------------ 写

    /// @notice 以 (circuits, tokenId) 的容器身份发一条消息。
    /// @param to      收件端点号：uint32(0) ‖ uint64(chainId) ‖ address(容器)。可以是任何链上的容器；合约只检查格式
    /// @param ref     引用的消息 ID（回复用），没有就填 0
    /// @param payload 载荷，合约不解析
    /// @return inboxIndex 这条消息在 inbox[to] 里的序号
    function send(address circuits, uint256 tokenId, bytes32 to, bytes32 ref, bytes calldata payload)
        external
        returns (uint256 inboxIndex)
    {
        _onlyProxy();
        _checkEndpoint(to);
        uint256 size = payload.length;
        if (size == 0) revert EmptyPayload();
        if (size > MAX_PAYLOAD) revert PayloadTooLarge(size, MAX_PAYLOAD);
        address from = _authorize(circuits, tokenId);

        HubStorage storage $ = _s();
        inboxIndex = $.inboxCount[to];
        uint256 outboxIndex = $.outboxCount[from];
        if (inboxIndex >= MAX_BOX || outboxIndex >= MAX_BOX) revert BoxFull();

        $.inbox[to][inboxIndex] = Entry({
            from: from,
            blockNumber: uint56(block.number),
            timestamp: uint40(block.timestamp),
            digest: keccak256(abi.encodePacked(ref, keccak256(payload)))
        });
        $.inboxCount[to] = inboxIndex + 1;
        // to 的高 32 位为 0（_checkEndpoint），左移 32 位不会溢出
        $.outbox[from][outboxIndex] = (uint256(to) << 32) | inboxIndex;
        $.outboxCount[from] = outboxIndex + 1;

        emit Sent(to, from, ref, inboxIndex, outboxIndex, payload);
    }

    /// @notice 发布（或替换）容器的加密公钥。持有人即调用者，必须是普通账户（EOA 或 EIP-7702 账户）。
    /// @param keyIndex 派生这把钥匙时用的序号，客户端据此知道该签哪一段文字
    /// @param chains   收信链位图（位 k = 规范链表第 k 条链），不能为 0
    function publishKey(address circuits, uint256 tokenId, uint8 suite, uint16 keyIndex, bytes32 key, uint64 chains)
        external
    {
        _onlyProxy();
        if (suite != SUITE_X25519) revert BadSuite();
        if (key == bytes32(0)) revert EmptyKey();
        if (chains == 0) revert NoChains();
        address container = _authorize(circuits, tokenId);
        // 合约钱包派生不出钥匙；而且持有人是合约时，合约换了控制人 ownerOf 也不变，旧钥匙会一直"可用"。
        // 没有代码却不是交易发起者的调用者，只可能是正在构造中的合约，同样拒绝。
        if (!_keyCapable(msg.sender) || (msg.sender.code.length == 0 && msg.sender != tx.origin)) revert ContractHolder();
        KeyRecord storage r = _s().keys[container];
        uint32 version = r.version + 1;
        r.key = key;
        r.holder = msg.sender;
        r.publishedAt = uint40(block.timestamp);
        r.suite = suite;
        r.keyIndex = keyIndex;
        r.version = version;
        r.chains = chains;
        emit KeyPublished(container, msg.sender, suite, keyIndex, key, version, chains);
    }

    /// @notice 撤销容器当前的公钥。只有当前持有人可以撤销。
    function revokeKey(address circuits, uint256 tokenId) external {
        _onlyProxy();
        address container = _authorize(circuits, tokenId);
        KeyRecord storage r = _s().keys[container];
        if (r.suite == 0) revert NoKey();
        uint32 version = r.version + 1;
        r.key = bytes32(0);
        r.holder = address(0);
        r.publishedAt = uint40(block.timestamp);
        r.suite = 0;
        r.keyIndex = 0;
        r.version = version;
        r.chains = 0;
        emit KeyRevoked(container, msg.sender, version);
    }

    // ------------------------------------------------------------------ 读：信箱

    /// @notice 本链上发给 to 的消息总数。
    function inboxCount(bytes32 to) external view returns (uint256) {
        return _s().inboxCount[to];
    }

    /// @notice inbox[to] 的第 i 条。
    function inboxAt(bytes32 to, uint256 i) external view returns (Entry memory) {
        HubStorage storage $ = _s();
        if (i >= $.inboxCount[to]) revert OutOfRange();
        return $.inbox[to][i];
    }

    /// @notice inbox[to] 从 start 起最多 n 条（按序号从旧到新；n 最多 MAX_PAGE）。start 超出范围时返回空。
    function inboxPage(bytes32 to, uint256 start, uint256 n) external view returns (Entry[] memory page) {
        HubStorage storage $ = _s();
        uint256 end = _pageEnd($.inboxCount[to], start, n);
        page = new Entry[](end > start ? end - start : 0);
        for (uint256 k = 0; k < page.length; k++) {
            page[k] = $.inbox[to][start + k];
        }
    }

    /// @notice 本链上 from 发出的消息总数。
    function outboxCount(address from) external view returns (uint256) {
        return _s().outboxCount[from];
    }

    /// @notice outbox[from] 从 start 起最多 n 条（按序号从旧到新；n 最多 MAX_PAGE）。
    function outboxPage(address from, uint256 start, uint256 n) external view returns (OutEntry[] memory page) {
        HubStorage storage $ = _s();
        uint256 end = _pageEnd($.outboxCount[from], start, n);
        page = new OutEntry[](end > start ? end - start : 0);
        for (uint256 k = 0; k < page.length; k++) {
            uint256 packed = $.outbox[from][start + k];
            bytes32 to = bytes32(packed >> 32);
            uint32 i = uint32(packed);
            Entry storage e = $.inbox[to][i];
            page[k] = OutEntry({to: to, inboxIndex: i, blockNumber: e.blockNumber, timestamp: e.timestamp, digest: e.digest});
        }
    }

    /// @notice 客户端核对载荷用的 digest。
    function digestOf(bytes32 ref, bytes calldata payload) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(ref, keccak256(payload)));
    }

    // ------------------------------------------------------------------ 读：端点与公钥

    /// @notice 本链上某个容器的端点号。
    function endpointOf(address container) public view returns (bytes32) {
        return bytes32((block.chainid << 160) | uint256(uint160(container)));
    }

    /// @notice (circuits, tokenId) 的容器地址。不检查 circuits 是否为处理器。
    function accountOf(address circuits, uint256 tokenId) external view returns (address) {
        return _accountOf(circuits, tokenId);
    }

    /// @notice 容器的原始公钥记录。**不检查持有人是否已变**，客户端必须改用 keyFor。
    function keyOf(address container) external view returns (KeyRecord memory) {
        return _s().keys[container];
    }

    /// @notice 一次读出发消息前需要的全部信息。只有 usable 为 true 才能加密给它：
    ///         电路合约未被替换、是登记过的处理器、公钥存在、发布者仍是当前持有人且是普通账户。
    function keyFor(address circuits, uint256 tokenId) external view returns (KeyView memory v) {
        v.container = _accountOf(circuits, tokenId);
        v.endpoint = endpointOf(v.container);
        v.opened = _readBool(payments, abi.encodeWithSelector(IPayments.paid.selector, v.container));
        v.current = _currentHolder(circuits, tokenId);
        KeyRecord storage r = _s().keys[v.container];
        v.version = r.version;
        v.usable = r.suite != 0 && v.current != address(0) && r.holder == v.current && _keyCapable(v.current)
            && _circuitsGenuine(circuits);
        // 不可用时公钥、套件、序号、收信链一律返回 0：不看 usable 的接入方也不会把消息加密给前任持有人
        if (v.usable) {
            v.suite = r.suite;
            v.keyIndex = r.keyIndex;
            v.key = r.key;
            v.chains = r.chains;
        }
    }

    // ------------------------------------------------------------------ 内部

    /// @dev 端点号格式：高 32 位为 0，链号非 0，容器地址非 0。
    function _checkEndpoint(bytes32 id) internal pure {
        uint256 v = uint256(id);
        if (v >> 224 != 0 || (v >> 160) == 0 || uint160(v) == 0) revert BadEndpoint();
    }

    function _pageEnd(uint256 count, uint256 start, uint256 n) private pure returns (uint256) {
        if (n > MAX_PAGE) n = MAX_PAGE;
        if (start >= count) return start;
        uint256 left = count - start;
        return start + (n < left ? n : left);
    }

    /// @dev 依次核对电路实现、处理器、持有人、开通状态，返回容器地址。任何一项读不通都当作不通过（fail-closed）。
    function _authorize(address circuits, uint256 tokenId) internal view returns (address container) {
        if (!_circuitsIntact()) revert CircuitsChanged();
        if (circuits.codehash != circuitCodehash) revert NotCPU();
        if (!_readBool(factory, abi.encodeWithSelector(IFactoryMin.isCPU.selector, circuits))) revert NotCPU();
        (bool ok, address o) = _readAddress(circuits, abi.encodeWithSelector(IERC721Min.ownerOf.selector, tokenId));
        if (!ok || o != msg.sender) revert NotHolder();
        container = _accountOf(circuits, tokenId);
        if (!_readBool(payments, abi.encodeWithSelector(IPayments.paid.selector, container))) revert NotOpened();
    }

    function _currentHolder(address circuits, uint256 tokenId) internal view returns (address) {
        (bool ok, address o) = _readAddress(circuits, abi.encodeWithSelector(IERC721Min.ownerOf.selector, tokenId));
        return ok ? o : address(0);
    }

    /// @dev 电路实现未被替换，且 circuits 是登记过的处理器代理。
    function _circuitsGenuine(address circuits) internal view returns (bool) {
        return _circuitsIntact() && circuits.codehash == circuitCodehash
            && _readBool(factory, abi.encodeWithSelector(IFactoryMin.isCPU.selector, circuits));
    }

    function _circuitsIntact() internal view returns (bool) {
        (bool ok, address impl) = _readAddress(circuitBeacon, abi.encodeWithSelector(IBeaconMin.implementation.selector));
        return ok && impl == circuitImplementation;
    }

    /// @dev 普通账户：没有代码，或只有 EIP-7702 委托标记（0xef0100 ‖ 20 字节地址，共 23 字节）。
    function _keyCapable(address a) internal view returns (bool) {
        uint256 size = a.code.length;
        if (size == 0) return true;
        if (size != 23) return false;
        bytes memory c = a.code;
        return c[0] == 0xef && c[1] == 0x01 && c[2] == 0x00;
    }

    function _accountOf(address circuits, uint256 tokenId) internal view returns (address) {
        (bool ok, address a) = _readAddress(
            registry,
            abi.encodeWithSelector(IERC6551RegistryMin.account.selector, accountImplementation, SALT, block.chainid, circuits, tokenId)
        );
        if (!ok || a == address(0)) revert RegistryFailed();
        return a;
    }

    /// @dev 有界 staticcall：限 gas，只复制前 32 字节，并要求真实返回长度恰好 32 字节。
    function _readWord(address target, bytes memory data) private view returns (bool ok, uint256 word) {
        if (target.code.length == 0) return (false, 0);
        uint256 size;
        assembly {
            ok := staticcall(READ_GAS, target, add(data, 0x20), mload(data), 0, 0)
            size := returndatasize()
            if and(ok, eq(size, 32)) {
                returndatacopy(0, 0, 32)
                word := mload(0)
            }
        }
        if (size != 32) ok = false;
    }

    function _readBool(address target, bytes memory data) private view returns (bool) {
        (bool ok, uint256 w) = _readWord(target, data);
        return ok && w == 1;
    }

    function _readAddress(address target, bytes memory data) private view returns (bool, address) {
        (bool ok, uint256 w) = _readWord(target, data);
        if (!ok || w >> 160 != 0) return (false, address(0));
        return (true, address(uint160(w)));
    }
}

interface IFactoryMin {
    function isCPU(address) external view returns (bool);
}

interface IBeaconMin {
    function implementation() external view returns (address);
}

interface IERC721Min {
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IPayments {
    function paid(address account) external view returns (bool);
}

interface IERC6551RegistryMin {
    function account(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId)
        external
        view
        returns (address);
}
