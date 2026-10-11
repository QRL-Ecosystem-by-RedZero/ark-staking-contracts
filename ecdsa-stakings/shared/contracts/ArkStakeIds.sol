// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "./interfaces/IArkStakeEscrow.sol";

/**
 * The cross-chain preimages, on the origin chain.
 *
 * The one rule this library exists to enforce: **this file is the origin-chain
 * half of a hash agreement, and a divergence from
 * contracts/ArkStakeRegistry.hyp is a bug here and never there.**
 *
 * Three implementations of these hashes exist — Hyperion on QRL, this one, and
 * JavaScript in ecdsa-stakings/relayer/lib/identifiers.js. A divergence in any
 * of them raises no error anywhere: it produces an identifier corresponding to
 * no position, or a proof that simply fails to verify. The suite therefore
 * asserts all three agree over a table rather than trusting the transcription.
 *
 * Everything is `abi.encode`, never `abi.encodePacked`. The insurance product's
 * asset key is packed and omits the chain id; that is a different scheme for a
 * different product and this one must not drift toward it.
 *
 * EVERY KIND OF LEAF CARRIES A TAG OF ITS OWN
 * -------------------------------------------
 * One epoch root carries every message QRL sends this chain: release receipts,
 * the allocation, premium locks, loss settlements, recovery shares, and
 * the control leaves that close, freeze and de-list. Without a tag per kind, a
 * leaf sealed for one purpose whose preimage happened to parse as another would
 * authorise the other.
 *
 * Two shapes coexist, and both are the specification's. The leaves this tree
 * introduced carry STAKE_DOMAIN and then a second tag for their kind. The loss
 * settlement and the recovery share are written by the yellow paper §2.2
 * listing with a single domain of their own in first position, `LOSS_DOMAIN`
 * and `RECOVERY_DOMAIN`, and are transcribed exactly as written — the QRL
 * registry seals them in that form, and a "tidier" prefix here would be a leaf
 * that matches nothing QRL ever seals. They cannot collide with the two-tag
 * leaves: the first word of every other leaf is STAKE_DOMAIN or ROOT_DOMAIN.
 * The release and anchor leaves are the remaining exceptions, and predate the
 * rest: no other leaf here hashes to `(STAKE_DOMAIN, escrow, bytes32)` or to
 * `(STAKE_DOMAIN, escrow, bytes32, uint256)`, and the second word of every
 * two-tag leaf is a domain constant, never an address.
 *
 * EVERY LEAF BINDS THE ESCROW THAT PAYS IT (D10, 2026-09-28)
 * -----------------------------------------------------------
 * One relay serves every escrow of a chain, so a leaf admitted there is a
 * member of a root every escrow on the chain reads. Each leaf an escrow acts
 * on, and each fact it emits for the forward path, therefore carries the
 * escrow's own address — yellow paper §2.2, I6: every leaf binds the
 * origin-chain address of the escrow that pays it. Without it a loss
 * settlement or recovery share sealed for one escrow paid again at every
 * other escrow of the relay (the R25 residual), and a release, a de-listing,
 * a closure or a freeze meant for one escrow reached another. The tags did
 * not change: the words did, and a leaf of the older shape hashes a different
 * number of words, so it can never verify as one of these.
 *
 * The domain constants are literals with their preimage beside them, so a
 * reader can check each without trusting the compiler, and the relayer asserts
 * each against `keccak256` of its string at load.
 */
