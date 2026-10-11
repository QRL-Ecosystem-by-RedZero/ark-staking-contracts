/**
 * Audit round OC (2026-10-03), the ECON stream and OC-COURT-01: one
 * regression per fix, each asserting the specification's behaviour where the
 * audit's proof of concept (docs/review/audit-2026-10-03/ECON/econ-poc.test.js,
 * COURT/court-i24-delivery.test.js) asserted the exploit.
 *
 *  - OC-ECON-01: the recovery claim stays with the holding of record; a record
 *    carved out after the draw claims nothing, and a class's leaves never sum
 *    above its part of the recovery (I23, I36).
 *  - OC-ECON-02: a carved record starts at its parent's relief cursor (I26′).
 *  - OC-ECON-03: a partial burn re-bases the holding's debts on the shares left.
 *  - OC-ECON-04: a declaration ratified while censorship slices are open is the
 *    whole ground, whoever calls first (YP §3.4, I37).
 *  - OC-ECON-06: entitlement claims never pass what is served.
 *  - OC-ECON-08: a coupon the pool cannot meet is not paid and not advanced past.
 *  - OC-ECON-09: every queue weight from the eighth clean age is the floor.
 *  - OC-COURT-01: a finding draws no more than the V it was admitted at (I24, G8),
 *    and no position's loss is taken above its notional.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { keccak256, toUtf8Bytes, id: selectorOf, AbiCoder } = require('ethers');
const { createAddressFromString, hexToBytes, bytesToHex } = require('@ethereumjs/util');
const F = require('./stake-fixture');
const { coder } = require('./harness');

const { ACCOUNTS, ONE, EPOCH, BPS, TERM, CLASS, CHAIN_ID, ESCROW, ASSET_A, PRICE_SCALE, JUROR_MIN_STAKE } = F;
const HOLDER = ACCOUNTS.alice;
const OTHER = ACCOUNTS.bob;
const MALLORY = ACCOUNTS.mallory;
const DAY = 24 * 3600;
const PRICE = PRICE_SCALE;
const DEST = '0x' + '33'.repeat(20);
const sid = (n) => '0x' + (0xa0 + n).toString(16).repeat(32);
const rid = (n) => '0x' + (0x10 + n).toString(16).repeat(32);
const det = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const T2_FLOOR = keccak256(toUtf8Bytes('ARK_T2_FLOOR'));
const uintPayload = (x) => AbiCoder.defaultAbiCoder().encode(['uint256'], [x]);
const epochNow = (ctx) => BigInt(ctx.chain.timestamp) / BigInt(EPOCH);

/** The bond's one refusal of a court finding, `FindingRefused(cause)`. */
const refused = (cause) => (e) =>
  /FindingRefused/.test(String(e && e.message)) &&
  String((e && e.data) || '').toLowerCase().includes(selectorOf(cause).slice(2, 10));

async function received(ctx, who, fn) {
  const before = await ctx.chain.balanceOf(who);
  const res = await fn();
  return { got: (await ctx.chain.balanceOf(who)) - before, res };
}

function attach(ctx) {
  ctx.s = ctx.chain.at('ArkCatBondSettlement', ctx.bond.address);
  ctx.r = ctx.chain.at('ArkCatBondRecovery', ctx.bond.address);
  return ctx;
}

