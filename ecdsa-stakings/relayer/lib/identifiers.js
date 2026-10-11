/**
 * The cross-chain preimages, in JavaScript.
 *
 * The one rule this module exists to enforce: **there is one definition of each
 * preimage, and a disagreement with contracts/ArkStakeRegistry.hyp is a bug
 * here and never there.**
 *
 * Three implementations of these hashes exist — Hyperion on QRL, Solidity on the
 * origin chain, and this one — and a divergence in any of them produces an
 * identifier that corresponds to no position rather than an error anyone sees.
 * The suite therefore asserts all three agree rather than trusting the
 * transcription; see ecdsa-stakings/relayer/test and the on-chain agreement test.
 *
 * Everything is `abi.encode`, never `encodePacked`. The insurance product's
 * `assetHash` in test/harness.js is packed, and it is a different scheme for a
 * different product — do not reach for it here.
 */
const { keccak256, sha256, AbiCoder, toUtf8Bytes, concat } = require('ethers');
const { toHex } = require('./addresses');

const coder = AbiCoder.defaultAbiCoder();

/**
 * The domain tags. whitepaper §3.5, yellow paper §2.2.
 *
 * Written as literals so a reader can check each against the deployed
 * constant, and asserted against its own preimage at load so a literal cannot
 * drift from the string it claims to be. A wrong domain tag fails every proof
 * rather than some of them, which is the good failure — but only if it fails at
 * startup rather than in production.
 */
const DOMAINS = {
  STAKE_DOMAIN: ['ARK_STAKE_V1', '0x7b78fb66e5c4c423ff7a9a14a2788b272f00bb59ce43a9623718bad3f1cfa45d'],
  // V2 since 2026-09-30: the root message binds the leaf count (audit 2026-09-29, OL-01).
  ROOT_DOMAIN: ['ARK_STAKE_ROOT_V2', '0x28f329df1ec937d6b558d9c77f38d6f96757f3ed829c76c3657598934ac1d099'],
  CLOSE_DOMAIN: ['ARK_STAKE_CLOSE_V1', '0x854acbb2adebc32db3c0b7fe0c7a3791d5c71760522622e3ca604425af7bddc4'],
  FREEZE_DOMAIN: ['ARK_STAKE_FREEZE_V1', '0xf7a842f65ccc868230aea36394e131d5771b1fac9be8f1af95b9fcdbe7765126'],
  DELIST_DOMAIN: ['ARK_STAKE_DELIST_V1', '0xd579036212c3ff80f640c3a782cfb7e3b4e95bee0f19240ba9585ddbc8dd8de1'],
  OFFER_DOMAIN: ['ARK_STAKE_OFFER_V1', '0xf31bdf39f2b36a1d845fa0ebddd9ede2a75e86163753426f768bda2e43a49745'],
  PREMIUM_DOMAIN: ['ARK_STAKE_PREMIUM_V3', '0x62aa012827ba11814bd6dd90fc72ca32919303403d8827a8d5788a3b0f1cd888'],
  RELEASED_DOMAIN: ['ARK_STAKE_RELEASED_V1', '0x1b5c902ec2c18bbcb342f901ea8496a8330696a9d00d7d5f6ae055dbbf1b4cb5'],
  // V4 since 2026-09-30 (PV-20, QL-25): the leaf carries stepQueued.
  ALLOCATION_DOMAIN: ['ARK_STAKE_ALLOCATION_V4', '0x00dea64034af1c14fb698f0f5d5dc90f019a7ebd16e16a20664167d7d7e352fc'],
  LOSS_DOMAIN: ['ARK_LOSS_V1', '0xe325f1a59c183640d2cd7301dbd4a5daf3e36569500d05e57fadb7a9c4455e20'],
  RECOVERY_DOMAIN: ['ARK_RECOVERY_V1', '0x4eae7b329f9f2fe17f6b58af08766d28f2b93286b5e3782b191cb0c0344dbfe0'],
  BUFFER_DOMAIN: ['ARK_STAKE_BUFFER_V1', '0x797db8e4a78fe7f6eaad089bffcc820051f8a3ade37bddda13e381d8da78551d'],
  // V2 since 2026-09-30 (PV-18, PV-22): the root of the consumed epoch and its leaf count ride with the message.
  EXTENSION_DOMAIN: ['ARK_STAKE_EXTENSION_V2', '0x9cc4c495e4dccc21ca61da2dba35f3866f1270a760307484e835a6c218b708ff'],
  CANCEL_DOMAIN: ['ARK_STAKE_CANCEL_V2', '0x77c6434a01f6eefea760fc29b5118cd7a5063a21f169526fc28a537725c0dedb'],
  // V2 since the re-audit of 2026-09-30 (BOND-02): the count is cumulative through the epoch.
  ANCHOR_COUNT_DOMAIN: ['ARK_STAKE_ANCHOR_COUNT_V2', '0x0652b5706f2b29d23becd11203d7bae566e534e4d3302e3192469ec4de809774'],
  // 2026-09-30 (PV-17): the seed return, sealed only while nothing is open on QRL.
  SEED_RETURN_DOMAIN: ['ARK_STAKE_SEED_RETURN_V1', '0xdce3579d119514aadb22ec03905469f05765676c8f51e30c9797f196abfc5750'],
};
for (const [name, [preimage, literal]] of Object.entries(DOMAINS)) {
  if (literal !== keccak256(toUtf8Bytes(preimage))) {
    throw new Error(`${name} literal does not match keccak256("${preimage}")`);
  }
}
const [
  STAKE_DOMAIN,
  ROOT_DOMAIN,
  CLOSE_DOMAIN,
  FREEZE_DOMAIN,
  DELIST_DOMAIN,
  OFFER_DOMAIN,
  PREMIUM_DOMAIN,
  RELEASED_DOMAIN,
  ALLOCATION_DOMAIN,
  LOSS_DOMAIN,
  RECOVERY_DOMAIN,
  BUFFER_DOMAIN,
  EXTENSION_DOMAIN,
  CANCEL_DOMAIN,
  ANCHOR_COUNT_DOMAIN,
  SEED_RETURN_DOMAIN,
] = Object.values(DOMAINS).map(([, literal]) => literal);

