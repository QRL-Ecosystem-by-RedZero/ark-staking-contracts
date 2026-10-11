/**
 * PremiumSwap: the QRL side of the swap of whitepaper §4.7 that sells the
 * premium for QRL in hash-timelocked lots.
 *
 * Every test is named for the rule it defends: a lot is quoted only in the
 * quote window and never above what the offer may sell, at any price since
 * 2026-09-30; lots are selected by price, whole, down to the reserve the
 * window closed on; an offer below the batching threshold is carried, at
 * most four epochs and never after a failure; a lot's QRL reaches
 * the delivered proceeds of its own epoch against the preimage and before its
 * QRL expiry, and otherwise goes back to its solver; the timelocks keep the QRL
 * leg outlasting the origin-chain leg (I31); the leaves agree with the origin
 * chain's and the relayer's byte for byte.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { keccak256, toUtf8Bytes, sha256 } = require('ethers');

const F = require('./stake-fixture');
const { ACCOUNTS, EPOCH, DAY, BPS, ONE, PRICE_SCALE, REF_PRICE, ASSET_A, ASSET_B, CHAIN_ID, REFERENCE_PARAMS, ZERO, ESCROW } = F;

const ids = require('../ecdsa-stakings/relayer/lib/identifiers');
const { loadModel } = require('./spec-model');

const SOLVER = ACCOUNTS.bob;
const RIVAL = ACCOUNTS.mallory;
const EVM_RECIPIENT = '0x' + 'b2'.repeat(20);
const secretOf = (label) => keccak256(toUtf8Bytes(label));
const epochNow = (ctx) => BigInt(ctx.chain.timestamp) / BigInt(EPOCH);
const quoteOpens = (t) => (BigInt(t) + 2n) * BigInt(EPOCH) - BigInt(DAY);
const quoteCloses = (t) => (BigInt(t) + 2n) * BigInt(EPOCH);
const evmExpiry = (t) => quoteCloses(t) + 2n * BigInt(DAY);
const qrlExpiry = (t) => evmExpiry(t) + 2n * BigInt(DAY);

function to(ctx, ts) {
  const now = BigInt(ctx.chain.timestamp);
  if (ts > now) ctx.chain.advanceTime(Number(ts - now));
}

async function swapStack({ feePool = false, ...opts } = {}) {
  const ctx = await F.deployBondStack({ ...opts, swapStandIn: false });
  // The court's fee pool the juror fraction funds (phase C3b), or none: the ledger takes it.
  const swap = await ctx.chain.deploy(
    'PremiumSwap',
    ['address', 'address', 'address', 'address', 'address'],
    [ctx.registry.address, ctx.params.address, ctx.ledger.address, ctx.attest.address, feePool ? ctx.court.address : ZERO],
  );
  await ctx.ledger.send('setSwap', [swap.address], { from: ACCOUNTS.admin });

  /** Seal an escrow's offer into the attestation for `epoch` and record it. */
  const offer = async (shares, { units = shares, asset = ASSET_A, epoch = epochNow(ctx), raw = false } = {}) => {
    const leaf = ids.premiumOfferLeaf({ chainId: CHAIN_ID, escrow: ESCROW, asset, epoch, shares, units });
    await ctx.attest.send('seal', [epoch, leaf]);
    const res = await swap.send('recordOffer', [CHAIN_ID, ESCROW, asset, epoch, shares, units, []], { from: ACCOUNTS.mallory });
    return raw ? res : epoch;
  };

  /** The reserve for `shares` of an offering, as the contract must compute it, rounding up. */
  const expectedReserve = async (shares, { offered, units = offered, failed = 0n, price = REF_PRICE }) => {
    const coupon = await ctx.registry.call('couponAtExactCoverBps', [220n]);
    const p = REFERENCE_PARAMS;
    const inadmissible = coupon === 0n ? BPS : (BigInt(p.tailPremiumFloorBps) * BPS + coupon - 1n) / coupon;
    const cap = inadmissible >= BPS ? 0n : BPS - inadmissible;
    const floorCap = BigInt(p.reserveFloorBps) < cap ? BigInt(p.reserveFloorBps) : cap;
    // d_0 = d_first, d_k = m_epoch + (k - 1) * step (EC-03, 2026-09-30).
    const stepped = failed === 0n ? BigInt(p.firstReserveDiscountBps) : BigInt(p.maxEpochMoveBps) + (failed - 1n) * BigInt(p.reserveStepBps);
    const d = stepped < floorCap ? stepped : floorCap;
    const num = units * price * (BPS - d);
    const den = offered * BPS * PRICE_SCALE;
    return (shares * num + den - 1n) / den;
  };

  /**
   * Quote a lot for `value` QRL, or at the reserve, sending the commitment
   * bond the swap computes beside it (I33) unless `bond` names another figure.
   */
  const quote = async (t, label, shares, { value, bond, from = SOLVER, asset = ASSET_A, recipient = EVM_RECIPIENT } = {}) => {
    const secret = secretOf(label);
    const hashlock = ids.hashlockOf(secret);
    const v = value ?? (await swap.call('required', [CHAIN_ID, asset, t, shares]));
    const b = bond ?? (await swap.call('bondFor', [CHAIN_ID, asset, t, v]))[0];
    const res = await swap.send('quote', [CHAIN_ID, asset, t, shares, hashlock, recipient, v], { from, value: v + b });
    const [ev] = swap.events(res, 'LotQuoted');
    return { secret, hashlock, lotId: ev.args.lotId, value: v, bond: b, shares, from, recipient };
  };

  return { ...ctx, swap, offer, expectedReserve, quote };
}

describe('the leaves agree with the origin chain and the relayer', () => {
  test('premiumOfferLeaf, premiumLockLeaf, the lot id and the domain tags are the relayer\'s, byte for byte', async () => {
    const ctx = await swapStack();
    // The three tags are internal since the re-audit of 2026-09-30 (the swap's
    // v3 room): the leaves below, byte for byte the relayer's, carry them.
    for (const [q, e] of [[1n, 0n], [ONE, 2810n], [2n ** 200n, 2n ** 64n - 1n]]) {
      assert.equal(
        await ctx.swap.call('premiumOfferLeaf', [CHAIN_ID, ESCROW, ASSET_A, e, q, q + 3n]),
        ids.premiumOfferLeaf({ chainId: CHAIN_ID, escrow: ESCROW, asset: ASSET_A, epoch: e, shares: q, units: q + 3n }),
      );
      const hashlock = ids.hashlockOf(secretOf(`s${e}`));
      const lotId = keccak256(toUtf8Bytes(`lot ${e}`));
      const terms = { epoch: e + 7n, lotId, hashlock, recipient: EVM_RECIPIENT, shares: q, bond: q / 13n, evmExpiry: e };
      assert.equal(
        await ctx.swap.call('premiumLockLeaf', [CHAIN_ID, ESCROW, ASSET_A, [terms.epoch, lotId, hashlock, EVM_RECIPIENT, q, terms.bond, e]]),
        ids.premiumLockLeaf({ chainId: CHAIN_ID, escrow: ESCROW, asset: ASSET_A, ...terms }),
      );
      assert.equal(
        await ctx.swap.call('lotIdOf', [hashlock, SOLVER, EVM_RECIPIENT, q, q * 2n, e]),
        ids.lotIdOf({ hashlock, solver: SOLVER, recipient: EVM_RECIPIENT, shares: q, value: q * 2n, qrlExpiry: e }),
      );
    }
  });

  test('the timetable: quote on the last day of t + 1, evmExpiry two days after, qrlExpiry two more (I31)', async () => {
    const ctx = await swapStack();
    const t = 2810n;
    const [qo, qc, evm, qrl] = await ctx.swap.call('timetable', [t]);
    assert.equal(qo, quoteOpens(t));
    assert.equal(qc, quoteCloses(t));
    assert.equal(evm, evmExpiry(t));
    assert.equal(qrl, qrlExpiry(t));
    // The QRL margin is not below the admission and claim windows together.
    assert.ok(qrl - evm >= evm - qc);
    // The settlement of t closes before the quote window offering t + 1 opens.
    assert.ok(qrl < quoteOpens(t + 1n));
  });
});

describe('the offer', () => {
  test('an offer is recorded only against the attested root, and once', async () => {
    const ctx = await swapStack();
    const t = epochNow(ctx);
    await assert.rejects(ctx.swap.send('recordOffer', [CHAIN_ID, ESCROW, ASSET_A, t, 10n * ONE, 10n * ONE, []]), /BadOfferProof/);
    await ctx.offer(10n * ONE, { epoch: t });
    await assert.rejects(ctx.offer(10n * ONE, { epoch: t }), /OfferExists/);
    assert.equal(await ctx.swap.call('available', [CHAIN_ID, ASSET_A, t]), 10n * ONE);
  });

  test('D10: an offer binds the escrow that holds the pot, and the offering records it for every lock', async () => {
    // One attestation root carries every escrow's facts; an offer sealed for
    // one escrow of an asset is no offer of another, and each lock of the
    // offering names the escrow that pays it.
    const ctx = await swapStack();
    const t = epochNow(ctx);
    const other = '0x' + 'e6'.repeat(20);
    const leaf = ids.premiumOfferLeaf({ chainId: CHAIN_ID, escrow: other, asset: ASSET_A, epoch: t, shares: 10n * ONE, units: 10n * ONE });
    await ctx.attest.send('seal', [t, leaf]);
    await assert.rejects(ctx.swap.send('recordOffer', [CHAIN_ID, ESCROW, ASSET_A, t, 10n * ONE, 10n * ONE, []]), /BadOfferProof/);
    await ctx.swap.send('recordOffer', [CHAIN_ID, other, ASSET_A, t, 10n * ONE, 10n * ONE, []]);
    assert.equal((await ctx.swap.call('offeringOf', [CHAIN_ID, ASSET_A, t])).escrow.toLowerCase(), other);
  });
});

