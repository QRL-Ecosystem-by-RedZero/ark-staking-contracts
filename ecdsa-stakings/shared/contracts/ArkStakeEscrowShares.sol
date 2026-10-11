// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "./ArkStakeEscrow.sol";
import "./interfaces/IShareAccounting.sol";

/**
 * The escrow for a rebasing asset, recorded in shares.
 *
 * The one rule this file adds: **principal is a share count, so a rebase changes
 * what the position is worth and never how much of it is principal.**
 *
 * yellow paper §2.1, `shareAccounting`. Recording units instead would present
 * every rebase as yield and the sweep would pay principal away; recording shares
 * and measuring yield as excess *shares* would find none at all, because the
 * escrow's share balance does not move when stETH rebases. The base class
 * carries the two-term expression that resolves both; this file only supplies
 * the conversions.
 *
 * `SHARES` is the accounting surface and is fixed at construction alongside the
 * asset. It is usually the asset itself — Lido implements both on one contract —
 * but it is a separate immutable so an asset with a differently named equivalent
 * takes an adapter rather than a branch in the escrow.
 */
contract ArkStakeEscrowShares is ArkStakeEscrow {
    IShareAccounting public immutable SHARES;

    constructor(
        address asset_,
        address shareAccounting_,
        address relay_,
        address operationsDestination_,
        uint256 seedMinimumUnits_,
        uint256 qrlOwnerLength_,
        uint256 auditYieldRate_
    ) ArkStakeEscrow(asset_, relay_, operationsDestination_, seedMinimumUnits_, qrlOwnerLength_, auditYieldRate_) {
        if (shareAccounting_ == address(0)) revert ZeroAddress();
        SHARES = IShareAccounting(shareAccounting_);

        // Seeded at construction so the first settlement measures the rebase
        // since deployment, not the rebase since the asset existed.
        lastRate = SHARES.getPooledEthByShares(RATE_ONE);
    }

    function _sharesHeld() internal view override returns (uint256) {
        return SHARES.sharesOf(address(this));
    }

    function _toUnits(uint256 shares) internal view override returns (uint256) {
        return SHARES.getPooledEthByShares(shares);
    }

    function _toShares(uint256 units) internal view override returns (uint256) {
        return SHARES.getSharesByPooledEth(units);
    }
}