/** A trigger-2 settlement drawn and settled at D_0: junior bore the draw. */
async function settledBook() {
  const ctx = attach(await F.deployBondStack());
  const p = await F.anchor(ctx, { owner: HOLDER, depositor: HOLDER, nonce: 0n, notional: 100n * ONE });
  ctx.chain.advanceTime(91 * DAY);
  ctx.junior = await F.subscribe(ctx, { from: HOLDER, class_: CLASS.JUNIOR, term: TERM.QUARTER, value: 70_000n * ONE });
  ctx.senior = await F.subscribe(ctx, { from: OTHER, class_: CLASS.SENIOR, term: TERM.QUARTER, value: 30_000n * ONE });
  await F.declare(ctx, BigInt(ctx.chain.timestamp));
  await ctx.r.send('recordClaimants', [[p.id]], { from: MALLORY });
  await ctx.s.send('settleDeclaration', [], { from: MALLORY });
  const t2 = await ctx.s.call('declaration');
  F.toEpoch(ctx, t2.epoch + 4n);
  await ctx.oracle.send('set', [9000n * PRICE, 9000n * PRICE, 9000n * PRICE]);
  await ctx.s.send('settleSeverity');
  ctx.pos = p;
  return ctx;
}

async function openedRecovery(ctx) {
  await ctx.params.send('admitSuccessor', [CHAIN_ID, sid(1)]);
  const res = await ctx.court.send('openRecovery', [rid(1), CHAIN_ID, sid(1), ESCROW, 10n * ONE, 100n * ONE]);
  return ctx.s.events(res, 'RecoveryOpened')[0].args;
}

const sealedOf = (ctx, res) => ctx.s.events(res, 'RecoveryLeafSealed')[0].args.quantity;

/* ------------------------------------------------------------------ */
/* OC-ECON-01                                                          */
/* ------------------------------------------------------------------ */

describe('OC-ECON-01: the recovery claim stays with the holding of record at the draw (whitepaper §5.4, I23, I36)', () => {
  test('claim, then split: the carved record claims nothing, and the class seals its share once', async () => {
    const ctx = await settledBook();
    const { toJunior } = await openedRecovery(ctx);
    assert.ok(toJunior > 0n);
    const r1 = await ctx.r.send('claimRecovery', [rid(1), ctx.junior, DEST], { from: HOLDER });
    assert.equal(sealedOf(ctx, r1), toJunior, 'the holding of record seals the whole class share');

    await F.distributeDue(ctx);
    let id = ctx.junior;
    let owner = HOLDER;
    for (let i = 0; i < 3; i++) {
      const h = await ctx.bond.call('holdingOf', [id]);
      const tx = await ctx.bond.send('transferHolding', [id, MALLORY, h.shares - 1n], { from: owner });
      id = ctx.bond.events(tx, 'HoldingTransferred')[0].args.newId;
      owner = MALLORY;
      const carved = await ctx.bond.call('holdingOf', [id]);
      assert.equal(carved.declFixed, true);
      assert.equal(carved.declShares, 0n, 'the carved record holds no claim of record');
      await assert.rejects(() => ctx.r.send('claimRecovery', [rid(1), id, DEST], { from: MALLORY }), /NotClaimant/);
    }
    assert.equal((await ctx.bond.call('holdingOf', [ctx.junior])).declShares > 0n, true, 'the record keeps its claim');
  });

  test('split after the draw and before any claim: the seller of record claims the whole share, the buyer nothing', async () => {
    const ctx = await settledBook();
    const { toJunior } = await openedRecovery(ctx);
    await F.distributeDue(ctx);
    const h = await ctx.bond.call('holdingOf', [ctx.junior]);
    const tx = await ctx.bond.send('transferHolding', [ctx.junior, MALLORY, h.shares / 2n], { from: HOLDER });
    const carved = ctx.bond.events(tx, 'HoldingTransferred')[0].args.newId;
    await assert.rejects(() => ctx.r.send('claimRecovery', [rid(1), carved, DEST], { from: MALLORY }), /NotClaimant/);
    const r1 = await ctx.r.send('claimRecovery', [rid(1), ctx.junior, DEST], { from: HOLDER });
    assert.equal(sealedOf(ctx, r1), toJunior, 'by holding of record at the opening determination');
    await assert.rejects(() => ctx.r.send('claimRecovery', [rid(1), ctx.junior, DEST], { from: HOLDER }), /AlreadyClaimed/);
  });
});

