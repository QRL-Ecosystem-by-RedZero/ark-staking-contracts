// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

import "./interfaces/IArkEpochRootRelay.sol";
import "./ArkEpochLib.sol";
import "./ArkStakeIds.sol";
import "./WotsVerifier.sol";

/// The one figure the relay reads of the escrow that calls it: whether its anchoring is closed (ORIGIN-01).
interface IAnchoringClosed {
    function anchoringClosed() external view returns (bool);
}

/**
 * QRL epoch roots, as the origin chain admits them. whitepaper §3.6, yellow
 * paper §2.2.
 *
 * The one rule this contract exists to enforce: **an epoch root is admitted
 * only under hash-based one-time signatures of k distinct signers of the
 * active generation of an authority chain fixed at construction, at the leaf
 * index the set shares, one index per root, forward only, and never ahead of
 * the clock** (invariants I16, I17 and I35).
 *
 * NO FUNCTION HERE READS THE SENDER
 * ---------------------------------
 * Admission is the one authority the escrow grants, and it is granted to
 * signatures rather than to an account: every account on this chain signs with
 * secp256k1, which the threat model grants the adversary outright. So anyone
 * may carry a signed root, and an adversary holding every origin-chain key can
 * censor a submission or reorder it but cannot forge one. Suppressing a root
 * means excluding every carrier from block production rather than holding one
 * recovered key (whitepaper §3.6).
 *
 * The declaration and the protective freeze reach this chain the same way — as
 * leaves of a root already admitted, one per escrow since every leaf binds the
 * escrow it acts on (D10), carried by anyone. The proof is the authority and
 * the caller receives nothing.
 *
 * A THRESHOLD, NOT ONE TREE (whitepaper §3.6, D1)
 * -----------------------------------------------
 * The constructor commits n independent one-time trees, one generated and held
 * by each signer, and a threshold k with n / 2 < k <= n (two of three at the
 * reference values; a testnet in phase 1 of whitepaper §3.7 runs k = n = 1). A
 * root is admitted where the signatures of k distinct signers over it verify,
 * each against its own tree, at the one index the set shares; every admitted
 * root consumes that index in every tree, so a leaf left unsigned at it is
 * never used. Any two coalitions able to admit share a signer, so two roots
 * signed for one epoch are attributable to a signer who signed both. Fewer
 * than k compromised signers direct no payment, and n - k unavailable signers
 * delay none. A signature that does not verify, a signer outside the set or a
 * signer named twice is simply not counted — the model's `thresholdAdmits` —
 * so what admits is exactly k distinct members that verify, and a carrier
 * cannot make a good set fail by adding to it.
 *
 * THE AUTHORITY CHAIN (whitepaper §3.6, I35, gap item 25)
 * -------------------------------------------------------
 * Four generations of signer sets are generated together and committed as a
 * hash chain beside the first: `chainCommit` is `hash(signerRoots of the next
 * generation || the commitment after it)`, and the last generation commits to
 * `keccak256(bytes32(0))`, which no set reproduces. k signers of the active
 * generation schedule the next link by an EXTENSION_DOMAIN message, only while
 * the active set has consumed [5,000, 9,500) bps of its leaves; it activates,
 * permissionlessly, six epochs later (the censorship window), and a
 * CANCEL_DOMAIN message of the same set under the same threshold voids it in
 * between. On activation the new set starts at its own leaf 0 and the old one
 * verifies against nothing. No function writes the chain, so the only
 * authorities this relay will ever honour were fixed before the first position
 * was anchored; an adversary can deny an extension and cannot insert one.
 *
 * An extension and a cancellation each consume the shared index AND an elapsed
 * epoch, as a root does. The listing of yellow paper §2.2 advances only the
 * index; spending the epoch too keeps I17 exact (at most one index per elapsed
 * epoch), at the price of the root of that epoch waiting for the next one.
 *
 * WHAT IS DELIBERATELY ABSENT
 * ---------------------------
 * There is no staleness closure. A censored relay is a ground put to the
 * dispute court (whitepaper §3.6), which settles the positions from bond
 * principal and leaves the escrow to be recovered once admission resumes. A
 * permissionless latch that closed the relay after a quiet period would turn
 * the adversary's censorship into permanent immobility of the escrow — the one
 * outcome the censorship ground exists to prevent.
 *
 * Root admission does not stop at closure either. The post-declaration
 * recovery of whitepaper §5.4 is carried by roots sealed after the settlement,
 * so a relay that refused roots once closed would make recovery impossible by
 * construction. What closure stops is on the escrow's side: releases, new
 * premium swap locks and anchoring.
 *
 * EPOCHS ARE NUMBERED FROM THE UNIX EPOCH
 * ---------------------------------------
 * The yellow paper §2.2 listing numbers epochs from a genesis timestamp taken
 * at deployment. This relay numbers them from the Unix epoch through
 * ArkEpochLib, a recorded departure: both legs key records by epoch number — a
 * delivery, a coupon, a spent proof, the epoch a receipt was sealed into — and
 * must agree without either being configured with the other's deployment
 * time. The listing's bound (no epoch before it begins) holds unchanged.
 *
 * THE LEAF SET IS FINITE, AND ITS END IS PLANNED FOR
 * --------------------------------------------------
 * `2^treeHeight` indices per generation. Exhaustion is terminal for the
 * generation that reaches it, and for the relay once the fourth does: no root
 * is admitted afterwards, so no receipt sealed later can release anything and
 * no recovery under whitepaper §5.4 is possible. Where no successor has been
 * activated, the escrows close to new anchoring at the migration horizon,
 * 8,000 bps of the active generation's leaves (`requireAnchorable`), so every
 * position can leave (or migrate) while a fifth of the leaves remain.
 * Migration to a successor escrow is specified in whitepaper §3.6 and is NOT
 * built here.
 */