describe('the quote', () => {
  test('a lot is quoted only in the quote window, on the last day of the epoch after', async () => {
    const ctx = await swapStack();
    const t = await ctx.offer(10n * ONE);
    await assert.rejects(ctx.quote(t, 'early', ONE, { value: 10n ** 24n }), /OutsideQuoteWindow/);
    to(ctx, quoteOpens(t));
    await ctx.quote(t, 'in', ONE);
    to(ctx, quoteCloses(t));
    await assert.rejects(ctx.quote(t, 'late', ONE, { value: 10n ** 24n }), /OutsideQuoteWindow/);
  });

  test('a lot above the offer is refused, one below the reserve is quoted and passed over at the selection; the reserve is in shares at the offer\'s rate', async () => {
    const ctx = await swapStack();
    // A rebasing asset: 10 shares worth 11 units.
    const t = await ctx.offer(10n * ONE, { units: 11n * ONE });
    to(ctx, quoteOpens(t));
    const reserve = await ctx.expectedReserve(ONE, { offered: 10n * ONE, units: 11n * ONE });
    assert.equal(await ctx.swap.call('required', [CHAIN_ID, ASSET_A, t, ONE]), reserve);
    // Any price is quoted since 2026-09-30 (whitepaper §4.7): the reserve binds
    // at the selection, at the reading the last in-window quote took.
    const low = await ctx.quote(t, 'low', ONE, { value: reserve - 1n, from: RIVAL });
    assert.equal((await ctx.swap.call('lotOf', [low.lotId])).status, 1n, 'quoted');
    await assert.rejects(ctx.quote(t, 'big', 10n * ONE + 1n, { value: 10n ** 24n }), /ExceedsOffer/);
    const lot = await ctx.quote(t, 'ok', ONE, { value: reserve });
    const l = await ctx.swap.call('lotOf', [lot.lotId]);
    assert.equal(l.status, 1n);
    assert.equal(l.qrlExpiry, qrlExpiry(t));
    assert.equal(lot.lotId, ids.lotIdOf({ hashlock: lot.hashlock, solver: SOLVER, recipient: EVM_RECIPIENT, shares: ONE, value: reserve, qrlExpiry: qrlExpiry(t) }));
    // The lot below the reserve is never selected, and is refundable at once.
    to(ctx, quoteCloses(t));
    const res = await ctx.swap.send('select', [CHAIN_ID, ASSET_A, t]);
    assert.deepEqual(ctx.swap.events(res, 'LotSelected').map((e) => e.args.lotId), [lot.lotId]);
    await ctx.swap.send('refund', [low.lotId]);
  });

  test('the reserve is fixed by the offering\'s first quote, when its window opens: no later reading moves it (re-audit 2026-09-30, SWAPGOV-02)', async () => {
    const ctx = await swapStack();
    const t = await ctx.offer(10n * ONE);
    to(ctx, quoteOpens(t));
    const early = await ctx.quote(t, 'early', 5n * ONE, { from: RIVAL });
    await ctx.oracle.send('set', [REF_PRICE * 2n, REF_PRICE, REF_PRICE]);
    const late = await ctx.quote(t, 'late', 5n * ONE);
    assert.equal(late.value, early.value, 'the reserve the first quote read, for every later quote too');
    to(ctx, quoteCloses(t));
    const res = await ctx.swap.send('select', [CHAIN_ID, ASSET_A, t]);
    assert.deepEqual(ctx.swap.events(res, 'LotSelected').map((e) => e.args.lotId).sort(), [early.lotId, late.lotId].sort(), 'both lots at the fixed reserve are taken');
  });

  test('SWAPGOV-02 (the PoC, now refused): a one-wei quote in the last moment of the window no longer re-fixes the reserve and voids the lots before it', async () => {
    const ctx = await swapStack();
    const t = epochNow(ctx);
    await ctx.offer(10n * ONE, { epoch: t });
    to(ctx, quoteOpens(t));
    const req = await ctx.swap.call('required', [CHAIN_ID, ASSET_A, t, 10n * ONE]);
    const honest = await ctx.quote(t, 'honest', 10n * ONE, { value: (req * 101n) / 100n });
    await ctx.oracle.send('set', [(REF_PRICE * 102n) / 100n, REF_PRICE, REF_PRICE]);
    const least = (10n * ONE + 31n) / 32n;
    await ctx.quote(t, 'grief', least, { value: 1n, from: RIVAL });
    to(ctx, quoteCloses(t));
    const res = await ctx.swap.send('select', [CHAIN_ID, ASSET_A, t]);
    assert.deepEqual(ctx.swap.events(res, 'LotSelected').map((e) => e.args.lotId), [honest.lotId], 'the honest lot is selected');
    assert.equal((await ctx.swap.call('offeringOf', [CHAIN_ID, ASSET_A, t])).sold, 10n * ONE);
  });

  test('the reserve reads the epoch average and never the settlement series (whitepaper §5.5)', async () => {
    // Cover reads the thirty-day series since 2026-09-28 (I38); the swap's
    // reserve is the one consumer of the epoch average, and must stay on it.
    const ctx = await swapStack();
    const t = await ctx.offer(10n * ONE);
    to(ctx, quoteOpens(t));
    await ctx.oracle.send('set', [REF_PRICE * 2n, REF_PRICE, REF_PRICE]);
    const reserve = await ctx.expectedReserve(ONE, { offered: 10n * ONE, price: REF_PRICE * 2n });
    assert.equal(await ctx.swap.call('required', [CHAIN_ID, ASSET_A, t, ONE]), reserve);
    assert.ok(reserve > (await ctx.expectedReserve(ONE, { offered: 10n * ONE })), 'not the series price');
  });

  /**
   * Quote `epoch`'s offering of ASSET_B under a suspension, expecting the
   * refusal of yellow paper §4.6 (item 123): no revert, no lot, the refusal
   * recorded (`QuoteRefused`), the zero lot id, and every planck sent back.
   */
  const refusedQuote = async (ctx, t, label) => {
    const hashlock = ids.hashlockOf(secretOf(label));
    const args = [CHAIN_ID, ASSET_B, t, ONE, hashlock, EVM_RECIPIENT, 10n ** 24n];
    const before = await ctx.chain.balanceOf(SOLVER);
    const held = await ctx.chain.balanceOf(ctx.swap.address);
    const res = await ctx.swap.send('quote', args, { from: SOLVER, value: 10n ** 24n });
    assert.equal(res.decoded[0], '0x' + '00'.repeat(32), 'the zero lot id');
    assert.equal(ctx.swap.events(res, 'LotQuoted').length, 0, 'no lot stored');
    const [ev] = ctx.swap.events(res, 'QuoteRefused');
    assert.ok(ev, 'the refusal recorded');
    assert.equal(ev.args.key, ids.assetKey(CHAIN_ID, ASSET_B));
    assert.equal(ev.args.epoch, t);
    assert.equal(ev.args.solver.toLowerCase(), SOLVER.toLowerCase());
    assert.equal(await ctx.chain.balanceOf(SOLVER), before, 'refunded whole');
    assert.equal(await ctx.chain.balanceOf(ctx.swap.address), held, 'the swap keeps nothing');
    assert.equal((await ctx.swap.call('offeringOf', [CHAIN_ID, ASSET_B, t])).reserveNum, 0n, 'no reserve fixed');
    assert.equal((await ctx.swap.call('offeringOf', [CHAIN_ID, ASSET_B, t])).judged, false, 'nothing judged');
  };

  test('a hashlock locks once per solver; under the breaker a reserve no quote fixed is refused and the refusal recorded, and one fixed before runs to its close (yellow paper §4.6)', async () => {
    const ctx = await swapStack();
    const t = await ctx.offer(10n * ONE);
    await ctx.offer(10n * ONE, { asset: ASSET_B });
    to(ctx, quoteOpens(t));
    await ctx.quote(t, 'once', ONE);
    await assert.rejects(ctx.quote(t, 'once', ONE), /HashlockUsed/);
    await ctx.oracle.send('set', [REF_PRICE, REF_PRICE / 3n, REF_PRICE]);
    // Refused and recorded since item 123 (OC-ORC-04): a revert recorded nothing.
    await refusedQuote(ctx, t, 'breaker B');
    // Suspended pricing since 2026-10-05: the first quote fixed this offering's reserve, so it runs.
    await ctx.quote(t, 'breaker', ONE);
  });

  test('a silent series refuses a quote whose reserve no quote fixed and records the refusal, and one fixed before runs to its close at that reserve (yellow paper §4.6, I40)', async () => {
    const ctx = await swapStack();
    const t = await ctx.offer(10n * ONE);
    await ctx.offer(10n * ONE, { asset: ASSET_B });
    to(ctx, quoteOpens(t));
    const first = await ctx.quote(t, 'fixed', ONE);
    await ctx.oracle.send('setSilent', [true]);
    await refusedQuote(ctx, t, 'unfixed');
    // An oracle that does not answer at all is silent too.
    await ctx.oracle.send('setReverting', [true]);
    await refusedQuote(ctx, t, 'unfixed, reverting');
    await ctx.oracle.send('setReverting', [false]);
    const later = await ctx.quote(t, 'after silence', ONE);
    assert.equal(later.value, first.value, 'the reserve the first quote fixed, read again from no oracle');
  });

  test('a hashlock copied from the mempool does not block the solver who chose it (D4)', async () => {
    // Keyed by the hashlock alone, a rival sending the same hashlock first made
    // the real quote revert. The lot id binds the solver, so both stand.
    const ctx = await swapStack();
    const t = await ctx.offer(10n * ONE);
    to(ctx, quoteOpens(t));
    const copy = await ctx.quote(t, 'solver secret', ONE, { from: RIVAL });
    const real = await ctx.quote(t, 'solver secret', ONE);
    assert.equal(copy.hashlock, real.hashlock);
    assert.notEqual(copy.lotId, real.lotId);
  });

  test('a lot is at least ceil(available / MAX_LOTS) unless it takes the whole quantity (D4)', async () => {
    const ctx = await swapStack();
    const offered = 10n * ONE;
    const t = await ctx.offer(offered);
    to(ctx, quoteOpens(t));
    const max = await ctx.swap.call('MAX_LOTS');
    const least = (offered + max - 1n) / max;
    await assert.rejects(ctx.quote(t, 'dust', 1n, { value: 10n ** 18n }), /LotTooSmall/);
    await assert.rejects(ctx.quote(t, 'just under', least - 1n, { value: 10n ** 24n }), /LotTooSmall/);
    await ctx.quote(t, 'at the least', least);
    await ctx.quote(t, 'the whole', offered, { from: RIVAL });
  });

  test('thirty-two dust quotes can no longer shut the offering to a real solver (D4)', async () => {
    const ctx = await swapStack();
    const t = await ctx.offer(64n * ONE);
    to(ctx, quoteOpens(t));
    let dustRefused = 0;
    for (let i = 0; i < 32; i++) {
      try {
        await ctx.quote(t, `dust ${i}`, 1n, { from: RIVAL, value: 1n });
      } catch (e) {
        assert.match(e.message, /LotTooSmall/);
        dustRefused += 1;
      }
    }
    assert.equal(dustRefused, 32, 'every dust quote is refused');
    assert.equal((await ctx.swap.call('lotsOf', [CHAIN_ID, ASSET_A, t])).length, 0);
    // The real solver's lot for the whole quantity goes through, and is selected.
    const lot = await ctx.quote(t, 'real', 64n * ONE);
    to(ctx, quoteCloses(t));
    const res = await ctx.swap.send('select', [CHAIN_ID, ASSET_A, t]);
    assert.deepEqual(ctx.swap.events(res, 'LotSelected').map((e) => e.args.lotId), [lot.lotId]);
  });
});

