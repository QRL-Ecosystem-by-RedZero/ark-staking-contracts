/**
 * ArkStakeEscrow: a payment the asset refuses.
 *
 * The rule these tests defend: **no payee can stop anyone else being paid.**
 * The queue pays in order of submission (whitepaper §3.3), so a payment that
 * reverts at the head is a payment that reverts for every entry behind it, in
 * every epoch, and — for a loss settlement, which is never dropped — for ever.
 * A payee the asset refuses is an ordinary case, not an exotic one: stETH
 * refuses a transfer to its own contract, a blocklist is written by an outside
 * party after the payee was committed on QRL, and several tokens refuse a
 * transfer of zero.
 *
 * So a refused payment is credited to its payee, held in shares like the queue
 * it left, and paid by `withdrawOwed(payee)`, which anyone may call and which
 * pays nobody but that payee. The same holds for the operations destination at
 * the sweep, where a refusal would otherwise stop every anchor and release,
 * since both settle first.
 *
 * The doubles are strict on purpose: `MockStrictRebasingAsset` is Lido at the
 * edges (refuses its own address, truncates a wei or two per transfer, does
 * not start at one unit per share), `MockStrictAsset` has a blocklist, and
 * `MockNoReturnAsset` returns nothing from `transfer`, as USDT does.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { keccak256, toUtf8Bytes } = require('ethers');

const { ACCOUNTS } = require('../../../test/harness');
const { originChain, relayFixture, CHAIN_ID, EPOCH: EPOCH_N } = require('./helpers');

const ids = require('../../relayer/lib/identifiers');

const EPOCH = Number(EPOCH_N);
const ONE = 10n ** 18n;
const OPS_DEST = '0x' + 'ef'.repeat(20);
const QRL_OWNER = '0x' + '66'.repeat(20);
const LOSS_DEST = '0x' + 'd1'.repeat(20);
const SEED_MINIMUM = 10n * ONE;
/** The escrow's AUDIT_YIELD_RATE (EC-08): 2.20% a year as one epoch's yield per unit, 1e18 fixed point. */
const AUDIT_RATE = 421917808219179n;

/**
 * A book on one of the strict assets. `opsIsToken` names the asset's own
 * address as the operations destination — the one immutable payee the escrow
 * has, and one the asset refuses.
 */
async function book({ kind = 'strictRebasing', opsIsToken = false } = {}) {
  const chain = await originChain();
  const r = await relayFixture(chain, { treeHeight: 5 });
  const contract = {
    strictRebasing: 'MockStrictRebasingAsset',
    strict: 'MockStrictAsset',
    noReturn: 'MockNoReturnAsset',
  }[kind];
  const asset = await chain.deploy(contract);
  const ops = opsIsToken ? asset.address : OPS_DEST;
  const escrow =
    kind === 'strictRebasing'
      ? await chain.deploy(
          'ArkStakeEscrowShares',
          ['address', 'address', 'address', 'address', 'uint256', 'uint256', 'uint256'],
          [asset.address, asset.address, r.relay.address, ops, SEED_MINIMUM, 20, AUDIT_RATE],
        )
      : await chain.deploy(
          'ArkStakeEscrowUnits',
          ['address', 'address', 'address', 'uint256', 'uint256', 'uint256'],
          [asset.address, r.relay.address, ops, SEED_MINIMUM, 20, AUDIT_RATE],
        );

  for (const who of [ACCOUNTS.admin, ACCOUNTS.alice, ACCOUNTS.bob, ACCOUNTS.mallory]) {
    await asset.send('mint', [who, 1_000n * ONE]);
    await asset.send('approve', [escrow.address, 10_000n * ONE], { from: who });
  }
  // stETH credits a transfer a wei or two short, and the seeding deposit is
  // counted in what arrived, so exactly SEED_MINIMUM would not open anchoring.
  await escrow.send('seed', [SEED_MINIMUM + 2n], { from: ACCOUNTS.admin });

  const anchorFor = async (who, units) => {
    const res = await escrow.send('anchor', [QRL_OWNER, units], { from: who });
    return escrow.events(res, 'Anchored')[0].args.stakeAssetId;
  };
  const releaseLeaf = (id, recipient) =>
    ids.releaseLeaf(escrow.address, ids.releasePayload({ id, recipient, claimNonce: 1n, chainId: CHAIN_ID }));
  const release = (id, recipient, s) =>
    escrow.send('release', [id, recipient, 1n, s.epoch, s.proof(releaseLeaf(id, recipient))], {
      from: ACCOUNTS.mallory,
    });
  const balance = (who) => asset.call('balanceOf', [who]);
  const drainEpochs = async (n) => {
    for (let i = 0; i < n; i += 1) {
      chain.advanceTime(EPOCH);
      await escrow.send('drainQueue', [32n], { from: ACCOUNTS.bob });
    }
  };
  return { chain, ...r, asset, escrow, anchorFor, releaseLeaf, release, balance, drainEpochs, ops };
}

