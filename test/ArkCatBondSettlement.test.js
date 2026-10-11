/**
 * Build 2 of the bond (phase C3): the settlement of both triggers, the
 * settlement entitlement, the subrogation recovery and the objection source,
 * end to end on the harness — the court's findings stated by the stand-in
 * court, everything after them the contracts' own.
 *
 * The one rule this file exists to defend: **bond principal leaves the pool to
 * settle a trigger only in the quantity the waterfall of whitepaper §5.2
 * determines, junior before senior, and the bond recovers afterwards at most
 * what it paid, senior before junior** (I11, I14, I21, I23′, I36, I37). Every
 * quantity the contract fixes is held to the specification's own model
 * (`ark-staking.ts`), called beside it.
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const F = require('./stake-fixture');
const { loadModel, MISSING } = require('./spec-model');
const ids = require('../ecdsa-stakings/relayer/lib/identifiers');

const { ACCOUNTS, ONE, EPOCH, BPS, TERM, CLASS, CHAIN_ID, ESCROW, ASSET_A, REF_PRICE, PRICE_SCALE } = F;
const HOLDER = ACCOUNTS.alice;
const OTHER = ACCOUNTS.bob;
const DEST = '0x' + '33'.repeat(20);
const DAY = 24 * 3600;
const PRICE = PRICE_SCALE;

let M;
before(async () => {
  M = await loadModel();
});

const needModel = (t) => {
  if (!M) {
    t.skip(MISSING);
    return true;
  }
  return false;
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const epochNow = (ctx) => BigInt(ctx.chain.timestamp) / BigInt(EPOCH);
const det = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const T2_FLOOR = require('ethers').keccak256(require('ethers').toUtf8Bytes('ARK_T2_FLOOR'));
const T2_BALANCE = require('ethers').keccak256(require('ethers').toUtf8Bytes('ARK_T2_BALANCE'));
const T2_REMAINDER = require('ethers').keccak256(require('ethers').toUtf8Bytes('ARK_T2_REMAINDER'));

/**
 * The bond's one refusal of a court finding (re-audit 2026-09-30, COURT-02):
 * `FindingRefused(cause)`, `cause` the selector of the named error it stands
 * for, e.g. `refused('DeterminationNotOpen(bytes32)')`.
 */
const refused = (cause) => (e) =>
  /FindingRefused/.test(String(e && e.message)) &&
  String((e && e.data) || '').toLowerCase().includes(require('ethers').id(cause).slice(2, 10));

/** P_rem and the two class residuals of one escrow (whitepaper §5.4, I36). */
async function residual(ctx, escrow = ESCROW) {
  const r = await ctx.r.call('recoveryResidual', [CHAIN_ID, escrow]);
  return [BigInt(r[0]), BigInt(r[1]), BigInt(r[2])];
}

/** An escrow's buffer, reported and proven into the registry (gap item 22's channel). */
async function recordBuffer(ctx, units, asset = ASSET_A) {
  const epoch = epochNow(ctx);
  await ctx.attest.send('seal', [epoch, F.bufferLeaf(CHAIN_ID, asset, epoch, units)]);
  await ctx.registry.send('recordBuffer', [CHAIN_ID, ESCROW, asset, epoch, units, []], { from: ACCOUNTS.mallory });
}

/**
 * A book: positions anchored, a junior and a senior class, and (optionally) a
 * buffer. `vested` moves the clock past the ninety-day vesting window, so a
 * trigger-1 claim is made whole by the vesting factor.
 */
async function book({
  junior = 70_000n * ONE,
  senior = 30_000n * ONE,
  positions = [{ owner: HOLDER, notional: 100n * ONE }],
  buffer = 0n,
  term = TERM.YEAR,
  vested = true,
  vestFirst = false,
  params,
  stage,
} = {}) {
  const ctx = await F.deployBondStack({ params, stage });
  ctx.s = ctx.chain.at('ArkCatBondSettlement', ctx.bond.address);
  // The fourth body (phase C3b): the claimant record and the recovery, at the bond's address.
  ctx.r = ctx.chain.at('ArkCatBondRecovery', ctx.bond.address);
  ctx.pos = [];
  let nonce = 0n;
  for (const p of positions) {
    ctx.pos.push({ ...(await F.anchor(ctx, { owner: p.owner, depositor: p.owner, nonce: nonce++, notional: p.notional })), ...p });
  }
  // Positions vested before the bond is subscribed: a vested book behind young holdings.
  if (vestFirst) ctx.chain.advanceTime(91 * DAY);
  ctx.junior = junior === 0n ? null : await F.subscribe(ctx, { from: HOLDER, class_: CLASS.JUNIOR, term, value: junior });
  ctx.senior = senior === 0n ? null : await F.subscribe(ctx, { from: OTHER, class_: CLASS.SENIOR, term, value: senior });
  if (vested) ctx.chain.advanceTime(91 * DAY);
  if (buffer !== 0n) await recordBuffer(ctx, buffer);
  return ctx;
}

async function classes(ctx) {
  const s = await ctx.bond.call('state');
  return { j: s.juniorPrincipal, s: s.seniorPrincipal };
}

/** Open a determination in the court and state its finding. */
async function determine(ctx, id, list) {
  await ctx.court.send('open', [id]);
  return ctx.court.send('determineLoss', [id, list.map((x) => x.id), list.map((x) => x.loss)]);
}

/** The model's trigger-1 window, position by position, as §5.2 states it. */
function modelWindow(t, { losses, indemnity, vesting, buffer, bondUnits, required }) {
  const { ark } = M;
  const claims = losses.map((l, i) => ark.settlementFor({ realisedLoss: l, indemnityBps: Number(indemnity), vestingBps: Number(vesting[i]), haircutBps: 10000 }));
  const obligation = claims.reduce((a, b) => a + b, 0n);
  const available = buffer + (bondUnits < required ? bondUnits : required);
  const haircut = BigInt(ark.settlementHaircutBps(available, obligation));
  const paid = claims.map((c) => (c * haircut) / BPS);
  return { claims, obligation, available, haircut, paid };
}

/* ------------------------------------------------------------------ */
/* Trigger 1                                                           */
/* ------------------------------------------------------------------ */

describe('trigger 1: the buffer pays first, then junior, then senior, at one haircut (whitepaper §5.2)', () => {
  test('a determination inside the buffer and the bond: buffer, then junior only, entitlement paid in QRL', async (t) => {
    if (needModel(t)) return;
    const ctx = await book({ buffer: 2n * ONE });
    const pos = ctx.pos[0];
    const before = await classes(ctx);
    const indemnity = await ctx.registry.call('effectiveIndemnityBps');
    const vesting = await ctx.registry.call('vestingBpsOf', [pos.id]);
    assert.equal(vesting, BPS, 'past the vesting window the factor is whole');
    const required = await ctx.registry.call('requiredCapital');
    const out = await ctx.bond.call('outstandingPrincipal');

    const res = await determine(ctx, det(1), [{ id: pos.id, loss: 50n * ONE }]);
    const [ev] = ctx.s.events(res, 'LossDetermined');
    const w = modelWindow(t, {
      losses: [50n * ONE], indemnity, vesting: [vesting], buffer: 2n * ONE,
      bondUnits: (out * PRICE) / REF_PRICE, required,
    });
    assert.equal(ev.args.obligation, w.obligation, 'the obligation is the model\'s, summed after vesting');
    assert.equal(ev.args.available, w.available, 'buffer + min(N_B,orig, K) (I11)');
    assert.equal(ev.args.haircutBps, w.haircut);
    assert.equal(w.haircut, BPS, 'inside the capital, no haircut');
    const bufferPart = w.paid[0] < 2n * ONE ? w.paid[0] : 2n * ONE;
    assert.equal(ev.args.bufferUnits, bufferPart, 'the buffer pays first');
    const qrl = ((w.paid[0] - bufferPart) * REF_PRICE) / PRICE;
    assert.equal(ev.args.drawQrl, qrl, 'the rest from bond principal, at the price fixed at the determination');

    const after = await classes(ctx);
    const draws = M.ark.classDrawsOnPrincipal(qrl, before.j, before.s);
    assert.equal(before.j - after.j, draws.junior, 'junior first (classDrawsOnPrincipal)');
    assert.equal(before.s - after.s, draws.senior);
    assert.equal(after.s, before.s, 'senior untouched while junior holds the draw');

    const part = await ctx.s.call('lossPartOf', [det(1), pos.id]);
    assert.equal(part.bufferUnits, bufferPart);
    assert.equal(part.qrl, qrl);

    // Recorded in the following epoch (yellow paper §1.4), and paid to the bound beneficiary alone.
    await assert.rejects(() => ctx.s.send('claimSettlement', [det(1), pos.id], { from: HOLDER }), /NotClaimant/);
    F.toNextEpoch(ctx);
    await assert.rejects(() => ctx.s.send('claimSettlement', [det(1), pos.id], { from: OTHER }), /NotBeneficiary/);
    const bal0 = await ctx.chain.balanceOf(HOLDER);
    const paid = await ctx.s.send('claimSettlement', [det(1), pos.id], { from: HOLDER });
    const [c] = ctx.s.events(paid, 'SettlementClaimed');
    assert.equal(c.args.amount, qrl);
    assert.ok((await ctx.chain.balanceOf(HOLDER)) > bal0);
    await assert.rejects(() => ctx.s.send('claimSettlement', [det(1), pos.id], { from: HOLDER }), /NothingDue/);
  });

  test('the loss leaf the beneficiary names is the one the escrow pays: the buffer part, fixed in units (D13)', async () => {
    const ctx = await book({ buffer: 2n * ONE });
    const pos = ctx.pos[0];
    await determine(ctx, det(2), [{ id: pos.id, loss: 50n * ONE }]);
    const part = await ctx.s.call('lossPartOf', [det(2), pos.id]);
    await assert.rejects(() => ctx.s.send('nameLossDestination', [det(2), pos.id, DEST], { from: OTHER }), /NotBeneficiary/);
    const res = await ctx.s.send('nameLossDestination', [det(2), pos.id, DEST], { from: HOLDER });
    const [ev] = ctx.s.events(res, 'LossLeafSealed');
    const leaf = ids.lossLeaf({ chainId: CHAIN_ID, escrow: ESCROW, determinationId: det(2), stakeAssetId: pos.id, destination: DEST, quantity: part.bufferUnits });
    assert.equal(ev.args.leaf, leaf, 'the leaf agrees with the relayer and the escrow (yellow paper §2.2 lossLeafKey)');
    assert.equal(ev.args.quantity, part.bufferUnits);
    assert.equal(ev.args.escrow.toLowerCase(), ESCROW.toLowerCase());
    await assert.rejects(() => ctx.s.send('nameLossDestination', [det(2), pos.id, DEST], { from: HOLDER }), /AlreadyClaimed/);
  });

  test('above the capital one haircut applies to every position of the window, and the draw reaches senior', async (t) => {
    if (needModel(t)) return;
    const ctx = await book({
      buffer: 2n * ONE,
      positions: [{ owner: HOLDER, notional: 100n * ONE }, { owner: OTHER, notional: 300n * ONE }],
    });
    const [a, b] = ctx.pos;
    const indemnity = await ctx.registry.call('effectiveIndemnityBps');
    const required = await ctx.registry.call('requiredCapital');
    const out = await ctx.bond.call('outstandingPrincipal');
    const res = await determine(ctx, det(3), [{ id: a.id, loss: 40n * ONE }, { id: b.id, loss: 120n * ONE }]);
    const [ev] = ctx.s.events(res, 'LossDetermined');
    const w = modelWindow(t, {
      losses: [40n * ONE, 120n * ONE], indemnity, vesting: [BPS, BPS], buffer: 2n * ONE,
      bondUnits: (out * PRICE) / REF_PRICE, required,
    });
    assert.ok(w.haircut < BPS, 'the obligation exceeds the capital available');
    assert.equal(ev.args.haircutBps, w.haircut, 'one factor for the window (I14)');
    const pa = await ctx.s.call('lossPartOf', [det(3), a.id]);
    const pb = await ctx.s.call('lossPartOf', [det(3), b.id]);
    // Each position's two parts sum to its haircut claim, give or take the
    // truncation of the conversion; the ratio is the same for both.
    for (const [p, paid] of [[pa, w.paid[0]], [pb, w.paid[1]]]) {
      const back = (BigInt(p.qrl) * PRICE) / REF_PRICE;
      assert.ok(paid - (BigInt(p.bufferUnits) + back) <= 1n, 'buffer part + bond part = the haircut claim');
    }
    assert.equal(BigInt(pa.bufferUnits) + BigInt(pb.bufferUnits) <= 2n * ONE, true, 'the buffer pays no more than it holds');
    const after = await classes(ctx);
    assert.ok(after.j === 0n, 'junior exhausted before senior is reached');
    assert.ok(after.s < 30_000n * ONE, 'senior bears the remainder');
  });

  test('a young position is paid at its vesting factor: the barrier against anchoring into a known loss', async (t) => {
    if (needModel(t)) return;
    const ctx = await book({ buffer: 0n, vested: false });
    ctx.chain.advanceTime(30 * DAY);
    const pos = ctx.pos[0];
    const vesting = await ctx.registry.call('vestingBpsOf', [pos.id]);
    assert.ok(vesting > 0n && vesting < BPS);
    const indemnity = await ctx.registry.call('effectiveIndemnityBps');
    const res = await determine(ctx, det(4), [{ id: pos.id, loss: 2n * ONE }]);
    const [ev] = ctx.s.events(res, 'LossDetermined');
    const claim = M.ark.settlementFor({ realisedLoss: 2n * ONE, indemnityBps: Number(indemnity), vestingBps: Number(vesting), haircutBps: 10000 });
    assert.equal(ev.args.obligation, claim);
  });

  test('a determination is the court\'s, on one it opened, once, and never beside trigger 2', async () => {
    const ctx = await book({ buffer: 2n * ONE, positions: [{ owner: HOLDER, notional: 100n * ONE }, { owner: OTHER, notional: 50n * ONE }] });
    const [a] = ctx.pos;
    await assert.rejects(() => ctx.s.send('determineLoss', [det(5), [a.id], [ONE], ONE], { from: HOLDER }), /OnlyCourt/);
    // Every refusal is the one refusal error, naming its cause (COURT-02).
    await assert.rejects(() => ctx.court.send('determineLoss', [det(5), [a.id], [ONE]]), refused('DeterminationNotOpen(bytes32)'));
    await ctx.court.send('open', [det(5)]);
    await assert.rejects(() => ctx.court.send('determineLoss', [det(5), [a.id, a.id], [ONE, ONE]]), refused('BadDetermination()'));
    await assert.rejects(() => ctx.court.send('determineLoss', [det(5), [a.id], []]), refused('BadDetermination()'));
    await assert.rejects(() => ctx.court.send('determineLoss', [det(5), ['0x' + '99'.repeat(32)], [ONE]]), refused('BadDetermination()'));
    // A loss no position can have, which would overflow the waterfall on every retry, is refused, not reverted.
    await assert.rejects(() => ctx.court.send('determineLoss', [det(5), [a.id], [1n << 128n]]), refused('BadDetermination()'));
    await ctx.court.send('determineLoss', [det(5), [a.id], [ONE]]);
    await assert.rejects(() => ctx.court.send('determineLoss', [det(5), [a.id], [ONE]]), refused('AlreadyDetermined(bytes32)'));
    // After a declaration's draw the pool stands behind that settlement alone.
    await ctx.court.send('close', [det(5)]);
    await F.declare(ctx, BigInt(ctx.chain.timestamp));
    await ctx.court.send('open', [det(6)]);
    await ctx.r.send('recordClaimants', [ctx.pos.map((p) => p.id)]);
    // From the first claimant record the pool stands behind the declaration.
    await assert.rejects(() => ctx.court.send('determineLoss', [det(6), [a.id], [ONE]]), refused('TriggersExclusive()'));
    await ctx.s.send('settleDeclaration');
    await assert.rejects(() => ctx.court.send('determineLoss', [det(6), [a.id], [ONE]]), refused('TriggersExclusive()'));
  });

  test('a module called directly, outside the bond, refuses to act on its own empty storage', async () => {
    const ctx = await book();
    const module = await ctx.bond.call('SETTLEMENT_MODULE');
    const direct = ctx.chain.at('ArkCatBondSettlement', module);
    await F.declare(ctx, BigInt(ctx.chain.timestamp));
    await assert.rejects(() => direct.send('settleDeclaration'), /ZeroAddress/);
    // Nor through it into the recovery module, nor the recovery module itself.
    await assert.rejects(() => ctx.chain.at('ArkCatBondRecovery', module).send('recordClaimants', [[ctx.pos[0].id]]), /ZeroAddress/);
    const recovery = ctx.chain.at('ArkCatBondRecovery', await direct.call('RECOVERY_MODULE'));
    await assert.rejects(() => recovery.send('recordClaimants', [[ctx.pos[0].id]]), /ZeroAddress/);
  });
});

