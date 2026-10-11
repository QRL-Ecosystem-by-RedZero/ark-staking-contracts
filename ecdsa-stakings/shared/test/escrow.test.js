/**
 * ArkStakeEscrow: what it takes in, how it divides the yield, and the paths
 * anything leaves by.
 *
 * Every test is named for the rule it defends rather than the call it makes,
 * because when one fails the name alone should say what broke. The rules are
 * whitepaper §3.2's properties of the bytecode, §3.3's lifecycle and its fixed
 * queue base, §3.5's four return messages, §4.2's allocation, §4.7's held
 * premium, §5.2's buffer and §5.4's recovery, and yellow paper §1.4's
 * origin-chain interface.
 *
 * Both escrow forms are exercised. The rebasing one is not a variant to cover
 * for completeness: recording principal in shares fixes one failure and creates
 * the opposite one, and the two-term yield expression that resolves both is
 * only exercised here.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { keccak256, toUtf8Bytes, AbiCoder } = require('ethers');

const { ACCOUNTS } = require('../../../test/harness');
const { originChain, relayFixture, epochOf, CHAIN_ID, EPOCH: EPOCH_N } = require('./helpers');

const ids = require('../../relayer/lib/identifiers');
const { loadModel, MISSING } = require('../../../test/spec-model');

const EPOCH = Number(EPOCH_N);
const DAY = 24 * 60 * 60;
const ONE = 10n ** 18n;
const BPS = 10_000n;
const ZERO_ADDR = '0x' + '00'.repeat(20);
const ZERO32 = '0x' + '00'.repeat(32);

const OPS_DEST = '0x' + 'ef'.repeat(20);
const BIDDER = '0x' + 'b1'.repeat(20);
const BIDDER_DEST = '0x' + 'b2'.repeat(20);
const SEED_MINIMUM = 10n * ONE;
/**
 * The escrow's AUDIT_YIELD_RATE (EC-08, PV-04): the admission audit's
 * reference yield, one epoch of gross yield per unit, 1e18 fixed point —
 * 2.20% a year, `auditYieldRateOf({})` of scripts/lib/deploy.js.
 */
const AUDIT_RATE = 421917808219179n;

/**
 * The bound beneficiary, in both renderings. ethers refuses the `Q` form, so
 * contract calls use the hex form; the `Q` form is kept because the identifier
 * must come out the same from either.
 */
const QRL_OWNER = '0x' + '66'.repeat(20);
const QRL_OWNER_Q = 'Q' + '66'.repeat(20);
// The canonical words of the legacy 20-byte owner: a zero high word, the
// address right-aligned in the low one (ArkStakeIds.qrlOwnerWords).
const QRL_OWNER_HI = '0x' + '00'.repeat(32);
const QRL_OWNER_LO = '0x' + '00'.repeat(12) + '66'.repeat(20);
// A QIP-55 owner: 64 bytes, whose words are simply its two halves.
const QRL_OWNER_V3 = '0x' + 'ab'.repeat(32) + 'cd'.repeat(32);
const QRL_OWNER_V3_Q = 'Q' + 'ab'.repeat(32) + 'cd'.repeat(32);

/**
 * A book on one asset, seeded unless told otherwise.
 *
 * `rebasing` picks the concrete escrow, and nothing else in a test changes with
 * it — which is the point of the abstract/concrete split: there is no runtime
 * flag to get wrong.
 */
async function fixture({ rebasing = false, treeHeight = 5, seeded = true, ownerLength = 20, auditRate = AUDIT_RATE } = {}) {
  const chain = await originChain();
  const r = await relayFixture(chain, { treeHeight });
  const { relay } = r;

  let asset;
  let escrow;
  if (rebasing) {
    asset = await chain.deploy('MockRebasingAsset');
    escrow = await chain.deploy(
      'ArkStakeEscrowShares',
      ['address', 'address', 'address', 'address', 'uint256', 'uint256', 'uint256'],
      [asset.address, asset.address, relay.address, OPS_DEST, SEED_MINIMUM, ownerLength, auditRate],
    );
  } else {
    asset = await chain.deploy('MockAsset');
    escrow = await chain.deploy(
      'ArkStakeEscrowUnits',
      ['address', 'address', 'address', 'uint256', 'uint256', 'uint256'],
      [asset.address, relay.address, OPS_DEST, SEED_MINIMUM, ownerLength, auditRate],
    );
  }

  const fund = async (who, units) => {
    await asset.send('mint', [who, units]);
    await asset.send('approve', [escrow.address, units * 10n], { from: who });
  };
  for (const who of [ACCOUNTS.admin, ACCOUNTS.alice, ACCOUNTS.bob, ACCOUNTS.mallory]) {
    await fund(who, 1_000n * ONE);
  }
  if (seeded) await escrow.send('seed', [SEED_MINIMUM], { from: ACCOUNTS.admin });

  const epoch = () => epochOf(chain);

  /** Record an allocation, proven against a fresh root. */
  const setAllocation = async (o = {}) => {
    const e = await r.freshEpoch();
    const { rates, leaf } = allocationOf(escrow.address, e, o);
    const s = await r.seal(leaf);
    const res = await escrow.send('recordEpochAllocation', [s.epoch, rates, s.proof(leaf)], { from: ACCOUNTS.mallory });
    return { ...s, res };
  };

  const anchorFor = async (who, units, owner = QRL_OWNER) => {
    const nonce = await escrow.call('nonceOf', [who]);
    const res = await escrow.send('anchor', [owner, units], { from: who });
    const [ev] = escrow.events(res, 'Anchored');
    return { id: ev.args.stakeAssetId, notional: ev.args.anchoredNotional, nonce, res };
  };

  const releaseLeaf = (id, recipient, claimNonce = 1n) =>
    ids.releaseLeaf(escrow.address, ids.releasePayload({ id, recipient, claimNonce, chainId: CHAIN_ID }));

  const release = (id, recipient, s, leaf = releaseLeaf(id, recipient)) =>
    escrow.send('release', [id, recipient, 1n, s.epoch, s.proof(leaf)], { from: ACCOUNTS.mallory });

  const balance = (who) => asset.call('balanceOf', [who]);

  /**
   * This escrow's seed-return leaf, sealed into the root of a fresh epoch
   * (PV-17; QRL seals it only while nothing is open there): the `(epoch,
   * proof)` arguments of `withdrawSeed`.
   */
  const seedReturn = async () => {
    const e = await r.freshEpoch();
    const leaf = ids.seedReturnLeaf(CHAIN_ID, escrow.address, e);
    const s = await r.seal(leaf);
    return [s.epoch, s.proof(leaf)];
  };

  /** Close this escrow's anchoring on its de-listing leaf: since ORIGIN-01 the seed returns only then. */
  const delist = async () => {
    const leaf = ids.delistLeaf(CHAIN_ID, escrow.address, asset.address);
    const s = await r.seal(leaf);
    await escrow.send('closeAnchoring', [s.epoch, s.proof(leaf)], { from: ACCOUNTS.mallory });
  };

  return {
    auditRate,
    delist,
    chain,
    ...r,
    asset,
    escrow,
    epoch,
    setAllocation,
    anchorFor,
    releaseLeaf,
    release,
    balance,
    seedReturn,
    rebasing,
    // Every leaf binds the escrow it acts on (D10): the closure, the freeze and
    // the allocation are this escrow's.
    declare: () => r.declare(escrow.address),
    freeze: (frozen) => r.freeze(escrow.address, frozen),
    allocationOf: (epoch, o) => allocationOf(escrow.address, epoch, o),
  };
}

/**
 * An allocation's rates, as `recordEpochAllocation` takes them, and its V4 leaf.
 * The defaults are the four streams the suite was written against, with no
 * levy and no commitment offered (gap item 19 defaults them to nothing), and
 * no stage step queued (V4, 2026-09-30).
 */
const RATE_DEFAULTS = { sigma: 3000, buffer: 250, ops: 250, juror: 0, levy: 0, target: 0, covered: 10000, psrCap: 0, term: 0, step: false };
function allocationOf(escrow, epoch, o = {}) {
  const a = { ...RATE_DEFAULTS, ...o };
  const rates = [a.sigma, a.buffer, a.ops, a.juror, a.levy, a.target, a.covered, a.psrCap, a.term, a.step];
  const leaf = ids.allocationLeaf({
    escrow,
    epoch,
    sigmaBps: a.sigma,
    bufferBps: a.buffer,
    operationsBps: a.ops,
    jurorFeeShareBps: a.juror,
    levyBps: a.levy,
    sigmaTargetBps: a.target,
    coveredBps: a.covered,
    psrCapBps: a.psrCap,
    commitTermEpochs: a.term,
    stepQueued: a.step,
  });
  return { rates, leaf };
}

const V1_ALLOCATION_DOMAIN = keccak256(toUtf8Bytes('ARK_STAKE_ALLOCATION_V1'));
const v1AllocationLeaf = (epoch, sigma, buffer, ops) =>
  keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32', 'uint256', 'uint16', 'uint16', 'uint16'],
      [ids.STAKE_DOMAIN, V1_ALLOCATION_DOMAIN, epoch, sigma, buffer, ops],
    ),
  );

/** positionShares + bufferShares + auctionShares + queuedShares + unclaimedShares + psrShares: the six pots. */
async function owed(escrow) {
  let sum = 0n;
  for (const f of ['positionShares', 'bufferShares', 'auctionShares', 'queuedShares', 'unclaimedShares', 'psrShares']) {
    sum += await escrow.call(f);
  }
  return sum;
}

/* ------------------------------------------------------------------ */

describe('the seeding deposit, ahead of the first anchor', () => {
  test('anchoring does not open until the seeding deposit is held', async () => {
    // whitepaper §4.2: with an empty buffer bond principal is first loss for
    // every event, including the small ones the buffer exists to absorb.
    const ctx = await fixture({ seeded: false });
    await assert.rejects(
      ctx.escrow.send('anchor', [QRL_OWNER, 10n * ONE], { from: ACCOUNTS.alice }),
      /SeedingAbsent/,
    );
  });

  test('the seeding deposit may arrive in parts from anyone, and only the total opens anchoring', async () => {
    const ctx = await fixture({ seeded: false });
    await ctx.escrow.send('seed', [SEED_MINIMUM / 2n], { from: ACCOUNTS.bob });
    await assert.rejects(
      ctx.escrow.send('anchor', [QRL_OWNER, 10n * ONE], { from: ACCOUNTS.alice }),
      /SeedingAbsent/,
    );
    await ctx.escrow.send('seed', [SEED_MINIMUM / 2n], { from: ACCOUNTS.mallory });
    assert.equal(await ctx.escrow.call('seededUnits'), SEED_MINIMUM);
    await ctx.anchorFor(ACCOUNTS.alice, 10n * ONE);
  });

  test('the seeding deposit is buffer, belonging to no position', async () => {
    const ctx = await fixture();
    assert.equal(await ctx.escrow.call('bufferShares'), SEED_MINIMUM);
    const { id, notional } = await ctx.anchorFor(ACCOUNTS.alice, 10n * ONE);
    assert.ok((await ctx.escrow.call('claimOf', [id])) <= notional);
  });

  test('an escrow that asks for no seeding deposit cannot be deployed', async () => {
    const chain = await originChain();
    const { relay } = await relayFixture(chain);
    const asset = await chain.deploy('MockAsset');
    await assert.rejects(
      chain.deploy(
        'ArkStakeEscrowUnits',
        ['address', 'address', 'address', 'uint256', 'uint256', 'uint256'],
        [asset.address, relay.address, OPS_DEST, 0n, 20, AUDIT_RATE],
      ),
      /deploy ArkStakeEscrowUnits failed/,
    );
  });

  test('an escrow with no audit reference yield cannot be deployed (EC-08: the gate would read a rate of zero)', async () => {
    const chain = await originChain();
    const { relay } = await relayFixture(chain);
    const asset = await chain.deploy('MockAsset');
    await assert.rejects(
      chain.deploy(
        'ArkStakeEscrowUnits',
        ['address', 'address', 'address', 'uint256', 'uint256', 'uint256'],
        [asset.address, relay.address, OPS_DEST, SEED_MINIMUM, 20, 0n],
      ),
      /deploy ArkStakeEscrowUnits failed/,
    );
  });

  test('the seed returns to the operations destination, last-out, only with no position anchored and no claim outstanding (PV-17)', async (t) => {
    const ctx = await fixture();
    // Anchored: the seed is first loss behind the position and stays.
    const { id } = await ctx.anchorFor(ACCOUNTS.alice, 10n * ONE);
    await ctx.delist();
    await assert.rejects(ctx.escrow.send('withdrawSeed', await ctx.seedReturn(), { from: ACCOUNTS.mallory }), /SeedLocked/);
    void id;
    const bare = await fixture();
    await bare.delist();
    // A loss the buffer paid first: what remains of the seed is the buffer (last-out).
    const quantity = SEED_MINIMUM / 4n;
    const loss = ids.lossLeaf({ chainId: CHAIN_ID, escrow: bare.escrow.address, determinationId: DETERMINATION, stakeAssetId: keccak256(toUtf8Bytes('gone')), destination: LOSS_DEST, quantity });
    const s = await bare.seal(loss);
    await bare.escrow.send('settleLoss', [DETERMINATION, keccak256(toUtf8Bytes('gone')), LOSS_DEST, quantity, s.epoch, s.proof(loss)]);
    assert.equal(await bare.escrow.call('lossOwedUnits'), 0n);
    const before = await bare.balance(OPS_DEST);
    const res = await bare.escrow.send('withdrawSeed', await bare.seedReturn(), { from: ACCOUNTS.mallory });
    const [ev] = bare.escrow.events(res, 'SeedWithdrawn');
    assert.equal(ev.args.units, SEED_MINIMUM - quantity, 'min(seed, buffer)');
    assert.equal((await bare.balance(OPS_DEST)) - before, SEED_MINIMUM - quantity, 'to the address fixed at construction, whoever calls');
    assert.equal(await bare.escrow.call('bufferShares'), 0n);
    assert.equal(await owed(bare.escrow), await bare.escrow.call('sharesHeld'));
    // The seed recorded goes to zero with it (ORIGIN-03): what was not returned was spent.
    assert.equal(await bare.escrow.call('seededUnits'), 0n);
    await assert.rejects(bare.escrow.send('withdrawSeed', await bare.seedReturn()), /ZeroValue/);
    // An outstanding claim on the buffer holds the seed (adversarial: the
    // treasury cannot take back first-loss capital a claimant is owed).
    const owing = await fixture();
    await owing.delist();
    const big = ids.lossLeaf({ chainId: CHAIN_ID, escrow: owing.escrow.address, determinationId: DETERMINATION, stakeAssetId: keccak256(toUtf8Bytes('x')), destination: LOSS_DEST, quantity: SEED_MINIMUM + ONE });
    const s2 = await owing.seal(big);
    await owing.escrow.send('settleLoss', [DETERMINATION, keccak256(toUtf8Bytes('x')), LOSS_DEST, SEED_MINIMUM + ONE, s2.epoch, s2.proof(big)]);
    assert.ok((await owing.escrow.call('lossOwedUnits')) > 0n);
    await assert.rejects(owing.escrow.send('withdrawSeed', await owing.seedReturn()), /SeedLocked/);
    const M = await loadModel();
    if (!M) return t.diagnostic(MISSING);
    assert.equal(M.ark.seedingWithdrawableUnits(SEED_MINIMUM, SEED_MINIMUM - quantity, { anchoredPositions: 0, outstandingClaims: 0n, openDeterminations: 0, declared: false }), SEED_MINIMUM - quantity);
    assert.equal(M.ark.seedingWithdrawableUnits(SEED_MINIMUM, SEED_MINIMUM, { anchoredPositions: 1, outstandingClaims: 0n, openDeterminations: 0, declared: false }), 0n);
    // The re-audit's three conditions (ORIGIN-01, BOND-03): requested, anchoring closed, no determined buffer unsettled.
    const clear = { anchoredPositions: 0, outstandingClaims: 0n, openDeterminations: 0, declared: false };
    assert.equal(M.ark.seedingWithdrawableUnits(SEED_MINIMUM, SEED_MINIMUM, { ...clear, requested: true, anchoringClosed: true, unsettledDeterminedBuffer: 0n }), SEED_MINIMUM);
    assert.equal(M.ark.seedingWithdrawableUnits(SEED_MINIMUM, SEED_MINIMUM, { ...clear, requested: false }), 0n);
    assert.equal(M.ark.seedingWithdrawableUnits(SEED_MINIMUM, SEED_MINIMUM, { ...clear, anchoringClosed: false }), 0n);
    assert.equal(M.ark.seedingWithdrawableUnits(SEED_MINIMUM, SEED_MINIMUM, { ...clear, unsettledDeterminedBuffer: 1n }), 0n);
  });

  test('ORIGIN-01 (re-audit 2026-09-30, the PoC now refused): a stranger can no longer return the seed of an escrow that takes deposits, nor present one leaf twice', async () => {
    const ctx = await fixture();
    // The PoC: a seed-return leaf of the epoch, presented before the first anchor.
    await assert.rejects(ctx.escrow.send('withdrawSeed', await ctx.seedReturn(), { from: ACCOUNTS.mallory }), /AnchoringOpen/);
    await ctx.anchorFor(ACCOUNTS.alice, 10n * ONE);
    // Only a de-listed escrow returns its seed, once per leaf (ORIGIN-01b).
    const bare = await fixture();
    await bare.delist();
    const args = await bare.seedReturn();
    await bare.escrow.send('withdrawSeed', args, { from: ACCOUNTS.mallory });
    await bare.escrow.send('seed', [SEED_MINIMUM], { from: ACCOUNTS.admin });
    await assert.rejects(bare.escrow.send('withdrawSeed', args, { from: ACCOUNTS.mallory }), /SeedReturnSpent/);
    assert.equal(await bare.relay.call('seedReturnSpent', [ids.seedReturnLeaf(CHAIN_ID, bare.escrow.address, args[0])]), true);
  });

  test('ORIGIN-03 (the PoC now refused): after a loss, the seed return leaves no seeded figure behind an empty buffer', async () => {
    const ctx = await fixture({ seeded: false });
    await ctx.escrow.send('seed', [4n * SEED_MINIMUM], { from: ACCOUNTS.admin });
    const stake = keccak256(toUtf8Bytes('gone'));
    const loss = ids.lossLeaf({ chainId: CHAIN_ID, escrow: ctx.escrow.address, determinationId: DETERMINATION, stakeAssetId: stake, destination: LOSS_DEST, quantity: SEED_MINIMUM });
    const s = await ctx.seal(loss);
    await ctx.escrow.send('settleLoss', [DETERMINATION, stake, LOSS_DEST, SEED_MINIMUM, s.epoch, s.proof(loss)]);
    await ctx.delist();
    await ctx.escrow.send('withdrawSeed', await ctx.seedReturn(), { from: ACCOUNTS.mallory });
    assert.equal(await ctx.escrow.call('bufferShares'), 0n);
    assert.equal(await ctx.escrow.call('seededUnits'), 0n, 'not the minimum the PoC read');
  });

  test('ORIGIN-05 (the PoC now refused): no prime after the declaration', async () => {
    const ctx = await fixture();
    await ctx.anchorFor(ACCOUNTS.alice, 10n * ONE);
    await ctx.declare(ctx.escrow.address);
    await assert.rejects(ctx.escrow.send('primePsr', [5n * ONE], { from: ACCOUNTS.admin }), /SettlementClosed/);
  });

  test('ORIGIN-04 (the PoC now refused): a dust book and a dust donation read at most four times the audit rate; a reserve of twenty audit-rate needs admits', async (t) => {
    const ctx = await fixture();
    const STAGE1 = { sigma: 1850, levy: 200, target: 1850, covered: 10000, psrCap: 11100, term: 13 };
    await ctx.setAllocation(STAGE1);
    await ctx.anchorFor(ACCOUNTS.mallory, 1n);
    await ctx.asset.send('mint', [ctx.escrow.address, ONE / 1000n]);
    await ctx.escrow.send('sweep', []);
    const book = await ctx.escrow.call('positionShares');
    await ctx.setAllocation(STAGE1);
    await ctx.anchorFor(ACCOUNTS.alice, 500n * ONE);
    await ctx.escrow.send('primePsr', [ONE], { from: ACCOUNTS.admin });
    // Refused by the PoC's build (PsrShort for thirteen epochs); admitted now.
    await ctx.escrow.send('anchorCommitted', [QRL_OWNER, 100n * ONE], { from: ACCOUNTS.bob });
    const M = await loadModel();
    if (!M) return t.diagnostic(MISSING);
    const clamp = M.ark.PSR_RATE_CLAMP_MULTIPLE * AUDIT_RATE;
    assert.equal(M.ark.psrEpochRate(ONE / 1000n, book, AUDIT_RATE), clamp, 'the model clamps the spike at four audit rates');
  });

  test('adversarial: with no stake left but a determination open on QRL, no seed-return leaf is sealed and the seed stays (PV-17)', async () => {
    // A release takes the stake out at its first presentation, so the escrow's
    // own state reads empty while the release unbonds under a determination
    // open on QRL. QRL then seals no seed-return leaf (the bond's
    // `seedReturnSealable`); every other leaf proves nothing here.
    const ctx = await fixture();
    await ctx.delist();
    const before = await ctx.escrow.call('bufferShares');
    // A root of the epoch in progress that carries no seed-return leaf.
    const other = keccak256(toUtf8Bytes('some other return fact'));
    const s = await ctx.seal(other);
    await assert.rejects(ctx.escrow.send('withdrawSeed', [s.epoch, s.proof(other)]), /BadProof/);
    // Another escrow's seed return proves nothing for this one (D10).
    const foreign = ids.seedReturnLeaf(CHAIN_ID, '0x' + '99'.repeat(20), await ctx.freshEpoch());
    const s2 = await ctx.seal(foreign);
    await assert.rejects(ctx.escrow.send('withdrawSeed', [s2.epoch, s2.proof(foreign)]), /BadProof/);
    // An epoch with no root at all.
    await assert.rejects(ctx.escrow.send('withdrawSeed', [ctx.epoch() + 1n, []]), /SeedReturnStale|NoRootForEpoch/);
    assert.equal(await ctx.escrow.call('bufferShares'), before, 'the seed stays in the buffer');
  });

  test('a seed-return leaf serves the epoch it was sealed for and the next, never later, and never after the declaration (PV-17)', async () => {
    const ctx = await fixture();
    await ctx.delist();
    const args = await ctx.seedReturn();
    // Two epochs on, the leaf says nothing about a determination opened since.
    ctx.chain.advanceTime(2 * EPOCH);
    await assert.rejects(ctx.escrow.send('withdrawSeed', args), /SeedReturnStale/);
    // One epoch on, still good.
    const fresh = await ctx.seedReturn();
    ctx.chain.advanceTime(EPOCH);
    const res = await ctx.escrow.send('withdrawSeed', fresh, { from: ACCOUNTS.mallory });
    assert.equal(ctx.escrow.events(res, 'SeedWithdrawn')[0].args.units, SEED_MINIMUM);
    // After the declaration the buffer belongs to the recovered pool.
    const closed = await fixture();
    await closed.delist();
    const leafArgs = await closed.seedReturn();
    await closed.declare();
    await assert.rejects(closed.escrow.send('withdrawSeed', leafArgs), /ReleaseClosed/);
  });
});