/** The five pots together: every share the escrow holds is one of these or excess. */
async function owed(escrow) {
  let sum = 0n;
  for (const f of ['positionShares', 'bufferShares', 'auctionShares', 'queuedShares', 'unclaimedShares']) {
    sum += await escrow.call(f);
  }
  return sum;
}

describe('a payee the asset refuses stops nobody else being paid', () => {
  test('a release to the stETH contract itself does not block the queue behind it, and a loss behind it is paid', async () => {
    // The PoC of the finding: stETH reverts TRANSFER_TO_STETH_CONTRACT, and a
    // release naming the stETH address reaches the head of the queue. Before
    // the fix every drain from then on reverted, and every release, loss
    // settlement and recovery share with it, because each drains on its way
    // out.
    const ctx = await book();
    const big = await ctx.anchorFor(ACCOUNTS.bob, 300n * ONE);
    const stuck = await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    const later = await ctx.anchorFor(ACCOUNTS.mallory, 50n * ONE);
    const lossLeaf = ids.lossLeaf({
      chainId: CHAIN_ID,
      escrow: ctx.escrow.address,
      determinationId: keccak256(toUtf8Bytes('det:1')),
      stakeAssetId: later,
      destination: LOSS_DEST,
      quantity: 5n * ONE,
    });
    const s = await ctx.seal([
      ctx.releaseLeaf(big, ACCOUNTS.bob),
      ctx.releaseLeaf(stuck, ctx.asset.address),
      ctx.releaseLeaf(later, ACCOUNTS.mallory),
      lossLeaf,
    ]);
    ctx.chain.advanceTime(4 * EPOCH);

    // The first release exhausts the epoch's bound, so the next two queue
    // behind it unpaid and reach the head in a later epoch.
    await ctx.release(big, ACCOUNTS.bob, s);
    await ctx.release(stuck, ctx.asset.address, s);
    const malloryBefore = await ctx.balance(ACCOUNTS.mallory);
    await ctx.release(later, ACCOUNTS.mallory, s);
    await ctx.escrow.send('settleLoss', [
      keccak256(toUtf8Bytes('det:1')), later, LOSS_DEST, 5n * ONE, s.epoch, s.proof(lossLeaf),
    ]);

    await ctx.drainEpochs(5);
    assert.equal(await ctx.escrow.call('queueHead'), await ctx.escrow.call('queueTail'), 'the queue never emptied');
    assert.ok((await ctx.balance(ACCOUNTS.mallory)) - malloryBefore >= 50n * ONE - 10n, 'the release behind was not paid');
    assert.ok((await ctx.balance(LOSS_DEST)) >= 5n * ONE - 10n, 'the loss behind was not paid');

    // The refused payment is credited, in shares, and kept out of the sweep.
    const credited = await ctx.escrow.call('owedShares', [ctx.asset.address]);
    assert.ok(credited > 0n, 'the refused release was not credited');
    assert.equal(await ctx.escrow.call('unclaimedShares'), credited);
    assert.ok((await ctx.escrow.call('sharesHeld')) >= (await owed(ctx.escrow)));

    // It can never be paid, and saying so reverts by name and blocks nothing.
    await assert.rejects(ctx.escrow.send('withdrawOwed', [ctx.asset.address]), /PaymentRefused/);
    await ctx.asset.send('rebase', [7n * ONE]);
    await assert.doesNotReject(ctx.escrow.send('sweep', []));
    assert.equal(await ctx.escrow.call('owedShares', [ctx.asset.address]), credited, 'the sweep took a credit as yield');
  });

  test('a blocklisted payee is credited, and paid by anyone once the block lifts, to itself only', async () => {
    const ctx = await book({ kind: 'strict' });
    const big = await ctx.anchorFor(ACCOUNTS.bob, 300n * ONE);
    const small = await ctx.anchorFor(ACCOUNTS.alice, 40n * ONE);
    const s = await ctx.seal([ctx.releaseLeaf(big, ACCOUNTS.bob), ctx.releaseLeaf(small, ACCOUNTS.alice)]);
    ctx.chain.advanceTime(4 * EPOCH);

    await ctx.asset.send('setBlocked', [ACCOUNTS.bob, true]);
    const res = await ctx.release(big, ACCOUNTS.bob, s);
    const [deferred] = ctx.escrow.events(res, 'PaymentDeferred');
    assert.equal(deferred.args.recipient.toLowerCase(), ACCOUNTS.bob);
    const aliceBefore = await ctx.balance(ACCOUNTS.alice);
    await ctx.release(small, ACCOUNTS.alice, s);
    await ctx.drainEpochs(3);
    assert.equal((await ctx.balance(ACCOUNTS.alice)) - aliceBefore, 40n * ONE, 'the payee behind was held');

    const bobOwed = await ctx.escrow.call('owedShares', [ACCOUNTS.bob]);
    assert.equal(bobOwed, 300n * ONE, 'the whole release is owed to its payee');
    await assert.rejects(
      ctx.escrow.send('withdrawOwed', [ACCOUNTS.bob], { from: ACCOUNTS.mallory }),
      /PaymentRefused/,
    );

    await ctx.asset.send('setBlocked', [ACCOUNTS.bob, false]);
    const bobBefore = await ctx.balance(ACCOUNTS.bob);
    const malloryBefore = await ctx.balance(ACCOUNTS.mallory);
    await ctx.escrow.send('withdrawOwed', [ACCOUNTS.bob], { from: ACCOUNTS.mallory });
    assert.equal((await ctx.balance(ACCOUNTS.bob)) - bobBefore, 300n * ONE);
    assert.equal(await ctx.balance(ACCOUNTS.mallory), malloryBefore, 'the caller was paid');
    assert.equal(await ctx.escrow.call('unclaimedShares'), 0n);
    await assert.rejects(ctx.escrow.send('withdrawOwed', [ACCOUNTS.bob]), /NothingOwed/);
    assert.equal(await ctx.escrow.call('sharesHeld'), await owed(ctx.escrow));
  });

  test('an operations destination the asset refuses does not stop the sweep, the anchor or the release', async () => {
    // OPERATIONS_DESTINATION is immutable. If its payment reverted, every
    // path that settles first — anchor, release, releaseShare, sweep — would
    // revert with it, for ever.
    const ctx = await book({ kind: 'strict', opsIsToken: true });
    const id = await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    await ctx.asset.send('mint', [ctx.escrow.address, 20n * ONE]);
    await ctx.escrow.send('sweep', [], { from: ACCOUNTS.mallory });

    // 250 bps of 20 is 0.5, the operations share, less no juror fraction.
    assert.equal(await ctx.escrow.call('owedShares', [ctx.asset.address]), ONE / 2n);
    assert.equal(await ctx.escrow.call('sharesHeld'), await owed(ctx.escrow));

    await ctx.asset.send('mint', [ctx.escrow.address, 20n * ONE]);
    await ctx.anchorFor(ACCOUNTS.bob, 10n * ONE);
    const s = await ctx.seal(ctx.releaseLeaf(id, ACCOUNTS.alice));
    ctx.chain.advanceTime(4 * EPOCH);
    await ctx.asset.send('mint', [ctx.escrow.address, 20n * ONE]);
    await ctx.release(id, ACCOUNTS.alice, s);
    assert.equal(await ctx.escrow.call('owedShares', [ctx.asset.address]), 3n * ONE / 2n);
  });

  test('a premium lot claimed to a recipient the asset refuses is consumed and credited, and paid once unblocked', async () => {
    // The solver paid on QRL; the quantity is theirs whether or not the asset
    // carries it today. A revert would leave the lot claimable only until its
    // expiry and then dead, taking what the solver paid for.
    const ctx = await book({ kind: 'strict' });
    const e = await ctx.freshEpoch();
    const a = { sigmaBps: 3000, bufferBps: 250, operationsBps: 250, jurorFeeShareBps: 0, levyBps: 0, sigmaTargetBps: 0, coveredBps: 10000, psrCapBps: 0, commitTermEpochs: 0 };
    const alloc = ids.allocationLeaf({ escrow: ctx.escrow.address, epoch: e, ...a });
    const sa = await ctx.seal(alloc);
    await ctx.escrow.send('recordEpochAllocation', [sa.epoch, ids.ALLOCATION_FIELDS.map((f) => a[f]), sa.proof(alloc)]);
    await ctx.anchorFor(ACCOUNTS.alice, 100n * ONE);
    await ctx.asset.send('mint', [ctx.escrow.address, 10n * ONE]);
    await ctx.escrow.send('sweep', []);
    assert.equal(await ctx.escrow.call('auctionShares'), 3n * ONE);

    const dest = '0x' + 'b2'.repeat(20);
    const secret = '0x' + '5e'.repeat(32);
    const lock = { lotId: '0x' + '10'.repeat(32), hashlock: ids.hashlockOf(secret), recipient: dest, shares: 2n * ONE, evmExpiry: BigInt(ctx.chain.timestamp) + 3n * 7n * 86400n, epoch: e - 2n, bond: ONE / 10n };
    const leaf = ids.premiumLockLeaf({ chainId: CHAIN_ID, escrow: ctx.escrow.address, asset: ctx.asset.address, ...lock });
    const s = await ctx.seal(leaf);
    await ctx.asset.send('setBlocked', [dest, true]);
    await ctx.escrow.send('claimPremium', [[lock.lotId, lock.hashlock, dest, lock.shares, lock.evmExpiry, lock.epoch, lock.bond], s.epoch, s.proof(leaf), secret]);
    assert.equal(await ctx.escrow.call('isSpent', [leaf]), true);
    assert.equal(await ctx.escrow.call('owedShares', [dest]), lock.shares);
    assert.equal(await ctx.escrow.call('auctionShares'), ONE);
    assert.equal(await ctx.escrow.call('sharesHeld'), await owed(ctx.escrow));

    await ctx.asset.send('setBlocked', [dest, false]);
    await ctx.escrow.send('withdrawOwed', [dest]);
    assert.equal(await ctx.balance(dest), lock.shares);
  });

  test('a token that returns nothing from transfer is paid normally, not deferred', async () => {
    // USDT returns no bool. A low-level payment that read an empty return as a
    // refusal would defer every payment it made.
    const ctx = await book({ kind: 'noReturn' });
    await ctx.anchorFor(ACCOUNTS.bob, 300n * ONE);
    const id = await ctx.anchorFor(ACCOUNTS.alice, 10n * ONE);
    const s = await ctx.seal(ctx.releaseLeaf(id, ACCOUNTS.alice));
    ctx.chain.advanceTime(4 * EPOCH);
    const before = await ctx.balance(ACCOUNTS.alice);
    const res = await ctx.release(id, ACCOUNTS.alice, s);
    assert.equal(ctx.escrow.events(res, 'PaymentDeferred').length, 0);
    assert.equal((await ctx.balance(ACCOUNTS.alice)) - before, 10n * ONE);
  });

  test('a token that returns nothing and reverts a blocked payee is credited, not bricked', async () => {
    const ctx = await book({ kind: 'noReturn' });
    await ctx.anchorFor(ACCOUNTS.bob, 300n * ONE);
    const id = await ctx.anchorFor(ACCOUNTS.alice, 10n * ONE);
    const s = await ctx.seal(ctx.releaseLeaf(id, ACCOUNTS.alice));
    ctx.chain.advanceTime(4 * EPOCH);
    await ctx.asset.send('setBlocked', [ACCOUNTS.alice, true]);
    await ctx.release(id, ACCOUNTS.alice, s);
    assert.equal(await ctx.escrow.call('owedShares', [ACCOUNTS.alice]), 10n * ONE);
    await ctx.asset.send('setBlocked', [ACCOUNTS.alice, false]);
    await ctx.escrow.send('withdrawOwed', [ACCOUNTS.alice]);
    assert.equal(await ctx.balance(ACCOUNTS.alice), 1_000n * ONE);
  });
});

