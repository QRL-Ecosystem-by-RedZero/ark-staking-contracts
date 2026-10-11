// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * The origin-chain escrow, as the relay and the depositor see it.
 *
 * Error names are shared with `ArkStakeRegistry` where the *rule* is the same —
 * `BadProof`, `ProofSpent`, `ReleaseClosed`, `NoBeneficiary` — and the argument
 * lists are made identical wherever the name is. `test/harness.js` keys its
 * revert decoder by full signature precisely because two contracts may declare
 * one name with different arguments, and reusing a name with a *different*
 * signature would make one of them decode as a bare revert. Where the arguments
 * cannot match, the name is different.
 */
interface IArkStakeEscrow {
    /**
     * A position, as the escrow records it.
     *
     * `stake` is a claim on the pooled shares, not a share count: the staker
     * share of yield accrues by the pool growing under a fixed stake, so one
     * storage write reprices every position. Walking positions on a sweep is the
     * design that stops working at exactly the moment it is needed.
     *
     * The escrow stores neither `boundQrlOwner` nor `recipient`. Both are inside
     * the identifier and the leaf respectively, which is what makes them
     * unrewritable rather than merely unwritten.
     */
    struct Position {
        uint128 stake;
        uint64 claimNonceUsed;
        uint64 anchoredAt;
    }

    /**
     * The rates an allocation leaf carries (whitepaper §4.2, §4.4). The staker
     * share is the residual. `levyBps` is the stabilization levy in force;
     * `sigmaTargetBps` the target rung, unscaled, that a position anchoring now
     * commits at and that a committed one is topped up to, and `coveredBps`
     * the cover it is scaled by; `psrCapBps` the reserve's cap factor,
     * `psrCapEpochs * (sigma_4 - sigma_1)`, applied to an epoch's gross yield;
     * `commitTermEpochs` the term a commitment made now runs for (I39).
     */
    struct AllocationRates {
        uint16 sigmaBps;
        uint16 bufferBps;
        uint16 operationsBps;
        uint16 jurorFeeShareBps;
        uint16 levyBps;
        uint16 sigmaTargetBps;
        uint16 coveredBps;
        uint16 psrCapBps;
        uint16 commitTermEpochs;
        /// A stage step queued when QRL sealed the leaf (V4, 2026-09-30; PV-20, QL-25): no commitment while it is.
        bool stepQueued;
    }

    /// The allocation recorded, one slot: the epoch of its leaf, its rates, and whether one exists.
    struct Allocation {
        uint64 epoch;
        uint16 sigmaBps;
        uint16 bufferBps;
        uint16 operationsBps;
        uint16 jurorFeeShareBps;
        uint16 levyBps;
        uint16 sigmaTargetBps;
        uint16 coveredBps;
        uint16 psrCapBps;
        uint16 commitTermEpochs;
        bool set;
        bool stepQueued;
    }

    /**
     * One cohort of term-committed positions (whitepaper §4.4): anchored in one
     * epoch at one committed rung, for one term. Its positions share `stake`,
     * their effective stake together; a position records `stake * 1e18 / mult`
     * at anchoring, and the reserve's top-up raises `mult` for all of them at
     * once, so nothing walks the positions.
     */
    struct Cohort {
        uint128 stake;
        uint128 mult;
        uint16 sigmaCommitBps;
        uint64 anchorEpoch;
        uint64 untilEpoch;
    }

    /**
     * The three kinds of payment the exit queue carries. whitepaper §3.5 lists
     * four return messages; three of them move the asset out of the escrow in
     * quantity and so settle through the queue under the per-epoch bound of
     * whitepaper §3.3. The fourth, the premium lock, pays out of the auction
     * pot directly, against a revealed preimage, and is not here.
     *
     * `None` is the zero value, so an entry already paid or dropped — and
     * deleted — reads as `None` wherever it is met.
     */
    enum EntryKind {
        None,
        Release,
        Loss,
        Recovery
    }

    /**
     * One lot of the premium share selected on QRL, as `claimPremium` takes it
     * (yellow paper §1.4). `lotId` is the QRL swap's identifier, which binds
     * the solver, the value locked and the QRL expiry; `shares` is what the
     * solver bought, in the shares the escrow holds.
     */
    /**
     * A premium lock as the solver presents it. `epoch` (the offered epoch) and
     * `bond` (the commitment bond) are bound by the leaf (yellow paper §3.5)
     * and read by nothing else here.
     */
    struct PremiumLock {
        bytes32 lotId;
        bytes32 hashlock;
        address recipient;
        uint256 shares;
        uint64 evmExpiry;
        uint256 epoch;
        uint256 bond;
    }

