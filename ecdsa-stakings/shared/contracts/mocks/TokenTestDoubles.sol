// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import "../interfaces/IShareAccounting.sol";

/// A plain non-rebasing ERC20. Never deployed to any network.
contract MockAsset is ERC20 {
    constructor() ERC20("Mock Asset", "MOCK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/**
 * A stETH-shaped rebasing token. Never deployed to any network.
 *
 * Balances are `shares * totalPooled / totalShares`, so a rebase is a change to
 * `totalPooled` alone and every holder's *share* count is untouched. That is the
 * property `ArkStakeEscrowShares` exists for, and a double that merely minted
 * extra tokens on a rebase would make every test about it vacuous — the escrow
 * would see excess shares and the two-term yield expression would never be
 * exercised.
 *
 * `transfer` moves shares computed from units and truncates, which is where
 * stETH's famous one-to-two wei difference comes from. The escrow measures what
 * arrived rather than trusting the amount for exactly this reason, so the double
 * has to reproduce it.
 */
contract MockRebasingAsset is IShareAccounting {
    string public constant name = "Mock Rebasing Asset";
    string public constant symbol = "MRBS";
    uint8 public constant decimals = 18;

    uint256 public totalShares;
    uint256 public totalPooled;

    mapping(address => uint256) private _shares;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function sharesOf(address account) public view returns (uint256) {
        return _shares[account];
    }

    function getPooledEthByShares(uint256 shares) public view returns (uint256) {
        if (totalShares == 0) return shares;
        return (shares * totalPooled) / totalShares;
    }

    function getSharesByPooledEth(uint256 units) public view returns (uint256) {
        if (totalPooled == 0) return units;
        return (units * totalShares) / totalPooled;
    }

    function totalSupply() external view returns (uint256) {
        return totalPooled;
    }

    function balanceOf(address account) public view returns (uint256) {
        return getPooledEthByShares(_shares[account]);
    }

    function mint(address to, uint256 units) public {
        uint256 shares = getSharesByPooledEth(units);
        _shares[to] += shares;
        totalShares += shares;
        totalPooled += units;
        emit Transfer(address(0), to, units);
    }

    /// A rebase moves the pool and not the shares. Negative values are allowed.
    function rebase(int256 deltaUnits) external {
        if (deltaUnits >= 0) totalPooled += uint256(deltaUnits);
        else totalPooled -= uint256(-deltaUnits);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "allowance");
            allowance[from][msg.sender] = allowed - value;
        }
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) private {
        uint256 shares = getSharesByPooledEth(value); // truncates: the wei stETH loses
        require(_shares[from] >= shares, "balance");
        _shares[from] -= shares;
        _shares[to] += shares;
        emit Transfer(from, to, value);
    }
}

/**
 * Lido's staking entry point on the rebasing double. Never deployed to any
 * network.
 *
 * `submit` mints the caller shares for the ETH sent at the pool's rate, as
 * Lido's does, and keeps the ETH. `setPaused` stands in for Lido's staking
 * pause and stake limit, the refusals `anchorNative` must revert with.
 */
contract MockLido is MockRebasingAsset {
    bool public paused;

    function setPaused(bool paused_) external {
        paused = paused_;
    }

    function submit(address) external payable returns (uint256 shares) {
        require(!paused, "STAKING_PAUSED");
        uint256 before = sharesOf(msg.sender);
        mint(msg.sender, msg.value);
        shares = sharesOf(msg.sender) - before;
    }
}

/**
 * stETH as it actually behaves at the edges the escrow pays across. Never
 * deployed to any network.
 *
 * The one rule this double exists to reproduce: **a transfer the asset itself
 * refuses is a normal outcome of a payment, not an exotic one.** Lido's
 * `_transferShares` reverts `TRANSFER_TO_STETH_CONTRACT` for a transfer to the
 * stETH contract and `TRANSFER_TO_ZERO_ADDR` for one to zero, and a recipient
 * named on QRL can be the former. `MockRebasingAsset` accepts both, which is
 * how an escrow whose queue a single refused payment blocked for ever passed
 * every test written against it.
 *
 * Also as Lido: the pool does not start at one unit per share (a double that
 * does hides every place shares and units are confused), and a transfer of
 * units moves the truncated share count, so a recipient receives one or two
 * wei less than it was sent.
 *
 * `setRefuseZero` is not Lido: it stands in for the ERC20s that revert a
 * zero-value transfer, so the escrow's zero-unit payment can be tested on the
 * one form where a payment can be worth zero units.
 */
