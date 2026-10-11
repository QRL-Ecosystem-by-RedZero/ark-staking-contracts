/**
 * The valuation oracle after the audit round OC of 2026-10-03 (docs/review/
 * audit-2026-10-03/ORACLE/REPORT.md). Each test is named for the rule the
 * finding broke and asserts the specified behaviour, on the PoC's own
 * history where there was one (ORACLE/oracle-poc.test.js).
 *
 *  - OC-ORC-03: the court values the seat on the ARK price read through
 *    `try`, falling back on the price carried from the last reading
 *    (`carriedArkPrice`, written at every assertion and by
 *    `carryArkPrice`), so a SEVERITY finding can be quoted and asserted
 *    while the oracle is silent for every key. With none ever carried it is
 *    refused, `ArkUnpriced`.
 *  - OC-ORC-04: a silent oracle at the retirement point defers the
 *    retirement; `select` goes through, the failure counts, and the next
 *    failure retires once the price is back.
 *  - OC-ORC-09: the double reverts on every key, keyed prices and the
 *    realised yield included, under `setReverting`, and each post emits its
 *    time.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { keccak256, toUtf8Bytes } = require('ethers');

const F = require('./stake-fixture');
const { coder, Chain } = require('./harness');
const ids = require('../ecdsa-stakings/relayer/lib/identifiers');

const { ACCOUNTS, ONE, TERM, CLASS, PRICE_SCALE, EPOCH, DAY, ASSET_A, CHAIN_ID, ZERO, ESCROW } = F;
const HOLDER = ACCOUNTS.alice;
const OTHER = ACCOUNTS.bob;
const P = PRICE_SCALE;
const EVIDENCE = keccak256(toUtf8Bytes('oc-orc'));
const LOSS = 1;
const SEVERITY = 3;

/**
 * The PoC's declared book: 100 units anchored, 70k junior + 30k senior,
 * vested; the product's court, with thirty jurors at the minimum seat (as
 * `ArkStakeCourt.test.js` seats them), so the pool admits one case.
 */
async function declaredBook() {
  const ctx = await F.deployBondStack({ court: 'real' });
  ctx.s = ctx.chain.at('ArkCatBondSettlement', ctx.bond.address);
  ctx.r = ctx.chain.at('ArkCatBondRecovery', ctx.bond.address);
  ctx.pos = [await F.anchor(ctx, { owner: HOLDER, depositor: HOLDER, nonce: 0n, notional: 100n * ONE })];
  ctx.chain.advanceTime(91 * DAY);
  await F.subscribe(ctx, { from: HOLDER, class_: CLASS.JUNIOR, term: TERM.QUARTER, value: 70_000n * ONE });
  await F.subscribe(ctx, { from: OTHER, class_: CLASS.SENIOR, term: TERM.QUARTER, value: 30_000n * ONE });
  for (let i = 0; i < 30; i++) {
    const j = '0x' + (0x2000 + i).toString(16).padStart(40, '0');
    await ctx.ark.send('transfer', [j, F.JUROR_MIN_STAKE], { from: ACCOUNTS.admin });
    await ctx.ark.send('approve', [ctx.jurorPool.address, F.JUROR_MIN_STAKE], { from: j });
    await ctx.jurorPool.send('stake', [F.JUROR_MIN_STAKE], { from: j });
  }
  F.toNextEpoch(ctx);
  return ctx;
}

/** Declared, opened, and held under an oracle silent for every key, then past 3 W_a: a SEVERITY finding is open. */
async function heldUnderDeadOracle(ctx) {
  await F.declare(ctx, BigInt(ctx.chain.timestamp));
  await ctx.r.send('recordClaimants', [ctx.pos.map((p) => p.id)], { from: ACCOUNTS.mallory });
  await ctx.s.send('settleDeclaration', [], { from: ACCOUNTS.mallory });
  const t2 = await ctx.s.call('declaration');
  F.toEpoch(ctx, t2.epoch + 4n);
  await ctx.oracle.send('setReverting', [true]);
  const r = await ctx.s.send('settleSeverity');
  assert.equal(ctx.s.events(r, 'SeverityHeld').length, 1, 'HELD');
  F.toEpoch(ctx, t2.epoch + 4n + 8n + 1n);
}