describe('the selection', () => {
  test('lots are taken whole in descending order of price, down to the reserve, up to the quantity offered', async () => {
    const ctx = await swapStack();
    const t = await ctx.offer(10n * ONE);
    to(ctx, quoteOpens(t));
    const r = await ctx.swap.call('required', [CHAIN_ID, ASSET_A, t, ONE]);
    const cheap = await ctx.quote(t, 'cheap', 4n * ONE, { value: 4n * r });
    const dear = await ctx.quote(t, 'dear', 4n * ONE, { value: 6n * r, from: RIVAL });
    const huge = await ctx.quote(t, 'huge', 5n * ONE, { value: 10n * r, from: ACCOUNTS.alice });
    const small = await ctx.quote(t, 'small', 2n * ONE, { value: 2n * r, from: ACCOUNTS.guardian });
    await assert.rejects(ctx.swap.send('select', [CHAIN_ID, ASSET_A, t]), /OutsideSelectionWindow/);
    to(ctx, quoteCloses(t));
    const res = await ctx.swap.send('select', [CHAIN_ID, ASSET_A, t], { from: ACCOUNTS.mallory });
    // huge (2r/share) 5, then dear (1.5r) 4 — 9 of 10; cheap (1r) 4 does not
    // fit, small (1r) 2 does not either; the rest is unsold.
    const selected = ctx.swap.events(res, 'LotSelected').map((e) => e.args.lotId);
    assert.deepEqual(selected, [huge.lotId, dear.lotId]);
    const [ev] = ctx.swap.events(res, 'LotSelected');
    assert.equal(ev.args.evmExpiry, evmExpiry(t));
    assert.equal(ev.args.premiumLockLeaf, ids.premiumLockLeaf({ chainId: CHAIN_ID, escrow: ESCROW, asset: ASSET_A, epoch: t, lotId: huge.lotId, hashlock: huge.hashlock, recipient: EVM_RECIPIENT, shares: 5n * ONE, bond: huge.bond, evmExpiry: evmExpiry(t) }));
    assert.equal(ev.args.epoch, t);
    assert.equal(ev.args.bond, huge.bond);
    const o = await ctx.swap.call('offeringOf', [CHAIN_ID, ASSET_A, t]);
    assert.equal(o.sold, 9n * ONE);
    await assert.rejects(ctx.swap.send('select', [CHAIN_ID, ASSET_A, t]), /AlreadySelected/);
    // A lot not selected is refundable at once, its bond with it.
    const before = await ctx.chain.balanceOf(SOLVER);
    await ctx.swap.send('refund', [cheap.lotId], { from: ACCOUNTS.mallory });
    assert.equal((await ctx.chain.balanceOf(SOLVER)) - before, cheap.value + cheap.bond);
    assert.ok(cheap.bond > 0n);
    await assert.rejects(ctx.swap.send('refund', [dear.lotId]), /NotRefundable/);
    assert.ok(small);
  });

  test('the next offering sells its snapshot less what the previous one selected', async () => {
    const ctx = await swapStack();
    const t = await ctx.offer(10n * ONE);
    to(ctx, quoteOpens(t));
    await ctx.quote(t, 'a', 6n * ONE);
    to(ctx, quoteCloses(t));
    await ctx.swap.send('select', [CHAIN_ID, ASSET_A, t]);
    // The escrow's next snapshot, taken during t + 1, still counts those 6.
    const leaf = ids.premiumOfferLeaf({ chainId: CHAIN_ID, escrow: ESCROW, asset: ASSET_A, epoch: t + 1n, shares: 12n * ONE, units: 12n * ONE });
    await ctx.attest.send('seal', [t + 1n, leaf]);
    await ctx.swap.send('recordOffer', [CHAIN_ID, ESCROW, ASSET_A, t + 1n, 12n * ONE, 12n * ONE, []]);
    assert.equal(await ctx.swap.call('available', [CHAIN_ID, ASSET_A, t + 1n]), 6n * ONE);
  });
});

