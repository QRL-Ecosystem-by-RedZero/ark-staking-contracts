// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * The one Lido call the native-entry escrow makes: stake ETH, receive stETH.
 *
 * `submit` mints stETH shares to the caller for the ETH sent, at the pool's
 * current rate, and returns the shares minted. The escrow does not trust the
 * return value; it measures its own share balance before and after, as every
 * other deposit path here does. The referral is always zero: nothing here
 * names an account it would reward.
 */
interface ILido {
    function submit(address referral) external payable returns (uint256);
}