/**
 * The insurance product's tag, for the domain-separation test and for nothing
 * else. A root sealed to record an anchoring must not verify against the
 * insurance claim path; keeping the other tag here is what lets a test show it.
 */
const INSURANCE_DOMAIN = keccak256(toUtf8Bytes('QUANTUM_ARK_CLAIM_V1'));

const big = (v) => (typeof v === 'bigint' ? v : BigInt(v));

/**
 * The canonical two-word form of a QRL account, from its hex form.
 *
 * A QIP-55 (testnet v3) QRL address is 64 bytes: it enters a preimage as two
 * 32-byte words, high half then low half — byte-identical to the raw address
 * between two ordinary `abi.encode` fields. The legacy 20-byte form is carried
 * right-aligned in the low word with a zero high word, which is exactly the
 * bytes `abi.encode(address)` used to produce preceded by one zero word, so
 * the two widths can never collide. Any other length is refused: an
 * identifier hashed over a malformed owner is a position no account on QRL
 * could ever answer for.
 *
 * The same rule lives in ArkStakeIds.qrlOwnerWords (Solidity) and the QRL
 * registry's `_ownerWords` (Hyperion); the suite asserts the three agree.
 */
const qrlOwnerWords = (owner) => {
  const hex = String(owner).replace(/^0x|^Q/, '').toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex)) throw new Error(`not a hex account: ${owner}`);
  if (hex.length === 128) return { hi: `0x${hex.slice(0, 64)}`, lo: `0x${hex.slice(64)}` };
  if (hex.length === 40) return { hi: `0x${'0'.repeat(64)}`, lo: `0x${'0'.repeat(24)}${hex}` };
  throw new Error(`a QRL account is 64 bytes (or the legacy 20): got ${hex.length / 2}`);
};

/** whitepaper §3.2. The registry's key for an admitted asset. */
const assetKey = (chainId, asset) =>
  keccak256(coder.encode(['uint256', 'address'], [big(chainId), toHex(asset)]));

/**
 * whitepaper §3.2. The identifier of a position, committing to its beneficiary.
 *
 * `boundQrlOwner` is inside the preimage rather than beside it, so a position
 * and the address entitled to release it are one object: an adversary holding
 * every origin-chain key has no field to change, because recomputing this with
 * another beneficiary yields an identifier corresponding to no position. It is
 * a QRL account and enters as the two words of `qrlOwnerWords`, since QIP-55
 * made it 64 bytes.
 */