describe('claim and refund', () => {
  async function selectedLot() {
    const ctx = await swapStack();
    const t = await ctx.offer(10n * ONE);
    to(ctx, quoteOpens(t));
    const lot = await ctx.quote(t, 'lot', 4n * ONE);
    to(ctx, quoteCloses(t));
    await ctx.swap.send('select', [CHAIN_ID, ASSET_A, t]);
    return { ctx, t, lot };
  }

  test('the preimage credits the lot\'s QRL to the delivered proceeds of its epoch, carried by anyone', async () => {
    const { ctx, t, lot } = await selectedLot();
    await assert.rejects(ctx.swap.send('claim', [lot.lotId, secretOf('guess')]), /WrongPreimage/);
    assert.equal(ids.hashlockOf(lot.secret), sha256(lot.secret));
    const res = await ctx.swap.send('claim', [lot.lotId, lot.secret], { from: ACCOUNTS.mallory });
    assert.equal(ctx.swap.events(res, 'LotClaimed')[0].args.secret, lot.secret);
    assert.equal(await ctx.ledger.call('deliveredIn', [t]), lot.value, 'keyed by the offered epoch, not the one the claim arrives in');
    assert.equal(await ctx.chain.balanceOf(ctx.swap.address), lot.bond, 'the bond waits for its solver');
    await assert.rejects(ctx.swap.send('claim', [lot.lotId, lot.secret]), /NotSelected/);
    // I33: the preimage appeared before qrlExpiry, so the bond is returned, once, to the solver.
    const before = await ctx.chain.balanceOf(SOLVER);
    await ctx.swap.send('refund', [lot.lotId], { from: ACCOUNTS.mallory });
    assert.equal((await ctx.chain.balanceOf(SOLVER)) - before, lot.bond);
    assert.equal(await ctx.chain.balanceOf(ctx.swap.address), 0n);
    await assert.rejects(ctx.swap.send('refund', [lot.lotId]), /NotRefundable/);
    assert.equal(await ctx.swap.call('bondsAtRisk', [t]), 0n);
  });

  test('the juror fraction of a claimed lot funds the court\'s fee pool, in proportion to the quantity it contributed (whitepaper §6.2; R41 (4))', async (t_) => {
    const M = await loadModel();
    if (!M) return t_.skip('the model is not reachable');
    const ctx = await swapStack({ feePool: true, court: 'real' });
    // A priced book: positions anchored and bond principal behind them, so the premium share is not zero.
    await F.anchor(ctx, { notional: 100n * ONE });
    await F.subscribe(ctx, { from: ACCOUNTS.alice, value: 10_000n * ONE });
    const t = await ctx.offer(10n * ONE);
    const p = await ctx.params.call('params');
    const offered = BigInt(M.ark.operationsSplit(Number(p.operationsBps), Number(p.jurorFeeShareBps)).offeredBps);
    const premium = await ctx.registry.call('premiumShareBps');
    assert.ok(premium > 0n && offered > 0n);
    const jurorBps = (offered * BPS) / (premium + offered);
    assert.equal((await ctx.swap.call('offeringOf', [CHAIN_ID, ASSET_A, t])).jurorBps, jurorBps, 'fixed when the offer is recorded');
    to(ctx, quoteOpens(t));
    const lot = await ctx.quote(t, 'lot', 4n * ONE);
    to(ctx, quoteCloses(t));
    await ctx.swap.send('select', [CHAIN_ID, ASSET_A, t]);
    const res = await ctx.swap.send('claim', [lot.lotId, lot.secret], { from: ACCOUNTS.mallory });
    const fee = (lot.value * jurorBps) / BPS;
    assert.equal(ctx.swap.events(res, 'JurorFeeRouted')[0].args.amount, fee);
    assert.equal(await ctx.court.call('feePool'), fee, 'to the court\'s fee pool');
    assert.equal(await ctx.ledger.call('deliveredIn', [t]), lot.value - fee, 'the premium\'s part to the proceeds of its epoch');
    // With no fee pool named the ledger takes the whole lot, as before (the stand-in court).
    const plain = await selectedLot();
    await plain.ctx.swap.send('claim', [plain.lot.lotId, plain.lot.secret]);
    assert.equal(await plain.ctx.ledger.call('deliveredIn', [plain.t]), plain.lot.value);
  });

  test('I33: a selected lot unclaimed at its QRL expiry returns its QRL to its solver and forfeits its bond to the proceeds of its epoch', async () => {
    const { ctx, t, lot } = await selectedLot();
    assert.equal(await ctx.swap.call('bondsAtRisk', [t]), lot.bond);
    to(ctx, evmExpiry(t));
    await assert.rejects(ctx.swap.send('refund', [lot.lotId]), /NotRefundable/, 'the QRL leg outlasts the origin one');
    await assert.rejects(ctx.swap.send('releaseForfeits', [t]), /ForfeitsNotDue/, 'determined at the QRL expiry and not before');
    to(ctx, qrlExpiry(t));
    await assert.rejects(ctx.swap.send('claim', [lot.lotId, lot.secret]), /LotExpired/);
    const before = await ctx.chain.balanceOf(SOLVER);
    await ctx.swap.send('refund', [lot.lotId], { from: ACCOUNTS.mallory });
    // The free option is gone: the whole lock used to come back here.
    assert.equal((await ctx.chain.balanceOf(SOLVER)) - before, lot.value, 'the lot and not its bond');
    await assert.rejects(ctx.swap.send('refund', [lot.lotId]), /NotRefundable/);
    // The coupon account pulls the forfeit through the ledger before reading the epoch.
    await ctx.ledger.send('collectForfeits', [t], { from: ACCOUNTS.mallory });
    assert.equal(await ctx.ledger.call('deliveredIn', [t]), lot.bond, 'forfeited to the delivered proceeds of the offered epoch');
    assert.equal(await ctx.chain.balanceOf(ctx.swap.address), 0n);
    await ctx.swap.send('releaseForfeits', [t]);
    assert.equal(await ctx.ledger.call('deliveredIn', [t]), lot.bond, 'once');
  });

  test('I33: a forfeited bond is part of the coupon its epoch pays, collected by the distribution itself', async () => {
    const { ctx, t, lot } = await selectedLot();
    to(ctx, qrlExpiry(t));
    await F.distributeDue(ctx);
    assert.equal(await ctx.ledger.call('deliveredIn', [t]), lot.bond);
    assert.ok(BigInt(await ctx.coupon.call('lastDistributed')) >= t);
  });

  test('I33: a quote must post the bond the protocol computes, no more and no less', async () => {
    const ctx = await swapStack();
    const t = await ctx.offer(10n * ONE);
    to(ctx, quoteOpens(t));
    const v = await ctx.swap.call('required', [CHAIN_ID, ASSET_A, t, ONE]);
    const [bond, bps] = await ctx.swap.call('bondFor', [CHAIN_ID, ASSET_A, t, v]);
    assert.equal(bps, BigInt(REFERENCE_PARAMS.solverBondCeilingBps), 'the ceiling at the first offering, whose discount is m_epoch (item 25d)');
    assert.equal(bond, (v * bps) / BPS);
    await assert.rejects(ctx.quote(t, 'none', ONE, { value: v, bond: 0n }), /BondMismatch/);
    await assert.rejects(ctx.quote(t, 'short', ONE, { value: v, bond: bond - 1n }), /BondMismatch/);
    const lot = await ctx.quote(t, 'exact', ONE, { value: v });
    assert.equal((await ctx.swap.call('lotOf', [lot.lotId])).bond, bond);
    // Sent above it, the excess comes straight back: the bond is the protocol's figure, never the solver's.
    const before = await ctx.chain.balanceOf(RIVAL);
    const over = await ctx.quote(t, 'over', ONE, { value: v, bond: bond + ONE, from: RIVAL });
    assert.equal((await ctx.swap.call('lotOf', [over.lotId])).bond, bond);
    assert.ok(before - (await ctx.chain.balanceOf(RIVAL)) === v + bond, 'charged the lot and the computed bond');
  });

  test('lots nobody selected are refundable once the selection window has passed', async () => {
    const ctx = await swapStack();
    const t = await ctx.offer(10n * ONE);
    to(ctx, quoteOpens(t));
    const lot = await ctx.quote(t, 'orphan', ONE);
    to(ctx, quoteCloses(t));
    await assert.rejects(ctx.swap.send('refund', [lot.lotId]), /NotRefundable/);
    to(ctx, quoteCloses(t) + BigInt(DAY));
    await ctx.swap.send('refund', [lot.lotId]);
    await assert.rejects(ctx.swap.send('select', [CHAIN_ID, ASSET_A, t]), /OutsideSelectionWindow/);
  });

  test('a bare transfer is refused: nothing reaches the ledger that no solver locked', async () => {
    const ctx = await swapStack();
    await assert.rejects(ctx.chain.execute(ctx.swap.address, ACCOUNTS.alice, '0x', ONE));
  });
});

describe('the reserve ladder and retention', () => {
  /** Offer and select an epoch in which nothing is quoted: a failed offering. */
  /**
   * An offering nobody quotes. Since the re-audit of 2026-09-30 (SWAPGOV-01)
   * an offer opens only on premium new since the last one, so a run of them
   * grows by a wei each (`shares`); the suites that walk the ladder with it
   * disable batching (a multiple of zero), as a failure is counted only when
   * the next offering is judged.
   */
  async function failedOffering(ctx, t, shares = 10n * ONE) {
    const leaf = ids.premiumOfferLeaf({ chainId: CHAIN_ID, escrow: ESCROW, asset: ASSET_A, epoch: t, shares, units: shares });
    await ctx.attest.send('seal', [t, leaf]);
    await ctx.swap.send('recordOffer', [CHAIN_ID, ESCROW, ASSET_A, t, shares, shares, []]);
    to(ctx, quoteCloses(t));
    await ctx.swap.send('select', [CHAIN_ID, ASSET_A, t]);
  }

  test('an offering that sells below the clearing floor steps the reserve down; retention follows the ladder', async () => {
    const ctx = await swapStack({ params: { offeringBatchMultiple: 0 } });
    const key = ids.assetKey(CHAIN_ID, ASSET_A);
    let t = epochNow(ctx);
    const unsold = BigInt(REFERENCE_PARAMS.unsoldEpochs);
    for (let i = 0n; i < unsold; i++) {
      await failedOffering(ctx, t + i, 10n * ONE + i);
      // Judged when the next offering is selected.
      assert.equal(await ctx.swap.call('failedOfferings', [key]), i === 0n ? 0n : i);
    }
    await failedOffering(ctx, t + unsold, 10n * ONE + unsold);
    assert.equal(await ctx.swap.call('failedOfferings', [key]), 0n);
    const retired = 10n * ONE + unsold - 1n;
    assert.equal(await ctx.swap.call('retainedShares', [key]), retired, 'retained after the seventh failure and offered no more');
    t += unsold + 1n;
    const leaf = ids.premiumOfferLeaf({ chainId: CHAIN_ID, escrow: ESCROW, asset: ASSET_A, epoch: t, shares: 15n * ONE, units: 15n * ONE });
    await ctx.attest.send('seal', [t, leaf]);
    await ctx.swap.send('recordOffer', [CHAIN_ID, ESCROW, ASSET_A, t, 15n * ONE, 15n * ONE, []]);
    assert.equal(await ctx.swap.call('available', [CHAIN_ID, ASSET_A, t]), 15n * ONE - retired);
  });

  test('a stepped reserve is lower, and never below the floor', async () => {
    const ctx = await swapStack({ params: { offeringBatchMultiple: 0 } });
    const t = epochNow(ctx);
    await failedOffering(ctx, t);
    await failedOffering(ctx, t + 1n, 10n * ONE + 1n);
    const q = 10n * ONE + 2n;
    const leaf = ids.premiumOfferLeaf({ chainId: CHAIN_ID, escrow: ESCROW, asset: ASSET_A, epoch: t + 2n, shares: q, units: q });
    await ctx.attest.send('seal', [t + 2n, leaf]);
    await ctx.swap.send('recordOffer', [CHAIN_ID, ESCROW, ASSET_A, t + 2n, q, q, []]);
    to(ctx, quoteOpens(t + 2n));
    await ctx.quote(t + 2n, 'x', ONE);
    const key = ids.assetKey(CHAIN_ID, ASSET_A);
    const k = await ctx.swap.call('failedOfferings', [key]);
    assert.equal(k, 2n);
    const r = await ctx.swap.call('required', [CHAIN_ID, ASSET_A, t + 2n, ONE]);
    assert.equal(r, await ctx.expectedReserve(ONE, { offered: q, failed: k }));
    assert.ok(r < await ctx.expectedReserve(ONE, { offered: q, failed: 0n }));
    assert.ok(r >= (REF_PRICE * (BPS - BigInt(REFERENCE_PARAMS.reserveFloorBps))) / BPS);
  });
});