describe('anchoring, and the entitlement it fixes', () => {
  test('a deposit naming no beneficiary is refused, not defaulted to the depositor', async () => {
    // whitepaper §3.2. Deriving one from msg.sender would make the entitlement a
    // function of an elliptic-curve key, which is the failure being removed.
    const ctx = await fixture();
    await assert.rejects(
      ctx.escrow.send('anchor', [ZERO_ADDR, 10n * ONE], { from: ACCOUNTS.alice }),
      /NoBeneficiary/,
    );
  });

  test('the identifier the escrow computes commits to the beneficiary', async () => {
    const ctx = await fixture();
    const { id } = await ctx.anchorFor(ACCOUNTS.alice, 10n * ONE);
    assert.equal(
      id,
      ids.stakeAssetId({
        chainId: CHAIN_ID,
        asset: ctx.asset.address,
        depositor: ACCOUNTS.alice,
        boundQrlOwner: QRL_OWNER_Q,
        depositNonce: 0n,
      }),
      'the identifier depends on how the beneficiary was written down',
    );
  });

  test('a different beneficiary is a different position, not a rewritten one', async () => {
    const ctx = await fixture();
    const a = await ctx.anchorFor(ACCOUNTS.alice, 10n * ONE, QRL_OWNER);
    const b = await ctx.anchorFor(ACCOUNTS.alice, 10n * ONE, '0x' + '77'.repeat(20));
    assert.notEqual(a.id, b.id);
  });

  test('the anchoring event carries every field the attester needs', async () => {
    const ctx = await fixture();
    const { res } = await ctx.anchorFor(ACCOUNTS.alice, 10n * ONE);
    const [ev] = ctx.escrow.events(res, 'Anchored');
    assert.equal(ev.args.chainId, CHAIN_ID);
    assert.equal(ev.args.asset.toLowerCase(), ctx.asset.address.toLowerCase());
    assert.equal(ev.args.depositor.toLowerCase(), ACCOUNTS.alice);
    // The owner is emitted as its two canonical words, the exact form the
    // preimage takes, so the attester applies no conversion.
    assert.equal(ev.args.qrlOwnerHi, QRL_OWNER_HI);
    assert.equal(ev.args.qrlOwnerLo, QRL_OWNER_LO);
    assert.equal(ev.args.depositNonce, 0n);
    assert.equal(ev.args.epoch, ctx.epoch());
    assert.equal(
      ev.args.stakeAssetId,
      ids.stakeAssetId({
        chainId: ev.args.chainId,
        asset: ev.args.asset,
        depositor: ev.args.depositor,
        boundQrlOwner: QRL_OWNER_Q,
        depositNonce: ev.args.depositNonce,
      }),
    );
  });

  test('a QIP-55 owner — 64 bytes — anchors at an escrow serving that line, splits into its two halves, and is a distinct position', async () => {
    const ctx = await fixture({ ownerLength: 64 });
    assert.equal(await ctx.escrow.call('QRL_OWNER_LENGTH'), 64n);
    const other = await ctx.anchorFor(ACCOUNTS.alice, 10n * ONE, '0x' + 'ab'.repeat(32) + 'ce'.repeat(32));
    const { id, res } = await ctx.anchorFor(ACCOUNTS.alice, 10n * ONE, QRL_OWNER_V3);
    const [ev] = ctx.escrow.events(res, 'Anchored');
    assert.equal(ev.args.qrlOwnerHi, '0x' + 'ab'.repeat(32));
    assert.equal(ev.args.qrlOwnerLo, '0x' + 'cd'.repeat(32));
    assert.equal(
      id,
      ids.stakeAssetId({
        chainId: CHAIN_ID,
        asset: ctx.asset.address,
        depositor: ACCOUNTS.alice,
        boundQrlOwner: QRL_OWNER_V3_Q,
        depositNonce: ev.args.depositNonce,
      }),
    );
    assert.notEqual(id, other.id);
  });

  test('an owner of any other length is refused before the transfer', async () => {
    const ctx = await fixture();
    for (const owner of ['0x' + '66'.repeat(19), '0x' + '66'.repeat(32), '0x' + '66'.repeat(65), '0x']) {
      await assert.rejects(
        ctx.escrow.send('anchor', [owner, 10n * ONE], { from: ACCOUNTS.alice }),
        /BadOwnerLength/,
      );
    }
  });

  test('D14: an escrow serves one QRL line — the legacy 20-byte form is refused on a QIP-55 escrow, and the reverse', async () => {
    // whitepaper §3.2: no account of the line an escrow serves could sign for
    // an owner of the other width, so the position would be one way.
    const v3 = await fixture({ ownerLength: 64 });
    for (const committed of [false, true]) {
      await assert.rejects(
        v3.escrow.send(committed ? 'anchorCommitted' : 'anchor', [QRL_OWNER, 10n * ONE], { from: ACCOUNTS.alice }),
        /BadOwnerLength/,
      );
    }
    const legacy = await fixture({ ownerLength: 20 });
    await assert.rejects(legacy.escrow.send('anchor', [QRL_OWNER_V3, 10n * ONE], { from: ACCOUNTS.alice }), /BadOwnerLength/);
    assert.equal(await legacy.asset.call('balanceOf', [legacy.escrow.address]), SEED_MINIMUM, 'refused before the transfer');
  });

  test('D14: an escrow committing to any other owner length cannot be deployed', async () => {
    const chain = await originChain();
    const { relay } = await relayFixture(chain);
    const asset = await chain.deploy('MockAsset');
    for (const len of [0, 19, 32, 65]) {
      await assert.rejects(
        chain.deploy('ArkStakeEscrowUnits', ['address', 'address', 'address', 'uint256', 'uint256', 'uint256'], [asset.address, relay.address, OPS_DEST, SEED_MINIMUM, len, AUDIT_RATE]),
        /deploy ArkStakeEscrowUnits failed/,
      );
    }
  });

  test('a zero deposit is refused', async () => {
    const ctx = await fixture();
    await assert.rejects(
      ctx.escrow.send('anchor', [QRL_OWNER, 0n], { from: ACCOUNTS.alice }),
      /ZeroValue/,
    );
  });

  test('a repeated deposit by one depositor is a different position', async () => {
    const ctx = await fixture();
    const a = await ctx.anchorFor(ACCOUNTS.alice, 10n * ONE);
    const b = await ctx.anchorFor(ACCOUNTS.alice, 10n * ONE);
    assert.equal(a.nonce, 0n);
    assert.equal(b.nonce, 1n);
    assert.notEqual(a.id, b.id);
  });

  test('a deposit after the declaration is refused rather than trapped', async () => {
    const ctx = await fixture();
    await ctx.declare();
    await assert.rejects(
      ctx.escrow.send('anchor', [QRL_OWNER, 10n * ONE], { from: ACCOUNTS.alice }),
      /ReleaseClosed/,
    );
  });

  test('anchoring closes at the migration horizon, while a fifth of the leaves remain', async () => {
    // whitepaper §3.6: exhaustion is terminal, so a position must be able to
    // leave while leaves remain. Height four: sixteen leaves, horizon twelve.
    const ctx = await fixture({ treeHeight: 4 });
    for (let i = 0; i < 11; i += 1) await ctx.seal(keccak256(toUtf8Bytes(`filler-${i}`)));
    await ctx.anchorFor(ACCOUNTS.alice, 10n * ONE);

    await ctx.seal(keccak256(toUtf8Bytes('filler-11')));
    assert.equal(await ctx.relay.call('nextLeaf'), 12n);
    await assert.rejects(
      ctx.escrow.send('anchor', [QRL_OWNER, 10n * ONE], { from: ACCOUNTS.alice }),
      /MigrationHorizonReached/,
    );
  });

  test('a donation before the first anchor costs the next depositor under one per cent of its claim', async () => {
    // The inflation attack: one wei-share anchored, a donation swept into the
    // pool, and the next real anchor's stake truncated. With offsets of one
    // and one the donation below — the staker residual of 106 is 100.7, just
    // over the victim's 100 — priced the victim at a stake of 1 against the
    // attacker's 1 and took a third of its deposit; a larger donation made the
    // anchor revert DustAnchor, which is a denial of anchoring for the price
    // of the donation. The virtual stake offset makes both cost the attacker
    // about as much as the victim.
    for (const donation of [106n * ONE, 100n * ONE, 1_000n * ONE]) {
      const ctx = await fixture();
      await ctx.asset.send('mint', [ACCOUNTS.mallory, donation]);
      await ctx.anchorFor(ACCOUNTS.mallory, 1n);
      await ctx.asset.send('transfer', [ctx.escrow.address, donation], { from: ACCOUNTS.mallory });
      await ctx.escrow.send('sweep', [], { from: ACCOUNTS.mallory });

      const { id, notional } = await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
      const claim = await ctx.escrow.call('claimOf', [id]);
      assert.ok(claim * 100n >= notional * 99n, `a donation of ${donation / ONE} took ${notional - claim} of a claim of ${notional}`);
      assert.ok(claim <= notional, 'the victim was credited with the donation');
    }
  });

  test('shares no position owns go to the buffer before the next anchor, not to the next depositor', async () => {
    // A sweep with no positions leaves the staker residual in positionShares
    // with no stake to claim it. Folded into the next anchor's price it
    // misprices that anchor; the buffer, which belongs to no position either,
    // is where it belongs.
    const ctx = await fixture();
    await ctx.asset.send('mint', [ctx.escrow.address, 50n * ONE]);
    await ctx.escrow.send('sweep', []);
    const orphaned = await ctx.escrow.call('positionShares');
    assert.ok(orphaned > 0n && (await ctx.escrow.call('totalStake')) === 0n);
    const buffer = await ctx.escrow.call('bufferShares');

    const { id, notional } = await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    assert.equal(await ctx.escrow.call('bufferShares'), buffer + orphaned);
    assert.equal(await ctx.escrow.call('positionShares'), notional);
    assert.ok(notional - (await ctx.escrow.call('claimOf', [id])) <= 1n, 'the anchor was mispriced by the orphaned shares');
  });

  test('the escrow holds exactly what the positions, buffer, pot and queue are owed', async () => {
    const ctx = await fixture();
    await ctx.setAllocation({ sigma: 3000, juror: 2000 });
    await ctx.anchorFor(ACCOUNTS.alice, 10n * ONE);
    await ctx.anchorFor(ACCOUNTS.bob, 30n * ONE);
    await ctx.asset.send('mint', [ctx.escrow.address, 7n * ONE]);
    await ctx.escrow.send('sweep', []);
    assert.equal(await ctx.escrow.call('sharesHeld'), await owed(ctx.escrow));
  });
});

describe('de-listing, reaching this chain', () => {
  test('a de-listing leaf closes the escrow to new anchoring, carried by anyone', async () => {
    // whitepaper §3.2. Without it a deposit made after QRL de-listed the asset
    // would have no record there and could never be released.
    const ctx = await fixture();
    const leaf = ids.delistLeaf(CHAIN_ID, ctx.escrow.address, ctx.asset.address);
    const s = await ctx.seal(leaf);
    await ctx.escrow.send('closeAnchoring', [s.epoch, s.proof(leaf)], { from: ACCOUNTS.mallory });
    assert.equal(await ctx.escrow.call('anchoringClosed'), true);
    await assert.rejects(
      ctx.escrow.send('anchor', [QRL_OWNER, 10n * ONE], { from: ACCOUNTS.alice }),
      /AnchoringIsClosed/,
    );
  });

  test('de-listing releases and does not confiscate: an existing position still leaves', async () => {
    const ctx = await fixture();
    await ctx.anchorFor(ACCOUNTS.bob, 1_000n * ONE);
    const { id } = await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    const delist = ids.delistLeaf(CHAIN_ID, ctx.escrow.address, ctx.asset.address);
    const rel = ctx.releaseLeaf(id, ACCOUNTS.alice);
    const s = await ctx.seal([delist, rel]);
    await ctx.escrow.send('closeAnchoring', [s.epoch, s.proof(delist)]);

    ctx.chain.advanceTime(4 * EPOCH);
    const before = await ctx.balance(ACCOUNTS.alice);
    await ctx.release(id, ACCOUNTS.alice, s, rel);
    assert.equal((await ctx.balance(ACCOUNTS.alice)) - before, 100n * ONE);
  });

  test('a de-listing of another asset does not close this escrow', async () => {
    const ctx = await fixture();
    const other = ids.delistLeaf(CHAIN_ID, ctx.escrow.address, '0x' + 'aa'.repeat(20));
    const s = await ctx.seal(other);
    await assert.rejects(
      ctx.escrow.send('closeAnchoring', [s.epoch, s.proof(other)]),
      /BadProof/,
    );
    assert.equal(await ctx.escrow.call('anchoringClosed'), false);
  });
});

describe('principal and yield, on a rebasing asset', () => {
  test('a rebase is principal, not yield, and the sweep does not pay it away', async () => {
    // The staker share of a rebase stays in the escrow and accrues to the
    // position; only the operations share leaves.
    const ctx = await fixture({ rebasing: true });
    await ctx.setAllocation({ sigma: 3000 });
    const { id, notional } = await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);

    await ctx.asset.send('rebase', [30n * ONE]);
    const res = await ctx.escrow.send('sweep', [], { from: ACCOUNTS.mallory });
    const [ev] = ctx.escrow.events(res, 'Swept');

    const claim = await ctx.escrow.call('claimOf', [id]);
    assert.ok(claim > notional, 'the position did not grow with the rebase');
    assert.equal(ev.args.stakerUnits, (ev.args.grossUnits * 6500n) / BPS);
    assert.ok(claim - notional >= ev.args.stakerUnits - 2n, 'the staker share did not reach the position');
  });

  test('a rebase yields a premium, so recording shares does not make it uncollectable', async () => {
    // The escrow's share balance never moves on a rebase, so a one-term sweep
    // would find no yield at all and the premium could never be collected.
    const ctx = await fixture({ rebasing: true });
    await ctx.setAllocation({ sigma: 3000 });
    await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);

    await ctx.asset.send('rebase', [10n * ONE]);
    const res = await ctx.escrow.send('sweep', [], { from: ACCOUNTS.mallory });
    const [held] = ctx.escrow.events(res, 'PremiumHeld');
    assert.ok(held.args.premiumUnits > 0n, 'no premium was collected from a rebase');
    assert.ok((await ctx.escrow.call('auctionShares')) > 0n);
  });

  test('a negative rebase creates no yield, and the recovery is not charged twice', async () => {
    const ctx = await fixture({ rebasing: true });
    await ctx.setAllocation({ sigma: 3000 });
    await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);

    await ctx.asset.send('rebase', [10n * ONE]);
    await ctx.escrow.send('sweep', [], { from: ACCOUNTS.mallory });
    const afterGain = await ctx.escrow.call('auctionShares');

    await ctx.asset.send('rebase', [-8n * ONE]);
    await assert.rejects(ctx.escrow.send('sweep', [], { from: ACCOUNTS.mallory }), /NothingToSweep/);

    await ctx.asset.send('rebase', [8n * ONE]);
    await assert.rejects(ctx.escrow.send('sweep', [], { from: ACCOUNTS.mallory }), /NothingToSweep/);
    assert.equal(await ctx.escrow.call('auctionShares'), afterGain);
  });

  test('a rebase does not widen the per-epoch release bound', async () => {
    // The bound is taken in shares for exactly this reason.
    const ctx = await fixture({ rebasing: true });
    await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    const before = await ctx.escrow.call('releaseBudgetRemaining');
    await ctx.asset.send('rebase', [50n * ONE]);
    assert.equal(await ctx.escrow.call('releaseBudgetRemaining'), before);
  });
});

describe('the sweep, and the four shares of section 4.2', () => {
  test('anyone may sweep, and the caller receives nothing', async () => {
    // Invariant I3.
    const ctx = await fixture();
    await ctx.setAllocation({ sigma: 3000 });
    await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    await ctx.asset.send('mint', [ctx.escrow.address, 10n * ONE]);

    const before = await ctx.balance(ACCOUNTS.mallory);
    await ctx.escrow.send('sweep', [], { from: ACCOUNTS.mallory });
    assert.equal(await ctx.balance(ACCOUNTS.mallory), before);
    assert.ok((await ctx.balance(OPS_DEST)) > 0n);
  });

  test('the premium share is held in the escrow for the auction, not paid anywhere', async () => {
    // whitepaper §4.7, yellow paper §1.4 sweep(): held until settled.
    const ctx = await fixture();
    await ctx.setAllocation({ sigma: 3000, buffer: 250, ops: 250 });
    await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    await ctx.asset.send('mint', [ctx.escrow.address, 100n * ONE]);
    const res = await ctx.escrow.send('sweep', [], { from: ACCOUNTS.mallory });

    assert.equal(await ctx.escrow.call('auctionShares'), (100n * ONE * 3000n) / BPS);
    assert.equal(await ctx.balance(OPS_DEST), (100n * ONE * 250n) / BPS);
    const [held] = ctx.escrow.events(res, 'PremiumHeld');
    assert.equal(held.args.premiumUnits, (100n * ONE * 3000n) / BPS);
    assert.equal(held.args.epoch, ctx.epoch());
  });

  test('the juror-fee fraction of the operations share is held with the premium', async () => {
    // whitepaper §4.2: 2,000 bps of the operations share is sold for the juror
    // fee pool. It is a fraction of that share, not a fifth stream.
    const ctx = await fixture();
    await ctx.setAllocation({ sigma: 3000, buffer: 250, ops: 250, juror: 2000 });
    await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    await ctx.asset.send('mint', [ctx.escrow.address, 100n * ONE]);
    const res = await ctx.escrow.send('sweep', []);

    const ops = (100n * ONE * 250n) / BPS;
    const juror = (ops * 2000n) / BPS;
    assert.equal(await ctx.balance(OPS_DEST), ops - juror);
    assert.equal(await ctx.escrow.call('auctionShares'), (100n * ONE * 3000n) / BPS + juror);
    const [ev] = ctx.escrow.events(res, 'Swept');
    assert.equal(ev.args.operationsUnits, ops, 'Swept reports the whole operations share');
    assert.equal(ctx.escrow.events(res, 'PremiumHeld')[0].args.jurorFeeUnits, juror);
  });

  test('the four shares sum to the gross exactly, with no unit unowned', async () => {
    // §4.2's identity. The staker share is the residual by subtraction.
    const ctx = await fixture();
    await ctx.setAllocation({ sigma: 3000, buffer: 250, ops: 250, juror: 2000 });
    await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    const gross = 333_333_333_333_333_333n; // deliberately not divisible by BPS
    await ctx.asset.send('mint', [ctx.escrow.address, gross]);

    const res = await ctx.escrow.send('sweep', [], { from: ACCOUNTS.mallory });
    const [ev] = ctx.escrow.events(res, 'Swept');
    assert.equal(ev.args.grossUnits, gross);
    assert.equal(
      ev.args.premiumUnits + ev.args.operationsUnits + ev.args.bufferUnits + ev.args.stakerUnits,
      gross,
    );
    assert.equal(await ctx.escrow.call('sharesHeld'), await owed(ctx.escrow));
  });

  test('the residual of every division stays with the staker', async () => {
    const ctx = await fixture();
    await ctx.setAllocation({ sigma: 3000, buffer: 250, ops: 250 });
    await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    const gross = 9_999n;
    await ctx.asset.send('mint', [ctx.escrow.address, gross]);

    const res = await ctx.escrow.send('sweep', [], { from: ACCOUNTS.mallory });
    const [ev] = ctx.escrow.events(res, 'Swept');
    assert.ok(ev.args.stakerUnits >= (gross * 6500n) / BPS, 'the staker lost the residual');
  });

  test('an unrecorded allocation charges nothing rather than charging the maximum', async () => {
    // The failure mode is then a coupon shortfall, which §4.7 specifies a
    // response to, rather than an over-charge, which nothing does.
    const ctx = await fixture();
    await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    await ctx.asset.send('mint', [ctx.escrow.address, 100n * ONE]);
    await ctx.escrow.send('sweep', [], { from: ACCOUNTS.mallory });
    assert.equal(await ctx.escrow.call('auctionShares'), 0n);
  });

  test('a sweep with nothing accrued says so rather than emitting an empty split', async () => {
    const ctx = await fixture();
    await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    await assert.rejects(ctx.escrow.send('sweep', [], { from: ACCOUNTS.mallory }), /NothingToSweep/);
  });

  test('the buffer stays in the escrow and belongs to no position', async () => {
    const ctx = await fixture();
    await ctx.setAllocation({ sigma: 3000, buffer: 250, ops: 250 });
    const { id } = await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    await ctx.asset.send('mint', [ctx.escrow.address, 100n * ONE]);
    await ctx.escrow.send('sweep', [], { from: ACCOUNTS.mallory });

    const buffer = await ctx.escrow.call('bufferShares');
    assert.equal(buffer, SEED_MINIMUM + (100n * ONE * 250n) / BPS);
    assert.ok((await ctx.escrow.call('claimOf', [id])) <= (await ctx.escrow.call('sharesHeld')) - buffer);
  });

  // Audit 2026-09-27 D20, whitepaper §4.2 as revised on 2026-09-28: from the
  // closure the operations share, its juror fraction included, is buffer
  // inflow — the destination is an origin-chain account whose key the
  // adversary may hold after the declaration. `sweepOperations` of the model.
  test('D20: after the declaration nothing more is held for the auction, and the operations share accrues to the buffer', async (t) => {
    const ctx = await fixture();
    await ctx.setAllocation({ sigma: 3000, buffer: 250, ops: 250, juror: 2000, levy: 200 });
    await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    await ctx.declare();

    const bufferBefore = await ctx.escrow.call('bufferShares');
    await ctx.asset.send('mint', [ctx.escrow.address, 100n * ONE]);
    const res = await ctx.escrow.send('sweep', [], { from: ACCOUNTS.mallory });
    const [ev] = ctx.escrow.events(res, 'Swept');
    assert.equal(ev.args.premiumUnits, 0n);
    assert.equal(ctx.escrow.events(res, 'PremiumHeld').length, 0);
    assert.equal(await ctx.balance(OPS_DEST), 0n, 'nothing reaches the operations destination after closure');
    assert.equal(await ctx.escrow.call('auctionShares'), 0n);
    assert.equal(await ctx.escrow.call('psrShares'), 0n, 'no levy after closure: the premium it smooths has ended');
    const gross = 100n * ONE;
    assert.equal((await ctx.escrow.call('bufferShares')) - bufferBefore, (gross * 250n) / BPS + (gross * 250n) / BPS);
    const M = await loadModel();
    if (!M) return t.diagnostic(MISSING);
    const split = M.ark.sweepOperations(250, 2000, true);
    assert.deepEqual([split.destinationBps, split.offeredBps, split.bufferBps], [0, 0, 250]);
  });

  test('D20: before the declaration the operations share splits as the model states', async (t) => {
    const ctx = await fixture();
    await ctx.setAllocation({ sigma: 3000, buffer: 250, ops: 250, juror: 2000 });
    await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    await ctx.asset.send('mint', [ctx.escrow.address, 100n * ONE]);
    await ctx.escrow.send('sweep', []);
    const gross = 100n * ONE;
    const M = await loadModel();
    if (!M) return t.diagnostic(MISSING);
    const split = M.ark.sweepOperations(250, 2000, false);
    assert.equal(await ctx.balance(OPS_DEST), (gross * BigInt(split.destinationBps)) / BPS);
  });
});

