// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import "./interfaces/IArkStakeEscrow.sol";
import "./interfaces/IArkEpochRootRelay.sol";
import "./ArkStakeIds.sol";
import "./ArkEpochLib.sol";

/**
 * Custody of an anchored position on its origin chain. whitepaper §3.2 and
 * §3.3, yellow paper §1.4 and §2.1.
 *
 * The one rule this contract exists to enforce: **nothing leaves except to a
 * destination fixed at construction or against a leaf of an epoch root the
 * relay has already admitted, and never on the authority of anything done on
 * this chain.**
 *
 * WHAT IS ABSENT, AND WHY THAT IS THE PRODUCT
 * -------------------------------------------
 * whitepaper §3.2 lists six properties of the bytecode, and each is the absence
 * of a capability rather than a restriction on one. There is no owner, admin,
 * guardian or pauser, and no function gated on an address; no proxy, no
 * `delegatecall`, no `selfdestruct`; no function that verifies a secp256k1
 * signature or recovers an address from one; no approval granted to any
 * address; and no path that moves principal outside `release` and, once a
 * recovery has opened, `releaseShare` — both against leaves sealed on QRL. An
 * adversary who has recovered every private key on this chain finds no
 * function to call, because a contract holds no key from which anything can be
 * recovered.
 *
 * Every function here is callable by any account and none reads the sender as
 * an authority (yellow paper §1.4). `msg.sender` appears only as the account
 * whose tokens a deposit pulls. What a caller can do is carry a proof; what the
 * proof admits is fixed on QRL.
 *
 * Every leaf this escrow acts on binds `address(this)` (yellow paper §2.2, I6,
 * D10), so a leaf admitted for another escrow of the same relay proves nothing
 * here. The membership check, the closure and the freeze are the relay's, read
 * by plain calls to an address fixed at construction — the relay delegates
 * nothing to this contract and this contract delegates nothing to it.
 *
 * WHAT LEAVES, AND BY WHICH PATH
 * ------------------------------
 * whitepaper §3.5 names four return messages and no others. Three of them move
 * a quantity of the asset and settle through one exit queue under the
 * per-epoch bound of whitepaper §3.3; the fourth, the premium swap, pays out
 * of the auction pot against a revealed preimage.
 *
 *  - Principal: `release`, one position whole, into the queue. The same
 *    receipt presented before its unbonding has run, or under the freeze,
 *    moves the position out of the priced book into transit and consumes
 *    nothing (whitepaper §3.3, I18; audit 2026-09-22, X7).
 *  - The buffer (and the seeding deposit, which is buffer): `settleLoss`, the
 *    buffer's part of a trigger-1 determination for one position, into the
 *    queue. It draws on `bufferShares` and on nothing else.
 *  - A realised escrow: `releaseShare`, one recipient's quantity under
 *    whitepaper §5.4, into the queue. It draws on the recovered pool — every
 *    share outside the buffer and outside the payable queue.
 *  - The operations share, less its juror-fee fraction: `sweep`, to a
 *    destination fixed at construction — until the declaration closes the
 *    escrow, after which the whole share accrues to the buffer (whitepaper
 *    §4.2, audit D20): the destination is an origin-chain account, and after
 *    the declaration its key may be the adversary's.
 *  - The premium stabilization reserve (`psrShares`, whitepaper §4.4, I39):
 *    filled by the levy, by its own yield and by the treasury's prime
 *    (`primePsr`, held above the cap until the levy replaces it), spent only
 *    topping the premium of term-committed positions up to the spot share,
 *    and what its cap — on the trailing mean of the closed epochs' gross
 *    yield — does not admit at an epoch's end goes to the buffer. A
 *    commitment is admitted only while it covers the committed book with the
 *    new position in it (`PsrShort`). No release, settlement or recovery
 *    path draws on it.
 *  - The premium share and the juror-fee fraction: held here in `auctionShares`
 *    and sold for QRL by the swap of whitepaper §4.7 (see THE PREMIUM SWAP
 *    below). A lot selected on QRL leaves by `claimPremium`, against a premium
 *    lock leaf and the sha256 preimage its solver's QRL is locked under.
 *  - A payment the asset refused, out of the queue or to the operations
 *    destination: credited to that payee in `owedShares` and paid by
 *    `withdrawOwed`, to that payee and nobody else. No payee can stop anyone
 *    else being paid.
 *
 * THE EXIT QUEUE AND ITS FIXED BASE
 * ---------------------------------
 * One queue, in order of submission across the three kinds, and one per-epoch
 * bound over all of it: `RELEASE_BOUND_BPS` of `queueBase`, the escrow's whole
 * holding of the asset read when the queue last opened and held until it
 * empties (whitepaper §3.3, yellow paper §1.4 `release`). What each kind does
 * when the drain reaches it:
 *
 *  - A release pays unless the freeze is on, and after the declaration never:
 *    it is dropped, and its shares belong to the recovered pool (whitepaper
 *    §3.3: the path closes permanently and the escrow is realised afterwards
 *    only under §5.4). A frozen release holds its own place and nothing
 *    behind it: the drain steps past it and pays what follows.
 *  - A loss settlement is a determined settlement and is not reduced
 *    (whitepaper §4.7), so it pays through a freeze and after the declaration.
 *  - A recovery share pays whenever it is reached. It exists only after an
 *    opening determination, which follows the declaration or the censorship
 *    ground of whitepaper §3.6, and the freeze holds release instructions and
 *    nothing else.
 *
 * ONE ESCROW PER (CHAIN, ASSET)
 * -----------------------------
 * whitepaper §3.2 says one escrow per origin chain, and this is one per chain
 * and asset. `shareAccounting` (yellow paper §2.1) has to be fixed somewhere,
 * and with no owner the only remaining place is construction. Nothing on QRL
 * changes: `ArkStakeRegistry.assetKey(chainId, asset)` never references an
 * escrow address. One relay per chain still carries one commitment and one
 * declaration to every asset at once, and a fault in the bytecode still
 * impairs every asset at once, which is the peril whitepaper §5.1 excludes.
 *
 * THE PREMIUM SWAP
 * ----------------
 * whitepaper §4.7: the premium is sold for QRL in hash-timelocked lots quoted
 * on QRL. `offerPremium` publishes what the pot holds; a solver quotes a lot on
 * QRL by locking QRL against `sha256(secret)`, payable to the delivered-proceeds
 * account alone; at the close of the quote window QRL selects lots by price
 * down to the reserve and seals each as a premium lock; `claimPremium` pays a
 * lot here against the secret before its `evmExpiry`, which publishes it, and
 * anyone then presents it on QRL, where the QRL lock is claimable for a margin
 * longer (I31). sha256 because both chains compute it natively and QuantaSwap's
 * HTLCs lock under it; against a quantum adversary its preimage resistance is
 * Grover-bounded at 128 bits.
 *
 * Nothing here trusts an account: the leaf is the authority to pay, the
 * preimage the proof the solver's QRL is locked, and the clock bounds both.
 *
 * SPECIFIED AND NOT BUILT HERE
 * ----------------------------
 * Each of these is recorded so a reader does not mistake its absence for an
 * oversight:
 *
 *  - Migration to a successor escrow (whitepaper §3.6). A release whose
 *    recipient is a successor escrow, outside the per-epoch bound. It needs an
 *    admission of the successor that this chain can check, which is unbuilt;
 *    until it is, a migration can only be carried as an ordinary release.
 *  - The buffer-share ramp to 1,000 bps below the threshold (whitepaper §4.2).
 *    The threshold is a share of the probable maximum loss, observed on QRL,
 *    so it reaches this chain as the `bufferBps` of an allocation leaf and
 *    needs nothing here beyond the range that already admits 1,000.
 *  - Retention of unsold premium as buffer (whitepaper §4.7). "No transfer and
 *    no function": the escrow already holds the quantity, so retention is
 *    bookkeeping on QRL, which simply stops offering it. It stays in
 *    `auctionShares` here, reachable by no path but a swap lock leaf; its
 *    shortfall carry and the offering of its yield (I34) are QRL's too.
 *  - The opening determination of a recovery (yellow paper §4.3). It is found
 *    on QRL by the dispute court; this contract sees only its consequence, a
 *    recovery share sealed into an accepted root, and pays it.
 *  - The release of positions of a de-listed asset (whitepaper §3.2) is
 *    instructed on QRL and arrives as ordinary receipts; `closeAnchoring` only
 *    closes the inflow.
 */