/* ------------------------------------------------------------------ */
/* OC-ECON-02 and OC-ECON-03: the run-off queue                         */
/* ------------------------------------------------------------------ */

async function queuedDrawn() {
  const ctx = attach(await F.deployBondStack({ stage: 4 }));
  const p = await F.anchor(ctx, { notional: ONE });
  ctx.q1 = await F.subscribe(ctx, { from: HOLDER, class_: CLASS.JUNIOR, term: TERM.QUARTER, value: 10_000n * ONE });
  ctx.q2 = await F.subscribe(ctx, { from: ACCOUNTS.carol || ACCOUNTS.guardian, class_: CLASS.JUNIOR, term: TERM.QUARTER, value: 10_000n * ONE });
  ctx.y = await F.subscribe(ctx, { from: OTHER, class_: CLASS.JUNIOR, term: TERM.YEAR, value: 10_000n * ONE });
  const m = (await ctx.bond.call('holdingOf', [ctx.q1])).maturityEpoch;
  F.toEpoch(ctx, m + 1n);
  await F.distributeDue(ctx);
  F.toNextEpoch(ctx);
  await F.distributeDue(ctx);
  const G = '0x' + '5c'.repeat(32);
  await ctx.court.send('open', [G]);
  await ctx.court.send('determineCensorship', [G, 0n]);
  await ctx.court.send('close', [G]);
  await ctx.r.send('recordClaimants', [[p.id]], { from: MALLORY });
  await ctx.s.send('settleDeclaration', [], { from: MALLORY });
  return ctx;
}

const reliefOf = (ctx, res) => {
  const ev = ctx.bond.events(res, 'ReliefPaid');
  return ev.length ? ev[0].args.amount : 0n;
};

async function reliefRun({ split }) {
  const ctx = await queuedDrawn();
  const q2Owner = (await ctx.bond.call('holdingOf', [ctx.q2])).owner;
  const r1 = await ctx.bond.send('claimQueued', [ctx.q1], { from: HOLDER });
  const out = { relief1: reliefOf(ctx, r1), relief2: 0n };
  if (split) {
    const h = await ctx.bond.call('holdingOf', [ctx.q1]);
    const tx = await ctx.bond.send('transferHolding', [ctx.q1, MALLORY, h.shares - 1n], { from: HOLDER });
    ctx.n = ctx.bond.events(tx, 'HoldingTransferred')[0].args.newId;
    assert.equal((await ctx.bond.call('holdingOf', [ctx.n])).reliefCursor, h.reliefCursor, 'the cursor is copied');
  }
  F.toNextEpoch(ctx);
  await F.distributeDue(ctx);
  if (split) out.relief2 = reliefOf(ctx, await ctx.bond.send('claimQueued', [ctx.n], { from: MALLORY }));
  out.reliefQ2 = reliefOf(ctx, await ctx.bond.send('claimQueued', [ctx.q2], { from: q2Owner }));
  return out;
}

describe('OC-ECON-02: a split carries the relief cursor (whitepaper §5.3, I26′)', () => {
  test('a record carved after a relief draw takes no relief again; the other queued holder is paid in full', async () => {
    const control = await reliefRun({ split: false });
    const run = await reliefRun({ split: true });
    assert.ok(control.relief1 > 0n && control.reliefQ2 > 0n, 'both queued holders are owed relief');
    assert.equal(run.relief1, control.relief1);
    assert.equal(run.relief2, 0n, 'the carved record was already paid through its parent');
    assert.equal(run.reliefQ2, control.reliefQ2, 'the other queued holder receives its whole relief');
  });
});