describe('the commitment bond prices abandonment (I33), and the carry of a retirement is repaid by its yield (I34)', () => {
  /** Record an offer of `shares` for `units` into `t`, sealed into its root. */
  async function record(ctx, t, shares, units = shares) {
    const leaf = ids.premiumOfferLeaf({ chainId: CHAIN_ID, escrow: ESCROW, asset: ASSET_A, epoch: t, shares, units });
    await ctx.attest.send('seal', [t, leaf]);
    await ctx.swap.send('recordOffer', [CHAIN_ID, ESCROW, ASSET_A, t, shares, units, []]);
  }

  test('I33: the bond falls along the ladder as failed offerings step the reserve from d_first past m_epoch, 3,030 bps over five rungs', async () => {
    // Whitepaper §4.7: the ceiling at the first offering (d_first, 400 bps,
    // since 2026-09-30) and at the epoch bound, and less at each rung after
    // it, the ladder anchored at m_epoch (item 25d). Each offering fails: the
    // rival quotes a lot of it at a quarter of the reserve, and the bond it posts
    // is the swap's figure at the rung the offering stands on. Since the
    // audit of 2026-10-03 (OC-SWAP-06) a selected lot abandoned no longer
    // steps the ladder: see the next test.
    const ctx = await swapStack();
    // At the reference 4.00 per cent the discount cap (5,085 bps, whitepaper §4.7) sits above the
    // floor, so the ladder runs to it; at the observed 2.20 the cap binds first and the bond stops there.
    await ctx.oracle.send('setYield', [0n, ZERO, 400n]);
    const t0 = epochNow(ctx);
    const ladder = [];
    for (let i = 0n; i < 5n; i++) {
      const t = t0 + i;
      // New premium at the second offer (SWAPGOV-01); from the third a failure is counted and every offer opens.
      await record(ctx, t, i === 0n ? 10n * ONE : 20n * ONE + i);
      to(ctx, quoteOpens(t));
      const low = (await ctx.swap.call('required', [CHAIN_ID, ASSET_A, t, 10n * ONE])) / 4n;
      const lot = await ctx.quote(t, `walk ${i}`, 10n * ONE, { from: RIVAL, value: low });
      const stored = await ctx.swap.call('lotOf', [lot.lotId]);
      ladder.push(Number((stored.bond * BPS) / stored.value));
      to(ctx, quoteCloses(t));
      await ctx.swap.send('select', [CHAIN_ID, ASSET_A, t]);
      assert.equal((await ctx.swap.call('offeringOf', [CHAIN_ID, ASSET_A, t])).sold, 0n, 'below the reserve: passed over, a failure');
    }
    assert.deepEqual(ladder, [750, 750, 630, 510, 390], 'b(d_t) at each offering, never rising as the discount deepens');
    assert.equal(ladder.reduce((a, b) => a + b, 0), 3030);
    const M = await loadModel();
    if (M) {
      const coupon = Number(await ctx.registry.call('couponAtExactCoverBps', [400n]));
      const model = [0, 1, 2, 3, 4].map((k) => M.ark.solverBondBps(M.params, M.ark.admittedDiscountBps(M.params, coupon, k)));
      assert.deepEqual(ladder, model, 'the model\'s bond at the model\'s rung');
    }
  });

  test('I33 adversarial (OC-SWAP-06): abandoning selected lots walks the reserve nowhere; each abandonment forfeits the ceiling bond to the epoch it was offered for', async () => {
    // The strategic default of the audit of 2026-10-03: win the whole
    // offering, never claim it, and buy the next one at a deeper reserve.
    // Judged on what was sold, the offering is a success, and the bond is the
    // whole price of the lapse.
    const ctx = await swapStack();
    await ctx.oracle.send('setYield', [0n, ZERO, 400n]);
    const t0 = epochNow(ctx);
    const ladder = [];
    let forfeited = 0n;
    for (let i = 0n; i < 4n; i++) {
      const t = t0 + i;
      // The escrow's next snapshot still holds the lapsed lots before it (see the header), and ten units of new premium.
      await record(ctx, t, (i + 1n) * 10n * ONE);
      to(ctx, quoteOpens(t));
      const lot = await ctx.quote(t, `abandon ${i}`, 10n * ONE, { from: RIVAL });
      const stored = await ctx.swap.call('lotOf', [lot.lotId]);
      ladder.push(Number((stored.bond * BPS) / stored.value));
      to(ctx, quoteCloses(t));
      await ctx.swap.send('select', [CHAIN_ID, ASSET_A, t]);
      assert.equal((await ctx.swap.call('lotOf', [lot.lotId])).status, 2n, 'selected, and never claimed');
      assert.equal(await ctx.swap.call('failedOfferings', [ids.assetKey(CHAIN_ID, ASSET_A)]), 0n, 'judged on what it sold: no failure');
      forfeited += stored.bond;
    }
    assert.deepEqual(ladder, [750, 750, 750, 750], 'the ceiling bond at every offering: the reserve never stepped');
    to(ctx, qrlExpiry(t0 + 3n));
    let credited = 0n;
    for (let i = 0n; i < 4n; i++) {
      await ctx.ledger.send('collectForfeits', [t0 + i]);
      credited += await ctx.ledger.call('deliveredIn', [t0 + i]);
    }
    assert.equal(credited, forfeited, 'every bond reached the proceeds of the epoch it was offered for');
  });

  test('G8: an offering is priced and judged on the parameters in force when it was recorded', async () => {
    const ctx = await swapStack();
    const t = epochNow(ctx);
    await record(ctx, t, 10n * ONE);
    const before = await ctx.swap.call('required', [CHAIN_ID, ASSET_A, t, ONE]);
    // A vote staged in the offering's epoch, in force before its quote window opens.
    // Each a quarter-range step at most: value-transfer keys since 2026-09-30.
    await F.voteParams(ctx.params, { maxEpochMoveBps: 2875, clearingFloorBps: 6250, solverBondCeilingBps: 1000 });
    F.toNextEpoch(ctx);
    assert.equal(BigInt((await ctx.params.call('params')).maxEpochMoveBps), 2875n, 'in force now');
    to(ctx, quoteOpens(t));
    assert.equal(await ctx.swap.call('required', [CHAIN_ID, ASSET_A, t, ONE]), before, 'the reserve of the snapshot, not of the vote');
    assert.equal(before, await ctx.expectedReserve(ONE, { offered: 10n * ONE }));
    const [, bps] = await ctx.swap.call('bondFor', [CHAIN_ID, ASSET_A, t, ONE]);
    assert.equal(bps, 750n, 'the bond ceiling of the snapshot');
    const o = await ctx.swap.call('offeringOf', [CHAIN_ID, ASSET_A, t]);
    assert.equal(o.maxEpochMoveBps, 2500n);
    assert.equal(o.clearingFloorBps, 5000n);
    // The next offering, recorded now, carries the new set (new premium: SWAPGOV-01).
    await record(ctx, t + 1n, 11n * ONE);
    const next = await ctx.swap.call('offeringOf', [CHAIN_ID, ASSET_A, t + 1n]);
    assert.equal(next.maxEpochMoveBps, 2875n);
    assert.equal(next.solverBondCeilingBps, 1000n);
  });

  test('I34: a retirement records a carry at d_last, the discount it was last offered at, and suspends issuance; the retained yield is offered and repays it', async () => {
    // Batching off, and each offer a wei larger: an offer opens on new premium only (SWAPGOV-01).
    const ctx = await swapStack({ params: { offeringBatchMultiple: 0 } });
    const key = ids.assetKey(CHAIN_ID, ASSET_A);
    const t0 = epochNow(ctx);
    const unsold = BigInt(REFERENCE_PARAMS.unsoldEpochs);
    for (let i = 0n; i <= unsold; i++) {
      await record(ctx, t0 + i, 10n * ONE + i);
      to(ctx, quoteCloses(t0 + i));
      await ctx.swap.send('select', [CHAIN_ID, ASSET_A, t0 + i]);
    }
    const R = 10n * ONE + unsold - 1n;
    assert.equal(await ctx.swap.call('retainedShares', [key]), R);
    assert.equal(await ctx.swap.call('retainedUnits', [key]), R);
    // Valued at the reference price less d_last = min(d_floor, d_cap), the
    // discount the retiring offering was priced at (SP-07, 2026-09-30): at
    // the observed 2.20 per cent the delivered-coupon bound binds first.
    const coupon = await ctx.registry.call('couponAtExactCoverBps', [220n]);
    const inadmissible = (BigInt(REFERENCE_PARAMS.tailPremiumFloorBps) * BPS + coupon - 1n) / coupon;
    const cap = inadmissible >= BPS ? 0n : BPS - inadmissible;
    const floor = BigInt(REFERENCE_PARAMS.reserveFloorBps);
    const dLast = cap < floor ? cap : floor;
    assert.ok(dLast < floor, 'd_cap binds first on this book');
    const carry = (((R * REF_PRICE) / PRICE_SCALE) * (BPS - dLast)) / BPS;
    const M = await loadModel();
    if (M) {
      assert.equal(Number(dLast), M.ark.admittedDiscountBps(M.params, Number(coupon), Number(unsold) - 1), 'the model\'s rung at the retention period');
      assert.equal(carry, M.ark.shortfallCarryQrl(R, REF_PRICE, Number(dLast)));
    }
    assert.equal(await ctx.swap.call('shortfallCarry', [key]), carry);
    assert.equal(await ctx.ledger.call('shortfallCarry'), carry, 'the total the bond reads');
    // Whitepaper §4.7 condition 3: issuance is suspended while the shortfall is unrecovered.
    await assert.rejects(F.subscribe(ctx, { value: 1000n * ONE }), /CouponShortfallUnrecovered/);
    assert.equal((await ctx.bond.call('state')).shortfallOpen, true);

    // The next offering: the escrow's pot has rebased by a tenth, and five more
    // shares arrived. The retained units need 9.09... of the ten shares now;
    // the rest is their yield, offered first.
    const t = t0 + unsold + 1n;
    const shares = 15n * ONE;
    const units = 165n * ONE / 10n;
    await record(ctx, t, shares, units);
    to(ctx, quoteOpens(t));
    const need = (R * shares + units - 1n) / units;
    const avail = shares - need;
    const lot = await ctx.quote(t, 'repays', avail);
    const released = R - need;
    assert.equal(await ctx.swap.call('retainedShares', [key]), need, 'the retained units are held constant');
    assert.equal(await ctx.swap.call('carryShares', [key]), released);
    to(ctx, quoteCloses(t));
    await ctx.swap.send('select', [CHAIN_ID, ASSET_A, t]);
    await ctx.swap.send('claim', [lot.lotId, lot.secret]);
    const repaid = (lot.value * released) / avail;
    assert.ok(repaid > 0n);
    assert.equal(await ctx.swap.call('shortfallCarry', [key]), carry - repaid, 'monotone decreasing, by the QRL the yield fetched');
    assert.equal(await ctx.ledger.call('shortfallCarry'), carry - repaid);
    assert.equal(await ctx.swap.call('carryShares', [key]), 0n);
    assert.equal(await ctx.ledger.call('deliveredIn', [t]), lot.value, 'repaid on the delivered-proceeds path, as the coupon of its epoch');
  });

  test('I34: the carry is repaid in full and never below zero, and issuance reopens', async () => {
    // A thousand base units an offering: below the batching threshold, so
    // batching is off here (a multiple of zero) and every epoch offers.
    const ctx = await swapStack({ params: { offeringBatchMultiple: 0 } });
    const key = ids.assetKey(CHAIN_ID, ASSET_A);
    const t0 = epochNow(ctx);
    const unsold = BigInt(REFERENCE_PARAMS.unsoldEpochs);
    // A small retirement against a large later rebase, so one sale repays it all.
    // Each a wei larger: an offer opens on new premium only (SWAPGOV-01).
    for (let i = 0n; i <= unsold; i++) {
      await record(ctx, t0 + i, 1000n + i);
      to(ctx, quoteCloses(t0 + i));
      await ctx.swap.send('select', [CHAIN_ID, ASSET_A, t0 + i]);
    }
    const carry = await ctx.swap.call('shortfallCarry', [key]);
    assert.ok(carry > 0n);
    const t = t0 + unsold + 1n;
    await record(ctx, t, 1000n, 1_000_000n);
    to(ctx, quoteOpens(t));
    // Before the first quote judges the last offering, the view does not yet count the released yield.
    const R = await ctx.swap.call('retainedUnits', [key]);
    const need = (R * 1000n + 1_000_000n - 1n) / 1_000_000n;
    const lot = await ctx.quote(t, 'all', 1000n - need, { value: 10n ** 24n });
    to(ctx, quoteCloses(t));
    await ctx.swap.send('select', [CHAIN_ID, ASSET_A, t]);
    await ctx.swap.send('claim', [lot.lotId, lot.secret]);
    assert.equal(await ctx.swap.call('shortfallCarry', [key]), 0n);
    assert.equal(await ctx.ledger.call('shortfallCarry'), 0n);
    assert.equal((await ctx.bond.call('state')).shortfallOpen, false, 'recovered: issuance is no longer suspended on it');
  });
});