/*
 * Gap item 19 (CLAUDE.md), whitepaper §4.2 and §4.4, I39: the stabilization
 * levy, the premium stabilization reserve and the term commitment. The model's
 * psrEpoch, psrTopUpUnits and committedPremiumDeliveredUnits are the arithmetic
 * of record.
 */
describe('the stabilization levy, the reserve and the term commitment (I39)', () => {
  /** A stage-1 book: the rung and the premium at 1,850 at complete cover, the levy in force. */
  const STAGE1 = { sigma: 1850, levy: 200, target: 1850, covered: 10000, psrCap: 11100, term: 13 };
  const STAGE2 = { ...STAGE1, sigma: 2500, target: 2500 };

  test('the levy is charged on every position and credited to the reserve, outside the staker residual', async () => {
    const ctx = await fixture();
    await ctx.setAllocation(STAGE1);
    await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    await ctx.asset.send('mint', [ctx.escrow.address, 100n * ONE]);
    const res = await ctx.escrow.send('sweep', []);
    const gross = 100n * ONE;
    const [ev] = ctx.escrow.events(res, 'Swept');
    assert.equal(ev.args.stakerUnits, gross - (gross * 1850n) / BPS - (gross * 250n) / BPS - (gross * 250n) / BPS - (gross * 200n) / BPS);
    assert.equal(await ctx.escrow.call('psrShares'), (gross * 200n) / BPS);
    const [rs] = ctx.escrow.events(res, 'ReserveSwept');
    assert.equal(rs.args.levyUnits, (gross * 200n) / BPS);
    assert.equal(rs.args.demandUnits, 0n, 'no commitment, no top-up');
    // The six pots still sum to the holding.
    assert.equal(await owed(ctx.escrow), await ctx.escrow.call('sharesHeld'));
  });

  test('I39: the cap is applied when the epoch ends, and what it does not admit accrues to the buffer', async (t) => {
    // A yield of the whole book in one epoch: an audit rate high enough that the
    // clamp of ORIGIN-04 (four times it) does not bind on the rate read here.
    const ctx = await fixture({ auditRate: ONE / 2n });
    // A cap of 100 bps of the epoch's gross against a levy of 200: half of it is over the cap.
    await ctx.setAllocation({ ...STAGE1, psrCap: 100 });
    await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    await ctx.asset.send('mint', [ctx.escrow.address, 100n * ONE]);
    await ctx.escrow.send('sweep', []);
    const gross = 100n * ONE;
    const levy = (gross * 200n) / BPS;
    assert.equal(await ctx.escrow.call('psrShares'), levy, 'the whole levy stands in the reserve until the epoch ends');
    const bufferBefore = await ctx.escrow.call('bufferShares');
    // The book the epoch's yield accrued on, as the close-out reads it.
    const book = await ctx.escrow.call('positionShares');
    await ctx.freshEpoch();
    await ctx.asset.send('mint', [ctx.escrow.address, 1n]);
    const res = await ctx.escrow.send('sweep', []);
    const cap = capAtRate(100, rateOf(gross, book), book);
    assert.ok(cap <= (gross * 100n) / BPS && (gross * 100n) / BPS - cap < 1000n, 'about 1% of the epoch\'s gross');
    const [ev] = ctx.escrow.events(res, 'ReserveCapped');
    assert.equal(ev.args.capShares, cap);
    assert.equal(ev.args.toBufferShares, levy - cap);
    assert.equal(await ctx.escrow.call('psrShares'), cap);
    assert.ok((await ctx.escrow.call('bufferShares')) - bufferBefore >= levy - cap);
    const M = await loadModel();
    if (!M) return t.diagnostic(MISSING);
    // psrCapAtRate at psrEpochRate, on a ladder whose gap times the epochs is the leaf's factor, 100 bps.
    const p = { ...M.params, psrCapEpochs: 1, threatStage1Bps: 1850, threatStage4Bps: 1950 };
    const rate = M.ark.psrTrailingRate(p, [M.ark.psrEpochRate(gross, book, ctx.auditRate)], ctx.auditRate);
    assert.equal(M.ark.psrCapAtRate(p, book, rate), cap);
  });

  /**
   * Two equal positions, one at spot and one committed at stage 1, with a
   * reserve built from earlier levy, and a treasury prime where `prime` is
   * set (the reserve gate of EC-08 admits the commitment only against one).
   */
  async function committedBook(ctx, reserveYield = 1000n * ONE, prime = 0n) {
    await ctx.setAllocation(STAGE1);
    // An earlier book's levy fills the reserve.
    const seedPos = await ctx.anchorFor(ACCOUNTS.bob, 100n * ONE);
    await ctx.asset.send('mint', [ctx.escrow.address, reserveYield]);
    await ctx.escrow.send('sweep', []);
    if (prime) await ctx.escrow.send('primePsr', [prime], { from: ACCOUNTS.admin });
    const spot = await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    const nonce = await ctx.escrow.call('nonceOf', [ACCOUNTS.mallory]);
    const res = await ctx.escrow.send('anchorCommitted', [QRL_OWNER, 100n * ONE], { from: ACCOUNTS.mallory });
    const [a] = ctx.escrow.events(res, 'Anchored');
    const [c] = ctx.escrow.events(res, 'Committed');
    return { seedPos, spot, committed: { id: a.args.stakeAssetId, nonce }, cohort: c.args };
  }

  test('a commitment locks the rung in force at anchoring for the term the allocation names', async () => {
    const ctx = await fixture();
    const { committed, cohort } = await committedBook(ctx);
    assert.equal(cohort.sigmaCommitBps, 1850n);
    assert.equal(cohort.untilEpoch, ctx.epoch() + 13n);
    const [key, c] = await ctx.escrow.call('cohortOf', [committed.id]);
    assert.equal(key, cohort.cohort);
    assert.equal(c.sigmaCommitBps, 1850n);
  });

  test('no commitment on an allocation of an earlier epoch, nor while a step of the stage is queued (QL-25, PV-20; adversarial)', async () => {
    const ctx = await fixture();
    await ctx.setAllocation(STAGE1);
    // The allocation of an epoch that has closed: a commitment would lock a
    // rung the next allocation may already have moved.
    ctx.chain.advanceTime(Number(EPOCH));
    await assert.rejects(
      ctx.escrow.send('anchorCommitted', [QRL_OWNER, 100n * ONE], { from: ACCOUNTS.alice }),
      /AllocationStale/,
    );
    // A step queued: the rung is about to move, and a commitment now would
    // take the option on it the positions at spot write.
    await ctx.setAllocation({ ...STAGE1, step: true });
    await assert.rejects(
      ctx.escrow.send('anchorCommitted', [QRL_OWNER, 100n * ONE], { from: ACCOUNTS.alice }),
      /StageStepQueued/,
    );
    assert.equal((await ctx.escrow.call('recordedAllocation')).stepQueued, true);
    // A position at spot is taken all the while.
    await ctx.anchorFor(ACCOUNTS.alice, 10n * ONE);
    // The step executed and no other queued: commitment opens again, against
    // a reserve the treasury primed (the gate of EC-08).
    await ctx.setAllocation(STAGE1);
    await ctx.escrow.send('primePsr', [ONE], { from: ACCOUNTS.admin });
    await ctx.escrow.send('anchorCommitted', [QRL_OWNER, 100n * ONE], { from: ACCOUNTS.alice });
  });

  /** psrCapBps of one epoch at `rate` on `book` shares, rounded up: the least reserve the gate admits. */
  const gateNeed = (capBps, rate, book) => (BigInt(capBps) * rate * book + BPS * ONE - 1n) / (BPS * ONE);
  /** The cap at the close-out, `psrCapAtRate`: the same figure, rounded up toward the reserve. */
  const capAtRate = gateNeed;
  /** One closed epoch's gross yield per share of its book, `psrEpochRate`, truncated. */
  const rateOf = (gross, book) => (gross * ONE) / book;

  test('EC-08 adversarial: an empty reserve admits no commitment, and one share short of the gate refuses (PsrShort)', async (t) => {
    const ctx = await fixture();
    await ctx.setAllocation(STAGE1);
    await assert.rejects(
      ctx.escrow.send('anchorCommitted', [QRL_OWNER, 100n * ONE], { from: ACCOUNTS.alice }),
      /PsrShort/,
      'the reserve holds nothing',
    );
    // The first position of a fresh book is recorded at exactly its shares,
    // so the gate reads the committed book as the deposit itself, at the
    // audit's reference yield before any epoch has closed.
    const need = gateNeed(STAGE1.psrCap, AUDIT_RATE, 100n * ONE);
    await ctx.escrow.send('primePsr', [need - 1n], { from: ACCOUNTS.admin });
    await assert.rejects(ctx.escrow.send('anchorCommitted', [QRL_OWNER, 100n * ONE], { from: ACCOUNTS.alice }), /PsrShort/);
    await ctx.escrow.send('primePsr', [1n], { from: ACCOUNTS.admin });
    await ctx.escrow.send('anchorCommitted', [QRL_OWNER, 100n * ONE], { from: ACCOUNTS.alice });
    // A position at spot never asks the reserve.
    await ctx.anchorFor(ACCOUNTS.bob, 100n * ONE);
    const M = await loadModel();
    if (!M) return t.diagnostic(MISSING);
    // psrCommitmentAdmissible at the reference parameters (psrCapEpochs * gap = 11,100).
    const y = (100n * ONE * AUDIT_RATE) / ONE;
    assert.equal(M.ark.psrCommitmentAdmissible(M.params, 2n * need, 0n, y), true);
    assert.equal(M.ark.psrCommitmentAdmissible(M.params, need / 2n, 0n, y), false);
    assert.equal(M.ark.psrCommitmentAdmissible(M.params, 0n, 0n, y), false);
    assert.equal(M.ark.psrCommitmentAdmissible(M.params, 2n * need, 0n, y, true), false, 'no commitment while a step is queued');
  });

  test('EC-08: the gate covers the committed book with the new position in it, not the new position alone', async () => {
    const ctx = await fixture();
    await ctx.setAllocation(STAGE1);
    // Enough for one 100-unit commitment, not for two.
    const one = gateNeed(STAGE1.psrCap, AUDIT_RATE, 100n * ONE);
    await ctx.escrow.send('primePsr', [one + one / 2n], { from: ACCOUNTS.admin });
    await ctx.escrow.send('anchorCommitted', [QRL_OWNER, 100n * ONE], { from: ACCOUNTS.alice });
    await assert.rejects(ctx.escrow.send('anchorCommitted', [QRL_OWNER, 100n * ONE], { from: ACCOUNTS.bob }), /PsrShort/);
    // A smaller second commitment that the reserve does cover still passes.
    await ctx.escrow.send('anchorCommitted', [QRL_OWNER, 40n * ONE], { from: ACCOUNTS.bob });
  });

  test('EC-08: after an epoch closes with a yield, the gate reads the trailing mean the cap is taken on, not the audit\'s rate', async () => {
    // An audit rate of a quarter of a per cent an epoch, so the epoch's 1% sits
    // at the ORIGIN-04 clamp, four times it, and is read whole.
    const ctx = await fixture({ auditRate: ONE / 400n });
    await ctx.setAllocation(STAGE1);
    await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    // One unit of gross yield on a book of 100: a rate of 1% an epoch, four
    // times the audit's.
    await ctx.asset.send('mint', [ctx.escrow.address, ONE]);
    await ctx.escrow.send('sweep', []);
    const audit = gateNeed(STAGE1.psrCap, ctx.auditRate, 100n * ONE);
    // The reserve holds the levy and a prime twice the audit-rate gate, half the mean-rate one.
    await ctx.escrow.send('primePsr', [audit * 2n], { from: ACCOUNTS.admin });
    // The next epoch: its first touch closes the last one.
    await ctx.setAllocation(STAGE1);
    await assert.rejects(ctx.escrow.send('anchorCommitted', [QRL_OWNER, 100n * ONE], { from: ACCOUNTS.bob }), /PsrShort/);
    // At the mean of the one closed epoch, per share of the book with the new
    // position in it, the gate wants about 0.55 units; a prime past it admits.
    await ctx.escrow.send('primePsr', [ONE + ONE / 5n], { from: ACCOUNTS.admin });
    await ctx.escrow.send('anchorCommitted', [QRL_OWNER, 100n * ONE], { from: ACCOUNTS.bob });
  });

  test('EC-08 liveness: a reserve exactly at its cap admits commitment of the whole book, the yield rising so the last epoch exceeds the mean', async (t) => {
    // Epochs of 1% and 3%: an audit rate of 1%, whose ORIGIN-04 clamp (4%) reads both whole.
    const ctx = await fixture({ auditRate: ONE / 100n });
    // A cap of 100 bps of the mean gross against a levy of 500: every epoch's
    // levy is above the cap, so the close sweeps the reserve to the cap itself.
    const o = { ...STAGE1, levy: 500, psrCap: 100 };
    await ctx.setAllocation(o);
    // The whole book committed from the start, against a prime the first
    // epoch's levy replaces.
    await ctx.escrow.send('primePsr', [gateNeed(o.psrCap, ctx.auditRate, 100n * ONE)], { from: ACCOUNTS.admin });
    await ctx.escrow.send('anchorCommitted', [QRL_OWNER, 100n * ONE], { from: ACCOUNTS.alice });
    await ctx.asset.send('mint', [ctx.escrow.address, ONE]);
    await ctx.escrow.send('sweep', []);
    const book0 = await ctx.escrow.call('positionShares');
    // The next epoch yields three times as much.
    await ctx.setAllocation(o);
    await ctx.asset.send('mint', [ctx.escrow.address, 3n * ONE]);
    await ctx.escrow.send('sweep', []);
    assert.equal(await ctx.escrow.call('primeUnreplaced'), 0n, 'the levy replaced the prime');
    const book = await ctx.escrow.call('positionShares');
    // The epoch after: the first touch closes the second, the mean of the two
    // rates below the last one, and caps the reserve at the shared rate. The
    // first touch is the allocation's recording, which settles first
    // (OC-LEGA-04), so the close-out runs at the allocation it accrued under.
    const { res } = await ctx.setAllocation(o);
    await ctx.asset.send('mint', [ctx.escrow.address, 1n]);
    await ctx.escrow.send('sweep', []);
    const last = rateOf(3n * ONE, book);
    const mean = (rateOf(ONE, book0) + last) / 2n;
    assert.ok(last > mean, 'the yield rose: the last rate exceeds the mean');
    const cap = capAtRate(o.psrCap, mean, book);
    assert.equal(ctx.escrow.events(res, 'ReserveCapped')[0].args.capShares, cap);
    const reserve = await ctx.escrow.call('psrShares');
    assert.equal(reserve, cap, 'the reserve stands exactly at its cap');
    // A second position committed beside the first, against a prime of just
    // its own part at the shared rate (one share over, for the stake's
    // conversion): the cap carries the book already committed.
    await ctx.escrow.send('primePsr', [gateNeed(o.psrCap, mean, 50n * ONE + 1n)], { from: ACCOUNTS.admin });
    await ctx.escrow.send('anchorCommitted', [QRL_OWNER, 50n * ONE], { from: ACCOUNTS.bob });
    const M = await loadModel();
    if (!M) return t.diagnostic(MISSING);
    const p = { ...M.params, psrCapEpochs: 1, threatStage1Bps: 1850, threatStage4Bps: 1950, commitmentTermEpochs: 13 };
    const rates = [M.ark.psrEpochRate(ONE, book0, ctx.auditRate), M.ark.psrEpochRate(3n * ONE, book, ctx.auditRate)];
    assert.equal(M.ark.psrTrailingRate(p, rates, ctx.auditRate), mean);
    assert.equal(M.ark.psrCapAtRate(p, book, mean), cap);
    // At its cap the reserve admits the whole book at the shared rate, and one unit short it does not.
    assert.equal(M.ark.psrCommitmentAdmissibleAtRate(p, reserve, book, 0n, mean), true);
    assert.equal(M.ark.psrCommitmentAdmissibleAtRate(p, reserve - 1n, book, 0n, mean), false);
    // At the last epoch's rate alone the same reserve would refuse it: anchoring would block.
    assert.equal(M.ark.psrCommitmentAdmissibleAtRate(p, reserve, book, 0n, last), false);
  });

  test('EC-08 adversarial: a window of quiet epochs reads the audit\'s rate, never a requirement of zero', async () => {
    const ctx = await fixture();
    await ctx.setAllocation(STAGE1);
    await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    // Two epochs pass with no yield swept: every closed epoch of the window reads zero.
    ctx.chain.advanceTime(2 * EPOCH);
    await ctx.anchorFor(ACCOUNTS.bob, ONE);
    await ctx.setAllocation(STAGE1);
    await assert.rejects(
      ctx.escrow.send('anchorCommitted', [QRL_OWNER, 100n * ONE], { from: ACCOUNTS.mallory }),
      /PsrShort/,
      'an empty reserve admits nothing on a quiet window',
    );
    const need = gateNeed(STAGE1.psrCap, AUDIT_RATE, 100n * ONE);
    await ctx.escrow.send('primePsr', [need / 2n], { from: ACCOUNTS.admin });
    await assert.rejects(ctx.escrow.send('anchorCommitted', [QRL_OWNER, 100n * ONE], { from: ACCOUNTS.mallory }), /PsrShort/);
    await ctx.escrow.send('primePsr', [need], { from: ACCOUNTS.admin });
    await ctx.escrow.send('anchorCommitted', [QRL_OWNER, 100n * ONE], { from: ACCOUNTS.mallory });
  });

  test('PV-04: the prime stands above the cap until the levy has replaced it (psrEpoch)', async (t) => {
    // A yield of the whole book: an audit rate the ORIGIN-04 clamp does not bind on.
    const ctx = await fixture({ auditRate: ONE / 2n });
    // A cap of 100 bps of the mean gross against a levy of 200, and a prime of 10.
    const o = { ...STAGE1, psrCap: 100 };
    await ctx.setAllocation(o);
    await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    const prime = 10n * ONE;
    const res0 = await ctx.escrow.send('primePsr', [prime], { from: ACCOUNTS.admin });
    const [pe] = ctx.escrow.events(res0, 'PsrPrimed');
    assert.equal(pe.args.shares, prime);
    assert.equal(await ctx.escrow.call('primeUnreplaced'), prime);
    await ctx.asset.send('mint', [ctx.escrow.address, 100n * ONE]);
    await ctx.escrow.send('sweep', []);
    const levy = (100n * ONE * 200n) / BPS;
    assert.equal(await ctx.escrow.call('psrShares'), prime + levy);
    // The epoch ends: the cap (about 1 unit) plus the prime still held stays, the rest to the buffer.
    const book = await ctx.escrow.call('positionShares');
    // Closed at the first touch of the next epoch: the allocation's recording (OC-LEGA-04).
    const { res } = await ctx.setAllocation(o);
    await ctx.asset.send('mint', [ctx.escrow.address, 1n]);
    await ctx.escrow.send('sweep', []);
    const [capped] = ctx.escrow.events(res, 'ReserveCapped');
    const cap = capAtRate(100, rateOf(100n * ONE, book), book);
    assert.equal(capped.args.capShares, cap);
    assert.equal(capped.args.toBufferShares, prime + levy - (cap + prime));
    assert.equal(await ctx.escrow.call('primeUnreplaced'), prime - levy, 'the epoch\'s levy replaced that much of the prime');
    const M = await loadModel();
    if (!M) return t.diagnostic(MISSING);
    // psrEpoch at the cap psrCapAtRate states: its balance, its sweep and the prime left.
    const p = { ...M.params, psrCapEpochs: 1, threatStage1Bps: 1850, threatStage4Bps: 1950 };
    assert.equal(M.ark.psrCapAtRate(p, book, M.ark.psrEpochRate(100n * ONE, book)), cap);
    const step = M.ark.psrEpoch(p, { balance: prime, levyInflow: levy, reserveYield: 0n, topUpDemand: 0n, epochGrossYield: cap * BPS / 100n, primeUnreplaced: prime });
    assert.equal(step.balance, cap + prime);
    assert.equal(step.toBuffer, levy - cap);
    assert.equal(step.primeUnreplaced, prime - levy);
  });

  test('QL-24: the cap is taken on the trailing mean of the closed epochs\' rates, a quiet epoch entering at zero (psrTrailingRate)', async (t) => {
    // A yield of the whole book: an audit rate the ORIGIN-04 clamp does not bind on.
    const ctx = await fixture({ auditRate: ONE / 2n });
    const o = { ...STAGE1, psrCap: 100 };
    await ctx.setAllocation(o);
    await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    await ctx.asset.send('mint', [ctx.escrow.address, 100n * ONE]);
    await ctx.escrow.send('sweep', []);
    const book = await ctx.escrow.call('positionShares');
    // One epoch passes untouched: when the next is first touched two epochs
    // have closed, one at its rate and a quiet one at zero, and the mean is half.
    ctx.chain.advanceTime(2 * EPOCH);
    await ctx.asset.send('mint', [ctx.escrow.address, 1n]);
    const res = await ctx.escrow.send('sweep', []);
    const [capped] = ctx.escrow.events(res, 'ReserveCapped');
    const mean = rateOf(100n * ONE, book) / 2n;
    const cap = capAtRate(100, mean, book);
    assert.equal(capped.args.capShares, cap);
    assert.equal(await ctx.escrow.call('psrShares'), cap);
    assert.ok(cap <= (50n * ONE * 100n) / BPS && (50n * ONE * 100n) / BPS - cap < 1000n, 'about 1% of a mean of 50');
    const M = await loadModel();
    if (!M) return t.diagnostic(MISSING);
    const p = { ...M.params, commitmentTermEpochs: 13 };
    assert.equal(M.ark.psrTrailingRate(p, [M.ark.psrEpochRate(100n * ONE, book, ctx.auditRate), 0n], ctx.auditRate), mean);
    assert.equal(M.ark.psrTrailingRate(p, [], AUDIT_RATE), AUDIT_RATE, 'the audit rate before the first close-out');
    assert.equal(M.ark.psrTrailingRate(p, [0n, 0n], AUDIT_RATE), AUDIT_RATE, 'and where every closed epoch was quiet');
  });

  test('no commitment without an allocation that offers a term', async () => {
    const ctx = await fixture();
    await assert.rejects(
      ctx.escrow.send('anchorCommitted', [QRL_OWNER, 100n * ONE], { from: ACCOUNTS.alice }),
      /CommitmentUnavailable/,
    );
    await ctx.setAllocation({ ...STAGE1, term: 0 });
    await assert.rejects(
      ctx.escrow.send('anchorCommitted', [QRL_OWNER, 100n * ONE], { from: ACCOUNTS.alice }),
      /CommitmentUnavailable/,
    );
  });

  test('I39: when the stage steps, the reserve tops the committed premium up to spot and the pot receives the spot premium', async (t) => {
    // A reserve filled by a yield of ten times the book: an audit rate the
    // ORIGIN-04 clamp does not bind on at the close-out, so the cap leaves the
    // reserve whole, and a prime that meets the gate at that audit rate.
    const ctx = await fixture({ auditRate: ONE });
    const { spot, committed } = await committedBook(ctx, 1000n * ONE, 100n * ONE);
    await ctx.setAllocation(STAGE2);
    const reserveBefore = await ctx.escrow.call('psrShares');
    const potBefore = await ctx.escrow.call('auctionShares');
    const claimBefore = [await ctx.escrow.call('claimOf', [spot.id]), await ctx.escrow.call('claimOf', [committed.id])];
    const T = await ctx.escrow.call('totalStake');
    const gross = 300n * ONE;
    await ctx.asset.send('mint', [ctx.escrow.address, gross]);
    const res = await ctx.escrow.send('sweep', []);
    const [rs] = ctx.escrow.events(res, 'ReserveSwept');
    // The committed cohort's part of the gross, and its top-up: the model's psrTopUpUnits.
    const [, c] = await ctx.escrow.call('cohortOf', [committed.id]);
    void c;
    const committedStake = (await ctx.escrow.call('positionOf', [committed.id])).stake;
    const yC = (gross * committedStake) / T;
    const expected = (650n * 10000n * yC) / (BPS * BPS);
    assert.equal(rs.args.demandUnits, expected);
    assert.equal(rs.args.paidUnits, expected, 'the reserve met the whole gap');
    const levy = (gross * 200n) / BPS;
    assert.equal(await ctx.escrow.call('psrShares'), reserveBefore + levy - expected, 'the levy credited before the top-up is paid');
    // The pot takes the spot premium on the whole gross: the coupon does not fall with the step.
    assert.equal((await ctx.escrow.call('auctionShares')) - potBefore, (gross * 2500n) / BPS);
    // The committed position gained its top-up over the spot one, to within rounding.
    const gainSpot = (await ctx.escrow.call('claimOf', [spot.id])) - claimBefore[0];
    const gainCommitted = (await ctx.escrow.call('claimOf', [committed.id])) - claimBefore[1];
    const diff = gainCommitted - gainSpot;
    assert.ok(diff <= expected && expected - diff < 10n ** 6n, `committed gained ${diff} over spot, top-up ${expected}`);
    const M = await loadModel();
    if (!M) return t.diagnostic(MISSING);
    assert.equal(M.ark.psrTopUpUnits(2500, 1850, 10000, yC), expected);
    const delivered = M.ark.committedPremiumDeliveredUnits(1850, 10000, yC, expected);
    const spotPremium = (2500n * 10000n * yC) / (BPS * BPS);
    assert.ok(delivered + 1n >= spotPremium, 'I39: at or above sigma_t * covered where the reserve met the gap');
  });

  test('I39 adversarial: a reserve that cannot meet the gap pays what it holds, the pot pays the rest, and every commitment reprices from the next epoch', async () => {
    const ctx = await fixture();
    // No earlier levy, and a prime just enough for the gate (psrCapBps of one
    // epoch at the audit rate on the committed position, about 0.047 units):
    // the reserve holds far less than the step's top-up when it comes.
    const { spot, committed } = await committedBook(ctx, 1n, ONE / 20n);
    await ctx.setAllocation({ ...STAGE2, levy: 100 });
    const potBefore = await ctx.escrow.call('auctionShares');
    const gross = 300n * ONE;
    await ctx.asset.send('mint', [ctx.escrow.address, gross]);
    const res = await ctx.escrow.send('sweep', []);
    const [rs] = ctx.escrow.events(res, 'ReserveSwept');
    assert.ok(rs.args.paidUnits < rs.args.demandUnits, 'exhausted');
    const [rp] = ctx.escrow.events(res, 'CommitmentsRepriced');
    assert.equal(rp.args.fromEpoch, ctx.epoch() + 1n);
    const unfunded = rs.args.demandUnits - rs.args.paidUnits;
    assert.equal((await ctx.escrow.call('auctionShares')) - potBefore, (gross * 2500n) / BPS - unfunded, 'the pot short by exactly what the reserve could not pay');
    assert.equal(await ctx.escrow.call('psrShares'), 0n, 'it paid what it held');
    // From the next epoch the commitment is void: the committed position pays spot.
    await ctx.setAllocation(STAGE2);
    const [, cohortBefore] = await ctx.escrow.call('cohortOf', [committed.id]);
    const before = [await ctx.escrow.call('claimOf', [spot.id]), await ctx.escrow.call('claimOf', [committed.id])];
    await ctx.asset.send('mint', [ctx.escrow.address, gross]);
    const again = await ctx.escrow.send('sweep', []);
    const [rs2] = ctx.escrow.events(again, 'ReserveSwept');
    assert.equal(rs2.args.demandUnits, 0n, 'no top-up for a repriced commitment');
    const [, cohortAfter] = await ctx.escrow.call('cohortOf', [committed.id]);
    assert.equal(cohortAfter.mult, cohortBefore.mult, 'its multiplier no longer moves');
    // Both now earn at spot: the same gain per unit of claim, to within rounding.
    const gainSpot = (await ctx.escrow.call('claimOf', [spot.id])) - before[0];
    const gainCommitted = (await ctx.escrow.call('claimOf', [committed.id])) - before[1];
    const lhs = gainSpot * before[1];
    const rhs = gainCommitted * before[0];
    const skew = lhs > rhs ? lhs - rhs : rhs - lhs;
    assert.ok(skew * 1_000_000n < lhs, `both at spot: ${gainSpot}/${before[0]} against ${gainCommitted}/${before[1]}`);
  });

  test('I39: the reserve is reached by no release, settlement or recovery path', async () => {
    const ctx = await fixture();
    await committedBook(ctx);
    const reserve = await ctx.escrow.call('psrShares');
    assert.ok(reserve > 0n);
    const recoveryId = keccak256(toUtf8Bytes('recovery:psr'));
    const recipient = keccak256(toUtf8Bytes('holder:psr'));
    const held = await ctx.escrow.call('sharesHeld');
    const quantity = held - (await ctx.escrow.call('bufferShares')) - (await ctx.escrow.call('queuedShares'));
    const leaf = ids.shareLeaf({ chainId: CHAIN_ID, escrow: ctx.escrow.address, recoveryId, recipient, destination: ACCOUNTS.bob, quantity });
    const s = await ctx.seal(leaf);
    await assert.rejects(
      ctx.escrow.send('releaseShare', [ZERO32, recoveryId, recipient, ACCOUNTS.bob, quantity, s.epoch, s.proof(leaf)]),
      /ShareExceedsHolding/,
      'the recovered pool is the positions and the pot, never the reserve',
    );
    assert.equal(await ctx.escrow.call('psrShares'), reserve);
  });

  test('at the declaration the reserve joins the recovered pool: a recovery share reaches it after closure, never before', async () => {
    // The reserve was funded from the positions' own yield to smooth a premium
    // that ends at the declaration; from closure no top-up is ever owed, so it
    // belongs with the positions that funded it. Before closure — the
    // censorship ground — it stays out of reach (I39, the test above).
    const ctx = await fixture();
    await committedBook(ctx);
    const reserve = await ctx.escrow.call('psrShares');
    assert.ok(reserve > 0n);
    const pool = async () => (await ctx.escrow.call('sharesHeld')) - (await ctx.escrow.call('bufferShares'))
      - (await ctx.escrow.call('queuedShares')) - (await ctx.escrow.call('unclaimedShares'));
    const shareOf = async (quantity, tag) => {
      const recoveryId = keccak256(toUtf8Bytes(tag));
      const recipient = keccak256(toUtf8Bytes('holder:psr'));
      const leaf = ids.shareLeaf({ chainId: CHAIN_ID, escrow: ctx.escrow.address, recoveryId, recipient, destination: ACCOUNTS.bob, quantity });
      const sealed = await ctx.seal(leaf);
      return { args: [ZERO32, recoveryId, recipient, ACCOUNTS.bob, quantity, sealed.epoch, sealed.proof(leaf)] };
    };
    const whole = await pool();
    const before = await shareOf(whole, 'recovery:before');
    await assert.rejects(ctx.escrow.send('releaseShare', before.args), /ShareExceedsHolding/);

    await ctx.declare();
    // Across an epoch boundary after closure, the cap moves none of it to the buffer.
    const buffer = await ctx.escrow.call('bufferShares');
    ctx.chain.advanceTime(EPOCH);
    await ctx.asset.send('mint', [ctx.escrow.address, ONE]);
    await ctx.escrow.send('sweep', []);
    assert.equal(await ctx.escrow.call('psrShares'), reserve, 'not capped into the buffer after the declaration');
    const bufferGrowth = (await ctx.escrow.call('bufferShares')) - buffer;
    assert.ok(bufferGrowth <= ONE, 'the buffer took the sweep\'s share and nothing of the reserve');

    const all = await pool();
    const after = await shareOf(all, 'recovery:after');
    const res = await ctx.escrow.send('releaseShare', after.args);
    const [ev] = ctx.escrow.events(res, 'ReleasesReclaimed');
    assert.equal(ev.args.reserveShares, reserve);
    assert.equal(await ctx.escrow.call('psrShares'), 0n);
    assert.equal(await ctx.escrow.call('positionShares') + await ctx.escrow.call('auctionShares'), 0n, 'the whole pool, reserve included, was drawn');
  });

  test('a committed position releases with the stake its top-ups raised, and leaves its cohort', async () => {
    const ctx = await fixture();
    const { committed } = await committedBook(ctx);
    await ctx.setAllocation(STAGE2);
    await ctx.asset.send('mint', [ctx.escrow.address, 300n * ONE]);
    await ctx.escrow.send('sweep', []);
    const claim = await ctx.escrow.call('claimOf', [committed.id]);
    const leaf = ctx.releaseLeaf(committed.id, ACCOUNTS.mallory);
    const s = await ctx.seal(leaf);
    ctx.chain.advanceTime(5 * EPOCH);
    await ctx.release(committed.id, ACCOUNTS.mallory, s, leaf);
    const paid = await ctx.balance(ACCOUNTS.mallory) - 900n * ONE;
    assert.ok(paid >= claim, `paid ${paid} against the claim ${claim} before the wait`);
    const [key] = await ctx.escrow.call('cohortOf', [committed.id]);
    assert.equal(key, 0n);
  });
});