    /**
     * One payment waiting in the exit queue. whitepaper §3.3: in transit.
     *
     * Held in shares, so a rebase while it waits accrues to the payee — for a
     * release, "notional in transit still earns the origin yield for its own
     * account". `ref` is the stake asset id for a release or a loss settlement
     * and the recovery id for a recovery share; `claimNonce` is a release's
     * only and zero otherwise.
     *
     * A loss settlement is the exception (2026-09-28, D13, D17): it holds no
     * shares and is owed `unitsDue` units of the asset, fixed at the
     * determination (whitepaper §5.2), paid out of the buffer at the rate of
     * each payment. What the buffer cannot meet stays owed — the outstanding
     * loss claim — until the buffer's next inflow, and the entry does not hold
     * the queue behind it meanwhile. Zero for every other kind.
     */
    struct QueueEntry {
        EntryKind kind;
        bytes32 ref;
        address recipient;
        uint64 claimNonce;
        uint256 sharesRemaining;
        uint256 unitsPaid;
        uint256 unitsDue;
    }


    /**
     * Everything the attester needs to build this anchor's leaf.
     *
     * Every preimage field is here, so an indexer reconstructs
     * `stakeLeafKey(stakeAssetId(...), anchoredNotional)` from the log alone and
     * never needs an archive call. `epoch` is emitted rather than recomputed off
     * chain for the same reason: one fewer place the two legs can disagree.
     *
     * The bound owner is emitted as the two canonical words of
     * `ArkStakeIds.qrlOwnerWords` rather than as an `address`: a QIP-55 QRL
     * address is 64 bytes and fits no topic, and the words are the exact form
     * the preimage takes, so the indexer applies no conversion. It is no
     * longer indexed — filtering by owner filters on `keccak256(hi, lo)` off
     * chain if anyone needs it, and the two slots freed keep the log cheaper
     * than three topics plus two words would be.
     */
    event Anchored(
        bytes32 indexed stakeAssetId,
        address indexed depositor,
        bytes32 qrlOwnerHi,
        bytes32 qrlOwnerLo,
        uint256 chainId,
        address asset,
        uint64 depositNonce,
        uint256 anchoredNotional,
        uint256 shares,
        uint256 epoch
    );

    event Seeded(address indexed from, uint256 units, uint256 shares, uint256 seededUnits);

    /// The seeding deposit, or what the buffer holds of it, returned to the protocol's address (whitepaper §4.2, PV-17).
    event SeedWithdrawn(address indexed to, uint256 units, uint256 shares);

    /// The treasury's prime of the reserve (whitepaper §4.4, PV-04), held above the cap until the levy replaces it; `amount` as transferred.
    event PsrPrimed(address indexed from, uint256 amount, uint256 shares);

    /// De-listing reached this chain: anchoring is closed, releases are not.
    event AnchoringClosed(uint64 indexed epoch);

    /// A receipt was consumed and the position entered the release queue.
    event ReleaseQueued(
        bytes32 indexed stakeAssetId,
        address indexed recipient,
        uint256 indexed sealedEpoch,
        uint64 claimNonce,
        uint256 shares,
        uint256 queueIndex
    );

    /**
     * The root carrying a release instruction is admitted here, and the
     * position left the book the premium is charged on before its unbonding
     * ran (whitepaper §3.3, I18; audit 2026-09-22, X7). The receipt is not
     * consumed: `release` consumes it once the unbonding has run.
     */
    event TransitMarked(bytes32 indexed stakeAssetId, uint256 indexed sealedEpoch, uint256 shares);

    /// One payment out of the queue, possibly partial.
    event EntryPaid(
        uint256 indexed queueIndex,
        bytes32 indexed ref,
        uint256 indexed epoch,
        EntryKind kind,
        uint256 units,
        uint256 shares,
        uint256 sharesRemaining
    );

    /**
     * A loss settlement or a recovery share paid in full. A release paid in
     * full emits `Released` instead, which carries the leaf the forward path
     * seals.
     */
    event EntrySettled(
        uint256 indexed queueIndex,
        bytes32 indexed ref,
        address indexed recipient,
        EntryKind kind,
        uint256 units
    );

    /**
     * A release met at the head of the queue after the declaration. Its shares
     * had already returned to the recovered pool when the escrow first saw the
     * closure (`ReleasesReclaimed`); this records that the entry is gone.
     */
    event ReleaseDropped(uint256 indexed queueIndex, bytes32 indexed stakeAssetId, uint64 claimNonce);