describe('OC-ECON-03: a partial burn re-bases the streams on the shares left', () => {
  test('after a partial queue draw, a later staking distribution pays the queued holding its per-share part', async () => {
    const ctx = await F.deployBondStack({ stage: 4 });
    const q = await F.subscribe(ctx, { from: HOLDER, class_: CLASS.JUNIOR, term: TERM.QUARTER, value: 1000n * ONE });
    const y = await F.subscribe(ctx, { from: OTHER, class_: CLASS.JUNIOR, term: TERM.YEAR, value: 1000n * ONE });
    const m = (await ctx.bond.call('holdingOf', [q])).maturityEpoch;
    await F.stakingDistribution(ctx, 100n * ONE);
    F.toEpoch(ctx, m + 1n);
    await F.distributeDue(ctx);
    F.toNextEpoch(ctx);
    await F.distributeDue(ctx);
    await ctx.bond.send('claimQueued', [q], { from: HOLDER });
    const hq = await ctx.bond.call('holdingOf', [q]);
    const accFreeAfterBurn = (await ctx.bond.call('state')).freePool;
    assert.ok(hq.shares > 0n, 'a partial draw');
    await ctx.bond.send('claim', [y], { from: OTHER });
    F.toNextEpoch(ctx);
    await F.stakingDistribution(ctx, 100n * ONE);
    F.toNextEpoch(ctx);
    await F.distributeDue(ctx);
    const b = await received(ctx, HOLDER, () => ctx.bond.send('claimQueued', [q], { from: HOLDER }));
    const freeQ = b.got - ctx.bond.events(b.res, 'Redeemed')[0].args.amount;
    const cy = await received(ctx, OTHER, () => ctx.bond.send('claim', [y], { from: OTHER }));
    const hy = await ctx.bond.call('holdingOf', [y]);
    const fairQ = (cy.got * hq.shares) / hy.shares;
    assert.ok(fairQ > ONE, 'a material part of the second distribution');
    const diff = freeQ > fairQ ? freeQ - fairQ : fairQ - freeQ;
    assert.ok(diff <= ONE / 10n ** 9n, `q is paid its per-share part (${freeQ} against ${fairQ})`);
    const left = (await ctx.bond.call('state')).freePool;
    assert.ok(left <= accFreeAfterBurn + 10n, `nothing of it is stranded in the free pool (${left})`);
  });
});

/* ------------------------------------------------------------------ */
/* OC-ECON-04                                                          */
/* ------------------------------------------------------------------ */

describe('OC-ECON-04: a declaration ratified while censorship slices are open is the whole ground (YP §3.4, I37)', () => {
  async function censorshipBook() {
    const ctx = attach(await F.deployBondStack());
    ctx.pos = await F.anchor(ctx, { owner: HOLDER, depositor: HOLDER, nonce: 0n, notional: 100n * ONE });
    ctx.chain.advanceTime(91 * DAY);
    await F.subscribe(ctx, { from: HOLDER, class_: CLASS.JUNIOR, term: TERM.YEAR, value: 70_000n * ONE });
    await F.subscribe(ctx, { from: OTHER, class_: CLASS.SENIOR, term: TERM.YEAR, value: 30_000n * ONE });
    return ctx;
  }

  test('the last slice closing after the ratification, before any grounding call, grounds nothing', async () => {
    const ctx = await censorshipBook();
    const G = det(0xc1);
    await ctx.court.send('open', [G]);
    await ctx.court.send('openSlices', [G, 2, 2]);
    await ctx.court.send('closeSlice', [G, 0, true, uintPayload(0n)]);
    // Ratified on the oracle alone: nobody has grounded the declaration yet,
    // and the last slice lands first.
    const at = BigInt(ctx.chain.timestamp);
    await ctx.qday.send('declare', [at]);
    const res = await ctx.court.send('closeSlice', [G, 1, true, uintPayload(0n)]);
    assert.equal(ctx.s.events(res, 'Trigger2Grounded').length, 0, 'the slice establishes no censorship ground');
    assert.equal(ctx.s.events(res, 'SliceClosed')[0].args.upheld, false, 'closes as refused');
    assert.equal((await ctx.r.call('claimants')).ground, 0n);
    const prior = at / BigInt(EPOCH) - 1n;
    await ctx.attest.send('seal', [prior, F.anchorCountLeaf(prior, 0n)]);
    await ctx.r.send('provePriorAnchors', [0n, []]);
    await ctx.r.send('recordClaimants', [[ctx.pos.id]], { from: MALLORY });
    assert.equal((await ctx.r.call('claimants')).ground, 1n, 'the declaration is the ground');
    await ctx.court.send('close', [G]);
    await ctx.s.send('settleDeclaration', [], { from: MALLORY });
    const t2 = await ctx.s.call('declaration');
    assert.equal(t2.censorship, false, 'settled as a declaration, severity and all');
    assert.equal(t2.stage, 1n, 'the assessment window is open');
  });

  test('after the ratification a censorship finding is refused, whole or as slices', async () => {
    const ctx = await censorshipBook();
    const G = det(0xc2);
    await ctx.court.send('open', [G]);
    await F.declare(ctx, BigInt(ctx.chain.timestamp));
    await assert.rejects(() => ctx.court.send('determineCensorship', [G, 0n]), refused('DeclarationAlreadySettled()'));
    await assert.rejects(() => ctx.court.send('openSlices', [G, 2, 2]), /DeclarationAlreadySettled/);
  });
});