describe('the allocation, and the bound on a forged one', () => {
  test('an allocation outside its section 6.3 range does not execute', async () => {
    const ctx = await fixture();
    for (const o of [
      { sigma: 4001 },
      { buffer: 249 },
      { buffer: 1501 },
      { ops: 249 },
      { ops: 1001 },
      { juror: 5001 },
      { levy: 501 },
      { target: 4001 },
      { covered: 10001 },
      { psrCap: 25801 },
      { term: 27 },
    ]) {
      const e = await ctx.freshEpoch();
      const { rates, leaf } = ctx.allocationOf(e, o);
      const s = await ctx.seal(leaf);
      await assert.rejects(
        ctx.escrow.send('recordEpochAllocation', [s.epoch, rates, s.proof(leaf)]),
        /AllocationOutOfRange/,
        JSON.stringify(o),
      );
    }
    // The levy is a share of gross yield like the other three, so it counts toward the sum.
    const e = await ctx.freshEpoch();
    const { rates, leaf } = ctx.allocationOf(e, { sigma: 4000, buffer: 1500, ops: 1000, levy: 500, juror: 0 });
    void rates;
    const s = await ctx.seal(leaf);
    await ctx.escrow.send('recordEpochAllocation', [s.epoch, rates, s.proof(leaf)]);
  });

  test('an allocation at the edge of every range is admitted and sums within the yield', async () => {
    const ctx = await fixture();
    await ctx.setAllocation({ sigma: 4000, buffer: 1500, ops: 1000, juror: 5000, levy: 500, target: 4000, covered: 10000, psrCap: 25800, term: 26 });
    const a = await ctx.escrow.call('recordedAllocation');
    assert.equal(
      [a.sigmaBps, a.bufferBps, a.operationsBps, a.jurorFeeShareBps, a.levyBps, a.sigmaTargetBps, a.coveredBps, a.psrCapBps, a.commitTermEpochs].join(),
      '4000,1500,1000,5000,500,4000,10000,25800,26',
    );
  });

  test('the record the relay packs is the compiler\'s layout: every field reads back as sealed (EC phase 2)', async () => {
    // `recordEpochAllocation` stores the one word `allocationReceipt` packs,
    // so a field written at the wrong offset would read back as another.
    // Distinct values in every field, the step flag both ways.
    const ctx = await fixture();
    for (const o of [
      { sigma: 1851, buffer: 252, ops: 253, juror: 4, levy: 105, target: 3706, covered: 9007, psrCap: 11108, term: 9, step: true },
      { sigma: 3999, buffer: 1499, ops: 999, juror: 4999, levy: 499, target: 1, covered: 2, psrCap: 25799, term: 25, step: false },
    ]) {
      const s = await ctx.setAllocation(o);
      const a = await ctx.escrow.call('recordedAllocation');
      assert.deepEqual(
        [a.epoch, a.sigmaBps, a.bufferBps, a.operationsBps, a.jurorFeeShareBps, a.levyBps, a.sigmaTargetBps, a.coveredBps, a.psrCapBps, a.commitTermEpochs, a.set, a.stepQueued],
        [s.epoch, ...[o.sigma, o.buffer, o.ops, o.juror, o.levy, o.target, o.covered, o.psrCap, o.term].map(BigInt), true, o.step],
      );
    }
  });

  test('a four-field allocation leaf from the old format does not verify', async () => {
    // The domain tag was bumped with the fifth field, so a leaf sealed under the
    // old format can never be read as the new one.
    const ctx = await fixture();
    const e = await ctx.freshEpoch();
    const old = v1AllocationLeaf(e, 3000, 250, 250);
    const s = await ctx.seal(old);
    await assert.rejects(
      ctx.escrow.send('recordEpochAllocation', [s.epoch, ctx.allocationOf(e).rates, s.proof(old)]),
      /BadProof/,
    );
  });

  test('a five-field V2 allocation leaf does not verify either (the V3 tag, gap item 19)', async () => {
    const ctx = await fixture();
    const e = await ctx.freshEpoch();
    const v2 = keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'bytes32', 'uint256', 'uint16', 'uint16', 'uint16', 'uint16'],
        [ids.STAKE_DOMAIN, keccak256(toUtf8Bytes('ARK_STAKE_ALLOCATION_V2')), e, 3000, 250, 250, 0],
      ),
    );
    const s = await ctx.seal(v2);
    await assert.rejects(ctx.escrow.send('recordEpochAllocation', [s.epoch, ctx.allocationOf(e).rates, s.proof(v2)]), /BadProof/);
  });

  test('an allocation for a future epoch does not execute', async () => {
    const ctx = await fixture();
    await assert.rejects(
      ctx.escrow.send('recordEpochAllocation', [ctx.epoch() + 1n, ctx.allocationOf(0n).rates, []]),
      /FutureEpochAllocation/,
    );
  });

  test('an allocation only moves forward, so a sweep is never repriced backwards', async () => {
    const ctx = await fixture();
    const e = await ctx.freshEpoch();
    const mk = (sigma) => ctx.allocationOf(e, { sigma });
    const s = await ctx.seal([mk(3000).leaf, mk(1500).leaf]);
    await ctx.escrow.send('recordEpochAllocation', [e, mk(3000).rates, s.proof(mk(3000).leaf)]);
    await assert.rejects(
      ctx.escrow.send('recordEpochAllocation', [e, mk(1500).rates, s.proof(mk(1500).leaf)]),
      /AllocationNotForward/,
    );
  });

  test('an allocation not in the epoch root does not execute', async () => {
    const ctx = await fixture();
    const e = await ctx.freshEpoch();
    const { leaf } = ctx.allocationOf(e);
    const s = await ctx.seal(leaf);
    await assert.rejects(
      ctx.escrow.send('recordEpochAllocation', [s.epoch, ctx.allocationOf(e, { sigma: 1500 }).rates, s.proof(leaf)]),
      /BadProof/,
    );
    // Every field of the leaf is bound: a relayer cannot seal one levy and record another.
    for (const o of [{ levy: 200 }, { target: 3700 }, { covered: 5000 }, { psrCap: 11100 }, { term: 13 }]) {
      await assert.rejects(
        ctx.escrow.send('recordEpochAllocation', [s.epoch, ctx.allocationOf(e, o).rates, s.proof(leaf)]),
        /BadProof/,
        JSON.stringify(o),
      );
    }
  });

  test('a forged allocation cannot send one wei to whoever forged it', async () => {
    // The bound, stated as a test: the one transfer a sweep makes goes to an
    // address fixed at construction, and everything else stays here.
    const ctx = await fixture();
    await ctx.setAllocation({ sigma: 4000, buffer: 250, ops: 1000, juror: 5000 });
    await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    await ctx.asset.send('mint', [ctx.escrow.address, 100n * ONE]);

    const heldBefore = await ctx.balance(ctx.escrow.address);
    const before = await ctx.balance(ACCOUNTS.mallory);
    await ctx.escrow.send('sweep', [], { from: ACCOUNTS.mallory });
    assert.equal(await ctx.balance(ACCOUNTS.mallory), before);
    const left = heldBefore - (await ctx.balance(ctx.escrow.address));
    assert.equal(left, await ctx.balance(OPS_DEST), 'something left other than to the operations destination');
  });
});

describe('the premium lock, the second return message', () => {
  const SECRET = keccak256(toUtf8Bytes('solver secret'));
  const HASHLOCK = ids.hashlockOf(SECRET);
  const LOT = keccak256(toUtf8Bytes('lot 1'));

  /**
   * A book with a held premium, and a premium lock for part of it — what QRL
   * seals for a lot selected at the close of its quote window.
   */
  async function withLock(ctx, { shares = 10n * ONE, recipient = BIDDER_DEST, hashlock = HASHLOCK, lotId = LOT, expiresIn = 2 * DAY } = {}) {
    await ctx.setAllocation({ sigma: 3000 });
    await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    await ctx.asset.send('mint', [ctx.escrow.address, 100n * ONE]);
    await ctx.escrow.send('sweep', []);
    const e = await ctx.freshEpoch();
    const evmExpiry = e * EPOCH_N + BigInt(expiresIn);
    // The offered epoch and the commitment bond are bound by the V3 leaf (yellow paper §3.5, I33).
    const lock = { lotId, hashlock, recipient, shares, evmExpiry, epoch: e - 2n, bond: shares / 40n };
    const leaf = ids.premiumLockLeaf({ chainId: CHAIN_ID, escrow: ctx.escrow.address, asset: ctx.asset.address, ...lock });
    const s = await ctx.seal(leaf);
    const payload = [lotId, hashlock, recipient, shares, evmExpiry, lock.epoch, lock.bond];
    return { leaf, s, lock, payload, args: (secret = SECRET) => [payload, s.epoch, s.proof(leaf), secret] };
  }

  test('a lot is paid to the solver the lock names, against the preimage, carried by anyone', async () => {
    const ctx = await fixture();
    const { args, lock } = await withLock(ctx);
    const pot = await ctx.escrow.call('auctionShares');
    const res = await ctx.escrow.send('claimPremium', args(), { from: ACCOUNTS.mallory });
    assert.equal(await ctx.balance(BIDDER_DEST), lock.shares);
    assert.equal(await ctx.escrow.call('auctionShares'), pot - lock.shares);
    assert.equal(await ctx.balance(ACCOUNTS.mallory), 1_000n * ONE, 'the carrier receives nothing');
    const [ev] = ctx.escrow.events(res, 'PremiumClaimed');
    assert.equal(ev.args.lotId, LOT);
    assert.equal(ev.args.secret, SECRET, 'the claim publishes the preimage for QRL');
  });

  test('a wrong preimage pays nothing; the hash is sha256, not keccak256', async () => {
    const ctx = await fixture();
    const { args, payload, s, leaf } = await withLock(ctx);
    await assert.rejects(ctx.escrow.send('claimPremium', args(keccak256(toUtf8Bytes('guess')))), /WrongPreimage/);
    const keccakLock = [payload[0], keccak256(SECRET), ...payload.slice(2)];
    await assert.rejects(ctx.escrow.send('claimPremium', [keccakLock, s.epoch, s.proof(leaf), SECRET]), /WrongPreimage/);
  });

  test('a substituted recipient, share count, expiry, offered epoch or bond has no proof', async () => {
    const ctx = await fixture();
    const { payload, s, leaf } = await withLock(ctx);
    for (const [i, v] of [[2, ACCOUNTS.mallory], [3, 10n * ONE + 1n], [4, payload[4] + 1n], [5, payload[5] + 1n], [6, payload[6] + 1n]]) {
      const forged = [...payload];
      forged[i] = v;
      await assert.rejects(ctx.escrow.send('claimPremium', [forged, s.epoch, s.proof(leaf), SECRET]), /BadProof/);
    }
  });

  test('a lot is paid once, however many roots carry its leaf', async () => {
    const ctx = await fixture();
    const { leaf, args, payload } = await withLock(ctx, { shares: ONE, expiresIn: 3 * EPOCH });
    await ctx.escrow.send('claimPremium', args());
    await assert.rejects(ctx.escrow.send('claimPremium', args()), /ProofSpent/);
    const again = await ctx.seal(leaf);
    await assert.rejects(ctx.escrow.send('claimPremium', [payload, again.epoch, again.proof(leaf), SECRET]), /ProofSpent/);
    assert.equal(await ctx.balance(BIDDER_DEST), ONE);
  });

  test('a lot cannot reach principal or buffer: it is bounded by the pot', async () => {
    const ctx = await fixture();
    const { args } = await withLock(ctx, { shares: 50n * ONE });
    assert.ok((await ctx.escrow.call('auctionShares')) < 50n * ONE);
    await assert.rejects(ctx.escrow.send('claimPremium', args()), /PremiumExceedsPot/);
  });

  test('at the origin-chain expiry the lot is dead and nothing has left the escrow', async () => {
    const ctx = await fixture();
    const { args, lock } = await withLock(ctx);
    const pot = await ctx.escrow.call('auctionShares');
    ctx.chain.advanceTime(Number(lock.evmExpiry - BigInt(ctx.chain.timestamp)));
    await assert.rejects(ctx.escrow.send('claimPremium', args()), /PremiumExpired/);
    assert.equal(await ctx.escrow.call('auctionShares'), pot, 'an unclaimed lot needs no refund here');
  });

  test('no lot sealed after the root that carried the close is paid, and the pot stays for recovery', async () => {
    const ctx = await fixture();
    await ctx.setAllocation({ sigma: 3000 });
    await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    await ctx.asset.send('mint', [ctx.escrow.address, 100n * ONE]);
    await ctx.escrow.send('sweep', []);
    const pot = await ctx.escrow.call('auctionShares');
    const closing = await ctx.declare();
    const e = await ctx.freshEpoch();
    const lock = { lotId: LOT, hashlock: HASHLOCK, recipient: BIDDER_DEST, shares: 10n * ONE, evmExpiry: e * EPOCH_N + BigInt(3 * EPOCH), epoch: e - 2n, bond: ONE / 4n };
    const leaf = ids.premiumLockLeaf({ chainId: CHAIN_ID, escrow: ctx.escrow.address, asset: ctx.asset.address, ...lock });
    const s = await ctx.seal(leaf);
    assert.ok(s.epoch > closing.epoch);
    const payload = [lock.lotId, lock.hashlock, lock.recipient, lock.shares, lock.evmExpiry, lock.epoch, lock.bond];
    await assert.rejects(ctx.escrow.send('claimPremium', [payload, s.epoch, s.proof(leaf), SECRET]), /SettlementClosed/);
    assert.equal(await ctx.escrow.call('auctionShares'), pot);
  });

  test('OC-LEGA-03: a lot sealed before the close was carried is still paid after it, inside its evmExpiry', async () => {
    // The race of the OC round (2026-10-03): the solver's claim is broadcast,
    // its preimage is public, and a close leaf carried in front of it closes
    // the escrow. The lot was paid for on QRL, so it is paid here.
    const ctx = await fixture();
    const { args, lock } = await withLock(ctx, { expiresIn: 3 * EPOCH });
    const pot = await ctx.escrow.call('auctionShares');
    await ctx.declare();
    assert.equal(await ctx.escrow.call('auctionShares'), pot);
    const res = await ctx.escrow.send('claimPremium', args());
    assert.equal(ctx.escrow.events(res, 'PremiumClaimed')[0].args.secret, SECRET);
    assert.equal(await ctx.balance(BIDDER_DEST), lock.shares);
    assert.equal(await ctx.escrow.call('auctionShares'), pot - lock.shares, 'paid out of the pot, nothing else');
    // Once only: the leaf is spent, closed or not.
    await assert.rejects(ctx.escrow.send('claimPremium', args()), /ProofSpent/);
  });

  test('the freeze does not stop a lot', async () => {
    const ctx = await fixture();
    const { args, lock } = await withLock(ctx, { expiresIn: 3 * EPOCH });
    await ctx.freeze(true);
    await ctx.escrow.send('claimPremium', args());
    assert.equal(await ctx.balance(BIDDER_DEST), lock.shares);
  });

  test('a lock sealed for another asset does not verify here', async () => {
    const ctx = await fixture();
    const { lock } = await withLock(ctx, { expiresIn: 3 * EPOCH });
    const leaf = ids.premiumLockLeaf({ chainId: CHAIN_ID, escrow: ctx.escrow.address, asset: '0x' + 'aa'.repeat(20), ...lock });
    const s = await ctx.seal(leaf);
    await assert.rejects(
      ctx.escrow.send('claimPremium', [[lock.lotId, lock.hashlock, lock.recipient, lock.shares, lock.evmExpiry, lock.epoch, lock.bond], s.epoch, s.proof(leaf), SECRET]),
      /BadProof/,
    );
  });

  test('on a rebasing asset a lot is paid in shares, and the five pots still sum to the holding', async () => {
    const ctx = await fixture({ rebasing: true });
    const { args, lock } = await withLock(ctx, { expiresIn: 3 * EPOCH });
    await ctx.asset.send('rebase', [20n * ONE]);
    const worth = await ctx.escrow.call('toUnits', [lock.shares]);
    await ctx.escrow.send('claimPremium', args());
    const got = await ctx.balance(BIDDER_DEST);
    assert.ok(got <= worth && worth - got <= 2n, `paid ${got}, the shares are worth ${worth}`);
    assert.ok(got > lock.shares, 'the rebase since the quote is the solver\'s');
    await ctx.escrow.send('sweep', []).catch(() => {});
    assert.equal(await owed(ctx.escrow), await ctx.escrow.call('sharesHeld'));
  });
});

