// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * The shared clock, on the origin chain.
 *
 * The one rule this library exists to enforce: **both chains number the same
 * second into the same epoch, with nothing configured.**
 *
 * A transcription of contracts/utils/ArkEpoch.hyp. Epochs are counted from the
 * Unix epoch rather than from a genesis timestamp, and that is not a stylistic
 * choice: it is what lets an event emitted here name an epoch that
 * `ProceedsLedger.deliver` on QRL agrees with, without either contract being
 * told about the other. An offset added here for convenience would break the
 * premium delivery of whitepaper §4.7 rather than shift a label. The yellow
 * paper §2.2 listing counts from a genesis timestamp instead; ArkEpochRootRelay
 * records that departure.
 *
 * `EPOCH_LENGTH` is a constant on both legs although whitepaper §6.3 makes it
 * governable. An epoch number is the key a delivery, a coupon draw and a spent
 * proof are recorded under, so changing it repoints those records rather than
 * adjusting a rate — CLAUDE.md §10.1 records that departure and its reasoning.
 */
library ArkEpochLib {
    uint64 internal constant EPOCH_LENGTH = 7 days;
    uint64 internal constant COUPON_CLIFF = 30 days;

    /**
     * The two windows of the premium swap that follow the close of a quote
     * window (whitepaper §4.7, §6.3): the admission of the root carrying the
     * locks, and the origin-chain claim. A copy of contracts/utils/ArkEpoch.hyp;
     * not editable alone.
     *
     * The escrow reads only their sum: a lot of the offering whose quote
     * window closed at the start of this epoch cannot be claimed after
     * `startOf(epoch) + ADMISSION_WINDOW + EVM_CLAIM_WINDOW`, so an offer read then counts
     * nothing an earlier lot may still take.
     */
    uint64 internal constant ADMISSION_WINDOW = 1 days;
    uint64 internal constant EVM_CLAIM_WINDOW = 1 days;

    function epochOf(uint256 timestamp) internal pure returns (uint256) {
        return timestamp / EPOCH_LENGTH;
    }

    function current() internal view returns (uint256) {
        return block.timestamp / EPOCH_LENGTH;
    }

    function startOf(uint256 epoch) internal pure returns (uint256) {
        return epoch * EPOCH_LENGTH;
    }
}