/* ------------------------------------------------------------------ */
/* Trigger 2                                                           */
/* ------------------------------------------------------------------ */

/** Record every position of the book as a claimant, then open the trigger-2 settlement. */
async function open2(ctx, ids = ctx.pos.map((p) => p.id)) {
  if (ids.length) await ctx.r.send('recordClaimants', [ids], { from: ACCOUNTS.mallory });
  return ctx.s.send('settleDeclaration', [], { from: ACCOUNTS.mallory });
}

/**
 * A declared book: quarter terms, so maturities fall after the window, and the
 * positions fully vested at the ratification (they vest before the bond is
 * subscribed, so the holdings stay young) — the full settlement of §5.2 is then
 * the whole pool: 100 units at 10,000 QRL against 100,000 QRL of principal.
 */
async function declared(opts = {}) {
  const ctx = await book({ term: TERM.QUARTER, vested: false, vestFirst: true, ...opts });
  await F.declare(ctx, BigInt(ctx.chain.timestamp));
  return ctx;
}

/** The vesting factor of whitepaper §5.3 at T: linear over ninety days, truncated (ArkStakeMath.vestingBps). */
const VEST = 90n * 24n * 3600n;
const vestingAt = (anchoredAt, at) => {
  const e = BigInt(at) - BigInt(anchoredAt);
  return Number(e <= 0n ? 0n : e >= VEST ? BPS : (e * BPS) / VEST);
};

/** A position as the model's claimant at T, and its vested weight. */
async function claimantAt(ctx, id, at) {
  const a = await ctx.registry.call('anchorOf', [id]);
  return { notional: a.anchoredNotional, vestingBps: vestingAt(a.anchoredAt, at) };
}
const weightAt = async (ctx, id, at) => M.ark.trigger2VestedWeight(await claimantAt(ctx, id, at));

/** att_eff as the claimant record fixed it at the grounding: K_T's attachment (EC-02, PV-11). */
const attAtT = async (ctx) => Number((await ctx.r.call('claimants')).att);

describe('trigger 2 on the vested obligation, D after the one haircut (whitepaper §5.2, yellow paper §3.4, papers sync 5)', () => {
  test('the floor draw is D_0 of the full settlement, junior first, and each claimant its entitlement on W', async (t) => {
    if (needModel(t)) return;
    const ctx = await declared({ positions: [{ owner: HOLDER, notional: 100n * ONE }, { owner: OTHER, notional: 300n * ONE }] });
    await assert.rejects(() => ctx.s.send('settleSeverity'), /NothingHeld/);
    const before = await classes(ctx);
    const pool = before.j + before.s;
    const res = await open2(ctx);
    const [ev] = ctx.s.events(res, 'Trigger2Drawn');
    const t2 = await ctx.s.call('declaration');
    const claimants = ctx.pos.map((p) => ({ notional: p.notional, vestingBps: 10000 }));
    const att = await attAtT(ctx);
    assert.equal(att, Number(await ctx.registry.call('effectiveAttachmentBps')), 'att_eff read at the grounding');
    const m = M.ark.trigger2Settlement(claimants, 6000, pool, t2.price, att);
    assert.equal(t2.weight, m.vestedWeight, 'W, fixed at the opening');
    assert.equal(t2.capUnits, m.capUnits, 'K_T = floor(N_T * att_eff / BPS) (EC-02)');
    assert.equal(t2.fullSettlement, m.fullSettlement, 'S_full = min(pool, value of W, value of K_T)');
    assert.equal(ev.args.drawQrl, m.poolDraw, 'D_0 of the full settlement (trigger2PoolDraw)');
    const d = M.ark.classDrawsOnPrincipal(m.poolDraw, before.j, before.s);
    assert.equal(ev.args.drawJunior, d.junior);
    assert.equal(ev.args.drawSenior, d.senior);
    await assert.rejects(() => ctx.s.send('settleDeclaration'), /DeclarationAlreadySettled/);

    F.toNextEpoch(ctx);
    for (const [i, p] of ctx.pos.entries()) {
      const r = await ctx.s.send('claimSettlement', [T2_FLOOR, p.id], { from: p.owner });
      const [c] = ctx.s.events(r, 'SettlementClaimed');
      assert.equal(c.args.amount, m.entitlements[i], 'trigger2Entitlement on the vested weight');
    }
  });

  test('an over-covered, part-vested book: S_full is the vested notional at the price, and the pool it does not reach is never drawn', async (t) => {
    if (needModel(t)) return;
    // 20 units at 10,000 QRL against 100,000 of principal: over-covered twice.
    const ctx = await book({
      term: TERM.QUARTER,
      vested: false,
      positions: [{ owner: HOLDER, notional: 6n * ONE }, { owner: OTHER, notional: 14n * ONE }],
    });
    // Thirty days of vesting for the first; the second anchors later and vests less.
    ctx.chain.advanceTime(20 * DAY);
    const late = await F.anchor(ctx, { owner: OTHER, depositor: OTHER, nonce: 7n, notional: 10n * ONE });
    ctx.chain.advanceTime(10 * DAY);
    const at = BigInt(ctx.chain.timestamp);
    await F.declare(ctx, at);
    const ids = [...ctx.pos.map((p) => p.id), late.id];
    const before = await classes(ctx);
    const pool = before.j + before.s;
    await ctx.r.send('recordClaimants', [ids]);
    const weights = [];
    for (const id of ids) weights.push(await weightAt(ctx, id, at));
    const claimants = [];
    for (const id of ids) claimants.push(await claimantAt(ctx, id, at));
    assert.ok(claimants[0].vestingBps > claimants[2].vestingBps && claimants[2].vestingBps > 0, 'vested at T, each to its own age');
    const res = await ctx.s.send('settleDeclaration');
    const t2 = await ctx.s.call('declaration');
    const m = M.ark.trigger2Settlement(claimants, 6000, pool, t2.price, await attAtT(ctx));
    assert.equal(t2.weight, m.vestedWeight);
    assert.ok(m.fullSettlement < pool, 'the vested notional is below the pool');
    assert.equal(t2.capUnits, m.capUnits);
    assert.equal(t2.fullSettlement, m.fullSettlement);
    assert.equal(ctx.s.events(res, 'Trigger2Drawn')[0].args.drawQrl, m.poolDraw);
    // A series that fell to nearly nothing: the measured severity is clamped
    // at 1 - (1 - m_epoch)^W_a (PV-03), and the draw is D_total of S_full,
    // never of the pool.
    F.toEpoch(ctx, t2.epoch + 4n);
    await ctx.oracle.send('set', [1n * PRICE, 1n * PRICE, 1n * PRICE]);
    const r2 = await ctx.s.send('settleSeverity');
    const [sev] = ctx.s.events(r2, 'SeveritySettled');
    const total = Number(sev.args.drawTotalBps);
    assert.ok(Number(sev.args.measuredLossBps) > 9900, 'the reading fell by nearly the whole');
    assert.equal(total, M.ark.trigger2DrawTotalBps(M.params, M.ark.trigger2SeverityBps(M.params, Number(sev.args.measuredLossBps))));
    assert.equal(total, M.ark.measuredSeverityCeilingBps(M.params), 'clamped at the ceiling of W_a epochs');
    const whole = M.ark.trigger2PoolDraw(m.vestedWeight, total, pool, t2.price, m.capUnits);
    assert.equal(ctx.s.events(r2, 'Trigger2Drawn')[0].args.drawQrl, whole - m.poolDraw);
    const after = await classes(ctx);
    assert.equal(after.j + after.s, pool - whole, 'the pool above the vested notional stays with the classes');
    F.toNextEpoch(ctx);
    let paid = 0n;
    for (const [i, id] of ids.entries()) {
      const owner = i === 0 ? HOLDER : OTHER;
      const a = (await ctx.s.send('claimSettlement', [T2_FLOOR, id], { from: owner }));
      const b = (await ctx.s.send('claimSettlement', [T2_BALANCE, id], { from: owner }));
      const fa = ctx.s.events(a, 'SettlementClaimed')[0].args.amount;
      const fb = ctx.s.events(b, 'SettlementClaimed')[0].args.amount;
      assert.equal(fa, M.ark.trigger2Entitlement(m.poolDraw, m.vestedWeight, claimants[i]));
      assert.equal(fb, M.ark.trigger2BalanceEntitlement(m.poolDraw, whole, m.vestedWeight, claimants[i]));
      assert.equal(fa + fb, M.ark.trigger2Entitlement(whole, m.vestedWeight, claimants[i]), 'the two parts are the entitlement at D_total');
      paid += fa + fb;
    }
    assert.ok(paid <= whole, 'the entitlements never sum above the draw');
    assert.deepEqual(weights.map(String), claimants.map((c) => String(M.ark.trigger2VestedWeight(c))));
  });

  test('the scenario report floor-draw table: 200 / 120 / 120 / 0 / 80 at 200 units of principal; above K_T the full settlement is K_T (units; EC-02)', async (t) => {
    if (needModel(t)) return;
    // One thousand units anchored, fully vested, at 10,000 QRL, at the fourth
    // stage the report is evaluated at; bond principal of 200 units (the
    // report's complete cover) and of 300. This fixture's book is one
    // correlation group, so its att_eff is above the report's 2,000 and K_T
    // above 200 units: the first row is the report's, and the second shows
    // the cap binding, the full settlement K_T and never the pool (EC-02).
    const unit = REF_PRICE / PRICE_SCALE * ONE;
    for (const [cover, rows] of [[200n, [200n, 120n, 120n, 0n, 80n]], [300n, null]]) {
      const ctx = await book({
        term: TERM.QUARTER,
        vested: false,
        vestFirst: true,
        stage: 4,
        junior: (cover * unit * 7000n) / BPS,
        senior: (cover * unit * 3000n) / BPS,
        positions: [{ owner: HOLDER, notional: 1000n * ONE }],
      });
      await F.declare(ctx, BigInt(ctx.chain.timestamp));
      const res = await open2(ctx);
      const t2 = await ctx.s.call('declaration');
      const [ev] = ctx.s.events(res, 'Trigger2Drawn');
      const att = await attAtT(ctx);
      assert.equal(att, Number(await ctx.registry.call('effectiveAttachmentBps')));
      const m = M.ark.trigger2Settlement([{ notional: 1000n * ONE, vestingBps: 10000 }], 6000, cover * unit, t2.price, att);
      assert.equal(t2.capUnits, m.capUnits, 'K_T: the requirement on the claimants');
      assert.ok(m.capUnits >= 200n * ONE && m.capUnits < 300n * ONE, 'K_T between the two pools');
      if (rows === null) {
        // Over-covered: S_full is K_T valued at the price, the floor draw D_0 of it,
        // and the pool above K_T is never reached.
        assert.equal(t2.fullSettlement, (m.capUnits * t2.price) / PRICE_SCALE);
        assert.ok(t2.fullSettlement < cover * unit);
        assert.equal(ev.args.drawQrl, (t2.fullSettlement * 6000n) / BPS);
        assert.equal(t2.fullSettlement, m.fullSettlement);
        assert.equal(ev.args.drawQrl, m.poolDraw);
        continue;
      }
      const got = [t2.fullSettlement, ev.args.drawQrl, ev.args.drawJunior, ev.args.drawSenior, t2.fullSettlement - ev.args.drawQrl].map((q) => q / unit);
      assert.deepEqual(got, rows, `cover ${cover} units`);
      assert.equal(t2.fullSettlement, m.fullSettlement);
      assert.equal(ev.args.drawQrl, m.poolDraw);
      assert.equal(ev.args.drawSenior, 0n, 'senior untouched: floor(D_0 * S_full / BPS) <= junior principal');
    }
  });

  test('nothing leaves ahead of the draw or during the window; principal the severity did not reach leaves after it', async (t) => {
    if (needModel(t)) return;
    const ctx = await declared();
    const holding = ctx.junior;
    const m = (await ctx.bond.call('holdingOf', [holding])).maturityEpoch;
    await open2(ctx);
    const t2 = await ctx.s.call('declaration');
    // The window: W_a = 4 epochs from the opening.
    F.toEpoch(ctx, t2.epoch + 3n);
    await assert.rejects(() => ctx.s.send('settleSeverity'), /AssessmentWindowOpen/);
    F.toEpoch(ctx, t2.epoch + 4n);
    // The thirty-day series fell 3,000 bps: below the severity floor, so D_total = D_0.
    await ctx.oracle.send('set', [7000n * PRICE, 7000n * PRICE, 7000n * PRICE]);
    const pre = await classes(ctx);
    const res = await ctx.s.send('settleSeverity');
    const [ev] = ctx.s.events(res, 'SeveritySettled');
    assert.equal(ev.args.measuredLossBps, 3000n);
    assert.equal(ev.args.severityBps, BigInt(M.ark.trigger2SeverityBps(M.params, 3000)));
    assert.equal(ev.args.drawTotalBps, BigInt(M.ark.trigger2DrawTotalBps(M.params, 6000)));
    assert.deepEqual(await classes(ctx), pre, 'max(D_0, S) = D_0: the balance is released, not drawn');
    // Maturity after the settlement: the undrawn principal leaves on its class's terms.
    F.toEpoch(ctx, m + 1n);
    await F.distributeDue(ctx);
    const worth = await ctx.bond.call('principalOf', [holding]);
    assert.ok(worth > 0n);
    const r = await ctx.bond.send('redeem', [holding], { from: HOLDER });
    const [red] = ctx.bond.events(r, 'Redeemed');
    assert.equal(red.args.amount, worth);
  });

  test('a measured severity above the floor draws the balance to D_total of S_full, and the rest is released', async (t) => {
    if (needModel(t)) return;
    const ctx = await declared();
    const pool = 100_000n * ONE;
    await open2(ctx);
    const t2 = await ctx.s.call('declaration');
    F.toEpoch(ctx, t2.epoch + 4n);
    await ctx.oracle.send('set', [2000n * PRICE, 2000n * PRICE, 2000n * PRICE]); // m_loss 8,000
    const res = await ctx.s.send('settleSeverity');
    const [ev] = ctx.s.events(res, 'Trigger2Drawn');
    const total = M.ark.trigger2DrawTotalBps(M.params, M.ark.trigger2SeverityBps(M.params, 8000));
    assert.equal(total, M.ark.measuredSeverityCeilingBps(M.params), 'an m_loss of 8,000 is clamped at 6,835 (PV-03)');
    const whole = M.ark.trigger2PoolDraw(t2.weight, total, pool, t2.price, t2.capUnits);
    assert.equal(ev.args.drawQrl, whole - M.ark.trigger2PoolDraw(t2.weight, 6000, pool, t2.price, t2.capUnits), 'the balance to D_total');
    const s = await classes(ctx);
    assert.equal(s.j + s.s, pool - whole, 'BPS - D_total of the full settlement stays with the classes');
  });
});