/* ------------------------------------------------------------------ */
/* OC-COURT-01: the bound on V at delivery                             */
/* ------------------------------------------------------------------ */

async function lossBook({ positions = [100n * ONE], buffer = 0n } = {}) {
  const ctx = attach(await F.deployBondStack());
  ctx.pos = [];
  let nonce = 0n;
  for (const notional of positions) {
    ctx.pos.push(await F.anchor(ctx, { owner: HOLDER, depositor: HOLDER, nonce: nonce++, notional }));
  }
  await F.subscribe(ctx, { from: HOLDER, class_: CLASS.JUNIOR, term: TERM.YEAR, value: 70_000n * ONE });
  await F.subscribe(ctx, { from: OTHER, class_: CLASS.SENIOR, term: TERM.YEAR, value: 30_000n * ONE });
  ctx.chain.advanceTime(91 * DAY);
  if (buffer !== 0n) {
    const epoch = epochNow(ctx);
    await ctx.attest.send('seal', [epoch, F.bufferLeaf(CHAIN_ID, ASSET_A, epoch, buffer)]);
    await ctx.registry.send('recordBuffer', [CHAIN_ID, ESCROW, ASSET_A, epoch, buffer, []], { from: MALLORY });
  }
  return ctx;
}

const lossOf = (ctx, res) => ctx.s.events(res, 'LossDetermined')[0].args;