describe('the premium offer, carried forward to QRL', () => {
  test('offered once per epoch, in shares, only once earlier lots can no longer be claimed', async () => {
    const ctx = await fixture();
    await ctx.setAllocation({ sigma: 3000 });
    await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    await ctx.asset.send('mint', [ctx.escrow.address, 100n * ONE]);
    const e = ctx.epoch();
    const opens = e * EPOCH_N + 2n * BigInt(DAY);
    if (BigInt(ctx.chain.timestamp) < opens) {
      await assert.rejects(ctx.escrow.send('offerPremium', []), /OfferNotOpen/);
      ctx.chain.advanceTime(Number(opens - BigInt(ctx.chain.timestamp)));
    }
    const res = await ctx.escrow.send('offerPremium', [], { from: ACCOUNTS.mallory });
    const [ev] = ctx.escrow.events(res, 'PremiumOffered');
    const held = (100n * ONE * 3000n) / BPS;
    assert.equal(ev.args.shares, held, 'settled first, so the yield up to now is in the pot');
    assert.equal(ev.args.units, held, 'a non-rebasing asset is one unit a share');
    assert.equal(ev.args.offerLeaf, ids.premiumOfferLeaf({ chainId: CHAIN_ID, escrow: ctx.escrow.address, asset: ctx.asset.address, epoch: ctx.epoch(), shares: held, units: held }));
    await assert.rejects(ctx.escrow.send('offerPremium', []), /AlreadyOffered/);
  });

  test('nothing held is nothing offered, and nothing is offered after the declaration', async () => {
    const ctx = await fixture();
    ctx.chain.advanceTime(EPOCH);
    const opens = ctx.epoch() * EPOCH_N + 2n * BigInt(DAY);
    ctx.chain.advanceTime(Number(opens - BigInt(ctx.chain.timestamp)) + 1);
    await assert.rejects(ctx.escrow.send('offerPremium', []), /ZeroValue/);
    await ctx.declare();
    await assert.rejects(ctx.escrow.send('offerPremium', []), /SettlementClosed/);
  });
});

describe('the buffer, carried forward to QRL', () => {
  // Whitepaper §4.3: buffer_orig stands in the denominator of utilisation on
  // QRL beside bond principal. QRL cannot read this chain, so the escrow states
  // it under a leaf the forward path seals and ArkStakeRegistry.recordBuffer proves.
  for (const rebasing of [false, true]) {
    test(`reported once per epoch, settled first, in shares and units, under the buffer leaf (${rebasing ? 'shares' : 'units'})`, async () => {
      const ctx = await fixture({ rebasing });
      await ctx.setAllocation({ sigma: 3000, buffer: 1000 });
      await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
      if (rebasing) await ctx.asset.send('rebase', [10n * ONE]);
      else await ctx.asset.send('mint', [ctx.escrow.address, 100n * ONE]);
      const res = await ctx.escrow.send('reportBuffer', [], { from: ACCOUNTS.mallory });
      const [ev] = ctx.escrow.events(res, 'BufferReported');
      assert.equal(ev.args.shares, await ctx.escrow.call('bufferShares'), 'the buffer as it stands after the settlement');
      assert.equal(ev.args.units, await ctx.escrow.call('toUnits', [ev.args.shares]));
      assert.ok(ev.args.units > SEED_MINIMUM, 'the buffer share of the yield up to now is in it');
      assert.equal(
        ev.args.bufferLeaf,
        ids.bufferLeaf({ chainId: CHAIN_ID, escrow: ctx.escrow.address, asset: ctx.asset.address, epoch: ctx.epoch(), units: ev.args.units }),
      );
      await assert.rejects(ctx.escrow.send('reportBuffer', []), /AlreadyReported/);
      ctx.chain.advanceTime(EPOCH);
      // Past the settlement it runs first, the report itself moves nothing.
      await ctx.escrow.send('sweep', []).catch(() => {});
      const before = await ctx.escrow.call('sharesHeld');
      const buffer = await ctx.escrow.call('bufferShares');
      await ctx.escrow.send('reportBuffer', [], { from: ACCOUNTS.bob });
      assert.equal(await ctx.escrow.call('sharesHeld'), before, 'a statement moves nothing');
      assert.equal(await ctx.escrow.call('bufferShares'), buffer);
    });
  }

  test('still stated after the declaration: the buffer is capital until it is recovered', async () => {
    const ctx = await fixture();
    await ctx.declare();
    const res = await ctx.escrow.send('reportBuffer', []);
    const [ev] = ctx.escrow.events(res, 'BufferReported');
    assert.equal(ev.args.units, SEED_MINIMUM);
  });
});

describe('native ETH into the stETH escrow, staked through Lido in the same call', () => {
  async function lidoFixture() {
    const chain = await originChain();
    const r = await relayFixture(chain, { treeHeight: 5 });
    const lido = await chain.deploy('MockLido');
    // A pool that does not start at one unit per share, as stETH's does not.
    await lido.send('mint', [ACCOUNTS.admin, 1_000n * ONE]);
    await lido.send('rebase', [37n * ONE]);
    const escrow = await chain.deploy(
      'ArkStakeEscrowLido',
      ['address', 'address', 'address', 'uint256', 'uint256', 'uint256'],
      [lido.address, r.relay.address, OPS_DEST, SEED_MINIMUM, 20, AUDIT_RATE],
    );
    return { chain, ...r, lido, escrow };
  }

  test('ETH seeds the buffer and anchors a position, recorded as the shares Lido minted', async () => {
    const ctx = await lidoFixture();
    await assert.rejects(ctx.escrow.send('anchorNative', [QRL_OWNER], { from: ACCOUNTS.alice, value: ONE }), /SeedingAbsent/);
    // The pool's rate truncates, so exactly the minimum in ETH is a wei short of
    // it in units — the same one or two wei a stETH transfer loses.
    await ctx.escrow.send('seedNative', [], { from: ACCOUNTS.admin, value: SEED_MINIMUM + ONE });
    assert.ok((await ctx.escrow.call('seededUnits')) >= SEED_MINIMUM);

    const sharesBefore = await ctx.lido.call('sharesOf', [ctx.escrow.address]);
    const res = await ctx.escrow.send('anchorNative', [QRL_OWNER], { from: ACCOUNTS.alice, value: 5n * ONE });
    const [ev] = ctx.escrow.events(res, 'Anchored');
    const minted = (await ctx.lido.call('sharesOf', [ctx.escrow.address])) - sharesBefore;
    assert.equal(ev.args.shares, minted);
    assert.equal(ev.args.anchoredNotional, await ctx.lido.call('getPooledEthByShares', [minted]));
    assert.equal(ev.args.qrlOwnerHi, QRL_OWNER_HI);
    assert.equal(ev.args.qrlOwnerLo, QRL_OWNER_LO);
    assert.equal(await ctx.escrow.call('positionShares'), minted);
  });

  test('ETH anchors under the same refusals as stETH: no beneficiary, nothing sent, Lido paused', async () => {
    const ctx = await lidoFixture();
    await ctx.escrow.send('seedNative', [], { from: ACCOUNTS.admin, value: SEED_MINIMUM + ONE });
    await assert.rejects(ctx.escrow.send('anchorNative', [ZERO_ADDR], { from: ACCOUNTS.alice, value: ONE }), /NoBeneficiary/);
    await assert.rejects(ctx.escrow.send('anchorNative', [QRL_OWNER], { from: ACCOUNTS.alice, value: 0n }), /ZeroValue/);
    await ctx.lido.send('setPaused', [true]);
    await assert.rejects(ctx.escrow.send('anchorNative', [QRL_OWNER], { from: ACCOUNTS.alice, value: ONE }));
    assert.equal(await ctx.escrow.call('positionShares'), 0n);
  });

  test('ETH sent bare names no beneficiary and is refused', async () => {
    const ctx = await lidoFixture();
    await assert.rejects(ctx.chain.execute(ctx.escrow.address, ACCOUNTS.alice, '0x', ONE));
  });
});

/* ------------------------------------------------------------------ */

describe('release, and the one path principal takes out', () => {
  /** Anchor, then seal the release receipt as QRL would after the instruction. */
  async function readyToRelease(
    ctx,
    { units = 100n * ONE, recipient = ACCOUNTS.bob, ballast = 1_000n * ONE } = {},
  ) {
    // The bound is 2,500 bps of the book an epoch, so a test that is not about
    // the bound puts something else in the book.
    if (ballast > 0n) await ctx.anchorFor(ACCOUNTS.bob, ballast);
    const { id } = await ctx.anchorFor(ACCOUNTS.alice, units);
    const leaf = ctx.releaseLeaf(id, recipient);
    const s = await ctx.seal(leaf);
    return { id, s, leaf, recipient };
  }

  test('a release is admitted only against a leaf of an admitted root', async () => {
    const ctx = await fixture();
    const { id, s } = await readyToRelease(ctx);
    ctx.chain.advanceTime(4 * EPOCH);

    const before = await ctx.balance(ACCOUNTS.bob);
    const res = await ctx.release(id, ACCOUNTS.bob, s);
    assert.equal((await ctx.balance(ACCOUNTS.bob)) - before, 100n * ONE);
    const [ev] = ctx.escrow.events(res, 'Released');
    assert.equal(ev.args.units, 100n * ONE);
    assert.equal(ev.args.releasedLeaf, ids.releasedLeaf(ctx.escrow.address, id, 1n), 'the forward path cannot rebuild it');
  });

  test('substituting the recipient produces a leaf with no proof', async () => {
    // whitepaper §3.5. The substituted transaction reverts rather than winning
    // the fee race.
    const ctx = await fixture();
    const { id, s, leaf } = await readyToRelease(ctx, { recipient: ACCOUNTS.bob });
    ctx.chain.advanceTime(4 * EPOCH);
    await assert.rejects(
      ctx.escrow.send('release', [id, ACCOUNTS.mallory, 1n, s.epoch, s.proof(leaf)]),
      /BadProof/,
    );
  });

  test('a root labelled with a past epoch after a gap counts the unbonding from its admission (D11)', async () => {
    // The relay takes any label above the last and not in the future. From the
    // label alone, a root admitted after a gap but labelled four epochs back
    // made its receipts usable the moment it landed (E7 of 2026-09-22).
    const ctx = await fixture();
    await ctx.anchorFor(ACCOUNTS.bob, 1_000n * ONE);
    const { id } = await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    const leaf = ctx.releaseLeaf(id, ACCOUNTS.bob);
    ctx.chain.advanceTime(8 * EPOCH);
    const now = BigInt(ctx.epoch());
    const labelled = now - 4n;
    assert.ok(labelled > BigInt(await ctx.relay.call('lastEpoch')));
    const { buildTree, proofFor } = require('../../relayer/lib/merkle');
    const tree = buildTree([leaf]);
    const res = await ctx.admit(labelled, tree.root);
    assert.equal(BigInt(await ctx.relay.call('admittedIn', [labelled])), now);
    const [ev] = ctx.relay.events(res, 'EpochRootAdmitted');
    assert.equal(ev.args.usableFromEpoch, now + 4n, 'the event counts from the admission as well');
    const s = { epoch: labelled, proof: (l) => proofFor(tree, l) };
    // The first presentation moves the position into transit and consumes
    // nothing (X7); the unbonding it waits for counts from the admission.
    const first = await ctx.release(id, ACCOUNTS.bob, s);
    assert.equal(ctx.escrow.events(first, 'TransitMarked').length, 1);
    assert.equal(ctx.escrow.events(first, 'ReleaseQueued').length, 0);
    ctx.chain.advanceTime(3 * EPOCH);
    await assert.rejects(ctx.release(id, ACCOUNTS.bob, s), /UnbondingNotServed/);
    ctx.chain.advanceTime(EPOCH);
    await ctx.release(id, ACCOUNTS.bob, s);
  });

  test('an exit does not outrun the twenty-one day unbonding', async () => {
    const ctx = await fixture();
    const { id, s } = await readyToRelease(ctx);
    ctx.chain.advanceTime(21 * DAY - 1);
    const before = await ctx.balance(ACCOUNTS.bob);
    const early = await ctx.release(id, ACCOUNTS.bob, s);
    assert.equal(ctx.escrow.events(early, 'ReleaseQueued').length, 0, 'an early presentation queues nothing');
    assert.equal(await ctx.balance(ACCOUNTS.bob), before, 'and pays nothing');
    await assert.rejects(ctx.release(id, ACCOUNTS.bob, s), /UnbondingNotServed/);
    ctx.chain.advanceTime(4 * EPOCH);
    await ctx.release(id, ACCOUNTS.bob, s);
  });

  test('a receipt is consumed once, against the pair of epoch and leaf', async () => {
    const ctx = await fixture();
    const { id, s, leaf } = await readyToRelease(ctx);
    ctx.chain.advanceTime(4 * EPOCH);
    await ctx.release(id, ACCOUNTS.bob, s);
    assert.equal(await ctx.escrow.call('isSpent', [ids.spendKey(s.epoch, leaf)]), true);
    await assert.rejects(ctx.release(id, ACCOUNTS.bob, s), /UnknownPosition/);
  });

  test('a receipt for a position this escrow never created fails against escrow state', async () => {
    const ctx = await fixture();
    const ghost = keccak256(toUtf8Bytes('never-anchored'));
    const leaf = ctx.releaseLeaf(ghost, ACCOUNTS.bob);
    const s = await ctx.seal(leaf);
    ctx.chain.advanceTime(4 * EPOCH);
    await assert.rejects(ctx.release(ghost, ACCOUNTS.bob, s, leaf), /UnknownPosition/);
  });

  test('a receipt with the wrong claim nonce fails against escrow state', async () => {
    const ctx = await fixture();
    const { id } = await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    const leaf = ctx.releaseLeaf(id, ACCOUNTS.bob, 2n);
    const s = await ctx.seal(leaf);
    ctx.chain.advanceTime(4 * EPOCH);
    await assert.rejects(
      ctx.escrow.send('release', [id, ACCOUNTS.bob, 2n, s.epoch, s.proof(leaf)]),
      /WrongClaimNonce/,
    );
  });

  test('a release into the zero address is refused rather than burning principal', async () => {
    const ctx = await fixture();
    const { id, s, leaf } = await readyToRelease(ctx);
    ctx.chain.advanceTime(4 * EPOCH);
    await assert.rejects(
      ctx.escrow.send('release', [id, ZERO_ADDR, 1n, s.epoch, s.proof(leaf)]),
      /ZeroAddress/,
    );
  });

  test('the release path does not reopen after the declaration', async () => {
    // Invariant I15. A release instructed before a declaration and unexecuted at
    // one does not execute.
    const ctx = await fixture();
    const { id, s } = await readyToRelease(ctx);
    ctx.chain.advanceTime(4 * EPOCH);
    await ctx.declare();
    await assert.rejects(ctx.release(id, ACCOUNTS.bob, s), /ReleaseClosed/);
  });

  test('a freeze stops a receipt that has already left QRL, and consumes nothing', async () => {
    // The receipt is here, its four epochs are served, and nothing on QRL is
    // left to refuse it: the freeze must be checked on this chain. A refusal
    // must not consume the receipt, or a suspension would be a confiscation.
    const ctx = await fixture();
    const { id, s, leaf } = await readyToRelease(ctx);
    ctx.chain.advanceTime(4 * EPOCH);
    await ctx.freeze(true);
    // The first presentation under the freeze moves the position into transit
    // (X7) and consumes nothing; the next is refused.
    const marked = await ctx.release(id, ACCOUNTS.bob, s);
    assert.equal(ctx.escrow.events(marked, 'ReleaseQueued').length, 0, 'the freeze consumed nothing');
    assert.ok((await ctx.escrow.call('transitShares', [id])) > 0n, 'in transit: out of the priced book, still owed');
    await assert.rejects(ctx.release(id, ACCOUNTS.bob, s), /ReleaseFrozen/);
    assert.equal(await ctx.escrow.call('isSpent', [ids.spendKey(s.epoch, leaf)]), false);

    await ctx.freeze(false);
    const before = await ctx.balance(ACCOUNTS.bob);
    await ctx.release(id, ACCOUNTS.bob, s);
    assert.ok((await ctx.balance(ACCOUNTS.bob)) > before);
  });

  test('a freeze blocks releases and nothing else', async () => {
    // The premium stream ends at the declaration and not before, so a freeze
    // must leave anchoring and the sweep alone.
    const ctx = await fixture();
    await ctx.anchorFor(ACCOUNTS.bob, 1_000n * ONE);
    await ctx.setAllocation({ sigma: 3000 });
    await ctx.freeze(true);

    const { id } = await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    assert.ok((await ctx.escrow.call('positionOf', [id])).stake > 0n, 'anchoring is unaffected');

    await ctx.asset.send('mint', [ctx.escrow.address, 100n * ONE]);
    await ctx.escrow.send('sweep', [], { from: ACCOUNTS.mallory });
    assert.ok((await ctx.escrow.call('auctionShares')) > 0n, 'the premium share is still charged');
  });

  test('a released position carries its share of the interval it was present for', async () => {
    const ctx = await fixture();
    await ctx.setAllocation({ sigma: 3000 });
    const r = await readyToRelease(ctx, { units: 100n * ONE });

    await ctx.asset.send('mint', [ctx.escrow.address, 110n * ONE]);
    ctx.chain.advanceTime(4 * EPOCH);

    const res = await ctx.release(r.id, ACCOUNTS.bob, r.s);
    const [ev] = ctx.escrow.events(res, 'Released');
    assert.ok(ev.args.units > 100n * ONE, 'the leaver kept nothing of the interval');
  });

  test('a proof from another epoch does not release', async () => {
    const ctx = await fixture();
    const { id, s, leaf } = await readyToRelease(ctx, { units: 1n * ONE });
    ctx.chain.advanceTime(4 * EPOCH);
    await assert.rejects(
      ctx.escrow.send('release', [id, ACCOUNTS.bob, 1n, s.epoch + 1n, s.proof(leaf)]),
      /NoRootForEpoch|UnbondingNotServed/,
    );
  });

  test('receipts sealed in one multi-leaf root release with the relayer’s proofs', async () => {
    const ctx = await fixture();
    await ctx.anchorFor(ACCOUNTS.bob, 1_000n * ONE);
    const positions = [];
    for (let i = 0; i < 3; i += 1) {
      const { id } = await ctx.anchorFor(ACCOUNTS.alice, 10n * ONE);
      positions.push({ id, leaf: ctx.releaseLeaf(id, ACCOUNTS.bob) });
    }
    const s = await ctx.seal(positions.map((p) => p.leaf));
    ctx.chain.advanceTime(4 * EPOCH);
    for (const p of positions) await ctx.release(p.id, ACCOUNTS.bob, s, p.leaf);
    for (const p of positions) assert.equal((await ctx.escrow.call('positionOf', [p.id])).stake, 0n);
  });
});