describe('a payment worth zero units', () => {
  test('is not attempted, so a token that refuses a zero transfer does not stop the drain', async () => {
    // A queue entry's last partial payment can be a few shares worth less than
    // one unit, once a negative rebase has taken a share below a unit. Paying
    // it as a zero transfer reverts on such a token, at the head of the queue.
    const ctx = await book();
    await ctx.escrow.send('seed', [200n * ONE], { from: ACCOUNTS.admin });
    const id = await ctx.anchorFor(ACCOUNTS.alice, 10n * ONE);

    // Take a share to about a thousandth of a unit.
    const pooled = await ctx.asset.call('totalPooled');
    const shares = await ctx.asset.call('totalShares');
    await ctx.asset.send('rebase', [shares / 1000n - pooled]);
    await ctx.asset.send('setRefuseZero', [true]);

    // A loss whose shares exceed one epoch's bound by less than a unit's worth,
    // so the second epoch pays a remainder worth nothing.
    const bound = await ctx.escrow.call('releaseBudgetRemaining');
    const sharesFor = async (q) => {
      let sh = await ctx.asset.call('getSharesByPooledEth', [q]);
      if ((await ctx.asset.call('getPooledEthByShares', [sh])) < q) sh += 1n;
      return sh;
    };
    let q = bound / 1000n;
    let rest;
    for (;;) {
      rest = (await sharesFor(q)) - bound;
      if (rest > 0n) break;
      q += 1n;
    }
    assert.equal(await ctx.asset.call('getPooledEthByShares', [rest]), 0n, 'the remainder is worth a unit');

    const det = keccak256(toUtf8Bytes('det:zero'));
    const leaf = ids.lossLeaf({ chainId: CHAIN_ID, escrow: ctx.escrow.address, determinationId: det, stakeAssetId: id, destination: LOSS_DEST, quantity: q });
    const s = await ctx.seal(leaf);
    await ctx.escrow.send('settleLoss', [det, id, LOSS_DEST, q, s.epoch, s.proof(leaf)]);
    // Owed in units since D13 (2026-09-28): what is left owed is a whole unit
    // or nothing, never a share worth less than one.
    const left = await ctx.escrow.call('lossOwedUnits');
    assert.ok(left <= 1n, 'the loss is owed units, not a sub-unit remainder of shares');

    ctx.chain.advanceTime(EPOCH);
    const res = await ctx.escrow.send('drainQueue', [8n]);
    assert.equal(ctx.escrow.events(res, 'EntrySettled').length, 1);
    assert.equal(ctx.escrow.events(res, 'PaymentDeferred').length, 0, 'a zero payment was attempted and refused');
    assert.equal(await ctx.escrow.call('queueHead'), await ctx.escrow.call('queueTail'));
  });

  test('withdrawOwed of a credit worth zero units attempts nothing', async () => {
    const ctx = await book({ kind: 'strict' });
    await assert.rejects(ctx.escrow.send('withdrawOwed', [ACCOUNTS.bob]), /NothingOwed/);
  });
});
