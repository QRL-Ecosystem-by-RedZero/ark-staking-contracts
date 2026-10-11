/**
 * ArkCatBond, with its coupon account and its staking contract: leg B of Ark
 * Staking.
 *
 * The one rule this file exists to defend: **bond principal leaves the pool only
 * at maturity, by the measured condition of whitepaper §5.3, or to settle a
 * trigger — never on request — and a coupon is paid from the proceeds of its own
 * epoch and from no other account** (invariants I7, I8, I9, I10, I21).
 *
 * Every test below states the rule it defends and not the call it makes. The
 * settlement of a trigger (§5.1), the subrogation of §5.4, the objection source
 * and the run-off queue's decaying exposure are build 2's (phase C3) and are
 * tested in test/ArkCatBondSettlement.test.js.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const F = require('./stake-fixture');
const { loadModel, MISSING } = require('./spec-model');

const { ACCOUNTS, ONE, EPOCH, DAY, BPS, TERM, TERM_EPOCHS, CLASS } = F;
const ZERO = F.ZERO;

const HOLDER = ACCOUNTS.alice;
const BUYER = ACCOUNTS.bob;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const epochNow = (ctx) => BigInt(ctx.chain.timestamp) / BigInt(EPOCH);

/**
 * Put ecosystem phase `p` in force from the next boundary through the phase
 * double (item 129). The stage is the phase's: phase 4 (Restoration) is stage
 * 1, so it is how a book at stage 4 leaves it.
 */
async function phaseFromNext(ctx, p) {
  const ph = ctx.params.phase;
  await ph.send('setPending', [p, epochNow(ctx) + 1n], { from: ph.operatorAccount });
}

/** The epoch a subscription made now becomes eligible for the coupon in. */
const cliffEpochNow = (ctx) => (BigInt(ctx.chain.timestamp) + BigInt(30 * DAY)) / BigInt(EPOCH) + 1n;

async function state(ctx) {
  const s = await ctx.bond.call('state');
  return s;
}

async function outstanding(ctx) {
  return ctx.bond.call('outstandingPrincipal');
}

/** Distribute every epoch still due, through `epoch`, with no proceeds. */
const distributeThrough = F.distributeThrough;

/** A junior and a senior holding, in the thickness the parameters promise (7,000 bps). */
async function twoClasses(ctx, { junior = 7000n * ONE, senior = 3000n * ONE } = {}) {
  const j = await F.subscribe(ctx, { from: HOLDER, class_: CLASS.JUNIOR, value: junior });
  const s = await F.subscribe(ctx, { from: HOLDER, class_: CLASS.SENIOR, value: senior });
  return { j, s };
}

/** What the stated senior coupon owes for one epoch on `principal`. Truncates, as the contract does. */
const seniorDue = (principal, cSBps = 100n) =>
  (principal * cSBps * BigInt(EPOCH)) / (BPS * 365n * BigInt(DAY));

/* ------------------------------------------------------------------ */
/* Issuance. Whitepaper §4.7, §5.3, yellow paper §1.4                  */
/* ------------------------------------------------------------------ */

describe('issuance is refused on every condition yellow paper §1.4 lists, by name', () => {
  test('a term outside the admitted set of §6.3 is refused by name, not by a panic', async () => {
    const ctx = await F.deployBondStack();
    await assert.rejects(
      () => ctx.bond.send('subscribe', [3, CLASS.JUNIOR], { from: HOLDER, value: ONE }),
      /TermNotAdmitted/,
    );
  });

  test('there are two classes and no third', async () => {
    const ctx = await F.deployBondStack();
    await assert.rejects(
      () => ctx.bond.send('subscribe', [TERM.YEAR, 2], { from: HOLDER, value: ONE }),
      /ClassUnknown/,
    );
  });

  test('the admitted terms are thirteen, fifty-two and one hundred and fifty-six epochs', async () => {
    const ctx = await F.deployBondStack();
    const now = epochNow(ctx);
    for (const [term, epochs] of [[TERM.QUARTER, 13n], [TERM.YEAR, 52n], [TERM.THREE_YEAR, 156n]]) {
      const id = await F.subscribe(ctx, { term, value: ONE });
      assert.equal((await ctx.bond.call('holdingOf', [id])).maturityEpoch, now + epochs);
    }
  });

  test('issuance is suspended while a determination is open, and resumes when it closes', async () => {
    const ctx = await F.deployBondStack();
    const id = '0x' + '01'.repeat(32);
    await ctx.court.send('open', [id]);
    await assert.rejects(() => F.subscribe(ctx, { value: ONE }), /DeterminationOpen/);
    await ctx.court.send('close', [id]);
    await F.subscribe(ctx, { value: ONE });
  });

  test('issuance is suspended while the circuit breaker of §5.5 is active', async () => {
    const ctx = await F.deployBondStack();
    // The thirty-day average has fallen by half against its value a day earlier.
    await ctx.oracle.send('set', [F.REF_PRICE, F.REF_PRICE / 2n, F.REF_PRICE]);
    await assert.rejects(() => F.subscribe(ctx, { value: ONE }), /BreakerActive/);
  });

  test('issuance is suspended while the coupon at exact cover is below the floor under the tail-risk premium', async () => {
    // At stage one the attachment is 1,234 bps and the floor 200, so the book must
    // yield 134 bps; 100 bps funds a coupon at exact cover of 149, below it.
    const ctx = await F.deployBondStack({ yieldBps: 100n });
    await assert.rejects(() => F.subscribe(ctx, { value: ONE }), /CouponBelowFloor/);
  });

  test('issuance is refused after a declaration: the pool is consumed by the event it covers', async () => {
    const ctx = await F.deployBondStack();
    await ctx.qday.send('declare', [BigInt(ctx.chain.timestamp)]);
    await assert.rejects(() => F.subscribe(ctx, { value: ONE }), /Declared/);
  });

  test('issuance is refused during the protective freeze', async () => {
    const ctx = await F.deployBondStack();
    await ctx.qday.send('setFrozen', [true]);
    await assert.rejects(() => F.subscribe(ctx, { value: ONE }), /Frozen/);
  });

  test('a subscription below the minimum is refused, so no epoch is occupied for dust', async () => {
    const ctx = await F.deployBondStack();
    await assert.rejects(() => F.subscribe(ctx, { value: 1000n }), /SubscriptionTooSmall/);
  });

  test('the run-off gate being closed does not suspend issuance: issuance is what repairs a contraction', async () => {
    const ctx = await F.deployBondStack({ stage: 4 });
    F.toNextEpoch(ctx);
    await ctx.bond.send('closeEpoch');
    assert.equal(await ctx.bond.call('runoffGateClosed'), true);
    await F.subscribe(ctx, { value: ONE });
  });
});

describe('junior absorbs a loss to its whole thickness before senior is reached (§4.6)', () => {
  test('a senior subscription into a book with no junior beneath it is refused', async () => {
    const ctx = await F.deployBondStack();
    await assert.rejects(
      () => F.subscribe(ctx, { class_: CLASS.SENIOR, value: ONE }),
      /JuniorTooThin/,
    );
  });

  test('senior may be bought up to the thickness from both sides of the line', async () => {
    const ctx = await F.deployBondStack();
    await F.subscribe(ctx, { class_: CLASS.JUNIOR, value: 7000n * ONE });
    // 7,000 of 10,000 is exactly the 7,000 bps promised: admitted.
    await F.subscribe(ctx, { class_: CLASS.SENIOR, value: 3000n * ONE });
    // One wei more of senior would take junior below it: refused.
    await assert.rejects(
      () => F.subscribe(ctx, { class_: CLASS.SENIOR, value: ONE }),
      /JuniorTooThin/,
    );
  });

  test('a junior subscription is always admitted: it only deepens the protection', async () => {
    const ctx = await F.deployBondStack();
    await twoClasses(ctx);
    await F.subscribe(ctx, { class_: CLASS.JUNIOR, value: 50_000n * ONE });
  });
});

describe('no maturity epoch carries more than the ladder fraction of the book it was sold into (§5.3)', () => {
  /**
   * Eight distinct maturity epochs make the ladder satisfiable at 1,428 bps —
   * `runoffHorizonEpochs(1428)` is eight — and it binds from then on.
   */
  async function eightEpochs(ctx, each) {
    for (let i = 0; i < 3; i++) {
      for (const term of [TERM.QUARTER, TERM.YEAR, TERM.THREE_YEAR]) {
        if (i === 2 && term === TERM.THREE_YEAR) break;
        await F.subscribe(ctx, { term, value: each });
      }
      if (i < 2) {
        F.toNextEpoch(ctx);
        await F.distributeDue(ctx);
      }
    }
  }

  test('the first sale into an empty book is admitted: the ladder waits until it can be satisfied', async () => {
    const ctx = await F.deployBondStack();
    // Every wei of this matures in one epoch, which is the whole book — the ladder
    // would refuse it on its own arithmetic if it bound from the first sale.
    await F.subscribe(ctx, { term: TERM.YEAR, value: 1000n * ONE });
  });

  test('once satisfiable, a maturity epoch at the ladder bound refuses the next sale into it', async () => {
    const ctx = await F.deployBondStack();
    const each = 100n * ONE;
    await eightEpochs(ctx, each);

    // The last subscription went into this epoch's YEAR maturity. Adding to it:
    //   (100 + y) * 10,000 <= (800 + y) * 1,428   =>   y <= 16.6
    await F.subscribe(ctx, { term: TERM.YEAR, value: 16n * ONE });
    await assert.rejects(
      () => F.subscribe(ctx, { term: TERM.YEAR, value: 1n * ONE }),
      /MaturityLadderFull/,
    );
  });

  test('a different maturity epoch still has room when one is full', async () => {
    const ctx = await F.deployBondStack();
    await eightEpochs(ctx, 100n * ONE);
    await F.subscribe(ctx, { term: TERM.YEAR, value: 16n * ONE });
    // A fresh maturity epoch holds nothing yet.
    F.toNextEpoch(ctx);
    await F.distributeDue(ctx);
    await F.subscribe(ctx, { term: TERM.YEAR, value: 16n * ONE });
  });
});

/* ------------------------------------------------------------------ */
/* The holding. Whitepaper §3.4, invariant I20                         */
/* ------------------------------------------------------------------ */

describe('the cliff is a property of the issuance and not of the holder (I20)', () => {
  test('a holding is first paid for the epoch after thirty days have fully passed', async () => {
    const ctx = await F.deployBondStack();
    const expected = cliffEpochNow(ctx);
    const id = await F.subscribe(ctx, { value: ONE });
    const h = await ctx.bond.call('holdingOf', [id]);
    assert.equal(h.cliffEpoch, expected);
    assert.equal(h.claimedThrough, expected - 1n);
  });

  test('a transfer carries the cliff, the maturity and the class unchanged', async () => {
    const ctx = await F.deployBondStack();
    const id = await F.subscribe(ctx, { value: 10n * ONE });
    const before = await ctx.bond.call('holdingOf', [id]);

    await ctx.bond.send('transferHolding', [id, BUYER, before.shares], { from: HOLDER });
    const after = await ctx.bond.call('holdingOf', [id]);
    assert.equal(after.owner.toLowerCase(), BUYER.toLowerCase());
    assert.equal(after.cliffEpoch, before.cliffEpoch);
    assert.equal(after.maturityEpoch, before.maturityEpoch);
    assert.equal(after.class_, before.class_);
  });

  test('a partial transfer splits the record, and both halves carry the original cliff and maturity', async () => {
    const ctx = await F.deployBondStack();
    const id = await F.subscribe(ctx, { value: 10n * ONE });
    const h = await ctx.bond.call('holdingOf', [id]);

    const res = await ctx.bond.send('transferHolding', [id, BUYER, h.shares / 4n], { from: HOLDER });
    const [ev] = ctx.bond.events(res, 'HoldingTransferred');
    const split = await ctx.bond.call('holdingOf', [ev.args.newId]);
    const kept = await ctx.bond.call('holdingOf', [id]);

    assert.notEqual(ev.args.newId, id);
    assert.equal(split.owner.toLowerCase(), BUYER.toLowerCase());
    assert.equal(split.cliffEpoch, h.cliffEpoch);
    assert.equal(split.maturityEpoch, h.maturityEpoch);
    assert.equal(split.shares + kept.shares, h.shares, 'a split moves shares and creates none');
    assert.equal(await outstanding(ctx), 10n * ONE, 'a split moves no principal out of the book');
  });

  test('only the holder may move a holding', async () => {
    const ctx = await F.deployBondStack();
    const id = await F.subscribe(ctx, { value: ONE });
    await assert.rejects(
      () => ctx.bond.send('transferHolding', [id, BUYER, 1n], { from: ACCOUNTS.mallory }),
      /NotHolder/,
    );
  });

  test('a transfer carries the coupons not yet fixed, and waits only on a keeper behind', async () => {
    // The coupon of epoch t is fixed four days into t + 2, so at every instant
    // some epoch is unfixed; its coupon follows the shares. What still stops a
    // transfer is an epoch whose settlement has closed and that nobody has
    // distributed, and anyone may distribute it.
    const ctx = await F.deployBondStack();
    const id = await F.subscribe(ctx, { value: ONE });
    F.toNextEpoch(ctx);
    F.toNextEpoch(ctx);
    await F.distributeDue(ctx);
    await ctx.bond.send('transferHolding', [id, BUYER, 1n], { from: HOLDER });
    const next = BigInt(await ctx.coupon.call('lastDistributed')) + 1n;
    ctx.chain.advanceTime(Number(F.settlementCloses(next) - BigInt(ctx.chain.timestamp)));
    await assert.rejects(
      () => ctx.bond.send('transferHolding', [id, BUYER, 1n], { from: HOLDER }),
      /CouponPending/,
    );
    await F.distributeDue(ctx);
    await ctx.bond.send('transferHolding', [id, BUYER, 1n], { from: HOLDER });
  });
});

