/**
 * The premium swap's judgement module and the rule of yellow paper §4.6 on
 * suspended pricing (audit OC 2026-10-03, OC-ORC-04; staking CLAUDE.md item
 * 123).
 *
 *  > "Where the series is silent (section 6.1) or the circuit breaker is
 *  > active when a quote is made, the quote is refused and the refusal
 *  > recorded. An offering in whose window a quote was refused, and which
 *  > selects no lot, is carried whole to the next epoch: $k_t$ and the count
 *  > toward the retention period do not advance [...]. An offering whose
 *  > reserve was fixed before the suspension runs to its close at that
 *  > reserve. A retirement reads the epoch-average price of the retired
 *  > epoch and, where the series is silent, waits on the next priced epoch."
 *
 * Each test is named for the rule it defends. The module tests hold the
 * split to its contract: `judge` runs only under the swap's delegatecall,
 * and what it writes lands in the swap's storage at the slots the swap
 * declared before the split (`PremiumSwapStore`'s order), so every suite
 * written against the one contract — PremiumSwap.test.js, OC-SWAP.test.js,
 * OC-ORC.test.js — reads the same state through the same getters.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { keccak256, getCreateAddress, AbiCoder, toUtf8Bytes } = require('ethers');
const { createAddressFromString, hexToBytes, bytesToHex } = require('@ethereumjs/util');

const F = require('./stake-fixture');
const ids = require('../ecdsa-stakings/relayer/lib/identifiers');

const { ACCOUNTS, ONE, EPOCH, DAY, ASSET_A, CHAIN_ID, ZERO, ESCROW, REF_PRICE } = F;
const SOLVER = ACCOUNTS.bob;
const EVM_RECIPIENT = '0x' + 'b2'.repeat(20);
const KEY = ids.assetKey(CHAIN_ID, ASSET_A);
const Q = 10n * ONE;
const abi = AbiCoder.defaultAbiCoder();

const epochNow = (ctx) => BigInt(ctx.chain.timestamp) / BigInt(EPOCH);
const quoteOpens = (t) => (BigInt(t) + 2n) * BigInt(EPOCH) - BigInt(DAY);
const quoteCloses = (t) => (BigInt(t) + 2n) * BigInt(EPOCH);
const offerOpens = (t) => BigInt(t) * BigInt(EPOCH) + 2n * BigInt(DAY);

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
  /** Seal and record `epoch`'s offer of `shares` (units = shares); the receipt. */
  const present = async (epoch, shares) => {
    const leaf = ids.premiumOfferLeaf({ chainId: CHAIN_ID, escrow: ESCROW, asset: ASSET_A, epoch, shares, units: shares });
    await ctx.attest.send('seal', [epoch, leaf]);
    return swap.send('recordOffer', [CHAIN_ID, ESCROW, ASSET_A, epoch, shares, shares, []], { from: ACCOUNTS.mallory });
  };
  /** Record `epoch`'s offer of `shares` and require that it opens an offering. */
  const opens = async (epoch, shares) => {
    to(ctx, offerOpens(epoch));
    const res = await present(epoch, shares);
    assert.equal(swap.events(res, 'OfferRecorded').length, 1, `the offer of ${epoch} opens an offering`);
  };
  /** A quote of `shares` at the reserve (or `value`), with the bond the swap computes; the receipt. */
  const quote = async (t, label, shares, { value } = {}) => {
    const v = value ?? (await swap.call('required', [CHAIN_ID, ASSET_A, t, shares]));
    const [bond] = await swap.call('bondFor', [CHAIN_ID, ASSET_A, t, v]);
    const hashlock = ids.hashlockOf(keccak256(toUtf8Bytes(label)));
    return swap.send('quote', [CHAIN_ID, ASSET_A, t, shares, hashlock, EVM_RECIPIENT, v], { from: SOLVER, value: v + bond });
  };
  /** A quote made under a suspension: refused, recorded, refunded whole. */
  const refused = async (t, label) => {
    const hashlock = ids.hashlockOf(keccak256(toUtf8Bytes(label)));
    const before = await ctx.chain.balanceOf(SOLVER);
    const res = await swap.send('quote', [CHAIN_ID, ASSET_A, t, ONE, hashlock, EVM_RECIPIENT, ONE], { from: SOLVER, value: 3n * ONE });
    assert.equal(swap.events(res, 'QuoteRefused').length, 1, 'the refusal recorded');
    assert.equal(swap.events(res, 'LotQuoted').length, 0, 'no lot');
    assert.equal(await ctx.chain.balanceOf(SOLVER), before, 'refunded whole');
    return res;
  };
  const select = (t) => {
    to(ctx, quoteCloses(t));
    return swap.send('select', [CHAIN_ID, ASSET_A, t]);
  };
  const failed = () => swap.call('failedOfferings', [KEY]);
  return { ...ctx, swap, present, opens, quote, refused, select, failed };
}