contract MockStrictRebasingAsset is IShareAccounting {
    string public constant name = "Mock Strict Rebasing Asset";
    string public constant symbol = "MSTR";
    uint8 public constant decimals = 18;

    /// Where the initial pool is parked, as Lido's initial holder is.
    address internal constant INITIAL_HOLDER = address(0xdead);

    uint256 public totalShares;
    uint256 public totalPooled;
    bool public refuseZero;

    mapping(address => uint256) private _shares;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor() {
        // 1.1537... units per share, and not a round number of wei.
        _shares[INITIAL_HOLDER] = 1e18;
        totalShares = 1e18;
        totalPooled = 1_153_700_000_000_000_007;
    }

    function sharesOf(address account) public view returns (uint256) {
        return _shares[account];
    }

    function getPooledEthByShares(uint256 shares) public view returns (uint256) {
        return (shares * totalPooled) / totalShares;
    }

    function getSharesByPooledEth(uint256 units) public view returns (uint256) {
        return (units * totalShares) / totalPooled;
    }

    function totalSupply() external view returns (uint256) {
        return totalPooled;
    }

    function balanceOf(address account) public view returns (uint256) {
        return getPooledEthByShares(_shares[account]);
    }

    function mint(address to, uint256 units) external {
        uint256 shares = getSharesByPooledEth(units);
        _shares[to] += shares;
        totalShares += shares;
        totalPooled += units;
        emit Transfer(address(0), to, units);
    }

    /// A rebase moves the pool and not the shares. Negative values are allowed.
    function rebase(int256 deltaUnits) external {
        if (deltaUnits >= 0) totalPooled += uint256(deltaUnits);
        else totalPooled -= uint256(-deltaUnits);
    }

    function setRefuseZero(bool refuse) external {
        refuseZero = refuse;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "ALLOWANCE_EXCEEDED");
            allowance[from][msg.sender] = allowed - value;
        }
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) private {
        require(to != address(0), "TRANSFER_TO_ZERO_ADDR");
        require(to != address(this), "TRANSFER_TO_STETH_CONTRACT");
        require(!(refuseZero && value == 0), "ZERO_TRANSFER");
        uint256 shares = getSharesByPooledEth(value); // truncates, as Lido's does
        require(_shares[from] >= shares, "BALANCE_EXCEEDED");
        _shares[from] -= shares;
        _shares[to] += shares;
        emit Transfer(from, to, value);
    }
}

/**
 * A non-rebasing ERC20 that refuses payments the way real ones do. Never
 * deployed to any network.
 *
 * The one rule: **a recipient can become unpayable after it was named.** A
 * blocklist (USDC, USDT) is written by an outside party at any time, so a payee
 * committed on QRL weeks earlier may be refused when the queue reaches it; a
 * transfer to the token's own address is refused as stETH refuses it; and a
 * zero-value transfer is refused as several older tokens refuse it.
 */
contract MockStrictAsset is ERC20 {
    mapping(address => bool) public blocked;

    constructor() ERC20("Mock Strict Asset", "MSTA") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address account, bool isBlocked) external {
        blocked[account] = isBlocked;
    }

    function _beforeTokenTransfer(address from, address to, uint256 amount) internal view override {
        if (from == address(0)) return; // minting is the test's own business
        require(!blocked[to], "BLOCKED");
        require(to != address(this), "TRANSFER_TO_TOKEN_CONTRACT");
        require(amount != 0, "ZERO_TRANSFER");
    }
}

/**
 * A non-rebasing token whose `transfer` returns nothing, as USDT's does.
 * Never deployed to any network.
 *
 * The one rule: **an empty return is success**, so an escrow that pays with a
 * low-level call must not read it as a refusal and defer every payment. A
 * refused payment reverts, as USDT's does.
 */
contract MockNoReturnAsset {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;
    uint256 public totalSupply;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function setBlocked(address account, bool isBlocked) external {
        blocked[account] = isBlocked;
    }

    function approve(address spender, uint256 value) external {
        allowance[msg.sender][spender] = value;
    }

    function transfer(address to, uint256 value) external {
        _move(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external {
        require(allowance[from][msg.sender] >= value, "allowance");
        allowance[from][msg.sender] -= value;
        _move(from, to, value);
    }

    function _move(address from, address to, uint256 value) private {
        require(!blocked[to], "blocked");
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }
}