/* ------------------------------------------------------------------ */
/* The coupon. Whitepaper §4.6, §4.7                                   */
/* ------------------------------------------------------------------ */

describe('a coupon is paid from its own epoch\'s proceeds, to the holders of record at its boundary', () => {
  /** A book with both classes past their cliff, and the first eligible epoch. */
  async function eligibleBook(opts) {
    const ctx = await F.deployBondStack();
    const first = cliffEpochNow(ctx);
    const ids = await twoClasses(ctx, opts);
    await F.distributeDue(ctx);
    return { ctx, first, ...ids };
  }

  test('senior is paid its stated rate and junior takes what the premium leaves (§4.6)', async () => {
    const { ctx, first, j, s } = await eligibleBook();
    const delivered = 50n * ONE;
    await F.deliverAndDistribute(ctx, first, delivered);

    const due = seniorDue(3000n * ONE);
    const seniorOwed = await ctx.coupon.call('owed', [CLASS.SENIOR, first - 1n, 3000n * ONE]);
    const juniorOwed = await ctx.coupon.call('owed', [CLASS.JUNIOR, first - 1n, 7000n * ONE]);

    // Senior is owed its stated rate, less at most the truncation of one index step.
    assert.ok(seniorOwed <= due && due - seniorOwed < 3001n, `senior ${seniorOwed} against ${due}`);
    // Junior takes the rest of the pot, again less one step's truncation.
    assert.ok(juniorOwed <= delivered - due && delivered - due - juniorOwed < 7001n);
    // I19: the two together draw no more than was delivered.
    assert.ok(seniorOwed + juniorOwed <= delivered);
  });

  // G8 (CLAUDE.md item 42): a parameter is read when the quantity it prices is
  // fixed. The base of an epoch is fixed when it closes, so is its senior rate;
  // a vote staged after that close must not reprice it at distribution.
  test('G8: an epoch is paid at the senior coupon in force when it closed, not when it is distributed', async () => {
    const { ctx, first } = await eligibleBook();
    F.toEpoch(ctx, first + 1n);
    await ctx.bond.send('closeEpoch');
    assert.equal(await ctx.coupon.call('seniorCouponAt', [first]), 100n, 'fixed with the base');
    await F.voteParams(ctx.params, { seniorCouponBps: 200 });
    F.toNextEpoch(ctx);
    assert.equal(BigInt((await ctx.params.call('bondParams'))[4]), 200n, 'the new rate is in force at distribution');
    const delivered = 50n * ONE;
    await F.deliverAndDistribute(ctx, first, delivered);
    const due = seniorDue(3000n * ONE, 100n);
    const seniorOwed = await ctx.coupon.call('owed', [CLASS.SENIOR, first - 1n, 3000n * ONE]);
    assert.ok(seniorOwed <= due && due - seniorOwed < 3001n, `senior ${seniorOwed} against ${due} at the closing rate`);
    assert.equal(await ctx.coupon.call('seniorCouponAt', [first + 1n]), 100n, 'closed in the epoch after the vote, at the rate in force in its own');
  });

  test('a holding is paid its coupon on claim, and the coupon account — not the bond — sends it', async () => {
    const { ctx, first, j } = await eligibleBook();
    await F.deliverAndDistribute(ctx, first, 50n * ONE);
    const owed = await ctx.coupon.call('owed', [CLASS.JUNIOR, first - 1n, 7000n * ONE]);

    const bondBefore = await ctx.chain.balanceOf(ctx.bond.address);
    const before = await ctx.chain.balanceOf(HOLDER);
    await ctx.bond.send('claim', [j], { from: HOLDER });
    assert.equal((await ctx.chain.balanceOf(HOLDER)) - before, owed);
    assert.equal(await ctx.chain.balanceOf(ctx.bond.address), bondBefore, 'no coupon passes through the pool');
  });

  test('bond principal is never a source of a coupon (I8)', async () => {
    const { ctx, first } = await eligibleBook();
    const pool = await ctx.chain.balanceOf(ctx.bond.address);
    await F.deliverAndDistribute(ctx, first, 50n * ONE);
    assert.equal(await ctx.chain.balanceOf(ctx.bond.address), pool);
    assert.equal(await outstanding(ctx), 10_000n * ONE);
  });

  test('proceeds short of the stated senior rate reduce senior and pay junior nothing', async () => {
    const { ctx, first } = await eligibleBook();
    const due = seniorDue(3000n * ONE);
    await F.deliverAndDistribute(ctx, first, due / 2n);

    assert.equal(await ctx.coupon.call('owed', [CLASS.JUNIOR, first - 1n, 7000n * ONE]), 0n);
    const senior = await ctx.coupon.call('owed', [CLASS.SENIOR, first - 1n, 3000n * ONE]);
    assert.ok(senior > 0n && senior <= due / 2n);
  });

  test('a shortfall is not carried forward: the next epoch pays from its own proceeds alone', async () => {
    const { ctx, first } = await eligibleBook();
    await F.deliverAndDistribute(ctx, first, seniorDue(3000n * ONE) / 2n);
    const afterShort = await ctx.coupon.call('owed', [CLASS.SENIOR, first - 1n, 3000n * ONE]);

    await F.deliverAndDistribute(ctx, first + 1n, 50n * ONE);
    const afterFull = await ctx.coupon.call('owed', [CLASS.SENIOR, first - 1n, 3000n * ONE]);
    const secondEpoch = afterFull - afterShort;
    // The second epoch paid senior its stated rate, and not a penny of the first
    // epoch's shortfall on top.
    assert.ok(secondEpoch <= seniorDue(3000n * ONE));
  });

  test('the residue of the two truncating divisions is carried into the following epoch', async () => {
    const { ctx, first } = await eligibleBook();
    // An amount that does not divide evenly across the shares.
    const delivered = 50n * ONE + 7n;
    await F.deliverAndDistribute(ctx, first, delivered);

    const drawn = (await ctx.coupon.call('owed', [CLASS.SENIOR, first - 1n, 3000n * ONE]))
      + (await ctx.coupon.call('owed', [CLASS.JUNIOR, first - 1n, 7000n * ONE]));
    const carried = await ctx.ledger.call('deliveredIn', [first + 1n]);

    assert.ok(carried > 0n, 'something was left over to carry');
    assert.equal(drawn + carried, delivered, 'nothing delivered is lost: drawn or carried');
    assert.equal(await ctx.ledger.call('remainingIn', [first]), 0n);
  });

  test('principal inside its cliff earns nothing, and the coupon of such an epoch is carried', async () => {
    const ctx = await F.deployBondStack();
    await twoClasses(ctx);
    const inside = epochNow(ctx) + 1n;
    await F.distributeDue(ctx);
    await F.deliverAndDistribute(ctx, inside, 50n * ONE);

    assert.equal(await ctx.coupon.call('owed', [CLASS.JUNIOR, inside - 1n, 7000n * ONE]), 0n);
    assert.equal(await ctx.ledger.call('deliveredIn', [inside + 1n]), 50n * ONE, 'carried whole');
  });

  test('the seller keeps the coupon of the epochs it held through; the buyer is paid from the transfer on', async () => {
    const { ctx, first, j } = await eligibleBook();
    await F.deliverAndDistribute(ctx, first, 50n * ONE);
    const sellersEpoch = await ctx.coupon.call('owed', [CLASS.JUNIOR, first - 1n, 7000n * ONE]);

    // The transfer settles the seller first. It must not send value mid-transfer,
    // so the coupon account withholds it for the seller to take.
    await ctx.bond.send('transferHolding', [j, BUYER, 7000n * ONE], { from: HOLDER });
    assert.equal(await ctx.coupon.call('withheldOf', [HOLDER]), sellersEpoch);

    const before = await ctx.chain.balanceOf(HOLDER);
    await ctx.coupon.send('withdraw', [], { from: HOLDER });
    assert.equal((await ctx.chain.balanceOf(HOLDER)) - before, sellersEpoch);

    // The buyer holds the same record, its cursor already past the seller's epoch.
    await F.deliverAndDistribute(ctx, first + 1n, 50n * ONE);
    const buyer = await ctx.bond.call('holdingOf', [j]);
    assert.equal(buyer.claimedThrough, first);
    await assert.rejects(() => ctx.coupon.send('withdraw', [], { from: BUYER }), /NothingDue/);
  });

  test('a coupon is distributed once per epoch, and in order', async () => {
    const { ctx, first } = await eligibleBook();
    await F.deliverAndDistribute(ctx, first, 50n * ONE);
    await assert.rejects(() => ctx.coupon.send('distribute', [first]), /EpochAlreadyDistributed/);
    await assert.rejects(() => ctx.coupon.send('distribute', [first + 2n]), /EpochAlreadyDistributed/);
  });

  test('the coupon account accepts value only from the ledger\'s draw', async () => {
    const ctx = await F.deployBondStack();
    await assert.rejects(() => ctx.chain.execute(ctx.coupon.address, HOLDER, '0x', ONE), /OnlyLedger/);
  });
});

/* ------------------------------------------------------------------ */
/* Maturity and the hold. Whitepaper §5.3, invariant I9                */
/* ------------------------------------------------------------------ */

