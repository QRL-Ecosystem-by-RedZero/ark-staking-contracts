/**
 * The court's deposit base in units of the origin asset (yellow paper §5.1;
 * technical reference §1.8, §3.4, §3.6; 2026-10-06; proposal
 * docs/review/audit-2026-10-03/COURT/DEPOSIT-BASE-PROPOSAL.md).
 *
 *   - A loss is heard where the losses named, capped at K, are at least
 *     `base_orig`, compared in origin units before any conversion: no price
 *     moves the smallest loss heard (`LossBelowFloor(loss, base_orig)`).
 *   - `D_1 = max(ceil(base_orig * refPrice_a), ceil(V / 100), 7 * fee)` in
 *     QRL, refPrice_a the settlement price at the assertion, the carried
 *     price while the series is silent; fixed for the case, every later round
 *     a multiple of it.
 *   - A bond above the deposits is admitted, the excess owed to the payer.
 *
 * Deployed at the reference base, 1e16 (0.01 of the asset); the other court
 * suites run at 1e17, which is the 1,000 QRL they were written against at the
 * fixture's price. Every deposit is checked against the model
 * (`courtFirstDeposit`, `lossHeard`; test/spec-model.js) where it loads.
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { keccak256, toUtf8Bytes } = require('ethers');
const F = require('./stake-fixture');
const { coder } = require('./harness');
const { loadModel } = require('./spec-model');

const { ACCOUNTS, ONE, BPS, TERM, CLASS, JUROR_MIN_STAKE, JUROR_FEE, PRICE_SCALE } = F;
const BASE = F.DEPOSIT_BASE_ORIG_REFERENCE;
const DAY = 24 * 3600;
const HOLDER = ACCOUNTS.alice;
const OTHER = ACCOUNTS.bob;
const OUTSIDER = ACCOUNTS.mallory;
const CHALLENGER = ACCOUNTS.attester;
const KIND = { LOSS: 1, CENSORSHIP: 2 };
const V = { UPHOLD: 1, REJECT: 2 };
const ARK_PRICE = 100n * ONE;
const EVIDENCE = keccak256(toUtf8Bytes('deposit-base'));
const MIN_DEPOSIT = 7n * JUROR_FEE;
/** QRL per unit of the origin asset: tenfold either way of the market rate, the scenario report's and QRL tenfold down. */
const PRICES = [330n, 3_300n, 10_000n, 33_000n].map((p) => p * PRICE_SCALE);

let M;
before(async () => {
  M = await loadModel();
});

const juror = (i) => '0x' + (0x6000 + i).toString(16).padStart(40, '0');
const salt = (a) => keccak256(toUtf8Bytes(`salt:${a.toLowerCase()}`));
const lossPayload = (id, loss) => coder.encode(['bytes32[]', 'uint256[]'], [[id], [loss]]);
const uintPayload = (x) => coder.encode(['uint256'], [x]);
const commitment = (id, round, vote, who) =>
  keccak256(coder.encode(['bytes32', 'uint8', 'uint8', 'bytes32', 'address'], [id, round, vote, salt(who), who]));

/** The base at the price, rounded up. */
const baseQrl = (price, base = BASE) => (base * price + PRICE_SCALE - 1n) / PRICE_SCALE;
/** D_1 as the papers state it, and the model's where it loads (the two must agree). */
function expectedDeposit(value, price, base = BASE) {
  const proportional = (value * 100n + BPS - 1n) / BPS;
  let d = baseQrl(price, base);
  if (MIN_DEPOSIT > d) d = MIN_DEPOSIT;
  if (proportional > d) d = proportional;
  if (M) assert.equal(M.ark.courtFirstDeposit(value, base, price, JUROR_FEE), d, 'the model\'s courtFirstDeposit');
  return d;
}