describe('OC-ORC-03: the court route out of a HOLD reads the ARK price through try, with a carried fallback', () => {
  test('oracle dead for every key after an ARK price was seen: SEVERITY is quoted at the carried price and asserted', async () => {
    const ctx = await declaredBook();
    assert.equal(await ctx.findings.call('carriedArkPrice'), 0n);
    await ctx.oracle.send('setPriceFor', [0n, ctx.ark.address, 100n * P]);
    await ctx.findings.send('carryArkPrice', [], { from: ACCOUNTS.mallory }); // any sender
    assert.equal(await ctx.findings.call('carriedArkPrice'), 100n * P);
    await heldUnderDeadOracle(ctx);
    await assert.rejects(() => ctx.oracle.call('observe', [0n, ctx.ark.address]), /OracleUnavailable/, 'ARK is silent too');

    const payload = coder.encode(['uint256'], [7_000n]);
    const q = await ctx.findings.call('quote', [SEVERITY, payload]);
    const held = (await ctx.s.call('declaration')).held;
    assert.equal(q[0], held, 'V: the held balance');
    assert.equal(q[1], (held * P + 100n * P - 1n) / (100n * P), 'V in ARK at the carried price, rounded up');
    // The carry is not overwritten by a silent reading.
    await ctx.findings.send('carryArkPrice');
    assert.equal(await ctx.findings.call('carriedArkPrice'), 100n * P);

    const res = await ctx.court.send('assertFinding', [SEVERITY, payload, EVIDENCE], { from: OTHER, value: q[3] * q[4] });
    assert.ok(ctx.court.events(res, 'AssertionOpened').length >= 1, 'the held balance reaches the court');
  });

  test('every assertion carries the ARK price it read; with none ever carried a dead oracle is refused as ArkUnpriced', async () => {
    const ctx = await declaredBook();
    await ctx.oracle.send('setPriceFor', [0n, ctx.ark.address, 250n * P]);
    const payload = coder.encode(['bytes32[]', 'uint256[]'], [[ctx.pos[0].id], [10n * ONE]]);
    const q = await ctx.findings.call('quote', [LOSS, payload], { from: HOLDER });
    assert.equal(await ctx.findings.call('carriedArkPrice'), 0n, 'a quote is a view and carries nothing');
    await ctx.court.send('assertFinding', [LOSS, payload, EVIDENCE], { from: HOLDER, value: q[3] * q[4] });
    assert.equal(await ctx.findings.call('carriedArkPrice'), 250n * P, 'carried at the assertion');

    const fresh = await declaredBook();
    await heldUnderDeadOracle(fresh);
    await assert.rejects(
      () => fresh.findings.call('quote', [SEVERITY, coder.encode(['uint256'], [7_000n])]),
      /ArkUnpriced/,
      'no price now and none carried',
    );
  });
});

/* ------------------------------------------------------------------ */
/* OC-ORC-04                                                           */
/* ------------------------------------------------------------------ */

const epochNow = (ctx) => BigInt(ctx.chain.timestamp) / BigInt(EPOCH);
const quoteCloses = (t) => (BigInt(t) + 2n) * BigInt(EPOCH);
const offerOpens = (t) => BigInt(t) * BigInt(EPOCH) + 2n * BigInt(DAY);
const KEY = ids.assetKey(CHAIN_ID, ASSET_A);

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
  const present = async (epoch, shares) => {
    const leaf = ids.premiumOfferLeaf({ chainId: CHAIN_ID, escrow: ESCROW, asset: ASSET_A, epoch, shares, units: shares });
    await ctx.attest.send('seal', [epoch, leaf]);
    return swap.send('recordOffer', [CHAIN_ID, ESCROW, ASSET_A, epoch, shares, shares, []], { from: ACCOUNTS.mallory });
  };
  return { ...ctx, swap, present };
}