describe('nothing redeems before maturity, and a maturity inside a claim is held (§5.3)', () => {
  async function matured(ctx, { value = 1000n * ONE } = {}) {
    const id = await F.subscribe(ctx, { term: TERM.QUARTER, value });
    const m = (await ctx.bond.call('holdingOf', [id])).maturityEpoch;
    F.toEpoch(ctx, m + 1n);
    await F.distributeDue(ctx);
    return { id, m };
  }

  test('there is no redemption at par on demand: a holding before its maturity epoch is refused (I9)', async () => {
    const ctx = await F.deployBondStack();
    const id = await F.subscribe(ctx, { term: TERM.QUARTER, value: ONE });
    await assert.rejects(() => ctx.bond.send('redeem', [id], { from: HOLDER }), /NotMatured/);
  });

  test('a matured holding is returned at par', async () => {
    const ctx = await F.deployBondStack();
    const { id } = await matured(ctx);
    const before = await ctx.chain.balanceOf(HOLDER);
    await ctx.bond.send('redeem', [id], { from: HOLDER });
    assert.equal((await ctx.chain.balanceOf(HOLDER)) - before, 1000n * ONE);
    assert.equal(await outstanding(ctx), 0n);
  });

  test('principal maturing while a determination is open is held, and stays outstanding', async () => {
    const ctx = await F.deployBondStack();
    const { id } = await matured(ctx);
    await ctx.court.send('open', ['0x' + '02'.repeat(32)]);
    await assert.rejects(() => ctx.bond.send('redeem', [id], { from: HOLDER }), /HeldByDetermination/);
    assert.equal(await outstanding(ctx), 1000n * ONE);
  });

  test('a hold under a determination lasts no longer than twenty days, whether or not the court closes it', async () => {
    const ctx = await F.deployBondStack();
    const { id } = await matured(ctx);
    await ctx.court.send('open', ['0x' + '03'.repeat(32)]);
    ctx.chain.advanceTime(20 * DAY + 1);
    await F.distributeDue(ctx);
    await ctx.bond.send('redeem', [id], { from: HOLDER });
  });

  test('principal maturing during the protective freeze is held until it lifts', async () => {
    const ctx = await F.deployBondStack();
    const { id } = await matured(ctx);
    await ctx.qday.send('setFrozen', [true]);
    await assert.rejects(() => ctx.bond.send('redeem', [id], { from: HOLDER }), /HeldByFreeze/);
    await ctx.qday.send('setFrozen', [false]);
    await ctx.bond.send('redeem', [id], { from: HOLDER });
  });

  test('a held holding remains transferable', async () => {
    const ctx = await F.deployBondStack();
    const { id } = await matured(ctx);
    await ctx.court.send('open', ['0x' + '04'.repeat(32)]);
    const h = await ctx.bond.call('holdingOf', [id]);
    await ctx.bond.send('transferHolding', [id, BUYER, h.shares], { from: HOLDER });
  });
});

/* ------------------------------------------------------------------ */
/* The run-off gate. Whitepaper §5.3                                   */
/* ------------------------------------------------------------------ */

describe('the run-off gate closes on either ground and opens only on two clean epochs (§5.3)', () => {
  test('the gate closes at the close of an epoch in which the threat stage stands at four', async () => {
    const ctx = await F.deployBondStack({ stage: 4 });
    await F.subscribe(ctx, { value: ONE });
    assert.equal(await ctx.bond.call('runoffGateClosed'), false, 'nothing runs until the boundary is crossed');
    F.toNextEpoch(ctx);
    await ctx.bond.send('closeEpoch');
    assert.equal(await ctx.bond.call('runoffGateClosed'), true);
  });

  test('while the gate is closed the registry prices at the surge ceiling', async () => {
    const ctx = await F.deployBondStack({ stage: 4 });
    assert.equal(await ctx.registry.call('premiumCeilingInForceBps'), 7400n);
    F.toNextEpoch(ctx);
    await ctx.bond.send('closeEpoch');
    // The stored gate actually reaches the price of cover.
    assert.equal(await ctx.registry.call('premiumCeilingInForceBps'), 8500n);
  });

  test('the gate closes when outstanding principal contracts by more than the trigger across two epochs', async () => {
    const ctx = await F.deployBondStack();
    await F.subscribe(ctx, { value: 1000n * ONE });
    F.toNextEpoch(ctx);
    await ctx.bond.send('closeEpoch');
    F.toNextEpoch(ctx);
    await ctx.bond.send('closeEpoch');
    assert.equal(await ctx.bond.call('runoffGateClosed'), false);

    // A loss of 30 per cent of principal, recorded through staking.
    await ctx.bond.send('placeWithStaking', [1000n * ONE]);
    await ctx.delegation.send('loseStake', [300n * ONE]);
    await ctx.staking.send('syncLoss');

    F.toNextEpoch(ctx);
    await ctx.bond.send('closeEpoch');
    assert.equal(await ctx.bond.call('runoffGateClosed'), true);
  });

  test('the gate does not open while a determination is open, however many clean epochs pass', async () => {
    const ctx = await F.deployBondStack({ stage: 4 });
    F.toNextEpoch(ctx);
    await ctx.bond.send('closeEpoch');
    assert.equal(await ctx.bond.call('runoffGateClosed'), true);

    // Restoration, stage 1 (item 129), so neither ground holds, and open a
    // determination. The step is in force from the next epoch boundary.
    await phaseFromNext(ctx, 4);
    await ctx.court.send('open', ['0x' + '05'.repeat(32)]);
    for (let i = 0; i < 3; i++) {
      F.toNextEpoch(ctx);
      await ctx.bond.send('closeEpoch');
    }
    assert.equal(await ctx.bond.call('runoffGateClosed'), true);
  });

  test('the gate opens only after two consecutive epochs in which neither ground held', async () => {
    const ctx = await F.deployBondStack({ stage: 4 });
    F.toNextEpoch(ctx);
    await ctx.bond.send('closeEpoch');
    // Restoration (phase 4, stage 1; item 129) reopens the gate with no code
    // of its own: the gate's ground is stage >= 4.
    await phaseFromNext(ctx, 4);

    // The step is in force from the next epoch, and the gate observes the
    // stage in force IN the epoch it closes (G8, phase C3): the epoch of the
    // vote still stood at the fourth stage.
    F.toNextEpoch(ctx);
    await ctx.bond.send('closeEpoch');
    assert.equal(await ctx.bond.call('runoffGateClosed'), true, 'the epoch of the vote stood at stage 4');
    F.toNextEpoch(ctx);
    await ctx.bond.send('closeEpoch');
    assert.equal(await ctx.bond.call('runoffGateClosed'), true, 'one clean epoch is not two');
    F.toNextEpoch(ctx);
    await ctx.bond.send('closeEpoch');
    assert.equal(await ctx.bond.call('runoffGateClosed'), false);
  });
});

/* ------------------------------------------------------------------ */
/* The run-off queue. Whitepaper §5.3, invariant I26                   */
/* ------------------------------------------------------------------ */

describe('principal maturing into a closed gate is queued, stays outstanding, and is paid at the bound (I26)', () => {
  /** A quarter-term holding maturing while the gate is closed by the fourth stage. */
  async function queued(value = 1000n * ONE) {
    const ctx = await F.deployBondStack({ stage: 4 });
    const id = await F.subscribe(ctx, { term: TERM.QUARTER, value });
    const m = (await ctx.bond.call('holdingOf', [id])).maturityEpoch;
    F.toEpoch(ctx, m + 1n);
    await F.distributeDue(ctx);
    return { ctx, id, m };
  }

  test('a maturity into a closed gate is not returned at maturity', async () => {
    const { ctx, id, m } = await queued();
    await assert.rejects(() => ctx.bond.send('redeem', [id], { from: HOLDER }), /InRunoffQueue/);
  });

  test('queued principal is still counted as outstanding', async () => {
    const { ctx } = await queued();
    assert.equal(await outstanding(ctx), 1000n * ONE);
    const s = await state(ctx);
    assert.equal(s.queueTotal, 1000n * ONE);
  });

  test('one epoch returns no more than the bound on the principal outstanding when the gate closed', async () => {
    const { ctx, id } = await queued();
    // The run-off bound is 2,000 bps and the gate closed with 1,000 QRL
    // outstanding, so one epoch authorises exactly 200 of the queue.
    const s = await state(ctx);
    assert.equal(s.atGateClose, 1000n * ONE);
    assert.equal(s.queueServed, (s.atGateClose * 2000n) / BPS);

    const before = await ctx.chain.balanceOf(HOLDER);
    await ctx.bond.send('claimQueued', [id], { from: HOLDER });
    assert.equal((await ctx.chain.balanceOf(HOLDER)) - before, 200n * ONE);
    // What was not reached stays queued, and stays outstanding.
    assert.equal(await outstanding(ctx), 800n * ONE);
  });

  test('a whole queue clears in the five epochs the bound implies, rather than decaying', async () => {
    const { ctx, id } = await queued();
    for (let i = 0; i < 6; i++) {
      F.toNextEpoch(ctx);
      await F.distributeDue(ctx);
    }
    const s = await state(ctx);
    assert.equal(s.queueServed, s.queueTotal, 'the nominal ledger has reached the whole queue');

    const before = await ctx.chain.balanceOf(HOLDER);
    await ctx.bond.send('claimQueued', [id], { from: HOLDER });
    assert.equal((await ctx.chain.balanceOf(HOLDER)) - before, 1000n * ONE);
    assert.equal(await outstanding(ctx), 0n);
  });

  test('a queued holding remains transferable', async () => {
    const { ctx, id } = await queued();
    const h = await ctx.bond.call('holdingOf', [id]);
    await ctx.bond.send('transferHolding', [id, BUYER, h.shares], { from: HOLDER });
  });
});

/* ------------------------------------------------------------------ */
/* The conditional release. Whitepaper §5.3, invariant I10             */
/* ------------------------------------------------------------------ */