describe('R-4: a settlement strikes at the registry\'s settlement price under the circuit breaker (whitepaper §5.5, yellow paper §4.2)', () => {
  /** The breaker fired two epochs ago on a series that fell to a quarter; the emergency valuation at 0.7 of the carried price. */
  async function fired(ctx) {
    await ctx.registry.send('markPremium', [], { from: ACCOUNTS.mallory });
    await ctx.oracle.send('set', [REF_PRICE / 4n, REF_PRICE / 4n, REF_PRICE]);
    await ctx.oracle.send('setEmergency', [(REF_PRICE * 7n) / 10n]);
    await ctx.registry.send('markPremium', [], { from: ACCOUNTS.mallory });
    ctx.chain.advanceTime(2 * EPOCH);
    assert.equal(await ctx.registry.call('breakerActive'), true);
  }

  test('trigger 1 converts at the settlement price, not the fallen series', async (t) => {
    if (needModel(t)) return;
    const ctx = await book({ buffer: 0n });
    const pos = ctx.pos[0];
    await fired(ctx);
    const price = await ctx.registry.call('settlementPrice');
    const floor = M.ark.emergencyPriceFloor(REF_PRICE, M.params.maxEpochMoveBps, 2);
    assert.equal(price, M.ark.settlementPrice({ breakerCleared: false, carried: REF_PRICE, twap30d: REF_PRICE / 4n, emergency: (REF_PRICE * 7n) / 10n, floor }));
    assert.equal(price, (REF_PRICE * 7n) / 10n);
    const res = await determine(ctx, det(41), [{ id: pos.id, loss: 10n * ONE }]);
    const [ev] = ctx.s.events(res, 'LossDetermined');
    const part = await ctx.s.call('lossPartOf', [det(41), pos.id]);
    const claim = M.ark.settlementFor({ realisedLoss: 10n * ONE, indemnityBps: Number(await ctx.registry.call('effectiveIndemnityBps')), vestingBps: 10000, haircutBps: Number(ev.args.haircutBps) });
    assert.equal(part.qrl, (claim * price) / PRICE, 'the QRL drawn follows the price struck, not the print');
    assert.ok(part.qrl > (claim * (REF_PRICE / 4n)) / PRICE);
  });

  test('the floor draw of a declaration fixes the settlement price; the severity balance is held while the breaker holds', async (t) => {
    if (needModel(t)) return;
    const ctx = await declared({ positions: [{ owner: HOLDER, notional: 3n * ONE }] });
    await fired(ctx);
    const res = await open2(ctx);
    const t2 = await ctx.s.call('declaration');
    const price = await ctx.registry.call('settlementPrice');
    assert.equal(t2.price, price, 'the floor draw converts at the settlement price');
    assert.equal(t2.refOpen, REF_PRICE / 4n, 'm_loss is measured from the bounded series, not from the settlement price');
    const pool = 100_000n * ONE;
    // 3 vested units at 7,000 QRL: the full settlement is below the pool.
    const m = M.ark.trigger2Settlement([{ notional: 3n * ONE, vestingBps: 10000 }], 6000, pool, price, await attAtT(ctx));
    assert.equal(t2.fullSettlement, m.fullSettlement);
    assert.equal(ctx.s.events(res, 'Trigger2Drawn')[0].args.drawQrl, m.poolDraw);
    F.toEpoch(ctx, t2.epoch + 4n);
    // Still under the breaker at the close of the window: held, not measured on the settlement price.
    const r = await ctx.s.send('settleSeverity');
    assert.equal(ctx.s.events(r, 'SeverityHeld')[0].args.heldQrl, M.ark.trigger2HeldPrincipal(t2.weight, 6000, pool, price, m.capUnits));
  });
});

describe('the claimants are the positions recorded as of the ratification, each at its vesting then (whitepaper §5.2; R-5)', () => {
  test('the record is taken as of QDAY.declaredAt(): a later opening moves no weight, and a position recorded after T is owed nothing', async (t) => {
    if (needModel(t)) return;
    const ctx = await book({ term: TERM.QUARTER, vested: false, positions: [{ owner: HOLDER, notional: 100n * ONE }] });
    ctx.chain.advanceTime(30 * DAY);
    const at = BigInt(ctx.chain.timestamp);
    await F.declare(ctx, at);
    // A record reaching QRL after the ratification: counted, owed nothing.
    ctx.chain.advanceTime(3 * DAY);
    const late = await F.anchor(ctx, { owner: OTHER, depositor: OTHER, nonce: 9n, notional: 50n * ONE });
    await assert.rejects(() => ctx.s.send('settleDeclaration'), /ClaimantsIncomplete/);
    await ctx.r.send('recordClaimants', [[ctx.pos[0].id]]);
    await assert.rejects(() => ctx.r.send('recordClaimants', [[ctx.pos[0].id]]), /AlreadyRecorded/);
    await assert.rejects(() => ctx.s.send('settleDeclaration'), /ClaimantsIncomplete/, 'the record has not passed the late position');
    await ctx.r.send('recordClaimants', [[late.id]]);
    const [lateKind] = await ctx.s.call('claimantOf', [late.id]);
    assert.equal(lateKind, 2n, 'recorded after T');
    // The opening a week later reads the vesting at T, not at the opening.
    ctx.chain.advanceTime(7 * DAY);
    const res = await ctx.s.send('settleDeclaration');
    const t2 = await ctx.s.call('declaration');
    assert.equal(t2.declaredAt, at, 'T is the ratification');
    const w = await weightAt(ctx, ctx.pos[0].id, at);
    assert.equal(t2.weight, w, 'W is the vested weight at T');
    const [, mine] = await ctx.s.call('claimantOf', [ctx.pos[0].id]);
    assert.equal(mine, w);
    const c = await ctx.r.call('claimants');
    assert.equal(c.live, 150n * ONE);
    assert.equal(c.anchored, 100n * ONE);
    F.toNextEpoch(ctx);
    const r = await ctx.s.send('claimSettlement', [T2_FLOOR, ctx.pos[0].id], { from: HOLDER });
    assert.equal(ctx.s.events(r, 'SettlementClaimed')[0].args.amount, ctx.s.events(res, 'Trigger2Drawn')[0].args.drawQrl, 'the one claimant is owed the whole draw');
    await assert.rejects(() => ctx.s.send('claimSettlement', [T2_FLOOR, late.id], { from: OTHER }), /NotClaimant/);
    await assert.rejects(() => ctx.r.send('recordClaimants', [[late.id]]), /DeclarationAlreadySettled/);
  });

  /**
   * Audit 2026-09-22, G6. A deposit the escrow took in the epoch before the
   * ratification reaches QRL only with that epoch's forward root, which may
   * be sealed after T. Read by the record's QRL time it was "recorded after
   * T" and owed nothing, and a settlement opened before its proof arrived
   * left it out of the record altogether.
   */
  test('a deposit of the epoch before the ratification is a claimant however late its proof, and the settlement waits for every anchor of that root (audit 2026-09-22 G6; audit 2026-09-29 QL-06)', async () => {
    const { buildTree, proofFor } = require('../ecdsa-stakings/relayer/lib/merkle');
    const ctx = await book({ term: TERM.QUARTER, vested: false, positions: [{ owner: HOLDER, notional: 100n * ONE }] });
    ctx.chain.advanceTime(30 * DAY);
    F.toNextEpoch(ctx);
    const depositEpoch = epochNow(ctx);
    F.toNextEpoch(ctx);
    ctx.chain.advanceTime(DAY);
    const at = BigInt(ctx.chain.timestamp);
    // Declared directly: no root of the preceding epoch is sealed yet.
    await ctx.qday.send('declare', [at]);
    await ctx.r.send('recordClaimants', [[ctx.pos[0].id]]);
    await assert.rejects(() => ctx.s.send('settleDeclaration'), /RootUnadmitted/, 'the record matches the book, but that epoch has not been heard from');
    await assert.rejects(() => ctx.r.send('provePriorAnchors', [0n, []]), /RootUnadmitted/);

    // The relayer seals the root of the deposit's epoch with its count: CUMULATIVE
    // since the re-audit of 2026-09-30 (BOND-02), the book's first anchor and this one.
    ctx.chain.advanceTime(DAY);
    const id = F.stakeAssetId(CHAIN_ID, ASSET_A, OTHER, OTHER, 9n);
    const leaf = F.stakeLeafKey(id, 50n * ONE);
    const count = F.anchorCountLeaf(depositEpoch, 2n);
    const tree = buildTree([leaf, count]);
    await ctx.attest.send('seal', [depositEpoch, tree.root]);
    await assert.rejects(() => ctx.r.send('provePriorAnchors', [1n, proofFor(tree, count)]), /RootUnadmitted/, 'the count is the root\'s own');
    await ctx.r.send('provePriorAnchors', [2n, proofFor(tree, count)], { from: ACCOUNTS.mallory });
    assert.deepEqual([...(await ctx.r.call('priorAnchors'))], [1n, 2n, true]);
    // Proven once: the same count again is idempotent, another refused (BOND-09).
    await ctx.r.send('provePriorAnchors', [2n, proofFor(tree, count)]);
    await assert.rejects(() => ctx.r.send('provePriorAnchors', [3n, proofFor(tree, count)]), /PriorCountProven/);
    // The front-run of the audit: sealed, not yet recorded. The record matches the
    // book, and the old rule (a root exists) opened here without the deposit.
    const c0 = await ctx.r.call('claimants');
    assert.equal(c0.live, await ctx.registry.call('totalAnchored'));
    await assert.rejects(() => ctx.s.send('settleDeclaration', [], { from: ACCOUNTS.mallory }), /AnchorsUnrecorded/, 'the deposit the root proves is not yet in the record');

    // The deposit's proof, labelled with the epoch the escrow took it in, reaches QRL after T.
    await ctx.registry.send('recordAnchor', [[CHAIN_ID, ASSET_A, OTHER, OTHER, 9n, 50n * ONE, ESCROW], depositEpoch, proofFor(tree, leaf)], { from: ACCOUNTS.mallory });
    const a = await ctx.registry.call('anchorOf', [id]);
    assert.equal(a.anchoredAt, (depositEpoch + 1n) * BigInt(EPOCH), 'anchored at the close of its epoch');
    assert.ok(a.anchoredAt <= at);

    await assert.rejects(() => ctx.s.send('settleDeclaration'), /ClaimantsIncomplete/);
    await ctx.r.send('recordClaimants', [[id]]);
    assert.equal((await ctx.r.call('priorAnchors'))[0], 2n);
    const [kind, weight] = await ctx.s.call('claimantOf', [id]);
    assert.equal(kind, 1n, 'a claimant, not recorded-after-T');
    assert.ok(weight > 0n, 'at its vesting from the close of its epoch to T');
    await ctx.s.send('settleDeclaration');
    const c = await ctx.r.call('claimants');
    assert.equal(c.anchored, 150n * ONE);
  });

  test('the wait for the anchors of the root before T lapses W_a epochs after T: the opening proceeds and the unrecorded are excluded (QL-06 lapse)', async () => {
    const { buildTree, proofFor } = require('../ecdsa-stakings/relayer/lib/merkle');
    for (const proveIt of [true, false]) {
      const ctx = await book({ term: TERM.QUARTER, vested: false, positions: [{ owner: HOLDER, notional: 100n * ONE }] });
      ctx.chain.advanceTime(30 * DAY);
      F.toNextEpoch(ctx);
      const depositEpoch = epochNow(ctx);
      const id = F.stakeAssetId(CHAIN_ID, ASSET_A, OTHER, OTHER, 9n);
      // Cumulative (BOND-02): the book's first anchor and the deposit.
      const count = F.anchorCountLeaf(depositEpoch, 2n);
      const tree = buildTree([F.stakeLeafKey(id, 50n * ONE), count]);
      F.toNextEpoch(ctx);
      ctx.chain.advanceTime(DAY);
      const at = BigInt(ctx.chain.timestamp);
      await ctx.qday.send('declare', [at]);
      if (proveIt) {
        await ctx.attest.send('seal', [depositEpoch, tree.root]);
        await ctx.r.send('provePriorAnchors', [2n, proofFor(tree, count)]);
      }
      await ctx.r.send('recordClaimants', [[ctx.pos[0].id]]);
      // The deposit's proof never reaches QRL.
      await assert.rejects(() => ctx.s.send('settleDeclaration'), proveIt ? /AnchorsUnrecorded/ : /RootUnadmitted/);
      const Wa = BigInt((await ctx.params.call('trigger2Params'))[2]);
      F.toEpoch(ctx, at / BigInt(EPOCH) + Wa - 1n);
      await assert.rejects(() => ctx.s.send('settleDeclaration'), proveIt ? /AnchorsUnrecorded/ : /RootUnadmitted/, 'not before W_a epochs from T');
      F.toEpoch(ctx, at / BigInt(EPOCH) + Wa);
      const res = await ctx.s.send('settleDeclaration');
      const [ev] = ctx.s.events(res, 'AnchorsExcluded');
      assert.equal(ev.args.epoch, depositEpoch);
      assert.equal(ev.args.excluded, proveIt ? 1n : 0n, 'the count excluded');
      assert.equal(ev.args.counted, proveIt);
      assert.equal(ctx.s.events(res, 'Trigger2Drawn').length, 1, 'the opening proceeds');
      assert.equal((await ctx.r.call('claimants')).anchored, 100n * ONE, 'the unrecorded deposit is not in W');
    }
  });

  test('an anchor of the root before T that left before T is counted toward that root, owed nothing (QL-06)', async () => {
    const { buildTree, proofFor } = require('../ecdsa-stakings/relayer/lib/merkle');
    const ctx = await book({ term: TERM.QUARTER, vested: false, positions: [{ owner: HOLDER, notional: 100n * ONE }] });
    ctx.chain.advanceTime(30 * DAY);
    F.toNextEpoch(ctx);
    const depositEpoch = epochNow(ctx);
    const id = F.stakeAssetId(CHAIN_ID, ASSET_A, OTHER, OTHER, 9n);
    const leaf = F.stakeLeafKey(id, 50n * ONE);
    // Cumulative (BOND-02): the book's first anchor and the deposit.
    const count = F.anchorCountLeaf(depositEpoch, 2n);
    const tree = buildTree([leaf, count]);
    F.toNextEpoch(ctx);
    await ctx.attest.send('seal', [depositEpoch, tree.root]);
    await ctx.registry.send('recordAnchor', [[CHAIN_ID, ASSET_A, OTHER, OTHER, 9n, 50n * ONE, ESCROW], depositEpoch, proofFor(tree, leaf)]);
    await ctx.registry.send('instructRelease', [id, DEST], { from: OTHER });
    ctx.chain.advanceTime(DAY);
    await ctx.qday.send('declare', [BigInt(ctx.chain.timestamp)]);
    await ctx.r.send('provePriorAnchors', [2n, proofFor(tree, count)]);
    await ctx.r.send('recordClaimants', [[ctx.pos[0].id]]);
    await assert.rejects(() => ctx.s.send('settleDeclaration'), /AnchorsUnrecorded/);
    await ctx.r.send('recordClaimants', [[id]]);
    const [kind] = await ctx.s.call('claimantOf', [id]);
    assert.equal(kind, 2n, 'counted, owed nothing: it left before T');
    await ctx.s.send('settleDeclaration');
    assert.equal((await ctx.r.call('claimants')).anchored, 100n * ONE);
  });

  test('a record before the ratification is refused, and a release instructed before T is no claimant', async () => {
    const ctx = await book({ term: TERM.QUARTER, positions: [{ owner: HOLDER, notional: 100n * ONE }, { owner: OTHER, notional: 50n * ONE }] });
    await assert.rejects(() => ctx.r.send('recordClaimants', [[ctx.pos[0].id]]), /DeclarationNotRatified/);
    await ctx.registry.send('instructRelease', [ctx.pos[1].id, DEST], { from: OTHER });
    ctx.chain.advanceTime(EPOCH);
    await F.declare(ctx, BigInt(ctx.chain.timestamp));
    // Anchored through the root before T and released before T: counted toward the
    // cumulative count, owed nothing (BOND-02), never a claimant.
    await ctx.r.send('recordClaimants', [[ctx.pos[1].id]]);
    assert.equal((await ctx.s.call('claimantOf', [ctx.pos[1].id]))[0], 2n);
    await ctx.r.send('recordClaimants', [[ctx.pos[0].id]]);
    await ctx.s.send('settleDeclaration');
    assert.equal((await ctx.r.call('claimants')).anchored, 100n * ONE);
  });

  test('BOND-02 (re-audit 2026-09-30): a deposit of an EARLIER epoch whose root is sealed after T holds the opening like the last root\'s (the PoC, now refused)', async () => {
    const { buildTree, proofFor } = require('../ecdsa-stakings/relayer/lib/merkle');
    const ctx = await book({ term: TERM.QUARTER, vested: false, positions: [{ owner: HOLDER, notional: 100n * ONE }] });
    ctx.chain.advanceTime(30 * DAY);
    F.toNextEpoch(ctx);
    const depositEpoch = epochNow(ctx); // the escrow takes the deposit here; the relayer lags
    F.toNextEpoch(ctx); // a quiet epoch
    F.toNextEpoch(ctx);
    ctx.chain.advanceTime(DAY);
    const at = BigInt(ctx.chain.timestamp);
    await ctx.qday.send('declare', [at]);
    const prior = at / BigInt(EPOCH) - 1n;
    assert.equal(prior, depositEpoch + 1n);
    // The relayer catches up: the quiet root of `prior` carries the CUMULATIVE count, two
    // (the book's first anchor and the deposit), and the late root of the deposit's epoch.
    await ctx.attest.send('seal', [prior, F.anchorCountLeaf(prior, 2n)]);
    const id = F.stakeAssetId(CHAIN_ID, ASSET_A, OTHER, OTHER, 9n);
    const leaf = F.stakeLeafKey(id, 50n * ONE);
    const tree = buildTree([leaf, F.anchorCountLeaf(depositEpoch, 2n)]);
    await ctx.attest.send('seal', [depositEpoch, tree.root]);
    // The PoC's front-run: a count of zero no longer proves (the root carries two).
    await assert.rejects(() => ctx.r.send('provePriorAnchors', [0n, []], { from: ACCOUNTS.mallory }), /RootUnadmitted/);
    await ctx.r.send('provePriorAnchors', [2n, []], { from: ACCOUNTS.mallory });
    await ctx.r.send('recordClaimants', [[ctx.pos[0].id]], { from: ACCOUNTS.mallory });
    await assert.rejects(() => ctx.s.send('settleDeclaration', [], { from: ACCOUNTS.mallory }), /AnchorsUnrecorded/, 'the earlier root\'s deposit holds the opening');
    // Its proof reaches QRL; it is a claimant, and the opening proceeds with it in W.
    await ctx.registry.send('recordAnchor', [[CHAIN_ID, ASSET_A, OTHER, OTHER, 9n, 50n * ONE, ESCROW], depositEpoch, proofFor(tree, leaf)]);
    await ctx.r.send('recordClaimants', [[id]]);
    await ctx.s.send('settleDeclaration');
    assert.equal((await ctx.r.call('claimants')).anchored, 150n * ONE, 'the 50-unit deposit is in W');
    F.toNextEpoch(ctx);
    await ctx.s.send('claimSettlement', [T2_FLOOR, id], { from: OTHER });
  });
});