/** The breaker of the mock: the thirty-day average at a third of the one 24 hours earlier. */
const breakerOn = (ctx) => ctx.oracle.send('set', [REF_PRICE, REF_PRICE / 3n, REF_PRICE]);
const breakerOff = (ctx) => ctx.oracle.send('set', [REF_PRICE, REF_PRICE, REF_PRICE]);

/** A raw storage word of `address`. */
async function slotOf(ctx, address, slot) {
  const v = await ctx.chain.vm.stateManager.getStorage(createAddressFromString(address), hexToBytes(slot));
  return v.length ? BigInt(bytesToHex(v)) : 0n;
}
const mapSlot = (key, keyType, slot) => keccak256(abi.encode([keyType, 'uint256'], [key, slot]));

/* ------------------------------------------------------------------ */
/* Suspended pricing                                                   */
/* ------------------------------------------------------------------ */

describe('yellow paper §4.6, suspended pricing: an offering whose window refused a quote and that sold nothing is carried, no failure counted', () => {
  test('a silent window: the quote is refused and recorded, select goes through, and the judgement carries the offering with failedOfferings unmoved', async () => {
    const ctx = await swapStack();
    const t = epochNow(ctx);
    await ctx.present(t, Q);
    to(ctx, quoteOpens(t));
    await ctx.oracle.send('setSilent', [true]);
    await ctx.refused(t, 'silent');
    const sel = await ctx.select(t); // under silence: nothing reads the oracle
    assert.equal(ctx.swap.events(sel, 'OfferingSelected')[0].args.sold, 0n);
    await ctx.oracle.send('setSilent', [false]);

    const e = t + 1n;
    await ctx.opens(e, 2n * Q);
    const judged = await ctx.select(e);
    const [ev] = ctx.swap.events(judged, 'OfferingSuspended');
    assert.ok(ev, 'carried for suspended pricing');
    assert.equal(ev.args.key, KEY);
    assert.equal(ev.args.epoch, t);
    assert.equal(ev.args.shares, Q, 'whole: what it could sell');
    assert.equal(await ctx.failed(), 0n, 'k_t did not advance');
    assert.equal(await ctx.swap.call('available', [CHAIN_ID, ASSET_A, e]), 2n * Q, 'the quantity is offered again, whole');
  });

  test('the control: the same window with no quote refused is judged failed (one rung)', async () => {
    const ctx = await swapStack();
    const t = epochNow(ctx);
    await ctx.present(t, Q);
    await ctx.select(t);
    await ctx.opens(t + 1n, 2n * Q);
    const judged = await ctx.select(t + 1n);
    assert.equal(ctx.swap.events(judged, 'OfferingSuspended').length, 0);
    assert.equal(await ctx.failed(), 1n);
  });

  test('a breaker window: carried, and a failure counted before stands — neither stepped nor reset', async () => {
    const ctx = await swapStack();
    const t = epochNow(ctx);
    // t fails with nobody quoting: one failure, counted at the selection of t + 1.
    await ctx.present(t, Q);
    await ctx.select(t);
    const e1 = t + 1n;
    await ctx.opens(e1, 2n * Q);
    to(ctx, quoteOpens(e1));
    await breakerOn(ctx);
    assert.equal(await ctx.registry.call('breakerActive'), true);
    await ctx.refused(e1, 'breaker');
    await ctx.select(e1); // judges t: a failure
    assert.equal(await ctx.failed(), 1n);
    await breakerOff(ctx);

    const e2 = t + 2n;
    await ctx.opens(e2, 3n * Q);
    const judged = await ctx.select(e2); // judges e1: carried
    assert.equal(ctx.swap.events(judged, 'OfferingSuspended').length, 1);
    assert.equal(await ctx.failed(), 1n, 'the count toward the retention period did not advance, nor reset');
    assert.equal(ctx.swap.events(judged, 'ShortfallCarried').length, 0);
  });

  test('a refusal recorded in a window that then sold a lot is judged on what it sold: the carry needs "selects no lot"', async () => {
    const ctx = await swapStack();
    const t = epochNow(ctx);
    await ctx.present(t, Q);
    to(ctx, quoteOpens(t));
    await breakerOn(ctx);
    await ctx.refused(t, 'early');
    await breakerOff(ctx);
    // The breaker lifted inside the window: a quote fixes the reserve and a small lot sells, below the clearing floor.
    const least = (Q + 31n) / 32n;
    await ctx.quote(t, 'small', least);
    const sel = await ctx.select(t);
    assert.equal(ctx.swap.events(sel, 'OfferingSelected')[0].args.sold, least);
    await ctx.opens(t + 1n, 2n * Q);
    const judged = await ctx.select(t + 1n);
    assert.equal(ctx.swap.events(judged, 'OfferingSuspended').length, 0, 'not carried');
    assert.equal(await ctx.failed(), 1n, 'a failure: it sold below the clearing floor');
  });

  test('a reserve fixed before the breaker runs to its close: later quotes are taken at it and selected under the breaker, nothing refused', async () => {
    const ctx = await swapStack();
    const t = epochNow(ctx);
    await ctx.present(t, Q);
    to(ctx, quoteOpens(t));
    const half = Q / 2n;
    const a = await ctx.quote(t, 'before', half);
    const fixed = (await ctx.swap.call('offeringOf', [CHAIN_ID, ASSET_A, t])).reserveNum;
    assert.ok(fixed > 0n);
    await breakerOn(ctx);
    const value = ctx.swap.events(a, 'LotQuoted')[0].args.value;
    const b = await ctx.quote(t, 'under', half, { value });
    assert.equal(ctx.swap.events(b, 'QuoteRefused').length, 0, 'not refused');
    assert.equal(ctx.swap.events(b, 'LotQuoted').length, 1);
    const sel = await ctx.select(t);
    assert.equal(ctx.swap.events(sel, 'LotSelected').length, 2, 'both lots at the fixed reserve');
    assert.equal((await ctx.swap.call('offeringOf', [CHAIN_ID, ASSET_A, t])).reserveNum, fixed, 'never read again');
  });
});