const stakeAssetId = ({ chainId, asset, depositor, boundQrlOwner, depositNonce }) => {
  const owner = qrlOwnerWords(boundQrlOwner);
  return keccak256(
    coder.encode(
      ['uint256', 'address', 'address', 'bytes32', 'bytes32', 'uint64'],
      [big(chainId), toHex(asset), toHex(depositor), owner.hi, owner.lo, big(depositNonce)],
    ),
  );
};

/**
 * whitepaper §3.5, yellow paper §2.2 `stakeLeafKey`. The leaf an attester
 * seals for an anchoring, naming the escrow it was made in (D10): every leaf
 * binds the origin-chain address of the escrow that pays it.
 */
const stakeLeafKey = (escrow, id, anchoredNotional) =>
  keccak256(coder.encode(['bytes32', 'address', 'bytes32', 'uint256'], [STAKE_DOMAIN, toHex(escrow), id, big(anchoredNotional)]));

/**
 * whitepaper §3.5, invariant I6. The key a proof is consumed against: the
 * epoch and the leaf, never the asset. Consumption keyed by asset would block a
 * legitimate re-anchoring after a release; keyed by leaf alone it would let an
 * old proof be replayed against a position no longer escrowed.
 */
const spendKey = (epoch, leaf) =>
  keccak256(coder.encode(['uint256', 'bytes32'], [big(epoch), leaf]));

/** whitepaper §3.5. Committed on QRL before any origin-chain transaction exists. */
const releasePayload = ({ id, recipient, claimNonce, chainId }) =>
  keccak256(
    coder.encode(
      ['bytes32', 'address', 'uint64', 'uint256'],
      [id, toHex(recipient), big(claimNonce), big(chainId)],
    ),
  );

/** whitepaper §3.5. The leaf the escrow checks a release receipt against, bound to that escrow (D10). */
const releaseLeaf = (escrow, payload) =>
  keccak256(coder.encode(['bytes32', 'address', 'bytes32'], [STAKE_DOMAIN, toHex(escrow), payload]));

/**
 * The message one epoch root's one-time signature signs. whitepaper §3.6.
 *
 * Binds the chain and the relay as well as the pair the yellow paper §2.2
 * listing signs, so one signature admits one root at one relay on one chain.
 * One key set still serves one relay: its leaves are one-time wherever used.
 * And the number of leaves the root is built on (audit 2026-09-29, OL-01):
 * the relay's `publishLeaves` takes only a list of that length, which only
 * the true leaves can be.
 */
const rootMessage = ({ chainId, relay, epoch, epochRoot, leafCount }) => {
  if (leafCount === undefined || leafCount === null || big(leafCount) === 0n) {
    throw new Error('rootMessage: a root message binds its leaf count, and a root has at least one leaf');
  }
  return keccak256(
    coder.encode(
      ['bytes32', 'uint256', 'address', 'uint64', 'bytes32', 'uint32'],
      [ROOT_DOMAIN, big(chainId), toHex(relay), big(epoch), epochRoot, big(leafCount)],
    ),
  );
};

/**
 * The forward root's count of anchor leaves (`ArkStakeLeaves.anchorCountLeaf`
 * on QRL, `ArkStakeIds.anchorCountLeaf`; audit 2026-09-29, QL-05, QL-06):
 * CUMULATIVE since the re-audit of 2026-09-30 (BOND-02), every stake leaf of
 * every root through `epoch`, unchanged by a quiet one. Sealed into the root
 * of every closed origin epoch — alone where the epoch was quiet — so the
 * bond's trigger-2 settlement waits for every anchor of every epoch before a
 * declaration's, however late its root was sealed.
 */
const anchorCountLeaf = ({ epoch, count }) =>
  keccak256(coder.encode(['bytes32', 'bytes32', 'uint256', 'uint256'], [STAKE_DOMAIN, ANCHOR_COUNT_DOMAIN, big(epoch), big(count)]));

const ZERO_WORD = '0x' + '00'.repeat(32);