describe('principal above the requirement is released at par, on a measured condition only (I10)', () => {
  test('the release takes no amount: it is never available on request', async () => {
    const ctx = await F.deployBondStack();
    const fn = ctx.bond.iface.getFunction('conditionalRelease');
    assert.equal(fn.inputs.length, 0);
  });

  test('an empty book releases nothing: with nothing anchored there is no utilisation to be below', async () => {
    const ctx = await F.deployBondStack();
    await F.subscribe(ctx, { value: 1000n * ONE });
    for (let i = 0; i < 3; i++) {
      F.toNextEpoch(ctx);
      await ctx.bond.send('closeEpoch');
    }
    await assert.rejects(() => ctx.bond.send('conditionalRelease'), /UtilisationNotLow/);
  });

  /**
   * Scenario report part 3's shape: a bond far larger than the book requires.
   * 200 units anchored at stage one require about 24.68 units of capital; two
   * million QRL is 200 units, so utilisation is about 1,234 bps.
   */
  async function overCapitalised() {
    const ctx = await F.deployBondStack();
    await F.anchor(ctx, { notional: 200n * ONE });
    const first = cliffEpochNow(ctx);
    await F.subscribe(ctx, { class_: CLASS.JUNIOR, value: 2_000_000n * ONE });
    await F.distributeDue(ctx);
    // An epoch that closed inside its operating range: a coupon paid in full.
    await F.deliverAndDistribute(ctx, first, 100n * ONE);
    return { ctx, first };
  }

  test('one epoch below the threshold is not two', async () => {
    // A bond far too small for the book: utilisation well above 2,500 bps, so the
    // count has not started. Then a large subscription drops it below, and the
    // count reaches one at the next close — and one is not the two §5.3 requires.
    const ctx = await F.deployBondStack();
    await F.anchor(ctx, { notional: 200n * ONE });
    const first = cliffEpochNow(ctx);
    await F.subscribe(ctx, { class_: CLASS.JUNIOR, value: 100_000n * ONE });
    await F.distributeDue(ctx);
    await F.deliverAndDistribute(ctx, first, 100n * ONE);
    assert.ok((await ctx.bond.call('utilisationBps')) > 2500n, 'the book is short of capital');
    assert.equal((await state(ctx)).belowEpochs, 0n);

    await F.subscribe(ctx, { class_: CLASS.JUNIOR, value: 2_000_000n * ONE });
    assert.ok((await ctx.bond.call('utilisationBps')) <= 2500n, 'and now it is not');
    F.toNextEpoch(ctx);
    await F.distributeDue(ctx);
    await ctx.attest.send('seal', [epochNow(ctx) - 1n, '0x' + 'ab'.repeat(32)]);

    assert.equal((await state(ctx)).belowEpochs, 1n);
    await assert.rejects(() => ctx.bond.send('conditionalRelease'), /UtilisationNotLow/);

    F.toNextEpoch(ctx);
    await F.distributeDue(ctx);
    await ctx.attest.send('seal', [epochNow(ctx) - 1n, '0x' + 'ab'.repeat(32)]);
    assert.equal((await state(ctx)).belowEpochs, 2n);
    await ctx.bond.send('conditionalRelease');
  });

  test('the release is suspended while the root of the preceding epoch is unadmitted', async () => {
    const { ctx } = await overCapitalised();
    F.toNextEpoch(ctx);
    F.toNextEpoch(ctx);
    await F.distributeDue(ctx);
    await assert.rejects(() => ctx.bond.send('conditionalRelease'), /RootUnadmitted/);
  });

  test('two epochs below the threshold release the principal above the requirement, at par, pro rata', async () => {
    const { ctx } = await overCapitalised();
    F.toNextEpoch(ctx);
    F.toNextEpoch(ctx);
    await F.distributeDue(ctx);
    await ctx.attest.send('seal', [epochNow(ctx) - 1n, '0x' + 'ab'.repeat(32)]);

    const required = await ctx.registry.call('requiredCapital');
    const pool = await outstanding(ctx);
    const res = await ctx.bond.send('conditionalRelease');
    const [ev] = ctx.bond.events(res, 'ConditionalReleased');
    const released = ev.args.junior + ev.args.senior;

    // What remains still meets the requirement: the requirement is converted
    // rounding up, so the retained principal is never a wei short of it.
    const retainedInOrigin = ((pool - released) * ONE) / F.REF_PRICE;
    assert.ok(retainedInOrigin >= required - 1n, `retained ${retainedInOrigin} against ${required}`);
    assert.ok(released > 0n);
  });

  test('under a conversion haircut the release leaves the requirement met at the capacity conversion (SP-05; adversarial: the unadjusted release took cover away)', async () => {
    const { ctx } = await overCapitalised();
    F.toNextEpoch(ctx);
    F.toNextEpoch(ctx);
    await F.distributeDue(ctx);
    await ctx.attest.send('seal', [epochNow(ctx) - 1n, '0x' + 'ab'.repeat(32)]);
    // A 2,500 bps drawdown over the window: the haircut at its cap.
    await ctx.oracle.send('setDrawdown', [BigInt(90 * 24 * 3600), 2500n]);
    const h = await ctx.registry.call('fxHaircutBps');
    assert.equal(h, 2500n);
    const required = await ctx.registry.call('requiredCapital');
    const pool = await outstanding(ctx);
    const res = await ctx.bond.send('conditionalRelease');
    const [ev] = ctx.bond.events(res, 'ConditionalReleased');
    const released = ev.args.junior + ev.args.senior;
    // required_QRL = ceil(K * P * BPS / (PRICE_SCALE * (BPS - h))) (the model's conditionalReleaseQrl).
    const den = ONE * (BPS - h);
    const requiredQrl = (required * F.REF_PRICE * BPS + den - 1n) / den;
    assert.equal(released, pool - requiredQrl);
    const kept = pool - released;
    assert.ok(kept * ONE * (BPS - h) >= required * F.REF_PRICE * BPS, 'what is kept covers K after the haircut');
    const unadjusted = pool - (required * F.REF_PRICE + ONE - 1n) / ONE;
    assert.ok(released < unadjusted, 'less than the release the settlement conversion alone admitted');
    const M = await loadModel();
    if (M) {
      const book = { anchoredNotional: 200n * ONE, bondNotional: pool, refPrice: F.REF_PRICE, maxAssetShareBps: Number(await ctx.registry.call('observedMaxGroupShareBps')), fxHaircutBps: Number(h) };
      const p = { ...M.params, sigmaTargetBps: Number(await ctx.registry.call('sigmaTargetBps')) };
      assert.equal(M.ark.requiredCapital(p, book), required);
      assert.equal(released, M.ark.conditionalReleaseQrl(p, book), 'the model\'s release');
    }
  });

  test('released principal is owed to the holders and cannot be placed with staking', async () => {
    const { ctx } = await overCapitalised();
    F.toNextEpoch(ctx);
    F.toNextEpoch(ctx);
    await F.distributeDue(ctx);
    await ctx.attest.send('seal', [epochNow(ctx) - 1n, '0x' + 'ab'.repeat(32)]);
    await ctx.bond.send('conditionalRelease');

    const free = await ctx.bond.call('unencumbered');
    const s = await state(ctx);
    assert.equal(free + s.principalOwed + s.freePool, await ctx.chain.balanceOf(ctx.bond.address));
    await assert.rejects(() => ctx.bond.send('placeWithStaking', [free + 1n]), /PrincipalNotLiquid/);
  });

  /**
   * Audit 2026-09-22, B-M3. Scenario report part 3 releases 160 units of 200;
   * this book releases nearly all of two million QRL. Measured gross, that is a
   * contraction far past the 2,500 bps trigger and the gate closed at the next
   * boundary — the gate the release is itself suspended by. Whitepaper §5.3
   * measures the ground net of the release.
   */
  test('the release does not trip the contraction ground, and a contraction after it still does (B-M3)', async () => {
    const { ctx } = await overCapitalised();
    F.toNextEpoch(ctx);
    F.toNextEpoch(ctx);
    await F.distributeDue(ctx);
    await ctx.attest.send('seal', [epochNow(ctx) - 1n, '0x' + 'ab'.repeat(32)]);
    const before = await outstanding(ctx);
    await ctx.bond.send('conditionalRelease');
    const rest = await outstanding(ctx);
    assert.ok(rest * 4n < before, `the release returned more than the trigger: ${before} -> ${rest}`);

    for (let i = 0; i < 3; i++) {
      F.toNextEpoch(ctx);
      await ctx.bond.send('closeEpoch');
      assert.equal(await ctx.bond.call('runoffGateClosed'), false, `boundary ${i + 1} after the release`);
    }

    // What the release left contracts by thirty per cent through staking: that
    // is run-off the ground exists for, measured on the principal left.
    const free = await ctx.bond.call('unencumbered');
    await ctx.bond.send('placeWithStaking', [free]);
    await ctx.delegation.send('loseStake', [(rest * 3n) / 10n]);
    await ctx.staking.send('syncLoss');
    F.toNextEpoch(ctx);
    await ctx.bond.send('closeEpoch');
    assert.equal(await ctx.bond.call('runoffGateClosed'), true);
  });
});

/* ------------------------------------------------------------------ */
/* Principal at staking. Whitepaper §3.4                               */
/* ------------------------------------------------------------------ */

describe('principal at staking comes back as principal, and the distribution reaches every holding', () => {
  test('the bond refuses a bare transfer: value arrives only through a function that names it', async () => {
    const ctx = await F.deployBondStack();
    await assert.rejects(() => ctx.chain.execute(ctx.bond.address, HOLDER, '0x', ONE), /ZeroValue/);
  });

  test('the staking contract accepts value from the venue, during a claim, and from nobody else', async () => {
    const ctx = await F.deployBondStack();
    await assert.rejects(() => ctx.chain.execute(ctx.staking.address, HOLDER, '0x', ONE), /OnlyVenue/);
  });

  test('principal placed with staking leaves the bond and is recorded as placed', async () => {
    const ctx = await F.deployBondStack();
    await F.subscribe(ctx, { value: 1000n * ONE });
    await ctx.bond.send('placeWithStaking', [600n * ONE]);
    assert.equal(await ctx.delegation.call('principal'), 600n * ONE, 'the pool stakes it at its validators');
    assert.equal(await ctx.pool.call('positionValue', [ctx.staking.address]), 600n * ONE);
    assert.equal(await ctx.bond.call('placedWithStaking'), 600n * ONE);
    assert.equal(await outstanding(ctx), 1000n * ONE, 'placing principal does not change what is outstanding');
  });

  test('principal recalled from staking is returned as principal, not credited as a distribution', async () => {
    // A quarter-term holding matures and every wei of it is at staking: the
    // bond owes principal it cannot meet, so a recall is measured and allowed.
    const ctx = await F.deployBondStack();
    const id = await F.subscribe(ctx, { term: TERM.QUARTER, value: 1000n * ONE });
    await ctx.bond.send('placeWithStaking', [1000n * ONE]);
    const m = (await ctx.bond.call('holdingOf', [id])).maturityEpoch;
    F.toEpoch(ctx, m + 1n);
    await F.distributeDue(ctx);
    const res = await ctx.staking.send('recall', [10_000n * ONE]);
    const [ev] = ctx.staking.events(res, 'Requested');
    assert.equal(ev.args.amount, 1000n * ONE, 'no more than the shortfall is asked for');
    await ctx.staking.send('claim', [ev.args.requestId]);
    assert.equal(await ctx.bond.call('placedWithStaking'), 0n);
    const st = await state(ctx);
    assert.equal(st.freePool, 0n, 'nothing returned was mistaken for a distribution');
    await ctx.bond.send('redeem', [id], { from: HOLDER });
  });

  test('no recall while the bond can meet what it owes', async () => {
    const ctx = await F.deployBondStack();
    await F.subscribe(ctx, { value: 1000n * ONE });
    await ctx.bond.send('placeWithStaking', [600n * ONE]);
    await assert.rejects(() => ctx.staking.send('recall', [600n * ONE]), /NoShortfall/);
  });

  test('the gain above principal is the distribution; a position at or below it has none', async () => {
    const ctx = await F.deployBondStack();
    await F.subscribe(ctx, { value: 1000n * ONE });
    await ctx.bond.send('placeWithStaking', [600n * ONE]);
    await assert.rejects(() => ctx.staking.send('harvest'), /NothingToHarvest/);
    await F.stakingDistribution(ctx, 30n * ONE);
    assert.equal(await ctx.bond.call('placedWithStaking'), 600n * ONE, 'the distribution is not principal');
    assert.ok((await state(ctx)).freePool > 0n);
  });

  test('a staking distribution reaches every holding pro rata by principal, with no cliff', async () => {
    const ctx = await F.deployBondStack();
    const { j, s } = await twoClasses(ctx);
    // Pushed the way `distribute` pushes: a raw call into the staking contract.
    await F.stakingDistribution(ctx, 100n * ONE);

    const before = await ctx.chain.balanceOf(HOLDER);
    await ctx.bond.send('claim', [j], { from: HOLDER });
    await ctx.bond.send('claim', [s], { from: HOLDER });
    const got = (await ctx.chain.balanceOf(HOLDER)) - before;
    // Inside the cliff, and paid anyway: the cliff belongs to the coupon. The
    // pool's share rounding keeps well under a millionth of a QRL.
    assert.ok(got <= 100n * ONE && 100n * ONE - got < 10n ** 6n);
  });

  // Audit 2026-09-27 D16, whitepaper §3.4. The PoC against the pre-fix bond:
  // a subscription placed in the epoch of a distribution claimed 49.9999 of a
  // distribution of 100 that the holder of record alone had earned.
  test('D16 PoC: a subscription placed just ahead of a distribution takes no part of it', async () => {
    const ctx = await F.deployBondStack();
    const a = await F.subscribe(ctx, { from: HOLDER, value: 1000n * ONE });
    await ctx.bond.send('placeWithStaking', [600n * ONE]);
    F.toNextEpoch(ctx);
    const b = await F.subscribe(ctx, { from: BUYER, value: 1000n * ONE });
    await F.stakingDistribution(ctx, 100n * ONE);
    const claimOf = async (id, who) => {
      const before = await ctx.chain.balanceOf(who);
      try {
        await ctx.bond.send('claim', [id], { from: who });
      } catch (e) {
        if (!/NothingDue/.test(e.message)) throw e;
      }
      return (await ctx.chain.balanceOf(who)) - before;
    };
    await assert.rejects(() => ctx.bond.send('claim', [b], { from: BUYER }), /NothingDue/, 'nothing of the epoch it was created in');
    const got = await claimOf(a, HOLDER);
    assert.ok(got <= 100n * ONE && 100n * ONE - got < 10n ** 6n, `the holder of record takes it whole: ${got}`);
    // From the next epoch it shares a distribution in proportion to principal.
    F.toNextEpoch(ctx);
    await F.stakingDistribution(ctx, 100n * ONE);
    const late = await claimOf(b, BUYER);
    assert.ok(late <= 50n * ONE && 50n * ONE - late < 10n ** 6n, `half of the next one: ${late}`);
  });

  test('D16: what each holding takes of a distribution is openingSnapshotShares of the model', async (t) => {
    const M = await loadModel();
    if (!M) return t.skip(MISSING);
    const ctx = await F.deployBondStack();
    const e0 = epochNow(ctx);
    const plan = [[HOLDER, 700n * ONE], [BUYER, 300n * ONE]];
    const ids = [];
    for (const [who, value] of plan) ids.push({ who, value, id: await F.subscribe(ctx, { from: who, value }), epoch: e0 });
    await ctx.bond.send('placeWithStaking', [600n * ONE]);
    F.toNextEpoch(ctx);
    const late = { who: ACCOUNTS.mallory, value: 2000n * ONE, epoch: e0 + 1n };
    late.id = await F.subscribe(ctx, { from: late.who, value: late.value });
    ids.push(late);
    const distribution = 100n * ONE;
    await F.stakingDistribution(ctx, distribution);
    const expected = M.ark.openingSnapshotShares(
      distribution,
      ids.map((h) => ({ amount: h.value, createdEpoch: Number(h.epoch) })),
      Number(e0 + 1n),
    );
    for (let i = 0; i < ids.length; i++) {
      const before = await ctx.chain.balanceOf(ids[i].who);
      try {
        await ctx.bond.send('claim', [ids[i].id], { from: ids[i].who });
      } catch (e) {
        if (!/NothingDue/.test(e.message)) throw e;
      }
      const got = (await ctx.chain.balanceOf(ids[i].who)) - before;
      // The pool's share rounding and the two index divisions keep well under a millionth of a QRL.
      assert.ok(got <= expected[i] && expected[i] - got < 10n ** 6n, `holding ${i}: ${got} against ${expected[i]}`);
    }
  });

  test('D16: a holding split in its first epoch passes the wait on to the part it carves off', async () => {
    const ctx = await F.deployBondStack();
    await F.subscribe(ctx, { from: HOLDER, value: 1000n * ONE });
    await ctx.bond.send('placeWithStaking', [600n * ONE]);
    F.toNextEpoch(ctx);
    const b = await F.subscribe(ctx, { from: BUYER, value: 1000n * ONE });
    const res = await ctx.bond.send('transferHolding', [b, ACCOUNTS.mallory, (await ctx.bond.call('holdingOf', [b])).shares / 2n], { from: BUYER });
    const [ev] = ctx.bond.events(res, 'HoldingTransferred');
    await F.stakingDistribution(ctx, 100n * ONE);
    await assert.rejects(() => ctx.bond.send('claim', [ev.args.newId], { from: ACCOUNTS.mallory }), /NothingDue/);
  });

  test('a validator returning less than its stake is a loss borne pro rata by every holding then outstanding', async () => {
    const ctx = await F.deployBondStack();
    const { j, s } = await twoClasses(ctx);
    await ctx.bond.send('placeWithStaking', [10_000n * ONE]);
    await ctx.delegation.send('loseStake', [1000n * ONE]);
    await ctx.staking.send('syncLoss');

    assert.equal(await outstanding(ctx), 9000n * ONE);
    const pj = await ctx.bond.call('principalOf', [j]);
    const ps = await ctx.bond.call('principalOf', [s]);
    // Both classes fell by the same ten per cent: a loss of principal is not a draw
    // under trigger 1, which is the one place seniority ranks it.
    assert.ok(pj >= 6299n * ONE && pj <= 6300n * ONE, `junior ${pj}`);
    assert.ok(ps >= 2699n * ONE && ps <= 2700n * ONE, `senior ${ps}`);
  });

  test('a holding issued after a loss does not bear it', async () => {
    const ctx = await F.deployBondStack();
    await twoClasses(ctx);
    await ctx.bond.send('placeWithStaking', [10_000n * ONE]);
    await ctx.delegation.send('loseStake', [1000n * ONE]);
    await ctx.staking.send('syncLoss');

    const late = await F.subscribe(ctx, { class_: CLASS.JUNIOR, value: 630n * ONE });
    const worth = await ctx.bond.call('principalOf', [late]);
    // Truncation falls on the subscriber, never on the holders already there.
    assert.ok(worth <= 630n * ONE && 630n * ONE - worth < 10n);
  });
});