async function court({ jurors = 30, stakeEach, notional = 100n * ONE, base = BASE } = {}) {
  const ctx = await F.deployBondStack({ court: 'real', courtOpts: { depositBaseOrig: base } });
  if (stakeEach === undefined) stakeEach = BigInt(Math.ceil(7 / jurors)) * JUROR_MIN_STAKE;
  ctx.pos = [{ ...(await F.anchor(ctx, { owner: HOLDER, depositor: HOLDER, nonce: 0n, notional })) }];
  await F.subscribe(ctx, { from: HOLDER, class_: CLASS.JUNIOR, term: TERM.YEAR, value: 70_000n * ONE });
  await F.subscribe(ctx, { from: OTHER, class_: CLASS.SENIOR, term: TERM.YEAR, value: 30_000n * ONE });
  ctx.chain.advanceTime(91 * DAY);
  for (let i = 0; i < jurors; i++) {
    const j = juror(i);
    await ctx.ark.send('transfer', [j, stakeEach], { from: ACCOUNTS.admin });
    await ctx.ark.send('approve', [ctx.jurorPool.address, stakeEach], { from: j });
    await ctx.jurorPool.send('stake', [stakeEach], { from: j });
  }
  F.toNextEpoch(ctx);
  await ctx.oracle.send('setPriceFor', [0n, ctx.ark.address, ARK_PRICE]);
  // p_ARK's reference value, so the seat is priced while the oracle is silent.
  await ctx.oracle.send('setArkReferencePrice', [ARK_PRICE]);
  return ctx;
}

const setPrice = (ctx, p) => ctx.oracle.send('set', [p, p, p]);
const quote = (ctx, kind, payload, from = HOLDER) => ctx.findings.call('quote', [kind, payload], { from });

/** The revert's arguments, decoded as `types` (the harness names the error; the data carries them). */
async function revertArgs(fn, name, types) {
  try {
    await fn();
  } catch (e) {
    assert.match(e.message, new RegExp(name));
    return coder.decode(types, '0x' + e.data.slice(10));
  }
  assert.fail(`expected ${name}`);
}

async function assertFinding(ctx, kind, payload, from = HOLDER, extra = 0n) {
  const q = await quote(ctx, kind, payload, from);
  const res = await ctx.court.send('assertFinding', [kind, payload, EVIDENCE], { from, value: q[3] * q[4] + extra });
  const [ev] = ctx.court.events(res, 'AssertionOpened');
  return { id: ev.args.caseId, value: q[0], deposit: q[3], slices: q[4], res };
}

const caseOf = (ctx, id) => ctx.court.call('caseOf', [id]);
const roundOf = (ctx, id, n) => ctx.court.call('roundOf', [id, n]);
function until(ctx, at) {
  const now = BigInt(ctx.chain.timestamp);
  if (BigInt(at) > now) ctx.chain.advanceTime(Number(BigInt(at) - now));
}
async function drawRound(ctx, id) {
  const c = await caseOf(ctx, id);
  const r = await roundOf(ctx, id, c.round);
  while (BigInt(ctx.chain.blockNumber) <= r.drawBlock) ctx.chain.advanceTime(0);
  await ctx.court.send('drawPanel', [id]);
  return (await ctx.jurorPool.call('panelOf', [id, c.round])).map((a) => a.toLowerCase());
}
async function vote(ctx, id, verdict) {
  const c = await caseOf(ctx, id);
  const n = Number(c.round);
  const panel = (await ctx.jurorPool.call('panelOf', [id, n])).map((a) => a.toLowerCase());
  for (const j of panel) await ctx.court.send('commitVote', [id, commitment(id, n, verdict, j)], { from: j });
  const r = await roundOf(ctx, id, n);
  until(ctx, r.commitEnd);
  for (const j of panel) await ctx.court.send('revealVote', [id, verdict, salt(j)], { from: j });
  until(ctx, r.revealEnd);
  return panel;
}
async function challengeAndDraw(ctx, id, value) {
  await ctx.court.send('challenge', [id], { from: CHALLENGER, value });
  const c = await caseOf(ctx, id);
  until(ctx, c.openedAt + (c.challengeDays + c.evidenceDays) * BigInt(DAY));
  await ctx.court.send('armDraw', [id]);
  return drawRound(ctx, id);
}
async function claim(ctx, who) {
  const before = await ctx.chain.balanceOf(who);
  await ctx.court.send('claim', [], { from: who });
  return (await ctx.chain.balanceOf(who)) - before;
}