describe('transit from the admission of the root, before the unbonding (I18; audit 2026-09-22, X7)', () => {
  /**
   * A rebasing book of 1,000 and 100 units, the release receipt of the second
   * sealed, and — where `mark` — presented as soon as its root is admitted.
   * Then a rebase of 10 per cent of what is pooled, and a sweep.
   */
  async function book({ mark }) {
    const ctx = await fixture({ rebasing: true });
    await ctx.setAllocation({ sigma: 3000 });
    await ctx.anchorFor(ACCOUNTS.bob, 1_000n * ONE);
    const { id } = await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    const leaf = ctx.releaseLeaf(id, ACCOUNTS.mallory);
    const s = await ctx.seal(leaf);
    let marked = null;
    if (mark) marked = await ctx.release(id, ACCOUNTS.mallory, s, leaf);
    const pooled = await ctx.asset.call('totalSupply');
    await ctx.asset.send('rebase', [pooled / 10n]);
    const swept = await ctx.escrow.send('sweep', [], { from: ACCOUNTS.mallory });
    return { ctx, id, s, leaf, marked, swept };
  }

  test('a receipt presented before its unbonding takes the position out of the priced book and consumes nothing', async () => {
    const { ctx, id, s, leaf, marked } = await book({ mark: true });
    const [ev] = ctx.escrow.events(marked, 'TransitMarked');
    assert.equal(ev.args.stakeAssetId, id);
    assert.equal(ev.args.sealedEpoch, s.epoch);
    assert.equal((await ctx.escrow.call('positionOf', [id])).claimNonceUsed, 0n, 'its next nonce is still the one presented');
    assert.equal(await ctx.escrow.call('transitShares', [id]), ev.args.shares);
    assert.equal((await ctx.escrow.call('positionOf', [id])).stake, 0n, 'out of the stake the pool is divided by');
    assert.equal(await ctx.escrow.call('isSpent', [ids.spendKey(s.epoch, leaf)]), false, 'the receipt is not spent');
    assert.equal(await ctx.escrow.call('queueTail'), 0n, 'no entry: nothing is owed before the unbonding');
    // The six pots still hold everything, the transit counted with the queue.
    assert.equal(await owed(ctx.escrow), await ctx.escrow.call('sharesHeld'));
    assert.equal(await ctx.escrow.call('queuedReleaseShares'), ev.args.shares);
  });

  test('a position in transit is charged no premium share, and keeps the whole of its own yield', async () => {
    const marked = await book({ mark: true });
    const unmarked = await book({ mark: false });
    const premium = (x) => x.ctx.escrow.events(x.swept, 'Swept')[0].args.premiumUnits;
    // Only the 1,000 units still in the book pay the premium on the rebase.
    assert.ok(premium(marked) < premium(unmarked));
    const diff = premium(marked) * 1100n - premium(unmarked) * 1000n;
    assert.ok(diff <= 1100n && diff >= -1100n, `the premium is the book's without the 100 in transit: ${premium(marked)} of ${premium(unmarked)}`);

    // Released after the unbonding: in transit it earned the rebase for its
    // own account, net of nothing; in the book it paid the four shares on it.
    const out = async (x) => {
      x.ctx.chain.advanceTime(4 * EPOCH);
      const res = await x.ctx.release(x.id, ACCOUNTS.mallory, x.s, x.leaf);
      return x.ctx.escrow.events(res, 'Released')[0].args.units;
    };
    const paidMarked = await out(marked);
    const paidUnmarked = await out(unmarked);
    assert.ok(paidMarked > paidUnmarked, `${paidMarked} > ${paidUnmarked}`);
    assert.ok(paidMarked >= 110n * ONE - 10n, `the transit kept its ten per cent: ${paidMarked}`);
  });

  test('a second early presentation moves nothing; a tampered or out-of-order one is refused', async () => {
    const { ctx, id, s, leaf } = await book({ mark: true });
    const shares = await ctx.escrow.call('transitShares', [id]);
    await assert.rejects(ctx.release(id, ACCOUNTS.mallory, s, leaf), /UnbondingNotServed/);
    await assert.rejects(ctx.escrow.send('release', [id, ACCOUNTS.bob, 1n, s.epoch, s.proof(leaf)]), /BadProof/);
    await assert.rejects(ctx.escrow.send('release', [id, ACCOUNTS.mallory, 2n, s.epoch, s.proof(leaf)]), /WrongClaimNonce/);
    assert.equal(await ctx.escrow.call('transitShares', [id]), shares);

    // Consumed once served: the count moves from transit to its entry.
    ctx.chain.advanceTime(4 * EPOCH);
    const res = await ctx.release(id, ACCOUNTS.mallory, s, leaf);
    assert.equal(ctx.escrow.events(res, 'ReleaseQueued')[0].args.shares, shares);
    assert.equal(await ctx.escrow.call('transitShares', [id]), 0n);
    assert.equal(await ctx.escrow.call('queuedReleaseShares'), 0n, 'paid out in full');
    await assert.rejects(ctx.release(id, ACCOUNTS.mallory, s, leaf), /UnknownPosition/);
  });

  test('a claim that rounds to no share is not marked, and is consumed whole when due', async () => {
    // A recovery share on the censorship ground drew the whole pool: the
    // position's stake stands, its claim is no share. Marked, it would read
    // as no position at all and its receipt could never close its transit on
    // QRL; it is refused early instead, as before X7.
    const ctx = await fixture();
    const { id } = await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    const leaf = ctx.releaseLeaf(id, ACCOUNTS.bob);
    const recovery = ids.shareLeaf({ chainId: CHAIN_ID, escrow: ctx.escrow.address, recoveryId: ZERO32, recipient: ZERO32, destination: ACCOUNTS.mallory, quantity: 100n * ONE });
    const s = await ctx.seal([leaf, recovery]);
    await ctx.escrow.send('releaseShare', [ZERO32, ZERO32, ZERO32, ACCOUNTS.mallory, 100n * ONE, s.epoch, s.proof(recovery)], { from: ACCOUNTS.mallory });
    assert.equal(await ctx.escrow.call('positionShares'), 0n, 'the pool is drained');
    assert.ok((await ctx.escrow.call('positionOf', [id])).stake > 0n);

    await assert.rejects(ctx.release(id, ACCOUNTS.bob, s, leaf), /UnbondingNotServed/);
    assert.ok((await ctx.escrow.call('positionOf', [id])).stake > 0n, 'not marked');
    // The share drains at the bound while the unbonding runs.
    for (let i = 0; i < 5; i += 1) {
      ctx.chain.advanceTime(EPOCH);
      await ctx.escrow.send('drainQueue', [8n], { from: ACCOUNTS.mallory });
    }
    const res = await ctx.release(id, ACCOUNTS.bob, s, leaf);
    const [released] = ctx.escrow.events(res, 'Released');
    assert.equal(released.args.units, 0n, 'released whole: its claim was nothing');
  });

  test('a position in transit at the declaration joins the recovered pool, and its receipt never pays', async () => {
    const { ctx, id, s, leaf } = await book({ mark: true });
    const shares = await ctx.escrow.call('transitShares', [id]);
    const pool = await ctx.escrow.call('positionShares');
    await ctx.declare();
    await ctx.escrow.send('drainQueue', [8n], { from: ACCOUNTS.mallory });
    ctx.chain.advanceTime(4 * EPOCH);
    await assert.rejects(ctx.release(id, ACCOUNTS.mallory, s, leaf), /ReleaseClosed/);
    // The queue was empty, so the drain did not run the reclaim; a recovery
    // share does, as every path that reads the pool after closure.
    const reserve = await ctx.escrow.call('psrShares');
    assert.equal(await ctx.escrow.call('queuedReleaseShares'), shares, 'not yet reclaimed');
    const recovery = ids.shareLeaf({ chainId: CHAIN_ID, escrow: ctx.escrow.address, successorId: ZERO32, recoveryId: ZERO32, recipient: ZERO32, destination: ACCOUNTS.bob, quantity: 1n });
    const r = await ctx.seal(recovery);
    await ctx.escrow.send('releaseShare', [ZERO32, ZERO32, ZERO32, ACCOUNTS.bob, 1n, r.epoch, r.proof(recovery)], { from: ACCOUNTS.mallory });
    assert.equal(await ctx.escrow.call('queuedReleaseShares'), 0n);
    assert.ok((await ctx.escrow.call('positionShares')) + 2n >= pool + shares + reserve, 'the transit is in the pool');
  });
});

describe('the release queue and the per-epoch bound', () => {
  /**
   * Two positions of `units` each, one released. The seeding deposit is in the
   * holding too, so the base is 2 * units + 10 and the bound a quarter of it.
   */
  async function halfBookRelease(ctx, units = 200n * ONE) {
    await ctx.anchorFor(ACCOUNTS.bob, units);
    const { id } = await ctx.anchorFor(ACCOUNTS.alice, units);
    const leaf = ctx.releaseLeaf(id, ACCOUNTS.alice);
    const s = await ctx.seal(leaf);
    ctx.chain.advanceTime(4 * EPOCH);
    return { id, s, leaf };
  }

  test('a quantity above the bound settles over later epochs and does not fail', async () => {
    // yellow paper §1.4: the receipt is consumed at once and the position leaves
    // over as many epochs as the bound needs, partially paid at the head.
    const ctx = await fixture();
    const { id, s, leaf } = await halfBookRelease(ctx);
    const start = await ctx.balance(ACCOUNTS.alice);

    await ctx.release(id, ACCOUNTS.alice, s, leaf);
    assert.equal(await ctx.escrow.call('isSpent', [ids.spendKey(s.epoch, leaf)]), true);
    assert.equal((await ctx.escrow.call('positionOf', [id])).stake, 0n, 'out of the book at once');
    // Holding 410 (two positions and the seeding deposit): a quarter is 102.5.
    assert.equal((await ctx.balance(ACCOUNTS.alice)) - start, 1025n * ONE / 10n);
    assert.equal(await ctx.escrow.call('queuedShares'), 975n * ONE / 10n);

    // Nothing more this epoch.
    await ctx.escrow.send('drainQueue', [10n]);
    assert.equal((await ctx.balance(ACCOUNTS.alice)) - start, 1025n * ONE / 10n);

    ctx.chain.advanceTime(EPOCH);
    const res = await ctx.escrow.send('drainQueue', [10n], { from: ACCOUNTS.mallory });
    assert.equal((await ctx.balance(ACCOUNTS.alice)) - start, 200n * ONE);
    const [ev] = ctx.escrow.events(res, 'Released');
    assert.equal(ev.args.units, 200n * ONE, 'the Released event carries the whole release');
    assert.equal(ev.args.releasedLeaf, ids.releasedLeaf(ctx.escrow.address, id, 1n));
    assert.equal(await ctx.escrow.call('queuedShares'), 0n);
  });

  test('the queue pays in order of submission, so a small release waits behind a large one', async () => {
    const ctx = await fixture();
    await ctx.anchorFor(ACCOUNTS.bob, 200n * ONE);
    const big = await ctx.anchorFor(ACCOUNTS.alice, 180n * ONE);
    const small = await ctx.anchorFor(ACCOUNTS.alice, 20n * ONE);
    const bigLeaf = ctx.releaseLeaf(big.id, ACCOUNTS.alice);
    const smallLeaf = ctx.releaseLeaf(small.id, ACCOUNTS.mallory);
    const s = await ctx.seal([bigLeaf, smallLeaf]);
    ctx.chain.advanceTime(4 * EPOCH);

    await ctx.release(big.id, ACCOUNTS.alice, s, bigLeaf);
    const malloryBefore = await ctx.balance(ACCOUNTS.mallory);
    await ctx.release(small.id, ACCOUNTS.mallory, s, smallLeaf);
    assert.equal(await ctx.balance(ACCOUNTS.mallory), malloryBefore, 'the small release jumped the queue');

    ctx.chain.advanceTime(EPOCH);
    await ctx.escrow.send('drainQueue', [10n]);
    assert.equal((await ctx.balance(ACCOUNTS.mallory)) - malloryBefore, 20n * ONE);
    assert.equal(await ctx.escrow.call('queueHead'), await ctx.escrow.call('queueTail'));
  });

  test('queued shares carry no premium and no staker share of later yield', async () => {
    // whitepaper §3.3 and I18: in transit the notional leaves the priced book.
    const ctx = await fixture();
    await ctx.setAllocation({ sigma: 3000 });
    const { id, s, leaf } = await halfBookRelease(ctx);
    await ctx.release(id, ACCOUNTS.alice, s, leaf);
    const queued = await ctx.escrow.call('queuedShares');
    assert.ok(queued > 0n);

    const bobPos = await ctx.escrow.call('positionShares');
    await ctx.asset.send('mint', [ctx.escrow.address, 40n * ONE]);
    await ctx.escrow.send('sweep', []);
    assert.equal(await ctx.escrow.call('queuedShares'), queued, 'the queue took a share of the yield');
    assert.ok((await ctx.escrow.call('positionShares')) > bobPos);
  });

  test('a rebase on queued shares stays with the leaver', async () => {
    // "Notional in transit still earns the origin yield for its own account."
    const ctx = await fixture({ rebasing: true });
    await ctx.setAllocation({ sigma: 3000 });
    const { id, s, leaf } = await halfBookRelease(ctx);
    const start = await ctx.balance(ACCOUNTS.alice);
    await ctx.release(id, ACCOUNTS.alice, s, leaf);
    const queued = await ctx.escrow.call('queuedShares');

    const rateBefore = await ctx.escrow.call('toUnits', [ONE]);
    await ctx.asset.send('rebase', [100n * ONE]);
    const rateAfter = await ctx.escrow.call('toUnits', [ONE]);
    const positions = await ctx.escrow.call('positionShares');
    const res = await ctx.escrow.send('sweep', []);
    const [ev] = ctx.escrow.events(res, 'Swept');
    assert.equal(
      ev.args.grossUnits,
      (positions * (rateAfter - rateBefore)) / ONE,
      'the sweep charged the queue for its own rebase',
    );

    for (let i = 0; i < 3; i += 1) {
      ctx.chain.advanceTime(EPOCH);
      await ctx.escrow.send('drainQueue', [10n]);
    }
    const received = (await ctx.balance(ACCOUNTS.alice)) - start;
    assert.ok(received > 200n * ONE, 'the leaver did not keep the rebase on its queued shares');
    assert.ok(received >= ((200n * ONE - queued) + (queued * rateAfter) / ONE) - 10n);
  });

  test('the drain pays no release under a freeze, and resumes when it lifts', async () => {
    const ctx = await fixture();
    const { id, s, leaf } = await halfBookRelease(ctx);
    await ctx.release(id, ACCOUNTS.alice, s, leaf);
    const partial = await ctx.balance(ACCOUNTS.alice);

    await ctx.freeze(true);
    ctx.chain.advanceTime(EPOCH);
    await ctx.escrow.send('drainQueue', [10n]);
    assert.equal(await ctx.balance(ACCOUNTS.alice), partial, 'the freeze let the book drain');

    await ctx.freeze(false);
    await ctx.escrow.send('drainQueue', [10n]);
    assert.ok((await ctx.balance(ACCOUNTS.alice)) > partial);
  });

  test('after the declaration a queued release is dropped and its shares join the recovered pool', async () => {
    // whitepaper §3.3: the release path closes permanently at the declaration,
    // and the escrow is realised afterwards only under §5.4. What the release
    // had not yet been paid is no longer owed to its recipient.
    const ctx = await fixture();
    const { id, s, leaf } = await halfBookRelease(ctx);
    await ctx.release(id, ACCOUNTS.alice, s, leaf);
    const partial = await ctx.balance(ACCOUNTS.alice);
    const queued = await ctx.escrow.call('queuedShares');
    const positions = await ctx.escrow.call('positionShares');

    await ctx.declare();
    ctx.chain.advanceTime(EPOCH);
    const res = await ctx.escrow.send('drainQueue', [10n]);
    assert.equal(await ctx.balance(ACCOUNTS.alice), partial, 'a release paid after the declaration');
    assert.equal(ctx.escrow.events(res, 'ReleaseDropped').length, 1);
    assert.equal(ctx.escrow.events(res, 'ReleasesReclaimed')[0].args.shares, queued);
    assert.equal(await ctx.escrow.call('queuedShares'), 0n);
    assert.equal(await ctx.escrow.call('queuedReleaseShares'), 0n);
    assert.equal(await ctx.escrow.call('positionShares'), positions + queued);
    assert.equal(await ctx.escrow.call('queueHead'), await ctx.escrow.call('queueTail'));
    assert.equal(await owed(ctx.escrow), await ctx.escrow.call('sharesHeld'));
  });

  test('the bound is taken on the whole holding when the queue opens', async () => {
    // yellow paper §1.4: releaseBoundBps of queueBase, the escrow's holding of
    // the asset — positions, buffer, pot and queue together.
    // The first release is larger than one epoch's bound, so the queue stays
    // open when the second arrives.
    const ctx = await fixture();
    await ctx.anchorFor(ACCOUNTS.bob, 200n * ONE);
    const a = await ctx.anchorFor(ACCOUNTS.alice, 150n * ONE);
    const b = await ctx.anchorFor(ACCOUNTS.alice, 50n * ONE);
    const la = ctx.releaseLeaf(a.id, ACCOUNTS.alice);
    const lb = ctx.releaseLeaf(b.id, ACCOUNTS.alice);
    const s = await ctx.seal([la, lb]);
    ctx.chain.advanceTime(4 * EPOCH);

    const start = await ctx.balance(ACCOUNTS.alice);
    const res = await ctx.release(a.id, ACCOUNTS.alice, s, la);
    const [open] = ctx.escrow.events(res, 'QueueOpened');
    assert.equal(open.args.queueBase, 410n * ONE);
    assert.equal(open.args.boundShares, 1025n * ONE / 10n);
    const res2 = await ctx.release(b.id, ACCOUNTS.alice, s, lb);
    assert.equal(ctx.escrow.events(res2, 'QueueOpened').length, 0, 'an open queue read its base again');
    assert.equal((await ctx.balance(ACCOUNTS.alice)) - start, 1025n * ONE / 10n);
  });

  test('a queue of the whole book clears in exactly ceil(BPS / 2500) = 4 draining epochs', async () => {
    // whitepaper §3.3 and invariant I25. Under a base re-read on what remains,
    // the bound shrinks every epoch it pays and the queue approaches empty
    // geometrically without reaching it: the earlier rule here paid 100, 75,
    // 56.25 and 42.19 and left 126.56 of the 400 outstanding after four.
    //
    // The first release is larger than one epoch's bound, so the queue holds
    // the whole book at once rather than emptying and reopening between two
    // releases — which would be two queues, each with its own base.
    const ctx = await fixture();
    const positions = [];
    for (const units of [150n, 100n, 100n, 50n]) {
      const { id } = await ctx.anchorFor(ACCOUNTS.alice, units * ONE);
      positions.push({ id, leaf: ctx.releaseLeaf(id, ACCOUNTS.bob) });
    }
    const s = await ctx.seal(positions.map((p) => p.leaf));
    ctx.chain.advanceTime(4 * EPOCH);

    const start = await ctx.balance(ACCOUNTS.bob);
    for (const p of positions) await ctx.release(p.id, ACCOUNTS.bob, s, p.leaf);
    assert.equal(await ctx.escrow.call('positionShares'), 0n, 'the whole book is in the queue');
    const base = await ctx.escrow.call('queueBase');
    assert.equal(base, 410n * ONE);

    const perEpoch = 1025n * ONE / 10n;
    const paid = async () => (await ctx.balance(ACCOUNTS.bob)) - start;
    assert.equal(await paid(), perEpoch, 'draining epoch 1');
    for (let epoch = 2n; epoch <= 3n; epoch += 1n) {
      ctx.chain.advanceTime(EPOCH);
      await ctx.escrow.send('drainQueue', [10n]);
      assert.equal(await paid(), perEpoch * epoch, `draining epoch ${epoch}`);
      assert.equal(await ctx.escrow.call('queueBase'), base, 'the base moved while the queue was open');
      assert.notEqual(await ctx.escrow.call('queueHead'), await ctx.escrow.call('queueTail'));
    }
    ctx.chain.advanceTime(EPOCH);
    await ctx.escrow.send('drainQueue', [10n]);
    assert.equal(await paid(), 400n * ONE, 'draining epoch 4 clears the book');
    assert.equal(await ctx.escrow.call('queueHead'), await ctx.escrow.call('queueTail'));
    assert.equal(await ctx.escrow.call('queuedShares'), 0n);
  });

  test('a queue that empties and reopens inside one epoch keeps the larger base, so the epoch pays its whole bound', async () => {
    // Invariant I25, found by the fuzzer's release wave: re-read on the
    // smaller holding while the epoch's count persisted, a wave arriving as
    // releases that each fit the bound shrank the epoch's bound with every
    // release it paid in full, and a whole book took five draining epochs. The
    // base a queue reopens on inside the epoch that already opened one is the
    // larger of that epoch's base and the holding now, and the epoch count is
    // kept, so the epoch pays exactly the bound of its first base.
    const ctx = await fixture();
    await ctx.anchorFor(ACCOUNTS.bob, 200n * ONE);
    const a = await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    const b = await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    const la = ctx.releaseLeaf(a.id, ACCOUNTS.alice);
    const lb = ctx.releaseLeaf(b.id, ACCOUNTS.alice);
    const s = await ctx.seal([la, lb]);
    ctx.chain.advanceTime(4 * EPOCH);

    const start = await ctx.balance(ACCOUNTS.alice);
    await ctx.release(a.id, ACCOUNTS.alice, s, la);
    assert.equal(await ctx.escrow.call('queueBase'), 0n, 'the first release left in full');
    const res = await ctx.release(b.id, ACCOUNTS.alice, s, lb);
    // The holding is now 310; the epoch's first base was 410.
    assert.equal(ctx.escrow.events(res, 'QueueOpened')[0].args.queueBase, 410n * ONE);
    assert.equal(
      (await ctx.balance(ACCOUNTS.alice)) - start,
      1025n * ONE / 10n,
      'the epoch paid other than the bound of its first base',
    );

    // In the next epoch a queue that opens reads the holding afresh.
    ctx.chain.advanceTime(EPOCH);
    await ctx.escrow.send('drainQueue', [10n]);
    assert.equal(await ctx.escrow.call('queueHead'), await ctx.escrow.call('queueTail'));
    const c = await ctx.anchorFor(ACCOUNTS.mallory, 10n * ONE);
    const lc = ctx.releaseLeaf(c.id, ACCOUNTS.mallory);
    const s2 = await ctx.seal(lc);
    ctx.chain.advanceTime(4 * EPOCH);
    const res2 = await ctx.release(c.id, ACCOUNTS.mallory, s2, lc);
    assert.equal(ctx.escrow.events(res2, 'QueueOpened')[0].args.queueBase, 220n * ONE);
  });

  test('the base is read again only after the queue empties', async () => {
    const ctx = await fixture();
    const { id, s, leaf } = await halfBookRelease(ctx);
    await ctx.release(id, ACCOUNTS.alice, s, leaf);
    assert.equal(await ctx.escrow.call('queueBase'), 410n * ONE);

    ctx.chain.advanceTime(EPOCH);
    await ctx.escrow.send('drainQueue', [10n]);
    assert.equal(await ctx.escrow.call('queueHead'), await ctx.escrow.call('queueTail'));
    assert.equal(await ctx.escrow.call('queueBase'), 0n, 'an empty queue kept its old base');

    // The next payment opens the queue on the holding as it now stands: 310.
    const { id: id2 } = await ctx.anchorFor(ACCOUNTS.mallory, 100n * ONE);
    const leaf2 = ctx.releaseLeaf(id2, ACCOUNTS.mallory);
    const s2 = await ctx.seal(leaf2);
    ctx.chain.advanceTime(4 * EPOCH);
    const res = await ctx.release(id2, ACCOUNTS.mallory, s2, leaf2);
    const [open] = ctx.escrow.events(res, 'QueueOpened');
    assert.equal(open.args.queueBase, 310n * ONE);
    assert.equal(await ctx.escrow.call('queueBase'), 310n * ONE);
  });

  test('the per-epoch count resets with the epoch and the base does not', async () => {
    const ctx = await fixture();
    const { id, s, leaf } = await halfBookRelease(ctx);
    await ctx.release(id, ACCOUNTS.alice, s, leaf);
    assert.equal(await ctx.escrow.call('releaseBudgetRemaining'), 0n);
    ctx.chain.advanceTime(EPOCH);
    assert.equal(await ctx.escrow.call('releaseBudgetRemaining'), 1025n * ONE / 10n);
  });

  test('D8: at the first drain of a later epoch the base ratchets up to the holding, and never down', async (t) => {
    // whitepaper §3.3, the model's ratchetedQueueBase: a release that arrives
    // after deposits have grown the holding drains on the larger base rather
    // than on the one the queue happened to open with. Taken on the opening
    // base alone, this queue would still owe 95 after its second epoch.
    const ctx = await fixture();
    await ctx.anchorFor(ACCOUNTS.bob, 100n * ONE);
    const { id } = await ctx.anchorFor(ACCOUNTS.alice, 300n * ONE);
    const leaf = ctx.releaseLeaf(id, ACCOUNTS.alice);
    const s = await ctx.seal(leaf);
    ctx.chain.advanceTime(4 * EPOCH);
    const start = await ctx.balance(ACCOUNTS.alice);
    await ctx.release(id, ACCOUNTS.alice, s, leaf);
    assert.equal(await ctx.escrow.call('queueBase'), 410n * ONE);
    assert.equal((await ctx.balance(ACCOUNTS.alice)) - start, 1025n * ONE / 10n);

    ctx.chain.advanceTime(EPOCH);
    await ctx.anchorFor(ACCOUNTS.mallory, 800n * ONE);
    // 307.5 still held plus 800 arrived: the view states what the first drain will take.
    const holding = 11075n * ONE / 10n;
    assert.equal(await ctx.escrow.call('releaseBudgetRemaining'), holding / 4n);
    const M = await loadModel();
    if (M) assert.equal(M.ark.ratchetedQueueBase(410n * ONE, holding), holding);
    else t.diagnostic(MISSING);
    await ctx.escrow.send('drainQueue', [10n]);
    assert.equal((await ctx.balance(ACCOUNTS.alice)) - start, 300n * ONE, 'the queue drained on the ratcheted base');

    // Never lowered while open: a smaller holding at a later first drain keeps the base.
    if (M) assert.equal(M.ark.ratchetedQueueBase(holding, 100n * ONE), holding);
  });

  test('D8: a release held by the freeze is passed over by a cursor, so a loss behind more held releases than one drain visits is still reached', async () => {
    // The freeze holds release instructions and nothing else. Before the
    // cursor, every drain re-walked the held releases from the head, so with
    // more of them than a call visits a determined loss behind them was never
    // reached. Now each held release is read once per freeze.
    const ctx = await fixture();
    await ctx.escrow.send('seed', [40n * ONE], { from: ACCOUNTS.admin });
    const big = await ctx.anchorFor(ACCOUNTS.bob, 400n * ONE);
    const small = [];
    for (let i = 0; i < 9; i += 1) small.push(await ctx.anchorFor(ACCOUNTS.alice, 10n * ONE));
    const leaves = [ctx.releaseLeaf(big.id, ACCOUNTS.bob), ...small.map((p) => ctx.releaseLeaf(p.id, ACCOUNTS.alice))];
    const s = await ctx.seal(leaves);
    ctx.chain.advanceTime(4 * EPOCH);
    // The large release takes the whole bound; the nine small ones queue behind it.
    await ctx.release(big.id, ACCOUNTS.bob, s, leaves[0]);
    for (let i = 0; i < 9; i += 1) await ctx.release(small[i].id, ACCOUNTS.alice, s, leaves[i + 1]);
    assert.equal(await ctx.escrow.call('queueTail'), 10n);

    await ctx.freeze(true);
    const quantity = 5n * ONE;
    const lLeaf = ids.lossLeaf({ chainId: CHAIN_ID, escrow: ctx.escrow.address, determinationId: DETERMINATION, stakeAssetId: big.id, destination: LOSS_DEST, quantity });
    const ls = await ctx.seal(lLeaf);
    // Its own drain visits eight entries: the held large release and seven small ones.
    await ctx.escrow.send('settleLoss', [DETERMINATION, big.id, LOSS_DEST, quantity, ls.epoch, ls.proof(lLeaf)]);
    assert.equal(await ctx.balance(LOSS_DEST), 0n);
    // Two more held releases, from where the last walk stopped rather than from the head.
    await ctx.escrow.send('drainQueue', [2n]);
    assert.equal(await ctx.balance(LOSS_DEST), 0n);
    await ctx.escrow.send('drainQueue', [1n]);
    assert.equal(await ctx.balance(LOSS_DEST), quantity, 'the loss behind the held releases was reached');
    assert.equal(await ctx.escrow.call('queueHead'), 0n, 'the held release keeps its place');

    // The freeze lifts: the walk starts at the head again and the releases pay in order.
    await ctx.freeze(false);
    const bob = await ctx.balance(ACCOUNTS.bob);
    await ctx.escrow.send('drainQueue', [20n]);
    assert.ok((await ctx.balance(ACCOUNTS.bob)) > bob, 'the head release paid first once the freeze lifted');
  });
});