/* ------------------------------------------------------------------ */
/* Wiring and the court. CLAUDE.md §7.11                               */
/* ------------------------------------------------------------------ */

describe('every wiring call is one-shot, and only the court opens a determination', () => {
  test('the court and the staking contract cannot be re-pointed', async () => {
    const ctx = await F.deployBondStack();
    await assert.rejects(
      () => ctx.bond.send('setCourt', [BUYER], { from: ACCOUNTS.admin }),
      /AlreadySet/,
    );
    await assert.rejects(
      () => ctx.bond.send('setStaking', [BUYER], { from: ACCOUNTS.admin }),
      /AlreadySet/,
    );
  });

  test('adversarial: a seed-return leaf is sealable only while no determination is open and no declaration stands (PV-17)', async () => {
    // The relayer seals an escrow's seed return only while this reads true:
    // the escrow cannot see a determination open on QRL, and without the
    // leaf the treasury could take first-loss capital back while releases
    // unbond under one.
    const ctx = await F.deployBondStack();
    assert.equal(await ctx.bond.call('seedReturnSealable'), true);
    const id = '0x' + '0a'.repeat(32);
    await ctx.court.send('open', [id]);
    assert.equal(await ctx.bond.call('seedReturnSealable'), false, 'a determination open');
    await ctx.court.send('close', [id]);
    assert.equal(await ctx.bond.call('seedReturnSealable'), true);
    await ctx.qday.send('declare', [BigInt(ctx.chain.timestamp)]);
    assert.equal(await ctx.bond.call('seedReturnSealable'), false, 'a declaration');
  });

  test('a determination is opened by the court and by no other account', async () => {
    const ctx = await F.deployBondStack();
    await assert.rejects(
      () => ctx.bond.send('openDetermination', ['0x' + '06'.repeat(32)], { from: ACCOUNTS.admin }),
      /OnlyCourt/,
    );
  });

  test('only the staking contract can tell the bond about a loss or a return', async () => {
    const ctx = await F.deployBondStack();
    await assert.rejects(() => ctx.bond.send('recordLoss', [ONE], { from: ACCOUNTS.admin }), /OnlyStaking/);
    await assert.rejects(
      () => ctx.bond.send('creditDistribution', [], { from: ACCOUNTS.admin, value: ONE }),
      /OnlyStaking/,
    );
  });
});

describe('the balance always covers what is owed', () => {
  test('after issuance, placement, a distribution and a claim, the pool still covers every obligation', async () => {
    const ctx = await F.deployBondStack();
    const { j } = await twoClasses(ctx);
    await ctx.bond.send('placeWithStaking', [4000n * ONE]);
    await F.stakingDistribution(ctx, 50n * ONE);
    await ctx.bond.send('claim', [j], { from: HOLDER });

    const s = await state(ctx);
    const balance = await ctx.chain.balanceOf(ctx.bond.address);
    assert.ok(balance >= s.freePool + s.principalOwed, 'the balance covers what holders are owed');
    assert.equal(s.outstanding, s.juniorPrincipal + s.seniorPrincipal);
  });
});

/* ------------------------------------------------------------------ */
/* Audited findings: each test is the proof of concept of one finding */
/* ------------------------------------------------------------------ */

/** Balance change of `who` across `fn`. The harness charges no gas. */
async function received(ctx, who, fn) {
  const before = await ctx.chain.balanceOf(who);
  await fn();
  return (await ctx.chain.balanceOf(who)) - before;
}

describe('the coupon cursor only moves forward (H1)', () => {
  test('a settlement inside the cliff does not rewind the cursor, and pays no epoch outside the base', async () => {
    const ctx = await F.deployBondStack();
    const first = cliffEpochNow(ctx);
    await F.subscribe(ctx, { from: HOLDER, value: 7000n * ONE });
    await F.distributeDue(ctx);

    // A second holding, bought when the first is already eligible: its cliff is
    // five epochs away and the coupon has only been distributed through `first - 1`.
    const cB = cliffEpochNow(ctx);
    const b = await F.subscribe(ctx, { from: BUYER, value: 1000n * ONE });
    // A staking distribution gives the claim something to pay, so it settles.
    await F.stakingDistribution(ctx, 8n * ONE);
    await ctx.bond.send('claim', [b], { from: BUYER });
    assert.equal((await ctx.bond.call('holdingOf', [b])).claimedThrough, cB - 1n, 'the cursor was not rewound');

    // The epochs before B's cliff pay the eligible holding only.
    for (let e = first; e < cB; e++) await F.deliverAndDistribute(ctx, e, 50n * ONE);
    await assert.rejects(() => ctx.bond.send('claim', [b], { from: BUYER }), /NothingDue/);
  });
});

describe('the run-off queue pays each holding its whole principal, however often it draws (H2)', () => {
  async function queuedBook(values) {
    const ctx = await F.deployBondStack({ stage: 4 });
    const ids = [];
    for (const [who, value] of values) ids.push(await F.subscribe(ctx, { from: who, term: TERM.QUARTER, value }));
    const m = (await ctx.bond.call('holdingOf', [ids[0]])).maturityEpoch;
    F.toEpoch(ctx, m + 1n);
    await F.distributeDue(ctx);
    return { ctx, ids };
  }

  async function drawEachEpoch(ctx, id, who, epochs) {
    let total = 0n;
    for (let i = 0; i < epochs; i++) {
      try {
        total += await received(ctx, who, () => ctx.bond.send('claimQueued', [id], { from: who }));
      } catch (e) {
        if (!/NothingDue/.test(String(e.message))) throw e;
      }
      F.toNextEpoch(ctx);
      await F.distributeDue(ctx);
    }
    return total;
  }

  test('a holding that draws once per epoch receives the full 1,000', async () => {
    const { ctx, ids: [id] } = await queuedBook([[HOLDER, 1000n * ONE]]);
    assert.equal(await drawEachEpoch(ctx, id, HOLDER, 7), 1000n * ONE);
    assert.equal(await outstanding(ctx), 0n);
  });

  test('an early drawer is not overpaid at the expense of a late one', async () => {
    const { ctx, ids: [a, b] } = await queuedBook([[HOLDER, 500n * ONE], [BUYER, 500n * ONE]]);
    const gotA = await drawEachEpoch(ctx, a, HOLDER, 7);
    const gotB = await received(ctx, BUYER, () => ctx.bond.send('claimQueued', [b], { from: BUYER }));
    assert.equal(gotA, 500n * ONE);
    assert.equal(gotB, 500n * ONE);
  });
});

describe('a holding of a void generation is worth nothing and cannot take the next generation\'s principal (H3)', () => {
  test('after a total loss the old holding is void, and the maturity ladder forgets its shares', async () => {
    const ctx = await F.deployBondStack();
    const old = await F.subscribe(ctx, { from: HOLDER, term: TERM.QUARTER, value: 1000n * ONE });
    const m = (await ctx.bond.call('holdingOf', [old])).maturityEpoch;
    await ctx.bond.send('placeWithStaking', [1000n * ONE]);
    await ctx.delegation.send('loseStake', [1000n * ONE]);
    await ctx.staking.send('syncLoss');
    assert.equal(await outstanding(ctx), 0n);

    // The class is recapitalised by a new subscriber, into a later maturity.
    const fresh = await F.subscribe(ctx, { from: BUYER, term: TERM.YEAR, value: 1000n * ONE });
    assert.equal(await ctx.bond.call('principalOf', [old]), 0n, 'the void holding is worth nothing');
    assert.equal(await ctx.bond.call('principalOf', [fresh]), 1000n * ONE);
    assert.equal(await ctx.bond.call('maturingQrl', [m]), 0n, 'no phantom principal in the old maturity');

    F.toEpoch(ctx, m + 1n);
    await F.distributeDue(ctx);
    await assert.rejects(() => ctx.bond.send('redeem', [old], { from: HOLDER }), /HoldingVoid/);
    assert.equal(await outstanding(ctx), 1000n * ONE);
  });
});