describe('audit 2026-09-29: the juror fraction of epoch t, a full book, and a reserve fixed by the window (QL-15, QL-17)', () => {
  /** Funded accounts that quote as separate solvers. */
  const sybil = (i) => '0x' + (0x7000 + i).toString(16).padStart(40, '0');
  async function sybils(ctx, n) {
    for (let i = 0; i < n; i++) await ctx.chain.fund(sybil(i), 10n ** 30n);
  }

  test('a premium share of zero in epoch t: every lot is juror fraction, and its claim pays the fee pool without calling the ledger with zero (QL-15; PoC H-5)', async () => {
    const ctx = await swapStack({ feePool: true, court: 'real' });
    assert.equal(await ctx.registry.call('premiumShareBps'), 0n, 'no bond principal: no cover sold');
    const t = await ctx.offer(10n * ONE);
    const o = await ctx.swap.call('offeringOf', [CHAIN_ID, ASSET_A, t]);
    assert.equal(o.jurorBps, BPS, 'the escrow offered the juror fraction alone');
    to(ctx, quoteOpens(t));
    const lot = await ctx.quote(t, 'lot', 4n * ONE);
    to(ctx, quoteCloses(t));
    await ctx.swap.send('select', [CHAIN_ID, ASSET_A, t]);
    const res = await ctx.swap.send('claim', [lot.lotId, lot.secret]);
    assert.equal(ctx.swap.events(res, 'LotClaimed').length, 1, 'the claim no longer reverts ZeroValue');
    assert.equal(await ctx.court.call('feePool'), lot.value, 'all of it to the fee pool');
    assert.equal(await ctx.ledger.call('deliveredIn', [t]), 0n);
    // The solver's bond comes back: the lot was claimed, not abandoned.
    const before = await ctx.chain.balanceOf(SOLVER);
    await ctx.swap.send('refund', [lot.lotId]);
    assert.equal((await ctx.chain.balanceOf(SOLVER)) - before, lot.bond);
  });

  test('jurorBps is the premium share of the offered epoch t, noted in t, not the share when the offer reaches QRL (QL-15)', async () => {
    const ctx = await swapStack({ feePool: true, court: 'real' });
    await F.anchor(ctx, { notional: 100n * ONE });
    await F.subscribe(ctx, { from: ACCOUNTS.alice, value: 10_000n * ONE });
    const t = epochNow(ctx);
    const premiumT = await ctx.registry.call('premiumShareBps');
    // Read from the event: the view `premiumShareAt` left the swap for its v3 room (re-audit 2026-09-30).
    const [noted] = ctx.swap.events(await ctx.swap.send('noteShare', [], { from: ACCOUNTS.mallory }), 'PremiumShareNoted');
    assert.deepEqual([noted.args.epoch, noted.args.premiumBps], [t, premiumT]);
    // The book moves in t + 1, and the offer of t is recorded then.
    F.toNextEpoch(ctx);
    await F.subscribe(ctx, { from: ACCOUNTS.alice, value: 20_000n * ONE });
    const premiumNow = await ctx.registry.call('premiumShareBps');
    assert.notEqual(premiumNow, premiumT, 'the share moved');
    const recorded = await ctx.offer(10n * ONE, { epoch: t, raw: true });
    const p = await ctx.params.call('params');
    const M = await loadModel();
    const offered = M ? BigInt(M.ark.operationsSplit(Number(p.operationsBps), Number(p.jurorFeeShareBps)).offeredBps) : null;
    const o = await ctx.swap.call('offeringOf', [CHAIN_ID, ASSET_A, t]);
    if (offered !== null) assert.equal(o.jurorBps, (offered * BPS) / (premiumT + offered), 'on the share of t');
    assert.equal(ctx.swap.events(recorded, 'PremiumShareNoted')[0].args.epoch, t + 1n, 'the record noted t + 1 in passing');
  });

  test('a full book takes a strictly better quote by evicting its worst lot, refundable at once; an equal one is refused (QL-17; PoC H-7)', async () => {
    const ctx = await swapStack();
    await sybils(ctx, 4);
    const t = await ctx.offer(10n * ONE);
    to(ctx, quoteOpens(t));
    // The blockade: thirty-two whole-quantity lots at the reserve, eight per solver.
    const lots = [];
    for (let i = 0; i < 32; i++) lots.push(await ctx.quote(t, 'grief' + i, 10n * ONE, { from: sybil(Math.floor(i / 8)) }));
    const req = await ctx.swap.call('required', [CHAIN_ID, ASSET_A, t, 10n * ONE]);
    await assert.rejects(ctx.quote(t, 'equal', 10n * ONE, { value: req }), /TooManyLots/, 'not strictly better: refused');
    const honest = await ctx.quote(t, 'honest', 10n * ONE, { value: req * 2n });
    const worst = lots[31];
    const w = await ctx.swap.call('lotOf', [worst.lotId]);
    assert.equal(w.status, 5n, 'the latest of the worst-priced lots is evicted');
    const book = await ctx.swap.call('lotsOf', [CHAIN_ID, ASSET_A, t]);
    assert.equal(book.length, 32);
    assert.ok(book.includes(honest.lotId) && !book.includes(worst.lotId));
    const before = await ctx.chain.balanceOf(sybil(3));
    await ctx.swap.send('refund', [worst.lotId], { from: ACCOUNTS.mallory });
    assert.equal((await ctx.chain.balanceOf(sybil(3))) - before, worst.value + worst.bond, 'QRL and bond back at once');
    to(ctx, quoteCloses(t));
    const res = await ctx.swap.send('select', [CHAIN_ID, ASSET_A, t]);
    assert.deepEqual(ctx.swap.events(res, 'LotSelected').map((e) => e.args.lotId), [honest.lotId], 'the better bid is sold');
  });

  test('one solver holds at most eight lots of an offering (QL-17)', async () => {
    const ctx = await swapStack();
    const t = await ctx.offer(64n * ONE);
    to(ctx, quoteOpens(t));
    // MAX_LOTS_PER_SOLVER, 8, is internal since the re-audit of 2026-09-30 (the swap's v3 room): the ninth lot shows it.
    for (let i = 0; i < 8; i++) await ctx.quote(t, 'mine' + i, 2n * ONE, { from: RIVAL });
    await assert.rejects(ctx.quote(t, 'ninth', 2n * ONE, { from: RIVAL }), /SolverLotsFull/);
    await ctx.quote(t, 'other', 2n * ONE);
  });

  test('the reserve is fixed by the window: a price rise after it no longer voids the lots quoted at the reserve (QL-17; PoC H-7 part 3)', async () => {
    const ctx = await swapStack();
    await sybils(ctx, 4);
    const t = await ctx.offer(10n * ONE);
    to(ctx, quoteOpens(t));
    const lots = [];
    for (let i = 0; i < 32; i++) lots.push(await ctx.quote(t, 'grief' + i, 10n * ONE, { from: sybil(Math.floor(i / 8)) }));
    to(ctx, quoteCloses(t));
    await ctx.oracle.send('set', [REF_PRICE + REF_PRICE / 100n, REF_PRICE, REF_PRICE]);
    await ctx.swap.send('select', [CHAIN_ID, ASSET_A, t]);
    const o = await ctx.swap.call('offeringOf', [CHAIN_ID, ASSET_A, t]);
    assert.equal(o.sold, 10n * ONE, 'a lot at the reserve of the window is sold');
    assert.equal(await ctx.swap.call('bondsAtRisk', [t]), lots[0].bond, 'and its bond is at risk: the blockade is no longer free');
  });
});

