/**
 * PremiumSwap after the audit round OC of 2026-10-03 (docs/review/
 * audit-2026-10-03/SWAP/REPORT.md): each test is named for the rule the
 * finding broke and asserts the specified behaviour, on the PoC's own
 * history where there was one.
 *
 *  - OC-SWAP-02: the batching increment is the fresh premium; the lots the
 *    escrow paid between two offers come off the units the carry last saw.
 *  - OC-SWAP-03: an offering's judgement is visible (`offeringOf.judged`) and
 *    a judging quote of one planck makes the views read what binds, which is
 *    what the reference solver does (relayer/test/solver.test.js).
 *  - OC-SWAP-06: an offering is judged on what it sold, not on what was claimed.
 *  - OC-SWAP-07: a zero epoch-average price is refused at the quote, never
 *    fixed as the reserve.
 *  - OC-SWAP-10: `required` of an epoch with no offering is zero.
 *  - SWAPGOV-11: a failed offering on a book with no new premium is judged
 *    within OFFERING_CARRY_MAX_EPOCHS, and retired after `unsoldEpochs`.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { keccak256, toUtf8Bytes } = require('ethers');

const F = require('./stake-fixture');
const { ACCOUNTS, EPOCH, DAY, ONE, ASSET_A, CHAIN_ID, ZERO, ESCROW, REF_PRICE } = F;
const ids = require('../ecdsa-stakings/relayer/lib/identifiers');

const SOLVER = ACCOUNTS.bob;
const EVM_RECIPIENT = '0x' + 'b2'.repeat(20);
const KEY = ids.assetKey(CHAIN_ID, ASSET_A);
const secretOf = (label) => keccak256(toUtf8Bytes(label));
const epochNow = (ctx) => BigInt(ctx.chain.timestamp) / BigInt(EPOCH);
const startOf = (t) => BigInt(t) * BigInt(EPOCH);
const quoteOpens = (t) => (BigInt(t) + 2n) * BigInt(EPOCH) - BigInt(DAY);
const quoteCloses = (t) => (BigInt(t) + 2n) * BigInt(EPOCH);
/** `ArkStakeEscrow.offerPremium`'s earliest instant for epoch t: the lots of t - 2 have passed their evmExpiry. */
const offerOpens = (t) => startOf(t) + 2n * BigInt(DAY);

function to(ctx, ts) {
  const now = BigInt(ctx.chain.timestamp);
  if (ts > now) ctx.chain.advanceTime(Number(ts - now));
}

async function swapStack() {
  const ctx = await F.deployBondStack({ swapStandIn: false });
  const swap = await ctx.chain.deploy(
    'PremiumSwap',
    ['address', 'address', 'address', 'address', 'address'],
    [ctx.registry.address, ctx.params.address, ctx.ledger.address, ctx.attest.address, ZERO],
  );
  await ctx.ledger.send('setSwap', [swap.address], { from: ACCOUNTS.admin });
  /** Seal and present `epoch`'s offer; the receipt. */
  const present = async (epoch, shares, units = shares) => {
    const leaf = ids.premiumOfferLeaf({ chainId: CHAIN_ID, escrow: ESCROW, asset: ASSET_A, epoch, shares, units });
    await ctx.attest.send('seal', [epoch, leaf]);
    return swap.send('recordOffer', [CHAIN_ID, ESCROW, ASSET_A, epoch, shares, units, []], { from: ACCOUNTS.mallory });
  };
  /** The views a solver prices from: the reserve of `shares` and the bond on it. */
  const viewsFor = async (t, shares) => {
    const v = await swap.call('required', [CHAIN_ID, ASSET_A, t, shares]);
    const b = (await swap.call('bondFor', [CHAIN_ID, ASSET_A, t, v]))[0];
    return { v, b };
  };
  const quote = async (t, label, shares, { value = null, from = SOLVER } = {}) => {
    const views = await viewsFor(t, shares);
    const v = value ?? views.v;
    const b = (await swap.call('bondFor', [CHAIN_ID, ASSET_A, t, v]))[0];
    const res = await swap.send('quote', [CHAIN_ID, ASSET_A, t, shares, ids.hashlockOf(secretOf(label)), EVM_RECIPIENT, v], { from, value: v + b });
    const [ev] = swap.events(res, 'LotQuoted');
    return { lotId: ev.args.lotId, value: v, bond: ev.args.bond, secret: secretOf(label), shares };
  };
  /** Quote the whole of an offering at its reserve and select it; claimed unless `claim` is false. */
  const sellWhole = async (t, label, { claim = true } = {}) => {
    const avail = await swap.call('available', [CHAIN_ID, ASSET_A, t]);
    to(ctx, quoteOpens(t));
    const lot = await quote(t, label, avail);
    to(ctx, quoteCloses(t));
    await swap.send('select', [CHAIN_ID, ASSET_A, t]);
    if (claim) await swap.send('claim', [lot.lotId, lot.secret]);
    return { avail, lot };
  };
  const carried = (res) => swap.events(res, 'OfferingCarried').length === 1;
  const opened = (res) => swap.events(res, 'OfferRecorded').length === 1;
  return { ...ctx, swap, present, viewsFor, quote, sellWhole, carried, opened };
}