describe('HOLD: an unmeasurable severity holds the balance, neither paid nor released (item 25a, I37)', () => {
  async function held() {
    const ctx = await declared();
    await open2(ctx);
    const t2 = await ctx.s.call('declaration');
    F.toEpoch(ctx, t2.epoch + 4n);
    await ctx.oracle.send('setReverting', [true]);
    const res = await ctx.s.send('settleSeverity');
    return { ctx, t2, res };
  }

  test('an oracle dead at the opening opens at the carried price: D_0 is drawn, and the balance is held and left to the court (QL-07)', async () => {
    const ctx = await declared();
    const [carried] = await ctx.registry.call('carriedPrice');
    assert.ok(carried > 0n, 'a price was carried by the last mark');
    await ctx.oracle.send('setReverting', [true]);
    // Since 2026-10-05 the registry's settlement price never reverts while the
    // series is silent: it strikes at the carried price (technical reference
    // §1.4, I40). The opening still reads the reference series as dead.
    assert.equal(await ctx.registry.call('settlementPrice'), carried, 'a dead oracle strikes at the carried price');
    await assert.rejects(() => ctx.registry.call('referencePrice'), 'the oracle is dead');
    const res = await open2(ctx);
    const [ev] = ctx.s.events(res, 'OpenedAtCarriedPrice');
    assert.equal(ev.args.price, carried);
    assert.equal(ev.args.refOpen, carried);
    const t2 = await ctx.s.call('declaration');
    assert.equal(t2.price, carried);
    assert.equal(t2.refOpen, carried);
    assert.equal(ctx.s.events(res, 'Trigger2Drawn').length, 1, 'D_0 is drawn: the principal is not all held with no path forward');
    F.toEpoch(ctx, t2.epoch + 4n);
    const r = await ctx.s.send('settleSeverity');
    assert.equal(ctx.s.events(r, 'SeverityHeld').length, 1, 'the balance is HELD while the series is silent (item 25a)');
    F.toEpoch(ctx, t2.epoch + 4n + 8n);
    const fixed = await ctx.court.send('fixSeverity', [7000n]);
    assert.equal(ctx.s.events(fixed, 'SeveritySettled').length, 1, 'and fixed by the court after 2 x W_a');
  });

  test('an oracle reading zero at the opening opens at the carried price as a dead one does (QL-07)', async () => {
    const ctx = await declared();
    const [carried] = await ctx.registry.call('carriedPrice');
    await ctx.oracle.send('set', [0n, 0n, 0n]);
    const res = await open2(ctx);
    assert.equal(ctx.s.events(res, 'OpenedAtCarriedPrice')[0].args.price, carried);
    assert.equal((await ctx.s.call('declaration')).price, carried);
  });

  test('a dead oracle at the close holds S_full - D_0 of it in its classes, junior first', async (t) => {
    if (needModel(t)) return;
    const { ctx, t2, res } = await held();
    const [ev] = ctx.s.events(res, 'SeverityHeld');
    const pool = 100_000n * ONE;
    assert.equal(ev.args.heldQrl, M.ark.trigger2HeldPrincipal(t2.weight, 6000, pool, t2.price, t2.capUnits), 'trigger2HeldPrincipal');
    // Junior bore D_0 (60,000 of its 70,000); the rest of the hold is senior's.
    assert.equal(ev.args.heldJunior, 10_000n * ONE);
    assert.equal(ev.args.heldSenior, 30_000n * ONE);
    const s = await classes(ctx);
    assert.equal(s.j + s.s, pool - (pool * 6000n) / BPS, 'held principal is not drawn: it stays in its class');
    // Held: a second close does not settle it, and the court may not yet fix m_loss.
    await assert.rejects(() => ctx.s.send('settleSeverity'), /SeverityUnmeasurable/);
    await assert.rejects(() => ctx.court.send('fixSeverity', [5000n]), refused('SeverityCourtTooEarly(uint256)'));
  });

  test('an active breaker holds the balance as a dead oracle does (whitepaper §5.5)', async () => {
    const ctx = await declared();
    await open2(ctx);
    const t2 = await ctx.s.call('declaration');
    F.toEpoch(ctx, t2.epoch + 4n);
    // The thirty-day average halved in a day: the breaker holds, the severity is not measured.
    await ctx.oracle.send('set', [4000n * PRICE, 4000n * PRICE, 9000n * PRICE]);
    assert.equal(await ctx.registry.call('breakerActive'), true);
    const res = await ctx.s.send('settleSeverity');
    assert.equal(ctx.s.events(res, 'SeverityHeld').length, 1);
    assert.equal((await ctx.s.call('declaration')).stage, 2n);
  });

  test('a class holding part of the balance is frozen whole until the hold settles (re-audit 2026-09-30, BOND-01; heldFreezeOfClassHolding)', async (t) => {
    if (needModel(t)) return;
    const { ctx, res } = await held();
    const [ev] = ctx.s.events(res, 'SeverityHeld');
    const m = (await ctx.bond.call('holdingOf', [ctx.senior])).maturityEpoch;
    F.toEpoch(ctx, m + 1n);
    await F.distributeDue(ctx);
    for (const [id, owner, heldInClass] of [[ctx.senior, OTHER, ev.args.heldSenior], [ctx.junior, HOLDER, ev.args.heldJunior]]) {
      const worth = await ctx.bond.call('principalOf', [id]);
      assert.ok(heldInClass > 0n);
      assert.equal(M.ark.heldFreezeOfClassHolding(worth, heldInClass), worth, 'the whole holding');
      await assert.rejects(() => ctx.bond.send('redeem', [id], { from: owner }), /HeldUnderSeverity/);
    }
  });

  /**
   * BOND-01 of the re-audit of 2026-09-30, the PoC as a regression: two equal
   * junior holdings under a hold, one matured. Under the pro-rata freeze of
   * PV-11 the matured one left with the part above its share and the court's
   * total severity then fell per share on the one that could not leave
   * (A 30,555.56 against B 19,444.44). Under the whole-class freeze neither
   * leaves, and both bear the draw equally.
   */
  test('BOND-01: a matured holding cannot leave ahead of a severity draw its class holds for; equal holdings end equal (the PoC, now refused)', async (t) => {
    if (needModel(t)) return;
    const ctx = await book({ junior: 0n, senior: 0n, term: TERM.QUARTER, vested: false, positions: [] });
    const p0 = await F.anchor(ctx, { owner: HOLDER, depositor: HOLDER, nonce: 0n, notional: ONE });
    const att = BigInt(await ctx.registry.call('effectiveAttachmentBps'));
    const units = (50_000n * ONE * PRICE_SCALE * BPS) / (REF_PRICE * att) + 1n;
    const p1 = await F.anchor(ctx, { owner: HOLDER, depositor: HOLDER, nonce: 1n, notional: units - ONE });
    ctx.chain.advanceTime(91 * DAY);
    const A = await F.subscribe(ctx, { from: HOLDER, class_: CLASS.JUNIOR, term: TERM.QUARTER, value: 50_000n * ONE });
    const B = await F.subscribe(ctx, { from: OTHER, class_: CLASS.JUNIOR, term: TERM.YEAR, value: 50_000n * ONE });
    await F.declare(ctx, BigInt(ctx.chain.timestamp));
    await ctx.r.send('recordClaimants', [[p0.id, p1.id]]);
    await ctx.s.send('settleDeclaration');
    const t2 = await ctx.s.call('declaration');
    F.toEpoch(ctx, t2.epoch + 4n);
    await ctx.oracle.send('setReverting', [true]);
    const [ev] = ctx.s.events(await ctx.s.send('settleSeverity'), 'SeverityHeld');
    assert.ok(ev.args.heldJunior > 0n, 'a balance is held in junior');
    const m = (await ctx.bond.call('holdingOf', [A])).maturityEpoch;
    F.toEpoch(ctx, m + 1n);
    await F.distributeDue(ctx);
    // The PoC's step: A redeems its "unfrozen" part. Refused whole now.
    await assert.rejects(() => ctx.bond.send('redeem', [A], { from: HOLDER }), /HeldUnderSeverity/);
    F.toEpoch(ctx, t2.epoch + 4n + 8n > m + 1n ? t2.epoch + 4n + 8n : m + 1n);
    await ctx.court.send('fixSeverity', [10000n]);
    const a = await ctx.bond.call('principalOf', [A]);
    const b = await ctx.bond.call('principalOf', [B]);
    assert.ok((a > b ? a - b : b - a) <= 2n, `equal holdings end equal: A ${a}, B ${b}`);
    // The hold settled, A leaves with what the draw left it.
    const r = await ctx.bond.send('redeem', [A], { from: HOLDER });
    assert.equal(ctx.bond.events(r, 'Redeemed')[0].args.amount, a);
  });

  test('the series resuming settles the hold, and what the severity does not reach is released', async (t) => {
    if (needModel(t)) return;
    const { ctx } = await held();
    await ctx.oracle.send('setReverting', [false]);
    await ctx.oracle.send('set', [3000n * PRICE, 3000n * PRICE, 3000n * PRICE]); // m_loss 7,000, clamped at 6,835 (PV-03)
    const res = await ctx.s.send('settleSeverity');
    const [ev] = ctx.s.events(res, 'Trigger2Drawn');
    const pool = 100_000n * ONE;
    const total = BigInt(M.ark.trigger2DrawTotalBps(M.params, M.ark.trigger2SeverityBps(M.params, 7000)));
    assert.equal(total, 6835n);
    assert.equal(ev.args.drawQrl, (pool * total) / BPS - (pool * 6000n) / BPS);
    const t2 = await ctx.s.call('declaration');
    assert.equal(t2.held, 0n);
    assert.equal(t2.stage, 3n);
  });

  test('silent for 2 x W_a epochs after the window, the court fixes m_loss and settles the hold', async (t) => {
    if (needModel(t)) return;
    const { ctx, t2 } = await held();
    const closes = t2.epoch + 4n;
    F.toEpoch(ctx, closes + 7n);
    await assert.rejects(() => ctx.court.send('fixSeverity', [9000n]), refused('SeverityCourtTooEarly(uint256)'));
    assert.equal(M.ark.holdDeterminationOpen(M.params, 7, false), false);
    F.toEpoch(ctx, closes + 8n);
    assert.equal(M.ark.holdDeterminationOpen(M.params, 8, false), true);
    // In the recovery module since the value slices of 2026-09-30, at the bond's address.
    await assert.rejects(() => ctx.r.send('fixSeverity', [9000n], { from: HOLDER }), /OnlyCourt/);
    const res = await ctx.court.send('fixSeverity', [9000n]);
    const [ev] = ctx.s.events(res, 'SeveritySettled');
    assert.equal(ev.args.byCourt, true);
    assert.equal(ev.args.drawTotalBps, 9000n);
  });

  test('where the series has resumed the court is not asked: the series settles it', async (t) => {
    if (needModel(t)) return;
    const { ctx, t2 } = await held();
    F.toEpoch(ctx, t2.epoch + 4n + 8n);
    await ctx.oracle.send('setReverting', [false]);
    assert.equal(M.ark.holdDeterminationOpen(M.params, 8, true), false);
    await assert.rejects(() => ctx.court.send('fixSeverity', [9000n]), refused('SeverityCourtTooEarly(uint256)'));
    await ctx.s.send('settleSeverity');
  });
});