/* ------------------------------------------------------------------ */

const DETERMINATION = keccak256(toUtf8Bytes('determination:1'));
const LOSS_DEST = '0x' + 'd1'.repeat(20);

describe('the loss settlement, the third return message', () => {
  /** A book, a loss leaf for one position, and the arguments that carry it. */
  async function withLoss(ctx, { quantity = 5n * ONE, destination = LOSS_DEST, extraSeed = 0n } = {}) {
    if (extraSeed > 0n) await ctx.escrow.send('seed', [extraSeed], { from: ACCOUNTS.admin });
    const { id } = await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    const leaf = ids.lossLeaf({
      chainId: CHAIN_ID,
      escrow: ctx.escrow.address,
      determinationId: DETERMINATION,
      stakeAssetId: id,
      destination,
      quantity,
    });
    const s = await ctx.seal(leaf);
    const args = [DETERMINATION, id, destination, quantity, s.epoch, s.proof(leaf)];
    return { id, leaf, s, args, quantity };
  }

  test('a loss settlement pays the buffer to the named destination, carried by anyone', async () => {
    // whitepaper §5.2: the buffer is spent first, in the origin asset.
    const ctx = await fixture();
    const { args, quantity } = await withLoss(ctx);
    const buffer = await ctx.escrow.call('bufferShares');
    const positions = await ctx.escrow.call('positionShares');

    const res = await ctx.escrow.send('settleLoss', args, { from: ACCOUNTS.mallory });
    assert.equal(await ctx.balance(LOSS_DEST), quantity);
    assert.equal(await ctx.escrow.call('bufferShares'), buffer - quantity);
    assert.equal(await ctx.escrow.call('positionShares'), positions, 'a loss drew on principal');
    assert.equal(ctx.escrow.events(res, 'EntrySettled')[0].args.units, quantity);
    assert.equal(await owed(ctx.escrow), await ctx.escrow.call('sharesHeld'));
  });

  test('D17: a loss above the buffer pays the whole buffer, and the rest waits as an outstanding claim on no position', async () => {
    // Whitepaper §5.2, yellow paper §1.4 settleLoss (2026-09-28): a buffer
    // short of the part determined pays all it holds and records the rest as
    // an outstanding loss claim; nothing is drawn from a position's principal,
    // so a forged loss still moves at most first-loss capital.
    const ctx = await fixture();
    const { args } = await withLoss(ctx, { quantity: SEED_MINIMUM + ONE });
    const positions = await ctx.escrow.call('positionShares');
    await ctx.escrow.send('settleLoss', args);
    assert.equal(await ctx.balance(LOSS_DEST), SEED_MINIMUM, 'the whole buffer is paid');
    assert.equal(await ctx.escrow.call('bufferShares'), 0n);
    assert.equal(await ctx.escrow.call('lossOwedUnits'), ONE, 'the rest is an outstanding claim');
    assert.equal(await ctx.escrow.call('positionShares'), positions, 'a loss drew on principal');
    assert.equal(await owed(ctx.escrow), await ctx.escrow.call('sharesHeld'));
  });

  test('D17: the next buffer inflow discharges the outstanding claim first, in the order determined', async (t) => {
    // The model's bufferLossSettlement and applyBufferInflow (ark-staking.ts):
    // what the buffer cannot meet stays owed, and later inflow pays the claims
    // in determination order before any of it is the buffer's.
    const ctx = await fixture();
    const first = await withLoss(ctx, { quantity: SEED_MINIMUM + 3n * ONE });
    await ctx.escrow.send('settleLoss', first.args);
    // A second determination, behind the first.
    const second = keccak256(toUtf8Bytes('determination:2'));
    const lLeaf = ids.lossLeaf({ chainId: CHAIN_ID, escrow: ctx.escrow.address, determinationId: second, stakeAssetId: first.id, destination: ACCOUNTS.bob, quantity: 2n * ONE });
    const s = await ctx.seal(lLeaf);
    await ctx.escrow.send('settleLoss', [second, first.id, ACCOUNTS.bob, 2n * ONE, s.epoch, s.proof(lLeaf)]);
    assert.equal(await ctx.escrow.call('lossOwedUnits'), 5n * ONE);

    // Yield: the buffer share of a sweep is inflow. 4 units of buffer arrive.
    const bufferBps = (await ctx.escrow.call('recordedAllocation')).bufferBps;
    const M = await loadModel();
    if (M) {
      const { paid, outstanding } = M.ark.bufferLossSettlement(SEED_MINIMUM + 3n * ONE, SEED_MINIMUM);
      assert.equal(paid, SEED_MINIMUM);
      assert.equal(outstanding, 3n * ONE);
    }
    const gross = (4n * ONE * 10_000n) / BigInt(bufferBps || 250);
    await ctx.asset.send('mint', [ctx.escrow.address, gross]);
    await ctx.escrow.send('sweep');
    const inflow = await ctx.escrow.call('bufferShares');
    ctx.chain.advanceTime(EPOCH);
    await ctx.escrow.send('drainQueue', [10n]);
    if (M) {
      const r = M.ark.applyBufferInflow(inflow, [3n * ONE, 2n * ONE]);
      assert.equal((await ctx.balance(LOSS_DEST)) - SEED_MINIMUM, r.paidToClaims[0], 'the first claim first');
      assert.equal(await ctx.balance(ACCOUNTS.bob) >= r.paidToClaims[1], true);
      assert.equal(await ctx.escrow.call('lossOwedUnits'), r.remainingClaims[0] + r.remainingClaims[1]);
      assert.equal(await ctx.escrow.call('bufferShares'), r.toBuffer, 'only what the claims leave is the buffer\'s');
    } else {
      t.diagnostic('model absent: the order is checked, not the figures');
      assert.equal((await ctx.balance(LOSS_DEST)) - SEED_MINIMUM, 3n * ONE);
    }
    assert.equal(await owed(ctx.escrow), await ctx.escrow.call('sharesHeld'));
  });

  test('D17: an outstanding claim waiting on an empty buffer does not hold the releases behind it', async () => {
    const ctx = await fixture();
    const { id } = await ctx.anchorFor(ACCOUNTS.bob, 50n * ONE);
    const loss = await withLoss(ctx, { quantity: SEED_MINIMUM + ONE });
    await ctx.escrow.send('settleLoss', loss.args);
    const rLeaf = ctx.releaseLeaf(id, ACCOUNTS.bob);
    const rs = await ctx.seal(rLeaf);
    ctx.chain.advanceTime(4 * EPOCH);
    const before = await ctx.balance(ACCOUNTS.bob);
    await ctx.release(id, ACCOUNTS.bob, rs, rLeaf);
    assert.ok((await ctx.balance(ACCOUNTS.bob)) > before, 'the release behind the claim was paid');
    assert.equal(await ctx.escrow.call('lossOwedUnits'), ONE, 'the claim still waits for inflow');
  });

  test('D13: a loss is owed units fixed at the determination; a negative rebase while it waits reduces nothing', async () => {
    // yellow paper §1.4 settleLoss: "quantity is in units ... fixed at the
    // determination and converted to shares at the rate of the payment, so a
    // negative rebase in between does not reduce it". Holding 200, bound 50.
    const ctx = await fixture({ rebasing: true });
    const { args } = await withLoss(ctx, { quantity: 80n * ONE, extraSeed: 90n * ONE });
    await ctx.escrow.send('settleLoss', args);
    const firstPaid = await ctx.balance(LOSS_DEST);
    assert.ok(firstPaid < 80n * ONE, 'the bound left part of it waiting');
    await ctx.asset.send('rebase', [-20n * ONE]);
    ctx.chain.advanceTime(EPOCH);
    // The destination's own balance rebased too; what reaches it now is the rest in units.
    const before = await ctx.balance(LOSS_DEST);
    const res = await ctx.escrow.send('drainQueue', [10n]);
    // Within the rebasing token's own transfer rounding (a wei or two).
    const got = (await ctx.balance(LOSS_DEST)) - before;
    assert.ok(80n * ONE - firstPaid - got <= 2n, `paid in full units after the rebase: ${got}`);
    assert.equal(ctx.escrow.events(res, 'EntrySettled')[0].args.units, 80n * ONE);
    assert.equal(await ctx.escrow.call('lossOwedUnits'), 0n);
  });

  test('D13: a positive rebase while it waits pays no more than the units determined', async () => {
    const ctx = await fixture({ rebasing: true });
    const { args } = await withLoss(ctx, { quantity: 80n * ONE, extraSeed: 90n * ONE });
    await ctx.escrow.send('settleLoss', args);
    const firstPaid = await ctx.balance(LOSS_DEST);
    await ctx.asset.send('rebase', [60n * ONE]);
    ctx.chain.advanceTime(EPOCH);
    const before = await ctx.balance(LOSS_DEST);
    const res = await ctx.escrow.send('drainQueue', [10n]);
    const got = (await ctx.balance(LOSS_DEST)) - before;
    assert.ok(got <= 80n * ONE - firstPaid && 80n * ONE - firstPaid - got <= 2n, `the rest in units, not in appreciated shares: ${got}`);
    assert.equal(ctx.escrow.events(res, 'EntrySettled')[0].args.units, 80n * ONE);
    // The shares the units did not need stay in the buffer; what is not in a
    // pot is the transfer's rounding, excess the next sweep divides.
    const held = await ctx.escrow.call('sharesHeld');
    const pots = await owed(ctx.escrow);
    assert.ok(held >= pots && held - pots <= 2n, `pots ${pots}, held ${held}`);
  });

  test('a substituted destination or a restated quantity has no proof', async () => {
    const ctx = await fixture();
    const { args } = await withLoss(ctx);
    await assert.rejects(
      ctx.escrow.send('settleLoss', [args[0], args[1], ACCOUNTS.mallory, ...args.slice(3)]),
      /BadProof/,
    );
    await assert.rejects(
      ctx.escrow.send('settleLoss', [args[0], args[1], args[2], args[3] + 1n, args[4], args[5]]),
      /BadProof/,
    );
    await assert.rejects(
      ctx.escrow.send('settleLoss', [keccak256(toUtf8Bytes('other')), ...args.slice(1)]),
      /BadProof/,
    );
  });

  test('a loss settlement is consumed once, and sealed again in a later root does not pay twice', async () => {
    // Keyed by the leaf, which names the determination: keyed by the carrying
    // root the same settlement carried in two roots would be two spend keys.
    const ctx = await fixture();
    const { leaf, args, quantity } = await withLoss(ctx);
    await ctx.escrow.send('settleLoss', args);
    assert.equal(await ctx.escrow.call('isSpent', [leaf]), true);
    await assert.rejects(ctx.escrow.send('settleLoss', args), /ProofSpent/);

    const again = await ctx.seal(leaf);
    await assert.rejects(
      ctx.escrow.send('settleLoss', [...args.slice(0, 4), again.epoch, again.proof(leaf)]),
      /ProofSpent/,
    );
    assert.equal(await ctx.balance(LOSS_DEST), quantity);
  });

  test('D10: a loss leaf binds the escrow that pays it, and verifies at no other escrow on the relay', async () => {
    // R25, closed by the binding. One relay serves every escrow on the chain,
    // and each escrow keeps its own spent map, so a leaf that named no escrow
    // paid one determination once per escrow, each time out of that escrow's
    // buffer. The leaf now binds the escrow (yellow paper §2.2 lossLeafKey):
    // at any other escrow it is a leaf no root carries.
    const ctx = await fixture();
    const otherAsset = await ctx.chain.deploy('MockAsset');
    const other = await ctx.chain.deploy(
      'ArkStakeEscrowUnits',
      ['address', 'address', 'address', 'uint256', 'uint256', 'uint256'],
      [otherAsset.address, ctx.relay.address, OPS_DEST, SEED_MINIMUM, 20, AUDIT_RATE],
    );
    await otherAsset.send('mint', [ACCOUNTS.admin, 100n * ONE]);
    await otherAsset.send('approve', [other.address, 100n * ONE], { from: ACCOUNTS.admin });
    await other.send('seed', [100n * ONE], { from: ACCOUNTS.admin });

    const { args, quantity } = await withLoss(ctx);
    await assert.rejects(other.send('settleLoss', args, { from: ACCOUNTS.mallory }), /BadProof/);
    assert.equal(await otherAsset.call('balanceOf', [LOSS_DEST]), 0n, 'a second escrow paid the same determination');
    assert.equal(await other.call('bufferShares'), 100n * ONE);

    await ctx.escrow.send('settleLoss', args);
    assert.equal(await ctx.balance(LOSS_DEST), quantity);
  });

  test('a loss naming a position that was anchored and has since left still pays', async () => {
    // A determination may follow the release; what the escrow checks is that
    // the position was ever anchored here, not that it is still here.
    const ctx = await fixture();
    await ctx.anchorFor(ACCOUNTS.bob, 200n * ONE);
    const { id } = await ctx.anchorFor(ACCOUNTS.alice, 10n * ONE);
    const rel = ctx.releaseLeaf(id, ACCOUNTS.alice);
    const quantity = 2n * ONE;
    const lLeaf = ids.lossLeaf({ chainId: CHAIN_ID, escrow: ctx.escrow.address, determinationId: DETERMINATION, stakeAssetId: id, destination: LOSS_DEST, quantity });
    const s = await ctx.seal([rel, lLeaf]);
    ctx.chain.advanceTime(4 * EPOCH);
    await ctx.release(id, ACCOUNTS.alice, s, rel);
    assert.equal((await ctx.escrow.call('positionOf', [id])).stake, 0n);
    await ctx.escrow.send('settleLoss', [DETERMINATION, id, LOSS_DEST, quantity, s.epoch, s.proof(lLeaf)]);
    assert.equal(await ctx.balance(LOSS_DEST), quantity);
  });

  test('a loss settlement pays through a freeze, since the freeze holds releases only', async () => {
    const ctx = await fixture();
    const { args, quantity } = await withLoss(ctx);
    await ctx.freeze(true);
    await ctx.escrow.send('settleLoss', args);
    assert.equal(await ctx.balance(LOSS_DEST), quantity);
  });

  test('a determined loss is not reduced by the declaration: it is consumed and paid after closure', async () => {
    // whitepaper §4.7: a settlement already determined is not reduced.
    const ctx = await fixture();
    const { args, quantity } = await withLoss(ctx);
    await ctx.declare();
    await ctx.escrow.send('settleLoss', args);
    assert.equal(await ctx.balance(LOSS_DEST), quantity);
  });

  test('a loss above the bound settles in the exit queue over later epochs', async () => {
    // yellow paper §1.4: "Settles in the exit queue of the asset under the
    // per-epoch bound". Buffer 100, positions 100: holding 200, bound 50.
    const ctx = await fixture();
    const { args } = await withLoss(ctx, { quantity: 80n * ONE, extraSeed: 90n * ONE });
    await ctx.escrow.send('settleLoss', args);
    assert.equal(await ctx.balance(LOSS_DEST), 50n * ONE);
    // Owed in units and drawn from the buffer at payment (D13): the queue holds
    // no shares of it, the buffer still does.
    assert.equal(await ctx.escrow.call('lossOwedUnits'), 30n * ONE);
    assert.equal(await ctx.escrow.call('queuedShares'), 0n);

    ctx.chain.advanceTime(EPOCH);
    const res = await ctx.escrow.send('drainQueue', [10n]);
    assert.equal(await ctx.balance(LOSS_DEST), 80n * ONE);
    assert.equal(ctx.escrow.events(res, 'EntrySettled')[0].args.units, 80n * ONE);
  });

  test('a loss behind a frozen release is paid, and the release keeps its place', async () => {
    // The freeze holds release instructions and nothing else, so it must not
    // hold a determined settlement queued behind one. The release is still
    // paid first once the freeze lifts: the head does not pass it.
    const ctx = await fixture();
    await ctx.escrow.send('seed', [40n * ONE], { from: ACCOUNTS.admin });
    await ctx.anchorFor(ACCOUNTS.bob, 200n * ONE);
    const { id } = await ctx.anchorFor(ACCOUNTS.alice, 200n * ONE);
    const rLeaf = ctx.releaseLeaf(id, ACCOUNTS.alice);
    const rs = await ctx.seal(rLeaf);
    ctx.chain.advanceTime(4 * EPOCH);
    const start = await ctx.balance(ACCOUNTS.alice);
    await ctx.release(id, ACCOUNTS.alice, rs, rLeaf);
    // Holding 450: bound 112.5, and the release is the head with 87.5 owed.
    assert.equal((await ctx.balance(ACCOUNTS.alice)) - start, 1125n * ONE / 10n);

    await ctx.freeze(true);
    const quantity = 20n * ONE;
    const lLeaf = ids.lossLeaf({ chainId: CHAIN_ID, escrow: ctx.escrow.address, determinationId: DETERMINATION, stakeAssetId: id, destination: LOSS_DEST, quantity });
    const ls = await ctx.seal(lLeaf); // a fresh epoch, so a fresh bound
    await ctx.escrow.send('settleLoss', [DETERMINATION, id, LOSS_DEST, quantity, ls.epoch, ls.proof(lLeaf)]);
    assert.equal(await ctx.balance(LOSS_DEST), quantity, 'the freeze held a loss settlement');
    assert.equal((await ctx.balance(ACCOUNTS.alice)) - start, 1125n * ONE / 10n, 'the freeze let a release pay');
    assert.equal(await ctx.escrow.call('queueHead'), 0n, 'the head passed the frozen release');

    await ctx.freeze(false);
    await ctx.escrow.send('drainQueue', [10n]);
    assert.equal((await ctx.balance(ACCOUNTS.alice)) - start, 200n * ONE);
    assert.equal(await ctx.escrow.call('queueHead'), await ctx.escrow.call('queueTail'));
    assert.equal(await owed(ctx.escrow), await ctx.escrow.call('sharesHeld'));
  });

  test('on a rebasing asset the buffer is debited at least what the settlement pays', async () => {
    const ctx = await fixture({ rebasing: true });
    await ctx.asset.send('rebase', [3n]);
    const { args, quantity } = await withLoss(ctx, { quantity: 3n * ONE + 1n });
    const buffer = await ctx.escrow.call('bufferShares');
    await ctx.escrow.send('settleLoss', args);
    const paid = await ctx.balance(LOSS_DEST);
    const debited = buffer - (await ctx.escrow.call('bufferShares'));
    assert.ok(paid + 2n >= quantity, 'the settlement lost more than rounding');
    assert.ok((await ctx.escrow.call('toUnits', [debited])) >= paid, 'the buffer paid out more than it was debited');
  });
});

/* ------------------------------------------------------------------ */

const RECOVERY = keccak256(toUtf8Bytes('recovery:1'));
const HOLDER = keccak256(toUtf8Bytes('holder:senior-1'));
const SHARE_DEST = '0x' + 'a7'.repeat(20);