abstract contract ArkStakeEscrow is IArkStakeEscrow, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /* ------------------------------------------------------------------ */
    /* Immutables — set at construction, written by no function            */
    /* ------------------------------------------------------------------ */

    IERC20 public immutable ASSET;
    IArkEpochRootRelay public immutable RELAY;

    /// whitepaper §4.2. Relay gas and keeper cost, spent in the origin asset.
    address public immutable OPERATIONS_DESTINATION;

    /**
     * whitepaper §4.2. The seeding deposit anchoring waits for, in units of the
     * asset. Immutable, like everything that decides whether the escrow opens.
     */
    uint256 public immutable SEED_MINIMUM;

    /**
     * whitepaper §3.2 (D14): the byte length of the QRL account form this
     * escrow serves — 64 on a chain carrying QIP-55, 20 on the legacy line.
     * A bound beneficiary of any other length is one no account of that line
     * could sign for, so anchoring refuses it.
     */
    uint256 public immutable QRL_OWNER_LENGTH;

    /**
     * The admission audit's reference yield (whitepaper §4.4, yellow paper
     * §1.4 `anchorCommitted`; EC-08, PV-04 of 2026-09-30): one epoch of gross
     * yield per unit of notional, RATE_ONE fixed point. The reserve gate reads
     * it until an epoch has closed with a yield of its own, so the gate is
     * never read at a rate of zero.
     */
    uint256 public immutable AUDIT_YIELD_RATE;

    /* ------------------------------------------------------------------ */
    /* Constants — no setter, so a redeployment is the only way to change  */
    /* ------------------------------------------------------------------ */

    uint256 internal constant BPS = 10_000;
    uint256 internal constant RATE_ONE = 1e18;
    /// The multiple of `AUDIT_YIELD_RATE` each closed epoch's reserve rate is clamped at (ORIGIN-04; the model's `PSR_RATE_CLAMP_MULTIPLE`).
    uint256 internal constant PSR_RATE_CLAMP = 4;

    /// The top of the target premium share's range in whitepaper §6.3.
    uint16 internal constant SIGMA_MAX_BPS = 4_000;
    uint16 internal constant BUFFER_MIN_BPS = 250;
    uint16 internal constant BUFFER_MAX_BPS = 1_500;
    uint16 internal constant OPS_MIN_BPS = 250;
    uint16 internal constant OPS_MAX_BPS = 1_000;
    /// The top of the juror-fee fraction's range in whitepaper §6.3.
    uint16 internal constant JUROR_FEE_MAX_BPS = 5_000;

    /// The tops of whitepaper §6.3's ranges for the levy and the commitment term (I39).
    uint16 internal constant LEVY_MAX_BPS = 500;
    uint16 internal constant COMMIT_TERM_MAX_EPOCHS = 26;

    /// The reserve's largest cap factor: twelve epochs of the widest ladder, 12 * (4,000 - 1,850).
    uint16 internal constant PSR_CAP_MAX_BPS = 25_800;

    /// A cohort's multiplier at one: a committed position's recorded stake times this over it is its stake.
    uint256 internal constant MULT_ONE = 1e18;

    /**
     * The per-epoch release bound, whitepaper §3.3 and §6.3, and the value
     * CLAUDE.md §10.1 decided for it.
     *
     * NOT EDITABLE ALONE. `ArkStakeRegistry.MAX_RELEASE_BOUND_BPS` on QRL is
     * this same figure, and it is the ceiling on the governable bound over
     * there. The two drain two books: the registry's governs how fast a
     * position leaves the record cover is priced against, and this one governs
     * how fast the asset leaves the escrow. If this were the smaller, the QRL
     * book would contract faster than the escrow does, and the positions in
     * between would be charged for cover the registry had already stopped
     * sizing capital against. `test/ArkStakeSpec.test.js` reads both figures
     * out of the two sources and fails if they part company.
     */
    uint256 internal constant RELEASE_BOUND_BPS = 2_500;

    /**
     * How long a release receipt waits after the epoch its leaf was sealed into.
     *
     * This is what enforces the twenty-one day unbonding of whitepaper §3.3 on
     * *this* chain, independently, from the epoch number alone.
     *
     * QRL seals a release leaf once the instruction is recorded, into the root
     * of an epoch no earlier than the one it was recorded in, and the relay
     * refuses any root for an epoch that has not begun. For a leaf sealed into
     * epoch `e`:
     *
     *     instructedAt <  (e + 1) * L          the leaf existed inside epoch e
     *     now          >= (e + 4) * L          this guard
     *     -----------------------------------------------------------------
     *     now - instructedAt > 3L = 21 days
     *
     * Late sealing lengthens it; early sealing is impossible. The escrow checks
     * the period rather than trusting QRL to have served it.
     *
     * Since 2026-09-29 the relay's `releaseReceipt` computes the epoch from
     * this same figure (its `RELEASE_EPOCH_DELAY`, which the suite holds equal
     * to this one): the escrow reads a receipt twice from then (X7) and the
     * check moved out of its bytecode. It is still a constant of this chain,
     * fixed at construction of the relay the escrow is bound to.
     */
    uint256 internal constant RELEASE_EPOCH_DELAY = 4;

    /**
     * How many queue entries a consuming call visits on its way out. Bounded so
     * the carrier of one receipt is not made to pay for draining an arbitrarily
     * long queue of other people's payments; anything left is drained by
     * `drainQueue`, which anyone may call.
     */
    uint256 internal constant DRAIN_ON_CONSUME = 8;

    /**
     * The virtual stake that stands beside `positionShares + 1` in every
     * conversion between shares and stake, so a stake is recorded at a
     * precision a million times finer than the share it prices.
     *
     * It is what closes the donation attack on the first anchors. With an
     * offset of one on each side an attacker anchoring one wei-share and
     * donating a little over the next deposit priced that deposit at a stake of
     * one against the attacker's one, and took a third of it; donating more
     * made it revert `DustAnchor`, a denial of anchoring for the price of the
     * donation. Against a virtual stake of 10^6 the attacker's one wei-share is
     * a stake of 10^6 too, the virtual stake takes half the donation, and the
     * next deposit's stake truncates by at most one part in 10^6 of what the
     * donation would have to be to deny it. The virtual stake's own claim is
     * never paid; it is the residual every truncation below leaves in the pool.
     *
     * 10^6 and not more: a stake is stored in 128 bits, and a first anchor of
     * 10^30 shares at this offset is still a hundred times inside it.
     */
    uint256 internal constant STAKE_OFFSET = 1e6;

    /* ------------------------------------------------------------------ */
    /* Storage                                                             */
    /* ------------------------------------------------------------------ */

    mapping(bytes32 => Position) internal _positions;
    mapping(bytes32 => bool) internal _spent;
    mapping(address => uint64) internal _nonceOf;

    /// Shares backing every anchored position. The pool grows; a stake does not.
    uint256 public positionShares;

    /// The denominator of a position's claim on `positionShares`.
    uint256 public totalStake;

    /// whitepaper §4.2 and §5.2. First loss, belonging to no position.
    uint256 public bufferShares;

    /// The premium share and the juror-fee fraction, held to be swapped for QRL.
    uint256 public auctionShares;

    /// One more than the last epoch `offerPremium` ran in; zero before the first.
    uint256 internal _offerMark;

    /// One more than the last epoch `reportBuffer` ran in; zero before the first.
    uint256 internal _bufferMark;

    /// Shares in the exit queue, of every kind: consumed, not yet paid. whitepaper §3.3.
    uint256 public queuedShares;

    /**
     * The part of `queuedShares` that belongs to releases. Tracked so that the
     * declaration can return every stranded release to the recovered pool in
     * one write rather than by walking the queue — the walk being the design
     * that stops working at exactly the moment it is needed.
     */
    uint256 public queuedReleaseShares;

    /// The stranded releases were returned to the recovered pool. A one-way latch, set after closure.
    bool public releasesReclaimed;


    /// Units credited by `seed`, cumulatively. Part of `bufferShares`.
    uint256 public seededUnits;

    /// Units per RATE_ONE shares at the last settlement. A rebase moves it.
    uint256 public lastRate;

    /// De-listing reached this chain. A one-way latch.
    bool public anchoringClosed;

    Allocation internal _alloc;

    mapping(uint256 => QueueEntry) internal _queue;
    uint256 public queueHead;
    uint256 public queueTail;

    /**
     * The base of the per-epoch bound, in shares: the escrow's whole holding
     * when the queue last opened. Zero while the queue is empty, or while it
     * waits on the buffer alone (`_drain`, OC-LEGA-05).
     */
    uint256 public queueBase;

    /// The epoch `_takenShares` counts for. The count resets with the epoch; the base does not.
    uint256 internal _drainEpoch;
    uint256 internal _takenShares;

    /**
     * The largest base any queue opened on in `_baseEpoch`. A queue that empties
     * and reopens inside that epoch opens on this or on the holding now,
     * whichever is larger (see `_enqueue`).
     */
    uint256 internal _baseEpoch;
    uint256 internal _epochBase;

    /**
     * Payments the asset refused, in shares, per payee. whitepaper §3.3 pays
     * the queue in order of submission, so a payment that reverted at the head
     * would revert for every entry behind it; a refused payment is credited
     * here instead and leaves by `withdrawOwed`. Held in shares like the queue
     * it came from, so a rebase while it waits is the payee's.
     */
    mapping(address => uint256) public owedShares;

    /// The sum of `owedShares`. The fifth term of the holding identity.
    uint256 public unclaimedShares;

    /**
     * The premium stabilization reserve, in shares (whitepaper §4.4, I39): the
     * sixth term of the holding identity. One credit path — the levy, and its
     * shares' own appreciation — and one debit path — the top-up of committed
     * positions. Held in shares like the buffer, so its yield is its own.
     */
    uint256 public psrShares;

    /// The epoch the reserve is accounted for, its gross yield so far, for the cap applied when it ends.
    uint64 internal _psrEpoch;
    uint256 internal _psrGross;

    /**
     * Commitments anchored before this epoch pay spot from it: set to the
     * epoch after one in which the reserve could not meet the top-up
     * (whitepaper §4.4: an exhausted reserve reprices every committed position
     * to spot at the next epoch boundary). Zero while it never has.
     */
    uint64 internal _voidEpoch;

    /**
     * The part of the treasury prime (`primePsr`) the levy has not yet
     * replaced (whitepaper §4.4, PV-04), in shares like the reserve it stands
     * in: held above the cap, so the cap's sweep never takes it, and replaced
     * by each epoch's levy.
     */
    uint256 public primeUnreplaced;

    /// The levy credited to the reserve in `_psrEpoch`, in shares: what replaces that much of the prime when the epoch ends.
    uint256 internal _psrLevy;

    /// The gross yield per share of the book of each closed epoch, RATE_ONE fixed point; one with no sweep reads zero (QL-24).
    mapping(uint256 => uint256) internal _rateOf;

    /// The first epoch closed here: the trailing window never reaches before it.
    uint256 internal _firstClosed;

    /// The trailing mean of `_rateOf` at the last close-out: the one rate the cap and the gate read; zero reads the audit's.
    uint256 internal _trailRate;

    mapping(uint256 => Cohort) internal _cohorts;
    /// Cohorts that may still demand a top-up; pruned as they end.
    uint256[] internal _liveCohorts;
    /// A committed position's cohort; zero for a position at spot.
    mapping(bytes32 => uint256) internal _cohortOf;

    /**
     * Where a drain under the freeze resumes (D8): every entry in [queueHead,
     * _heldCursor) is a release the freeze holds or an entry already paid in
     * place, so the walk steps over them in one move rather than reading each
     * frozen release again at every drain.
     */
    uint256 internal _heldCursor;

    /**
     * Units owed by loss settlements consumed and not yet paid (whitepaper
     * §5.2; D13, D17, phase C3): each one's quantity, fixed at the
     * determination, waits in the exit queue and is paid out of the buffer at
     * the rate of the payment. What the buffer cannot meet stays owed, the
     * outstanding loss claim of §5.2, and every later inflow into the buffer
     * is spent on those claims, in queue order, before anything else can
     * reach it. `reportBuffer` reports the buffer net of it.
     */
    uint256 public lossOwedUnits;

    /**
     * A position moved into transit by a presentation of its release receipt
     * before the unbonding has run or under the freeze, in shares, until a
     * later presentation consumes the receipt (whitepaper §3.3, I18; audit
     * 2026-09-22, X7). Counted in `queuedShares` and `queuedReleaseShares` from the move,
     * with no queue entry, so it is outside the book the premium is charged
     * on, keeps its own appreciation as the queue does, and joins the
     * recovered pool at the declaration with the stranded releases — after
     * which the figure here names shares that are no longer the position's.
     */
    mapping(bytes32 => uint256) public transitShares;

    constructor(
        address asset_,
        address relay_,
        address operationsDestination_,
        uint256 seedMinimumUnits_,
        uint256 qrlOwnerLength_,
        uint256 auditYieldRate_
    ) {
        if (asset_ == address(0) || relay_ == address(0) || operationsDestination_ == address(0)) {
            revert ZeroAddress();
        }
        // A zero minimum would open anchoring on an empty buffer, which is the
        // state whitepaper §4.2 exists to prevent: bond principal in the
        // first-loss position for every event, including the small ones. A
        // zero reference yield would admit every commitment before the first
        // close-out on no reserve at all.
        if (seedMinimumUnits_ == 0 || auditYieldRate_ == 0) revert ZeroValue();
        // The two account forms `ArkStakeIds.qrlOwnerWords` can split; any other
        // escrow would refuse every anchor.
        if (qrlOwnerLength_ != 64 && qrlOwnerLength_ != 20) revert ArkStakeIds.BadOwnerLength(qrlOwnerLength_);

        ASSET = IERC20(asset_);
        RELAY = IArkEpochRootRelay(relay_);
        OPERATIONS_DESTINATION = operationsDestination_;
        SEED_MINIMUM = seedMinimumUnits_;
        QRL_OWNER_LENGTH = qrlOwnerLength_;
        AUDIT_YIELD_RATE = auditYieldRate_;
    }

    /// Closed at the declaration: this escrow's close leaf reached the relay.
    function _closed() internal view returns (bool) {
        return RELAY.isClosed(address(this));
    }

    /**
     * The bound beneficiary's two words, refused unless it has the length of
     * the QRL line this escrow serves (whitepaper §3.2, D14): the legacy
     * 20-byte form is a well-formed account on the v2 line and none on a
     * QIP-55 chain, where it would anchor a position nobody can release.
     */
    function _ownerWords(bytes calldata boundQrlOwner) internal view returns (bytes32, bytes32) {
        if (boundQrlOwner.length != QRL_OWNER_LENGTH) revert ArkStakeIds.BadOwnerLength(boundQrlOwner.length);
        return ArkStakeIds.qrlOwnerWords(boundQrlOwner);
    }

    /* ------------------------------------------------------------------ */
    /* Share accounting — the whole of the concrete/abstract split         */
    /* ------------------------------------------------------------------ */

    function _sharesHeld() internal view virtual returns (uint256);

    function _toUnits(uint256 shares) internal view virtual returns (uint256);

    function _toShares(uint256 units) internal view virtual returns (uint256);

    /**
     * Units to shares, rounding up.
     *
     * Used for anything credited to the buffer, and for what a premium
     * settlement debits from the auction pot. Understating first-loss capital
     * overstates what stands behind the positions; understating a debit lets a
     * settlement take more than the pot held. The cost is at most one
     * wei-share, borne by the staker residual in the first case and by the pot
     * in the second.
     */
    function _toSharesUp(uint256 units) internal view returns (uint256) {
        uint256 shares = _toShares(units);
        if (_toUnits(shares) < units) shares += 1;
        return shares;
    }

    /// Transfer in and measure what arrived, rather than trusting `amount`.
    function _pull(uint256 amount) private returns (uint256 sharesReceived) {
        // stETH loses one or two wei to integer division on every transfer, and
        // an anchor leaf commits `anchoredNotional` — so a one-wei disagreement
        // produces a leaf that matches no position on QRL.
        uint256 before = _sharesHeld();
        ASSET.safeTransferFrom(msg.sender, address(this), amount);
        sharesReceived = _sharesHeld() - before;
        if (sharesReceived == 0) revert ZeroValue();
    }

    /* ------------------------------------------------------------------ */
    /* Seeding and anchoring                                               */
    /* ------------------------------------------------------------------ */

    /**
     * The seeding deposit of whitepaper §4.2. Any sender.
     *
     * Credited to the buffer, supplied outside the four yield shares, forfeited
     * to no party and withdrawable by no function — the one path out of
     * `bufferShares` is `settleLoss`, which pays an affected position's
     * beneficiary under a determination, never the party that seeded. It may be
     * made in several parts by several parties; only the cumulative figure
     * opens anchoring.
     *
     * No settlement first: the arriving shares join the balance and the buffer
     * together, so they change neither the excess the sweep would find nor the
     * shares the rate term is measured on.
     */
    function seed(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroValue();
        _creditSeed(_pull(amount));
    }

    /**
     * Return the seeding deposit (whitepaper §4.2, PV-17 of 2026-09-30).
     * Any sender; the one payee is `OPERATIONS_DESTINATION`, the protocol's
     * address fixed at construction, which supplied it.
     *
     * The seed stands last-out in the pooled buffer: a loss the buffer paid
     * was charged to its accrued share and the retained premium first, so
     * what remains of the seed is the lesser of the deposit and the buffer.
     * Only once no position is anchored (every stake has left), no loss claim
     * on the buffer is outstanding and no declaration has reached this
     * escrow: after a declaration the buffer is part of the recovered pool.
     * The seed recorded goes to zero with it (re-audit 2026-09-30, ORIGIN-03):
     * the deposit is returned last-out, and what was not returned was spent,
     * so none of it remains to open anchoring on an empty buffer.
     *
     * Since the same re-audit (ORIGIN-01) the relay also requires this
     * escrow's anchoring closed (a de-listed escrow) and spends the leaf,
     * which QRL seals only on a request of governance recorded there, one
     * leaf per request.
     *
     * A determination open on QRL is not visible here, so the return also
     * needs this escrow's seed-return leaf for the epoch in progress or the
     * one before it, in that epoch's admitted root (yellow paper §2.2
     * `seedReturnLeafKey`), which QRL seals only while no determination is
     * open and no declaration is ratified: a release leaves the stake at its
     * first presentation, so `totalStake == 0` alone let the seed leave while
     * releases unbonded under an open determination. The relay checks the
     * leaf, the epoch and the closure (`seedReturnReceipt`).
     */
    function withdrawSeed(uint64 epoch, bytes32[] calldata proof) external nonReentrant returns (uint256 units) {
        RELAY.seedReturnReceipt(epoch, proof);
        _settle();
        if (totalStake != 0 || lossOwedUnits != 0) revert SeedLocked(totalStake, lossOwedUnits);
        uint256 buffer = bufferShares;
        units = _toUnits(buffer);
        if (seededUnits < units) units = seededUnits;
        if (units == 0) revert ZeroValue();
        // Rounds up, so the buffer is debited at least what leaves; never past it.
        uint256 shares = _toSharesUp(units);
        if (shares > buffer) shares = buffer;
        bufferShares = buffer - shares;
        seededUnits = 0;
        emit SeedWithdrawn(OPERATIONS_DESTINATION, units, shares);
        if (!_push(OPERATIONS_DESTINATION, units)) _credit(OPERATIONS_DESTINATION, shares, units);
    }

    /**
     * The treasury's prime of the premium stabilization reserve (whitepaper
     * §4.4, I39; PV-04 of 2026-09-30): psrCapEpochs * (sigma_4 - sigma_1) of
     * one epoch of gross yield on the book the admission audit sized, at its
     * reference yield (the model's `psrPrimeUnits`), deposited when anchoring
     * opens. Any sender; nothing is owed back. It joins the reserve and is
     * counted in `primeUnreplaced`, which the cap's sweep leaves standing
     * until the levy has replaced it. No settlement first, as for `seed`: the
     * shares join the holding and the reserve together.
     */
    function primePsr(uint256 amount) external nonReentrant {
        // Not after the declaration (re-audit 2026-09-30, ORIGIN-05): the
        // reserve has joined the recovered pool once, and a prime then would
        // be stranded outside every path.
        if (_closed()) revert SettlementClosed();
        uint256 shares = _pull(amount);
        psrShares += shares;
        primeUnreplaced += shares;
        emit PsrPrimed(msg.sender, amount, shares);
    }

    /// The seeding deposit, once its shares are here. Shared with the native-entry form.
    function _creditSeed(uint256 sharesReceived) internal {
        uint256 units = _toUnits(sharesReceived);
        bufferShares += sharesReceived;
        seededUnits += units;
        emit Seeded(msg.sender, units, sharesReceived, seededUnits);
    }

    /**
     * Escrow a position, one way.
     *
     * Every refusal ahead of the transfer is a state in which a deposit could
     * not later be released, or should not be covered:
     *
     *  - A closed relay: a deposit after the declaration can never be released,
     *    which is worse than anything whitepaper §3.2 enumerates.
     *  - A de-listed asset (whitepaper §3.2): QRL records no anchor for it, so
     *    no release instruction could ever be signed and the deposit would be
     *    one way with no exit.
     *  - The migration horizon (whitepaper §3.6): a position anchored past it
     *    might not leave before the leaf set is exhausted.
     *  - No seeding deposit (whitepaper §4.2): bond principal would be first
     *    loss for every event.
     *
     * The beneficiary is refused rather than defaulted. Deriving one from
     * `msg.sender` would make the entitlement a function of an elliptic-curve
     * key, which is the exact failure this product exists to remove, and
     * supplying one afterwards would leave a window in which the position exists
     * with no entitled address. whitepaper §3.2.
     *
     * `boundQrlOwner` is raw bytes because a QRL account is 64 bytes since
     * QIP-55 and no longer fits an `address`. The escrow serves one QRL line,
     * fixed at construction (`QRL_OWNER_LENGTH`: 64, or the legacy 20 of the
     * v2 line and the local harness), and any other length is refused before
     * the transfer — an identifier hashed over an owner of the wrong form is a
     * position no account on that line could release.
     */
    function anchor(bytes calldata boundQrlOwner, uint256 amount)
        external
        returns (bytes32 id, uint64 depositNonce, uint256 anchoredNotional)
    {
        return _anchor(boundQrlOwner, amount, false);
    }

    /**
     * `anchor`, term-committed (whitepaper §4.4): the position pays the
     * target rung in force now, `sigmaTargetBps` of the allocation this escrow
     * holds, for `commitTermEpochs` epochs, and a step of the ladder inside
     * the term does not reprice it — the reserve tops its premium up to the
     * spot rung while it can. It pays the levy like every position. Chosen
     * here, before any step is known, so the reserve is not an option written
     * by the positions that stayed at spot.
     */
    function anchorCommitted(bytes calldata boundQrlOwner, uint256 amount)
        external
        returns (bytes32 id, uint64 depositNonce, uint256 anchoredNotional)
    {
        return _anchor(boundQrlOwner, amount, true);
    }

    function _anchor(bytes calldata boundQrlOwner, uint256 amount, bool committed)
        private
        nonReentrant
        returns (bytes32, uint64, uint256)
    {
        if (amount == 0) revert ZeroValue();
        (bytes32 ownerHi, bytes32 ownerLo) = _ownerWords(boundQrlOwner);
        _openAnchor(ownerHi, ownerLo);
        return _recordAnchor(ownerHi, ownerLo, _pull(amount), committed);
    }

    /**
     * Every refusal of `anchor` that precedes the deposit, and the settlement
     * and orphan sweep the deposit must follow. Shared with the native-entry
     * form, which acquires its shares differently and must be refused and
     * priced identically.
     */
    function _openAnchor(bytes32 ownerHi, bytes32 ownerLo) internal {
        // The closure and the migration horizon of the active generation, both
        // the relay's; it reverts `ReleaseClosed` or `MigrationHorizonReached`.
        RELAY.requireAnchorable(address(this));
        if (anchoringClosed) revert AnchoringIsClosed();
        if (seededUnits < SEED_MINIMUM) revert SeedingAbsent(seededUnits, SEED_MINIMUM);
        if (ownerHi == bytes32(0) && ownerLo == bytes32(0)) revert NoBeneficiary();

        // Before the new shares join the pool. Without it the arriving position
        // is charged its share of yield produced before it existed.
        _settle();

        // Shares no stake claims — the staker residual of a sweep with no
        // positions, or the truncation residue the last leaver left — belong to
        // no position, which is what the buffer is. Left in the pool they would
        // price this anchor against value nobody deposited.
        if (totalStake == 0) {
            uint256 orphaned = positionShares;
            if (orphaned != 0) {
                positionShares = 0;
                bufferShares += orphaned;
                emit OrphanedSharesBuffered(orphaned);
            }
        } else if (positionShares == 0) {
            // Stakes with no shares behind them: a recovery share on the
            // censorship ground took the pool (whitepaper §5.4). A stake priced
            // against an empty pool is unbounded, and the positions it would
            // join are worth nothing; nothing should be anchored into that.
            revert PositionsDrained(totalStake);
        }
    }

    /// Record a position for `sharesReceived` shares already held, at spot or committed. After `_openAnchor`.
    function _recordAnchor(bytes32 ownerHi, bytes32 ownerLo, uint256 sharesReceived, bool committed)
        internal
        returns (bytes32 id, uint64 depositNonce, uint256 anchoredNotional)
    {
        // Derived per depositor rather than supplied, as the yellow paper §1.4
        // signature has it: a supplied nonce is one a depositor can collide with
        // their own earlier position, and the collision would be refused only
        // after the transfer had been attempted.
        depositNonce = _nonceOf[msg.sender]++;
        id = ArkStakeIds.stakeAssetId(
            block.chainid,
            address(ASSET),
            msg.sender,
            ownerHi,
            ownerLo,
            depositNonce
        );
        if (_positions[id].stake != 0) revert AnchorExists(id);

        // The virtual stake closes the donation attack; see STAKE_OFFSET.
        //
        // Truncates, and the residual stays with the existing positions — a
        // depositor arriving must never dilute the ones already here.
        uint256 stake = (sharesReceived * (totalStake + STAKE_OFFSET)) / (positionShares + 1);
        if (stake == 0) revert DustAnchor(sharesReceived);
        // Checked, not cast: a pool drained to a few shares under standing
        // stakes prices a stake past 128 bits, and a silent truncation records
        // the position at a fraction of what it paid.
        if (stake > type(uint128).max) revert StakeOverflow(stake);

        positionShares += sharesReceived;
        totalStake += stake;
        _positions[id] = Position({
            stake: uint128(committed ? _commit(id, stake) : stake),
            claimNonceUsed: 0,
            anchoredAt: uint64(block.timestamp)
        });

        anchoredNotional = _toUnits(sharesReceived);

        emit Anchored(
            id,
            msg.sender,
            ownerHi,
            ownerLo,
            block.chainid,
            address(ASSET),
            depositNonce,
            anchoredNotional,
            sharesReceived,
            ArkEpochLib.current()
        );
    }

    /**
     * Place a committed position of `stake` in the cohort of this epoch, the
     * rung in force and the term in force, and return what it records: the
     * stake over the cohort's multiplier, truncating toward the pool.
     */
    function _commit(bytes32 id, uint256 stake) private returns (uint256) {
        Allocation memory a = _alloc;
        if (!a.set || a.commitTermEpochs == 0) revert CommitmentUnavailable();
        uint256 nowEpoch = ArkEpochLib.current();
        // On the allocation of the epoch in progress only, and not while a
        // step of the threat stage is queued (whitepaper §4.4; QL-25, PV-20):
        // a step is public before it executes, and a commitment made then
        // would lock the rung it is about to leave.
        if (a.epoch != nowEpoch) revert AllocationStale(a.epoch, nowEpoch);
        if (a.stepQueued) revert StageStepQueued();
        // The reserve gate (whitepaper §4.4, EC-08; the model's
        // `psrCommitmentAdmissible`): the reserve holds psrCapBps of one epoch
        // of gross yield of the committed book with this position in it:
        //   reserve * BPS * RATE_ONE >= psrCapBps * rate * book
        // (the model's `psrCommitmentAdmissibleAtRate`), at the one rate the
        // cap is taken on — the trailing mean of the closed epochs' gross
        // yield per share (`_trailRate`, `psrTrailingRate`) — so a reserve at
        // its cap admits commitment of the whole book, whatever the last epoch
        // alone yielded. Before any epoch has closed, or where every epoch of
        // the window was quiet (a mean of zero), at the audit's reference
        // yield: the gate never reads a zero requirement. The reserve and the
        // book are both in shares, so no conversion is read; the committed
        // stake converts to the book's shares at the pool's price, truncating
        // by at most a share, toward admission.
        {
            (, uint256 committed) = _prune(nowEpoch);
            uint256 book = ((committed + stake) * (positionShares + 1)) / (totalStake + STAKE_OFFSET);
            uint256 rate = _trailRate == 0 ? AUDIT_YIELD_RATE : _trailRate;
            uint256 reserve = psrShares;
            if (reserve * BPS * RATE_ONE < uint256(a.psrCapBps) * rate * book) revert PsrShort(reserve, book);
        }
        uint256 until = nowEpoch + a.commitTermEpochs;
        uint256 key = (nowEpoch << 128) | (uint256(a.sigmaTargetBps) << 64) | until;
        Cohort storage c = _cohorts[key];
        if (c.mult == 0) {
            c.mult = uint128(MULT_ONE);
            c.sigmaCommitBps = a.sigmaTargetBps;
            c.anchorEpoch = uint64(nowEpoch);
            c.untilEpoch = uint64(until);
            _liveCohorts.push(key);
        }
        c.stake += uint128(stake);
        _cohortOf[id] = key;
        emit Committed(id, key, a.sigmaTargetBps, uint64(until));
        return (stake * MULT_ONE) / c.mult;
    }

    /// A position's stake: what it recorded, times its cohort's multiplier where it is committed. Truncates, toward the pool.
    function _stakeOf(bytes32 id, uint256 recorded) internal view returns (uint256) {
        uint256 key = _cohortOf[id];
        return key == 0 ? recorded : (recorded * _cohorts[key].mult) / MULT_ONE;
    }

    /**
     * De-listing, reaching this chain. whitepaper §3.2 and §6.3.
     *
     * Any sender; the leaf is the authority. A one-way latch on the inflow and
     * nothing else: de-listing releases, it does not confiscate, so every
     * position already here stays releasable and the sweep continues.
     *
     * Without it an escrow knows nothing of admission, and a deposit made after
     * QRL de-listed the asset would have no record there, no release
     * instruction could ever be signed for it, and the principal would be one
     * way into a contract with no path out.
     */
    function closeAnchoring(uint64 epoch, bytes32[] calldata proof) external {
        if (anchoringClosed) revert AnchoringIsClosed();
        // The de-listing of this escrow's asset, over this escrow, built and proven by the relay.
        RELAY.delistReceipt(epoch, address(ASSET), proof);
        anchoringClosed = true;
        emit AnchoringClosed(epoch);
    }

    /* ------------------------------------------------------------------ */
    /* Release                                                             */
    /* ------------------------------------------------------------------ */

    /**
     * Consume a release receipt sealed on QRL, and pay what the epoch's bound
     * allows. whitepaper §3.3 and §3.5, yellow paper §1.4 `release`.
     *
     * Any sender: the proof is the authority and the caller receives nothing.
     *
     * `recipient` is a parameter of this call but it is not authority. It is
     * inside the payload, committed on QRL and sealed into a root before this
     * transaction existed, so an observer resubmitting with another destination
     * produces a different payload, a different leaf and no membership proof.
     *
     * A quantity above the per-epoch bound settles in a later epoch and does
     * not fail (yellow paper §1.4): the receipt is consumed here, the position
     * leaves the book into the queue, and the queue pays in order of submission
     * as each epoch's bound allows.
     *
     * TWO PRESENTATIONS (whitepaper §3.3, I18; audit 2026-09-22, X7). The
     * first presentation of a receipt whose unbonding has not run, or made
     * under the freeze, moves the position into transit — out of the book the
     * premium is charged on — and returns without consuming anything; a later
     * one, once due and outside the freeze, consumes it. A position already in
     * transit is refused, as before, while its unbonding runs or the freeze
     * holds, so the refusal keeps the receipt unspent. Chosen over a separate
     * entry point because a function of its own did not fit the Lido form
     * under EIP-170; the relay's `releaseReceipt` checks the leaf.
     */
    function release(
        bytes32 id,
        address recipient,
        uint64 claimNonce,
        uint256 epoch,
        bytes32[] calldata proof
    ) external nonReentrant {
        // Invariant I15 for the closure, which is permanent. The freeze of
        // whitepaper §3.3 is read here too and applied below: it holds the
        // CONSUMPTION of a receipt, and has to be checked HERE and not only on
        // QRL — a receipt sealed before the freeze went on has already left
        // QRL, and checking only there would stop the paperwork and let the
        // book drain, in exactly the window the freeze exists for.
        bool held;
        {
            IArkEpochRootRelay.Control memory c = RELAY.controlOf(address(this));
            if (c.closed) revert ReleaseClosed();
            held = c.frozen;
        }
        if (recipient == address(0)) revert ZeroAddress();

        Position storage p = _positions[id];
        // In transit already, from an earlier presentation of this receipt:
        // its shares left the book then and are in the queue's count without
        // an entry.
        uint256 transit = transitShares[id];
        // A receipt without a recorded position fails against escrow state
        // rather than against a signature check. A released position has
        // `stake == 0` and no transit, and lands here too, which is the
        // intended reading.
        if (p.stake == 0 && transit == 0) revert UnknownPosition(id);
        // Derived rather than hardcoded, and it is what stops one receipt being
        // replayed under a second epoch's root.
        {
            uint64 expected = p.claimNonceUsed + 1;
            if (claimNonce != expected) revert WrongClaimNonce(expected, claimNonce);
        }

        // The receipt, checked by the relay against the root and bound to this
        // escrow: its spend key, and the first epoch it may be consumed in.
        // Unbonding counts from the later of the root's label and the epoch it
        // was admitted in; from the label alone, a root labelled with a past
        // epoch after a gap in admissions made its receipts usable at once
        // (audit 2026-09-27, D11). An escrow of this build needs a relay of
        // this build.
        (bytes32 key, uint256 usableFrom) = RELAY.releaseReceipt(epoch, id, recipient, claimNonce, proof);
        if (_spent[key]) revert ProofSpent(key);
        held = held || ArkEpochLib.current() < usableFrom;
        // A position already in transit gains nothing from a second early
        // presentation: the refusal keeps the receipt unspent, as before.
        if (held && transit != 0) _refuse(epoch, usableFrom);

        // Before the leaver's shares are computed, so it carries its part of the
        // interval it was present for and stops sharing the next one.
        _settle();

        if (transit == 0) {
            // Out of the book the premium is charged on, and out of the stake
            // the staker share accrues to, from the first presentation of the
            // receipt — as soon as the root carrying it is admitted, and not
            // only once the unbonding has run (whitepaper §3.3, I18; audit
            // 2026-09-22, X7). Before the escrow knew of an instruction only
            // at consumption, and charged the premium share throughout the
            // twenty-one days I18 has it charge none.
            transit = _leave(id, p);
            if (held) {
                // A claim that rounds to no share — a pool a recovery share
                // drained — has nothing to take out of the book, and marked
                // it would read as no position at all: it waits, refused as
                // before, and is consumed whole when due.
                if (transit == 0) _refuse(epoch, usableFrom);
                // Presented before its unbonding has run, or under the freeze:
                // into transit, and the receipt is NOT consumed. Its shares
                // wait in the queue's count with no entry, keep their own
                // appreciation as the queue does, and join the recovered pool
                // with the stranded releases at the declaration.
                transitShares[id] = transit;
                queuedShares += transit;
                queuedReleaseShares += transit;
                emit TransitMarked(id, epoch, transit);
                return;
            }
        } else {
            // Its count moves from transit to its entry, which `_enqueue` adds.
            delete transitShares[id];
            queuedShares -= transit;
            queuedReleaseShares -= transit;
        }

        _spent[key] = true;
        p.claimNonceUsed = claimNonce;
        queuedReleaseShares += transit;
        uint256 index = _enqueue(EntryKind.Release, id, recipient, claimNonce, transit, 0);
        emit ReleaseQueued(id, recipient, epoch, claimNonce, transit, index);

        _drain(DRAIN_ON_CONSUME);
    }

    /// The refusal of a receipt that may not be consumed yet: its unbonding has not run, or the freeze holds.
    function _refuse(uint256 epoch, uint256 usableFrom) private view {
        if (ArkEpochLib.current() < usableFrom) revert UnbondingNotServed(epoch, usableFrom);
        revert ReleaseFrozen();
    }

    /**
     * Take a position out of the pool and its cohort, and return its shares.
     * Truncates: the residual stays with the remaining positions, becomes
     * excess at the next settlement, and is divided there. A committed
     * position leaves with its multiplied stake, so what its cohort was paid
     * in top-ups leaves with it.
     */
    function _leave(bytes32 id, Position storage p) private returns (uint256 sharesOut) {
        uint256 stake = _stakeOf(id, p.stake);
        sharesOut = (stake * (positionShares + 1)) / (totalStake + STAKE_OFFSET);
        positionShares -= sharesOut;
        totalStake -= stake;
        p.stake = 0;
        uint256 cohort = _cohortOf[id];
        if (cohort != 0) {
            Cohort storage c = _cohorts[cohort];
            c.stake -= uint128(stake < c.stake ? stake : c.stake);
            delete _cohortOf[id];
        }
    }

    /**
     * Pay the exit queue, in order of submission, as far as the epoch's bound
     * allows. Any sender. Returns the entries paid in full or dropped.
     *
     * Never reverts on a held entry, because it carries no receipt that a
     * revert would preserve: a frozen release simply waits, and after the
     * declaration a release is dropped and its shares are already in the
     * recovered pool.
     */
    function drainQueue(uint256 maxEntries) external nonReentrant returns (uint256) {
        return _drain(maxEntries);
    }

    /**
     * Append one payment to the exit queue, reading the base if this opens it.
     *
     * THE BASE IS FIXED WHILE THE QUEUE IS OPEN. whitepaper §3.3 and yellow
     * paper §1.4 take the bound on "the escrow's holding of the asset at the
     * close of the epoch in which its exit queue last opened, held until the
     * queue empties", and never on the holding that remains. Taken on what
     * remains, the bound shrinks with every epoch it pays and a queue of the
     * whole book approaches empty geometrically without reaching it, so the
     * settlement horizon of invariant I25 — the epochs of unbonding plus
     * ceil(BPS / RELEASE_BOUND_BPS) — would describe a queue this escrow never
     * clears. An earlier version of this contract did exactly that.
     *
     * READ WHEN THE QUEUE OPENS, NOT AT THE CLOSE OF THAT EPOCH. The listing
     * says "at the close"; nothing runs at an epoch boundary on a chain nobody
     * is obliged to call, so the close is not an instant this contract can
     * observe. Reading at the opening differs only by what arrives or leaves in
     * the rest of that epoch, and on the path that matters — a release wave —
     * the holding is not growing, so the difference is in the conservative
     * direction.
     *
     * The whole holding, `_sharesHeld()`: the positions, the buffer, the pot,
     * the queue and the unclaimed credits together, which is "the escrow's
     * holding of the asset". Taken in SHARES, not units, so a rebase cannot
     * widen it.
     *
     * A QUEUE REOPENED INSIDE ONE EPOCH KEEPS THAT EPOCH'S LARGER BASE. The
     * epoch's count of what has left (`_takenShares`) survives the queue
     * emptying, as it must, or reopening would reset the bound. Re-reading the
     * base on the smaller holding under that same count shrank the epoch's
     * bound with every release that fitted it: a release wave arriving one
     * receipt at a time paid less than a quarter of the book in its first
     * epoch and took five draining epochs, not the four invariant I25
     * assumes. "The epoch in which the queue last opened" is still that epoch,
     * so its base is the larger of what the epoch already opened on and the
     * holding now. The base is still fixed while the queue is open.
     */
    function _enqueue(
        EntryKind kind,
        bytes32 ref,
        address recipient,
        uint64 claimNonce,
        uint256 shares,
        uint256 unitsDue
    ) private returns (uint256 index) {
        // Opening, for the base: empty, or released by the drain while it
        // waited on the buffer alone (`_drain`, OC-LEGA-05).
        if (queueBase == 0) _openQueue();
        queuedShares += shares;
        index = queueTail++;
        _queue[index] = QueueEntry({
            kind: kind,
            ref: ref,
            recipient: recipient,
            claimNonce: claimNonce,
            sharesRemaining: shares,
            unitsPaid: 0,
            unitsDue: unitsDue
        });
    }

    /// Read the base of a queue opening now: the holding, or the larger base this epoch already opened on.
    function _openQueue() private {
        uint256 base = _sharesHeld();
        uint256 nowEpoch = ArkEpochLib.current();
        if (_baseEpoch == nowEpoch) {
            if (_epochBase > base) base = _epochBase;
        } else {
            _baseEpoch = nowEpoch;
        }
        _epochBase = base;
        queueBase = base;
        // Truncates, so the bound is at most the stated share, never above.
        emit QueueOpened(nowEpoch, base, (base * RELEASE_BOUND_BPS) / BPS);
    }

    /**
     * At the first sight of the declaration, return every release still in the
     * queue to the recovered pool, in one write.
     *
     * A release in the queue at the declaration never pays (whitepaper §3.3:
     * the path closes permanently), so its shares are no longer owed to its
     * recipient and belong with everything else the escrow holds outside the
     * buffer — the pool whitepaper §5.4 realises. They join `positionShares`
     * rather than an account of their own so the identity
     * `positionShares + bufferShares + auctionShares + queuedShares +
     * unclaimedShares == held` keeps its five terms, and so `releaseShare` has
     * one place to draw from. A release payment already credited to
     * `owedShares` is not reclaimed: it was paid before the declaration, and
     * only the asset's refusal kept it here.
     *
     * Settled first, so a rebase accrued on the stranded shares while they were
     * in transit stays with them (and so with the pool) rather than being read
     * by the next sweep as yield on `positionShares`.
     *
     * The entries themselves stay where they are and are dropped as the drain
     * meets them; that costs nothing but a visit, since nothing is owed on them.
     *
     * THE RESERVE JOINS THE POOL IN THE SAME WRITE. The stabilization reserve
     * (`psrShares`, I39) was funded from the positions' own yield to smooth a
     * premium that ends at the declaration, and after it no top-up is ever
     * owed, so it belongs with the positions it came from: from here
     * `releaseShare` reaches it exactly as it reaches `positionShares`. Before
     * closure no settlement path reaches it (I39 unchanged). Between the
     * closure and this write the cap moves none of it to the buffer
     * (`_closeReserveEpoch`).
     */
    function _reclaimReleases() private {
        if (releasesReclaimed || !_closed()) return;
        _settle();
        uint256 stranded = queuedReleaseShares;
        uint256 reserve = psrShares;
        releasesReclaimed = true;
        queuedReleaseShares = 0;
        psrShares = 0;
        queuedShares -= stranded;
        positionShares += stranded + reserve;
        emit ReleasesReclaimed(stranded, reserve);
    }

    /**
     * The per-epoch bound of whitepaper §3.3, and the queue it meters.
     *
     * The head is paid partially when the budget runs out, so a payment larger
     * than one epoch's bound leaves over several epochs instead of blocking
     * every payment behind it — which a whole-or-nothing rule would do for
     * ever, since such a payment never fits.
     *
     * A frozen release is stepped past rather than waited on. The freeze holds
     * release instructions and nothing else (whitepaper §3.3), and a loss
     * settlement behind one is a determined settlement that is not reduced; if
     * the head waited, a freeze would hold every kind. So the walk continues
     * past it and pays what follows in place, and `queueHead` stays at the
     * first entry still owed something, so the frozen release keeps its place
     * and is paid first once the freeze lifts. An entry paid in place is
     * deleted and reads as `None` when the head later reaches it.
     *
     * After the declaration a release is dropped wherever the walk meets it,
     * using no budget, so a dropped release can never block the queue.
     * `maxEntries` bounds the entries visited, not the entries paid, so a
     * caller's gas is bounded whatever the queue holds.
     */
    function _drain(uint256 maxEntries) internal returns (uint256 settled) {
        uint256 head = queueHead;
        uint256 tail = queueTail;
        if (head == tail || maxEntries == 0) return 0;

        bool isClosed;
        bool isFrozen;
        {
            IArkEpochRootRelay.Control memory c = RELAY.controlOf(address(this));
            isClosed = c.closed;
            // The relay refuses a freeze leaf after closure, but a freeze
            // standing at the declaration stays set; it means nothing to a
            // queue in which every release is dropped.
            isFrozen = !isClosed && c.frozen;
        }
        if (isClosed) _reclaimReleases();

        // A queue the last drain released from its base while it waited on
        // the buffer alone (below, OC-LEGA-05) reopens here, as `_enqueue`
        // would open it, before the bound is read.
        if (queueBase == 0) _openQueue();
        uint256 nowEpoch = ArkEpochLib.current();
        if (nowEpoch != _drainEpoch) {
            _drainEpoch = nowEpoch;
            _takenShares = 0;
            // THE BASE RATCHETS UP (whitepaper §3.3, the model's
            // `ratchetedQueueBase`, D8): at the first drain of each epoch it is
            // raised to the holding then, where that is greater, and never
            // lowered while the queue is open. A base that only rises gives a
            // bound that only rises, so the horizon of I25 still holds, and a
            // release arriving after deposits grew the holding drains on the
            // larger base rather than on the one the queue happened to open with.
            uint256 holding = _sharesHeld();
            if (holding > queueBase) queueBase = holding;
        }

        // Truncates, so the bound is at most the stated share, never above.
        uint256 budget = (queueBase * RELEASE_BOUND_BPS) / BPS;
        // A holding under four shares truncates to a zero bound and would hold
        // its queue for ever. One share an epoch exceeds the stated bound by at
        // most one wei-share, which is the cheaper of the two failures.
        if (budget == 0) budget = 1;
        uint256 taken = _takenShares;

        // Under the freeze the walk resumes at the cursor the last drain left:
        // everything between the head and it is a held release or a paid entry
        // (D8), so a drain reads each held release once per freeze, not once
        // per call. The head stays at the first held release either way.
        uint256 i = head;
        if (isFrozen && _heldCursor > i) i = _heldCursor;
        // True once the walk has stepped past a frozen release: the head cannot
        // move beyond it, whatever is paid behind it.
        bool held = i > head;
        // The first outstanding loss claim the walk steps past (OL-06 of
        // 2026-09-29): the cursor never moves beyond it, so the next drain
        // under the freeze reads it again and the buffer's next inflow pays it
        // before any loss queued after it (whitepaper §5.2, D17 order).
        uint256 stop = tail;
        uint256 visited;
        for (; i < tail && visited < maxEntries; ++i) {
            ++visited;
            QueueEntry storage q = _queue[i];
            EntryKind kind = q.kind;

            if (kind == EntryKind.None) {
                // Paid in place on an earlier walk.
                if (!held) head = i + 1;
                continue;
            }
            if (kind == EntryKind.Release) {
                if (isClosed) {
                    // Its shares went to the recovered pool in _reclaimReleases.
                    emit ReleaseDropped(i, q.ref, q.claimNonce);
                    delete _queue[i];
                    if (!held) head = i + 1;
                    ++settled;
                    continue;
                }
                if (isFrozen) {
                    held = true;
                    continue;
                }
            }

            uint256 pay = q.sharesRemaining;
            if (kind == EntryKind.Loss) {
                // Owed in units, paid out of the buffer at the rate of the
                // payment (D13). Where the buffer holds nothing the entry is
                // an outstanding loss claim (D17): it keeps its place and is
                // stepped past, as a frozen release is, so it waits for the
                // buffer's next inflow without holding the queue behind it.
                pay = _toSharesUp(q.unitsDue - q.unitsPaid);
                if (pay > bufferShares) pay = bufferShares;
                if (pay == 0) {
                    held = true;
                    if (i < stop) stop = i;
                    continue;
                }
            }
            if (taken >= budget) break;
            if (pay > budget - taken) pay = budget - taken;
            taken += pay;

            if (_pay(i, q, kind, pay, nowEpoch)) {
                // Still owed with the bound unspent: the buffer ran out first.
                if (kind == EntryKind.Loss && bufferShares == 0) {
                    held = true;
                    if (i < stop) stop = i;
                    continue;
                }
                break;
            }

            if (!held) head = i + 1;
            ++settled;
        }

        _takenShares = taken;
        queueHead = head;
        // Where the walk stopped, the next entry it has not read under this
        // freeze, or the first loss claim it left owed if that is earlier.
        _heldCursor = i < stop ? i : stop;
        // Empty: the base is read again by whatever opens the queue next.
        //
        // So too a queue the walk crossed to its tail whose first owed entry
        // is a loss claim the buffer cannot pay (OC round 2026-10-03,
        // OC-LEGA-05). Such a queue waits on the buffer's inflow, not on the
        // bound: nothing in it could be paid now. Held open, its base stayed
        // at the largest holding it ever ratcheted to while the holding
        // shrank, and the bound loosened for as long as a claim was
        // outstanding (D17). Released, the next payment reopens it on the
        // holding then: an entry enqueued behind it (`_enqueue`), or the
        // buffer's next inflow at the next drain (above). Outside a freeze a
        // walk reaches the tail only past paid entries and such claims; under
        // one, a frozen release ahead of the first such claim (`head < stop`,
        // which a cursor past the head always is) keeps the base, as a queue
        // still open for that release. A frozen release behind it does not,
        // and is metered on the base read when it is next payable, which is
        // never above the one released.
        if (i == tail && !(isFrozen && head < stop)) queueBase = 0;
    }

    /// One payment out of the queue. Returns true if the entry is still owed something.
    function _pay(uint256 i, QueueEntry storage q, EntryKind kind, uint256 pay, uint256 nowEpoch)
        private
        returns (bool stillOwed)
    {
        // Truncates. The unpaid fraction of a share stays here as excess and is
        // divided at the next sweep.
        uint256 units = _toUnits(pay);
        // What the entry is still owed after this payment: shares for a release
        // or a recovery share, units for a loss settlement.
        uint256 remaining;
        if (kind == EntryKind.Loss) {
            // A loss settlement is owed units fixed at the determination, never
            // the shares that happened to cover them (whitepaper §5.2, yellow
            // paper §1.4 `settleLoss`; D13, left open by the shares-based queue
            // of 2026-09-22, E8): taken from the buffer now, at the rate of this
            // payment, so a negative rebase while it waited defers nothing and
            // reduces nothing, and a positive one pays no more than was owed.
            uint256 due = q.unitsDue - q.unitsPaid;
            if (units > due) units = due;
            bufferShares -= pay;
            lossOwedUnits -= units;
            remaining = due - units;
        } else {
            q.sharesRemaining -= pay;
            queuedShares -= pay;
            if (kind == EntryKind.Release) queuedReleaseShares -= pay;
            remaining = q.sharesRemaining;
        }
        q.unitsPaid += units;
        // A refused payment is credited to its payee and the walk goes on. A
        // revert here would stop the drain at this entry in every epoch, and
        // every release, loss settlement and recovery share with it, since each
        // drains on its way out; a loss entry is never dropped, so for ever.
        // The payment has used its part of the bound either way.
        if (!_push(q.recipient, units)) _credit(q.recipient, pay, units);
        emit EntryPaid(i, q.ref, nowEpoch, kind, units, pay, remaining);

        if (remaining != 0) return true;

        if (kind == EntryKind.Release) {
            emit Released(
                q.ref,
                q.recipient,
                q.claimNonce,
                q.unitsPaid,
                ArkStakeIds.releasedLeaf(address(this), q.ref, q.claimNonce)
            );
        } else {
            emit EntrySettled(i, q.ref, q.recipient, kind, q.unitsPaid);
        }
        delete _queue[i];
        return false;
    }

    /* ------------------------------------------------------------------ */
    /* Refused payments                                                    */
    /* ------------------------------------------------------------------ */

    /**
     * Pay `units` of the asset to `to`, reporting a refusal instead of
     * reverting with it.
     *
     * A payee the asset refuses is an ordinary case: stETH reverts
     * `TRANSFER_TO_STETH_CONTRACT` for its own address, a blocklist is written
     * by an outside party after the payee was committed on QRL, and a token
     * may refuse a transfer of zero. The call's result is read as SafeERC20
     * reads it — success with no return data from a contract (USDT returns
     * nothing), or a first word of exactly one — and anything else is a
     * refusal, including `false`.
     *
     * A zero payment is not attempted and is not a refusal: nothing is owed
     * that a transfer could carry, and a token that reverts on zero would
     * otherwise be credited a zero forever.
     *
     * Only the first word of return data is copied, so a token cannot make a
     * payment cost more than its own execution by returning a large buffer.
     * The call forwards all but 1/64 of the gas (EIP-150): a token hook that
     * burns what it is given fails as a refusal, and the remainder finishes
     * the walk if the caller sent enough.
     */
    function _push(address to, uint256 units) private returns (bool ok) {
        if (units == 0) return true;
        bytes memory data = abi.encodeCall(IERC20.transfer, (to, units));
        address token = address(ASSET);
        assembly ("memory-safe") {
            ok := call(gas(), token, 0, add(data, 0x20), mload(data), 0, 0x20)
            if ok {
                switch returndatasize()
                case 0 {
                    ok := gt(extcodesize(token), 0)
                }
                default {
                    ok := and(gt(returndatasize(), 0x1f), eq(mload(0), 1))
                }
            }
        }
    }

    /// Record a refused payment of `shares` (worth `units` now) to `to`.
    function _credit(address to, uint256 shares, uint256 units) private {
        owedShares[to] += shares;
        unclaimedShares += shares;
        emit PaymentDeferred(to, units, shares);
    }

    /**
     * Pay a payee what the asset refused it earlier. Any sender; the payee is
     * the only possible recipient, so the caller chooses when and never where.
     *
     * Outside the per-epoch bound, because the credited shares already used
     * their part of it in the epoch they left the queue. Not stopped by the
     * freeze or the declaration: a credit is a payment already made, held only
     * because the asset would not carry it. A payee the asset will never pay —
     * the stETH contract itself — keeps its credit for ever and blocks nobody,
     * which is the whole point of the credit.
     *
     * Reverts on a refusal rather than crediting again, so the credit is
     * untouched and the payee can be paid later.
     */
    function withdrawOwed(address recipient) external nonReentrant returns (uint256 units) {
        uint256 shares = owedShares[recipient];
        // Truncates. The fraction of a unit below the last whole one becomes
        // excess and is divided at the next sweep, as a queue payment's does.
        units = _toUnits(shares);
        if (units == 0) revert NothingOwed(recipient);
        owedShares[recipient] = 0;
        unclaimedShares -= shares;
        if (!_push(recipient, units)) revert PaymentRefused(recipient);
        emit OwedWithdrawn(recipient, units, shares);
    }

    /* ------------------------------------------------------------------ */
    /* The loss settlement and the recovery share                          */
    /* ------------------------------------------------------------------ */

    /**
     * Pay the buffer's part of a trigger-1 determination for one position, by
     * the loss settlement of whitepaper §3.5. Any sender. whitepaper §5.2,
     * yellow paper §1.4 `settleLoss`.
     *
     * Bounded by construction to `bufferShares`: it draws on no position's
     * recorded principal, no premium and nothing in transit, so a forged loss
     * settlement moves at most the buffer — which is first loss and belongs to
     * no position. The position, the destination its bound beneficiary named
     * on QRL, and the quantity are all inside the leaf.
     *
     * Settles in the exit queue under the per-epoch bound, and is not stopped
     * by the freeze or by the declaration: it is a determined settlement, and
     * whitepaper §4.7 says a settlement already determined is not reduced.
     * Nothing here refuses it after closure either, since roots are still
     * admitted then and a determination made before the declaration may be
     * sealed after it.
     */
    function settleLoss(
        bytes32 determinationId,
        bytes32 stakeAssetId,
        address destination,
        uint256 quantity,
        uint64 epoch,
        bytes32[] calldata proof
    ) external nonReentrant {
        if (destination == address(0)) revert ZeroAddress();
        if (quantity == 0) revert ZeroValue();

        // Bound to this escrow (yellow paper §2.2 `lossLeafKey`, D10): one
        // relay serves every escrow on the chain, each with its own spent map,
        // and a leaf that named no escrow paid one determination once per
        // escrow, each time out of that escrow's buffer (R25). The check of
        // 2026-09-22 that the position was anchored here is what the binding
        // replaced. Built by the relay over the caller and checked against the
        // root of `epoch` there (EC phase 2, 2026-09-30, for the Lido form's
        // bytes, as R3-07 did for the allocation).
        bytes32 leaf = RELAY.lossReceipt(epoch, determinationId, stakeAssetId, destination, quantity, proof);
        // Consumed against the leaf itself, not against the carrying root. A
        // loss settlement has no claim nonce and no position stake to zero, so
        // keyed by the carrying root the same leaf sealed again in a later root
        // would pay twice. The leaf already names the determination, the
        // position, the destination and the quantity — one payment exactly,
        // since a determination settles each affected position once — so
        // adding `determinationId` to the key again would add nothing.
        if (_spent[leaf]) revert ProofSpent(leaf);

        _spent[leaf] = true;
        // Owed in units and drawn from the buffer only when paid (D13, D17):
        // a buffer short of the quantity no longer refuses the settlement.
        lossOwedUnits += quantity;
        uint256 index = _enqueue(EntryKind.Loss, stakeAssetId, destination, 0, 0, quantity);
        emit LossQueued(determinationId, stakeAssetId, destination, quantity, 0, index);

        _drain(DRAIN_ON_CONSUME);
    }

    /**
     * Pay one recipient its share of a realised escrow, by the recovery share of
     * whitepaper §3.5. Any sender. whitepaper §5.4, yellow paper §1.4
     * `releaseShare` and §4.3.
     *
     * Not gated on closure in either direction. A recovery follows the
     * declaration — after which roots are still admitted, precisely so this can
     * run — or the censorship ground of whitepaper §3.6, on which the relay was
     * never closed. The receipts exist only after an opening determination on
     * QRL, which is the whole of the authority; the escrow adds none.
     *
     * THE RECOVERED POOL, AND WHAT A SHARE MAY DRAW ON
     * ------------------------------------------------
     * Everything outside the buffer and the payable queue:
     * `positionShares + auctionShares`, after `_reclaimReleases` has returned
     * any release stranded by the declaration, and the stabilization reserve,
     * to `positionShares`. That is the positions, the stranded releases, the
     * reserve and the auction pot. Before the declaration — the censorship
     * ground — the reserve stays out of reach (I39). Drawn from the positions
     * first and the pot last: before a declaration a selected lot may still be
     * claimed out of the pot, and after one `claimPremium` is closed, the pot
     * is inert and the order changes nothing.
     *
     * The leaf binds this escrow and the successor state it is paid on
     * (`successorId`, whitepaper §5.4, I36): QRL runs one monotone residual
     * across up to three admitted successors in admission order, and a share
     * sealed for one successor is another leaf on every other, so it is spent
     * once and on one fork. The escrow adds nothing to that order; it pays the
     * leaf it is shown.
     *
     * yellow paper §1.4 bounds the quantity by "the holding of the asset
     * outside bufferBalance". This is tighter by the payable queue: a loss
     * settlement, another recipient's share, or — on the censorship ground — a
     * release still waiting to pay are entitlements already determined, and a
     * share drawn on them would pay one recipient out of another's settlement.
     *
     * The unbonding period does not apply (yellow paper §4.3, Pace); the
     * per-epoch bound does.
     */
    function releaseShare(
        bytes32 successorId,
        bytes32 recoveryId,
        bytes32 recipient,
        address destination,
        uint256 quantity,
        uint64 epoch,
        bytes32[] calldata proof
    ) external nonReentrant {
        if (destination == address(0)) revert ZeroAddress();
        if (quantity == 0) revert ZeroValue();

        // Over this escrow, built and proven by the relay as `settleLoss`'s is.
        bytes32 leaf = RELAY.shareReceipt(epoch, successorId, recoveryId, recipient, destination, quantity, proof);
        // Keyed by the leaf, for the reason `settleLoss` gives: it names one
        // recipient's one share of one recovery on one successor exactly. QRL
        // must therefore seal one share per recipient per recovery — a holder
        // of two classes is paid their sum — or the second of two identical
        // leaves is refused.
        if (_spent[leaf]) revert ProofSpent(leaf);

        // Before the pool is read, so it includes yield accrued up to now and
        // any release stranded by the declaration.
        _settle();
        _reclaimReleases();

        // Rounds up, so the pool is debited at least what the queue will pay.
        uint256 shares = _toSharesUp(quantity);
        {
            uint256 fromPositions = positionShares;
            uint256 pool = fromPositions + auctionShares;
            if (shares > pool) revert ShareExceedsHolding(shares, pool);
            if (shares <= fromPositions) {
                positionShares = fromPositions - shares;
            } else {
                positionShares = 0;
                auctionShares -= shares - fromPositions;
            }
        }

        _spent[leaf] = true;
        uint256 index = _enqueue(EntryKind.Recovery, recoveryId, destination, 0, shares, 0);
        emit ShareQueued(recoveryId, recipient, destination, quantity, shares, index);

        _drain(DRAIN_ON_CONSUME);
    }

    /* ------------------------------------------------------------------ */
    /* The premium swap                                                    */
    /* ------------------------------------------------------------------ */

    /**
     * Publish the premium this escrow offers for the epoch in progress, for the
     * forward path to carry to QRL. Any sender, once per epoch, the caller
     * receives nothing.
     *
     * Not before `ADMISSION_WINDOW + EVM_CLAIM_WINDOW` into the epoch. The lots
     * of the offering whose quote window closed as this epoch began may be
     * claimed until then; read later, the pot counts nothing they can still
     * take, and the swap on QRL has only the previous offering's selected lots
     * to subtract (whitepaper §4.7). Settled first, so the pot includes the
     * premium of yield accrued up to now.
     */
    function offerPremium() external nonReentrant returns (uint256 epoch, uint256 shares, uint256 units) {
        if (_closed()) revert SettlementClosed();
        epoch = ArkEpochLib.current();
        if (_offerMark == epoch + 1) revert AlreadyOffered(epoch);
        uint256 opensAt = ArkEpochLib.startOf(epoch) + ArkEpochLib.ADMISSION_WINDOW + ArkEpochLib.EVM_CLAIM_WINDOW;
        if (block.timestamp < opensAt) revert OfferNotOpen(opensAt);
        _settle();
        shares = auctionShares;
        if (shares == 0) revert ZeroValue();
        // Truncates, so the rate QRL prices the reserve at never overstates a share.
        units = _toUnits(shares);
        _offerMark = epoch + 1;
        emit PremiumOffered(
            epoch,
            shares,
            units,
            ArkStakeIds.premiumOfferLeaf(block.chainid, address(this), address(ASSET), epoch, shares, units)
        );
    }

    /**
     * Publish this escrow's buffer for the forward path to carry to QRL. Any
     * sender, once per epoch, the caller receives nothing, and it moves no
     * value: the one fact it states is `bufferShares` valued in units.
     *
     * The buffer stands in the denominator of utilisation on QRL beside bond
     * principal (whitepaper §4.3: `u = K / (N^cap_30 + buffer_orig)`), and QRL
     * cannot read this chain; `ArkStakeRegistry.recordBuffer` takes the leaf
     * against the forward root of `epoch`, only ever newer than the last.
     * Settled first, so the buffer share of yield accrued up to now is in it.
     * Not refused after the declaration: the buffer is still capital, and the
     * report is a statement, not a flow.
     */
    function reportBuffer() external nonReentrant returns (uint256 epoch, uint256 units) {
        epoch = ArkEpochLib.current();
        if (_bufferMark == epoch + 1) revert AlreadyReported(epoch);
        _settle();
        uint256 shares = bufferShares;
        // Truncates, so QRL never counts a fraction of a unit the buffer does not hold.
        units = _toUnits(shares);
        // Net of the loss settlements waiting on it (D17): capital the positions
        // already determined against it is not capital that stands for the book.
        uint256 owed = lossOwedUnits;
        units = units > owed ? units - owed : 0;
        _bufferMark = epoch + 1;
        emit BufferReported(
            epoch,
            shares,
            units,
            ArkStakeIds.bufferLeaf(block.chainid, address(this), address(ASSET), epoch, units)
        );
    }

    /**
     * Pay one lot of the premium share selected on QRL to the solver the
     * premium lock names, against the preimage of its hashlock. Any sender.
     * Whitepaper §3.5 and §4.7, yellow paper §1.4 `claimPremium`.
     *
     * One call and no lock before it: the lot is paid from the auction pot the
     * moment its preimage is shown, so a lot left unclaimed moves nothing and
     * needs no refund here. The claim publishes the preimage in
     * `PremiumClaimed`, and anyone presents it on QRL, where the solver's QRL
     * goes to the delivered-proceeds account and nowhere else; that lock
     * outlasts `evmExpiry` by the QRL claim margin (I31), so whoever takes the
     * lot here has already paid for it.
     *
     * Paid in shares, as the lot was quoted, not in units: what the solver
     * bought is those shares, so a rebase since the quote is the solver's, as
     * it is for any holder of the asset.
     *
     * Bounded by construction to `auctionShares`, as the premium settlement it
     * replaces was: it moves no principal, no buffer and nothing in transit, so
     * a forged lock moves at most the premium already held. Consumed against
     * the leaf itself rather than the carrying root, because a lock has no
     * nonce: sealed again in a later root, it would otherwise pay twice. The
     * lot id is in the leaf, so two lots are two leaves.
     *
     * Closed at the declaration to every lock sealed after the root that
     * carried the close: quantity not yet settled stays in the escrow and
     * forms part of the recovered pool (whitepaper §5.4); the solver's QRL is
     * refunded on QRL at its expiry. A lock sealed in that root or an earlier
     * one is still paid until its `evmExpiry` (OC round 2026-10-03,
     * OC-LEGA-03): its lot was selected and paid for on QRL before the
     * declaration reached this chain, and a close carried in front of the
     * solver's claim left its preimage public and its QRL claimable by anyone
     * with no shares paid for it. The relay reads the closure, in
     * `premiumReceipt`. Not stopped by the freeze, which holds releases of
     * principal and nothing else.
     */
    function claimPremium(PremiumLock calldata payload, uint64 epoch, bytes32[] calldata proof, bytes32 secret)
        external
        nonReentrant
    {
        if (payload.recipient == address(0)) revert ZeroAddress();
        if (payload.shares == 0) revert ZeroValue();
        if (block.timestamp >= payload.evmExpiry) revert PremiumExpired(payload.evmExpiry);
        if (sha256(abi.encodePacked(secret)) != payload.hashlock) revert WrongPreimage(payload.hashlock);

        // Over this escrow and its asset, built and proven by the relay as `settleLoss`'s is.
        bytes32 leaf = RELAY.premiumReceipt(epoch, address(ASSET), payload, proof);
        if (_spent[leaf]) revert ProofSpent(leaf);

        // Before the pot is read, so it includes the premium accrued up to now.
        _settle();
        if (payload.shares > auctionShares) revert PremiumExceedsPot(payload.shares, auctionShares);

        _spent[leaf] = true;
        auctionShares -= payload.shares;
        // Truncates. The fraction of a unit below the last whole one becomes
        // excess and is divided at the next sweep. A recipient the asset
        // refuses is credited, as a queue payment is: the solver paid on QRL,
        // so the quantity is theirs whether or not the asset carries it today.
        uint256 units = _toUnits(payload.shares);
        if (!_push(payload.recipient, units)) _credit(payload.recipient, payload.shares, units);

        emit PremiumClaimed(payload.lotId, secret);
    }

    /* ------------------------------------------------------------------ */
    /* The allocation, arriving over the relay                             */
    /* ------------------------------------------------------------------ */

    /**
     * Record the shares for an epoch, proven against that epoch's root.
     *
     * Any sender; the proof is the authority and the caller receives nothing.
     *
     * The bound, stated exactly: a forged allocation misallocates at most one
     * settlement interval's yield between the positions (committed or not),
     * the buffer, the reserve, the auction pot and the operations destination.
     * The first four stay here;
     * the fourth is fixed at construction and readable in the runtime code; and
     * the pot leaves only against a premium lock leaf and its preimage. **A forged allocation
     * cannot send one wei to whoever forged it.** It is not bounded in the
     * *base*: the unit is one settlement interval, which a permissionless sweep
     * keeps short but nothing forces short.
     */
    function recordEpochAllocation(uint256 epoch, AllocationRates calldata rates, bytes32[] calldata proof) external nonReentrant {
        if (_closed()) revert ReleaseClosed();

        uint256 nowEpoch = ArkEpochLib.current();
        // Crediting value is a gift and needs no permission, but choosing which
        // epoch it applies to is not, because it moves value between two sets
        // of holders.
        if (epoch > nowEpoch) revert FutureEpochAllocation(epoch, nowEpoch);

        // Allocations only move forward. This refuses a second write for an epoch
        // — which would reprice a sweep already taken — and refuses backfilling
        // an older allocation over a newer one.
        if (_alloc.set && epoch <= _alloc.epoch) revert AllocationNotForward(_alloc.epoch, epoch);

        // whitepaper §6.3's ranges, the whole of gross yield, the leaf over this
        // escrow and its membership, checked by the relay (R3-07, 2026-09-30):
        // the ranges stay fixed in code there, so control of the relay still
        // does not confer control of the arithmetic, and the Lido form keeps
        // the bytes for the reserve gate and the seed return.
        (bytes32 leaf, uint256 word) = RELAY.allocationReceipt(epoch, rates, proof);

        // Settled first, at the rates in force until now (OC round 2026-10-03,
        // OC-LEGA-04): the yield accrued since the last settlement, and the
        // reserve's close-out of an ended epoch, belong to the allocation they
        // accrued under. Without it whoever ordered a sweep against this call
        // chose the rates that interval was divided at.
        _settle();

        // The record `Allocation{epoch, rates..., set: true, stepQueued}` as
        // the one storage word the relay packed it into (EC phase 2,
        // 2026-09-30): packing its twelve fields here cost the Lido form some
        // 450 bytes. The relay is fixed at construction, as the membership
        // check it already performs is, and `recordedAllocation` reads the
        // record back field by field through the compiler's own layout.
        assembly ("memory-safe") {
            sstore(_alloc.slot, word)
        }

        emit AllocationRecorded(epoch, leaf);
    }

    /**
     * The rates in force for the next sweep.
     *
     * An unrecorded allocation charges **no premium at all**, no levy and holds
     * no juror fraction. The failure mode of a missing rate is then a coupon
     * shortfall, which whitepaper §4.7 already specifies a response to, rather
     * than an over-charge on the anchored positions, which nothing specifies a
     * response to. The residual stays with the staker.
     *
     * After closure sigma, the juror fraction and the levy are forced to zero.
     * The premium stream ends at the declaration (whitepaper §3.5), the swap
     * that would carry either out of the pot is closed, and a reserve that
     * smooths a premium nobody pays has nothing to fund; holding them would
     * only move yield out of the positions into pots nothing can pay. The
     * operations share keeps its size and changes its destination, to the
     * buffer (`_settle`, whitepaper §4.2, D20).
     */
    function _allocInForce(bool isClosed) internal view returns (AllocationRates memory r) {
        Allocation memory a = _alloc;
        if (!a.set) {
            r.bufferBps = BUFFER_MIN_BPS;
            r.operationsBps = OPS_MIN_BPS;
            return r;
        }
        r.bufferBps = a.bufferBps;
        r.operationsBps = a.operationsBps;
        r.sigmaTargetBps = a.sigmaTargetBps;
        r.coveredBps = a.coveredBps;
        r.psrCapBps = a.psrCapBps;
        r.commitTermEpochs = a.commitTermEpochs;
        if (isClosed) return r;
        r.sigmaBps = a.sigmaBps;
        r.jurorFeeShareBps = a.jurorFeeShareBps;
        r.levyBps = a.levyBps;
    }

    /* ------------------------------------------------------------------ */
    /* The sweep                                                           */
    /* ------------------------------------------------------------------ */

    /**
     * Divide the yield. whitepaper §4.2, yellow paper §1.4 `sweep()`.
     *
     * Any sender, and the caller receives nothing: the one transfer it makes
     * goes to a destination fixed at construction, and everything else stays
     * here. Invariant I3.
     */
    function sweep() external nonReentrant {
        if (_settle() == 0) revert NothingToSweep();
    }

    /**
     * THE TWO-TERM YIELD EXPRESSION, AND WHY ONE TERM IS NOT ENOUGH
     * -------------------------------------------------------------
     * For a rebasing asset principal is recorded in shares, "otherwise a rebase
     * presents principal as yield and the sweep pays it away" (yellow paper
     * §2.1, `shareAccounting`). Recording shares creates the opposite error:
     * for stETH the escrow's *share* balance never moves, so excess shares are
     * identically zero and the premium could never be collected. For a
     * rebasing LST the yield *is* the rebase, appearing as appreciation of
     * shares the positions already hold.
     *
     * So there are two terms. `excessShares` catches donations and the yield of
     * a non-rebasing asset; the rate term catches the rebase. For a
     * non-rebasing asset the rate never moves and this reduces to "the balance
     * in excess of recorded principal" of whitepaper §3.2.
     *
     * WHO THE RATE TERM IS MEASURED ON
     * --------------------------------
     * `positionShares` alone. The buffer, the auction pot, the reserve and the
     * queue are held in shares too, and each keeps its own appreciation: the
     * buffer, the pot and the reserve grow in units, and notional in transit
     * "still earns the origin yield for its own account" (whitepaper §3.3) and
     * is charged no premium (I18). All of them are in `owed`, so their shares
     * are never read as excess.
     *
     * A NEGATIVE REBASE IS NOT YIELD, AND IS NOT CHARGED TWICE
     * --------------------------------------------------------
     * The subtraction is guarded — unguarded it would panic and brick every
     * sweep exactly when the book is impaired. `lastRate` is left standing
     * rather than lowered, so the recovery back to the old rate is not
     * collected as though it were yield.
     *
     * THE RESERVE AND THE COMMITTED POSITIONS (whitepaper §4.4, I39)
     * --------------------------------------------------------------
     * Every position is charged the spot premium and the levy; the levy is
     * credited to the reserve first, then each live cohort of committed
     * positions is owed `psrTopUpUnits` — its rung's gap to the spot rung,
     * times cover, of its part of the gross — which the reserve pays as far as
     * it holds and this sweep's premium pays the rest of. So a committed
     * position pays its committed rung whatever happens this epoch; the pot
     * receives the spot premium wherever the reserve met the gap and less by
     * exactly the shortfall where it did not, which reprices every commitment
     * from the next epoch. The top-up reaches a cohort as stake (`_payTopUps`), so
     * nothing walks its positions.
     */
    function _settle() internal returns (uint256 grossUnits) {
        {
            uint256 nowEpoch = ArkEpochLib.current();
            if (_psrEpoch != nowEpoch) _closeReserveEpoch(nowEpoch);
        }
        uint256 nowRate = _toUnits(RATE_ONE);

        // Scoped so these die before the split below; the fix for stack depth is
        // fewer live locals rather than viaIR, because the security argument
        // here is about bytecode somebody can read.
        {
            uint256 held = _sharesHeld();
            uint256 owed = positionShares + bufferShares + auctionShares + queuedShares + unclaimedShares + psrShares;
            uint256 excessShares = held > owed ? held - owed : 0;

            uint256 rateGainUnits;
            if (nowRate > lastRate && positionShares != 0) {
                // Truncates; the fraction of a unit left is picked up by the
                // next settlement, when it is no longer a fraction.
                rateGainUnits = (positionShares * (nowRate - lastRate)) / RATE_ONE;
            }
            grossUnits = _toUnits(excessShares) + rateGainUnits;
        }

        if (grossUnits == 0) {
            // Still advance the rate on a settlement that finds nothing, so a book
            // opening before any yield exists does not later collect the whole
            // history as one gain.
            if (nowRate > lastRate) lastRate = nowRate;
            return 0;
        }

        Split memory s = _split(grossUnits);
        _psrGross += grossUnits;
        _psrLevy += _toShares(s.levyUnits);
        _reserveDraw(s, grossUnits);

        // Before closure, a refusal is credited rather than reverted: the
        // destination is immutable, and every anchor, release and recovery
        // share settles first, so a destination the asset refuses — a
        // blocklisted address, or the asset's own — would otherwise stop all of
        // them for good. Credited at the truncated share count, so the
        // destination is owed at most one wei-share less than it was cut and
        // the residual stays with the staker. After closure nothing goes there.
        if (!s.closed) {
            uint256 opsPaid = s.operationsUnits - s.jurorFeeUnits;
            if (!_push(OPERATIONS_DESTINATION, opsPaid)) {
                _credit(OPERATIONS_DESTINATION, _toShares(opsPaid), opsPaid);
            }
        }

        // Re-derived from the balance after the transfer rather than tracked, so
        // the six pots sum to `_sharesHeld()` exactly and every rounding
        // remainder lands with the staker. The clamps are defensive: they bind
        // only at one wei-share of rounding, and in the order that protects what
        // does not belong to the positions — the queue and the credits first,
        // then the buffer, the reserve, then the pot.
        uint256 avail = _sharesHeld();
        {
            uint256 reserved = queuedShares + unclaimedShares;
            avail = avail > reserved ? avail - reserved : 0;
        }

        // From closure the operations share is buffer inflow (whitepaper §4.2, D20).
        uint256 newBuffer = bufferShares + _toSharesUp(s.bufferUnits + (s.closed ? s.operationsUnits : 0));
        if (newBuffer > avail) newBuffer = avail;
        avail -= newBuffer;

        // The levy in, the reserve's part of the top-up out; truncating, the
        // residual with the staker.
        uint256 newPsr = psrShares + _toShares(s.levyUnits);
        {
            uint256 out = _toSharesUp(s.psrPaidUnits);
            newPsr = newPsr > out ? newPsr - out : 0;
        }
        if (newPsr > avail) newPsr = avail;
        avail -= newPsr;

        // Truncates; the residual stays with the staker. What the reserve could
        // not pay of the top-up stays with the positions it is owed to.
        uint256 newAuction = auctionShares + _toShares(s.premiumUnits - s.unfundedUnits + s.jurorFeeUnits);
        if (newAuction > avail) newAuction = avail;
        avail -= newAuction;

        bufferShares = newBuffer;
        psrShares = newPsr;
        auctionShares = newAuction;
        positionShares = avail;

        if (s.demandUnits != 0) _payTopUps(grossUnits, s.psrPaidUnits + s.unfundedUnits);

        if (nowRate > lastRate) lastRate = nowRate;

        emit Swept(s.epoch, grossUnits, s.premiumUnits, s.operationsUnits, s.bufferUnits, s.stakerUnits);
        if (s.premiumUnits != 0 || s.jurorFeeUnits != 0) {
            emit PremiumHeld(s.epoch, s.premiumUnits, s.jurorFeeUnits, s.sigmaBps, s.jurorFeeShareBps);
        }
        if (s.levyUnits != 0 || s.demandUnits != 0) {
            emit ReserveSwept(s.epoch, s.levyUnits, s.demandUnits, s.psrPaidUnits);
        }
    }

    /// The streams of whitepaper §4.2 and the reserve's flows, in memory so the caller keeps its stack.
    struct Split {
        uint256 epoch;
        uint256 premiumUnits;
        uint256 operationsUnits;
        uint256 jurorFeeUnits;
        uint256 bufferUnits;
        uint256 levyUnits;
        uint256 stakerUnits;
        uint256 demandUnits;
        uint256 psrPaidUnits;
        uint256 unfundedUnits;
        uint16 sigmaBps;
        uint16 jurorFeeShareBps;
        bool closed;
    }

    function _split(uint256 grossUnits) private view returns (Split memory s) {
        s.closed = _closed();
        AllocationRates memory r = _allocInForce(s.closed);
        s.sigmaBps = r.sigmaBps;
        s.jurorFeeShareBps = r.jurorFeeShareBps;
        s.epoch = ArkEpochLib.current();

        // Every one of these truncates and the residual falls to the staker,
        // the convention whitepaper §4.1 fixes.
        s.premiumUnits = (grossUnits * r.sigmaBps) / BPS;
        s.operationsUnits = (grossUnits * r.operationsBps) / BPS;
        s.bufferUnits = (grossUnits * r.bufferBps) / BPS;
        s.levyUnits = (grossUnits * r.levyBps) / BPS;

        // A fraction of the operations share, not another stream. Truncates,
        // and the residual stays with the operations destination, which is the
        // share it was carved from.
        s.jurorFeeUnits = (s.operationsUnits * r.jurorFeeShareBps) / BPS;

        // By subtraction and never from a rate of its own, so the shares sum to
        // the gross exactly (whitepaper §4.2). `recordEpochAllocation` refuses
        // a set of shares summing above BPS, so this cannot underflow.
        s.stakerUnits = grossUnits - s.premiumUnits - s.operationsUnits - s.bufferUnits - s.levyUnits;
    }

    /**
     * What the committed cohorts are owed this sweep, and who pays it: the
     * reserve, holding its balance plus this sweep's levy, pays what it holds
     * (`psrEpoch` of the model, the levy credited before the top-up), and the
     * premium the rest. A shortfall reprices every commitment from the next
     * epoch (whitepaper §4.4). Prunes the cohorts that can owe nothing again.
     */
    function _reserveDraw(Split memory s, uint256 grossUnits) private {
        if (s.closed) return;
        (uint256 live,) = _prune(s.epoch);
        if (live == 0) return;
        uint256 demand = _demandOf(grossUnits);
        if (demand == 0) return;
        uint256 available = _toUnits(psrShares) + s.levyUnits;
        uint256 paid = demand < available ? demand : available;
        uint256 unfunded = demand - paid;
        // Never more than this sweep's premium: binds only on a leaf whose premium
        // sits below the target it names, and then the top-up is paid short.
        if (unfunded > s.premiumUnits) unfunded = s.premiumUnits;
        s.demandUnits = demand;
        s.psrPaidUnits = paid;
        s.unfundedUnits = unfunded;
        if (unfunded != 0 && _voidEpoch <= s.epoch) {
            _voidEpoch = uint64(s.epoch + 1);
            emit CommitmentsRepriced(s.epoch + 1);
        }
    }

    /// Drop the cohorts that are over, void, or empty past their epoch. Returns how many remain, and their stake.
    function _prune(uint256 nowEpoch) private returns (uint256 n, uint256 committed) {
        n = _liveCohorts.length;
        uint256 v = _voidEpoch;
        uint256 i;
        while (i < n) {
            Cohort storage c = _cohorts[_liveCohorts[i]];
            bool over = nowEpoch >= c.untilEpoch || (v != 0 && c.anchorEpoch < v && nowEpoch >= v)
                || (c.stake == 0 && nowEpoch > c.anchorEpoch);
            if (over) {
                _liveCohorts[i] = _liveCohorts[n - 1];
                _liveCohorts.pop();
                --n;
            } else {
                committed += c.stake;
                ++i;
            }
        }
    }

    /// The top-up owed across the live cohorts at `grossUnits`.
    function _demandOf(uint256 grossUnits) private view returns (uint256 total) {
        uint256 n = _liveCohorts.length;
        uint256 T = totalStake;
        uint256 target = _alloc.sigmaTargetBps;
        uint256 covered = _alloc.coveredBps;
        for (uint256 i; i < n; ++i) total += _cohortDemand(_cohorts[_liveCohorts[i]], target, covered, grossUnits, T);
    }

    /**
     * Pay the top-up, `budget` in all, cohort by cohort in list order. Each
     * cohort's part reaches it as stake, priced on the positions before the
     * top-up joined them, so every other position's claim is unchanged and the
     * cohort's rises by what it is paid; its multiplier moves in proportion,
     * which is how each of its positions takes its part without being touched.
     * Every division truncates, toward the pool: the stake minted never claims
     * more than the top-up paid in.
     */
    function _payTopUps(uint256 grossUnits, uint256 budget) private {
        uint256 n = _liveCohorts.length;
        uint256 T = totalStake;
        uint256 target = _alloc.sigmaTargetBps;
        uint256 covered = _alloc.coveredBps;
        // The positions before the top-up joined them: the price every mint is at.
        uint256 base;
        {
            uint256 rebate = _toShares(budget);
            base = positionShares > rebate ? positionShares - rebate : 0;
        }
        uint256 minted;
        for (uint256 i; i < n; ++i) {
            Cohort storage c = _cohorts[_liveCohorts[i]];
            uint256 owed = _cohortDemand(c, target, covered, grossUnits, T);
            if (owed > budget) owed = budget;
            if (owed == 0) continue;
            budget -= owed;
            uint256 add = (_toShares(owed) * (T + STAKE_OFFSET)) / (base + 1);
            uint256 before = c.stake;
            c.mult = uint128((uint256(c.mult) * (before + add)) / before);
            c.stake = uint128(before + add);
            minted += add;
        }
        totalStake = T + minted;
    }

    /**
     * One cohort's top-up at `grossUnits`: `psrTopUpUnits` of the model on its
     * part of the gross, the spot rung's gap over its committed rung times
     * cover. Zero where the stage has not stepped above it — a commitment is a
     * smoothing of the path, never a discount on the destination, and a
     * committed rung above the spot one pays spot. Truncates, so the demand is
     * never overstated.
     */
    function _cohortDemand(Cohort storage c, uint256 target, uint256 covered, uint256 grossUnits, uint256 T)
        private
        view
        returns (uint256)
    {
        uint256 commit = c.sigmaCommitBps;
        if (target <= commit || T == 0 || c.stake == 0) return 0;
        uint256 y = (grossUnits * c.stake) / T;
        return ((target - commit) * covered * y) / (BPS * BPS);
    }

    /**
     * The end of the reserve's epoch, at the first touch of a later one
     * (whitepaper §4.2, §4.4, I39; the model's `psrEpoch`):
     *
     *  - its gross yield per share of the book it accrued on is recorded
     *    (the model's `psrEpochRate`, `floor(gross * 1e18 / book)`, the book
     *    being `positionShares` at the close);
     *  - the rate is the mean of the last `commitTermEpochs` of those, or of
     *    every closed epoch while fewer have closed, a quiet epoch entering at
     *    zero (`psrTrailingRate`, QL-24), and the audit's where the mean is
     *    zero. It is kept (`_trailRate`): the commitment gate reads the same
     *    rate, so a reserve at its cap admits commitment of the whole book;
     *  - the cap is `ceil(psrCapBps * rate * book / (BPS * 1e18))`
     *    (`psrCapAtRate`); the prime still unreplaced and still held stands
     *    above it, what it does not admit is credited to the buffer, and the
     *    epoch's levy replaces that much of the prime (`primeUnreplaced`,
     *    PV-04).
     *
     * Epochs skipped between two touches are closed at once, on the window
     * ending at the last of them. The epoch's rate and the mean truncate;
     * the cap rounds up, toward the reserve and the committed positions it
     * tops up, against the buffer, so that the reserve at its cap meets the
     * gate exactly.
     *
     * Not after the declaration: the reserve then belongs to the recovered
     * pool, which `_reclaimReleases` folds it into, and a cap moving it to the
     * buffer first would take it from the positions that funded it.
     */
    function _closeReserveEpoch(uint256 nowEpoch) private {
        uint256 e = _psrEpoch;
        if (e != 0 && !_closed()) {
            uint256 book = positionShares;
            if (book != 0) {
                // Clamped at PSR_RATE_CLAMP times the audit's reference rate
                // (re-audit 2026-09-30, ORIGIN-04; the model's `psrEpochRate`):
                // on a book of a few base units a donation read thousands of
                // times it and closed the gate for the whole trailing window.
                uint256 r = (_toShares(_psrGross) * RATE_ONE) / book;
                uint256 clamp = PSR_RATE_CLAMP * AUDIT_YIELD_RATE;
                _rateOf[e] = r < clamp ? r : clamp;
            }
            if (_firstClosed == 0) _firstClosed = e;
            uint256 w = _alloc.commitTermEpochs;
            if (w == 0) w = 1;
            uint256 n = nowEpoch - _firstClosed;
            if (n > w) n = w;
            uint256 rate;
            for (uint256 i = 1; i <= n; ++i) rate += _rateOf[nowEpoch - i];
            rate /= n;
            _trailRate = rate;
            if (rate == 0) rate = AUDIT_YIELD_RATE;
            uint256 held = psrShares;
            uint256 prime = primeUnreplaced;
            if (prime > held) prime = held;
            uint256 cap;
            {
                uint256 den = BPS * RATE_ONE;
                cap = (uint256(_alloc.psrCapBps) * rate * book + den - 1) / den;
            }
            uint256 keep = cap + prime;
            if (held > keep) {
                psrShares = keep;
                bufferShares += held - keep;
                emit ReserveCapped(e, cap, held - keep);
            }
            uint256 levy = _psrLevy;
            primeUnreplaced = prime > levy ? prime - levy : 0;
        }
        _psrEpoch = uint64(nowEpoch);
        _psrGross = 0;
        _psrLevy = 0;
    }

    /* ------------------------------------------------------------------ */
    /* Views                                                               */
    /* ------------------------------------------------------------------ */

    function positionOf(bytes32 id) external view returns (Position memory) {
        return _positions[id];
    }

    /// The units a position could claim if it released right now, before a settlement.
    function claimOf(bytes32 id) external view returns (uint256) {
        uint256 stake = _stakeOf(id, _positions[id].stake);
        if (stake == 0) return 0;
        // Truncates, as `release` does.
        return _toUnits((stake * (positionShares + 1)) / (totalStake + STAKE_OFFSET));
    }

    function queueEntry(uint256 index) external view returns (QueueEntry memory) {
        return _queue[index];
    }

    /// A committed position's cohort, or an empty one for a position at spot.
    function cohortOf(bytes32 id) external view returns (uint256 key, Cohort memory cohort) {
        key = _cohortOf[id];
        cohort = _cohorts[key];
    }


    function recordedAllocation() external view returns (Allocation memory) {
        return _alloc;
    }

    function isSpent(bytes32 spendKey_) external view returns (bool) {
        return _spent[spendKey_];
    }


    function nonceOf(address depositor) external view returns (uint64) {
        return _nonceOf[depositor];
    }

    /**
     * What may still leave the escrow in the epoch in progress, in shares. On
     * an empty queue, what would be available if a payment opened it now.
     */
    function releaseBudgetRemaining() external view returns (uint256) {
        uint256 base = queueBase;
        uint256 nowEpoch = ArkEpochLib.current();
        if (base == 0) {
            // What `_enqueue` would open on now.
            base = _sharesHeld();
            if (_baseEpoch == nowEpoch && _epochBase > base) base = _epochBase;
        } else if (_drainEpoch != nowEpoch) {
            // What the first drain of this epoch would ratchet it to.
            uint256 holding = _sharesHeld();
            if (holding > base) base = holding;
        }
        // Truncates, as the drain does, with the same one-share floor.
        uint256 budget = (base * RELEASE_BOUND_BPS) / BPS;
        if (budget == 0) budget = 1;
        uint256 taken = nowEpoch == _drainEpoch ? _takenShares : 0;
        return budget > taken ? budget - taken : 0;
    }

    function sharesHeld() external view returns (uint256) {
        return _sharesHeld();
    }

    function toUnits(uint256 shares) external view returns (uint256) {
        return _toUnits(shares);
    }
}