describe('the censorship ground draws D_0 only, over the book and the qualifying releases (item 25b; whitepaper §3.6, §5.2)', () => {
  test('the finding fixes T; the record of positions and releases opens D_0 of the full settlement over both', async (t) => {
    if (needModel(t)) return;
    const ctx = await book({ positions: [{ owner: HOLDER, notional: 100n * ONE }, { owner: OTHER, notional: 100n * ONE }] });
    // Bob's position leaves: instructed and past unbonding, unsettled for want of a root.
    const [a, b] = ctx.pos;
    await ctx.registry.send('instructRelease', [b.id, DEST], { from: OTHER });
    ctx.chain.advanceTime(22 * DAY);
    await ctx.court.send('open', [det(9)]);
    const res = await ctx.court.send('determineCensorship', [det(9), 100n * ONE]);
    const [g] = ctx.s.events(res, 'Trigger2Grounded');
    assert.equal(g.args.ground, 2n);
    assert.equal(g.args.baseAtT, 100n * ONE, 'the anchored notional at the determination');
    assert.equal(ctx.s.events(res, 'Trigger2Drawn').length, 0, 'the draw waits for the record');
    // Nothing is issued and nothing leaves while it waits.
    await assert.rejects(() => F.subscribe(ctx, { from: HOLDER, value: ONE }), /DeclaredPendingSettlement|DeterminationOpen/);
    await assert.rejects(() => ctx.s.send('settleDeclaration'), /ClaimantsIncomplete/);
    await ctx.r.send('recordClaimants', [[a.id]]);
    await assert.rejects(() => ctx.s.send('settleDeclaration'), /ClaimantsIncomplete/, 'the qualifying transit is not recorded yet');
    await ctx.r.send('recordClaimants', [[b.id]]);
    const before = await classes(ctx);
    const pool = before.j + before.s;
    const r = await ctx.s.send('settleDeclaration');
    const [ev] = ctx.s.events(r, 'Trigger2Drawn');
    const t2 = await ctx.s.call('declaration');
    const claimants = [{ notional: 100n * ONE, vestingBps: 10000 }, { notional: 100n * ONE, vestingBps: 10000 }];
    const m = M.ark.trigger2Settlement(claimants, M.ark.censorshipDrawBps(M.params), pool, t2.price, await attAtT(ctx));
    assert.equal(t2.capUnits, m.capUnits, 'K_T on the positions and the qualifying releases together');
    assert.equal(ev.args.drawQrl, m.poolDraw, 'D_0 of the full settlement and no more: the escrow is unimpaired');
    assert.equal(t2.stage, 3n, 'no assessment window: nothing further is measured');
    assert.equal(t2.base, 200n * ONE, 'the book widened by the qualifying transit');
    await assert.rejects(() => ctx.s.send('settleSeverity'), /NothingHeld/);
    F.toNextEpoch(ctx);
    for (const [i, p] of [a, b].entries()) {
      const c = await ctx.s.send('claimSettlement', [T2_FLOOR, p.id], { from: p.owner });
      assert.equal(ctx.s.events(c, 'SettlementClaimed')[0].args.amount, m.entitlements[i]);
    }
    // Each is diluted by N_A / (N_A + N_T) against a declaration's terms at a pool below both.
    assert.equal(M.ark.censorshipDilutionBps(100n * ONE, 100n * ONE), 5000);
  });

  test('a transit figure no record can meet holds the opening only until the assessment window has run', async () => {
    const ctx = await book({ positions: [{ owner: HOLDER, notional: 100n * ONE }] });
    await ctx.court.send('open', [det(8)]);
    await ctx.court.send('determineCensorship', [det(8), 5n * ONE]);
    await ctx.r.send('recordClaimants', [[ctx.pos[0].id]]);
    await assert.rejects(() => ctx.s.send('settleDeclaration'), /ClaimantsIncomplete/);
    const found = epochNow(ctx);
    F.toEpoch(ctx, found + 3n);
    await assert.rejects(() => ctx.s.send('settleDeclaration'), /ClaimantsIncomplete/, 'W_a = 4 epochs from the finding');
    F.toEpoch(ctx, found + 4n);
    await ctx.s.send('settleDeclaration');
    assert.equal((await ctx.s.call('declaration')).base, 100n * ONE);
  });
});

/* ------------------------------------------------------------------ */
/* Value slices of a single fact (whitepaper §6.2, EC-04)             */
/* ------------------------------------------------------------------ */

describe('value slices of a single fact: each settles only its fraction (whitepaper §6.2, EC-04; slices-rule.md of 2026-09-30)', () => {
  const { keccak256, AbiCoder } = require('ethers');
  const coder = AbiCoder.defaultAbiCoder();
  const WHOLE = 10n ** 18n;
  const uintPayload = (x) => coder.encode(['uint256'], [x]);
  const sliceId = (g, i) => keccak256(coder.encode(['bytes32', 'uint8'], [g, i]));
  const G = det(0x5c);
  const phi = (Phi, n, i) => M.ark.sliceFraction(Phi, n, i);

  /** The draw, the hold and its classes of the settlement as it stands. */
  async function t2Of(ctx) {
    const t = await ctx.s.call('declaration');
    assert.equal(t.heldByClass[0] + t.heldByClass[1], t.held, 'invariant 7: the classes hold what is held');
    assert.ok(t.drawn + t.held <= t.fullSettlement, 'invariant 3: the draw and the hold never pass S_full');
    return t;
  }

  /**
   * The censorship ground in four slices, slice 1 rejected, closed in
   * `order`. Since the re-audit of 2026-09-30 (COURT-04) the ground stands
   * only when the LAST slice closes with one upheld, T at the first upheld
   * slice, and it opens with every slice closed: no slice grounds anything
   * alone, and nothing opens while one is before the court. Returns the
   * settlement and T.
   */
  async function censorshipInSlices(order) {
    const ctx = await book({ positions: [{ owner: HOLDER, notional: 100n * ONE }] });
    await ctx.court.send('open', [G]);
    const opened = await ctx.court.send('openSlices', [G, 2, 4]);
    assert.equal(ctx.s.events(opened, 'SlicesOpened')[0].args.phi, WHOLE);
    const upheld = [true, false, true, true];
    let T = 0n;
    for (const [k, i] of order.entries()) {
      ctx.chain.advanceTime(3600);
      const res = await ctx.court.send('closeSlice', [G, i, upheld[i], uintPayload(0n)]);
      if (upheld[i] && T === 0n) T = BigInt(ctx.chain.timestamp);
      const last = k === order.length - 1;
      assert.equal(ctx.s.events(res, 'Trigger2Grounded').length, last ? 1 : 0, 'the ground stands with the last slice only');
      if (!last) {
        assert.equal((await ctx.r.call('claimants')).ground, 0n, 'no slice grounds anything alone');
        await assert.rejects(() => ctx.r.send('recordClaimants', [[ctx.pos[0].id]]), /DeclarationNotRatified/);
      }
    }
    // `at` by index: a Result's `.at` is Array.prototype.at.
    assert.equal((await ctx.r.call('claimants'))[1], T, 'T is the first upheld slice\'s');
    await ctx.r.send('recordClaimants', [[ctx.pos[0].id]]);
    const res = await ctx.s.send('settleDeclaration');
    assert.equal(ctx.s.events(res, 'Trigger2Drawn').length, 1, 'one draw, at the opening');
    assert.equal(ctx.s.events(res, 'Trigger2Drawn')[0].args.settlementId, T2_FLOOR);
    return ctx;
  }

  test('the censorship ground: the ground draws D_0 of the upheld fraction, the open part held meanwhile, whatever the order (invariants 1 - 4, 6, 7)', async (t) => {
    if (needModel(t)) return;
    const finals = [];
    for (const order of [[0, 1, 2, 3], [3, 2, 1, 0], [1, 3, 0, 2]]) {
      const ctx = await censorshipInSlices(order);
      const d = await t2Of(ctx);
      const U = WHOLE - phi(WHOLE, 4, 1);
      assert.equal(d.stage, 3n, 'settled with the last slice');
      assert.equal(d.held, 0n);
      assert.equal(d.drawn, M.ark.slicedDrawTarget(d.fullSettlement, U * d.d0), 'invariant 4: floor(S * D_0 * U / (BPS * F))');
      assert.ok(d.drawn < (d.fullSettlement * d.d0) / BPS, 'less than the unsliced draw by the rejected fraction');
      assert.equal((await ctx.s.call('sliceGroup')).id, '0x' + '00'.repeat(32), 'the group is cleared with its last slice');
      assert.equal(await ctx.bond.call('seedReturnSealable'), false, 'the ground found holds every seed return');
      // The recovery ledger takes the cumulative draw by class (rule §7).
      const la = await ctx.r.call('escrowLedger', [CHAIN_ID, ESCROW]);
      const units = { junior: (d.drawnByClass[0] * PRICE) / d.price, senior: (d.drawnByClass[1] * PRICE) / d.price };
      const inc = M.ark.trigger2EscrowDraws(units, la.weight, d.weight);
      assert.equal(la.paid, inc.junior + inc.senior, 'P of the escrow: its part of the whole cumulative draw');
      finals.push(d.drawn);
    }
    assert.equal(new Set(finals.map(String)).size, 1, 'invariant 6: every close order gives the same draw');
  });

  test('the ground\'s one draw is claimed under T2_FLOOR, floor(draw * w / W) (trigger2Entitlement)', async (t) => {
    if (needModel(t)) return;
    const ctx = await censorshipInSlices([0, 1, 2, 3]);
    const d = await ctx.s.call('declaration');
    F.toNextEpoch(ctx);
    const [rec] = await ctx.s.call('settlementOf', [T2_FLOOR]);
    assert.equal(rec.total, d.drawn);
    const [none] = await ctx.s.call('settlementOf', [sliceId(G, 3)]);
    assert.equal(none.total, 0n, 'no slice draws under its own id');
    const claimant = await claimantAt(ctx, ctx.pos[0].id, d.declaredAt);
    const c = await ctx.s.send('claimSettlement', [T2_FLOOR, ctx.pos[0].id], { from: HOLDER });
    assert.equal(ctx.s.events(c, 'SettlementClaimed')[0].args.amount, M.ark.trigger2Entitlement(rec.total, d.weight, claimant));
  });

  test('every slice rejected: nothing is grounded and nothing drawn (rule §5)', async () => {
    const ctx = await book({ positions: [{ owner: HOLDER, notional: 100n * ONE }] });
    await ctx.court.send('open', [G]);
    await ctx.court.send('openSlices', [G, 2, 3]);
    for (const i of [0, 1, 2]) {
      const res = await ctx.court.send('closeSlice', [G, i, false, '0x']);
      assert.equal(ctx.s.events(res, 'Trigger2Grounded').length, 0);
    }
    assert.equal((await ctx.r.call('claimants')).ground, 0n);
    await assert.rejects(() => ctx.s.send('settleDeclaration'), /DeclarationNotRatified/);
    // A later assertion of the ground starts a group of its own on the whole.
    await ctx.court.send('open', [det(0x5d)]);
    await ctx.court.send('openSlices', [det(0x5d), 2, 2]);
    assert.equal((await ctx.s.call('declaration')).phiOpen, WHOLE);
  });

  test('at one slice the censorship ground draws what determineCensorship draws (n = 1 reduces exactly)', async () => {
    const drawn = [];
    for (const sliced of [false, true]) {
      const ctx = await book({ positions: [{ owner: HOLDER, notional: 100n * ONE }] });
      await ctx.court.send('open', [G]);
      if (sliced) {
        await ctx.court.send('openSlices', [G, 2, 1]);
        await ctx.court.send('closeSlice', [G, 0, true, uintPayload(0n)]);
      } else {
        await ctx.court.send('determineCensorship', [G, 0n]);
      }
      await ctx.r.send('recordClaimants', [[ctx.pos[0].id]]);
      await ctx.s.send('settleDeclaration');
      const d = await ctx.s.call('declaration');
      assert.equal(d.stage, 3n);
      drawn.push(d.drawn);
    }
    assert.equal(drawn[0], drawn[1]);
  });

  /** A declared book whose severity is held, 2 x W_a past the window's close: the court may fix it. */
  async function heldBook() {
    const ctx = await declared();
    await open2(ctx);
    const t2 = await ctx.s.call('declaration');
    F.toEpoch(ctx, t2.epoch + 4n);
    await ctx.oracle.send('setReverting', [true]);
    await ctx.s.send('settleSeverity');
    F.toEpoch(ctx, t2.epoch + 4n + 8n);
    return ctx;
  }

  test('a held balance in slices: an upheld slice draws its fraction at the court\'s D and releases the rest; a rejected one stays held and is asserted again (invariants 5, 7)', async (t) => {
    if (needModel(t)) return;
    const ctx = await heldBook();
    const d0 = await t2Of(ctx);
    const S = d0.fullSettlement;
    const reach = 10000 - Number(d0.d0);
    let z = d0.d0 * WHOLE;
    assert.equal(d0.held, M.ark.slicedHeldPrincipal(S, z, WHOLE, reach), 'the hold is slicedHeldPrincipal with nothing settled');
    await ctx.court.send('openSlices', [G, 3, 3]);
    await assert.rejects(() => ctx.court.send('openSlices', [det(0x5e), 3, 2]), /SliceGroupOpen/, 'one group of a kind at a time');
    // Slice 0 upheld at 9,000: its fraction drawn at 9,000, the rest of it released.
    let res = await ctx.court.send('closeSlice', [G, 0, true, uintPayload(9000n)]);
    z += phi(WHOLE, 3, 0) * (9000n - d0.d0);
    let d = await t2Of(ctx);
    assert.equal(d.drawn, M.ark.slicedDrawTarget(S, z));
    assert.equal(d.held, M.ark.slicedHeldPrincipal(S, z, WHOLE - phi(WHOLE, 3, 0), reach));
    assert.ok(d.held < d0.held, 'the rest of the slice\'s share is released');
    assert.equal(ctx.s.events(res, 'Trigger2Drawn')[0].args.settlementId, sliceId(G, 0));
    // Slice 1 rejected: nothing moves, its fraction stays held.
    res = await ctx.court.send('closeSlice', [G, 1, false, '0x']);
    assert.equal(ctx.s.events(res, 'Trigger2Drawn').length, 0);
    assert.equal((await t2Of(ctx)).held, d.held);
    // Slice 2 upheld at 7,000.
    await ctx.court.send('closeSlice', [G, 2, true, uintPayload(7000n)]);
    z += phi(WHOLE, 3, 2) * (7000n - d0.d0);
    const open = phi(WHOLE, 3, 1);
    d = await t2Of(ctx);
    assert.equal(d.phiOpen, open);
    assert.equal(d.stage, 2n, 'still held: the rejected fraction');
    assert.equal(d.held, M.ark.slicedHeldPrincipal(S, z, open, reach));
    await assert.rejects(() => ctx.court.send('closeSlice', [G, 2, true, uintPayload(7000n)]), refused('NoSuchSlice(bytes32,uint8)'), 'the group is gone');
    // Asserted again: a group on what is still open, both slices upheld at 8,000.
    const G2 = det(0x5f);
    const opened = await ctx.court.send('openSlices', [G2, 3, 2]);
    assert.equal(ctx.s.events(opened, 'SlicesOpened')[0].args.phi, open);
    await ctx.court.send('closeSlice', [G2, 1, true, uintPayload(8000n)]);
    await ctx.court.send('closeSlice', [G2, 0, true, uintPayload(8000n)]);
    z += open * (8000n - d0.d0);
    d = await t2Of(ctx);
    assert.equal(d.stage, 3n, 'settled once nothing is open');
    assert.equal(d.held, 0n);
    assert.equal(d.drawn, M.ark.slicedDrawTarget(S, z));
  });

  test('at one slice, and with every slice upheld at one m, a held balance draws what fixSeverity draws (invariant 5)', async () => {
    const drawn = [];
    for (const n of [0, 1, 4]) {
      const ctx = await heldBook();
      if (n === 0) {
        await ctx.court.send('fixSeverity', [9000n]);
      } else {
        await ctx.court.send('openSlices', [G, 3, n]);
        for (let i = n - 1; i >= 0; i--) await ctx.court.send('closeSlice', [G, i, true, uintPayload(9000n)]);
      }
      const d = await ctx.s.call('declaration');
      assert.equal(d.stage, 3n);
      drawn.push(d.drawn);
    }
    assert.equal(drawn[1], drawn[0], 'one slice: the unsliced draw');
    assert.equal(drawn[2], drawn[0], 'every slice upheld at one m: the unsliced draw');
  });

  test('adversarial: slices are the court\'s, once each, of the group open, and only where the bond\'s record admits them', async () => {
    const ctx = await book({ positions: [{ owner: HOLDER, notional: 100n * ONE }] });
    // In the recovery module since the re-audit of 2026-09-30.
    await assert.rejects(() => ctx.r.send('openSlices', [G, 2, 2], { from: HOLDER }), /OnlyCourt/);
    await assert.rejects(() => ctx.court.send('openSlices', [G, 2, 2]), /DeterminationNotOpen/, 'the censorship group needs its determination');
    await ctx.court.send('open', [G]);
    await assert.rejects(() => ctx.court.send('openSlices', [G, 2, 0]), /BadSlices/);
    await assert.rejects(() => ctx.court.send('openSlices', [G, 2, 17]), /BadSlices/, 'at most sixteen');
    await assert.rejects(() => ctx.court.send('openSlices', [G, 1, 2]), /BadSlices/, 'a loss is split by its asserter, not sliced');
    await assert.rejects(() => ctx.court.send('openSlices', [G, 3, 2]), /NothingHeld/, 'a severity group needs a held balance');
    await ctx.court.send('openSlices', [G, 2, 2]);
    await assert.rejects(() => ctx.r.send('closeSlice', [G, 0, true, uintPayload(0n), 0n], { from: HOLDER }), /OnlyCourt/);
    const noSlice = refused('NoSuchSlice(bytes32,uint8)');
    await assert.rejects(() => ctx.court.send('closeSlice', [det(1), 0, true, uintPayload(0n)]), noSlice, 'another group');
    await assert.rejects(() => ctx.court.send('closeSlice', [G, 2, true, uintPayload(0n)]), noSlice, 'past the count');
    await ctx.court.send('closeSlice', [G, 0, true, uintPayload(0n)]);
    await assert.rejects(() => ctx.court.send('closeSlice', [G, 0, true, uintPayload(0n)]), noSlice, 'once');
    // A censorship slice closing once a declaration is the ground moves
    // nothing, and closes all the same, unapplied (BOND-07): the group
    // completes and no fraction is stranded.
    const other = await book({ positions: [{ owner: HOLDER, notional: 100n * ONE }] });
    await other.court.send('open', [G]);
    await other.court.send('openSlices', [G, 2, 2]);
    await F.declare(other, BigInt(other.chain.timestamp));
    for (const i of [0, 1]) {
      const res = await other.court.send('closeSlice', [G, i, true, uintPayload(0n)]);
      assert.equal(other.s.events(res, 'SliceClosed')[0].args.upheld, false, 'closed unapplied');
      assert.equal(other.s.events(res, 'Trigger2Grounded').length, 0);
    }
    assert.equal((await other.s.call('sliceGroup')).id, '0x' + '00'.repeat(32), 'the group completes');
    assert.equal((await other.r.call('claimants')).ground, 1n, 'the declaration is the ground');
    const third = await declared();
    await third.court.send('open', [G]);
    await assert.rejects(() => third.court.send('openSlices', [G, 2, 2]), /DeclarationAlreadySettled/);
  });
});