    /**
     * Every release still in the queue at the declaration, and the
     * stabilization reserve, returned to the recovered pool at once.
     */
    event ReleasesReclaimed(uint256 shares, uint256 reserveShares);

    /// A loss settlement was consumed and its quantity moved from the buffer into the queue.
    event LossQueued(
        bytes32 indexed determinationId,
        bytes32 indexed stakeAssetId,
        address indexed destination,
        uint256 quantity,
        uint256 shares,
        uint256 queueIndex
    );

    /// A recovery share was consumed and its quantity moved from the recovered pool into the queue.
    event ShareQueued(
        bytes32 indexed recoveryId,
        bytes32 indexed recipient,
        address indexed destination,
        uint256 quantity,
        uint256 shares,
        uint256 queueIndex
    );

    /**
     * A release paid in full. `releasedLeaf` is what an attester seals so QRL
     * learns the notional in transit has left; `units` is the total paid.
     */
    event Released(
        bytes32 indexed stakeAssetId,
        address indexed recipient,
        uint64 claimNonce,
        uint256 units,
        bytes32 releasedLeaf
    );

    event Swept(
        uint256 indexed epoch,
        uint256 grossUnits,
        uint256 premiumUnits,
        uint256 operationsUnits,
        uint256 bufferUnits,
        uint256 stakerUnits
    );

    /**
     * The premium share, and the juror-fee fraction of the operations share,
     * held for the auction of whitepaper §4.7. The event the auction offering
     * keys on.
     */
    event PremiumHeld(
        uint256 indexed epoch,
        uint256 premiumUnits,
        uint256 jurorFeeUnits,
        uint16 sigmaBps,
        uint16 jurorFeeShareBps
    );

    /**
     * The premium offered to QRL for the epoch in progress, in shares and in
     * units at the same instant. The forward path seals `offerLeaf`.
     */
    event PremiumOffered(uint256 indexed epoch, uint256 shares, uint256 units, bytes32 offerLeaf);

    /**
     * The buffer this escrow holds, in shares and in units at the same instant.
     * The forward path seals `bufferLeaf`; QRL counts it in utilisation
     * (whitepaper §4.3).
     */
    event BufferReported(uint256 indexed epoch, uint256 shares, uint256 units, bytes32 bufferLeaf);

    /**
     * A lot was paid to its solver. `secret` is the preimage of its hashlock,
     * published here so anyone can present it on QRL, where the lot's QRL is
     * credited to the delivered-proceeds account (yellow paper §1.4).
     */
    event PremiumClaimed(bytes32 indexed lotId, bytes32 secret);

    /// An allocation leaf was recorded; `recordedAllocation` holds its rates.
    event AllocationRecorded(uint256 indexed epoch, bytes32 allocationLeaf);

    /// A position anchored term-committed (whitepaper §4.4): its cohort, the rung it locked, the epoch it ends.
    event Committed(bytes32 indexed stakeAssetId, uint256 indexed cohort, uint16 sigmaCommitBps, uint64 untilEpoch);

    /**
     * One sweep's premium stabilization reserve (I39): the levy credited, what
     * the committed positions' top-up demanded, and what the reserve paid of
     * it; `psrShares` holds the reserve after. Demand the reserve could not
     * meet is met out of the sweep's premium, and every commitment reprices
     * from the next epoch.
     */
    event ReserveSwept(uint256 indexed epoch, uint256 levyUnits, uint256 demandUnits, uint256 paidUnits);

    /// What an epoch's cap did not admit left the reserve for the buffer (whitepaper §4.2, I39).
    /// The reserve's cap, in shares since EC phase 2 (`ceil(psrCapBps * rate * book / (BPS * 1e18))`), and what it sent to the buffer.
    event ReserveCapped(uint256 indexed epoch, uint256 capShares, uint256 toBufferShares);

    /// The reserve fell short: every commitment anchored before `fromEpoch` pays spot from it.
    event CommitmentsRepriced(uint256 indexed fromEpoch);

    /**
     * The exit queue went from empty to non-empty and its base was read.
     * `queueBase` holds until the queue empties again; `boundShares` is what
     * each epoch may pay against it.
     */
    event QueueOpened(uint256 indexed epoch, uint256 queueBase, uint256 boundShares);

    /**
     * The asset refused a payment to `recipient`, out of the queue or to the
     * operations destination, and it was credited to `owedShares` instead.
     * The queue entry it came from still emits `EntryPaid`: the payment has
     * left the queue and used its part of the bound.
     */
    event PaymentDeferred(address indexed recipient, uint256 units, uint256 shares);