/**
 * The message k signers of the active generation sign to schedule the next
 * link of the authority chain (whitepaper §3.6, I35). `link` is the relay's
 * `chainCommit`; `epoch` is the elapsed epoch the message consumes; since V2
 * (2026-09-30, PV-18) `epochRoot` and `leafCount` are that epoch's root,
 * which rides with the message where the count is not zero (zero and zero:
 * no root rides).
 */
const extensionMessage = ({ chainId, relay, epoch, nextGeneration, link, epochRoot = ZERO_WORD, leafCount = 0 }) =>
  keccak256(
    coder.encode(
      ['bytes32', 'uint256', 'address', 'uint64', 'uint8', 'bytes32', 'bytes32', 'uint32'],
      [EXTENSION_DOMAIN, big(chainId), toHex(relay), big(epoch), Number(nextGeneration), link, epochRoot, Number(leafCount)],
    ),
  );

/** The message that voids a scheduled extension during its ratchet delay, its epoch's root riding as with an extension. */
const cancelMessage = ({ chainId, relay, epoch, nextGeneration, link, epochRoot = ZERO_WORD, leafCount = 0 }) =>
  keccak256(
    coder.encode(
      ['bytes32', 'uint256', 'address', 'uint64', 'uint8', 'bytes32', 'bytes32', 'uint32'],
      [CANCEL_DOMAIN, big(chainId), toHex(relay), big(epoch), Number(nextGeneration), link, epochRoot, Number(leafCount)],
    ),
  );

/** What the last generation commits to: keccak256(bytes32(0)), which no set of roots reproduces. */
const TERMINAL_COMMIT = keccak256('0x' + '00'.repeat(32));

/** One link of the authority chain: keccak256(signerRoots || nextChainCommit), packed (`ArkStakeIds.chainLink`). */
const chainLink = (signerRoots, nextChainCommit) => keccak256(concat([...signerRoots, nextChainCommit]));

/**
 * The commitment each generation holds while active, from the signer roots of
 * every generation (index 0 is generation 1): `commits[g]` is
 * `chainLink(generations[g + 1], commits[g + 1])`, the last one the terminal
 * commitment. The relay is constructed with `generations[0]` and `commits[0]`.
 */
function chainCommits(generations) {
  const commits = new Array(generations.length);
  commits[generations.length - 1] = TERMINAL_COMMIT;
  for (let g = generations.length - 2; g >= 0; g -= 1) commits[g] = chainLink(generations[g + 1], commits[g + 1]);
  return commits;
}

/** The declaration, for one escrow, as a leaf of an accepted root. Invariant I15. */
const closeLeaf = (chainId, escrow) =>
  keccak256(coder.encode(['bytes32', 'bytes32', 'uint256', 'address'], [STAKE_DOMAIN, CLOSE_DOMAIN, big(chainId), toHex(escrow)]));

/** The protective freeze of one escrow. Applying and lifting are different leaves. */
const freezeLeaf = (chainId, escrow, frozen) =>
  keccak256(
    coder.encode(
      ['bytes32', 'bytes32', 'uint256', 'address', 'bool'],
      [STAKE_DOMAIN, FREEZE_DOMAIN, big(chainId), toHex(escrow), Boolean(frozen)],
    ),
  );

/** A de-listing of one asset at one escrow on one chain. whitepaper §3.2. */
const delistLeaf = (chainId, escrow, asset) =>
  keccak256(
    coder.encode(
      ['bytes32', 'bytes32', 'uint256', 'address', 'address'],
      [STAKE_DOMAIN, DELIST_DOMAIN, big(chainId), toHex(escrow), toHex(asset)],
    ),
  );

/**
 * The return of one escrow's seeding deposit, sealed for `epoch` only while
 * no determination is open and no declaration is ratified on QRL (whitepaper
 * §4.2, yellow paper §2.2 `seedReturnLeafKey`, PV-17). `ArkStakeIds` and
 * `ArkStakeLeaves.seedReturnLeaf` build the same word.
 */
const seedReturnLeaf = (chainId, escrow, epoch) =>
  keccak256(
    coder.encode(
      ['bytes32', 'bytes32', 'uint256', 'address', 'uint256'],
      [STAKE_DOMAIN, SEED_RETURN_DOMAIN, big(chainId), toHex(escrow), big(epoch)],
    ),
  );