/* ------------------------------------------------------------------ */
/* The censorship ground and a later declaration (re-audit 2026-09-30) */
/* ------------------------------------------------------------------ */

describe('COURT-04 / BOND-04 (re-audit 2026-09-30): a declaration after a censorship ground settles on its remainder', () => {
  const { AbiCoder } = require('ethers');
  const coder = AbiCoder.defaultAbiCoder();
  const WHOLE = 10n ** 18n;
  const uintPayload = (x) => coder.encode(['uint256'], [x]);
  const G = det(0x6c);

  /**
   * The ground in `n` slices, the ones in `upheldSet` upheld and the others
   * rejected; the record and the opening follow. A quarter-term book whose
   * holdings matured before the ground, so the hold is observable.
   */
  async function ground(n, upheldSet) {
    const ctx = await book({ term: TERM.QUARTER, vested: false, vestFirst: true, positions: [{ owner: HOLDER, notional: 100n * ONE }] });
    await ctx.court.send('open', [G]);
    await ctx.court.send('openSlices', [G, 2, n]);
    for (let i = 0; i < n; i++) await ctx.court.send('closeSlice', [G, i, upheldSet.includes(i), uintPayload(0n)]);
    await ctx.court.send('close', [G]);
    await ctx.r.send('recordClaimants', [[ctx.pos[0].id]]);
    await ctx.s.send('settleDeclaration');
    const U = upheldSet.reduce((a, i) => a + M.ark.sliceFraction(WHOLE, n, i), 0n);
    return { ctx, U };
  }

  test('one upheld slice of five forecloses its own share only: the declaration draws D_0 and its severity on the rest (the COURT-04 PoC, now refused)', async (t) => {
    if (needModel(t)) return;
    const { ctx, U } = await ground(5, [0]);
    const g = await ctx.s.call('declaration');
    assert.equal(g.stage, 3n, 'the ground settles at its opening');
    assert.equal(g.drawn, M.ark.slicedDrawTarget(g.fullSettlement, U * g.d0), 'the ground draws D_0 of U');
    // Before the ratification a matured holding leaves on the terms of its class.
    const m = (await ctx.bond.call('holdingOf', [ctx.junior])).maturityEpoch;
    F.toEpoch(ctx, m + 1n);
    await F.distributeDue(ctx);
    // Q-Day is then ratified. From the ratification nothing leaves until the
    // declaration has opened on its remainder (D6).
    await ctx.qday.send('declare', [BigInt(ctx.chain.timestamp)]);
    await assert.rejects(() => ctx.bond.send('redeem', [ctx.junior], { from: HOLDER }), /DeclaredPendingSettlement/);
    await assert.rejects(() => ctx.court.send('openRecovery', [rid(1), CHAIN_ID, '0x' + '00'.repeat(32), ESCROW, ONE, ONE]), refused('NothingToSubrogate()'), 'BOND-04: no realisation ahead of the remainder\'s draws');
    const res = await ctx.s.send('settleDeclaration');
    const rem = M.ark.declarationRemainderFraction(U);
    assert.equal(rem, WHOLE - U);
    const [ev] = ctx.s.events(res, 'DeclarationOnRemainder');
    assert.equal(ev.args.remainder, rem);
    const [drawn] = ctx.s.events(res, 'Trigger2Drawn');
    assert.equal(drawn.args.settlementId, T2_REMAINDER);
    const d = await ctx.s.call('declaration');
    assert.equal(d.stage, 1n, 'an assessment window runs on the remainder');
    assert.equal(d.phiOpen, rem);
    assert.equal(d.censorship, true, 'the same settlement: the record and S_full are the ground\'s');
    assert.equal(d.fullSettlement, g.fullSettlement);
    assert.equal(d.z, U * g.d0 + rem * g.d0, 'z continues from the ground\'s');
    assert.equal(d.drawn, M.ark.slicedDrawTarget(d.fullSettlement, BigInt(g.d0) * WHOLE), 'D_0 of the whole in all');
    // The model's draw on the remainder alone, to the one wei the two truncations of the ledger leave.
    const [rec] = await ctx.s.call('settlementOf', [T2_REMAINDER]);
    const alone = M.ark.slicedDrawTarget(d.fullSettlement, BigInt(g.d0) * rem);
    assert.ok(rec.total >= alone && rec.total - alone <= 1n, `remainder floor ${rec.total} vs the model's ${alone}`);
    // The model's trigger2Settlement on the ground's record and S_full, at the remainder.
    const claimant = await claimantAt(ctx, ctx.pos[0].id, d.declaredAt);
    const model = M.ark.trigger2Settlement([claimant], Number(g.d0), d.pool, d.price, await attAtT(ctx), rem);
    assert.equal(model.fullSettlement, d.fullSettlement, 'the same S_full');
    assert.equal(model.poolDraw, alone, 'trigger2Settlement(..., remainder) is D_0 of the remainder');
    await assert.rejects(() => ctx.s.send('settleDeclaration'), /DeclarationAlreadySettled/, 'once');
    // The severity after the window, on the remainder: measured, clamped, drawn.
    F.toEpoch(ctx, d.epoch + 4n);
    await ctx.oracle.send('set', [3000n * PRICE, 3000n * PRICE, 3000n * PRICE]);
    const sev = await ctx.s.send('settleSeverity');
    const total = BigInt(M.ark.trigger2DrawTotalBps(M.params, M.ark.trigger2SeverityBps(M.params, 7000)));
    const fin = await ctx.s.call('declaration');
    assert.equal(fin.stage, 3n);
    assert.equal(fin.z, U * g.d0 + rem * total, 'U at D_0, the remainder at D_total');
    assert.equal(fin.drawn, M.ark.slicedDrawTarget(fin.fullSettlement, fin.z));
    assert.equal(ctx.s.events(sev, 'SeveritySettled').length, 1);
    // Settled: the recovery may now be found, and principal leaves.
    await ctx.court.send('openRecovery', [rid(1), CHAIN_ID, '0x' + '00'.repeat(32), ESCROW, ONE, ONE]);
    await F.distributeDue(ctx);
    await ctx.bond.send('redeem', [ctx.junior], { from: HOLDER });
  });

  test('every slice upheld leaves the declaration nothing: a remainder of zero draws nothing and only lifts the hold', async (t) => {
    if (needModel(t)) return;
    const { ctx, U } = await ground(3, [0, 1, 2]);
    assert.equal(U, WHOLE);
    const before = (await ctx.s.call('declaration')).drawn;
    const m = (await ctx.bond.call('holdingOf', [ctx.junior])).maturityEpoch;
    F.toEpoch(ctx, m + 1n);
    await F.distributeDue(ctx);
    await ctx.qday.send('declare', [BigInt(ctx.chain.timestamp)]);
    await assert.rejects(() => ctx.bond.send('redeem', [ctx.junior], { from: HOLDER }), /DeclaredPendingSettlement/);
    const res = await ctx.s.send('settleDeclaration');
    assert.equal(ctx.s.events(res, 'Trigger2Drawn').length, 0);
    assert.equal((await ctx.s.call('declaration')).drawn, before);
    await assert.rejects(() => ctx.s.send('settleDeclaration'), /DeclarationAlreadySettled/);
    await ctx.bond.send('redeem', [ctx.junior], { from: HOLDER });
  });

  test('a declaration ratified while the slices are open is the whole ground: the slices close unapplied and it draws D_0 of the whole', async (t) => {
    if (needModel(t)) return;
    const ctx = await book({ term: TERM.QUARTER, vested: false, vestFirst: true, positions: [{ owner: HOLDER, notional: 100n * ONE }] });
    await ctx.court.send('open', [G]);
    await ctx.court.send('openSlices', [G, 2, 3]);
    await ctx.court.send('closeSlice', [G, 0, true, uintPayload(0n)]);
    await F.declare(ctx, BigInt(ctx.chain.timestamp));
    await ctx.r.send('recordClaimants', [[ctx.pos[0].id]]);
    await ctx.s.send('settleDeclaration');
    for (const i of [1, 2]) await ctx.court.send('closeSlice', [G, i, true, uintPayload(0n)]);
    const d = await ctx.s.call('declaration');
    assert.equal(d.censorship, false);
    assert.equal(d.drawn, M.ark.slicedDrawTarget(d.fullSettlement, BigInt(d.d0) * WHOLE), 'D_0 of the whole');
    assert.equal(d.phiOpen, WHOLE, 'the severity is still the declaration\'s, on the whole');
  });
});

/* ------------------------------------------------------------------ */
/* Recovery                                                            */
/* ------------------------------------------------------------------ */

const sid = (n) => '0x' + (0xa0 + n).toString(16).repeat(32);
const rid = (n) => '0x' + (0x10 + n).toString(16).repeat(32);
const ESCROW_B = '0x' + 'e6'.repeat(20);

/** A declaration settled at the floor, a price of 10,000 QRL a unit: P = 6 units. */
async function settled(opts) {
  const ctx = await declared(opts);
  await open2(ctx);
  const t2 = await ctx.s.call('declaration');
  F.toEpoch(ctx, t2.epoch + 4n);
  await ctx.oracle.send('set', [9000n * PRICE, 9000n * PRICE, 9000n * PRICE]); // m_loss 1,000: D_total = D_0
  await ctx.s.send('settleSeverity');
  return ctx;
}