describe('the recovery share, the fourth return message', () => {
  /** A leaf for one recipient's share, sealed, and the arguments that carry it. */
  async function shareFor(ctx, quantity, { recipient = HOLDER, destination = SHARE_DEST, recoveryId = RECOVERY, successorId = ZERO32 } = {}) {
    const leaf = ids.shareLeaf({ chainId: CHAIN_ID, escrow: ctx.escrow.address, successorId, recoveryId, recipient, destination, quantity });
    const s = await ctx.seal(leaf);
    return { leaf, s, args: [successorId, recoveryId, recipient, destination, quantity, s.epoch, s.proof(leaf)] };
  }

  test('after the declaration a recovery share pays the named destination out of the recovered pool', async () => {
    // whitepaper §5.4: the escrow is realised afterwards only under §5.4.
    const ctx = await fixture();
    await ctx.anchorFor(ACCOUNTS.bob, 200n * ONE);
    await ctx.declare();
    const { args } = await shareFor(ctx, 50n * ONE);
    const res = await ctx.escrow.send('releaseShare', args, { from: ACCOUNTS.mallory });
    assert.equal(await ctx.balance(SHARE_DEST), 50n * ONE);
    assert.equal(await ctx.escrow.call('positionShares'), 150n * ONE);
    assert.equal(await ctx.escrow.call('bufferShares'), SEED_MINIMUM, 'a recovery drew on the buffer');
    const [queued] = ctx.escrow.events(res, 'ShareQueued');
    assert.equal(queued.args.recipient, HOLDER);
    assert.equal(await owed(ctx.escrow), await ctx.escrow.call('sharesHeld'));
  });

  test('a recovery share is bounded by the holding outside the buffer', async () => {
    // yellow paper §1.4: quantity exceeds the holding outside bufferBalance.
    // The escrow holds 210; the pool is 200.
    const ctx = await fixture();
    await ctx.anchorFor(ACCOUNTS.bob, 200n * ONE);
    await ctx.declare();
    const { args } = await shareFor(ctx, 200n * ONE + 1n);
    await assert.rejects(ctx.escrow.send('releaseShare', args), /ShareExceedsHolding/);
    assert.equal(await ctx.balance(SHARE_DEST), 0n);
  });

  test('a recovery share cannot draw on a release still payable in the queue', async () => {
    // On the censorship ground the relay is not closed and a queued release
    // is still owed to its recipient: a share drawn on it would pay one
    // claimant out of another's settlement.
    const ctx = await fixture();
    await ctx.anchorFor(ACCOUNTS.bob, 200n * ONE);
    const { id } = await ctx.anchorFor(ACCOUNTS.alice, 200n * ONE);
    const leaf = ctx.releaseLeaf(id, ACCOUNTS.alice);
    const s = await ctx.seal(leaf);
    ctx.chain.advanceTime(4 * EPOCH);
    await ctx.release(id, ACCOUNTS.alice, s, leaf);
    assert.ok((await ctx.escrow.call('queuedShares')) > 0n);

    const { args } = await shareFor(ctx, 200n * ONE + 1n);
    await assert.rejects(ctx.escrow.send('releaseShare', args), /ShareExceedsHolding/);
  });

  test('the recovered pool is the positions, the stranded releases and the pot, and a dropped release never blocks the share behind it', async () => {
    const ctx = await fixture();
    await ctx.setAllocation({ sigma: 3000 });
    await ctx.anchorFor(ACCOUNTS.bob, 200n * ONE);
    const { id } = await ctx.anchorFor(ACCOUNTS.alice, 200n * ONE);
    const leaf = ctx.releaseLeaf(id, ACCOUNTS.alice);
    const s = await ctx.seal(leaf);
    await ctx.asset.send('mint', [ctx.escrow.address, 40n * ONE]);
    await ctx.escrow.send('sweep', []);
    ctx.chain.advanceTime(4 * EPOCH);
    await ctx.release(id, ACCOUNTS.alice, s, leaf);
    await ctx.declare();

    const stranded = await ctx.escrow.call('queuedShares');
    const pool =
      (await ctx.escrow.call('positionShares')) + (await ctx.escrow.call('auctionShares')) + stranded;
    assert.ok((await ctx.escrow.call('auctionShares')) > 0n, 'no pot to test with');

    const { args } = await shareFor(ctx, pool);
    const res = await ctx.escrow.send('releaseShare', args);
    assert.equal(ctx.escrow.events(res, 'ReleaseDropped').length, 1, 'the stranded release was not dropped');
    assert.ok((await ctx.balance(SHARE_DEST)) > 0n, 'the dropped release blocked the share behind it');
    assert.equal(await ctx.escrow.call('positionShares'), 0n);
    assert.equal(await ctx.escrow.call('auctionShares'), 0n);
    assert.ok((await ctx.escrow.call('bufferShares')) >= SEED_MINIMUM, 'the buffer was drawn on');
    assert.equal(await owed(ctx.escrow), await ctx.escrow.call('sharesHeld'));
  });

  test('a recovery completes in ceil(BPS / 2500) = 4 epochs with no unbonding', async () => {
    // yellow paper §4.3, Pace: the per-epoch bound taken on the escrow as it
    // stands at the opening, and no unbonding period.
    const ctx = await fixture();
    await ctx.anchorFor(ACCOUNTS.bob, 400n * ONE);
    await ctx.declare();
    const first = await shareFor(ctx, 200n * ONE, { destination: SHARE_DEST });
    const second = await shareFor(ctx, 200n * ONE, { recipient: keccak256(toUtf8Bytes('holder:2')), destination: LOSS_DEST });
    await ctx.escrow.send('releaseShare', first.args);
    await ctx.escrow.send('releaseShare', second.args);
    const paid = async () => (await ctx.balance(SHARE_DEST)) + (await ctx.balance(LOSS_DEST));
    // Holding 410: the bound is 102.5 an epoch, from the epoch the queue opened.
    assert.equal(await paid(), 1025n * ONE / 10n);
    for (let epoch = 2n; epoch <= 4n; epoch += 1n) {
      ctx.chain.advanceTime(EPOCH);
      await ctx.escrow.send('drainQueue', [10n]);
    }
    assert.equal(await paid(), 400n * ONE);
    assert.equal(await ctx.escrow.call('queueHead'), await ctx.escrow.call('queueTail'));
  });

  test('a recovery share pays on the censorship ground, where the relay was never closed', async () => {
    // whitepaper §5.4: after a determination on the censorship ground the
    // escrow is unimpaired and only the resumption of admission is required.
    const ctx = await fixture();
    await ctx.anchorFor(ACCOUNTS.bob, 200n * ONE);
    assert.equal(await ctx.relay.call('isClosed', [ctx.escrow.address]), false);
    const { args } = await shareFor(ctx, 50n * ONE);
    await ctx.escrow.send('releaseShare', args);
    assert.equal(await ctx.balance(SHARE_DEST), 50n * ONE);
  });

  test('after a recovery took every position share on the censorship ground, anchoring is refused by name', async () => {
    // The stakes remain and the shares behind them are gone. A new anchor's
    // stake divides by the shares left, so on an empty pool it is unbounded
    // and on a nearly empty one it overflowed the stored uint128 and was
    // truncated without a word — a position recorded at a fraction of what it
    // paid.
    const ctx = await fixture();
    await ctx.anchorFor(ACCOUNTS.bob, 200n * ONE);
    const { args } = await shareFor(ctx, 200n * ONE);
    await ctx.escrow.send('releaseShare', args);
    assert.equal(await ctx.escrow.call('positionShares'), 0n);
    assert.ok((await ctx.escrow.call('totalStake')) > 0n);
    await assert.rejects(
      ctx.escrow.send('anchor', [QRL_OWNER, 10n * ONE], { from: ACCOUNTS.alice }),
      /PositionsDrained/,
    );
  });

  test('a stake too large to record is refused rather than truncated', async () => {
    const ctx = await fixture();
    await ctx.anchorFor(ACCOUNTS.bob, 200n * ONE);
    const { args } = await shareFor(ctx, 200n * ONE - 1n);
    await ctx.escrow.send('releaseShare', args);
    assert.equal(await ctx.escrow.call('positionShares'), 1n);
    await assert.rejects(
      ctx.escrow.send('anchor', [QRL_OWNER, 1_000n * ONE], { from: ACCOUNTS.alice }),
      /StakeOverflow/,
    );
  });

  test('D10: a recovery share binds the escrow that pays it, and verifies at no other escrow on the relay', async () => {
    // R25, closed by the binding. The shareLeaf preimage of yellow paper §2.2
    // carries the escrow since 2026-09-28; before, one leaf was payable at
    // every escrow on the relay, each out of its own recovered pool.
    const ctx = await fixture();
    await ctx.anchorFor(ACCOUNTS.bob, 200n * ONE);
    const otherAsset = await ctx.chain.deploy('MockAsset');
    const other = await ctx.chain.deploy(
      'ArkStakeEscrowUnits',
      ['address', 'address', 'address', 'uint256', 'uint256', 'uint256'],
      [otherAsset.address, ctx.relay.address, OPS_DEST, SEED_MINIMUM, 20, AUDIT_RATE],
    );
    await otherAsset.send('mint', [ACCOUNTS.admin, 300n * ONE]);
    await otherAsset.send('approve', [other.address, 300n * ONE], { from: ACCOUNTS.admin });
    await other.send('seed', [SEED_MINIMUM], { from: ACCOUNTS.admin });
    await other.send('anchor', [QRL_OWNER, 200n * ONE], { from: ACCOUNTS.admin });

    const { args } = await shareFor(ctx, 10n * ONE);
    await assert.rejects(other.send('releaseShare', args), /BadProof/);
    await ctx.escrow.send('releaseShare', args);
    assert.equal(await ctx.balance(SHARE_DEST), 10n * ONE);
    assert.equal(await otherAsset.call('balanceOf', [SHARE_DEST]), 0n);
  });

  test('I36: a share binds the successor state it is paid on, so it is spent once and on one fork', async () => {
    // whitepaper §5.4: QRL divides one monotone residual across up to three
    // admitted successors in admission order and seals each fork's shares for
    // that fork. The same share presented under another successor is a leaf
    // no root carries; each fork's own leaf is its own spend.
    const ctx = await fixture();
    await ctx.anchorFor(ACCOUNTS.bob, 200n * ONE);
    await ctx.declare();
    const forkA = keccak256(toUtf8Bytes('successor:A'));
    const forkB = keccak256(toUtf8Bytes('successor:B'));
    const a = await shareFor(ctx, 10n * ONE, { successorId: forkA });
    await assert.rejects(ctx.escrow.send('releaseShare', [forkB, ...a.args.slice(1)]), /BadProof/);
    await assert.rejects(ctx.escrow.send('releaseShare', [ZERO32, ...a.args.slice(1)]), /BadProof/);
    await ctx.escrow.send('releaseShare', a.args);
    await assert.rejects(ctx.escrow.send('releaseShare', a.args), /ProofSpent/);
    const b = await shareFor(ctx, 10n * ONE, { successorId: forkB });
    assert.notEqual(b.leaf, a.leaf);
    await ctx.escrow.send('releaseShare', b.args);
    assert.equal(await ctx.balance(SHARE_DEST), 20n * ONE);
  });

  test('a recovery share is consumed once, and sealed again in a later root does not pay twice', async () => {
    const ctx = await fixture();
    await ctx.anchorFor(ACCOUNTS.bob, 200n * ONE);
    await ctx.declare();
    const { leaf, args } = await shareFor(ctx, 10n * ONE);
    await ctx.escrow.send('releaseShare', args);
    await assert.rejects(ctx.escrow.send('releaseShare', args), /ProofSpent/);
    const again = await ctx.seal(leaf);
    await assert.rejects(
      ctx.escrow.send('releaseShare', [...args.slice(0, 5), again.epoch, again.proof(leaf)]),
      /ProofSpent/,
    );
    assert.equal(await ctx.balance(SHARE_DEST), 10n * ONE);
  });

  test('a substituted destination, recipient or quantity has no proof', async () => {
    const ctx = await fixture();
    await ctx.anchorFor(ACCOUNTS.bob, 200n * ONE);
    await ctx.declare();
    const { args } = await shareFor(ctx, 10n * ONE);
    await assert.rejects(
      ctx.escrow.send('releaseShare', [args[0], args[1], args[2], ACCOUNTS.mallory, ...args.slice(4)]),
      /BadProof/,
    );
    await assert.rejects(
      ctx.escrow.send('releaseShare', [args[0], args[1], keccak256(toUtf8Bytes('someone')), ...args.slice(3)]),
      /BadProof/,
    );
    await assert.rejects(
      ctx.escrow.send('releaseShare', [args[0], args[1], args[2], args[3], args[4] + 1n, args[5], args[6]]),
      /BadProof/,
    );
  });

  test('a loss leaf does not verify as a recovery share over the same words', async () => {
    // The two preimages have one shape, so their domains are all that
    // separates a buffer payment from a draw on the recovered pool.
    const ctx = await fixture();
    await ctx.anchorFor(ACCOUNTS.bob, 200n * ONE);
    const lossLeaf = ids.lossLeaf({ chainId: CHAIN_ID, escrow: ctx.escrow.address, determinationId: RECOVERY, stakeAssetId: HOLDER, destination: SHARE_DEST, quantity: ONE });
    const s = await ctx.seal(lossLeaf);
    await assert.rejects(
      ctx.escrow.send('releaseShare', [ZERO32, RECOVERY, HOLDER, SHARE_DEST, ONE, s.epoch, s.proof(lossLeaf)]),
      /BadProof/,
    );
  });
});

describe('the on-chain audit round of 2026-10-03 (Leg A)', () => {
  /** A loss leaf of `quantity` to `destination`, sealed and carried. */
  async function settle(ctx, tag, stakeAssetId, destination, quantity) {
    const determinationId = keccak256(toUtf8Bytes(tag));
    const leaf = ids.lossLeaf({ chainId: CHAIN_ID, escrow: ctx.escrow.address, determinationId, stakeAssetId, destination, quantity });
    const s = await ctx.seal(leaf);
    return ctx.escrow.send('settleLoss', [determinationId, stakeAssetId, destination, quantity, s.epoch, s.proof(leaf)]);
  }

  test('OC-LEGA-04: recording an allocation settles first, so the yield before it is divided at the rates it accrued under', async () => {
    const ctx = await fixture();
    await ctx.setAllocation({ sigma: 0 });
    await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    // Yield accrued under a premium share of zero, and no sweep ordered before the next allocation.
    await ctx.asset.send('mint', [ctx.escrow.address, 10n * ONE]);
    const { res } = await ctx.setAllocation({ sigma: 3000 });
    const [swept] = ctx.escrow.events(res, 'Swept');
    assert.ok(swept, 'the recording settled');
    assert.equal(swept.args.grossUnits, 10n * ONE);
    assert.equal(swept.args.premiumUnits, 0n, 'divided at the allocation in force when it accrued');
    assert.equal(await ctx.escrow.call('auctionShares'), 0n);
    assert.equal(ctx.escrow.events(res, 'AllocationRecorded').length, 1);
    // The next interval is divided at the new rates.
    await ctx.asset.send('mint', [ctx.escrow.address, 10n * ONE]);
    await ctx.escrow.send('sweep', []);
    assert.equal(await ctx.escrow.call('auctionShares'), 3n * ONE);
    assert.equal(await owed(ctx.escrow), await ctx.escrow.call('sharesHeld'));
  });

  test('OL-06: under a freeze the buffer\'s inflow pays an older outstanding loss claim before a newer loss', async () => {
    // The PoC of the 2026-09-29 round (R3-06), re-proven on 2026-10-03: the
    // D8 cursor stepped past the held claim and the newer loss was paid first.
    const ctx = await fixture();
    const { id } = await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    await settle(ctx, 'L1', id, LOSS_DEST, SEED_MINIMUM + 3n * ONE); // the buffer paid whole, 3 outstanding
    assert.equal(await ctx.escrow.call('lossOwedUnits'), 3n * ONE);
    await ctx.freeze(true);
    await ctx.asset.send('mint', [ctx.escrow.address, 160n * ONE]); // 4 units of buffer at 250 bps
    await ctx.escrow.send('sweep', []);
    const bobBefore = await ctx.balance(ACCOUNTS.bob);
    await settle(ctx, 'L2', id, ACCOUNTS.bob, 2n * ONE);
    for (let i = 0; i < 2; i += 1) {
      ctx.chain.advanceTime(EPOCH);
      await ctx.escrow.send('drainQueue', [50n]);
    }
    assert.equal(await ctx.balance(LOSS_DEST), SEED_MINIMUM + 3n * ONE, 'the older claim is paid whole first');
    assert.equal((await ctx.balance(ACCOUNTS.bob)) - bobBefore, ONE, 'the newer loss takes only what the older one left');
    assert.equal(await ctx.escrow.call('lossOwedUnits'), ONE);
    assert.equal(await ctx.escrow.call('bufferShares'), 0n);
    assert.equal(await owed(ctx.escrow), await ctx.escrow.call('sharesHeld'));
  });

  test('OL-06: the cursor still steps over frozen releases, and stops at the first outstanding loss claim', async () => {
    const ctx = await fixture();
    const a = await ctx.anchorFor(ACCOUNTS.alice, 200n * ONE);
    await ctx.anchorFor(ACCOUNTS.bob, 200n * ONE);
    const leaf = ctx.releaseLeaf(a.id, ACCOUNTS.alice);
    const s = await ctx.seal(leaf);
    ctx.chain.advanceTime(4 * EPOCH);
    await ctx.release(a.id, ACCOUNTS.alice, s, leaf); // a quarter paid, the rest queued
    const paid = await ctx.balance(ACCOUNTS.alice);
    await ctx.freeze(true);
    ctx.chain.advanceTime(EPOCH);
    await settle(ctx, 'L1', a.id, LOSS_DEST, SEED_MINIMUM + ONE);
    // The frozen release at the head, then the claim the buffer left owed.
    assert.equal(await ctx.balance(LOSS_DEST), SEED_MINIMUM);
    assert.equal(await ctx.escrow.call('lossOwedUnits'), ONE);
    await ctx.asset.send('mint', [ctx.escrow.address, 80n * ONE]); // 2 units of buffer
    await ctx.escrow.send('sweep', []);
    await ctx.escrow.send('drainQueue', [50n]);
    assert.equal(await ctx.balance(LOSS_DEST), SEED_MINIMUM + ONE, 'the claim behind the frozen release is paid');
    assert.equal(await ctx.escrow.call('lossOwedUnits'), 0n);
    assert.equal(await ctx.balance(ACCOUNTS.alice), paid, 'the frozen release is not');
  });

  test('OC-LEGA-05: a queue holding only loss claims the buffer cannot pay releases its base, and reopens on the holding', async () => {
    const ctx = await fixture();
    const alice = await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    const bob = await ctx.anchorFor(ACCOUNTS.bob, 300n * ONE);
    const aLeaf = ctx.releaseLeaf(alice.id, ACCOUNTS.alice);
    const bLeaf = ctx.releaseLeaf(bob.id, ACCOUNTS.bob);
    // An outstanding loss claim: the buffer (the seed, 10) paid, 5 owed.
    await settle(ctx, 'L1', alice.id, LOSS_DEST, SEED_MINIMUM + 5n * ONE);
    assert.equal(await ctx.escrow.call('lossOwedUnits'), 5n * ONE);
    assert.notEqual(await ctx.escrow.call('queueHead'), await ctx.escrow.call('queueTail'), 'the claim keeps its place');
    assert.equal(await ctx.escrow.call('queueBase'), 0n, 'nothing in the queue can be paid: its base is released');

    const s = await ctx.seal([aLeaf, bLeaf]);
    ctx.chain.advanceTime(4 * EPOCH);
    // A release wave behind the claim reopens the queue on the holding then.
    const held = await ctx.escrow.call('sharesHeld');
    assert.equal(held, 400n * ONE);
    const bobBefore = await ctx.balance(ACCOUNTS.bob);
    const res = await ctx.release(bob.id, ACCOUNTS.bob, s, bLeaf);
    const [open] = ctx.escrow.events(res, 'QueueOpened');
    assert.ok(open, 'the release reopened the queue');
    assert.equal(open.args.queueBase, held);
    assert.equal(await ctx.escrow.call('queueBase'), held, 'fixed while the release is owed');
    assert.equal((await ctx.balance(ACCOUNTS.bob)) - bobBefore, 100n * ONE, 'a quarter of the holding');
    for (let i = 0; i < 2; i += 1) {
      ctx.chain.advanceTime(EPOCH);
      await ctx.escrow.send('drainQueue', [10n]);
      if (i === 0) assert.equal(await ctx.escrow.call('queueBase'), held, 'the base does not move while a release is owed');
    }
    assert.equal((await ctx.balance(ACCOUNTS.bob)) - bobBefore, 300n * ONE);
    // The wave paid: only the claim is left, and the base is released again.
    assert.equal(await ctx.escrow.call('queueBase'), 0n);
    assert.equal(await ctx.escrow.call('lossOwedUnits'), 5n * ONE);

    // The next release is bounded on the holding that remains (100), not on the 400 the queue once held.
    ctx.chain.advanceTime(EPOCH);
    const remaining = await ctx.escrow.call('sharesHeld');
    assert.equal(remaining, 100n * ONE);
    assert.equal(await ctx.escrow.call('releaseBudgetRemaining'), (remaining * 2_500n) / BPS);
    const aliceBefore = await ctx.balance(ACCOUNTS.alice);
    const res2 = await ctx.release(alice.id, ACCOUNTS.alice, s, aLeaf);
    assert.equal(ctx.escrow.events(res2, 'QueueOpened')[0].args.queueBase, remaining);
    assert.equal((await ctx.balance(ACCOUNTS.alice)) - aliceBefore, (remaining * 2_500n) / BPS);
    assert.equal(await owed(ctx.escrow), await ctx.escrow.call('sharesHeld'));
  });

  test('OC-LEGA-05: the buffer\'s next inflow reopens a released queue at the drain, inside the epoch', async () => {
    const ctx = await fixture();
    const { id } = await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    await settle(ctx, 'L1', id, LOSS_DEST, SEED_MINIMUM + 3n * ONE);
    assert.equal(await ctx.escrow.call('queueBase'), 0n);
    // Inflow in the same epoch: the drain reads the base again rather than paying under a bound of one share.
    await ctx.asset.send('mint', [ctx.escrow.address, 160n * ONE]);
    await ctx.escrow.send('sweep', []);
    const res = await ctx.escrow.send('drainQueue', [10n]);
    assert.equal(ctx.escrow.events(res, 'QueueOpened').length, 1);
    assert.equal(await ctx.balance(LOSS_DEST), SEED_MINIMUM + 3n * ONE, 'the claim is paid from the inflow at once');
    assert.equal(await ctx.escrow.call('lossOwedUnits'), 0n);
    assert.equal(await ctx.escrow.call('queueHead'), await ctx.escrow.call('queueTail'));
    assert.equal(await ctx.escrow.call('queueBase'), 0n);
  });

  test('OC-LEGA-05: under a freeze a frozen release ahead of the claim keeps the base it opened on', async () => {
    const ctx = await fixture();
    const a = await ctx.anchorFor(ACCOUNTS.alice, 200n * ONE);
    await ctx.anchorFor(ACCOUNTS.bob, 200n * ONE);
    const leaf = ctx.releaseLeaf(a.id, ACCOUNTS.alice);
    const s = await ctx.seal(leaf);
    ctx.chain.advanceTime(4 * EPOCH);
    await ctx.release(a.id, ACCOUNTS.alice, s, leaf);
    assert.equal(await ctx.escrow.call('queueBase'), 410n * ONE);
    await ctx.freeze(true);
    ctx.chain.advanceTime(EPOCH);
    await settle(ctx, 'L1', a.id, LOSS_DEST, SEED_MINIMUM + ONE);
    assert.equal(await ctx.escrow.call('lossOwedUnits'), ONE);
    assert.equal(await ctx.escrow.call('queueBase'), 410n * ONE, 'the release it opened for is still owed');
  });
});