describe('OC-ORC-04: a silent oracle at the retirement point defers the retirement, never reverts select', () => {
  test('the unsoldEpochs-th failure judged under a dead oracle: select goes through, the failure counts, and the next failure retires once the price is back', async () => {
    const ctx = await swapStack();
    const Q = 10n * ONE;
    const t = epochNow(ctx);
    // SWAPGOV-11's history: an unsold offering, carried while nothing is new, then judged.
    await ctx.present(t, Q);
    const unsold = BigInt((await ctx.swap.call('offeringOf', [CHAIN_ID, ASSET_A, t])).unsoldEpochs);
    to(ctx, quoteCloses(t));
    await ctx.swap.send('select', [CHAIN_ID, ASSET_A, t]);
    let e = t + 1n;
    for (; ; e += 1n) {
      to(ctx, offerOpens(e));
      if (ctx.swap.events(await ctx.present(e, Q), 'OfferRecorded').length) break;
    }
    to(ctx, quoteCloses(e));
    await ctx.swap.send('select', [CHAIN_ID, ASSET_A, e]);
    assert.equal(await ctx.swap.call('failedOfferings', [KEY]), 1n);
    // A failure counted opens every offer at once: one rung an epoch, nobody quoting.
    for (let i = 2n; i < unsold; i += 1n) {
      e += 1n;
      to(ctx, offerOpens(e));
      await ctx.present(e, Q);
      to(ctx, quoteCloses(e));
      const sel = await ctx.swap.send('select', [CHAIN_ID, ASSET_A, e]);
      assert.equal(ctx.swap.events(sel, 'ShortfallCarried').length, 0);
    }
    assert.equal(await ctx.swap.call('failedOfferings', [KEY]), unsold - 1n);

    // The select that judges the unsoldEpochs-th failure, with the oracle dead.
    e += 1n;
    to(ctx, offerOpens(e));
    await ctx.present(e, Q);
    to(ctx, quoteCloses(e));
    await ctx.oracle.send('setReverting', [true]);
    const deferred = await ctx.swap.send('select', [CHAIN_ID, ASSET_A, e]);
    assert.equal(ctx.swap.events(deferred, 'ShortfallCarried').length, 0, 'not retired');
    assert.equal(ctx.swap.events(deferred, 'OfferingSelected').length, 1, 'selected');
    assert.equal(await ctx.swap.call('failedOfferings', [KEY]), unsold, 'the failure counts');
    assert.equal(await ctx.swap.call('retainedShares', [KEY]), 0n, 'the quantity stays on offer');
    assert.equal(await ctx.swap.call('shortfallCarry', [KEY]), 0n);

    // The price back: the next failure retires what the later offering left.
    await ctx.oracle.send('setReverting', [false]);
    e += 1n;
    to(ctx, offerOpens(e));
    await ctx.present(e, Q);
    to(ctx, quoteCloses(e));
    const retired = await ctx.swap.send('select', [CHAIN_ID, ASSET_A, e]);
    const [ev] = ctx.swap.events(retired, 'ShortfallCarried');
    assert.ok(ev, 'retired at the next select');
    assert.equal(await ctx.swap.call('retainedShares', [KEY]), Q, 'what the failed offerings left is retained as buffer');
    assert.ok((await ctx.swap.call('shortfallCarry', [KEY])) > 0n, 'and its carry recorded');
    assert.equal(await ctx.swap.call('failedOfferings', [KEY]), 0n);
  });
});

/* ------------------------------------------------------------------ */
/* OC-ORC-09                                                           */
/* ------------------------------------------------------------------ */

describe('OC-ORC-09: the oracle double is silent for every key under setReverting, and dates its posts', () => {
  test('a keyed price and the realised yield revert under setReverting; set and setPriceFor emit the timestamp', async () => {
    const chain = await Chain.create();
    const oracle = await chain.deploy('MockPriceOracle');
    const ark = '0x' + 'a7'.repeat(20);
    const posted = await oracle.send('set', [10n * P, 11n * P, 12n * P]);
    const [ps] = oracle.events(posted, 'PriceSet');
    assert.deepEqual([ps.args.twapEpoch, ps.args.twap30d, ps.args.twap24hAgo, ps.args.timestamp], [10n * P, 11n * P, 12n * P, BigInt(chain.timestamp)]);
    const keyed = await oracle.send('setPriceFor', [0n, ark, 100n * P]);
    const [pf] = oracle.events(keyed, 'PriceSetFor');
    assert.equal(pf.args.asset.toLowerCase(), ark);
    assert.equal(pf.args.twap30d, 100n * P);
    assert.equal(pf.args.timestamp, BigInt(chain.timestamp));
    await oracle.send('setYield', [0n, ZERO, 300n]);
    assert.equal((await oracle.call('observe', [0n, ark]))[1], 100n * P);

    await oracle.send('setReverting', [true]);
    await assert.rejects(() => oracle.call('observe', [0n, ark]), /OracleUnavailable/, 'the keyed price is silent too');
    await assert.rejects(() => oracle.call('observe', [0n, ZERO]), /OracleUnavailable/);
    await assert.rejects(() => oracle.call('realisedYieldBps', [0n, ZERO]), /OracleUnavailable/);
    await oracle.send('setReverting', [false]);
    assert.equal((await oracle.call('observe', [0n, ark]))[1], 100n * P);
    assert.equal(await oracle.call('realisedYieldBps', [0n, ZERO]), 300n);
  });
});