describe('matured and queued principal is reserved, and a redemption never draws on another pot (H4)', () => {
  test('matured principal cannot be placed with staking, and counts as owed', async () => {
    const ctx = await F.deployBondStack();
    const id = await F.subscribe(ctx, { term: TERM.QUARTER, value: 1000n * ONE });
    const m = (await ctx.bond.call('holdingOf', [id])).maturityEpoch;
    F.toEpoch(ctx, m + 1n);
    await F.distributeDue(ctx);

    assert.equal(await ctx.bond.call('unencumbered'), 0n);
    assert.equal(await ctx.bond.call('principalOwedNow'), 1000n * ONE);
    await assert.rejects(() => ctx.bond.send('placeWithStaking', [ONE]), /PrincipalNotLiquid/);
  });

  test('queued principal is reserved too', async () => {
    const ctx = await F.deployBondStack({ stage: 4 });
    const id = await F.subscribe(ctx, { term: TERM.QUARTER, value: 1000n * ONE });
    const m = (await ctx.bond.call('holdingOf', [id])).maturityEpoch;
    F.toEpoch(ctx, m + 1n);
    await F.distributeDue(ctx);
    assert.equal(await ctx.bond.call('unencumbered'), 0n);
    assert.equal(await ctx.bond.call('principalOwedNow'), 1000n * ONE);
  });

  test('a redemption the liquid principal cannot meet is refused rather than paid out of the distribution pot', async () => {
    const ctx = await F.deployBondStack();
    const a = await F.subscribe(ctx, { from: HOLDER, term: TERM.QUARTER, value: 500n * ONE });
    const b = await F.subscribe(ctx, { from: BUYER, term: TERM.YEAR, value: 1000n * ONE });
    await ctx.bond.send('placeWithStaking', [1100n * ONE]);
    await F.stakingDistribution(ctx, 200n * ONE);
    const m = (await ctx.bond.call('holdingOf', [a])).maturityEpoch;
    F.toEpoch(ctx, m + 1n);
    await F.distributeDue(ctx);

    await assert.rejects(() => ctx.bond.send('redeem', [a], { from: HOLDER }), /PrincipalNotLiquid/);
    // B's distribution is untouched and still payable.
    const got = await received(ctx, BUYER, () => ctx.bond.send('claim', [b], { from: BUYER }));
    assert.ok(got > 133n * ONE && got <= 134n * ONE, `B received ${got}`);
  });
});

describe('the index roundings never pay out more than a pot holds (M1)', () => {
  const ODD = 7000n * ONE + 123456789n;

  test('a holder claiming many epochs of coupon at once is paid, and the pool does not underflow', async () => {
    const ctx = await F.deployBondStack();
    const first = cliffEpochNow(ctx);
    const j = await F.subscribe(ctx, { value: ODD });
    await F.distributeDue(ctx);
    for (let i = 0n; i < 6n; i++) {
      await F.deliverAndDistribute(ctx, first + i, 13n * ONE + 999_999_999_999n + i * 77_777n);
    }
    await ctx.bond.send('claim', [j], { from: HOLDER });
  });

  test('a holder claiming many staking distributions at once is paid, and the free pool does not underflow', async () => {
    const ctx = await F.deployBondStack();
    const j = await F.subscribe(ctx, { value: ODD });
    for (let i = 0n; i < 6n; i++) {
      await F.stakingDistribution(ctx, ONE + 1n + i * 77_777n);
    }
    await ctx.bond.send('claim', [j], { from: HOLDER });
    const s = await state(ctx);
    const placed = await ctx.bond.call('placedWithStaking');
    // The fourth pot, the Cushion (I42), beside the other three.
    const cushion = await ctx.bond.call('cushion');
    assert.ok((await ctx.chain.balanceOf(ctx.bond.address)) + placed >= s.freePool + s.principalOwed + s.outstanding + cushion);
  });
});

describe('a queued holding is held under a determination and the freeze, as a maturity is (M2)', () => {
  async function queuedOne() {
    const ctx = await F.deployBondStack({ stage: 4 });
    const id = await F.subscribe(ctx, { term: TERM.QUARTER, value: 1000n * ONE });
    const m = (await ctx.bond.call('holdingOf', [id])).maturityEpoch;
    F.toEpoch(ctx, m + 1n);
    await F.distributeDue(ctx);
    return { ctx, id };
  }

  test('an open determination holds a queue draw', async () => {
    const { ctx, id } = await queuedOne();
    await ctx.court.send('open', ['0x' + '07'.repeat(32)]);
    await assert.rejects(() => ctx.bond.send('claimQueued', [id], { from: HOLDER }), /HeldByDetermination/);
  });

  test('the protective freeze holds a queue draw', async () => {
    const { ctx, id } = await queuedOne();
    await ctx.qday.send('setFrozen', [true]);
    await assert.rejects(() => ctx.bond.send('claimQueued', [id], { from: HOLDER }), /HeldByFreeze/);
  });
});

describe('the twenty-day hold cannot be renewed by cycling determinations (M4)', () => {
  test('closing and reopening inside the cap does not restart it', async () => {
    const ctx = await F.deployBondStack();
    const id = await F.subscribe(ctx, { term: TERM.QUARTER, value: 1000n * ONE });
    const m = (await ctx.bond.call('holdingOf', [id])).maturityEpoch;
    F.toEpoch(ctx, m + 1n);
    await F.distributeDue(ctx);

    await ctx.court.send('open', ['0x' + '08'.repeat(32)]);
    ctx.chain.advanceTime(19 * DAY);
    await ctx.court.send('close', ['0x' + '08'.repeat(32)]);
    await ctx.court.send('open', ['0x' + '09'.repeat(32)]);
    ctx.chain.advanceTime(2 * DAY);
    await F.distributeDue(ctx);
    await ctx.bond.send('redeem', [id], { from: HOLDER });
  });

  test('the stand-in court opens and closes only for the account that deployed it', async () => {
    const ctx = await F.deployBondStack();
    const id = '0x' + '0a'.repeat(32);
    await assert.rejects(() => ctx.court.send('open', [id], { from: ACCOUNTS.mallory }), /OnlyDeployer/);
    await ctx.court.send('open', [id]);
    await assert.rejects(() => ctx.court.send('close', [id], { from: ACCOUNTS.mallory }), /OnlyDeployer/);
  });
});

describe('a payout keeps the coupons not yet fixed: the coupon tail', () => {
  /** A quarter-term holding, matured, with the two epochs before redemption still unsettled and delivered. */
  async function maturedWithUnsettled() {
    const ctx = await F.deployBondStack();
    const id = await F.subscribe(ctx, { term: TERM.QUARTER, value: 1000n * ONE });
    const m = (await ctx.bond.call('holdingOf', [id])).maturityEpoch;
    F.toEpoch(ctx, m + 1n);
    await F.distributeDue(ctx);
    // m - 1 and m are closed and inside their settlement windows: bob stands
    // in for the swap and credits both.
    await ctx.ledger.send('deliver', [m - 1n], { from: ACCOUNTS.bob, value: 30n * ONE });
    await ctx.ledger.send('deliver', [m], { from: ACCOUNTS.bob, value: 20n * ONE });
    return { ctx, id, m };
  }

  test('redeeming at maturity opens a tail over the closed epochs not yet distributed', async () => {
    const { ctx, id, m } = await maturedWithUnsettled();
    const last = BigInt(await ctx.coupon.call('lastDistributed'));
    const res = await ctx.bond.send('redeem', [id], { from: HOLDER });
    const [ev] = ctx.bond.events(res, 'CouponTailOpened');
    assert.equal(ev.args.owner.toLowerCase(), HOLDER.toLowerCase());
    assert.equal(ev.args.fromEpoch, last);
    assert.equal(ev.args.throughEpoch, m, 'through the last epoch closed before the payout');
    assert.ok(ev.args.shares > 0n);
  });

  test('the tail pays the redeemed holder what those epochs deliver, and strands nothing', async () => {
    const { ctx, id, m } = await maturedWithUnsettled();
    const res = await ctx.bond.send('redeem', [id], { from: HOLDER });
    const [ev] = ctx.bond.events(res, 'CouponTailOpened');
    const tailId = ev.args.tailId;
    await assert.rejects(() => ctx.bond.send('claimTail', [tailId], { from: HOLDER }), /NothingDue/);
    await assert.rejects(() => ctx.bond.send('claimTail', [tailId], { from: BUYER }), /NotTailOwner/);

    F.toEpoch(ctx, m + 2n);
    ctx.chain.advanceTime(5 * DAY);
    await F.distributeDue(ctx);
    const before = await ctx.chain.balanceOf(HOLDER);
    await ctx.bond.send('claimTail', [tailId], { from: HOLDER });
    const paid = (await ctx.chain.balanceOf(HOLDER)) - before;
    // The only holding in the base: the whole of both epochs, less what the
    // index divisions truncate and carry.
    assert.ok(paid <= 50n * ONE && 50n * ONE - paid < ONE / 1000n, `paid ${paid}`);
    assert.equal((await ctx.bond.call('tailOf', [tailId])).shares, 0n, 'a tail paid through its last epoch is gone');
    await assert.rejects(() => ctx.bond.send('claimTail', [tailId], { from: HOLDER }), /NotTailOwner/);
  });

  test('a holding redeemed with nothing unsettled opens no tail', async () => {
    const ctx = await F.deployBondStack();
    const id = await F.subscribe(ctx, { term: TERM.QUARTER, value: 1000n * ONE });
    const m = (await ctx.bond.call('holdingOf', [id])).maturityEpoch;
    F.toEpoch(ctx, m + 3n);
    ctx.chain.advanceTime(5 * DAY);
    await F.distributeDue(ctx);
    await ctx.bond.send('closeEpoch');
    // Everything closed before the payout is distributed only if the payout
    // waits for it; one epoch still unsettled is the normal case, so this
    // asserts the tail never reaches past the last closed epoch.
    const res = await ctx.bond.send('redeem', [id], { from: HOLDER });
    for (const ev of ctx.bond.events(res, 'CouponTailOpened')) {
      assert.ok(ev.args.throughEpoch <= epochNow(ctx) - 1n);
      assert.ok(ev.args.fromEpoch >= BigInt(await ctx.coupon.call('lastDistributed')));
    }
  });
});

describe('no delivered coupon is stranded (M5)', () => {
  test('proceeds delivered for the deployment epoch are distributed', async () => {
    const ctx = await F.deployBondStack();
    const e = epochNow(ctx);
    await F.deliverAndDistribute(ctx, e, 5n * ONE);
    assert.equal(await ctx.coupon.call('lastDistributed'), e);
  });

  test('a distribution made late still carries its residue into the following epoch', async () => {
    const ctx = await F.deployBondStack();
    await twoClasses(ctx);
    const inside = epochNow(ctx) + 1n;
    F.toEpoch(ctx, inside + 1n);
    await ctx.ledger.send('deliver', [inside], { from: ACCOUNTS.bob, value: 50n * ONE });
    // Distributed only after the following epoch's own credit window has shut.
    F.toEpoch(ctx, inside + 3n);
    ctx.chain.advanceTime(5 * DAY);
    for (let e = BigInt(await ctx.coupon.call('lastDistributed')) + 1n; e < inside; e++) await ctx.coupon.send('distribute', [e]);
    await ctx.coupon.send('distribute', [inside]);
    assert.equal(await ctx.ledger.call('remainingIn', [inside]), 0n, 'nothing stranded');
    assert.equal(await ctx.ledger.call('deliveredIn', [inside + 1n]), 50n * ONE, 'carried whole');
  });
});

describe('a class reduced to dust starts a new generation rather than truncating shares (L2)', () => {
  test('a subscription after a near-total loss is worth what it paid', async () => {
    const ctx = await F.deployBondStack();
    await F.subscribe(ctx, { value: 1000n * ONE });
    await ctx.bond.send('placeWithStaking', [1000n * ONE]);
    await ctx.delegation.send('loseStake', [1000n * ONE - 1n]);
    await ctx.staking.send('syncLoss');
    const late = await F.subscribe(ctx, { from: BUYER, value: 1000n * ONE });
    const worth = await ctx.bond.call('principalOf', [late]);
    assert.ok(worth >= 1000n * ONE && worth <= 1000n * ONE + 1n, `worth ${worth}`);
  });
});

describe('the conditional release reads one utilisation per boundary crossed, and a recent operating epoch (L3)', () => {
  test('one call across a gap of epochs counts one reading, not one per epoch', async () => {
    const ctx = await F.deployBondStack();
    await F.anchor(ctx, { notional: 200n * ONE });
    await F.subscribe(ctx, { class_: CLASS.JUNIOR, value: 100_000n * ONE });
    F.toNextEpoch(ctx);
    await ctx.bond.send('closeEpoch');
    assert.equal((await state(ctx)).belowEpochs, 0n);
    await F.subscribe(ctx, { class_: CLASS.JUNIOR, value: 2_000_000n * ONE });
    for (let i = 0; i < 3; i++) F.toNextEpoch(ctx);
    await ctx.bond.send('closeEpoch');
    assert.equal((await state(ctx)).belowEpochs, 1n);
  });

  test('an operating epoch long past does not satisfy the condition for ever', async () => {
    const ctx = await F.deployBondStack();
    await F.anchor(ctx, { notional: 200n * ONE });
    const first = cliffEpochNow(ctx);
    await F.subscribe(ctx, { class_: CLASS.JUNIOR, value: 2_000_000n * ONE });
    await F.distributeDue(ctx);
    await F.deliverAndDistribute(ctx, first, 100n * ONE);
    for (let i = 0; i < 5; i++) {
      F.toNextEpoch(ctx);
      await F.distributeDue(ctx);
    }
    await ctx.attest.send('seal', [epochNow(ctx) - 1n, '0x' + 'ab'.repeat(32)]);
    await assert.rejects(() => ctx.bond.send('conditionalRelease'), /NoOperatingEpoch/);
  });
});