/* ------------------------------------------------------------------ */
/* The retirement under a silent series                                */
/* ------------------------------------------------------------------ */

/**
 * Walk an asset to `unsoldEpochs - 1` failures, then judge the last failure
 * with the oracle in `mode` ('silent': `epochAverage` reverts OracleSilent
 * and the yield still answers; 'reverting': nothing answers), and return the
 * stack and the next epoch.
 */
async function toRetirement(mode) {
  const ctx = await swapStack();
  const t = epochNow(ctx);
  await ctx.present(t, Q);
  const unsold = BigInt((await ctx.swap.call('offeringOf', [CHAIN_ID, ASSET_A, t])).unsoldEpochs);
  await ctx.select(t);
  let e = t;
  for (let i = 1n; i < unsold; i += 1n) {
    e += 1n;
    await ctx.opens(e, Q * (i + 1n));
    await ctx.select(e);
  }
  assert.equal(await ctx.failed(), unsold - 1n);
  e += 1n;
  await ctx.opens(e, Q * (unsold + 1n));
  to(ctx, quoteCloses(e));
  await ctx.oracle.send(mode === 'silent' ? 'setSilent' : 'setReverting', [true]);
  const deferred = await ctx.select(e);
  return { ctx, e, unsold, deferred };
}

describe('yellow paper §4.6: a retirement reads the epoch-average price and, where the series is silent, waits on the next priced epoch', () => {
  test('the unsoldEpochs-th failure judged under a silent series (OracleSilent, the yield still answering): select goes through, nothing retires, the next priced failure does', async () => {
    const { ctx, e, unsold, deferred } = await toRetirement('silent');
    assert.equal(ctx.swap.events(deferred, 'OfferingSelected').length, 1, 'selected');
    assert.equal(ctx.swap.events(deferred, 'ShortfallCarried').length, 0, 'not retired');
    assert.equal(await ctx.failed(), unsold, 'the failure counts');
    assert.equal(await ctx.swap.call('retainedShares', [KEY]), 0n);
    assert.equal(await ctx.swap.call('shortfallCarry', [KEY]), 0n);

    await ctx.oracle.send('setSilent', [false]);
    await ctx.opens(e + 1n, Q * (unsold + 2n));
    const retired = await ctx.select(e + 1n);
    const [ev] = ctx.swap.events(retired, 'ShortfallCarried');
    assert.ok(ev, 'retired at the next priced judgement');
    assert.equal(ev.args.epoch, e, 'what the later offering left');
    assert.ok(ev.args.carry > 0n);
    assert.equal(await ctx.swap.call('shortfallCarry', [KEY]), ev.args.carry);
    assert.equal(await ctx.failed(), 0n);
  });

  test('an oracle that does not answer at all (the yield read reverting too) defers the retirement and never reverts select', async () => {
    const { ctx, unsold, deferred } = await toRetirement('reverting');
    assert.equal(ctx.swap.events(deferred, 'ShortfallCarried').length, 0);
    assert.equal(await ctx.failed(), unsold);
  });
});