    /// A credited payment reached its payee.
    event OwedWithdrawn(address indexed recipient, uint256 units, uint256 shares);

    /// Shares no stake claimed were moved to the buffer ahead of an anchor.
    event OrphanedSharesBuffered(uint256 shares);

    error NoBeneficiary();
    error ZeroValue();
    error ZeroAddress();
    error AnchorExists(bytes32 stakeAssetId);
    error UnknownPosition(bytes32 stakeAssetId);
    error DustAnchor(uint256 shares);
    error WrongClaimNonce(uint64 expected, uint64 supplied);
    error ProofSpent(bytes32 spendKey);
    error BadProof(uint256 epoch, bytes32 leaf);
    error NoRootForEpoch(uint256 epoch);
    error UnbondingNotServed(uint256 sealedEpoch, uint256 usableFromEpoch);
    error ReleaseClosed();

    /**
     * The protective freeze is on.
     *
     * Separate from `ReleaseClosed` because the two are different states and a
     * beneficiary needs to know which one they are in: a freeze is reversible
     * and settles nothing, so the receipt stays valid and unspent and the
     * release executes once the freeze comes off. A closure is the declaration
     * and the path does not reopen.
     */
    error ReleaseFrozen();

    /// whitepaper §4.2: anchoring opens only once the seeding deposit is held.
    error SeedingAbsent(uint256 seededUnits, uint256 minimumUnits);

    /// The seed returns only once no position is anchored and no loss claim on the buffer is outstanding (PV-17).
    error SeedLocked(uint256 totalStake, uint256 lossOwedUnits);

    /// whitepaper §3.6: the leaf set is past the migration horizon.
    error MigrationHorizonReached(uint32 nextLeaf, uint32 horizon);

    /// whitepaper §3.2: the asset was de-listed and the de-listing reached this chain.
    error AnchoringIsClosed();

    /// whitepaper §3.5: no premium is offered or locked after the declaration.
    error SettlementClosed();
    error PremiumExceedsPot(uint256 shares, uint256 auctionShares);

    /// `offerPremium`: this epoch's premium was offered already.
    error AlreadyOffered(uint256 epoch);

    /// `reportBuffer`: this epoch's buffer was reported already.
    error AlreadyReported(uint256 epoch);

    /// `offerPremium`: earlier lots may still be claimed until this instant.
    error OfferNotOpen(uint256 opensAt);

    /// `claimPremium`: sha256 of the secret is not the lot's hashlock.
    error WrongPreimage(bytes32 hashlock);

    /// `claimPremium`: the lot's origin-chain expiry has passed.
    error PremiumExpired(uint64 evmExpiry);

    /// yellow paper §1.4 `releaseShare`: the quantity exceeds the recovered pool.
    error ShareExceedsHolding(uint256 shares, uint256 recoverableShares);

    error NothingToSweep();

    /// `withdrawOwed`: the asset still refuses the payee. Its credit is untouched.
    error PaymentRefused(address recipient);

    /// `withdrawOwed`: nothing credited to the payee is worth a unit.
    error NothingOwed(address recipient);

    /**
     * Stakes stand with no shares behind them — a recovery share on the
     * censorship ground took the pool — so a new stake cannot be priced.
     */
    error PositionsDrained(uint256 totalStake);

    /// The stake an anchor would record does not fit the 128 bits it is stored in.
    error StakeOverflow(uint256 stake);

    error AllocationNotForward(uint64 recorded, uint256 supplied);
    error FutureEpochAllocation(uint256 epoch, uint256 current);
    /// A rate of the leaf outside whitepaper §6.3's range; `field` is its place in `AllocationRates`.
    error AllocationOutOfRange(uint256 field, uint256 supplied);
    error AllocationExceedsYield(uint256 sigmaBps, uint256 bufferBps, uint256 operationsBps);

    /// `anchorCommitted`: no allocation in force offers a commitment term.
    error CommitmentUnavailable();
    /// A term commitment while a step of the threat stage is queued (whitepaper §4.4; QL-25, PV-20).
    error StageStepQueued();
    /// A term commitment on an allocation not recorded for the epoch in progress (whitepaper §4.4, PV-20).
    error AllocationStale(uint256 recordedEpoch, uint256 epoch);
    /**
     * A term commitment the reserve cannot cover (whitepaper §4.4, EC-08): it
     * holds less than psrCapBps of one epoch of gross yield of `bookShares`,
     * the committed book with the position in it. Both in shares.
     */
    error PsrShort(uint256 reserveShares, uint256 bookShares);
}