describe('OC-COURT-01: a finding draws no more than the V it was admitted at (I24, G8)', () => {
  test('a loss asserted above a position\'s notional is taken at the notional', async () => {
    const at = async (loss) => {
      const ctx = await lossBook();
      await ctx.court.send('open', [det(1)]);
      return lossOf(ctx, await ctx.court.send('determineLoss', [det(1), [ctx.pos[0].id], [loss]]));
    };
    const whole = await at(100n * ONE);
    const tenfold = await at(1_000n * ONE);
    assert.equal(tenfold.obligation, whole.obligation, 'the obligation is the notional\'s');
    assert.equal(tenfold.drawQrl, whole.drawQrl, 'and so is the draw');
  });

  test('the bond capital a trigger-1 finding can reach is V: one haircut spreads the rest', async () => {
    const ctx = await lossBook();
    const value = 3_000n * ONE;
    await ctx.court.send('open', [det(2)]);
    const unbounded = await (async () => {
      const c = await lossBook();
      await c.court.send('open', [det(2)]);
      return lossOf(c, await c.court.send('determineLoss', [det(2), [c.pos[0].id], [100n * ONE]]));
    })();
    assert.ok(unbounded.drawQrl > value, 'the control draws above V');
    const ev = lossOf(ctx, await ctx.court.send('determineLossAt', [det(2), [ctx.pos[0].id], [100n * ONE], value]));
    assert.ok(ev.drawQrl <= value, `drawn ${ev.drawQrl} within V ${value}`);
    assert.ok(ev.haircutBps < BPS, 'a haircut, not a refusal');
    const part = await ctx.s.call('lossPartOf', [det(2), ctx.pos[0].id]);
    assert.ok(part.qrl <= value);
  });

  test('the censorship ground\'s floor draw is bounded by the V of its upheld slices', async () => {
    const run = async (value) => {
      const ctx = await lossBook();
      const G = det(0xc3);
      await ctx.court.send('open', [G]);
      if (value === undefined) await ctx.court.send('determineCensorship', [G, 0n]);
      else await ctx.court.send('determineCensorshipAt', [G, 0n, value]);
      await ctx.court.send('close', [G]);
      await ctx.r.send('recordClaimants', [[ctx.pos[0].id]], { from: MALLORY });
      const res = await ctx.s.send('settleDeclaration', [], { from: MALLORY });
      return ctx.s.events(res, 'Trigger2Drawn')[0].args.drawQrl;
    };
    const control = await run(undefined);
    const value = control / 3n;
    assert.ok(value > 0n);
    assert.equal(await run(value), value, 'drawn to V and no further');

    // Sliced: only the upheld slices' V counts.
    const ctx = await lossBook();
    const G = det(0xc4);
    await ctx.court.send('open', [G]);
    await ctx.court.send('openSlices', [G, 2, 2]);
    await ctx.court.send('closeSliceAt', [G, 0, true, uintPayload(0n), value]);
    await ctx.court.send('closeSliceAt', [G, 1, false, '0x', 10n ** 30n]);
    await ctx.court.send('close', [G]);
    await ctx.r.send('recordClaimants', [[ctx.pos[0].id]], { from: MALLORY });
    const res = await ctx.s.send('settleDeclaration', [], { from: MALLORY });
    const drawn = ctx.s.events(res, 'Trigger2Drawn')[0].args.drawQrl;
    assert.ok(drawn <= value, `half the ground upheld at V ${value}: drawn ${drawn}`);
  });

  test('through the real court: a loss heard at V = K_open draws no more than V when K grows before delivery', async () => {
    const juror = (i) => '0x' + (0x3000 + i).toString(16).padStart(40, '0');
    const lossPayload = (list) => coder.encode(['bytes32[]', 'uint256[]'], [list.map((x) => x.id), list.map((x) => x.loss)]);
    const ctx = attach(await F.deployBondStack({ court: 'real' }));
    const pos = await F.anchor(ctx, { owner: HOLDER, depositor: HOLDER, nonce: 0n, notional: 100n * ONE });
    await F.subscribe(ctx, { from: HOLDER, class_: CLASS.JUNIOR, term: TERM.YEAR, value: 280_000n * ONE });
    await F.subscribe(ctx, { from: OTHER, class_: CLASS.SENIOR, term: TERM.YEAR, value: 120_000n * ONE });
    ctx.chain.advanceTime(91 * DAY);
    for (let i = 0; i < 7; i++) {
      const j = juror(i);
      await ctx.ark.send('transfer', [j, 10n * JUROR_MIN_STAKE], { from: ACCOUNTS.admin });
      await ctx.ark.send('approve', [ctx.jurorPool.address, 10n * JUROR_MIN_STAKE], { from: j });
      await ctx.jurorPool.send('stake', [10n * JUROR_MIN_STAKE], { from: j });
    }
    F.toNextEpoch(ctx);
    const arkPrice = 30n * ONE;
    await ctx.oracle.send('setPriceFor', [0n, ctx.ark.address, arkPrice]);
    const payload = lossPayload([{ id: pos.id, loss: 1_000n * ONE }]);
    const q = await ctx.findings.call('quote', [1, payload]);
    const res = await ctx.court.send('assertFinding', [1, payload, keccak256(toUtf8Bytes('e'))], { from: MALLORY, value: q[3] * q[4] });
    const caseId = ctx.court.events(res, 'AssertionOpened')[0].args.caseId;
    const c = await ctx.court.call('caseOf', [caseId]);
    const boundQrl = ((await ctx.findings.call('boundOf', [c.seat, c.slashBps, c.coverBps])) * arkPrice) / ONE;
    const k0 = await ctx.registry.call('requiredCapital');
    for (let n = 1n; n <= 2n; n++) await F.anchor(ctx, { owner: MALLORY, depositor: MALLORY, nonce: n, notional: 100n * ONE });
    assert.ok((await ctx.registry.call('requiredCapital')) > k0, 'K grew before delivery');
    ctx.chain.advanceTime(Number(c.challengeDays) * DAY + 1);
    const fin = await ctx.court.send('finalize', [caseId, payload]);
    const [ld] = ctx.s.events(fin, 'LossDetermined');
    assert.ok(ld, 'the loss reached the bond');
    assert.ok(ld.args.drawQrl <= c.value, `drawn ${ld.args.drawQrl} within V ${c.value}`);
    assert.ok(ld.args.drawQrl <= boundQrl, 'and within the I24 bound it was admitted under');
  });
});