/* ------------------------------------------------------------------ */
/* The module                                                          */
/* ------------------------------------------------------------------ */

describe('PremiumSwapJudge: the judgement runs in the swap\'s storage, by delegatecall, and nowhere else', () => {
  test('the module is the swap\'s first creation and refuses a direct call (it would act on its own empty storage)', async () => {
    const ctx = await swapStack();
    const judge = getCreateAddress({ from: ctx.swap.address, nonce: 1 });
    const code = await ctx.chain.vm.stateManager.getCode(createAddressFromString(judge));
    assert.ok(code.length > 0, 'deployed by the swap\'s constructor');
    const m = ctx.chain.at('PremiumSwapJudge', judge);
    assert.equal((await m.call('REGISTRY')).toLowerCase(), ctx.registry.address.toLowerCase(), 'the swap\'s dependencies, as its own immutables');
    assert.equal((await m.call('LEDGER')).toLowerCase(), ctx.ledger.address.toLowerCase());
    await assert.rejects(m.send('judge', [KEY, 1n]), /ZeroAddress/);
    // The swap's ABI is the one before the split: no getter for the module.
    assert.equal(ctx.swap.iface.getFunction('JUDGE_MODULE'), null);
    assert.equal(ctx.swap.iface.getFunction('judge'), null);
  });

  test('a retirement through the module writes the swap\'s storage at the pre-split slots, read back through the swap\'s getters', async () => {
    const { ctx, e, unsold } = await toRetirement('silent');
    await ctx.oracle.send('setSilent', [false]);
    await ctx.opens(e + 1n, Q * (unsold + 2n));
    await ctx.select(e + 1n);
    const at = (slot) => slotOf(ctx, ctx.swap.address, slot);
    // ReentrancyGuard first (slot 0), then the declarations in their order of 2026-10-05:
    // _lots 1, _offerings 2, _lotIds 3, _hashlockUsed 4, failedOfferings 5, retainedShares 6,
    // retainedUnits 7, carryShares 8, shortfallCarry 9, bondsAtRisk 10, _shareAt 11,
    // _solverLots 12, _carries 13, _lastOfferPlusOne 14; _quoteRefused 15, appended.
    assert.equal(await at('0x' + '00'.repeat(32)), 1n, '_status: not entered');
    const retained = await ctx.swap.call('retainedShares', [KEY]);
    assert.ok(retained > 0n);
    assert.equal(await at(mapSlot(KEY, 'bytes32', 6n)), retained, 'retainedShares at slot 6');
    assert.equal(await at(mapSlot(KEY, 'bytes32', 7n)), await ctx.swap.call('retainedUnits', [KEY]), 'retainedUnits at slot 7');
    const carry = await ctx.swap.call('shortfallCarry', [KEY]);
    assert.ok(carry > 0n);
    assert.equal(await at(mapSlot(KEY, 'bytes32', 9n)), carry, 'shortfallCarry at slot 9');
    assert.equal(await at(mapSlot(KEY, 'bytes32', 5n)), await ctx.failed(), 'failedOfferings at slot 5');
    assert.equal(await at(mapSlot(KEY, 'bytes32', 14n)), e + 2n, '_lastOfferPlusOne at slot 14');
    // The judged flag the swap sets before the delegatecall sits in the offering's struct.
    assert.equal((await ctx.swap.call('offeringOf', [CHAIN_ID, ASSET_A, e + 1n])).judged, true);
    // The module's own storage is untouched by all of it.
    const judge = getCreateAddress({ from: ctx.swap.address, nonce: 1 });
    assert.equal(await slotOf(ctx, judge, mapSlot(KEY, 'bytes32', 6n)), 0n);
    assert.equal(await slotOf(ctx, judge, mapSlot(KEY, 'bytes32', 9n)), 0n);
  });

  test('the refusal is recorded at the appended slot 15, keyed (asset, epoch)', async () => {
    const ctx = await swapStack();
    const t = epochNow(ctx);
    await ctx.present(t, Q);
    to(ctx, quoteOpens(t));
    const slot = keccak256(abi.encode(['uint256', 'bytes32'], [t, mapSlot(KEY, 'bytes32', 15n)]));
    assert.equal(await slotOf(ctx, ctx.swap.address, slot), 0n);
    await breakerOn(ctx);
    await ctx.refused(t, 'slot');
    assert.equal(await slotOf(ctx, ctx.swap.address, slot), 1n);
  });
});
