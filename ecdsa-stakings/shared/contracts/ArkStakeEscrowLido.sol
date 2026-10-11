// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "./ArkStakeEscrowShares.sol";
import "./ArkStakeIds.sol";
import "./interfaces/ILido.sol";

/**
 * The stETH escrow, with native ETH as a way in.
 *
 * The one rule this file adds: **ETH sent here is staked through Lido in the
 * same call and recorded as the shares that call minted, so a position anchored
 * in ETH is indistinguishable from one anchored in stETH.**
 *
 * A depositor holding ETH would otherwise stake at Lido in one transaction and
 * anchor the stETH in another. Doing both in one call puts the deposit straight
 * into consensus-layer staking and removes the approval, the transfer's one- or
 * two-wei rounding and the window between the two. It adds no authority: the
 * escrow calls one function of the asset it already holds, and sends it nothing
 * but the ETH that arrived with the call.
 *
 * Every refusal and every price is the base contract's. `_openAnchor` runs
 * before any ETH moves, and the shares are measured, not taken from `submit`'s
 * return value. Lido's own refusals — staking paused, the stake limit reached —
 * revert the whole call, and the ETH goes back with it.
 *
 * There is no `receive()`. ETH sent bare cannot name a beneficiary, and a
 * deposit naming none is refused rather than defaulted (whitepaper §3.2), so it
 * is refused by the absence of the function.
 *
 * Whether stETH is admissible at all is decided by the admission procedure of
 * whitepaper §6.3 (status register item 33), not by this contract.
 */
contract ArkStakeEscrowLido is ArkStakeEscrowShares {
    constructor(
        address steth_,
        address relay_,
        address operationsDestination_,
        uint256 seedMinimumUnits_,
        uint256 qrlOwnerLength_,
        uint256 auditYieldRate_
    ) ArkStakeEscrowShares(steth_, steth_, relay_, operationsDestination_, seedMinimumUnits_, qrlOwnerLength_, auditYieldRate_) {}

    /**
     * Anchor ETH, staked through Lido in this call: yellow paper §1.4
     * `anchorNative`. As `anchor`, with the shares Lido minted in place of the
     * shares a transfer delivered. The deposit nonce is derived, as `anchor`
     * derives it, not supplied (CLAUDE.md §7.3).
     */
    function anchorNative(bytes calldata boundQrlOwner)
        external
        payable
        returns (bytes32 id, uint64 depositNonce, uint256 anchoredNotional)
    {
        return _anchorNative(boundQrlOwner, false);
    }

    /// `anchorNative`, term-committed: as `anchorCommitted` (whitepaper §4.4).
    function anchorNativeCommitted(bytes calldata boundQrlOwner)
        external
        payable
        returns (bytes32 id, uint64 depositNonce, uint256 anchoredNotional)
    {
        return _anchorNative(boundQrlOwner, true);
    }

    function _anchorNative(bytes calldata boundQrlOwner, bool committed)
        private
        nonReentrant
        returns (bytes32, uint64, uint256)
    {
        if (msg.value == 0) revert ZeroValue();
        (bytes32 ownerHi, bytes32 ownerLo) = _ownerWords(boundQrlOwner);
        _openAnchor(ownerHi, ownerLo);
        return _recordAnchor(ownerHi, ownerLo, _stake(), committed);
    }

    /// The seeding deposit in ETH, staked through Lido in this call. As `seed`.
    function seedNative() external payable nonReentrant {
        if (msg.value == 0) revert ZeroValue();
        _creditSeed(_stake());
    }

    /// Stake `msg.value` at Lido and measure the shares that arrived.
    function _stake() private returns (uint256 sharesReceived) {
        uint256 before = _sharesHeld();
        ILido(address(ASSET)).submit{value: msg.value}(address(0));
        sharesReceived = _sharesHeld() - before;
        if (sharesReceived == 0) revert ZeroValue();
    }
}