/**
 * The premium an escrow offers for an epoch, carried forward to QRL: the
 * auction pot in shares, and those shares' worth in units at the same instant.
 */
const premiumOfferLeaf = ({ chainId, escrow, asset, epoch, shares, units }) =>
  keccak256(
    coder.encode(
      ['bytes32', 'bytes32', 'uint256', 'address', 'address', 'uint256', 'uint256', 'uint256'],
      [STAKE_DOMAIN, OFFER_DOMAIN, big(chainId), toHex(escrow), toHex(asset), big(epoch), big(shares), big(units)],
    ),
  );

/**
 * The buffer an escrow holds at an epoch, in units, carried forward to QRL
 * (`ArkStakeIds.bufferLeaf`, `ArkStakeRegistry.bufferLeaf`): buffer_orig of
 * whitepaper §4.3, beside bond principal in the denominator of utilisation.
 */
const bufferLeaf = ({ chainId, escrow, asset, epoch, units }) =>
  keccak256(
    coder.encode(
      ['bytes32', 'bytes32', 'uint256', 'address', 'address', 'uint256', 'uint256'],
      [STAKE_DOMAIN, BUFFER_DOMAIN, big(chainId), toHex(escrow), toHex(asset), big(epoch), big(units)],
    ),
  );

/**
 * A premium lock: one lot selected on QRL, paid by the escrow's
 * `claimPremium` to `recipient` in `shares` against the preimage of
 * `hashlock`, before `evmExpiry`. whitepaper §3.5 and §4.7. V3 since
 * 2026-09-28: yellow paper §3.5 binds the offered epoch and the solver's
 * commitment bond (I33) as well, after the asset.
 */
const premiumLockLeaf = ({ chainId, escrow, asset, epoch, lotId, hashlock, recipient, shares, bond, evmExpiry }) =>
  keccak256(
    coder.encode(
      ['bytes32', 'bytes32', 'uint256', 'address', 'address', 'uint256', 'bytes32', 'bytes32', 'address', 'uint256', 'uint256', 'uint64'],
      [
        STAKE_DOMAIN,
        PREMIUM_DOMAIN,
        big(chainId),
        toHex(escrow),
        toHex(asset),
        big(epoch),
        lotId,
        hashlock,
        toHex(recipient),
        big(shares),
        big(bond),
        big(evmExpiry),
      ],
    ),
  );

/**
 * The QRL swap's identifier of a lot: sha256 over the ABI encoding of the
 * hashlock, the solver, its origin-chain recipient, the shares, the QRL locked
 * and the QRL expiry — QuantaSwap's identifier form (yellow paper §1.4 `quote`).
 *
 * The solver is a QRL account — the swap's `msg.sender` — so it enters as the
 * two words of `qrlOwnerWords`, like the bound owner of `stakeAssetId`; the
 * recipient stays one word, an origin-chain address.
 */
const lotIdOf = ({ hashlock, solver, recipient, shares, value, qrlExpiry }) => {
  const s = qrlOwnerWords(solver);
  return sha256(
    coder.encode(
      ['bytes32', 'bytes32', 'bytes32', 'address', 'uint256', 'uint256', 'uint64'],
      [hashlock, s.hi, s.lo, toHex(recipient), big(shares), big(value), big(qrlExpiry)],
    ),
  );
};

/** The hashlock of a swap secret, as both chains compute it: sha256 of the 32 bytes. */
const hashlockOf = (preimage) => sha256(preimage);

/** A release paid in full by `escrow`, carried back to QRL on the forward path. */
const releasedLeaf = (escrow, id, claimNonce) =>
  keccak256(
    coder.encode(
      ['bytes32', 'bytes32', 'address', 'bytes32', 'uint64'],
      [STAKE_DOMAIN, RELEASED_DOMAIN, toHex(escrow), id, big(claimNonce)],
    ),
  );

/**
 * The allocation for an epoch. whitepaper §4.2, §4.4. The staker share is
 * absent: it is the residual, recomputed on the origin chain by subtraction.
 * V3 since 2026-09-28 (gap item 19, I39): the stabilization levy in force, the
 * ladder rung and the cover a term commitment is topped up against, the
 * reserve's cap factor `psrCapEpochs * (sigma_4 - sigma_1)`, and the
 * commitment term a position anchoring now commits for.
 */