library ArkStakeIds {
    /// keccak256("ARK_STAKE_V1"). whitepaper §3.5, yellow paper §2.2.
    bytes32 internal constant STAKE_DOMAIN =
        0x7b78fb66e5c4c423ff7a9a14a2788b272f00bb59ce43a9623718bad3f1cfa45d;

    /**
     * keccak256("ARK_STAKE_ROOT_V2"). The message a one-time signature signs.
     * V2 since 2026-09-30: the message binds the root's leaf count as well
     * (audit 2026-09-29, OL-01), so no V1 signature admits a root here.
     */
    bytes32 internal constant ROOT_DOMAIN =
        0x28f329df1ec937d6b558d9c77f38d6f96757f3ed829c76c3657598934ac1d099;

    /**
     * keccak256("ARK_STAKE_ANCHOR_COUNT_V2"). The QRL-side forward root's
     * count of the anchors (audit 2026-09-29, QL-05, QL-06): the relayer seals
     * one into the root of every closed origin epoch. CUMULATIVE since the
     * re-audit of 2026-09-30 (BOND-02): every stake leaf of every root through
     * the epoch, so the V1 leaf (that root's own count) is another tag. No
     * escrow computes it; it is here so the three implementations agree.
     */
    bytes32 internal constant ANCHOR_COUNT_DOMAIN =
        0x0652b5706f2b29d23becd11203d7bae566e534e4d3302e3192469ec4de809774;

    /**
     * keccak256("ARK_STAKE_EXTENSION_V2"). The message k signers of the active
     * generation sign to schedule the next link of the authority chain
     * (whitepaper §3.6, yellow paper §2.2 `scheduleTreeExtension`, I35). V2
     * since 2026-09-30 (PV-18, PV-22): the message carries the root of the
     * epoch it consumes and that root's leaf count, and the root rides with it.
     */
    bytes32 internal constant EXTENSION_DOMAIN =
        0x9cc4c495e4dccc21ca61da2dba35f3866f1270a760307484e835a6c218b708ff;

    /// keccak256("ARK_STAKE_CANCEL_V2"). The message that voids a scheduled extension during its ratchet delay; V2 as the extension's.
    bytes32 internal constant CANCEL_DOMAIN =
        0x77c6434a01f6eefea760fc29b5118cd7a5063a21f169526fc28a537725c0dedb;

    /*
     * Whitepaper §6.3's ranges for an allocation, read by the relay's
     * `allocationReceipt` for every escrow (R3-07, 2026-09-30): fixed in code,
     * so control of the relay does not confer control of the arithmetic.
     */
    uint16 internal constant SIGMA_MAX_BPS = 4_000;
    uint16 internal constant BUFFER_MIN_BPS = 250;
    uint16 internal constant BUFFER_MAX_BPS = 1_500;
    uint16 internal constant OPS_MIN_BPS = 250;
    uint16 internal constant OPS_MAX_BPS = 1_000;
    uint16 internal constant JUROR_FEE_MAX_BPS = 5_000;
    uint16 internal constant LEVY_MAX_BPS = 500;
    uint16 internal constant COMMIT_TERM_MAX_EPOCHS = 26;
    /// The reserve's largest cap factor: twelve epochs of the widest ladder, 12 * (4,000 - 1,850).
    uint16 internal constant PSR_CAP_MAX_BPS = 25_800;

    /// keccak256("ARK_STAKE_CLOSE_V1"). The declaration, reaching this chain.
    bytes32 internal constant CLOSE_DOMAIN =
        0x854acbb2adebc32db3c0b7fe0c7a3791d5c71760522622e3ca604425af7bddc4;

    /// keccak256("ARK_STAKE_FREEZE_V1"). The protective freeze, either direction.
    bytes32 internal constant FREEZE_DOMAIN =
        0xf7a842f65ccc868230aea36394e131d5771b1fac9be8f1af95b9fcdbe7765126;

    /// keccak256("ARK_STAKE_DELIST_V1"). A de-listing, closing one asset to anchoring.
    bytes32 internal constant DELIST_DOMAIN =
        0xd579036212c3ff80f640c3a782cfb7e3b4e95bee0f19240ba9585ddbc8dd8de1;

    /**
     * keccak256("ARK_STAKE_SEED_RETURN_V1"). The return of an escrow's seeding
     * deposit, sealed for an epoch only while no determination is open and no
     * declaration is ratified on QRL (whitepaper §4.2, yellow paper §2.2).
     */
    bytes32 internal constant SEED_RETURN_DOMAIN =
        0xdce3579d119514aadb22ec03905469f05765676c8f51e30c9797f196abfc5750;

    /**
     * keccak256("ARK_STAKE_OFFER_V1"). The premium this escrow holds, carried
     * forward to QRL as the quantity the swap of whitepaper §4.7 offers.
     */
    bytes32 internal constant OFFER_DOMAIN =
        0xf31bdf39f2b36a1d845fa0ebddd9ede2a75e86163753426f768bda2e43a49745;

    /**
     * keccak256("ARK_STAKE_PREMIUM_V3"). The premium lock of whitepaper §3.5
     * and §4.7: one lot selected on QRL, paid here against its preimage.
     *
     * V2 because V1 tagged the premium settlement of the sealed-bid auction,
     * whose leaf named a bidder and a quantity in units; V3 since 2026-09-28,
     * because yellow paper §3.5 binds the offered epoch and the commitment
     * bond as well (I33). Bumping the tag is what guarantees an older leaf can
     * never verify as a lock.
     */
    bytes32 internal constant PREMIUM_DOMAIN =
        0x62aa012827ba11814bd6dd90fc72ca32919303403d8827a8d5788a3b0f1cd888;

    /**
     * keccak256("ARK_STAKE_BUFFER_V1"). The buffer this escrow holds, carried
     * forward to QRL as `buffer_orig` of whitepaper §4.3.
     */
    bytes32 internal constant BUFFER_DOMAIN =
        0x797db8e4a78fe7f6eaad089bffcc820051f8a3ade37bddda13e381d8da78551d;

    /// keccak256("ARK_STAKE_RELEASED_V1"). A completed release, carried back to QRL.
    bytes32 internal constant RELEASED_DOMAIN =
        0x1b5c902ec2c18bbcb342f901ea8496a8330696a9d00d7d5f6ae055dbbf1b4cb5;

    /**
     * keccak256("ARK_STAKE_ALLOCATION_V4").
     *
     * V2 because the leaf gained the juror-fee fraction; V3 since 2026-09-28,
     * because it gained the levy, the target rung, the cover, the reserve's cap
     * factor and the commitment term (gap item 19, I39); V4 since 2026-09-30,
     * because it gained `stepQueued` (QL-25, PV-20). Bumping the tag
     * rather than appending fields is what guarantees a leaf sealed under an
     * older format can never verify as this one.
     */
    bytes32 internal constant ALLOCATION_DOMAIN =
        0x00dea64034af1c14fb698f0f5d5dc90f019a7ebd16e16a20664167d7d7e352fc;

    /**
     * keccak256("ARK_LOSS_V1"). The loss settlement of whitepaper §3.5 and
     * §5.2, as yellow paper §2.2 names it.
     */
    bytes32 internal constant LOSS_DOMAIN =
        0xe325f1a59c183640d2cd7301dbd4a5daf3e36569500d05e57fadb7a9c4455e20;

    /**
     * keccak256("ARK_RECOVERY_V1"). The recovery share of whitepaper §3.5 and
     * §5.4, as yellow paper §2.2 names it.
     */
    bytes32 internal constant RECOVERY_DOMAIN =
        0x4eae7b329f9f2fe17f6b58af08766d28f2b93286b5e3782b191cb0c0344dbfe0;

    /// whitepaper §3.2. The registry's key for an admitted asset.
    function assetKey(uint256 chainId, address asset) internal pure returns (bytes32) {
        return keccak256(abi.encode(chainId, asset));
    }

    /**
     * whitepaper §3.2. The identifier of a position, committing to its
     * beneficiary.
     *
     * The beneficiary is inside the preimage rather than stored beside it, so a
     * position and the address entitled to release it are one object. An
     * adversary holding every key on this chain has no field to change:
     * recomputing this with another beneficiary yields a different identifier,
     * corresponding to no position (invariant I4).
     *
     * The beneficiary is a QRL account and, since QIP-55 (testnet v3), a QRL
     * address is 64 bytes — it does not fit the `address` word this function
     * used to take. It enters the preimage as two 32-byte words, high half
     * then low half, which is byte-identical to including the raw 64-byte
     * address between two ordinary `abi.encode` fields. A legacy 20-byte owner
     * (the v2 line, and the local harness) is carried right-aligned in the low
     * word with a zero high word — the same bytes `abi.encode(address)` used
     * to produce, preceded by one zero word, so the two widths can never
     * collide: they differ in the high word wherever a v3 address has one.
     * `qrlOwnerWords` is the one place the split is defined.
     *
     * The chain id is in here too. The insurance product's asset key omits it
     * and consequently collides for one contract address deployed on two
     * chains; a product admitting assets on several origin chains cannot
     * inherit that.
     */
    function stakeAssetId(
        uint256 chainId,
        address asset,
        address depositor,
        bytes32 qrlOwnerHi,
        bytes32 qrlOwnerLo,
        uint64 depositNonce
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(chainId, asset, depositor, qrlOwnerHi, qrlOwnerLo, depositNonce));
    }

    /**
     * The canonical two-word form of a bound QRL owner, from its raw bytes.
     *
     * 64 bytes — the QIP-55 address — split at the middle: the first 32 bytes
     * are the high word, the last 32 the low. 20 bytes — the legacy form —
     * right-aligned in the low word, exactly where `abi.encode(address)` put
     * it, with a zero high word. Any other length is refused here rather than
     * hashed into an identifier no account on QRL could ever answer for.
     *
     * This is the origin-chain half of the same agreement the header states:
     * the registry's `_ownerWords` and the relayer's `identifiers.js` apply
     * the identical rule, and the suite asserts the three agree over a table.
     */
    function qrlOwnerWords(bytes memory boundQrlOwner)
        internal
        pure
        returns (bytes32 hi, bytes32 lo)
    {
        if (boundQrlOwner.length == 64) {
            assembly ("memory-safe") {
                hi := mload(add(boundQrlOwner, 0x20))
                lo := mload(add(boundQrlOwner, 0x40))
            }
        } else if (boundQrlOwner.length == 20) {
            assembly ("memory-safe") {
                // The 20 bytes left-aligned in a word, shifted right into the
                // right-aligned position abi.encode(address) uses.
                lo := shr(96, mload(add(boundQrlOwner, 0x20)))
            }
        } else {
            revert BadOwnerLength(boundQrlOwner.length);
        }
    }

    /// A bound owner must be a 64-byte QIP-55 address or a legacy 20-byte one.
    error BadOwnerLength(uint256 length);

    /**
     * whitepaper §3.5, yellow paper §2.2 `stakeLeafKey`, byte for byte. The
     * leaf an attester seals for an anchoring, naming the escrow it was made
     * in, which the registry keeps with the position and which every return
     * leaf of that position binds.
     */
    function stakeLeafKey(address escrow, bytes32 id, uint256 anchoredNotional) internal pure returns (bytes32) {
        return keccak256(abi.encode(STAKE_DOMAIN, escrow, id, anchoredNotional));
    }

    /**
     * whitepaper §3.5, invariant I6. The key a proof is consumed against: the
     * epoch and the leaf, never the asset.
     *
     * Consumption keyed by asset would block a legitimate re-anchoring after a
     * release. Consumption keyed by leaf alone would let an old proof be
     * replayed against a position that is no longer escrowed.
     */
    function spendKey(uint256 epoch, bytes32 leaf) internal pure returns (bytes32) {
        return keccak256(abi.encode(epoch, leaf));
    }

    /**
     * whitepaper §3.5. The payload a release commits to, signed on QRL before
     * any transaction on this chain carries it.
     *
     * This is what defeats mempool substitution. The destination is not a
     * parameter the escrow trusts: an observer resubmitting at a higher fee with
     * another recipient produces a different payload, a different leaf and no
     * membership proof, so the substitution reverts instead of winning the race.
     */
    function releasePayload(bytes32 id, address recipient, uint64 claimNonce, uint256 chainId)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(id, recipient, claimNonce, chainId));
    }

    /**
     * whitepaper §3.5. The leaf the escrow checks a release receipt against,
     * bound to that escrow: the identifier names none, and a successor escrow
     * of the same asset numbers its depositors' positions from the same nonces.
     */
    function releaseLeaf(address escrow, bytes32 payload) internal pure returns (bytes32) {
        return keccak256(abi.encode(STAKE_DOMAIN, escrow, payload));
    }

    /**
     * The message one epoch root's one-time signature signs. whitepaper §3.6.
     *
     * The yellow paper §2.2 listing signs `hash(epoch, epochRoot)`. This binds
     * the chain id and the relay's own address as well, which is strictly
     * stronger: a signature over the bare pair is admissible at every relay
     * whose commitment it reaches, so a relay deployed by mistake against a key
     * set already in use elsewhere would admit the other's roots verbatim. Here
     * a signature admits one root at one relay on one chain.
     *
     * It does not make a shared key set safe. Leaves are one-time, and a leaf
     * that signs two different messages — at two relays, or twice at one —
     * leaks enough of its chains to forge a third. One commitment serves one
     * relay.
     *
     * It binds the number of leaves the root was built on (audit 2026-09-29,
     * OL-01): `publishLeaves` then takes only a list of that length, and the
     * one ascending list of that length that hashes to the root is the true
     * one — a pair of interior nodes no longer reproduces it and latches the
     * epoch's publication against the real leaves.
     */
    function rootMessage(uint256 chainId, address relay, uint64 epoch, bytes32 epochRoot, uint32 leafCount)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(ROOT_DOMAIN, chainId, relay, epoch, epochRoot, leafCount));
    }

    /// The count of anchor leaves a forward root carries (QL-05, QL-06); `ArkStakeLeaves.anchorCountLeaf` on QRL.
    function anchorCountLeaf(uint256 epoch, uint256 count) internal pure returns (bytes32) {
        return keccak256(abi.encode(STAKE_DOMAIN, ANCHOR_COUNT_DOMAIN, epoch, count));
    }

    /**
     * The message k signers of the active generation sign to schedule the
     * next one (whitepaper §3.6, I35). `link` is the chain commitment in
     * force — the hash of the next generation's signer roots and of the
     * commitment after it — so the message names the successor exactly; the
     * epoch is the one the message consumes, as a root's does. Since V2
     * (2026-09-30, PV-18) it also carries that epoch's root and its leaf
     * count, admitted with it where the count is not zero, so an epoch with a
     * return fact is not left without a root by the authority chain.
     */
    function extensionMessage(
        uint256 chainId,
        address relay,
        uint64 epoch,
        uint8 nextGeneration,
        bytes32 link,
        bytes32 epochRoot,
        uint32 leafCount
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(EXTENSION_DOMAIN, chainId, relay, epoch, nextGeneration, link, epochRoot, leafCount));
    }

    /// The message that voids a scheduled extension during its ratchet delay: the same words under CANCEL_DOMAIN.
    function cancelMessage(
        uint256 chainId,
        address relay,
        uint64 epoch,
        uint8 nextGeneration,
        bytes32 link,
        bytes32 epochRoot,
        uint32 leafCount
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(CANCEL_DOMAIN, chainId, relay, epoch, nextGeneration, link, epochRoot, leafCount));
    }

    /**
     * One link of the authority chain: a generation's signer roots and the
     * commitment to the generation after it, `hash(signerRoots || chainCommit)`
     * of yellow paper §2.2. The last generation commits to
     * `keccak256(bytes32(0))`, which no set of roots reproduces.
     */
    function chainLink(bytes32[] memory signerRoots, bytes32 nextChainCommit) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(signerRoots, nextChainCommit));
    }

    /**
     * The declaration, as a leaf of an accepted root, for one escrow.
     * Invariant I15. The relay keeps closure per escrow, since every leaf binds
     * the escrow it acts on (D10), and QRL seals one per escrow of the chain.
     */
    function closeLeaf(uint256 chainId, address escrow) internal pure returns (bytes32) {
        return keccak256(abi.encode(STAKE_DOMAIN, CLOSE_DOMAIN, chainId, escrow));
    }

    /**
     * The protective freeze of one escrow, as a leaf of an accepted root.
     * `frozen` is inside the preimage, so the leaf that applies a freeze and
     * the leaf that lifts it are different leaves and neither can be read as
     * the other.
     */
    function freezeLeaf(uint256 chainId, address escrow, bool frozen) internal pure returns (bytes32) {
        return keccak256(abi.encode(STAKE_DOMAIN, FREEZE_DOMAIN, chainId, escrow, frozen));
    }

    /// A de-listing of one asset at one escrow on one chain. whitepaper §3.2.
    function delistLeaf(uint256 chainId, address escrow, address asset) internal pure returns (bytes32) {
        return keccak256(abi.encode(STAKE_DOMAIN, DELIST_DOMAIN, chainId, escrow, asset));
    }

    /**
     * The return of one escrow's seeding deposit, sealed for `epoch`
     * (whitepaper §4.2, yellow paper §2.2 `seedReturnLeafKey`, PV-17 of
     * 2026-09-30): QRL seals it only while no determination is open and no
     * declaration is ratified, which the escrow cannot see.
     */
    function seedReturnLeaf(uint256 chainId, address escrow, uint256 epoch) internal pure returns (bytes32) {
        return keccak256(abi.encode(STAKE_DOMAIN, SEED_RETURN_DOMAIN, chainId, escrow, epoch));
    }

    /**
     * The premium this escrow offers for epoch `epoch`, carried forward to
     * QRL: the auction pot in shares, and what those shares were worth in
     * units at the same instant, read once the lots of every earlier offering
     * have passed their origin-chain expiry. Lots are quoted in shares and the
     * reserve is a price per unit, so QRL needs the rate between them. The
     * swap offers it less what the previous offering's selected lots may still
     * take.
     *
     * The chain, the escrow and the asset are in the preimage because one
     * attestation root carries the facts of every escrow on every chain; the
     * swap on QRL records the escrow and binds every lock of the offering to it.
     */
    function premiumOfferLeaf(
        uint256 chainId,
        address escrow,
        address asset,
        uint256 epoch,
        uint256 shares,
        uint256 units
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(STAKE_DOMAIN, OFFER_DOMAIN, chainId, escrow, asset, epoch, shares, units));
    }

    /**
     * The buffer this escrow holds at `epoch`, in units of its asset, carried
     * forward to QRL, where it stands in the denominator of utilisation beside
     * bond principal (whitepaper §4.3). The chain and the asset are in the
     * preimage for the reason they are in the offer's.
     */
    function bufferLeaf(uint256 chainId, address escrow, address asset, uint256 epoch, uint256 units)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(STAKE_DOMAIN, BUFFER_DOMAIN, chainId, escrow, asset, epoch, units));
    }

    /**
     * A premium lock: one lot selected on QRL at the close of its quote
     * window, whitepaper §4.7 and yellow paper §1.4 `claimPremium`.
     *
     * `lotId` is the QRL swap's identifier of the lot, the QuantaSwap form
     * `sha256(hashlock, solver, recipient, shares, value, qrlExpiry)`.
     * `recipient` is the solver's account here and `shares` what it bought, in
     * the shares this escrow holds; `evmExpiry` is the last instant the escrow
     * pays. The offered epoch and the commitment bond are bound too, in the
     * order yellow paper §3.5 lists them, though this chain acts on neither:
     * the bond lives on QRL, and a lock is spent against the leaf itself. All
     * are committed on QRL, so a claim naming any other has no proof.
     */
    function premiumLockLeaf(uint256 chainId, address escrow, address asset, IArkStakeEscrow.PremiumLock calldata p)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                STAKE_DOMAIN,
                PREMIUM_DOMAIN,
                chainId,
                escrow,
                asset,
                p.epoch,
                p.lotId,
                p.hashlock,
                p.recipient,
                p.shares,
                p.bond,
                p.evmExpiry
            )
        );
    }

    /**
     * A completed release, as the forward path carries it back to QRL.
     *
     * The escrow emits this when a queued release is paid in full, so an
     * attester can seal it and the registry can learn that the notional in
     * transit has left the escrow. `(id, claimNonce)` names one release of one
     * position exactly, which is all the fact needs.
     */
    function releasedLeaf(address escrow, bytes32 id, uint64 claimNonce) internal pure returns (bytes32) {
        return keccak256(abi.encode(STAKE_DOMAIN, RELEASED_DOMAIN, escrow, id, claimNonce));
    }

    /**
     * The allocation for an epoch: the premium share, the two governable shares
     * that divide the rest, and the juror-fee fraction of the operations share.
     * whitepaper §4.2, yellow paper §1.4 `sweep()`.
     *
     * `stakerBps` is deliberately absent. It is the residual, recomputed on this
     * side by subtraction, which is how whitepaper §4.2's identity is enforced
     * *across* the relay rather than trusted through it. Sealing all four would
     * make the identity something a relayer asserts.
     *
     * `bufferBps`, `operationsBps` and `jurorFeeShareBps` travel with it because
     * each is governable under whitepaper §6.3 and an ownerless escrow has no
     * other way to be told about a vote. So do the levy, the target rung and
     * the cover a term commitment is topped up against, the reserve's cap
     * factor and the commitment term (whitepaper §4.2, §4.4, I39): each is
     * governable or measured on QRL, and none can be computed here.
     */
    function allocationLeaf(address escrow, uint256 epoch, IArkStakeEscrow.AllocationRates memory r)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            bytes.concat(
                abi.encode(STAKE_DOMAIN, ALLOCATION_DOMAIN, escrow, epoch, r.sigmaBps, r.bufferBps, r.operationsBps),
                abi.encode(
                    r.jurorFeeShareBps, r.levyBps, r.sigmaTargetBps, r.coveredBps, r.psrCapBps, r.commitTermEpochs, r.stepQueued
                )
            )
        );
    }

    /**
     * The loss settlement: the buffer's part of a trigger-1 determination for
     * one affected position. whitepaper §3.5 and §5.2, yellow paper §2.2
     * `lossLeafKey`, byte for byte.
     *
     * It names a quantity because its recipient holds no position whose
     * principal would fix one, and a destination because the bound beneficiary
     * names it in a message signed on QRL. `determinationId` is what makes two
     * determinations paying one position the same quantity two leaves; within
     * one determination a position is settled once, so the leaf names exactly
     * one payment.
     */
    function lossLeaf(
        uint256 chainId,
        address escrow,
        bytes32 determinationId,
        bytes32 stakeAssetId_,
        address destination,
        uint256 quantity
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(LOSS_DOMAIN, chainId, escrow, determinationId, stakeAssetId_, destination, quantity));
    }

    /**
     * One recipient's share of a realised escrow. whitepaper §3.5 and §5.4,
     * yellow paper §2.2 `shareLeafKey`, byte for byte.
     *
     * `recipient` is a bytes32 because it identifies a holder on QRL — a holder
     * of a bond class, or the bound beneficiary of a settled position — and not
     * an account on this chain. The account paid is `destination`.
     *
     * `successorId` names the admitted successor state the share is paid on
     * (whitepaper §5.4, yellow paper §4.3, I36): QRL divides one monotone
     * residual across up to three successors in admission order, and a share
     * sealed for one of them is a different leaf from the same share on
     * another, so it is spent once and on one fork. Zero names the origin
     * chain itself, where no declaration forked it (the censorship ground).
     */
    function shareLeaf(
        uint256 chainId,
        address escrow,
        bytes32 successorId,
        bytes32 recoveryId,
        bytes32 recipient,
        address destination,
        uint256 quantity
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(RECOVERY_DOMAIN, chainId, escrow, successorId, recoveryId, recipient, destination, quantity)
        );
    }
}