/* ------------------------------------------------------------------ */
/* OC-ECON-06                                                          */
/* ------------------------------------------------------------------ */

describe('OC-ECON-06: what the entitlements are paid never passes what is served (I11)', () => {
  test('parts summing a few wei above the drawn total: every claim pays, the last capped, paid <= served', async () => {
    // Three positions, a buffer whose per-position parts truncate, and V
    // binding at exactly half the obligation: the parts' bond legs sum above V
    // by the buffer's truncation, the draw is clamped to V, and the parts
    // then exceed the settlement's total.
    const ctx = await lossBook({ positions: [100n * ONE, 100n * ONE, 100n * ONE], buffer: ONE + 7n });
    const indemnity = await ctx.registry.call('effectiveIndemnityBps');
    const price = await ctx.registry.call('settlementPrice');
    assert.equal(price % PRICE_SCALE, 0n, 'a whole price, so V converts exactly');
    // Each claim even, so a 5,000 bps haircut halves it exactly.
    const want = [3n * ONE + 2n, 3n * ONE + 1_000_000_004n, 4n * ONE + 1_234_566n];
    const losses = want.map((c) => {
      let l = (c * BPS + indemnity - 1n) / indemnity;
      while (((l * indemnity) / BPS) % 2n !== 0n) l += 1n;
      return l;
    });
    const claims = losses.map((l) => (l * indemnity) / BPS);
    const paid = claims.reduce((a, b) => a + b, 0n) / 2n;
    const B = ONE + 7n;
    const bondUnits = paid - B;
    const value = (bondUnits * price) / PRICE_SCALE;
    const delta = B - claims.map((c) => ((c / 2n) * B) / paid).reduce((a, b) => a + b, 0n);
    assert.ok(delta >= 1n, 'the buffer parts truncate');

    const D = det(6);
    await ctx.court.send('open', [D]);
    const res = await ctx.court.send('determineLossAt', [D, ctx.pos.map((p) => p.id), losses, value]);
    const ev = lossOf(ctx, res);
    assert.equal(ev.haircutBps, 5000n);
    const parts = ctx.s.events(res, 'LossPartRecorded').reduce((a, e) => a + e.args.entitlementQrl, 0n);
    assert.equal(ev.drawQrl, value, 'drawn to V');
    assert.ok(parts > ev.drawQrl, `the parts (${parts}) exceed the drawn total (${ev.drawQrl})`);

    F.toNextEpoch(ctx);
    let sum = 0n;
    for (const p of ctx.pos) {
      const c = await ctx.s.send('claimSettlement', [D, p.id], { from: HOLDER });
      sum += ctx.s.events(c, 'SettlementClaimed')[0].args.amount;
    }
    const [, served, paidOut] = await ctx.s.call('settlementOf', [D]);
    assert.ok(paidOut <= served, `paid ${paidOut} <= served ${served}`);
    assert.equal(sum, value, 'the whole draw and not a wei more');
    await ctx.bond.call('principalOwedNow');
    await ctx.bond.call('unencumbered');
  });
});