describe('recovery by subrogation: per escrow, in admission order, senior first (whitepaper §5.4, I23′, I36)', () => {
  test('successors are admitted by governance, in order, up to the limit, each once', async () => {
    const ctx = await F.deployBondStack();
    await assert.rejects(() => ctx.params.send('admitSuccessor', [CHAIN_ID, sid(1)], { from: HOLDER }), /OnlyGovernance/);
    await assert.rejects(() => ctx.params.send('admitSuccessor', [CHAIN_ID, '0x' + '00'.repeat(32)]), /SuccessorNotAdmissible/);
    for (let i = 1; i <= 3; i++) await ctx.params.send('admitSuccessor', [CHAIN_ID, sid(i)]);
    await assert.rejects(() => ctx.params.send('admitSuccessor', [CHAIN_ID, sid(1)]), /SuccessorNotAdmissible/);
    await assert.rejects(() => ctx.params.send('admitSuccessor', [CHAIN_ID, sid(4)]), /SuccessorLimitReached/);
    assert.equal(await ctx.params.call('successorIndex', [CHAIN_ID, sid(2)]), 2n);
    assert.equal(await ctx.params.call('successorCount', [CHAIN_ID]), 3n);
    // Another origin chain has its own three.
    await ctx.params.send('admitSuccessor', [CHAIN_ID + 1n, sid(1)]);
  });

  test('three successors in admission order against a monotone P_rem; senior first on the actual draws', async (t) => {
    if (needModel(t)) return;
    const ctx = await settled();
    for (let i = 1; i <= 3; i++) await ctx.params.send('admitSuccessor', [CHAIN_ID, sid(i)]);
    const t2 = await ctx.s.call('declaration');
    const oj = (t2.drawnByClass[0] * PRICE) / t2.price;
    const os = (t2.drawnByClass[1] * PRICE) / t2.price;
    const P = oj + os;
    assert.deepEqual(await residual(ctx), [P, oj, os]);

    const realised = [2n * ONE, 3n * ONE, 5n * ONE];
    const shares = M.ark.sequentialRecovery(realised, P);
    let remJ = oj;
    let remS = os;
    let rem = P;
    for (let i = 0; i < 3; i++) {
      const res = await ctx.court.send('openRecovery', [rid(i), CHAIN_ID, sid(i + 1), ESCROW, realised[i], 100n * ONE]);
      const [ev] = ctx.s.events(res, 'RecoveryOpened');
      const cls = M.ark.classRecovery(shares[i].bond, { junior: remJ, senior: remS });
      remJ -= cls.junior;
      remS -= cls.senior;
      assert.equal(ev.args.toSenior, cls.senior, `successor ${i + 1}: senior to its draw first`);
      assert.equal(ev.args.toJunior, cls.junior);
      assert.equal(ev.args.toPositions, shares[i].anchored, 'the rest to the positions of that fork');
      assert.ok(ev.args.residualAfter <= rem, 'P_rem never rises between draws');
      rem = ev.args.residualAfter;
    }
    assert.equal(rem, 0n, 'the bond recovers at most what it paid, across every fork together');
    await assert.rejects(() => ctx.court.send('openRecovery', [rid(0), CHAIN_ID, sid(1), ESCROW, ONE, ONE]), refused('RecoveryExists(bytes32)'));
    await assert.rejects(() => ctx.court.send('openRecovery', [rid(8), CHAIN_ID, sid(1), ESCROW, ONE, ONE]), refused('RecoveryExists(bytes32)'), 'one finding per successor per escrow');
    await assert.rejects(() => ctx.court.send('openRecovery', [rid(9), CHAIN_ID, sid(5), ESCROW, ONE, ONE]), refused('SuccessorNotAdmitted(uint256,bytes32)'));
    await assert.rejects(() => ctx.court.send('openRecovery', [rid(9), CHAIN_ID, '0x' + '00'.repeat(32), ESCROW, ONE, ONE]), refused('SuccessorNotAdmitted(uint256,bytes32)'));
  });

  test('R-2: a later successor\'s finding waits behind an earlier one, and a finding of none releases it (applicableRealisations)', async (t) => {
    if (needModel(t)) return;
    const ctx = await settled();
    for (let i = 1; i <= 3; i++) await ctx.params.send('admitSuccessor', [CHAIN_ID, sid(i)]);
    const [P] = await residual(ctx);
    // The third realises first: recorded, not applied.
    let res = await ctx.court.send('openRecovery', [rid(3), CHAIN_ID, sid(3), ESCROW, 9n * ONE, 100n * ONE]);
    assert.equal(ctx.s.events(res, 'RecoveryFound').length, 1);
    assert.equal(ctx.s.events(res, 'RecoveryOpened').length, 0, 'waits for the first and the second');
    assert.deepEqual(M.ark.applicableRealisations([null, null, 9n * ONE]), []);
    await assert.rejects(() => ctx.r.send('claimPositionRecovery', [rid(3), ctx.pos[0].id, DEST], { from: HOLDER }), /RecoveryWaiting/);
    // The second arrives: still behind the first.
    res = await ctx.court.send('openRecovery', [rid(2), CHAIN_ID, sid(2), ESCROW, 1n * ONE, 100n * ONE]);
    assert.equal(ctx.s.events(res, 'RecoveryOpened').length, 0);
    await ctx.r.send('applyRecoveries', [CHAIN_ID, ESCROW], { from: ACCOUNTS.mallory });
    assert.equal((await residual(ctx))[0], P, 'nothing applied by anyone before the first');
    // The court finds the first does not realise the escrow: R = 0 releases both, in admission order.
    res = await ctx.court.send('openRecovery', [rid(1), CHAIN_ID, sid(1), ESCROW, 0n, 0n]);
    const opened = ctx.s.events(res, 'RecoveryOpened');
    assert.deepEqual(opened.map((e) => e.args.recoveryId), [rid(1), rid(2), rid(3)]);
    const applied = M.ark.applicableRealisations([0n, 1n * ONE, 9n * ONE]);
    const shares = M.ark.sequentialRecovery(applied, P);
    for (let i = 0; i < 3; i++) {
      assert.equal(opened[i].args.toSenior + opened[i].args.toJunior, shares[i].bond, `slot ${i + 1}: the bond's share in admission order`);
      assert.equal(opened[i].args.toPositions, shares[i].anchored);
    }
    // The order of realisation never reordered the residual: the second took from P first.
    assert.equal(opened[1].args.toSenior + opened[1].args.toJunior, 1n * ONE);
    const r = await ctx.r.send('claimPositionRecovery', [rid(3), ctx.pos[0].id, DEST], { from: HOLDER });
    assert.equal(ctx.s.events(r, 'RecoveryLeafSealed')[0].args.quantity, shares[2].anchored);
  });

  test('R-3: each escrow keeps its own P and residual; a realisation of one never repays what the bond paid another (escrowRecoveryLedger)', async (t) => {
    if (needModel(t)) return;
    const ctx = await book({ term: TERM.YEAR, vested: false, positions: [{ owner: HOLDER, notional: 60n * ONE }] });
    const b = await F.anchor(ctx, { owner: OTHER, depositor: OTHER, nonce: 5n, notional: 40n * ONE, asset: F.ASSET_B, escrow: ESCROW_B });
    ctx.chain.advanceTime(91 * DAY);
    const at = BigInt(ctx.chain.timestamp);
    await F.declare(ctx, at);
    await ctx.params.send('admitSuccessor', [CHAIN_ID, sid(1)]);
    await ctx.r.send('recordClaimants', [[ctx.pos[0].id, b.id]]);
    await ctx.s.send('settleDeclaration');
    const t2 = await ctx.s.call('declaration');
    F.toEpoch(ctx, t2.epoch + 4n);
    await ctx.oracle.send('set', [9000n * PRICE, 9000n * PRICE, 9000n * PRICE]);
    await ctx.s.send('settleSeverity');

    const d = await ctx.s.call('declaration');
    const draws = { junior: (d.drawnByClass[0] * PRICE) / d.price, senior: (d.drawnByClass[1] * PRICE) / d.price };
    const wA = await weightAt(ctx, ctx.pos[0].id, at);
    const wB = await weightAt(ctx, b.id, at);
    const incA = M.ark.trigger2EscrowDraws(draws, wA, d.weight);
    const incB = M.ark.trigger2EscrowDraws(draws, wB, d.weight);
    const la = await ctx.r.call('escrowLedger', [CHAIN_ID, ESCROW]);
    const lb = await ctx.r.call('escrowLedger', [CHAIN_ID, ESCROW_B]);
    assert.equal(la.paid, incA.junior + incA.senior, 'P of escrow A: its vested weight over W of the draw');
    assert.equal(lb.paid, incB.junior + incB.senior);
    assert.ok(la.paid + lb.paid <= draws.junior + draws.senior, 'the parts never exceed the draw');

    // Escrow B realises far more than B's P: the rest is B's positions', and A's residual stands.
    const R = 100n * ONE;
    const res = await ctx.court.send('openRecovery', [rid(1), CHAIN_ID, sid(1), ESCROW_B, R, 40n * ONE]);
    const [ev] = ctx.s.events(res, 'RecoveryOpened');
    const ledger = M.ark.escrowRecoveryLedger([
      { kind: 'draw', escrow: 'A', draws: incA },
      { kind: 'draw', escrow: 'B', draws: incB },
      { kind: 'realised', escrow: 'B', recovered: R },
    ]);
    const stepB = ledger[2];
    assert.equal(ev.args.toSenior + ev.args.toJunior, stepB.allocation.bond, 'the bond takes only what it paid B');
    assert.equal(ev.args.toPositions, stepB.allocation.anchored);
    assert.equal(ev.args.residualAfter, stepB.residual);
    const [remA] = await ctx.r.call('recoveryResidual', [CHAIN_ID, ESCROW]);
    assert.equal(remA, ledger[0].residual, 'escrow A\'s residual untouched by B\'s realisation');
    // B's positions divide their part over B's claimants' recorded principal.
    const r = await ctx.r.send('claimPositionRecovery', [rid(1), b.id, DEST], { from: OTHER });
    assert.equal(ctx.s.events(r, 'RecoveryLeafSealed')[0].args.quantity, stepB.allocation.anchored);
    await assert.rejects(() => ctx.r.send('claimPositionRecovery', [rid(1), ctx.pos[0].id, DEST], { from: HOLDER }), /NotClaimant/, 'A\'s position is not on B');
  });

  test('one successor and one recovery: every holder and position is sealed its share leaf, once', async (t) => {
    if (needModel(t)) return;
    const ctx = await settled();
    await ctx.params.send('admitSuccessor', [CHAIN_ID, sid(1)]);
    const res = await ctx.court.send('openRecovery', [rid(1), CHAIN_ID, sid(1), ESCROW, 10n * ONE, 100n * ONE]);
    const [ev] = ctx.s.events(res, 'RecoveryOpened');
    // Junior paid the whole floor draw: its holding recovers it all.
    const r1 = await ctx.r.send('claimRecovery', [rid(1), ctx.junior, DEST], { from: HOLDER });
    const [leafEv] = ctx.s.events(r1, 'RecoveryLeafSealed');
    const recipient = '0x' + BigInt(ctx.junior).toString(16).padStart(64, '0');
    assert.equal(leafEv.args.quantity, ev.args.toJunior);
    assert.equal(leafEv.args.leaf, ids.shareLeaf({ chainId: CHAIN_ID, escrow: ESCROW, successorId: sid(1), recoveryId: rid(1), recipient, destination: DEST, quantity: ev.args.toJunior }));
    await assert.rejects(() => ctx.r.send('claimRecovery', [rid(1), ctx.junior, DEST], { from: HOLDER }), /AlreadyClaimed/);
    await assert.rejects(() => ctx.r.send('claimRecovery', [rid(1), ctx.senior, DEST], { from: OTHER }), /NotClaimant/);
    const r2 = await ctx.r.send('claimPositionRecovery', [rid(1), ctx.pos[0].id, DEST], { from: HOLDER });
    assert.equal(ctx.s.events(r2, 'RecoveryLeafSealed')[0].args.quantity, ev.args.toPositions);
    await assert.rejects(() => ctx.r.send('claimPositionRecovery', [rid(1), ctx.pos[0].id, '0x' + '00'.repeat(20)], { from: HOLDER }), /DestinationNotOriginAddress/);
  });

  test('a holding that redeemed what the draw left keeps its claim on the recovery (holding of record)', async () => {
    const ctx = await settled();
    const m = (await ctx.bond.call('holdingOf', [ctx.junior])).maturityEpoch;
    F.toEpoch(ctx, m + 1n);
    await F.distributeDue(ctx);
    await ctx.bond.send('redeem', [ctx.junior], { from: HOLDER });
    const h = await ctx.bond.call('holdingOf', [ctx.junior]);
    assert.equal(h.declFixed, true);
    assert.ok(h.declShares > 0n && h.shares === 0n);
    await ctx.params.send('admitSuccessor', [CHAIN_ID, sid(1)]);
    const res = await ctx.court.send('openRecovery', [rid(1), CHAIN_ID, sid(1), ESCROW, 10n * ONE, 100n * ONE]);
    const [ev] = ctx.s.events(res, 'RecoveryOpened');
    const r = await ctx.r.send('claimRecovery', [rid(1), ctx.junior, DEST], { from: HOLDER });
    assert.equal(ctx.s.events(r, 'RecoveryLeafSealed')[0].args.quantity, ev.args.toJunior);
  });

  test('a recovery opened with a hold standing recovers the drawn part; the held draw raises that escrow\'s P_rem by exactly its part', async () => {
    const ctx = await declared();
    await open2(ctx);
    const t2 = await ctx.s.call('declaration');
    F.toEpoch(ctx, t2.epoch + 4n);
    await ctx.oracle.send('setReverting', [true]);
    await ctx.s.send('settleSeverity');
    for (let i = 1; i <= 2; i++) await ctx.params.send('admitSuccessor', [CHAIN_ID, sid(i)]);

    const [P0] = await residual(ctx);
    assert.equal(P0, 6n * ONE, 'the held balance is not part of P while held');
    // More is realised than the floor draw paid: the bond takes P_rem, the positions the rest.
    let res = await ctx.court.send('openRecovery', [rid(1), CHAIN_ID, sid(1), ESCROW, 8n * ONE, 100n * ONE]);
    let [ev] = ctx.s.events(res, 'RecoveryOpened');
    assert.equal(ev.args.residualAfter, 0n);
    assert.equal(ev.args.toPositions, 2n * ONE);

    await ctx.oracle.send('setReverting', [false]);
    await ctx.oracle.send('set', [2000n * PRICE, 2000n * PRICE, 2000n * PRICE]); // m_loss 8,000: 2,000 bps more
    res = await ctx.s.send('settleSeverity');
    const [drawn] = ctx.s.events(res, 'Trigger2Drawn');
    const [P1] = await residual(ctx);
    assert.equal(P1, (drawn.args.drawQrl * PRICE) / REF_PRICE, 'P_rem rose by exactly the held draw (one escrow: all of it)');
    res = await ctx.court.send('openRecovery', [rid(2), CHAIN_ID, sid(2), ESCROW, 5n * ONE, 100n * ONE]);
    [ev] = ctx.s.events(res, 'RecoveryOpened');
    assert.equal(ev.args.toSenior + ev.args.toJunior, P1, 'a later successor recovers against the raised residual');
  });

  test('a held balance released rather than drawn never enters P', async () => {
    const ctx = await declared();
    await open2(ctx);
    const t2 = await ctx.s.call('declaration');
    F.toEpoch(ctx, t2.epoch + 4n);
    await ctx.oracle.send('setReverting', [true]);
    await ctx.s.send('settleSeverity');
    await ctx.oracle.send('setReverting', [false]);
    await ctx.oracle.send('set', [9500n * PRICE, 9500n * PRICE, 9500n * PRICE]); // m_loss 500: D_total = D_0
    await ctx.s.send('settleSeverity');
    const [P] = await residual(ctx);
    assert.equal(P, 6n * ONE);
  });

  test('a recovery opens only after the trigger-2 settlement it subrogates', async () => {
    const ctx = await declared();
    await ctx.params.send('admitSuccessor', [CHAIN_ID, sid(1)]);
    await assert.rejects(() => ctx.court.send('openRecovery', [rid(1), CHAIN_ID, sid(1), ESCROW, ONE, ONE]), refused('NothingToSubrogate()'));
    await open2(ctx);
    await assert.rejects(() => ctx.court.send('openRecovery', [rid(1), CHAIN_ID, sid(1), ESCROW, ONE, ONE]), refused('NothingToSubrogate()'));
  });
});

/* ------------------------------------------------------------------ */
/* The objection source                                                */
/* ------------------------------------------------------------------ */

describe('the objection source counts principal at the boundary that opened an epoch (core IObjectionSource, GD6)', () => {
  test('a subscription, a transfer and a draw count from the next boundary, never inside the epoch they happen in', async () => {
    const ctx = await book({ vested: false, vestFirst: true });
    // Core's IObjectionSource, implemented by the bond itself.
    const src = ctx.bond;
    const e0 = epochNow(ctx);
    // Nothing stood at the boundary that opened this epoch.
    assert.equal(await src.call('principalAt', [HOLDER, e0]), 0n);
    assert.equal(await src.call('totalPrincipalAt', [e0]), 0n);
    assert.equal(await src.call('principalAt', [HOLDER, e0 + 1n]), 70_000n * ONE);
    assert.equal(await src.call('principalAt', [OTHER, e0 + 1n]), 30_000n * ONE);
    assert.equal(await src.call('totalPrincipalAt', [e0 + 1n]), 100_000n * ONE);

    F.toNextEpoch(ctx);
    await F.distributeDue(ctx);
    const h = await ctx.bond.call('holdingOf', [ctx.junior]);
    await ctx.bond.send('transferHolding', [ctx.junior, OTHER, h.shares / 2n], { from: HOLDER });
    const e1 = epochNow(ctx);
    assert.equal(await src.call('principalAt', [HOLDER, e1]), 70_000n * ONE, 'the transfer is inside the epoch');
    assert.equal(await src.call('principalAt', [HOLDER, e1 + 1n]), 35_000n * ONE);
    assert.equal(await src.call('principalAt', [OTHER, e1 + 1n]), 65_000n * ONE);
    assert.equal(
      (await src.call('principalAt', [HOLDER, e1 + 1n])) + (await src.call('principalAt', [OTHER, e1 + 1n])),
      await src.call('totalPrincipalAt', [e1 + 1n]),
      'counted once',
    );

    // A draw reprices every holder at the next boundary.
    await F.declare(ctx, BigInt(ctx.chain.timestamp));
    await open2(ctx);
    assert.equal(await src.call('totalPrincipalAt', [e1 + 1n]), 40_000n * ONE);
    assert.equal(await src.call('principalAt', [OTHER, e1 + 1n]), 5_000n * ONE + 30_000n * ONE);
  });
});

/* ------------------------------------------------------------------ */
/* The admitted terms and G8                                           */
/* ------------------------------------------------------------------ */

describe('the admitted bond terms are a governed mask per phase; withdrawing one shortens nothing (whitepaper §6.3; item 129)', () => {
  test('a term whose bit is clear is refused from the boundary the vote takes effect at; holdings keep their maturity', async () => {
    const ctx = await F.deployBondStack();
    const id = await F.subscribe(ctx, { term: TERM.THREE_YEAR, value: ONE });
    const m = (await ctx.bond.call('holdingOf', [id])).maturityEpoch;
    // The cell of phase 0, the phase in force.
    await F.voteParams(ctx.params, { 'admittedTermsMask@0': 3 });
    await F.subscribe(ctx, { term: TERM.THREE_YEAR, value: ONE }); // still this epoch's set
    F.toNextEpoch(ctx);
    await assert.rejects(() => F.subscribe(ctx, { term: TERM.THREE_YEAR, value: ONE }), /TermNotAdmitted/);
    await F.subscribe(ctx, { term: TERM.QUARTER, value: ONE });
    assert.equal((await ctx.bond.call('holdingOf', [id])).maturityEpoch, m, 'no holding already issued is shortened');
    assert.equal(await ctx.params.call('admittedTermsMask'), 3n);
  });

  test('a mask clearing every bit is refused but in Q-Day\'s row; one naming a term outside the set is refused in every row', async () => {
    const ctx = await F.deployBondStack();
    for (const ph of [0, 1, 2, 4]) {
      await assert.rejects(() => F.voteParams(ctx.params, { [`admittedTermsMask@${ph}`]: 0 }), /ParameterOutOfRange/, `phase ${ph}`);
    }
    for (const ph of [0, 1, 2, 3, 4]) {
      await assert.rejects(() => F.voteParams(ctx.params, { [`admittedTermsMask@${ph}`]: 8 }), /ParameterOutOfRange/, `phase ${ph}`);
    }
    // Phase 3 admits no new principal at the reference rows: settlement only.
    await F.voteParams(ctx.params, { 'admittedTermsMask@3': 0 });
  });
});