describe('batching: an offer below the threshold is carried, at most four epochs and never after a failure (whitepaper §4.7, EC-03, PV-05, PV-13)', () => {
  /** The threshold at the reference values: 50 x 600,000 gwei of an eighteen-decimal asset, 0.03 of a unit. */
  const THRESHOLD = (50n * 600_000n * 10n ** 18n) / 10n ** 9n;
  const small = THRESHOLD / 10n;

  /** Seal and present `epoch`'s offer; the receipt. */
  async function present(ctx, epoch, shares, units = shares) {
    const leaf = ids.premiumOfferLeaf({ chainId: CHAIN_ID, escrow: ESCROW, asset: ASSET_A, epoch, shares, units });
    await ctx.attest.send('seal', [epoch, leaf]);
    return ctx.swap.send('recordOffer', [CHAIN_ID, ESCROW, ASSET_A, epoch, shares, units, []], { from: ACCOUNTS.mallory });
  }

  test('the threshold is the model\'s, and an offer under it records no offering: nothing offered, nothing failed, the reserve unmoved', async () => {
    const ctx = await swapStack();
    const M = await loadModel();
    if (M) assert.equal(THRESHOLD, M.ark.offeringBatchThresholdUnits(M.params), 'offeringBatchThresholdUnits at 10^18');
    assert.equal(await ctx.swap.call('OFFERING_CARRY_MAX_EPOCHS'), 4n);
    if (M) assert.equal(Number(await ctx.swap.call('OFFERING_CARRY_MAX_EPOCHS')), M.ark.OFFERING_CARRY_MAX_EPOCHS);
    const t = epochNow(ctx);
    const res = await present(ctx, t, small);
    const [ev] = ctx.swap.events(res, 'OfferingCarried');
    assert.equal(ev.args.units, small);
    assert.equal(ev.args.threshold, THRESHOLD);
    assert.equal(ev.args.carriedEpochs, 0n);
    assert.equal(ctx.swap.events(res, 'OfferRecorded').length, 0);
    assert.equal((await ctx.swap.call('offeringOf', [CHAIN_ID, ASSET_A, t])).recorded, false);
    to(ctx, quoteOpens(t));
    await assert.rejects(ctx.quote(t, 'none', 1n, { value: 1n }), /NoOffer/);
    to(ctx, quoteCloses(t));
    await assert.rejects(ctx.swap.send('select', [CHAIN_ID, ASSET_A, t]), /NoOffer/);
    assert.equal(await ctx.swap.call('failedOfferings', [ids.assetKey(CHAIN_ID, ASSET_A)]), 0n, 'nothing failed');
    // The same epoch presented again is refused, as a recorded one is.
    await assert.rejects(present(ctx, t, small), /OfferExists/);
    // The quantity at the threshold opens an offering.
    const opened = await present(ctx, t + 1n, THRESHOLD);
    assert.equal(ctx.swap.events(opened, 'OfferRecorded').length, 1);
    await assert.rejects(present(ctx, t, small), /OfferExists/, 'offers only move forward');
  });

  test('a quantity carried four epochs opens whatever its size (adversarial: a wound-down book never strands its premium)', async () => {
    const ctx = await swapStack();
    const t = epochNow(ctx);
    for (let i = 0n; i < 4n; i++) {
      const res = await present(ctx, t + i, small + i);
      assert.equal(ctx.swap.events(res, 'OfferingCarried')[0].args.carriedEpochs, i);
      const M = await loadModel();
      if (M) assert.equal(M.ark.offeringOpens(M.params, small + i, 10n ** 18n, Number(i), 0), false);
    }
    const res = await present(ctx, t + 4n, small + 4n);
    assert.equal(ctx.swap.events(res, 'OfferRecorded').length, 1, 'the fifth epoch offers what the four carried');
    const M = await loadModel();
    if (M) assert.equal(M.ark.offeringOpens(M.params, small + 4n, 10n ** 18n, 4, 0), true);
    assert.equal((await ctx.swap.call('offeringOf', [CHAIN_ID, ASSET_A, t + 4n])).offered, small + 4n);
    // The carry is spent: the next small offer starts a new one.
    const next = await present(ctx, t + 5n, small);
    assert.equal(ctx.swap.events(next, 'OfferingCarried')[0].args.carriedEpochs, 0n);
  });

  test('a quantity that has failed an offering is never batched, and the judge reaches it across a carried epoch', async () => {
    const ctx = await swapStack();
    const key = ids.assetKey(CHAIN_ID, ASSET_A);
    const t = epochNow(ctx);
    // An offering at the threshold that nobody quotes: a failure.
    await present(ctx, t, THRESHOLD);
    to(ctx, quoteCloses(t));
    await ctx.swap.send('select', [CHAIN_ID, ASSET_A, t]);
    // The next epoch is carried (its new premium, small, is below the
    // threshold); the one after adds the threshold and opens, and its
    // selection judges the offering of t, two epochs back, not the carried
    // one. The pot keeps t's unsold quantity, which is not new (SWAPGOV-01).
    await present(ctx, t + 1n, THRESHOLD + small);
    await present(ctx, t + 2n, 2n * THRESHOLD + small);
    assert.equal((await ctx.swap.call('offeringOf', [CHAIN_ID, ASSET_A, t + 2n])).prevPlusOne, t + 1n, 'the offering before it is t');
    to(ctx, quoteCloses(t + 2n));
    await ctx.swap.send('select', [CHAIN_ID, ASSET_A, t + 2n]);
    assert.equal(await ctx.swap.call('failedOfferings', [key]), 1n, 'the offering of t judged across the carried epoch');
    // A failed quantity below the threshold is offered every epoch.
    const res = await present(ctx, t + 3n, 2n * THRESHOLD + 2n * small);
    assert.equal(ctx.swap.events(res, 'OfferRecorded').length, 1, 'never batched after a failure');
    const M = await loadModel();
    if (M) assert.equal(M.ark.offeringOpens(M.params, small, 10n ** 18n, 0, 2), true);
  });

  test('the juror fraction of an offering that carries several epochs is their quantity-weighted mix (offeringJurorBps)', async (t_) => {
    const M = await loadModel();
    if (!M) return t_.skip('the model is not reachable');
    const ctx = await swapStack({ feePool: true, court: 'real' });
    const t = epochNow(ctx);
    // Epoch t: no cover sold, a premium share of zero: all juror fraction.
    const [nT] = ctx.swap.events(await ctx.swap.send('noteShare', [], { from: ACCOUNTS.mallory }), 'PremiumShareNoted');
    assert.equal(nT.args.epoch, t);
    const shareT = nT.args.premiumBps;
    assert.equal(shareT, 0n);
    await present(ctx, t, small);
    // Epoch t + 1: a priced book, and the offer grows by three times as much.
    F.toNextEpoch(ctx);
    await F.anchor(ctx, { notional: 100n * ONE });
    await F.subscribe(ctx, { from: ACCOUNTS.alice, value: 10_000n * ONE });
    const [nT1] = ctx.swap.events(await ctx.swap.send('noteShare', [], { from: ACCOUNTS.mallory }), 'PremiumShareNoted');
    assert.equal(nT1.args.epoch, t + 1n);
    const shareT1 = nT1.args.premiumBps;
    assert.ok(shareT1 > 0n);
    // Over the threshold at t + 1: it opens, carrying t.
    await present(ctx, t + 1n, THRESHOLD + small, THRESHOLD + small);
    const p = await ctx.params.call('params');
    const offered = BigInt(M.ark.operationsSplit(Number(p.operationsBps), Number(p.jurorFeeShareBps)).offeredBps);
    const fraction = (premium) => (offered * BPS) / (premium + offered);
    // The model: each epoch's premium and juror quantities in the units it added.
    const grown = [small, THRESHOLD];
    const epochs = [[grown[0], shareT], [grown[1], shareT1]].map(([q, share]) => {
      const juror = (q * fraction(share)) / BPS;
      return { premiumUnits: q - juror, offeredOpsUnits: juror };
    });
    const o = await ctx.swap.call('offeringOf', [CHAIN_ID, ASSET_A, t + 1n]);
    const weighted = (grown[0] * fraction(shareT) + grown[1] * fraction(shareT1)) / (grown[0] + grown[1]);
    assert.equal(o.jurorBps, weighted, 'the increments of units weighted by each epoch\'s fraction');
    // Within a basis point of the model's quantity-weighted mix, which rounds each epoch's juror quantity first.
    const model = BigInt(M.ark.offeringJurorBps(epochs));
    assert.ok(o.jurorBps - model <= 1n && model - o.jurorBps <= 1n, `contract ${o.jurorBps} model ${model}`);
    assert.ok(o.jurorBps < fraction(shareT) && o.jurorBps > fraction(shareT1), 'between the two epochs\' fractions');
  });
});