/* ------------------------------------------------------------------ */
/* OC-ECON-08                                                          */
/* ------------------------------------------------------------------ */

describe('OC-ECON-08: a coupon the pool cannot meet is not paid and its cursor does not move', () => {
  async function slotOf(chain, address, value, max = 40) {
    const addr = createAddressFromString(address);
    for (let s = 0; s < max; s++) {
      const v = await chain.vm.stateManager.getStorage(addr, hexToBytes('0x' + s.toString(16).padStart(64, '0')));
      if (v.length && BigInt(bytesToHex(v)) === value) return s;
    }
    throw new Error('slot not found');
  }

  test('owed above the pool: nothing paid, cursor kept; paid in full once the pool covers it', async () => {
    const ctx = await F.deployBondStack();
    const first = (BigInt(ctx.chain.timestamp) + BigInt(30 * DAY)) / BigInt(EPOCH) + 1n;
    const j = await F.subscribe(ctx, { from: HOLDER, class_: CLASS.JUNIOR, value: 7000n * ONE });
    await F.subscribe(ctx, { from: OTHER, class_: CLASS.SENIOR, value: 3000n * ONE });
    await F.distributeDue(ctx);
    await F.deliverAndDistribute(ctx, first, 50n * ONE);
    const owed = await ctx.coupon.call('owed', [CLASS.JUNIOR, first - 1n, 7000n * ONE]);
    const pool = await ctx.coupon.call('pool');
    assert.ok(owed > 0n && pool >= owed);
    const slot = await slotOf(ctx.chain, ctx.coupon.address, pool);
    const code = bytesToHex(await ctx.chain.vm.stateManager.getCode(createAddressFromString(ctx.coupon.address)));
    await ctx.chain.installCode(ctx.coupon.address, code, { [slot]: owed - 1n });
    assert.equal(await ctx.coupon.call('pool'), owed - 1n);

    const cursor = (await ctx.bond.call('holdingOf', [j])).claimedThrough;
    await assert.rejects(() => ctx.bond.send('claim', [j], { from: HOLDER }), /NothingDue/, 'nothing paid out of a short pool');
    assert.equal((await ctx.bond.call('holdingOf', [j])).claimedThrough, cursor, 'the cursor stays');
    assert.equal(await ctx.coupon.call('pool'), owed - 1n, 'the pool is untouched');

    await ctx.chain.installCode(ctx.coupon.address, code, { [slot]: pool });
    const got = await received(ctx, HOLDER, () => ctx.bond.send('claim', [j], { from: HOLDER }));
    assert.equal(got.got, owed, 'paid in full once the pool covers it');
  });
});

/* ------------------------------------------------------------------ */
/* OC-ECON-09                                                          */
/* ------------------------------------------------------------------ */

describe('OC-ECON-09: from the eighth clean age every queue weight is the floor', () => {
  test('even where the decay alone would not have reached the floor by then', async () => {
    const ctx = await F.deployBondStack();
    const math = await ctx.chain.deploy('StakeMathHarness');
    // Outside the admissible ranges (decay 500): x(7) is above the floor, x(8) is the floor.
    assert.equal(await math.call('queueExposureBps', [500n, 2000n, 7n]), 10_000n - 3500n);
    for (const age of [8n, 9n, 12n, 100n]) {
      assert.equal(await math.call('queueExposureBps', [500n, 2000n, age]), 2000n, `age ${age}`);
    }
  });
});