contract ArkEpochRootRelay is IArkEpochRootRelay {
    uint8 public immutable THRESHOLD;

    /// n, the signers of every generation.
    uint8 public immutable SIGNER_COUNT;

    uint8 public immutable TREE_HEIGHT;

    /// 2^TREE_HEIGHT. The indices each generation will ever consume.
    uint32 public immutable LEAF_COUNT;

    /**
     * 8,000 bps of LEAF_COUNT, truncated. whitepaper §6.4 makes it a constant
     * ratio rather than a parameter: a horizon a vote could move is a horizon an
     * adversary in control of the vote could move to the leaf before
     * exhaustion. Truncation closes anchoring one leaf earlier at most, which is
     * the direction that leaves more of the migration window, never less.
     */
    uint32 public immutable MIGRATION_HORIZON;

    /// The extension window of yellow paper §2.2, [5,000, 9,500) bps of LEAF_COUNT, both truncated.
    uint32 public immutable EXTENSION_OPENS;
    uint32 public immutable EXTENSION_CLOSES;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant HORIZON_BPS = 8_000;
    uint256 internal constant EXTENSION_OPENS_BPS = 5_000;
    uint256 internal constant EXTENSION_CLOSES_BPS = 9_500;

    /// T of yellow paper §2.2: the chain holds four generations, the first included.
    uint8 public constant MAX_GENERATIONS = 4;

    /// The ratchet delay: six epochs, the censorship window of whitepaper §6.4.
    uint64 public constant RATCHET_EPOCHS = 6;

    /// A signer set fits the bitmask the verification counts distinct signers in, and stays generable.
    uint256 internal constant MAX_SIGNERS = 16;

    /**
     * Bounds on the tree. A height of zero is one root ever and a horizon of
     * zero, so no escrow could open. Above twenty the key set (a million
     * one-time keys, each 67 chains of fifteen hashes) is past what a signer can
     * reasonably generate and hold, and the relay's life already exceeds
     * 20,000 years of weekly roots.
     */
    uint8 internal constant MIN_TREE_HEIGHT = 1;
    uint8 internal constant MAX_TREE_HEIGHT = 20;

    /**
     * ArkStakeEscrow.RELEASE_EPOCH_DELAY, the epochs a release receipt waits
     * after its root: enforced here since 2026-09-29, through
     * `releaseReceipt`, and named in the admission event.
     */
    uint256 internal constant RELEASE_EPOCH_DELAY = 4;

    /// The active generation's tree roots, one per signer. Written at construction and by activation alone.
    bytes32[] internal _signerRoots;

    /// The commitment to the next link: hash(next signer roots || the commitment after them).
    bytes32 public chainCommit;

    /// 1 .. MAX_GENERATIONS.
    uint8 public generation;

    /// Monotonic within a generation. The index every tree of the set is at next.
    uint32 public nextLeaf;

    /// Monotonic. The epoch of the last root, extension or cancellation admitted.
    uint64 public lastEpoch;

    /// The epoch the scheduled extension activates from; zero while none is scheduled.
    uint64 public extensionActivatesAt;

    bytes32[] internal _pendingRoots;
    bytes32 internal _pendingCommit;

    mapping(uint256 => bytes32) internal _acceptedRoot;

    /**
     * The epoch in which each root was admitted, which can be later than the
     * epoch it is labelled with. See `admittedIn` (audit 2026-09-27, D11).
     */
    mapping(uint256 => uint64) internal _admittedIn;

    /// The epochs whose ordered leaves are on chain (`publishLeaves`).
    mapping(uint256 => bool) public leavesPublished;

    /// The number of leaves each admitted root was built on, as its signers signed it (audit 2026-09-29, OL-01).
    mapping(uint256 => uint32) public leafCounts;

    mapping(address => Control) internal _control;

    /// Seed-return leaves already presented: each returns the seed once (re-audit 2026-09-30, ORIGIN-01).
    mapping(bytes32 => bool) public seedReturnSpent;

    constructor(bytes32[] memory signerRoots_, uint8 threshold, uint8 treeHeight, bytes32 chainCommit_) {
        uint256 n = signerRoots_.length;
        _checkSet(signerRoots_, n);
        // n / 2 < k <= n (whitepaper §3.6): any two coalitions able to admit
        // share a signer, and none is larger than the set.
        if (threshold > n || 2 * uint256(threshold) <= n) revert BadThreshold(threshold, n);
        if (treeHeight < MIN_TREE_HEIGHT || treeHeight > MAX_TREE_HEIGHT) revert BadTreeHeight(treeHeight);
        // A zero commitment names no successor and is almost certainly a
        // deployment that forgot the chain; the terminal link is explicit.
        if (chainCommit_ == bytes32(0)) revert ZeroRootAuthority();

        THRESHOLD = threshold;
        SIGNER_COUNT = uint8(n);
        TREE_HEIGHT = treeHeight;
        uint32 count = uint32(1) << treeHeight;
        LEAF_COUNT = count;
        // Truncate: the horizon lands at or below 8,000 bps, never above.
        MIGRATION_HORIZON = uint32((uint256(count) * HORIZON_BPS) / BPS);
        EXTENSION_OPENS = uint32((uint256(count) * EXTENSION_OPENS_BPS) / BPS);
        EXTENSION_CLOSES = uint32((uint256(count) * EXTENSION_CLOSES_BPS) / BPS);

        _signerRoots = signerRoots_;
        chainCommit = chainCommit_;
        generation = 1;
        // The forward-only rule counts from deployment, not from 1970 (OC
        // round 2026-10-03, OC-LEGA-02): from zero, every epoch since the Unix
        // epoch read as elapsed, and one admitting set could label a root for
        // each of them in one block and burn the generation to its horizon.
        // From here the first message may label the epoch of deployment, and
        // every index consumed is one epoch elapsed since (I17).
        lastEpoch = uint64(ArkEpochLib.current()) - 1;
    }

    /**
     * A signer set: 1 .. MAX_SIGNERS roots, none zero — reached by no signature,
     * so a set counting it could never make its threshold — and no two equal,
     * since two signers holding one tree are one signer counted twice.
     */
    function _checkSet(bytes32[] memory roots, uint256 n) private pure {
        if (n == 0 || n > MAX_SIGNERS || roots.length != n) revert BadThreshold(0, roots.length);
        for (uint256 i; i < n; ++i) {
            if (roots[i] == bytes32(0)) revert ZeroRootAuthority();
            for (uint256 j; j < i; ++j) {
                if (roots[j] == roots[i]) revert DuplicateSignerRoot(i);
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* Admission                                                           */
    /* ------------------------------------------------------------------ */

    /**
     * Admit one epoch root. Any sender. yellow paper §2.2, `admitEpochRoot`.
     *
     * Each guard has its own error because each fails for a different reason
     * and a carrier deciding whether to retry needs to know which.
     */
    function admitEpochRoot(uint64 epoch, bytes32 epochRoot, uint32 leafCount, uint32 leafIndex, SignerSig[] calldata sigs)
        external
    {
        // The verifier reads a zero root as "no root for this epoch", and an
        // empty proof as `leaf == root`. A zero root would consume an index and
        // an epoch and prove nothing; nor is a root built on no leaves.
        if (epochRoot == bytes32(0) || leafCount == 0) revert ZeroRoot();
        uint256 nowEpoch = _advance(
            epoch,
            leafIndex,
            ArkStakeIds.rootMessage(block.chainid, address(this), epoch, epochRoot, leafCount),
            sigs
        );
        _recordRoot(epoch, epochRoot, leafCount, leafIndex, nowEpoch);
    }

    /**
     * The writes of an admitted root: by `admitEpochRoot`, and by an extension
     * or a cancellation the root rode with (V2, PV-18). A root that rides with
     * a nonzero count and is zero is refused as a root's is (`ZeroRoot`).
     */
    function _recordRoot(uint64 epoch, bytes32 epochRoot, uint32 leafCount, uint32 leafIndex, uint256 nowEpoch) private {
        if (leafCount == 0) return;
        if (epochRoot == bytes32(0)) revert ZeroRoot();
        _acceptedRoot[epoch] = epochRoot;
        _admittedIn[epoch] = uint64(nowEpoch);
        leafCounts[epoch] = leafCount;

        emit EpochRootAdmitted(epoch, epochRoot, leafIndex, nowEpoch + RELEASE_EPOCH_DELAY);
    }

    /**
     * Every rule a message signed at the shared index is admitted under — a
     * root, an extension, a cancellation — and the write that consumes the
     * index and the epoch. Returns the current epoch.
     */
    function _advance(uint64 epoch, uint32 leafIndex, bytes32 message, SignerSig[] calldata sigs)
        private
        returns (uint256 nowEpoch)
    {
        // One message per epoch, and never backwards. Without it a compromised
        // coalition could overwrite a root with proofs in flight against it, or
        // mint history for an epoch long past whose receipts are already beyond
        // the escrow's release delay.
        if (epoch <= lastEpoch) revert EpochNotForward(epoch, lastEpoch);

        // No epoch before it begins. Together with the rule above this is what
        // bounds index consumption to one per elapsed epoch (I17), so no
        // coalition can bring the migration horizon forward, and it is what the
        // escrow's unbonding derivation rests on: a receipt cannot be sealed
        // into an epoch that has not started.
        nowEpoch = ArkEpochLib.current();
        if (epoch > nowEpoch) revert FutureEpochRoot(epoch, nowEpoch);

        // Forward only. A one-time key signs once; admitting any other index
        // would let a key be used twice, and a WOTS key that signs two messages
        // leaks enough chain elements to forge a third.
        if (leafIndex != nextLeaf) revert WrongLeafIndex(nextLeaf, leafIndex);

        // Terminal for the generation. There is no key beyond its last leaf; the
        // one path past it is the next link of the chain, scheduled earlier.
        if (leafIndex >= LEAF_COUNT) revert LeafSetExhausted(LEAF_COUNT);

        _verifyThreshold(message, leafIndex, sigs);

        lastEpoch = epoch;
        nextLeaf = leafIndex + 1;
    }

    /**
     * k distinct signers of the active generation over `message`, each on its
     * own tree, at `leafIndex` (yellow paper §2.2 `verifyThreshold`; the model's
     * `thresholdAdmits`). What does not count is skipped rather than refused: a
     * signer outside the set, a signer already counted, a path of the wrong
     * length — which at a shorter length could present an interior node as a
     * tree root — and a signature that reaches another root. Counting stops at
     * k, so a carrier pays for no verification past the threshold.
     */
    function _verifyThreshold(bytes32 message, uint32 leafIndex, SignerSig[] calldata sigs) private view {
        uint256 k = THRESHOLD;
        uint256 n = SIGNER_COUNT;
        uint256 height = TREE_HEIGHT;
        uint256 seen;
        uint256 count;
        for (uint256 i; i < sigs.length && count < k; ++i) {
            SignerSig calldata s = sigs[i];
            uint256 who = s.signer;
            if (who >= n || (seen >> who) & 1 == 1 || s.authPath.length != height) continue;
            if (WotsVerifier.recoverRoot(message, s.ots, leafIndex, s.authPath) != _signerRoots[who]) continue;
            seen |= uint256(1) << who;
            ++count;
        }
        if (count < k) revert ThresholdNotMet(count, k);
    }

    /* ------------------------------------------------------------------ */
    /* Data availability                                                   */
    /* ------------------------------------------------------------------ */

    /**
     * Publish the leaves of an admitted root. Any sender, once per epoch.
     * whitepaper §3.6, yellow paper §2.2 `publishLeaves` (D15).
     *
     * The leaves are taken in the one order the root is built in — strictly
     * ascending, which also refuses a duplicate — and hashed exactly as the
     * relayer builds the tree and OpenZeppelin's MerkleProof verifies it:
     * sorted pairs, an odd node promoted unchanged. Only a list that reproduces
     * the admitted root is accepted, so the event is the root's own content and
     * every leaf a payment needs is recoverable from origin-chain state; a
     * party that withholds its copy withholds nothing another account cannot
     * publish.
     *
     * The list must be exactly as long as the leaf count the root's signers
     * signed (audit 2026-09-29, OL-01): the sorted children of the root, or any
     * interior layer, reproduced it too, and a front-runner publishing them
     * latched the epoch against the real leaves. Every layer above the leaves
     * is shorter than the leaf layer, so the one list of the signed length
     * that hashes to the root is the leaves themselves.
     */
    function publishLeaves(uint64 epoch, bytes32[] calldata leaves) external {
        bytes32 root = _acceptedRoot[epoch];
        if (root == bytes32(0)) revert NoRootForEpoch(epoch);
        if (leavesPublished[epoch]) revert LeavesAlreadyPublished(epoch);

        uint256 n = leaves.length;
        if (n != leafCounts[epoch]) revert LeafCountMismatch(epoch, leafCounts[epoch], n);
        bytes32[] memory layer = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            if (i != 0 && leaves[i] <= leaves[i - 1]) revert LeavesNotOrdered(i);
            layer[i] = leaves[i];
        }
        // In place: each layer's node m is written from nodes 2m and 2m + 1 of
        // the layer below, which the loop has already read.
        while (n > 1) {
            uint256 m;
            for (uint256 i; i < n; i += 2) {
                layer[m++] = i + 1 < n ? _hashPair(layer[i], layer[i + 1]) : layer[i];
            }
            n = m;
        }
        bytes32 computed = n == 0 ? bytes32(0) : layer[0];
        if (computed != root) revert LeavesNotRoot(epoch, computed);

        leavesPublished[epoch] = true;
        emit LeavesPublished(epoch, leaves);
    }

    /// OpenZeppelin 4.9's `_hashPair`: the pair sorted, so the verifier needs no direction bit.
    function _hashPair(bytes32 a, bytes32 b) private pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /* ------------------------------------------------------------------ */
    /* The authority chain                                                 */
    /* ------------------------------------------------------------------ */

    /**
     * Schedule the next generation. Any sender; k signers of the active one are
     * the authority. yellow paper §2.2 `scheduleTreeExtension`, I35.
     *
     * Only inside [EXTENSION_OPENS, EXTENSION_CLOSES) of the active leaf set:
     * late enough that an extension answers a measured approach to exhaustion,
     * early enough that the migration horizon remains reachable where none is
     * activated. Only the next link of the chain fixed at construction.
     *
     * The root of the epoch the message consumes rides with it (V2,
     * 2026-09-30; PV-18): the message binds `epochRoot` and `leafCount`, and a
     * nonzero count is admitted as `admitEpochRoot` admits it, so an epoch
     * with a return fact is not left rootless by the authority chain. A zero
     * count admits no root, as before.
     */
    function scheduleExtension(
        bytes32[] calldata nextRoots,
        bytes32 nextChainCommit,
        uint64 epoch,
        bytes32 epochRoot,
        uint32 leafCount,
        uint32 leafIndex,
        SignerSig[] calldata sigs
    ) external {
        bytes32 message = _extensionMessage(nextRoots, nextChainCommit, epoch, epochRoot, leafCount);
        uint256 nowEpoch = _advance(epoch, leafIndex, message, sigs);
        _recordRoot(epoch, epochRoot, leafCount, leafIndex, nowEpoch);

        // Counted from admission, not from the label, as a root's unbonding is.
        uint64 at = uint64(nowEpoch + RATCHET_EPOCHS);
        extensionActivatesAt = at;
        _pendingRoots = nextRoots;
        _pendingCommit = nextChainCommit;
        emit ExtensionScheduled(generation + 1, epoch, leafIndex, at);
    }

    /**
     * Every refusal of an extension before its signatures, and the message
     * they must sign. Apart from \`scheduleExtension\` so the legacy code
     * generator's stack holds the riding root's two words.
     */
    function _extensionMessage(
        bytes32[] calldata nextRoots,
        bytes32 nextChainCommit,
        uint64 epoch,
        bytes32 epochRoot,
        uint32 leafCount
    ) private view returns (bytes32) {
        if (extensionActivatesAt != 0) revert ExtensionPending(extensionActivatesAt);
        uint8 g = generation;
        if (g >= MAX_GENERATIONS) revert ChainExhausted(g);
        uint32 next = nextLeaf;
        if (next < EXTENSION_OPENS || next >= EXTENSION_CLOSES) {
            revert OutsideExtensionWindow(next, EXTENSION_OPENS, EXTENSION_CLOSES);
        }
        bytes32 commit = chainCommit;
        bytes32 link = ArkStakeIds.chainLink(nextRoots, nextChainCommit);
        if (link != commit) revert NotNextLink(commit, link);
        // The link was fixed before any key could be inspected, so a malformed
        // set in it — a wrong count, a zero or a repeated root — is refused
        // here, and the generation then runs to its migration horizon.
        _checkSet(nextRoots, SIGNER_COUNT);
        return ArkStakeIds.extensionMessage(block.chainid, address(this), epoch, g + 1, commit, epochRoot, leafCount);
    }

    /**
     * Void the scheduled extension, during its ratchet delay. Any sender; k
     * signers of the active generation are the authority, under the same
     * threshold as a root. The epoch's root rides with it as with an
     * extension (V2, PV-18).
     */
    function cancelExtension(uint64 epoch, bytes32 epochRoot, uint32 leafCount, uint32 leafIndex, SignerSig[] calldata sigs)
        external
    {
        _requireCancellable();
        // Built before the advance, and the advance's epoch passed straight on:
        // the legacy code generator's stack holds no more locals than these.
        bytes32 message =
            ArkStakeIds.cancelMessage(block.chainid, address(this), epoch, generation + 1, chainCommit, epochRoot, leafCount);
        _recordRoot(epoch, epochRoot, leafCount, leafIndex, _advance(epoch, leafIndex, message, sigs));
        _clearPending();
        emit ExtensionCancelled(generation + 1, epoch, leafIndex);
    }

    /// A scheduled extension whose ratchet delay still runs.
    function _requireCancellable() private view {
        uint64 at = extensionActivatesAt;
        if (at == 0) revert NoExtensionPending();
        if (ArkEpochLib.current() >= at) revert RatchetElapsed(at);
    }

    /**
     * Make the scheduled generation the active one, once its delay has run.
     * Any sender, since the schedule is the authority and the delay the
     * protection. The new set starts at its own leaf 0; the old one, having
     * no roots in `_signerRoots`, verifies against nothing again.
     */
    function activateNextGeneration() external {
        uint64 at = extensionActivatesAt;
        if (at == 0) revert NoExtensionPending();
        if (ArkEpochLib.current() < at) revert RatchetRunning(at);
        _signerRoots = _pendingRoots;
        chainCommit = _pendingCommit;
        uint8 g = generation + 1;
        generation = g;
        nextLeaf = 0;
        _clearPending();
        emit GenerationActivated(g, chainCommit);
    }

    function _clearPending() private {
        extensionActivatesAt = 0;
        delete _pendingRoots;
        _pendingCommit = bytes32(0);
    }

    /* ------------------------------------------------------------------ */
    /* Control leaves, per escrow                                          */
    /* ------------------------------------------------------------------ */

    /**
     * The declaration, reaching one escrow. whitepaper §3.5, invariant I15.
     *
     * Permissionless: the leaf is the authority. A latch, so the leaf needs no
     * spend key — replaying it finds the escrow already closed.
     */
    function close(address escrow, uint64 epoch, bytes32[] calldata proof) external {
        Control storage c = _control[escrow];
        if (c.closed) revert AlreadyClosed(c.closedEpoch);
        _requireMember(epoch, ArkStakeIds.closeLeaf(block.chainid, escrow), proof);

        c.closed = true;
        c.closedEpoch = epoch;
        emit Closed(escrow, epoch, uint64(block.timestamp));
    }

    /**
     * The protective freeze of one escrow, on or off. whitepaper §3.3: no
     * release settles while it is active.
     *
     * The latest root wins. A freeze leaf is applied only if its root is later
     * than the one that last set the flag, so an old freeze leaf cannot be
     * replayed over a later lift, nor an old lift over a later freeze. Without
     * the ordering, anyone holding a stale proof could toggle the flag at will.
     *
     * Refused after closure, because there is nothing left to suspend and a
     * `frozen` flag moving under a closed escrow would suggest the closure is
     * itself reversible.
     *
     * A leaf restating the current state still advances `freezeEpoch`. It is
     * the latest root's word on the freeze, and ordering by it is what makes
     * an older leaf inapplicable. When a restatement reverted instead, a lift
     * sealed after an uncarried freeze was refused while the escrow happened to
     * be unfrozen, and the older freeze then applied over it. It emits
     * `FreezeRestated` and not `FreezeSet`, so an observer reconstructing when
     * releases were suspended does not date a second freeze from it.
     *
     * The proof is checked before the ordering moves, restatement or not;
     * otherwise anyone could advance `freezeEpoch` past a genuine freeze with
     * no leaf at all and make that freeze inapplicable.
     *
     * Two contradictory freeze leaves in one root share an epoch, so whichever
     * is carried first is applied and the other is refused `FreezeNotForward`.
     * The relay cannot know which QRL meant; a root must carry at most one.
     */
    function setFrozen(address escrow, bool frozen_, uint64 epoch, bytes32[] calldata proof) external {
        Control storage c = _control[escrow];
        if (c.closed) revert AlreadyClosed(c.closedEpoch);
        if (epoch <= c.freezeEpoch) revert FreezeNotForward(c.freezeEpoch, epoch);
        _requireMember(epoch, ArkStakeIds.freezeLeaf(block.chainid, escrow, frozen_), proof);

        c.freezeEpoch = epoch;
        if (c.frozen == frozen_) {
            emit FreezeRestated(escrow, frozen_, epoch);
            return;
        }
        c.frozen = frozen_;
        emit FreezeSet(escrow, frozen_, epoch, uint64(block.timestamp));
    }

    function _requireMember(uint256 epoch, bytes32 leaf, bytes32[] calldata proof) private view {
        bytes32 root = _acceptedRoot[epoch];
        if (root == bytes32(0)) revert NoRootForEpoch(epoch);
        if (!MerkleProof.verifyCalldata(proof, root, leaf)) revert BadProof(epoch, leaf);
    }

    /* ------------------------------------------------------------------ */
    /* What an escrow reads                                                */
    /* ------------------------------------------------------------------ */

    /**
     * Membership of a leaf in the root admitted for `epoch`, reverting with the
     * reason. The escrow's one check of a return leaf, kept here so the
     * verifier is one copy in the contract that admits the roots, and read by
     * a plain call: the escrow delegates nothing.
     */
    function requireMember(uint256 epoch, bytes32 leaf, bytes32[] calldata proof) external view {
        _requireMember(epoch, leaf, proof);
    }

    /// @inheritdoc IArkEpochRootRelay
    function allocationReceipt(uint256 epoch, IArkStakeEscrow.AllocationRates calldata rates, bytes32[] calldata proof)
        external
        view
        returns (bytes32 leaf, uint256 word)
    {
        // A field is named by its place in the leaf (0 = sigmaBps ... 8 =
        // commitTermEpochs), not by a string the bytecode would carry.
        _inRange(0, rates.sigmaBps, 0, ArkStakeIds.SIGMA_MAX_BPS);
        _inRange(1, rates.bufferBps, ArkStakeIds.BUFFER_MIN_BPS, ArkStakeIds.BUFFER_MAX_BPS);
        _inRange(2, rates.operationsBps, ArkStakeIds.OPS_MIN_BPS, ArkStakeIds.OPS_MAX_BPS);
        _inRange(3, rates.jurorFeeShareBps, 0, ArkStakeIds.JUROR_FEE_MAX_BPS);
        _inRange(4, rates.levyBps, 0, ArkStakeIds.LEVY_MAX_BPS);
        _inRange(5, rates.sigmaTargetBps, 0, ArkStakeIds.SIGMA_MAX_BPS);
        _inRange(6, rates.coveredBps, 0, BPS);
        _inRange(7, rates.psrCapBps, 0, ArkStakeIds.PSR_CAP_MAX_BPS);
        _inRange(8, rates.commitTermEpochs, 0, ArkStakeIds.COMMIT_TERM_MAX_EPOCHS);
        // Refused here rather than at the escrow's sweep, where the staker
        // residual would underflow and strand the sweep. The levy is a share
        // of gross yield like the three others (whitepaper §4.2).
        if (uint256(rates.sigmaBps) + rates.bufferBps + rates.operationsBps + rates.levyBps > BPS) {
            revert AllocationExceedsYield(rates.sigmaBps, rates.bufferBps, rates.operationsBps);
        }
        leaf = ArkStakeIds.allocationLeaf(msg.sender, epoch, rates);
        _requireMember(epoch, leaf, proof);
        word = _allocationWord(epoch, rates);
    }

    /**
     * The escrow's `Allocation` in its storage layout, packed from the low bit
     * in declaration order: uint64 epoch, nine uint16 rates, bool set, bool
     * stepQueued. The escrow refuses an epoch past the current one, so the
     * epoch fits sixty-four bits. `test/escrow.test.js` holds the record read
     * back field for field.
     */
    function _allocationWord(uint256 epoch, IArkStakeEscrow.AllocationRates calldata r) private pure returns (uint256 w) {
        w = uint256(uint64(epoch)) | (uint256(r.sigmaBps) << 64) | (uint256(r.bufferBps) << 80);
        w |= (uint256(r.operationsBps) << 96) | (uint256(r.jurorFeeShareBps) << 112) | (uint256(r.levyBps) << 128);
        w |= (uint256(r.sigmaTargetBps) << 144) | (uint256(r.coveredBps) << 160) | (uint256(r.psrCapBps) << 176);
        w |= (uint256(r.commitTermEpochs) << 192) | (uint256(1) << 208);
        if (r.stepQueued) w |= uint256(1) << 216;
    }

    /// @inheritdoc IArkEpochRootRelay
    function lossReceipt(
        uint256 epoch,
        bytes32 determinationId,
        bytes32 stakeAssetId,
        address destination,
        uint256 quantity,
        bytes32[] calldata proof
    ) external view returns (bytes32 leaf) {
        leaf = ArkStakeIds.lossLeaf(block.chainid, msg.sender, determinationId, stakeAssetId, destination, quantity);
        _requireMember(epoch, leaf, proof);
    }

    /// @inheritdoc IArkEpochRootRelay
    function shareReceipt(
        uint256 epoch,
        bytes32 successorId,
        bytes32 recoveryId,
        bytes32 recipient,
        address destination,
        uint256 quantity,
        bytes32[] calldata proof
    ) external view returns (bytes32 leaf) {
        leaf = ArkStakeIds.shareLeaf(block.chainid, msg.sender, successorId, recoveryId, recipient, destination, quantity);
        _requireMember(epoch, leaf, proof);
    }

    /**
     * @inheritdoc IArkEpochRootRelay
     * @dev The closure is read here, not in the escrow (OC round 2026-10-03,
     *      OC-LEGA-03), and it refuses only a lock sealed after the root that
     *      carried the close. A lot selected and sealed before the declaration
     *      reached the escrow was paid for on QRL, where its lock pays anyone
     *      holding the preimage until `qrlExpiry`: refused here once a close
     *      was carried in front of the solver's claim, the solver's secret was
     *      already public and it lost the lot's QRL for no shares (I31, I33).
     *      Within `evmExpiry` it is paid out of the pot as before; the pot is
     *      drawn last by a recovery share (`releaseShare`), so the claim takes
     *      what the solver bought and nothing a recovery already took. A lock
     *      sealed later is one QRL should never have sealed. Read here so the
     *      Lido form, at the edge of EIP-170, spends no byte on it.
     */
    function premiumReceipt(uint256 epoch, address asset, IArkStakeEscrow.PremiumLock calldata payload, bytes32[] calldata proof)
        external
        view
        returns (bytes32 leaf)
    {
        {
            Control storage c = _control[msg.sender];
            if (c.closed && epoch > c.closedEpoch) revert SettlementClosed();
        }
        leaf = ArkStakeIds.premiumLockLeaf(block.chainid, msg.sender, asset, payload);
        _requireMember(epoch, leaf, proof);
    }

    /// @inheritdoc IArkEpochRootRelay
    function delistReceipt(uint256 epoch, address asset, bytes32[] calldata proof) external view {
        _requireMember(epoch, ArkStakeIds.delistLeaf(block.chainid, msg.sender, asset), proof);
    }

    /**
     * @inheritdoc IArkEpochRootRelay
     * @dev Since the re-audit of 2026-09-30 (ORIGIN-01) the leaf is spent here,
     *      once, and the calling escrow must have closed its anchoring (a
     *      de-listed escrow): QRL seals the leaf only on a request of
     *      governance recorded there, and a stranger presenting it before the
     *      first anchor, or again after a re-seed, used to keep an escrow from
     *      ever opening. Read from the escrow itself, so the escrow spends no
     *      byte on it.
     */
    function seedReturnReceipt(uint256 epoch, bytes32[] calldata proof) external {
        if (_control[msg.sender].closed) revert ReleaseClosed();
        if (!IAnchoringClosed(msg.sender).anchoringClosed()) revert AnchoringOpen();
        uint256 current = ArkEpochLib.current();
        // The epoch in progress or the one before it: a leaf sealed while
        // nothing was open on QRL says nothing about a later determination.
        if (epoch != current && epoch + 1 != current) revert SeedReturnStale(epoch, current);
        bytes32 leaf = ArkStakeIds.seedReturnLeaf(block.chainid, msg.sender, epoch);
        if (seedReturnSpent[leaf]) revert SeedReturnSpent(leaf);
        _requireMember(epoch, leaf, proof);
        seedReturnSpent[leaf] = true;
    }

    function _inRange(uint256 field, uint256 v, uint256 lo, uint256 hi) private pure {
        if (v < lo || v > hi) revert AllocationOutOfRange(field, v);
    }

    /**
     * A release receipt of the calling escrow, checked against the root
     * admitted for `epoch`: the key it is spent under, and the first epoch it
     * may be consumed in — its unbonding counted from the later of the root's
     * label and the epoch it was admitted in (D11), so a root labelled with a
     * past epoch after a gap shortens no unbonding.
     *
     * The leaf binds `msg.sender` (D10), so a caller can only ever check a
     * receipt of its own; the relay adds no authority. Built here rather than
     * in the escrow since 2026-09-29, because the escrow runs against EIP-170
     * and reads a receipt twice from then: once the root carrying it is
     * admitted, to take the position out of the book the premium is charged
     * on, and after the unbonding, to consume it (whitepaper §3.3, I18; audit
     * 2026-09-22, X7). `RELEASE_EPOCH_DELAY` is the escrow's rule, held here.
     */
    function releaseReceipt(uint256 epoch, bytes32 id, address recipient, uint64 claimNonce, bytes32[] calldata proof)
        external
        view
        returns (bytes32 key, uint256 usableFrom)
    {
        bytes32 leaf = ArkStakeIds.releaseLeaf(msg.sender, ArkStakeIds.releasePayload(id, recipient, claimNonce, block.chainid));
        _requireMember(epoch, leaf, proof);
        key = ArkStakeIds.spendKey(epoch, leaf);
        uint256 admitted = _admittedIn[epoch];
        usableFrom = (admitted > epoch ? admitted : epoch) + RELEASE_EPOCH_DELAY;
    }

    /**
     * Whether `escrow` may take a deposit: not closed at the declaration, and
     * the active generation short of its migration horizon (whitepaper §3.6) —
     * a generation whose successor was activated starts again at leaf 0.
     */
    function requireAnchorable(address escrow) external view {
        if (_control[escrow].closed) revert ReleaseClosed();
        uint32 next = nextLeaf;
        if (next >= MIGRATION_HORIZON) revert MigrationHorizonReached(next, MIGRATION_HORIZON);
    }

    function controlOf(address escrow) external view returns (Control memory) {
        return _control[escrow];
    }

    function isClosed(address escrow) external view returns (bool) {
        return _control[escrow].closed;
    }

    /* ------------------------------------------------------------------ */
    /* Views                                                               */
    /* ------------------------------------------------------------------ */

    /**
     * The root admitted for the epoch, or zero. Its absence at a finalised
     * height is the evidence of the censorship ground of whitepaper §3.6.
     */
    function acceptedRoot(uint64 epoch) external view returns (bytes32) {
        return _acceptedRoot[epoch];
    }

    function rootOf(uint256 epoch) external view returns (bytes32) {
        return _acceptedRoot[epoch];
    }

    /**
     * The epoch the root labelled `epoch` was admitted in; zero where none was.
     *
     * The label is only bounded to be forward and not in the future, so after
     * a gap a root may be labelled with an epoch long past. The escrow counts
     * unbonding from the later of the two: counted from the label alone, a
     * receipt sealed into a root labelled four epochs back was usable the
     * moment it was admitted (audit 2026-09-27, D11; open item E7 of 2026-09-22).
     */
    function admittedIn(uint256 epoch) external view returns (uint64) {
        return _admittedIn[epoch];
    }

    /// The active generation's tree roots, one per signer, in signer order.
    function signerRoots() external view returns (bytes32[] memory) {
        return _signerRoots;
    }

    /// The scheduled generation's tree roots and the commitment after them; empty while none is scheduled.
    function pendingGeneration() external view returns (bytes32[] memory roots, bytes32 nextChainCommit) {
        return (_pendingRoots, _pendingCommit);
    }

    /// The message k signers must sign at `nextLeaf` to admit `epochRoot`, built on `leafCount` leaves.
    function rootMessage(uint64 epoch, bytes32 epochRoot, uint32 leafCount) external view returns (bytes32) {
        return ArkStakeIds.rootMessage(block.chainid, address(this), epoch, epochRoot, leafCount);
    }

    /// The message k signers must sign to schedule the next generation, consuming `epoch`, with its root riding.
    function extensionMessage(uint64 epoch, bytes32 epochRoot, uint32 leafCount) external view returns (bytes32) {
        return ArkStakeIds.extensionMessage(block.chainid, address(this), epoch, generation + 1, chainCommit, epochRoot, leafCount);
    }

    /// The message k signers must sign to cancel the scheduled extension, consuming `epoch`, with its root riding.
    function cancelMessage(uint64 epoch, bytes32 epochRoot, uint32 leafCount) external view returns (bytes32) {
        return ArkStakeIds.cancelMessage(block.chainid, address(this), epoch, generation + 1, chainCommit, epochRoot, leafCount);
    }

    function currentEpoch() external view returns (uint256) {
        return ArkEpochLib.current();
    }
}