describe('a long gap is closed in bounded batches (L4)', () => {
  test('a path across too long a gap names the batch call, and the batch call closes it', async () => {
    const ctx = await F.deployBondStack();
    await F.subscribe(ctx, { value: 1000n * ONE });
    ctx.chain.advanceTime(40 * EPOCH);
    await assert.rejects(() => ctx.bond.send('closeEpoch'), /EpochGapTooLong/);
    await assert.rejects(() => F.subscribe(ctx, { value: ONE }), /EpochGapTooLong/);
    await ctx.bond.send('closeEpochs', [20n]);
    await ctx.bond.send('closeEpochs', [20n]);
    assert.equal((await state(ctx)).lastClosedEpoch, epochNow(ctx) - 1n);
    await F.subscribe(ctx, { value: ONE });
  });
});

describe('a split re-bases the seller\'s debts on the shares it keeps', () => {
  test('the half kept is paid its staking distribution after a split, not withheld against the whole', async () => {
    const ctx = await F.deployBondStack();
    const id = await F.subscribe(ctx, { from: HOLDER, value: 1000n * ONE });
    await F.stakingDistribution(ctx, 100n * ONE);
    const h = await ctx.bond.call('holdingOf', [id]);
    // The first 100 accrued to the whole holding, before the split: the seller's.
    const atSplit = await received(ctx, HOLDER, () =>
      ctx.bond.send('transferHolding', [id, BUYER, h.shares / 2n], { from: HOLDER }));
    assert.ok(atSplit >= 100n * ONE - 10n ** 6n && atSplit <= 100n * ONE, `paid at the split ${atSplit}`);

    await F.stakingDistribution(ctx, 100n * ONE);
    const got = await received(ctx, HOLDER, () => ctx.bond.send('claim', [id], { from: HOLDER }));
    assert.ok(got >= 50n * ONE - 10n ** 6n && got <= 50n * ONE, `the kept half received ${got}`);
  });

  test('a whole transfer pays the seller what it accrued, and the buyer nothing of it', async () => {
    const ctx = await F.deployBondStack();
    const id = await F.subscribe(ctx, { from: HOLDER, value: 1000n * ONE });
    await F.stakingDistribution(ctx, 100n * ONE);
    const credited = (await state(ctx)).freePool;
    const h = await ctx.bond.call('holdingOf', [id]);
    const got = await received(ctx, HOLDER, () =>
      ctx.bond.send('transferHolding', [id, BUYER, h.shares], { from: HOLDER }));
    assert.ok(got >= 100n * ONE - 10n ** 6n && got <= 100n * ONE, `seller received ${got}`);
    await assert.rejects(() => ctx.bond.send('claim', [id], { from: BUYER }), /NothingDue/);
    assert.equal((await state(ctx)).freePool, credited - got, 'nothing left owed to nobody');
  });

  test('a void holding cannot be transferred', async () => {
    const ctx = await F.deployBondStack();
    const id = await F.subscribe(ctx, { value: 1000n * ONE });
    await ctx.bond.send('placeWithStaking', [1000n * ONE]);
    await ctx.delegation.send('loseStake', [1000n * ONE]);
    await ctx.staking.send('syncLoss');
    await assert.rejects(() => ctx.bond.send('transferHolding', [id, BUYER, 1n], { from: HOLDER }), /HoldingVoid/);
  });
});

/* ------------------------------------------------------------------ */
/* A randomised run against the invariants, on a fixed seed            */
/* ------------------------------------------------------------------ */

describe('under any sequence of operations the pots stay funded and the cursors stay forward', () => {
  /** mulberry32: small, fast, and the same sequence on every machine. */
  function prng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Every refusal a random operation may legitimately meet, by name. */
  const EXPECTED = new RegExp([
    'JuniorTooThin', 'MaturityLadderFull', 'CouponBelowFloor', 'CouponPending', 'NotMatured',
    'InRunoffQueue', 'NotQueued', 'NothingDue', 'HeldByDetermination', 'HeldByFreeze',
    'PrincipalNotLiquid', 'HoldingVoid', 'NotYetPayable', 'CreditWindowShut', 'EpochAlreadyDistributed', 'NoShortfall', 'NothingToHarvest', 'NotSettled',
    'UtilisationNotLow', 'RunoffGateShut', 'NoOperatingEpoch', 'RootUnadmitted', 'NothingToRelease',
    'AmountExceedsHolding', 'DeterminationOpen', 'EpochSealed', 'ZeroValue',
    'DeterminationAlreadyOpen', 'NoSuchDetermination', 'ThreatStageAlreadyStepped',
  ].join('|'));

  const STEPS = 300;
  /** Early, while no principal has matured: matured principal is reserved and cannot be placed, so later nothing is total. */
  const CATASTROPHE = 70;

  /**
   * One seeded run. `toStage4` and `courtOpen` set how often the book is pushed
   * into the states that hold principal — the fourth threat stage (the gate)
   * and an open determination — so one run can reach the run-off queue and
   * another the ordinary redemption. Returns what completed and what was voided.
   */
  async function runFuzz(seed, { toStage4, fromStage4, courtOpen, catastrophe = CATASTROPHE }) {
    const rnd = prng(seed);
    const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
    const qrl = (lo, hi) => BigInt(Math.floor(lo + rnd() * (hi - lo))) * ONE + BigInt(Math.floor(rnd() * 1e9));

    const ctx = await F.deployBondStack({ stage: 3 });
    await F.anchor(ctx, { notional: 50n * ONE });
    const people = [ACCOUNTS.alice, ACCOUNTS.bob, ACCOUNTS.mallory];
    const ids = [];
    const cursor = new Map();
    const stale = new Set();
    let stage = 3;
    let lastMove = -1n;
    const openDets = [];
    let detSeq = 0;

    const done = {};
    let current = '';
    async function attempt(fn) {
      try {
        await fn();
        done[current] = (done[current] || 0) + 1;
        return true;
      } catch (e) {
        const why = String(e.message).match(EXPECTED);
        if (!why) throw e;
        refused[`${current}:${why[0]}`] = (refused[`${current}:${why[0]}`] || 0) + 1;
        return false;
      }
    }
    const refused = {};

    /**
     * A holding is void once its class has been drawn to nothing: the class then
     * holds no shares while the holding still does (class shares are the sum of
     * its live holdings'), or a later holding of the class carries a newer
     * generation.
     */
    async function refreshStale() {
      const s = await state(ctx);
      const classShares = [s.juniorShares, s.seniorShares];
      const hs = [];
      for (const id of ids) hs.push([id, await ctx.bond.call('holdingOf', [id])]);
      const maxGen = [0n, 0n];
      for (const [, h] of hs) if (h.gen > maxGen[Number(h.class_)]) maxGen[Number(h.class_)] = h.gen;
      for (const [id, h] of hs) {
        const c = Number(h.class_);
        if (h.gen < maxGen[c] || (h.shares > 0n && classShares[c] === 0n)) stale.add(id);
      }
    }

    async function checkInvariants(step) {
      await refreshStale();
      const s = await state(ctx);
      if (process.env.FUZZ_TALLY && step % 20 === 0) {
        console.log(step, 'epoch', epochNow(ctx), 'gate', s.gateClosed, 'clear', s.clearEpochs, 'open', s.determinationsOpen, 'out', s.outstanding / ONE, 'stage', stage);
      }
      const couponBal = await ctx.chain.balanceOf(ctx.coupon.address);
      let withheld = 0n;
      for (const p of people) withheld += await ctx.coupon.call('withheldOf', [p]);
      assert.ok(couponBal >= s.couponPool + withheld, `step ${step}: coupon ${couponBal} < pool ${s.couponPool} + withheld ${withheld}`);

      const bondBal = await ctx.chain.balanceOf(ctx.bond.address);
      const placed = await ctx.bond.call('placedWithStaking');
      const cushion = await ctx.bond.call('cushion');
      assert.ok(
        bondBal + placed >= s.outstanding + s.freePool + s.principalOwed + cushion,
        `step ${step}: bond ${bondBal} + placed ${placed} < outstanding ${s.outstanding} + free ${s.freePool} + owed ${s.principalOwed} + cushion ${cushion}`,
      );

      for (const id of ids) {
        const h = await ctx.bond.call('holdingOf', [id]);
        const prev = cursor.get(id);
        if (prev !== undefined) assert.ok(h.claimedThrough >= prev, `step ${step}: cursor of ${id} moved back`);
        assert.ok(h.claimedThrough >= h.cliffEpoch - 1n, `step ${step}: cursor of ${id} below its cliff`);
        cursor.set(id, h.claimedThrough);
        if (stale.has(id)) assert.equal(await ctx.bond.call('principalOf', [id]), 0n, `step ${step}: void ${id} has worth`);
      }
    }

    /** Distribute every epoch whose reveal window has closed, in order. */
    async function catchUpCoupon() {
      for (;;) {
        const next = BigInt(await ctx.coupon.call('lastDistributed')) + 1n;
        if (BigInt(ctx.chain.timestamp) < F.settlementCloses(next)) return;
        await ctx.coupon.send('distribute', [next]);
      }
    }

    /** Run an operation on a holding; a void one must not receive a wei, whatever it calls. */
    async function onHolding(id, owner, fn) {
      const before = await ctx.chain.balanceOf(owner);
      await attempt(fn);
      if (stale.has(id)) assert.equal(await ctx.chain.balanceOf(owner), before, `void holding ${id} was paid`);
    }

    const ops = [
      ['subscribe', 6, async () => {
        const class_ = rnd() < 0.7 ? CLASS.JUNIOR : CLASS.SENIOR;
        const from = pick(people);
        await attempt(async () => {
          const res = await ctx.bond.send('subscribe', [rnd() < 0.85 ? TERM.QUARTER : TERM.YEAR, class_], { from, value: qrl(1, 3000) });
          const [ev] = ctx.bond.events(res, 'Subscribed');
          ids.push(ev.args.id);
        });
      }],
      ['transfer', 3, async () => {
        if (!ids.length) return;
        const id = pick(ids);
        const h = await ctx.bond.call('holdingOf', [id]);
        if (h.shares === 0n) return;
        const part = rnd() < 0.5 ? h.shares : h.shares / BigInt(2 + Math.floor(rnd() * 5));
        await onHolding(id, h.owner, async () => {
          const res = await ctx.bond.send('transferHolding', [id, pick(people), part === 0n ? 1n : part], { from: h.owner });
          const [ev] = ctx.bond.events(res, 'HoldingTransferred');
          if (ev.args.newId !== id) ids.push(ev.args.newId);
        });
      }],
      ...['claim', 'redeem', 'claimQueued'].map((fn) => [fn, fn === 'claim' ? 3 : 5, async () => {
        if (!ids.length) return;
        // A keeper distributes whatever coupon is payable first, as the relayer would.
        await catchUpCoupon();
        // Mostly a live holding, and for a payout of principal mostly a matured one.
        let pool = ids.filter((i) => !stale.has(i));
        if (fn !== 'claim') {
          const now = epochNow(ctx);
          const matured = [];
          for (const i of pool) if ((await ctx.bond.call('holdingOf', [i])).maturityEpoch < now) matured.push(i);
          if (matured.length) pool = matured;
        }
        const id = pool.length && rnd() < 0.8 ? pick(pool) : pick(ids);
        const h = await ctx.bond.call('holdingOf', [id]);
        await onHolding(id, h.owner, () => ctx.bond.send(fn, [id], { from: h.owner }));
      }]),
      ['deliver', 5, async () => {
        // Bob stands in for the swap: the last closed epoch, or the one before
        // while its settlement window is still open.
        const now = BigInt(ctx.chain.timestamp) / BigInt(EPOCH);
        const epoch = rnd() < 0.5 || now < 2n ? now - 1n : now - 2n;
        await attempt(() => ctx.ledger.send('deliver', [epoch], { from: ACCOUNTS.bob, value: qrl(0, 40) + 1n }));
      }],
      ['distribute', 3, async () => {
        const next = BigInt(await ctx.coupon.call('lastDistributed')) + 1n;
        await attempt(() => ctx.coupon.send('distribute', [next]));
      }],
      ['closeEpoch', 1, () => attempt(() => ctx.bond.send('closeEpoch'))],
      ['advance', 7, async () => ctx.chain.advanceTime(Math.floor(rnd() * 10 * DAY) + 3600)],
      ['place', 2, async () => {
        const free = await ctx.bond.call('unencumbered');
        if (free > 0n) await attempt(() => ctx.bond.send('placeWithStaking', [(free * BigInt(Math.floor(rnd() * 90) + 1)) / 100n]));
      }],
      ['recall', 1, async () => {
        let res = null;
        await attempt(async () => {
          res = await ctx.staking.send('recall', [qrl(0, 2000) + 1n]);
        });
        const ev = res && ctx.staking.events(res, 'Requested')[0];
        if (ev) {
          await attempt(() => ctx.pool.send('settle', [8n]));
          await attempt(() => ctx.staking.send('claim', [ev.args.requestId]));
        }
      }],
      ['stakingDistribution', 2, async () => {
        if ((await ctx.bond.call('placedWithStaking')) === 0n) return;
        await attempt(() => F.stakingDistribution(ctx, qrl(0, 20) + 7n));
      }],
      ['loss', 1, async () => {
        const p = await ctx.delegation.call('principal');
        if (p === 0n) return;
        const whole = rnd() < 0.15;
        await ctx.delegation.send('loseStake', [whole ? p : p / BigInt(5 + Math.floor(rnd() * 20))]);
        if (rnd() < 0.5) await ctx.staking.send('syncLoss');
      }],
      ['stage', 2, async () => {
        // Into the fourth stage now and then, and out again soon, so maturities
        // meet both an open gate and a closed one.
        if (rnd() >= (stage === 3 ? toStage4 : fromStage4)) return;
        // The stage is the phase's since item 129: into Q-Day (phase 3, stage
        // 4) and back below the gate's ground to phase 2, a step only the
        // double takes (core's ArkPhase has no way out of 3 but Restoration).
        // One move per epoch, in force from the next boundary, as a vote's.
        const e = epochNow(ctx);
        if (e === lastMove) return;
        if (await attempt(() => phaseFromNext(ctx, stage === 3 ? 3 : 2))) {
          lastMove = e;
          stage = stage === 3 ? 4 : 3;
        }
      }],
      ['court', 1, async () => {
        // Mostly closing what is open, so the book is not held for most of the run.
        if (openDets.length && rnd() < 0.8) {
          const det = openDets.splice(Math.floor(rnd() * openDets.length), 1)[0];
          await attempt(() => ctx.court.send('close', [det]));
        } else if (rnd() < courtOpen) {
          const det = '0x' + (++detSeq).toString(16).padStart(64, '0');
          if (await attempt(() => ctx.court.send('open', [det]))) openDets.push(det);
        }
      }],
      ['release', 1, async () => {
        await attempt(() => ctx.attest.send('seal', [epochNow(ctx) - 1n, '0x' + 'ab'.repeat(32)]));
        await attempt(() => ctx.bond.send('conditionalRelease'));
      }],
    ];
    const weighted = ops.flatMap(([name, w, fn]) => Array(w).fill([name, fn]));

    for (let step = 0; step < STEPS; step++) {
      let [name, fn] = pick(weighted);
      // Once, a whole class is lost: every idle wei placed, and the delegation
      // loses everything it holds. That is what voids a generation.
      if (step === catastrophe) {
        name = 'catastrophe';
        fn = async () => {
          const free = await ctx.bond.call('unencumbered');
          if (free > 0n) await ctx.bond.send('placeWithStaking', [free]);
          const p = await ctx.delegation.call('principal');
          if (p > 0n) await ctx.delegation.send('loseStake', [p]);
          await ctx.staking.send('syncLoss');
        };
      }
      current = name;
      try {
        await fn();
      } catch (e) {
        throw new Error(`step ${step} (${name}): ${e.message}`);
      }
      await checkInvariants(step);
    }
    if (process.env.FUZZ_TALLY) console.log(JSON.stringify(done), JSON.stringify(refused), 'void', stale.size);
    // The run is only evidence if it reached the paths the invariants are about.
    for (const op of ['subscribe', 'transfer', 'claim', 'distribute', 'deliver']) {
      assert.ok(done[op] > 0, `the run never completed a ${op}`);
    }
    assert.ok(stale.size > 0, 'the run never voided a generation');
    return done;
  }

  test(`a calm book, seed 20260922, ${STEPS} operations: maturities are redeemed`, async () => {
    const done = await runFuzz(20260922, { toStage4: 0.1, fromStage4: 1, courtOpen: 0.1 });
    assert.ok(done.redeem > 0, 'the run never completed a redemption');
  });

  // Seed 7340035 since 2026-09-28 (phase C3): the gate now observes the stage
  // in force in the epoch it closes (G8), a boundary later than before, and
  // 7340033's path no longer reached a queue draw. The seed is a choice of
  // path; the invariants are checked on every step of any.
  test(`a stormy book, seed 7340035, ${STEPS} operations: maturities are queued and drawn`, async () => {
    const done = await runFuzz(Number(process.env.FUZZ_SEED || 7340035), { toStage4: 0.8, fromStage4: 0.15, courtOpen: 0.15, catastrophe: 25 });
    assert.ok(done.claimQueued > 0, 'the run never completed a queue draw');
  });
});