describe('the deposit base in units of the origin asset (yellow paper §5.1, 2026-10-06)', () => {
  test('the rate does not move the floor: base_orig - 1 is refused and base_orig heard at every price, and K below the base refuses every loss', async () => {
    const ctx = await court();
    assert.equal(await ctx.findings.call('DEPOSIT_BASE_ORIG'), BASE);
    assert.equal(await ctx.findings.call('MIN_DEPOSIT'), MIN_DEPOSIT, 'seven juror fees');
    const id = ctx.pos[0].id;
    for (const price of PRICES) {
      await setPrice(ctx, price);
      const [loss, floor] = await revertArgs(() => quote(ctx, KIND.LOSS, lossPayload(id, BASE - 1n)), 'LossBelowFloor', ['uint256', 'uint256']);
      assert.equal(loss, BASE - 1n, 'the loss, in origin units');
      assert.equal(floor, BASE, 'the floor, base_orig, in origin units');
      const q = await quote(ctx, KIND.LOSS, lossPayload(id, BASE));
      assert.equal(q[0], baseQrl(price), `heard at the base at ${price / PRICE_SCALE} QRL`);
      if (M) {
        const k = await ctx.registry.call('requiredCapital');
        assert.equal(M.ark.lossHeard(BASE - 1n, k, BASE), false);
        assert.equal(M.ark.lossHeard(BASE, k, BASE), true, 'the model\'s lossHeard');
      }
    }
    // A book whose K is below the base: every loss is capped below it and refused.
    const small = await court({ notional: BASE / 2n });
    const k = await small.registry.call('requiredCapital');
    assert.ok(k > 0n && k < BASE, `K ${k} below the base`);
    const [loss] = await revertArgs(() => quote(small, KIND.LOSS, lossPayload(small.pos[0].id, 10n * ONE)), 'LossBelowFloor', ['uint256', 'uint256']);
    assert.equal(loss, k, 'compared capped at K');
    if (M) assert.equal(M.ark.lossHeard(10n * ONE, k, BASE), false);
    assert.equal((await ctx.bond.call('state')).determinationsOpen, 0n);
  });

  test('the deposit follows the price above seven juror fees, and the proportional term binds from 100 times the base wherever the base at the price is above them', async () => {
    const ctx = await court();
    const id = ctx.pos[0].id;
    for (const price of [...PRICES, 70_000n * PRICE_SCALE, 100_000n * PRICE_SCALE]) {
      await setPrice(ctx, price);
      for (const loss of [BASE, 50n * BASE, 100n * BASE, 101n * BASE, 300n * BASE]) {
        const q = await quote(ctx, KIND.LOSS, lossPayload(id, loss));
        assert.equal(q[3], expectedDeposit(q[0], price), `D_1 at ${price / PRICE_SCALE} QRL, loss ${loss}`);
        assert.ok(q[3] >= baseQrl(price) && q[3] >= MIN_DEPOSIT);
      }
      const small = (await quote(ctx, KIND.LOSS, lossPayload(id, BASE)))[3];
      assert.equal(small, baseQrl(price) > MIN_DEPOSIT ? baseQrl(price) : MIN_DEPOSIT, 'a small claim posts the base at the price, or seven fees');
      if (baseQrl(price) >= MIN_DEPOSIT) {
        assert.equal((await quote(ctx, KIND.LOSS, lossPayload(id, 100n * BASE)))[3], baseQrl(price), 'at 100 times the base the base still binds');
        assert.ok((await quote(ctx, KIND.LOSS, lossPayload(id, 101n * BASE)))[3] > baseQrl(price), 'above it, 1 per cent of V');
      }
    }
  });

  test('fixed for the case: the price moves after the assertion, and the challenge, the appeal and the escalation post D_1, 2 D_1 and 4 D_1 as fixed', async () => {
    const ctx = await court();
    await setPrice(ctx, 100_000n * PRICE_SCALE);
    const payload = lossPayload(ctx.pos[0].id, BASE);
    const a = await assertFinding(ctx, KIND.LOSS, payload);
    assert.equal(a.deposit, 1_000n * ONE, '0.01 of the asset at 100,000 QRL, above seven fees');
    assert.equal((await caseOf(ctx, a.id)).deposit, a.deposit);
    await setPrice(ctx, 200_000n * PRICE_SCALE);
    assert.equal((await quote(ctx, KIND.LOSS, payload))[3], 2_000n * ONE, 'a new assertion would post at the new price');
    await assert.rejects(() => ctx.court.send('challenge', [a.id], { from: CHALLENGER, value: 2_000n * ONE }), /IncorrectBond/, 'the challenge posts the D_1 fixed at the assertion');
    await challengeAndDraw(ctx, a.id, a.deposit);
    await vote(ctx, a.id, V.UPHOLD);
    await ctx.court.send('appeal', [a.id], { from: CHALLENGER, value: 2n * a.deposit });
    await drawRound(ctx, a.id);
    await vote(ctx, a.id, V.REJECT);
    await assert.rejects(() => ctx.court.send('escalateToGovernance', [a.id], { from: HOLDER, value: 8_000n * ONE }), /IncorrectBond/);
    await ctx.court.send('escalateToGovernance', [a.id], { from: HOLDER, value: 4n * a.deposit });
    const c = await caseOf(ctx, a.id);
    assert.deepEqual([c.posted[0], c.posted[1]], [5n * a.deposit, 3n * a.deposit], 'D_1 + 4 D_1 against D_1 + 2 D_1, at the price of the assertion');
  });

  test('silence uses the carried price, the breaker its bounded settlement price, and a price of zero the floor of seven fees', async () => {
    const ctx = await court();
    const payload = lossPayload(ctx.pos[0].id, BASE);
    await setPrice(ctx, 100_000n * PRICE_SCALE);
    await ctx.registry.send('markPremium', []);
    const [carried] = await ctx.registry.call('carriedPrice');
    assert.equal(carried, 100_000n * PRICE_SCALE);
    await setPrice(ctx, 150_000n * PRICE_SCALE);
    assert.equal((await quote(ctx, KIND.LOSS, payload))[3], expectedDeposit(baseQrl(150_000n * PRICE_SCALE), 150_000n * PRICE_SCALE), 'live: the series');
    const atCarried = expectedDeposit(baseQrl(carried), carried);
    await ctx.oracle.send('setSilent', [true]);
    assert.equal((await quote(ctx, KIND.LOSS, payload))[3], atCarried, 'silent: the carried price');
    await ctx.oracle.send('setSilent', [false]);
    await ctx.oracle.send('setReverting', [true]);
    assert.equal((await quote(ctx, KIND.LOSS, payload))[3], atCarried, 'reverting: the carried price');
    await ctx.oracle.send('setReverting', [false]);
    await ctx.oracle.send('setHeartbeat', [3600n]);
    ctx.chain.advanceTime(2 * 3600);
    assert.equal((await quote(ctx, KIND.LOSS, payload))[3], atCarried, 'a lapsed heartbeat: the carried price');
    await ctx.oracle.send('setHeartbeat', [0n]);
    // The breaker: the series halves in a day; the price is min(carried, max(twap_e, floor_k)).
    await ctx.oracle.send('set', [30_000n * PRICE_SCALE, 40_000n * PRICE_SCALE, 100_000n * PRICE_SCALE]);
    assert.equal(await ctx.registry.call('breakerActive'), true);
    F.toNextEpoch(ctx, 2); // floor_k: the carried price compounded down by m_epoch for two epochs
    const sp = await ctx.registry.call('settlementPrice');
    assert.ok(sp < carried, 'the breaker values below the carried price');
    const q = await quote(ctx, KIND.LOSS, payload);
    assert.equal(q[0], baseQrl(sp), 'V at the settlement price');
    assert.equal(q[3], expectedDeposit(q[0], sp), 'D_1 at the same price as V');

    // A registry never marked, its oracle silent from the start: P = 0, the base is
    // nothing in QRL, and the deposit is the floor of seven fees, never zero.
    const fresh = await F.deployBondStack({ court: 'real', courtOpts: { depositBaseOrig: BASE } });
    await fresh.oracle.send('setSilent', [true]);
    await fresh.oracle.send('setArkReferencePrice', [ARK_PRICE]);
    assert.equal(await fresh.registry.call('settlementPrice'), 0n);
    const z = await fresh.findings.call('quote', [KIND.CENSORSHIP, uintPayload(0n)]);
    assert.equal(z[0], 0n, 'V = 0 at a zero price');
    assert.equal(z[3], MIN_DEPOSIT, 'the deposit is seven juror fees');
    if (M) assert.equal(M.ark.courtFirstDeposit(0n, BASE, 0n, JUROR_FEE), MIN_DEPOSIT);
    await assert.rejects(() => fresh.court.send('assertFinding', [KIND.CENSORSHIP, uintPayload(0n), EVIDENCE], { from: HOLDER, value: MIN_DEPOSIT }), /NothingToMove/);
  });

  test('slices and the outsider: each slice posts at least the base at the price; an outsider max(D_1(V), D_1(V_max)) at one price', async () => {
    // At 0.1 of the asset the base at 10,000 QRL is 1,000 QRL, above seven fees, so the base term is seen.
    const base = 10n * BASE;
    const ctx = await court({ jurors: 12, stakeEach: 40n * JUROR_MIN_STAKE, base });
    const price = 10_000n * PRICE_SCALE;
    await setPrice(ctx, price);
    await ctx.oracle.send('setPriceFor', [0n, ctx.ark.address, ONE]); // one QRL an ARK: the censorship ground is sliced
    await ctx.oracle.send('setArkReferencePrice', [0n]);
    const [value, , , deposit, slices] = await quote(ctx, KIND.CENSORSHIP, uintPayload(0n));
    assert.ok(slices > 1n, `sliced (${slices})`);
    assert.equal(deposit, expectedDeposit((value + slices - 1n) / slices, price, base), 'each slice on V / n, at the base and the least deposit');
    assert.equal(deposit, baseQrl(price, base), 'a slice of a small part posts the base at the price');

    await ctx.oracle.send('setPriceFor', [0n, ctx.ark.address, ARK_PRICE]);
    await ctx.oracle.send('setArkReferencePrice', [ARK_PRICE]);
    const payload = lossPayload(ctx.pos[0].id, 2n * base);
    const own = await ctx.findings.call('quoteFor', [KIND.LOSS, payload, HOLDER]);
    const out = await ctx.findings.call('quoteFor', [KIND.LOSS, payload, OUTSIDER]);
    const vMax = await ctx.findings.call('valueMax');
    assert.equal(own[3], expectedDeposit(own[0], price, base));
    const dMax = expectedDeposit(vMax, price, base);
    assert.equal(out[3], dMax > own[3] ? dMax : own[3], 'the outsider: the larger, both at the one price');
  });

  test('seven fees are the least first deposit: at 330 QRL a unit D_1 is 700 QRL, and a first panel is paid from the losing deposit, the fee pool untouched', async () => {
    const ctx = await court();
    await setPrice(ctx, 330n * PRICE_SCALE);
    const payload = lossPayload(ctx.pos[0].id, BASE);
    const a = await assertFinding(ctx, KIND.LOSS, payload);
    assert.equal(a.deposit, MIN_DEPOSIT, 'the base is 3.3 QRL here; seven fees bind');
    await ctx.court.send('fundFeePool', [], { from: OTHER, value: 50n * ONE });
    const panel = await challengeAndDraw(ctx, a.id, a.deposit);
    await vote(ctx, a.id, V.REJECT);
    until(ctx, (await roundOf(ctx, a.id, 1)).appealEnd);
    const res = await ctx.court.send('finalize', [a.id, payload]);
    const [ev] = ctx.court.events(res, 'CaseFinal');
    assert.equal(ev.args.fromFeePool, 0n, 'the losing deposit pays every coherent seat');
    assert.equal(await ctx.court.call('feePool'), 50n * ONE, 'the pool untouched');
    assert.equal(await ctx.court.call('owed', [panel[0]]), JUROR_FEE);
    assert.equal(await claim(ctx, CHALLENGER), a.deposit, 'the winner\'s deposit returns');
  });

  test('a bond above the deposits is admitted and the excess owed to the payer; one below them is refused', async () => {
    const ctx = await court();
    await setPrice(ctx, 100_000n * PRICE_SCALE);
    const payload = lossPayload(ctx.pos[0].id, BASE);
    const d = (await quote(ctx, KIND.LOSS, payload))[3];
    await assert.rejects(() => ctx.court.send('assertFinding', [KIND.LOSS, payload, EVIDENCE], { from: HOLDER, value: d - 1n }), /IncorrectBond/);
    const margin = d / 4n; // the app's margin, one m_epoch step at most
    const a = await assertFinding(ctx, KIND.LOSS, payload, HOLDER, margin);
    assert.equal(a.deposit, d, 'the case posts D_1, not the bond sent');
    assert.equal((await caseOf(ctx, a.id)).posted[0], d);
    assert.equal(await ctx.court.call('owed', [HOLDER]), margin, 'the excess, owed to the payer');
    if (M) assert.equal(M.ark.assertionBondExcess(d + margin, d), margin);
    assert.equal(await claim(ctx, HOLDER), margin, 'and withdrawn by pull');
    assert.equal(await ctx.chain.balanceOf(ctx.court.address), d + (await ctx.court.call('feePool')), 'the court holds the case deposit and its pool');
  });
});
