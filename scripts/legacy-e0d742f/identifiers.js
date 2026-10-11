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
const { keccak256, AbiCoder, toUtf8Bytes } = require('ethers');
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
  ROOT_DOMAIN: ['ARK_STAKE_ROOT_V1', '0xaa540f17b81f003174cc8c8bee5f91c73a0b607b79402362a97790ad2acbb1b2'],
  CLOSE_DOMAIN: ['ARK_STAKE_CLOSE_V1', '0x854acbb2adebc32db3c0b7fe0c7a3791d5c71760522622e3ca604425af7bddc4'],
  FREEZE_DOMAIN: ['ARK_STAKE_FREEZE_V1', '0xf7a842f65ccc868230aea36394e131d5771b1fac9be8f1af95b9fcdbe7765126'],
  DELIST_DOMAIN: ['ARK_STAKE_DELIST_V1', '0xd579036212c3ff80f640c3a782cfb7e3b4e95bee0f19240ba9585ddbc8dd8de1'],
  PREMIUM_DOMAIN: ['ARK_STAKE_PREMIUM_V1', '0x0f69d79ec71aeeac362a477e601751754c6633e091f6b5ba015f1b74cd0183b2'],
  RELEASED_DOMAIN: ['ARK_STAKE_RELEASED_V1', '0x1b5c902ec2c18bbcb342f901ea8496a8330696a9d00d7d5f6ae055dbbf1b4cb5'],
  ALLOCATION_DOMAIN: ['ARK_STAKE_ALLOCATION_V2', '0x34c3f0e0b33580722257404ab6e79c2b03bd0f6b141588081d484b2ddce36edf'],
  LOSS_DOMAIN: ['ARK_LOSS_V1', '0xe325f1a59c183640d2cd7301dbd4a5daf3e36569500d05e57fadb7a9c4455e20'],
  RECOVERY_DOMAIN: ['ARK_RECOVERY_V1', '0x4eae7b329f9f2fe17f6b58af08766d28f2b93286b5e3782b191cb0c0344dbfe0'],
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
  PREMIUM_DOMAIN,
  RELEASED_DOMAIN,
  ALLOCATION_DOMAIN,
  LOSS_DOMAIN,
  RECOVERY_DOMAIN,
] = Object.values(DOMAINS).map(([, literal]) => literal);

/**
 * The insurance product's tag, for the domain-separation test and for nothing
 * else. A root sealed to record an anchoring must not verify against the
 * insurance claim path; keeping the other tag here is what lets a test show it.
 */
const INSURANCE_DOMAIN = keccak256(toUtf8Bytes('QUANTUM_ARK_CLAIM_V1'));

const big = (v) => (typeof v === 'bigint' ? v : BigInt(v));

/** whitepaper §3.2. The registry's key for an admitted asset. */
const assetKey = (chainId, asset) =>
  keccak256(coder.encode(['uint256', 'address'], [big(chainId), toHex(asset)]));

/**
 * whitepaper §3.2. The identifier of a position, committing to its beneficiary.
 *
 * `boundQrlOwner` is inside the preimage rather than beside it, so a position
 * and the address entitled to release it are one object: an adversary holding
 * every origin-chain key has no field to change, because recomputing this with
 * another beneficiary yields an identifier corresponding to no position.
 */
const stakeAssetId = ({ chainId, asset, depositor, boundQrlOwner, depositNonce }) =>
  keccak256(
    coder.encode(
      ['uint256', 'address', 'address', 'address', 'uint64'],
      [big(chainId), toHex(asset), toHex(depositor), toHex(boundQrlOwner), big(depositNonce)],
    ),
  );

/** whitepaper §3.5. The leaf an attester seals for an anchoring. */
const stakeLeafKey = (id, anchoredNotional) =>
  keccak256(coder.encode(['bytes32', 'bytes32', 'uint256'], [STAKE_DOMAIN, id, big(anchoredNotional)]));

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

/** whitepaper §3.5. The leaf the escrow checks a release receipt against. */
const releaseLeaf = (payload) =>
  keccak256(coder.encode(['bytes32', 'bytes32'], [STAKE_DOMAIN, payload]));

/**
 * The message one epoch root's one-time signature signs. whitepaper §3.6.
 *
 * Binds the chain and the relay as well as the pair the yellow paper §2.2
 * listing signs, so one signature admits one root at one relay on one chain.
 * One key set still serves one relay: its leaves are one-time wherever used.
 */
const rootMessage = ({ chainId, relay, epoch, epochRoot }) =>
  keccak256(
    coder.encode(
      ['bytes32', 'uint256', 'address', 'uint64', 'bytes32'],
      [ROOT_DOMAIN, big(chainId), toHex(relay), big(epoch), epochRoot],
    ),
  );