describe('the re-audit of 2026-09-30: new premium, the fixed reserve, quote order and a late offer (SWAPGOV-01, -06, -10)', () => {
  const THRESHOLD = (50n * 600_000n * 10n ** 18n) / 10n ** 9n;
  async function present(ctx, epoch, shares, units = shares) {
    const leaf = ids.premiumOfferLeaf({ chainId: CHAIN_ID, escrow: ESCROW, asset: ASSET_A, epoch, shares, units });
    await ctx.attest.send('seal', [epoch, leaf]);
    return ctx.swap.send('recordOffer', [CHAIN_ID, ESCROW, ASSET_A, epoch, shares, units, []], { from: ACCOUNTS.mallory });
  }

  test('SWAPGOV-01 (the PoC, now refused): the next offer\'s pot holds the last offering\'s quantity; only its new premium is compared with the threshold', async () => {
    const ctx = await swapStack();
    const t = epochNow(ctx);
    await present(ctx, t, THRESHOLD);
    to(ctx, quoteOpens(t));
    const whole = await ctx.quote(t, 'whole', THRESHOLD);
    to(ctx, quoteCloses(t));
    await ctx.swap.send('select', [CHAIN_ID, ASSET_A, t]);
    await ctx.swap.send('claim', [whole.lotId, whole.secret]);
    const fresh = THRESHOLD / 10n;
    const res = await present(ctx, t + 1n, THRESHOLD + fresh);
    assert.equal(ctx.swap.events(res, 'OfferRecorded').length, 0, 'no dust offering opens');
    assert.equal(ctx.swap.events(res, 'OfferingCarried').length, 1, 'the new tenth is carried');
    const M = await loadModel();
    if (M) assert.equal(M.ark.offeringOpens(M.params, fresh), false, 'the model carries it too');
    // It opens once the new premium reaches the threshold.
    const open = await present(ctx, t + 2n, 2n * THRESHOLD + fresh);
    assert.equal(ctx.swap.events(open, 'OfferRecorded').length, 1);
    assert.equal(await ctx.swap.call('failedOfferings', [ids.assetKey(CHAIN_ID, ASSET_A)]), 0n, 'nothing failed');
  });

  test('SWAPGOV-06 (the PoC, now refused): of lots at one price the latest quoted is evicted, however the book was filled', async () => {
    const ctx = await swapStack();
    const sybil = (i) => '0x' + (0x7000 + i).toString(16).padStart(40, '0');
    for (let i = 0; i < 4; i++) await ctx.chain.fund(sybil(i), 10n ** 30n);
    const t = await ctx.offer(10n * ONE);
    to(ctx, quoteOpens(t));
    const lots = [];
    for (let i = 0; i < 32; i++) {
      const value = i === 0 ? 1000n : i === 5 ? 1001n : 1002n;
      lots.push(await ctx.quote(t, 'l' + i, 10n * ONE, { value, from: sybil(Math.floor(i / 8)) }));
    }
    const x = await ctx.quote(t, 'x', 10n * ONE, { value: 1001n, from: SOLVER });
    assert.equal((await ctx.swap.call('lotOf', [lots[0].lotId])).status, 5n);
    await ctx.quote(t, 'z', 10n * ONE, { value: 1002n, from: ACCOUNTS.alice });
    assert.equal((await ctx.swap.call('lotOf', [x.lotId])).status, 5n, 'the later-quoted X is evicted');
    assert.equal((await ctx.swap.call('lotOf', [lots[5].lotId])).status, 1n, 'the earlier lot 5 stays');
    const book = await ctx.swap.call('lotsOf', [CHAIN_ID, ASSET_A, t]);
    assert.equal(book.length, 32);
  });

  test('SWAPGOV-10 (the PoC, now refused): an offer recorded after its quote window closed is carried, never judged a failed offering', async () => {
    const ctx = await swapStack();
    const t = epochNow(ctx);
    to(ctx, quoteCloses(t) + 3n * BigInt(DAY));
    const late = await present(ctx, t, 10n * ONE);
    assert.equal(ctx.swap.events(late, 'OfferRecorded').length, 0);
    assert.equal(ctx.swap.events(late, 'OfferingCarried').length, 1, 'carried into the next offer');
    await present(ctx, t + 1n, 10n * ONE + 1n);
    to(ctx, quoteOpens(t + 1n));
    await ctx.quote(t + 1n, 'judge', (10n * ONE + 1n + 31n) / 32n, { value: 1n });
    assert.equal(await ctx.swap.call('failedOfferings', [ids.assetKey(CHAIN_ID, ASSET_A)]), 0n, 'nothing failed');
    assert.equal((await ctx.swap.call('offeringOf', [CHAIN_ID, ASSET_A, t + 1n])).offered, 10n * ONE + 1n, 'the late quantity is offered with the next');
  });
});

describe('the coupon is paid from the swap and from nothing else', () => {
  test('the ledger takes a credit from the swap alone', async () => {
    const ctx = await swapStack();
    const t = epochNow(ctx);
    F.toEpoch(ctx, t + 1n);
    await assert.rejects(ctx.ledger.send('deliver', [t], { from: ACCOUNTS.bob, value: ONE }), /OnlySwap/);
  });

  test('a claimed lot is the coupon of its epoch once the settlement window closes', async () => {
    const ctx = await swapStack();
    const t = await ctx.offer(10n * ONE);
    to(ctx, quoteOpens(t));
    const lot = await ctx.quote(t, 'coupon', 4n * ONE);
    to(ctx, quoteCloses(t));
    await ctx.swap.send('select', [CHAIN_ID, ASSET_A, t]);
    await ctx.swap.send('claim', [lot.lotId, lot.secret]);
    to(ctx, qrlExpiry(t));
    await F.distributeDue(ctx);
    assert.ok(BigInt(await ctx.coupon.call('lastDistributed')) >= t);
  });
});
