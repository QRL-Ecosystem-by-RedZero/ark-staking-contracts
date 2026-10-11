// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "./IArkStakeEscrow.sol";

/**
 * The inbound authority for the origin-chain leg.
 *
 * One relay is deployed per origin chain and every escrow on that chain reads
 * it immutably. That is what keeps whitepaper §3.2's "one escrow is deployed
 * per origin chain" true in the sense that matters once escrows are per asset:
 * one signer set, one leaf index, one migration horizon, one authority chain.
 * The control facts — the declaration and the protective freeze — are kept per
 * escrow since 2026-09-28 (D10): every leaf binds the escrow it acts on, so QRL
 * seals one close leaf per escrow of the chain, and they reach every asset in
 * the same root.
 *
 * Nothing here is gated on an address. Every state change is admitted on
 * hash-based one-time signatures of a threshold of the committed signer set (a
 * root, an extension, a cancellation), on membership in a root already admitted
 * (the control leaves, the published leaves), or on the clock (an activation),
 * and the caller is never read.
 *
 * A fault here impairs every admitted asset on the chain simultaneously, which
 * is exactly the peril whitepaper §5.1 excludes from the first trigger. The
 * split is therefore consistent with the cover as sold.
 */
interface IArkEpochRootRelay {
    /**
     * One signer's one-time signature: its index in the active generation, the
     * 67 Winternitz chain elements, and the positional path to its own tree.
     */
    struct SignerSig {
        uint8 signer;
        bytes32[67] ots;
        bytes32[] authPath;
    }

    /// Closure and the freeze of one escrow, as its control leaves set them.
    struct Control {
        bool closed;
        bool frozen;
        uint64 closedEpoch;
        uint64 freezeEpoch;
    }

    /**
     * `usableFromEpoch` is when a release receipt sealed into this root clears
     * the escrow's unbonding derivation, so an observer need not know the
     * escrow's constant to know when to carry it: counted from the epoch of
     * admission, which is never earlier than the label (`admittedIn`).
     */
    event EpochRootAdmitted(
        uint64 indexed epoch,
        bytes32 indexed epochRoot,
        uint32 leafIndex,
        uint256 usableFromEpoch
    );

    /**
     * The ordered leaves of an admitted root, published so every leaf a
     * payment needs is recoverable from origin-chain state (whitepaper §3.6,
     * yellow paper §2.2 `publishLeaves`, D15).
     */
    event LeavesPublished(uint64 indexed epoch, bytes32[] leaves);

    /// k signers of the active generation scheduled the next one; it activates from `activatesAt`.
    event ExtensionScheduled(uint8 indexed nextGeneration, uint64 indexed epoch, uint32 leafIndex, uint64 activatesAt);

    /// k signers of the active generation voided the scheduled extension during its delay.
    event ExtensionCancelled(uint8 indexed nextGeneration, uint64 indexed epoch, uint32 leafIndex);

    /// The next link of the chain is the active generation, from its leaf 0.
    event GenerationActivated(uint8 indexed generation, bytes32 chainCommit);

    /**
     * `timestamp` rather than `at`, in both events below.
     *
     * ethers decodes event arguments into a `Result`, which extends `Array`, so
     * a field called `at` is shadowed by `Array.prototype.at` and reads back as
     * a function instead of a number — silently, and truthily, so a guard
     * written against it always passes. A parameter name is not part of an event
     * signature, so nothing is at stake in the rename but the trap.
     */
    event Closed(address indexed escrow, uint64 indexed epoch, uint64 timestamp);

    /// The protective freeze of `escrow` went on or came off, on the root of `epoch`.
    event FreezeSet(address indexed escrow, bool frozen, uint64 indexed epoch, uint64 timestamp);

    /// A later root restated the freeze as it stands: the ordering moved, the flag did not.
    event FreezeRestated(address indexed escrow, bool frozen, uint64 indexed epoch);

