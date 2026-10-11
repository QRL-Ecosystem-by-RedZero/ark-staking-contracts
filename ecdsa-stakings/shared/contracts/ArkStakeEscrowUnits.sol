// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "./ArkStakeEscrow.sol";

/**
 * The escrow for an asset whose balance does not rebase.
 *
 * The one rule this file adds: **a share is a unit, so the rate never moves and
 * the yield is the whole of the balance above recorded principal.**
 *
 * `_toUnits(RATE_ONE)` therefore returns `RATE_ONE` forever, `lastRate` settles
 * once and never changes, and the rate term of `_settle` vanishes — leaving
 * exactly whitepaper §3.2's "the balance above recorded principal". There is no
 * runtime flag distinguishing this from the rebasing form: the choice is which
 * bytecode was deployed, and it is visible by inspecting it.
 */
contract ArkStakeEscrowUnits is ArkStakeEscrow {
    constructor(
        address asset_,
        address relay_,
        address operationsDestination_,
        uint256 seedMinimumUnits_,
        uint256 qrlOwnerLength_,
        uint256 auditYieldRate_
    ) ArkStakeEscrow(asset_, relay_, operationsDestination_, seedMinimumUnits_, qrlOwnerLength_, auditYieldRate_) {
        lastRate = RATE_ONE;
    }

    function _sharesHeld() internal view override returns (uint256) {
        return ASSET.balanceOf(address(this));
    }

    function _toUnits(uint256 shares) internal pure override returns (uint256) {
        return shares;
    }

    function _toShares(uint256 units) internal pure override returns (uint256) {
        return units;
    }
}