describe('the audit round OC of 2026-10-03: PremiumSwap', () => {
  test('OC-SWAP-02: in steady state, with every offering selling, every offer of a fresh premium above the threshold opens an offering and every epoch\'s coupon is delivered', async () => {
    const ctx = await swapStack();
    const Fz = 10n * ONE; // fresh premium per epoch, ~333x the 0.03-unit threshold
    const t = epochNow(ctx);
    let pot = 0n;
    const sold = {};
    const outcome = {};
    // The PoC's history: the escrow's pot is the last pot, less the lots of
    // e - 2 paid since, plus the fresh premium; offer e, then sell e - 1.
    for (let e = t; e < t + 8n; e += 1n) {
      to(ctx, offerOpens(e));
      pot = pot - (sold[e - 2n] || 0n) + Fz;
      const res = await ctx.present(e, pot);
      outcome[e] = ctx.carried(res) ? 'carried' : 'opened';
      const prev = e - 1n;
      if (outcome[prev] === 'opened') sold[prev] = (await ctx.sellWhole(prev, `lot-${prev}`)).avail;
    }
    const pattern = [...Array(8).keys()].map((i) => outcome[t + BigInt(i)]);
    assert.deepEqual(pattern, Array(8).fill('opened'), 'no offer carrying ~333x the threshold of fresh premium is carried');
    for (let e = t; e < t + 7n; e += 1n) {
      assert.equal(sold[e], Fz, `offering ${e} sells its own epoch's premium, no lump`);
      assert.ok((await ctx.ledger.call('deliveredIn', [e])) > 0n, `epoch ${e}'s coupon has delivered proceeds`);
    }
  });

  test('OC-SWAP-02: a claim takes the lot\'s units off the carry at the offering\'s own rate', async () => {
    const ctx = await swapStack();
    const t = epochNow(ctx);
    // Two units per share: the escrow pays 20 units for a lot of 10 shares.
    await ctx.present(t, 10n * ONE, 20n * ONE);
    to(ctx, offerOpens(t + 1n));
    // The pot of t + 1 still holds the lot in flight, and one fresh unit.
    assert.ok(ctx.opened(await ctx.present(t + 1n, 10n * ONE + ONE / 2n, 21n * ONE)), 'the fresh unit opens t + 1');
    await ctx.sellWhole(t, 'whole');
    // t + 2: the escrow paid the lot's 20 units and gained one more fresh unit:
    // 21 - 20 + 1 = 2 units, one of them new. Compared whole with the 21 of
    // t + 1 it showed no increment at all and was carried.
    to(ctx, offerOpens(t + 2n));
    const res = await ctx.present(t + 2n, ONE, 2n * ONE);
    assert.ok(ctx.opened(res), 'the fresh unit, above the threshold, opens t + 2');
  });

  test('OC-SWAP-03: the first quote judges the offering before; a judging quote of one planck lands, and the views read after it price a lot that is selected', async () => {
    const ctx = await swapStack();
    const Q = 10n * ONE;
    const t = epochNow(ctx);
    // The PoC's history: t fails, t + 1 sells (judging t: one failure), t + 2 is next.
    await ctx.present(t, Q);
    to(ctx, quoteCloses(t));
    await ctx.swap.send('select', [CHAIN_ID, ASSET_A, t]);
    to(ctx, offerOpens(t + 1n));
    assert.ok(ctx.opened(await ctx.present(t + 1n, 2n * Q)));
    to(ctx, offerOpens(t + 2n));
    assert.ok(ctx.opened(await ctx.present(t + 2n, 3n * Q)));
    await ctx.sellWhole(t + 1n, 'ok');
    assert.equal(await ctx.swap.call('failedOfferings', [KEY]), 1n);

    to(ctx, quoteOpens(t + 2n));
    assert.equal((await ctx.swap.call('offeringOf', [CHAIN_ID, ASSET_A, t + 2n])).judged, false, 'not judged yet: the views are stale');
    const avail = await ctx.swap.call('available', [CHAIN_ID, ASSET_A, t + 2n]);
    const stale = await ctx.viewsFor(t + 2n, avail);
    // The reference solver's judging quote: the least lot, one planck, the bond the swap computes for it.
    const least = (avail + 31n) / 32n;
    const judging = await ctx.quote(t + 2n, 'judging', least, { value: 1n });
    assert.equal(judging.bond, 0n);
    assert.equal((await ctx.swap.call('offeringOf', [CHAIN_ID, ASSET_A, t + 2n])).judged, true);
    assert.equal(await ctx.swap.call('failedOfferings', [KEY]), 0n, 'the success of t + 1 reset the count');
    const fresh = await ctx.viewsFor(t + 2n, avail);
    assert.ok(fresh.v > stale.v, 'the reserve read after the judgement is the higher one that binds');
    const lot = await ctx.quote(t + 2n, 'priced', avail);
    to(ctx, quoteCloses(t + 2n));
    const sel = await ctx.swap.send('select', [CHAIN_ID, ASSET_A, t + 2n]);
    assert.deepEqual(ctx.swap.events(sel, 'LotSelected').map((e) => e.args.lotId), [lot.lotId], 'the lot priced after the judgement is selected, the judging lot is not');
    assert.equal((await ctx.swap.call('offeringOf', [CHAIN_ID, ASSET_A, t + 2n])).sold, avail);
    const res = await ctx.swap.send('refund', [judging.lotId]);
    const [r] = ctx.swap.events(res, 'LotRefunded');
    assert.equal(r.args.value, 1n, 'the judging planck comes back at the selection');
  });

  test('OC-SWAP-06: an offering sold whole and never claimed is not a failure: its bond pays for the lapse, and the next reserve does not step down', async () => {
    const ctx = await swapStack();
    const Q = 10n * ONE;
    const t = epochNow(ctx);
    await ctx.present(t, Q);
    const { lot } = await ctx.sellWhole(t, 'walked away', { claim: false });
    assert.equal(await ctx.swap.call('bondsAtRisk', [t]), lot.bond, 'the lapse is priced: the bond is at risk');
    to(ctx, offerOpens(t + 1n));
    assert.ok(ctx.opened(await ctx.present(t + 1n, 2n * Q)));
    to(ctx, quoteOpens(t + 1n));
    await ctx.quote(t + 1n, 'next', await ctx.swap.call('available', [CHAIN_ID, ASSET_A, t + 1n]));
    const prev = await ctx.swap.call('offeringOf', [CHAIN_ID, ASSET_A, t]);
    assert.equal(prev.claimed, 0n);
    assert.equal(prev.sold, Q);
    assert.equal(await ctx.swap.call('failedOfferings', [KEY]), 0n, 'judged on what it sold');
  });

  test('OC-SWAP-07: with no epoch-average price the quote is refused ZeroValue and no reserve is fixed; with one, the reserve is fixed above zero', async () => {
    const ctx = await swapStack();
    const t = epochNow(ctx);
    await ctx.present(t, 10n * ONE);
    to(ctx, quoteOpens(t));
    await ctx.oracle.send('set', [0n, REF_PRICE, REF_PRICE]);
    assert.equal(await ctx.registry.call('epochPrice'), 0n);
    await assert.rejects(
      ctx.swap.send('quote', [CHAIN_ID, ASSET_A, t, 10n * ONE, ids.hashlockOf(secretOf('one wei')), EVM_RECIPIENT, 1n], { from: SOLVER, value: 1n }),
      /ZeroValue/,
    );
    assert.equal((await ctx.swap.call('offeringOf', [CHAIN_ID, ASSET_A, t])).reserveNum, 0n);
    await ctx.oracle.send('set', [REF_PRICE, REF_PRICE, REF_PRICE]);
    await ctx.quote(t, 'priced', 10n * ONE);
    assert.ok((await ctx.swap.call('offeringOf', [CHAIN_ID, ASSET_A, t])).reserveNum > 0n);
  });

  test('OC-SWAP-10: required() of an epoch with no offering recorded, or carried, is zero rather than a panic', async () => {
    const ctx = await swapStack();
    const t = epochNow(ctx);
    assert.equal(await ctx.swap.call('required', [CHAIN_ID, ASSET_A, t + 5n, ONE]), 0n);
    const res = await ctx.present(t, 1000n); // far below the threshold: carried
    assert.ok(ctx.carried(res));
    assert.equal(await ctx.swap.call('required', [CHAIN_ID, ASSET_A, t, ONE]), 0n);
  });

  test('SWAPGOV-11: a failed offering on a book with no new premium is judged within OFFERING_CARRY_MAX_EPOCHS and retired after unsoldEpochs failures', async () => {
    const ctx = await swapStack();
    const Q = 10n * ONE;
    const t = epochNow(ctx);
    const max = await ctx.swap.call('OFFERING_CARRY_MAX_EPOCHS');
    await ctx.present(t, Q);
    to(ctx, quoteCloses(t));
    await ctx.swap.send('select', [CHAIN_ID, ASSET_A, t]); // nobody quoted: it failed
    // The pot unchanged: nothing new. Carried at most `max` epochs, then opened.
    let e = t + 1n;
    for (; e <= t + max; e += 1n) {
      to(ctx, offerOpens(e));
      assert.ok(ctx.carried(await ctx.present(e, Q)), `epoch ${e} carried`);
    }
    to(ctx, offerOpens(e));
    const res = await ctx.present(e, Q);
    assert.ok(ctx.opened(res), `epoch ${e}, ${max} epochs on, opens on nothing new`);
    assert.equal(ctx.swap.events(res, 'OfferingCarried').length, 0);
    to(ctx, quoteCloses(e));
    await ctx.swap.send('select', [CHAIN_ID, ASSET_A, e]);
    assert.equal(await ctx.swap.call('failedOfferings', [KEY]), 1n, 'the failure of t is judged');
    // A failure counted opens every offer at once, so the ladder walks one rung an epoch to retirement.
    const unsold = BigInt((await ctx.swap.call('offeringOf', [CHAIN_ID, ASSET_A, t])).unsoldEpochs);
    let retiredAt = null;
    for (let i = 1n; i <= unsold && retiredAt === null; i += 1n) {
      const next = e + i;
      to(ctx, offerOpens(next));
      assert.ok(ctx.opened(await ctx.present(next, Q)), `epoch ${next} opens: a failure is counted`);
      to(ctx, quoteCloses(next));
      const sel = await ctx.swap.send('select', [CHAIN_ID, ASSET_A, next]);
      if (ctx.swap.events(sel, 'ShortfallCarried').length) retiredAt = next;
    }
    assert.equal(retiredAt, e + unsold - 1n, `retired at the ${unsold}th failure`);
    assert.equal(await ctx.swap.call('retainedShares', [KEY]), Q, 'what the failed offerings left is retained as buffer');
    assert.equal(await ctx.swap.call('failedOfferings', [KEY]), 0n);
  });
});