    error BadTreeHeight(uint8 treeHeight);
    error ZeroRootAuthority();
    /// A threshold outside `n / 2 < k <= n`, or a signer set outside 1 .. 16 (whitepaper §3.6).
    error BadThreshold(uint256 threshold, uint256 signers);
    /// Two signers of one generation committed to the same tree would be one signer counted twice.
    error DuplicateSignerRoot(uint256 index);
    error EpochNotForward(uint64 epoch, uint64 lastEpoch);
    error FutureEpochRoot(uint256 epoch, uint256 current);
    error WrongLeafIndex(uint32 expected, uint32 supplied);
    error LeafSetExhausted(uint32 leafCount);
    error ZeroRoot();
    /// An allocation outside whitepaper §6.3's range, field by its place in the leaf (0 = sigmaBps ... 8 = commitTermEpochs); as the escrow's.
    error AllocationOutOfRange(uint256 field, uint256 supplied);
    /// An allocation whose four shares of gross yield exceed the whole; as the escrow's.
    error AllocationExceedsYield(uint256 sigmaBps, uint256 bufferBps, uint256 operationsBps);
    /// Fewer than k distinct signers of the active generation signed the message at the leaf index.
    error ThresholdNotMet(uint256 verified, uint256 threshold);
    error NoRootForEpoch(uint256 epoch);
    error BadProof(uint256 epoch, bytes32 leaf);
    error AlreadyClosed(uint64 closedEpoch);
    error FreezeNotForward(uint64 freezeEpoch, uint64 supplied);
    /// The escrow may not take a deposit: closed at the declaration.
    error ReleaseClosed();
    /// `premiumReceipt`: a premium lock sealed in a root after the one that carried the escrow's close (OC-LEGA-03).
    error SettlementClosed();
    /// whitepaper §3.6: the active generation is past the migration horizon and no successor is active.
    error MigrationHorizonReached(uint32 nextLeaf, uint32 horizon);
    /// `seedReturnReceipt`: a seed-return leaf of an epoch other than the one in progress or the one before it.
    error SeedReturnStale(uint256 epoch, uint256 current);
    /// `seedReturnReceipt`: the leaf returned the seed already (ORIGIN-01).
    error SeedReturnSpent(bytes32 leaf);
    /// `seedReturnReceipt`: the escrow still takes deposits; only a de-listed escrow returns its seed (ORIGIN-01).
    error AnchoringOpen();
    /// `publishLeaves`: the leaves are not in the strictly ascending order the tree is built in.
    error LeavesNotOrdered(uint256 index);
    /// `publishLeaves`: the ordered leaves do not hash to the root admitted for the epoch.
    error LeavesNotRoot(uint64 epoch, bytes32 computed);
    error LeavesAlreadyPublished(uint64 epoch);
    /// `publishLeaves`: the list is not as long as the leaf count the root was admitted with (OL-01).
    error LeafCountMismatch(uint64 epoch, uint256 expected, uint256 given);
    /// The authority chain: scheduling outside [5,000, 9,500) bps of the active leaf set.
    error OutsideExtensionWindow(uint32 nextLeaf, uint32 opens, uint32 closes);
    /// The supplied roots and commitment are not the next link of the chain fixed at construction.
    error NotNextLink(bytes32 expected, bytes32 supplied);
    /// The chain holds at most four generations; the last has no successor.
    error ChainExhausted(uint8 generation);
    error ExtensionPending(uint64 activatesAt);
    error NoExtensionPending();
    /// A cancellation after the ratchet delay has run, or an activation before it has.
    error RatchetElapsed(uint64 activatesAt);
    error RatchetRunning(uint64 activatesAt);

    /**
     * No longer raised: a restatement advances the ordering and emits
     * `FreezeRestated`. Kept declared so revert data from relays deployed
     * before that change still decodes by name.
     */
    error FreezeUnchanged(bool frozen);

    function admitEpochRoot(uint64 epoch, bytes32 epochRoot, uint32 leafCount, uint32 leafIndex, SignerSig[] calldata sigs)
        external;

    function publishLeaves(uint64 epoch, bytes32[] calldata leaves) external;

    /**
     * An allocation of the calling escrow for `epoch`: whitepaper §6.3's
     * ranges and the whole of gross yield checked, its leaf built over the
     * caller and checked against the root admitted for `epoch`. Returns the
     * leaf. Moved out of the escrow on 2026-09-30 (R3-07) to pay for the
     * reserve gate and the seed return in the Lido form's bytes; the ranges
     * stay fixed in code, here, which no key can change.
     *
     * Also returns `word`, the escrow's `Allocation` record as the one storage
     * word the compiler lays it out in (EC phase 2, 2026-09-30): the epoch in
     * bits 0-63, the nine rates at sixteen bits each from bit 64 in the order
     * of `AllocationRates`, `set` at bit 208 and `stepQueued` at bit 216. The
     * escrow stores it whole rather than packing twelve fields itself.
     */
    function allocationReceipt(uint256 epoch, IArkStakeEscrow.AllocationRates calldata rates, bytes32[] calldata proof)
        external
        view
        returns (bytes32 leaf, uint256 word);