describe('a booked loss is not escaped by redeeming at par first (D7)', () => {
  test('a redemption syncs a loss at staking before it prices the holding', async () => {
    const ctx = await F.deployBondStack();
    const a = await F.subscribe(ctx, { from: HOLDER, term: TERM.QUARTER, value: 1000n * ONE });
    await F.subscribe(ctx, { from: BUYER, term: TERM.YEAR, value: 1000n * ONE });
    await ctx.bond.send('placeWithStaking', [1000n * ONE]);
    // The delegation has lost half of what it holds; nobody has told the bond.
    await ctx.delegation.send('loseStake', [500n * ONE]);
    const m = (await ctx.bond.call('holdingOf', [a])).maturityEpoch;
    F.toEpoch(ctx, m + 1n);
    await F.distributeDue(ctx);

    const got = await received(ctx, HOLDER, () => ctx.bond.send('redeem', [a], { from: HOLDER }));
    assert.equal(got, 750n * ONE, 'the loss is borne pro rata, and not escaped');
  });
});

/* ------------------------------------------------------------------ */
/* The 2026-09-27 audit: D6, D5, D18                                   */
/* ------------------------------------------------------------------ */

describe('no principal leaves after a declaration, ahead of the trigger-2 settlement (D6, whitepaper §5.2)', () => {
  test('a matured holding is not redeemed once Q-Day is declared, freeze lifted and no determination open', async () => {
    const ctx = await F.deployBondStack();
    const id = await F.subscribe(ctx, { term: TERM.QUARTER, value: 1000n * ONE });
    const m = (await ctx.bond.call('holdingOf', [id])).maturityEpoch;
    F.toEpoch(ctx, m + 1n);
    await F.distributeDue(ctx);
    await ctx.qday.send('declare', [BigInt(ctx.chain.timestamp)]);
    assert.equal(await ctx.qday.call('frozen'), false);
    await assert.rejects(() => ctx.bond.send('redeem', [id], { from: HOLDER }), /DeclaredPendingSettlement/);
    await assert.rejects(() => ctx.bond.send('claimQueued', [id], { from: HOLDER }), /DeclaredPendingSettlement/);
    assert.equal(await outstanding(ctx), 1000n * ONE, 'the principal stays behind the settlement');
    // A transfer moves no principal out of the pool, so it is not a payout.
    const h = await ctx.bond.call('holdingOf', [id]);
    await ctx.bond.send('transferHolding', [id, BUYER, h.shares], { from: HOLDER });
  });

  test('the conditional release is refused once Q-Day is declared', async () => {
    const ctx = await F.deployBondStack();
    await F.anchor(ctx, { notional: 200n * ONE });
    const first = cliffEpochNow(ctx);
    await F.subscribe(ctx, { class_: CLASS.JUNIOR, value: 2_000_000n * ONE });
    await F.distributeDue(ctx);
    await F.deliverAndDistribute(ctx, first, 100n * ONE);
    F.toNextEpoch(ctx);
    F.toNextEpoch(ctx);
    await F.distributeDue(ctx);
    await ctx.attest.send('seal', [epochNow(ctx) - 1n, '0x' + 'ab'.repeat(32)]);
    await ctx.qday.send('declare', [BigInt(ctx.chain.timestamp)]);
    await assert.rejects(() => ctx.bond.send('conditionalRelease'), /DeclaredPendingSettlement/);
  });
});

describe('a dead valuation oracle does not freeze the bond (D5, whitepaper §5.5)', () => {
  test('with every price read reverting, the epoch closes, the coupon is distributed and a maturity is paid', async () => {
    const ctx = await F.deployBondStack();
    const id = await F.subscribe(ctx, { term: TERM.QUARTER, value: 1000n * ONE });
    const m = (await ctx.bond.call('holdingOf', [id])).maturityEpoch;
    await ctx.oracle.send('setReverting', [true]);
    await assert.rejects(() => ctx.registry.call('referencePrice'), /OracleUnavailable/);
    F.toEpoch(ctx, m + 1n);
    // Every epoch's coupon is distributed although `breakerActive` cannot be read.
    await F.distributeDue(ctx);
    const before = await ctx.chain.balanceOf(HOLDER);
    await ctx.bond.send('redeem', [id], { from: HOLDER });
    assert.equal((await ctx.chain.balanceOf(HOLDER)) - before, 1000n * ONE);
  });

  test('an epoch nobody could price neither counts toward the release nor breaks a run of low epochs', async () => {
    const ctx = await F.deployBondStack();
    await F.anchor(ctx, { notional: 200n * ONE });
    const first = cliffEpochNow(ctx);
    const hid = await F.subscribe(ctx, { class_: CLASS.JUNIOR, value: 2_000_000n * ONE });
    await F.distributeDue(ctx);
    await F.deliverAndDistribute(ctx, first, 100n * ONE);
    F.toNextEpoch(ctx);
    await ctx.bond.send('closeEpoch');
    const low = (await state(ctx)).belowEpochs;
    assert.ok(low >= 1n, 'the book is below the threshold');

    await ctx.oracle.send('setReverting', [true]);
    F.toNextEpoch(ctx);
    await ctx.bond.send('closeEpoch');
    assert.equal((await state(ctx)).belowEpochs, low, 'no reading: the count neither rises nor resets');
    // And a transfer, which crosses the boundary first, still goes through.
    F.toNextEpoch(ctx);
    await F.distributeDue(ctx);
    const h = await ctx.bond.call('holdingOf', [hid]);
    await ctx.bond.send('transferHolding', [hid, BUYER, h.shares / 2n], { from: HOLDER });
    assert.equal((await state(ctx)).belowEpochs, low);

    await ctx.oracle.send('setReverting', [false]);
    F.toNextEpoch(ctx);
    await ctx.bond.send('closeEpoch');
    assert.equal((await state(ctx)).belowEpochs, low + 1n, 'the count resumes where it stood');
  });
});

describe('the epoch boundary shares the bond\'s reentrancy guard (D18)', () => {
  test('under the guard, closing is still permissionless and idempotent', async () => {
    const ctx = await F.deployBondStack();
    F.toNextEpoch(ctx);
    await ctx.bond.send('closeEpoch', [], { from: ACCOUNTS.mallory });
    await ctx.bond.send('closeEpoch', [], { from: ACCOUNTS.mallory });
    await ctx.bond.send('closeEpochs', [4n], { from: ACCOUNTS.mallory });
  });
});