const ALLOCATION_FIELDS = [
  'sigmaBps',
  'bufferBps',
  'operationsBps',
  'jurorFeeShareBps',
  'levyBps',
  'sigmaTargetBps',
  'coveredBps',
  'psrCapBps',
  'commitTermEpochs',
  // V4: a step of the threat stage queued, a bool (one word, 0 or 1, as the uint16 fields).
  'stepQueued',
];
const allocationLeaf = (a) =>
  keccak256(
    coder.encode(
      ['bytes32', 'bytes32', 'address', 'uint256', ...ALLOCATION_FIELDS.map((f) => (f === 'stepQueued' ? 'bool' : 'uint16'))],
      [STAKE_DOMAIN, ALLOCATION_DOMAIN, toHex(a.escrow), big(a.epoch), ...ALLOCATION_FIELDS.map((f) => (f === 'stepQueued' ? Boolean(Number(a[f] ?? 0)) : big(a[f])))],
    ),
  );

/**
 * The loss settlement: the buffer's part of a trigger-1 determination for one
 * position. whitepaper §3.5 and §5.2, yellow paper §2.2 `lossLeafKey`.
 *
 * Under LOSS_DOMAIN alone, not prefixed by STAKE_DOMAIN: that is how the
 * listing writes it and how the QRL registry seals it.
 */
const lossLeaf = ({ chainId, escrow, determinationId, stakeAssetId, destination, quantity }) =>
  keccak256(
    coder.encode(
      ['bytes32', 'uint256', 'address', 'bytes32', 'bytes32', 'address', 'uint256'],
      [LOSS_DOMAIN, big(chainId), toHex(escrow), determinationId, stakeAssetId, toHex(destination), big(quantity)],
    ),
  );

/**
 * One recipient's share of a realised escrow. whitepaper §3.5 and §5.4, yellow
 * paper §2.2 `shareLeafKey`. `recipient` is a bytes32 naming a holder on QRL;
 * `destination` is the account on this chain that is paid; `successorId` the
 * admitted successor state it is paid on (I36; zero is the origin chain).
 */
const ZERO32 = '0x' + '00'.repeat(32);
const shareLeaf = ({ chainId, escrow, successorId = ZERO32, recoveryId, recipient, destination, quantity }) =>
  keccak256(
    coder.encode(
      ['bytes32', 'uint256', 'address', 'bytes32', 'bytes32', 'bytes32', 'address', 'uint256'],
      [RECOVERY_DOMAIN, big(chainId), toHex(escrow), successorId, recoveryId, recipient, toHex(destination), big(quantity)],
    ),
  );

/** The insurance leaf space, for the domain-separation test only. */
const insuranceLeafKey = (id, notional) =>
  keccak256(
    coder.encode(['bytes32', 'bytes32', 'uint256'], [INSURANCE_DOMAIN, id, big(notional)]),
  );

module.exports = {
  DOMAINS,
  STAKE_DOMAIN,
  ROOT_DOMAIN,
  CLOSE_DOMAIN,
  FREEZE_DOMAIN,
  DELIST_DOMAIN,
  OFFER_DOMAIN,
  PREMIUM_DOMAIN,
  RELEASED_DOMAIN,
  ALLOCATION_DOMAIN,
  LOSS_DOMAIN,
  RECOVERY_DOMAIN,
  BUFFER_DOMAIN,
  EXTENSION_DOMAIN,
  CANCEL_DOMAIN,
  ANCHOR_COUNT_DOMAIN,
  SEED_RETURN_DOMAIN,
  INSURANCE_DOMAIN,
  TERMINAL_COMMIT,
  rootMessage,
  anchorCountLeaf,
  extensionMessage,
  cancelMessage,
  chainLink,
  chainCommits,
  closeLeaf,
  freezeLeaf,
  delistLeaf,
  seedReturnLeaf,
  premiumOfferLeaf,
  bufferLeaf,
  premiumLockLeaf,
  lotIdOf,
  hashlockOf,
  releasedLeaf,
  allocationLeaf,
  ALLOCATION_FIELDS,
  lossLeaf,
  shareLeaf,
  assetKey,
  qrlOwnerWords,
  stakeAssetId,
  stakeLeafKey,
  spendKey,
  releasePayload,
  releaseLeaf,
  insuranceLeafKey,
};