    /// A loss settlement of the calling escrow (`lossLeaf` over `msg.sender`), a member of the root of `epoch`. Returns the leaf.
    function lossReceipt(
        uint256 epoch,
        bytes32 determinationId,
        bytes32 stakeAssetId,
        address destination,
        uint256 quantity,
        bytes32[] calldata proof
    ) external view returns (bytes32 leaf);

    /// A recovery share of the calling escrow (`shareLeaf` over `msg.sender`), a member of the root of `epoch`. Returns the leaf.
    function shareReceipt(
        uint256 epoch,
        bytes32 successorId,
        bytes32 recoveryId,
        bytes32 recipient,
        address destination,
        uint256 quantity,
        bytes32[] calldata proof
    ) external view returns (bytes32 leaf);

    /**
     * A premium lock of the calling escrow for `asset` (`premiumLockLeaf` over
     * `msg.sender`), a member of the root of `epoch`. Returns the leaf.
     * Refused `SettlementClosed` once the escrow is closed, unless the lock's
     * root is no later than the root that carried the close (OC-LEGA-03).
     */
    function premiumReceipt(uint256 epoch, address asset, IArkStakeEscrow.PremiumLock calldata payload, bytes32[] calldata proof)
        external
        view
        returns (bytes32 leaf);

    /// Reverts unless the de-listing of `asset` at the calling escrow (`delistLeaf` over `msg.sender`) is a member of the root of `epoch`.
    function delistReceipt(uint256 epoch, address asset, bytes32[] calldata proof) external view;

    /**
     * Reverts unless the seed return of the calling escrow for `epoch`
     * (`seedReturnLeaf` over `msg.sender`) is a member of the root of `epoch`,
     * `epoch` is the one in progress or the one before it (`SeedReturnStale`),
     * the escrow is not closed (`ReleaseClosed`), its anchoring is closed
     * (`AnchoringOpen`) and the leaf was never presented before
     * (`SeedReturnSpent`); then spends it. Whitepaper §4.2, PV-17; re-audit
     * 2026-09-30, ORIGIN-01.
     */
    function seedReturnReceipt(uint256 epoch, bytes32[] calldata proof) external;

    /// Since V2 (2026-09-30, PV-18) the epoch's root and its leaf count ride with the message: admitted where the count is not zero.
    function scheduleExtension(
        bytes32[] calldata nextRoots,
        bytes32 nextChainCommit,
        uint64 epoch,
        bytes32 epochRoot,
        uint32 leafCount,
        uint32 leafIndex,
        SignerSig[] calldata sigs
    ) external;

    function cancelExtension(uint64 epoch, bytes32 epochRoot, uint32 leafCount, uint32 leafIndex, SignerSig[] calldata sigs)
        external;

    function activateNextGeneration() external;

    function close(address escrow, uint64 epoch, bytes32[] calldata proof) external;

    function setFrozen(address escrow, bool frozen, uint64 epoch, bytes32[] calldata proof) external;

    /* ------------------------------------------------------------------ */
    /* What an escrow reads                                                */
    /* ------------------------------------------------------------------ */

    /// Reverts `NoRootForEpoch` or `BadProof` unless `leaf` is a member of the root admitted for `epoch`.
    function requireMember(uint256 epoch, bytes32 leaf, bytes32[] calldata proof) external view;

    /**
     * A release receipt of the calling escrow, a member of the root admitted
     * for `epoch` or reverting as `requireMember` does: the key it is spent
     * under, and the first epoch it may be consumed in (whitepaper §3.3; D11).
     */
    function releaseReceipt(uint256 epoch, bytes32 id, address recipient, uint64 claimNonce, bytes32[] calldata proof)
        external
        view
        returns (bytes32 key, uint256 usableFrom);

    /// Reverts `ReleaseClosed` or `MigrationHorizonReached` where `escrow` may not take a deposit.
    function requireAnchorable(address escrow) external view;

    function controlOf(address escrow) external view returns (Control memory);

    function isClosed(address escrow) external view returns (bool);

    function acceptedRoot(uint64 epoch) external view returns (bytes32);

    /// `acceptedRoot` at the width the escrow's receipts carry an epoch in.
    function rootOf(uint256 epoch) external view returns (bytes32);

    /// The epoch the root labelled `epoch` was admitted in; zero where none was.
    function admittedIn(uint256 epoch) external view returns (uint64);

    function nextLeaf() external view returns (uint32);

    function lastEpoch() external view returns (uint64);

    function generation() external view returns (uint8);

    function MIGRATION_HORIZON() external view returns (uint32);
}