describe('G8: the run-off gate reads the parameters in force in the epoch it observes', () => {
  test('a vote on the run-off bound staged in e is not applied to the close of e', async () => {
    const ctx = await F.deployBondStack({ stage: 4 });
    const e = epochNow(ctx);
    // A quarter-range step (the bound is a value-transfer key since
    // 2026-09-30): relation 9 at 1,750 drains in six epochs, BPS - 5 x 1,500
    // is the 2,500 floor.
    await F.voteParams(ctx.params, { runoffBoundBps: 1750 });
    const inE = await ctx.params.call('runoffParamsAt', [e]);
    const next = await ctx.params.call('runoffParamsAt', [e + 1n]);
    assert.equal(inE[1], 2000n, 'the bound in force in e');
    assert.equal(next[1], 1750n, 'the bound from e + 1');
    assert.equal(inE[2], 4n);
    F.toNextEpoch(ctx);
    // Read from e + 1, e still answers the bound it closed under (G8).
    assert.equal((await ctx.params.call('runoffParamsAt', [e]))[1], 2000n);
  });

  test('the stage in force in a past epoch survives the vote that moved it', async () => {
    // The band of phase 2, then the phase (item 129), each from the next boundary.
    const ctx = await F.deployBondStack({ stage: 2 });
    const e = epochNow(ctx);
    await ctx.params.send('setThreatStage', [2, 3]);
    F.toNextEpoch(ctx);
    const ph = ctx.params.phase;
    await ph.send('setPending', [3, e + 2n], { from: ph.operatorAccount });
    assert.equal((await ctx.params.call('runoffParamsAt', [e]))[2], 2n);
    assert.equal((await ctx.params.call('runoffParamsAt', [e + 1n]))[2], 3n);
    assert.equal((await ctx.params.call('runoffParamsAt', [e + 2n]))[2], 4n);
    F.toNextEpoch(ctx);
    assert.equal((await ctx.params.call('runoffParamsAt', [e]))[2], 2n, 'read from inside Q-Day, e keeps its stage');
    assert.equal((await ctx.params.call('runoffParamsAt', [e + 1n]))[2], 3n);
  });
});

/* ------------------------------------------------------------------ */
/* The run-off queue's decaying exposure (gap item 24)                 */
/* ------------------------------------------------------------------ */

describe('queued principal carries a decaying exposure, on a clock the first signal stops (whitepaper §5.3, I26′)', () => {
  /** A quarter holding queued at its maturity behind a gate the fourth stage closed, and a year holding beside it. */
  async function queuedBook() {
    const ctx = await F.deployBondStack({ stage: 4 });
    ctx.s = ctx.chain.at('ArkCatBondSettlement', ctx.bond.address);
    ctx.q = await F.subscribe(ctx, { from: HOLDER, class_: CLASS.JUNIOR, term: TERM.QUARTER, value: 1000n * ONE });
    ctx.y = await F.subscribe(ctx, { from: OTHER, class_: CLASS.JUNIOR, term: TERM.YEAR, value: 1000n * ONE });
    ctx.m = (await ctx.bond.call('holdingOf', [ctx.q])).maturityEpoch;
    F.toEpoch(ctx, ctx.m + 1n);
    await F.distributeDue(ctx);
    return ctx;
  }
  const exposure = async (ctx) => {
    const r = await ctx.s.call('queueExposure');
    return { clock: r[0], queued: r[1], weighted: r[3] };
  };

  test('each clean epoch lowers the weight by the decay, to the floor, and the capital requirement reads it', async (t) => {
    if (needModel(t)) return;
    const ctx = await queuedBook();
    const start = await exposure(ctx);
    assert.ok(start.queued > 0n, 'the quarter holding is in the queue');
    assert.equal(start.weighted, start.queued, 'a clean age of zero weighs the whole');
    for (let age = 1; age <= 7; age++) {
      F.toNextEpoch(ctx);
      await F.distributeDue(ctx);
      const x = await exposure(ctx);
      assert.equal(x.clock, start.clock + BigInt(age), 'the clock advances once per clean epoch');
      const w = BigInt(M.ark.queueExposureBps(M.params, age));
      assert.equal(x.weighted, (x.queued * w + BPS - 1n) / BPS, `weight at age ${age} is the model's queueExposureBps (${w})`);
      // The registry reads the queue at its weight (I26′).
      const s = await ctx.bond.call('state');
      const face = s.juniorPrincipal + s.seniorPrincipal;
      const queuedWorth = (x.queued * s.juniorPrincipal) / s.juniorShares;
      const weightedWorth = (x.weighted * s.juniorPrincipal) / s.juniorShares;
      const out = await ctx.bond.call('outstandingPrincipal');
      assert.ok(out <= face - queuedWorth + weightedWorth + 1n && out + 1n >= face - queuedWorth + weightedWorth);
      if (x.queued === 0n) break;
    }
  });

  test('the clock stands still under the protective freeze and under an open determination', async () => {
    const ctx = await queuedBook();
    const c0 = (await exposure(ctx)).clock;
    await ctx.qday.send('setFrozen', [true]);
    F.toNextEpoch(ctx);
    await ctx.bond.send('closeEpoch');
    assert.equal((await exposure(ctx)).clock, c0, 'an epoch closed under the freeze does not age the queue');
    await ctx.qday.send('setFrozen', [false]);
    await ctx.court.send('open', [det(77)]);
    F.toNextEpoch(ctx);
    await ctx.bond.send('closeEpoch');
    assert.equal((await exposure(ctx)).clock, c0, 'nor one with a determination open');
    await ctx.court.send('close', [det(77)]);
    F.toNextEpoch(ctx);
    await ctx.bond.send('closeEpoch');
    assert.equal((await exposure(ctx)).clock, c0, 'nor the epoch the determination closed in');
    F.toNextEpoch(ctx);
    await ctx.bond.send('closeEpoch');
    assert.equal((await exposure(ctx)).clock, c0 + 1n, 'a clean epoch ages it again');
  });

  test('queued principal earns the coupon at the same weight its draw is taken at', async () => {
    const ctx = await queuedBook();
    // The epoch after the next: the queued cohort's clean age is one there.
    const e = epochNow(ctx) + 1n;
    await F.deliverAndDistribute(ctx, e, 50n * ONE);
    const base = await ctx.coupon.call('baseAt', [e]);
    const hq = await ctx.bond.call('holdingOf', [ctx.q]);
    const hy = await ctx.bond.call('holdingOf', [ctx.y]);
    // Counted at 8,500 bps in the base (rounded up).
    const weighted = (hq.shares * 8500n + BPS - 1n) / BPS;
    assert.equal(base[0], hy.shares + weighted, 'the base counts the queued shares at their weight');
    const before = [await ctx.coupon.call('owed', [CLASS.JUNIOR, hy.claimedThrough, hy.shares])];
    const ry = await ctx.bond.send('claim', [ctx.y], { from: OTHER });
    const rq = await ctx.bond.send('claim', [ctx.q], { from: HOLDER });
    const cy = ctx.bond.events(ry, 'Claimed')[0].args.coupon;
    const cq = ctx.bond.events(rq, 'Claimed')[0].args.coupon;
    assert.ok(cy > 0n && cq > 0n);
    assert.equal(before[0], cy);
    // Per share, the queued holding is paid 8,500/10,000 of the other's (truncation aside).
    const perY = (cy * ONE) / hy.shares;
    const perQ = (cq * ONE) / hq.shares;
    const expected = (perY * 8500n) / BPS;
    assert.ok(perQ <= expected + 2n && perQ + 2n >= expected, `queued ${perQ} against ${expected}`);
    assert.ok(cy + cq <= 50n * ONE, 'the two draw no more than the proceeds (I19)');
  });
});

describe('a trigger draw reaches queued principal at its weight, and the class bears the rest (whitepaper §5.3, I26′)', () => {
  test('trigger 2 on a queued holding: the class falls at the rate on its exposure, the queued holding is paid back (BPS - x) of it', async (t) => {
    if (needModel(t)) return;
    const ctx = await F.deployBondStack({ stage: 4 });
    ctx.s = ctx.chain.at('ArkCatBondSettlement', ctx.bond.address);
    ctx.r = ctx.chain.at('ArkCatBondRecovery', ctx.bond.address);
    // One unit anchored and vested (10,000 QRL): the full settlement is the whole weighted pool.
    // Anchored now, it is fully vested by the declaration fifteen epochs on.
    const book1 = await F.anchor(ctx, { notional: ONE });
    ctx.pos = [{ id: book1.id }];
    const q = await F.subscribe(ctx, { from: HOLDER, class_: CLASS.JUNIOR, term: TERM.QUARTER, value: 1000n * ONE });
    const y = await F.subscribe(ctx, { from: OTHER, class_: CLASS.JUNIOR, term: TERM.YEAR, value: 1000n * ONE });
    const m = (await ctx.bond.call('holdingOf', [q])).maturityEpoch;
    F.toEpoch(ctx, m + 1n);
    await F.distributeDue(ctx);
    // Two clean epochs in the queue: weight 7,000.
    for (let i = 0; i < 2; i++) {
      F.toNextEpoch(ctx);
      await F.distributeDue(ctx);
    }
    const age = 2;
    const x = BigInt(M.ark.queueExposureBps(M.params, age));
    assert.equal(x, 7000n);
    const exposure = await ctx.bond.call('outstandingPrincipal');
    assert.equal(exposure, 1000n * ONE + (1000n * ONE * x) / BPS, 'the pool counts the queued holding at its weight');

    await F.declare(ctx, BigInt(ctx.chain.timestamp));
    await open2(ctx);
    const t2 = await ctx.s.call('declaration');
    const d = (exposure * 6000n) / BPS;
    assert.equal(t2.drawn, d, 'D_0 of the weighted pool');
    // Each unit of exposure bears d / E: the year holding its whole value's share.
    const yWorth = await ctx.bond.call('principalOf', [y]);
    const yLoss = 1000n * ONE - yWorth;
    const rate = (d * ONE) / exposure;
    assert.ok(yLoss - (1000n * ONE * rate) / ONE <= 2n * ONE / 1000n, `the non-queued holding bears the rate in full: ${yLoss}`);

    F.toEpoch(ctx, t2.epoch + 4n);
    await ctx.s.send('settleSeverity');
    await F.distributeDue(ctx);
    const res = await ctx.bond.send('claimQueued', [q], { from: HOLDER });
    const [relief] = ctx.bond.events(res, 'ReliefPaid');
    // Owed back: the uniform fall of the class, times (BPS - x), on its shares.
    const expected = (1000n * ONE * rate * (BPS - x)) / (ONE * BPS);
    assert.ok(relief, 'the queued holding is paid its relief with its queue draw');
    const diff = relief.args.amount > expected ? relief.args.amount - expected : expected - relief.args.amount;
    assert.ok(diff <= 2n * ONE / 1000n, `relief ${relief.args.amount} against ${expected}`);
    // So what the queued holding lost is the rate times its weight.
    const qLoss = 1000n * ONE - (await ctx.bond.call('principalOf', [q])) - relief.args.amount - ctx.bond.events(res, 'Redeemed')[0].args.amount;
    const want = (1000n * ONE * rate * x) / (ONE * BPS);
    const diff2 = qLoss > want ? qLoss - want : want - qLoss;
    assert.ok(diff2 <= 2n * ONE / 1000n, `queued loss ${qLoss} against ${want}`);
    // Taken once.
    await F.distributeDue(ctx);
  });
});

describe('the settlement entitlement is paid from principal not deployed, then as exits return it (yellow paper §1.4)', () => {
  test('a determination the buffer meets whole draws nothing from the bond and owes nothing there', async () => {
    const ctx = await book({ buffer: 20n * ONE });
    const pos = ctx.pos[0];
    const before = await classes(ctx);
    const res = await determine(ctx, det(31), [{ id: pos.id, loss: 5n * ONE }]);
    const [ev] = ctx.s.events(res, 'LossDetermined');
    assert.equal(ev.args.drawQrl, 0n);
    assert.ok(ev.args.bufferUnits > 0n);
    assert.deepEqual(await classes(ctx), before, 'no principal drawn');
    F.toNextEpoch(ctx);
    await assert.rejects(() => ctx.s.send('claimSettlement', [det(31), pos.id], { from: HOLDER }), /NothingDue/);
  });

  test('pro rata within a determination while principal is at staking, and the rest once an exit returns it', async () => {
    const ctx = await book({
      buffer: 2n * ONE,
      positions: [{ owner: HOLDER, notional: 100n * ONE }, { owner: OTHER, notional: 300n * ONE }],
    });
    const [a, b] = ctx.pos;
    // Nine tenths of the pool at staking before the determination.
    await ctx.bond.send('placeWithStaking', [90_000n * ONE]);
    await determine(ctx, det(32), [{ id: a.id, loss: 40n * ONE }, { id: b.id, loss: 120n * ONE }]);
    const pa = BigInt((await ctx.s.call('lossPartOf', [det(32), a.id])).qrl);
    const pb = BigInt((await ctx.s.call('lossPartOf', [det(32), b.id])).qrl);
    const total = pa + pb;
    assert.ok(total > 10_000n * ONE, 'the bond owes more than it holds undeployed');
    assert.ok((await ctx.bond.call('principalOwedNow')) >= total, 'the entitlements count as owed, so an exit is asked for them');
    F.toNextEpoch(ctx);
    const r1 = await ctx.s.send('claimSettlement', [det(32), a.id], { from: HOLDER });
    const got1 = ctx.s.events(r1, 'SettlementClaimed')[0].args.amount;
    const [s1] = await ctx.s.call('settlementOf', [det(32)]);
    const served = (await ctx.s.call('settlementOf', [det(32)]))[1];
    assert.ok(served < total, 'only what is undeployed is paid now');
    assert.equal(got1, (served * pa) / total, 'pro rata within the determination');
    // The exit: principal comes home from staking, and the rest is paid.
    const res = await ctx.staking.send('recall', [100_000n * ONE]);
    const [ev] = ctx.staking.events(res, 'Requested');
    await ctx.staking.send('claim', [ev.args.requestId]);
    const r2 = await ctx.s.send('claimSettlement', [det(32), a.id], { from: HOLDER });
    assert.equal(got1 + ctx.s.events(r2, 'SettlementClaimed')[0].args.amount, pa, 'paid in full once principal returned');
    const r3 = await ctx.s.send('claimSettlement', [det(32), b.id], { from: OTHER });
    assert.equal(ctx.s.events(r3, 'SettlementClaimed')[0].args.amount, pb);
    assert.equal(s1.kind, 1n);
  });
});

describe('a held balance stays deployed and earns the staking distribution, outside the coupon base (item 81 defaults)', () => {
  test('a staking distribution during the hold reaches the held classes; the base of an epoch closed while held leaves the balance out', async () => {
    const ctx = await declared();
    await open2(ctx);
    const t2 = await ctx.s.call('declaration');
    F.toEpoch(ctx, t2.epoch + 4n);
    await ctx.oracle.send('setReverting', [true]);
    await ctx.s.send('settleSeverity');
    const held = await ctx.s.call('declaration');
    assert.equal(held.stage, 2n);
    await F.stakingDistribution(ctx, 100n * ONE);
    F.toNextEpoch(ctx);
    await F.distributeDue(ctx);
    const r = await ctx.bond.send('claim', [ctx.senior], { from: OTHER });
    assert.ok(ctx.bond.events(r, 'Claimed')[0].args.principalAndDistribution > 0n, 'held principal earns its distribution for its holders');
    const e = epochNow(ctx) - 1n;
    const base = await ctx.coupon.call('baseAt', [e]);
    const s = await ctx.bond.call('state');
    assert.ok(base[1] < s.juniorPrincipal + s.seniorPrincipal, 'the held balance is outside the coupon base');
  });
});