/** The declaration, as a leaf of an accepted root. Invariant I15. */
const closeLeaf = (chainId) =>
  keccak256(coder.encode(['bytes32', 'bytes32', 'uint256'], [STAKE_DOMAIN, CLOSE_DOMAIN, big(chainId)]));

/** The protective freeze. Applying and lifting are different leaves. */
const freezeLeaf = (chainId, frozen) =>
  keccak256(
    coder.encode(
      ['bytes32', 'bytes32', 'uint256', 'bool'],
      [STAKE_DOMAIN, FREEZE_DOMAIN, big(chainId), Boolean(frozen)],
    ),
  );

/** A de-listing of one asset on one chain. whitepaper §3.2. */
const delistLeaf = (chainId, asset) =>
  keccak256(
    coder.encode(
      ['bytes32', 'bytes32', 'uint256', 'address'],
      [STAKE_DOMAIN, DELIST_DOMAIN, big(chainId), toHex(asset)],
    ),
  );

/**
 * The premium settlement of whitepaper §3.5 and §4.7: the quantity cleared to
 * one bidder in one auction, and the destination it is paid to.
 */
const premiumSettlementLeaf = ({ chainId, asset, bidder, destination, quantity, auctionEpoch }) =>
  keccak256(
    coder.encode(
      ['bytes32', 'bytes32', 'uint256', 'address', 'address', 'address', 'uint256', 'uint64'],
      [
        STAKE_DOMAIN,
        PREMIUM_DOMAIN,
        big(chainId),
        toHex(asset),
        toHex(bidder),
        toHex(destination),
        big(quantity),
        big(auctionEpoch),
      ],
    ),
  );

/** A release paid in full, carried back to QRL on the forward path. */
const releasedLeaf = (id, claimNonce) =>
  keccak256(
    coder.encode(
      ['bytes32', 'bytes32', 'bytes32', 'uint64'],
      [STAKE_DOMAIN, RELEASED_DOMAIN, id, big(claimNonce)],
    ),
  );

/**
 * The allocation for an epoch. whitepaper §4.2. The staker share is absent: it
 * is the residual, recomputed on the origin chain by subtraction.
 */
const allocationLeaf = ({ epoch, sigmaBps, bufferBps, operationsBps, jurorFeeShareBps }) =>
  keccak256(
    coder.encode(
      ['bytes32', 'bytes32', 'uint256', 'uint16', 'uint16', 'uint16', 'uint16'],
      [
        STAKE_DOMAIN,
        ALLOCATION_DOMAIN,
        big(epoch),
        big(sigmaBps),
        big(bufferBps),
        big(operationsBps),
        big(jurorFeeShareBps),
      ],
    ),
  );

/**
 * The loss settlement: the buffer's part of a trigger-1 determination for one
 * position. whitepaper §3.5 and §5.2, yellow paper §2.2 `lossLeafKey`.
 *
 * Under LOSS_DOMAIN alone, not prefixed by STAKE_DOMAIN: that is how the
 * listing writes it and how the QRL registry seals it.
 */
const lossLeaf = ({ chainId, determinationId, stakeAssetId, destination, quantity }) =>
  keccak256(
    coder.encode(
      ['bytes32', 'uint256', 'bytes32', 'bytes32', 'address', 'uint256'],
      [LOSS_DOMAIN, big(chainId), determinationId, stakeAssetId, toHex(destination), big(quantity)],
    ),
  );

/**
 * One recipient's share of a realised escrow. whitepaper §3.5 and §5.4, yellow
 * paper §2.2 `shareLeafKey`. `recipient` is a bytes32 naming a holder on QRL;
 * `destination` is the account on this chain that is paid.
 */
const shareLeaf = ({ chainId, recoveryId, recipient, destination, quantity }) =>
  keccak256(
    coder.encode(
      ['bytes32', 'uint256', 'bytes32', 'bytes32', 'address', 'uint256'],
      [RECOVERY_DOMAIN, big(chainId), recoveryId, recipient, toHex(destination), big(quantity)],
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
  PREMIUM_DOMAIN,
  RELEASED_DOMAIN,
  ALLOCATION_DOMAIN,
  LOSS_DOMAIN,
  RECOVERY_DOMAIN,
  INSURANCE_DOMAIN,
  rootMessage,
  closeLeaf,
  freezeLeaf,
  delistLeaf,
  premiumSettlementLeaf,
  releasedLeaf,
  allocationLeaf,
  lossLeaf,
  shareLeaf,
  assetKey,
  stakeAssetId,
  stakeLeafKey,
  spendKey,
  releasePayload,
  releaseLeaf,
  insuranceLeafKey,
};
