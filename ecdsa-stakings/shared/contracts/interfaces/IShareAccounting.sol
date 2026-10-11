// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * The share accounting a rebasing asset exposes.
 *
 * The admission audit records `shareAccounting` on an asset profile (yellow
 * paper §2.1): whether the balance rebases, and if so how principal is
 * recorded. For a rebasing asset the recorded figure is in shares rather than
 * units, because otherwise a rebase presents principal as yield and the sweep
 * pays it away.
 *
 * This is Lido's surface, which is the one the modelled book uses. An asset with
 * a differently named equivalent needs an adapter deployed at this interface
 * rather than a branch inside the escrow — the escrow's asset is immutable, and
 * a second code path for a second naming convention is a second thing to audit
 * for no gain.
 */
interface IShareAccounting {
    function sharesOf(address account) external view returns (uint256);

    function getPooledEthByShares(uint256 shares) external view returns (uint256);

    function getSharesByPooledEth(uint256 units) external view returns (uint256);
}
