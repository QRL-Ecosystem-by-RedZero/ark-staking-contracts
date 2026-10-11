/**
 * The Cushion of the catastrophe bond (yellow paper §4.5, §5.3; technical
 * reference §1.7, §3.2; I42), end to end on the harness.
 *
 * The one rule this file defends, I42: **the Cushion is credited only by a
 * deposit on the cushion lane, which confers no claim, share, vote or refund,
 * and is debited only by a draw of trigger 1 or of trigger 2 other than on the
 * censorship ground, taken before any principal of the classes, and by the
 * residual draw that closes it after a declaration.** No coupon, maturity,
 * release, staking, governance or recovery path reaches it, and the balance
 * covers it beside every other pot. Every figure is held to the model
 * (`ark-staking.ts`): `layerDrawsOnPrincipal`, `seniorSubscriptionAdmissible`,
 * `cushionRoom`, `cushionShortfall`, `cushionResidualDraw`.
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { keccak256, toUtf8Bytes, AbiCoder } = require('ethers');
const { createAddressFromString, hexToBytes, bytesToHex } = require('@ethereumjs/util');
const F = require('./stake-fixture');
const { loadModel, MISSING } = require('./spec-model');

const { ACCOUNTS, ONE, EPOCH, BPS, TERM, CLASS, CHAIN_ID, ESCROW, ASSET_A, REF_PRICE, PRICE_SCALE } = F;
const HOLDER = ACCOUNTS.alice;
const OTHER = ACCOUNTS.bob;
const DONOR = ACCOUNTS.mallory;
const DAY = 24 * 3600;
const coder = AbiCoder.defaultAbiCoder();

const CUSHION = keccak256(toUtf8Bytes('quantumark.lane.cushion.v1'));
const TREASURY_LANE = keccak256(toUtf8Bytes('quantumark.lane.treasury.staking.v1'));
const T2_FLOOR = keccak256(toUtf8Bytes('ARK_T2_FLOOR'));
const T2_BALANCE = keccak256(toUtf8Bytes('ARK_T2_BALANCE'));
const T2_REMAINDER = keccak256(toUtf8Bytes('ARK_T2_REMAINDER'));
const T2_CUSHION = keccak256(toUtf8Bytes('ARK_T2_CUSHION'));
const REF = '0x' + '0e'.repeat(32);
const C_MAX = 1500n;
const C_TGT = 500n;

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

const det = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const epochNow = (ctx) => BigInt(ctx.chain.timestamp) / BigInt(EPOCH);
const min = (a, b) => (a < b ? a : b);

/** A book as the settlement suite builds it: positions anchored, junior and senior subscribed. */
async function book({
  junior = 70_000n * ONE,
  senior = 30_000n * ONE,
  positions = [{ owner: HOLDER, notional: 100n * ONE }],
  term = TERM.YEAR,
  vested = true,
  vestFirst = false,
} = {}) {
  const ctx = await F.deployBondStack();
  ctx.s = ctx.chain.at('ArkCatBondSettlement', ctx.bond.address);
  ctx.r = ctx.chain.at('ArkCatBondRecovery', ctx.bond.address);
  ctx.pos = [];
  let nonce = 0n;
  for (const p of positions) {
    ctx.pos.push({ ...(await F.anchor(ctx, { owner: p.owner, depositor: p.owner, nonce: nonce++, notional: p.notional })), ...p });
  }
  if (vestFirst) ctx.chain.advanceTime(91 * DAY);
  ctx.junior = junior === 0n ? null : await F.subscribe(ctx, { from: HOLDER, class_: CLASS.JUNIOR, term, value: junior });
  ctx.senior = senior === 0n ? null : await F.subscribe(ctx, { from: OTHER, class_: CLASS.SENIOR, term, value: senior });
  if (vested) ctx.chain.advanceTime(91 * DAY);
  return ctx;
}

const deposit = (ctx, value, { from = DONOR, lane = CUSHION } = {}) => ctx.bond.send('deposit', [lane, REF], { from, value });

async function classes(ctx) {
  const s = await ctx.bond.call('state');
  return { j: s.juniorPrincipal, s: s.seniorPrincipal };
}

async function determine(ctx, id, list) {
  await ctx.court.send('open', [id]);
  return ctx.court.send('determineLoss', [id, list.map((x) => x.id), list.map((x) => x.loss)]);
}

async function open2(ctx) {
  await ctx.r.send('recordClaimants', [ctx.pos.map((p) => p.id)], { from: ACCOUNTS.mallory });
  return ctx.s.send('settleDeclaration', [], { from: ACCOUNTS.mallory });
}

/** One word of the bond's storage. */
async function word(ctx, slot) {
  const v = await ctx.chain.vm.stateManager.getStorage(
    createAddressFromString(ctx.bond.address),
    hexToBytes('0x' + BigInt(slot).toString(16).padStart(64, '0')),
  );
  return v.length ? BigInt(bytesToHex(v)) : 0n;
}

/** What the balance must cover: the four pots and class principal (I21, I42). */
async function covered(ctx) {
  const s = await ctx.bond.call('state');
  const placed = await ctx.bond.call('placedWithStaking');
  const cushion = await ctx.bond.call('cushion');
  const bal = await ctx.chain.balanceOf(ctx.bond.address);
  return bal + placed >= s.juniorPrincipal + s.seniorPrincipal + s.freePool + s.principalOwed + cushion;
}

/* ------------------------------------------------------------------ */
/* The port: one credit path                                           */
/* ------------------------------------------------------------------ */

describe('I42 the cushion lane: the one credit path (technical reference §1.7, IArkFlow)', () => {
  test('I42 any account deposits on the cushion lane alone; zero, other lanes and a bare transfer are refused', async (t) => {
    if (needModel(t)) return;
    const ctx = await book();
    const info = await ctx.bond.call('laneInfo', [CUSHION]);
    const nominal = 100_000n * ONE;
    assert.deepEqual([info.declared, info.open, info.oneWay, info.defensive], [true, true, true, true]);
    assert.equal(info.room, M.ark.cushionRoom(0n, nominal, Number(C_MAX)), 'room = c_max * N_B - N_C');
    assert.equal(await ctx.bond.call('acceptsLane', [CUSHION]), true);
    const other = await ctx.bond.call('laneInfo', [TREASURY_LANE]);
    assert.equal(other.declared, false, 'the bond holds one lane');
    await assert.rejects(() => deposit(ctx, 0n), /ZeroDeposit/);
    await assert.rejects(() => deposit(ctx, ONE, { lane: TREASURY_LANE }), /LaneUnknown/);
    await assert.rejects(() => ctx.chain.execute(ctx.bond.address, DONOR, '0x', ONE), /ZeroValue/, 'a bare transfer names no lane');

    const res = await deposit(ctx, 1_000n * ONE);
    const [ev] = ctx.bond.events(res, 'Deposited');
    assert.equal(ev.args.lane, CUSHION);
    assert.equal(ev.args.from.toLowerCase(), DONOR.toLowerCase());
    assert.equal(ev.args.amount, 1_000n * ONE);
    assert.equal(ev.args.ref, REF);
    // Anyone: a bondholder too, and it buys nothing.
    await deposit(ctx, 500n * ONE, { from: HOLDER });
    assert.equal(await ctx.bond.call('cushion'), 1_500n * ONE);
    assert.equal(await ctx.bond.call('laneTotal', [CUSHION]), 1_500n * ONE);
    const s = await ctx.bond.call('state');
    assert.equal(s.juniorPrincipal + s.seniorPrincipal, nominal, 'no principal, share or claim is issued');
    assert.equal(await ctx.bond.call('outstandingPrincipal'), nominal);
    assert.ok(await covered(ctx));
  });

  test('I42 the ceiling: a deposit above room is refused and its sender keeps it; ArkFlowSend.push clamps to room', async (t) => {
    if (needModel(t)) return;
    const ctx = await book();
    const room = (C_MAX * 100_000n * ONE) / BPS;
    await deposit(ctx, 4_000n * ONE);
    const r = await ctx.bond.call('laneInfo', [CUSHION]);
    assert.equal(r.room, room - 4_000n * ONE);
    assert.equal(r.room, M.ark.cushionRoom(4_000n * ONE, 100_000n * ONE, Number(C_MAX)));
    await assert.rejects(() => deposit(ctx, r.room + 1n), /LaneRoomExceeded/);
    // The shortfall to the target: c_tgt * N_B - N_C, reported and acted on by nobody here.
    assert.equal(await ctx.bond.call('cushionShortfall'), M.ark.cushionShortfall(4_000n * ONE, 100_000n * ONE, Number(C_TGT)));
    assert.equal(await ctx.bond.call('cushionShortfall'), (C_TGT * 100_000n * ONE) / BPS - 4_000n * ONE);

    const sender = await ctx.chain.deploy('MockFlowSender');
    const res = await sender.send('push', [ctx.bond.address, CUSHION, REF], { from: DONOR, value: 20_000n * ONE });
    assert.equal(sender.events(res, 'Pushed')[0].args.sent, r.room, 'clamped to the room');
    assert.equal(await ctx.chain.balanceOf(sender.address), 20_000n * ONE - r.room, 'the sender keeps the rest');
    assert.equal(await ctx.bond.call('cushion'), room);
    assert.equal((await ctx.bond.call('laneInfo', [CUSHION])).room, 0n);
    assert.equal(await ctx.bond.call('acceptsLane', [CUSHION]), false);
    assert.equal(await ctx.bond.call('cushionShortfall'), 0n);
    const none = await sender.send('push', [ctx.bond.address, CUSHION, REF], { from: DONOR, value: ONE });
    assert.equal(sender.events(none, 'Pushed')[0].args.sent, 0n, 'a full Cushion takes nothing, and the push does not revert');
  });

  test('I42 an empty book has no room: a gift with no bond principal behind it is refused', async () => {
    const ctx = await book({ junior: 0n, senior: 0n });
    assert.equal((await ctx.bond.call('laneInfo', [CUSHION])).room, 0n);
    await assert.rejects(() => deposit(ctx, ONE), /LaneRoomExceeded/);
  });

  test('I42 Q-Day: the lane stays open through the freeze and the ratification (defensive)', async () => {
    const ctx = await book({ term: TERM.QUARTER, vested: false, vestFirst: true });
    await ctx.qday.send('setFrozen', [true]);
    await deposit(ctx, 1_000n * ONE);
    await assert.rejects(() => F.subscribe(ctx, { from: HOLDER, value: ONE }), /Frozen/, 'issuance closes, deposits do not');
    await ctx.qday.send('setFrozen', [false]);
    await F.declare(ctx, BigInt(ctx.chain.timestamp));
    await deposit(ctx, 1_000n * ONE);
    await open2(ctx);
    await deposit(ctx, ONE);
    assert.equal((await ctx.bond.call('laneInfo', [CUSHION])).open, true, 'open until the residual draw');
    assert.equal(await ctx.bond.call('laneTotal', [CUSHION]), 2_001n * ONE, 'the lifetime total keeps counting after a draw');
  });
});

/* ------------------------------------------------------------------ */
/* The storage layout                                                  */
/* ------------------------------------------------------------------ */

describe('the storage layout: the store is the prefix the modules share, the receiver after it', () => {
  test('I42 _laneTotal lies in the slot after the last of ArkCatBondStore, and the modules write the Cushion the bond reads', async (t) => {
    if (needModel(t)) return;
    const ctx = await book({ positions: [{ owner: HOLDER, notional: 100n * ONE }] });
    const x = 1_234n * ONE + 7n;
    await deposit(ctx, x);
    // ReentrancyGuard's `_status` is the first word of the store's layout.
    assert.equal(await word(ctx, 0), 1n, 'slot 0 is the shared guard, not entered');
    // `_cushion | _cushionCeilingBps << 128`: the last word the store declares.
    const packed = x + (C_MAX << 128n);
    const found = [];
    for (let slot = 0n; slot < 400n; slot++) if ((await word(ctx, slot)) === packed) found.push(slot);
    assert.equal(found.length, 1, 'the Cushion word is found once');
    const sC = found[0];
    // `ArkFlowReceiver._laneTotal`, a mapping: its slot p holds keccak256(lane, p).
    const lanes = [];
    for (let p = 0n; p < 400n; p++) {
      if ((await word(ctx, BigInt(keccak256(coder.encode(['bytes32', 'uint256'], [CUSHION, p]))))) === x) lanes.push(p);
    }
    assert.deepEqual(lanes, [sC + 1n], 'the receiver\'s mapping is the next slot after the store: inherited AFTER it');
    for (let slot = sC + 1n; slot < sC + 8n; slot++) assert.equal(await word(ctx, slot), 0n, `nothing past the store but a mapping head (${slot})`);
    // A module (Determinations, through the settlement module) debits the
    // same word the bond credited and reads.
    const before = await ctx.bond.call('cushion');
    const res = await determine(ctx, det(1), [{ id: ctx.pos[0].id, loss: 50n * ONE }]);
    const [cd] = ctx.s.events(res, 'CushionDrawn');
    assert.ok(cd && cd.args.amount > 0n);
    assert.equal(await ctx.bond.call('cushion'), before - cd.args.amount);
    assert.equal(await word(ctx, sC), before - cd.args.amount + (C_MAX << 128n));
  });
});

/* ------------------------------------------------------------------ */
/* The two debit paths: the draws, ahead of junior                     */
/* ------------------------------------------------------------------ */

describe('I42 the waterfall: the Cushion pays after the buffer and before junior and senior (yellow paper §4.5)', () => {
  test('I42 trigger 1: Cushion first, then junior; the capital available is unchanged; the Cushion part is paid at once', async (t) => {
    if (needModel(t)) return;
    const ctx = await book();
    const pos = ctx.pos[0];
    // Every unit of class principal goes to staking; the Cushion cannot be placed.
    const free = await ctx.bond.call('unencumbered');
    await deposit(ctx, 1_000n * ONE);
    assert.equal(await ctx.bond.call('unencumbered'), free, 'the Cushion is outside the balance principal may use');
    await assert.rejects(() => ctx.bond.send('placeWithStaking', [free + 1n]), /PrincipalNotLiquid/);
    await ctx.bond.send('placeWithStaking', [free]);
    const c0 = await ctx.bond.call('cushion');
    const before = await classes(ctx);
    const out = await ctx.bond.call('outstandingPrincipal');
    const required = await ctx.registry.call('requiredCapital');

    const res = await determine(ctx, det(1), [{ id: pos.id, loss: 50n * ONE }]);
    const [ev] = ctx.s.events(res, 'LossDetermined');
    const [cd] = ctx.s.events(res, 'CushionDrawn');
    const bondUnits = (out * PRICE_SCALE) / REF_PRICE;
    assert.equal(ev.args.available, min(bondUnits, required), 'buffer + min(N_B,orig, K): the Cushion adds nothing (I11)');
    assert.ok(ev.args.drawQrl > c0, 'a draw larger than the Cushion, so both layers are reached');
    const m = M.ark.layerDrawsOnPrincipal(ev.args.drawQrl, c0, before.j, before.s);
    assert.equal(cd.args.settlementId, det(1));
    assert.equal(cd.args.amount, m.cushion, 'the Cushion to the whole of its balance');
    assert.equal(ev.args.drawJunior, m.junior, 'then junior');
    assert.equal(ev.args.drawSenior, m.senior);
    assert.equal(ev.args.drawQrl, m.cushion + m.junior + m.senior, 'the three parts sum to the bond contribution');
    const after = await classes(ctx);
    assert.equal(before.j - after.j, m.junior);
    assert.equal(after.s, before.s, 'senior untouched');
    assert.equal(await ctx.bond.call('cushion'), 0n);
    assert.equal(await ctx.bond.call('laneTotal', [CUSHION]), 1_000n * ONE, 'the lifetime total is not a balance');
    // The Cushion's part is in the bond, so it is paid at once; the classes' part waits for exits.
    F.toNextEpoch(ctx);
    const paid = await ctx.s.send('claimSettlement', [det(1), pos.id], { from: HOLDER });
    assert.equal(ctx.s.events(paid, 'SettlementClaimed')[0].args.amount, m.cushion, 'paid from the Cushion at once');
    assert.ok(await covered(ctx));
  });

  test('I42 trigger 2: the floor draw and the measured balance each take the Cushion first; P counts the classes only', async (t) => {
    if (needModel(t)) return;
    const ctx = await book({ term: TERM.QUARTER, vested: false, vestFirst: true });
    await deposit(ctx, 10_000n * ONE);
    await F.declare(ctx, BigInt(ctx.chain.timestamp));
    const before = await classes(ctx);
    const res = await open2(ctx);
    const [ev] = ctx.s.events(res, 'Trigger2Drawn');
    const [cd] = ctx.s.events(res, 'CushionDrawn');
    const t2 = await ctx.s.call('declaration');
    const m = M.ark.trigger2Settlement([{ notional: 100n * ONE, vestingBps: 10000 }], 6000, before.j + before.s, t2.price, Number((await ctx.r.call('claimants')).att));
    assert.equal(t2.fullSettlement, m.fullSettlement, 'S_full is unmoved by the Cushion');
    assert.equal(ev.args.drawQrl, m.poolDraw, 'D_0 of S_full');
    const l = M.ark.layerDrawsOnPrincipal(m.poolDraw, 10_000n * ONE, before.j, before.s);
    assert.equal(cd.args.settlementId, T2_FLOOR);
    assert.equal(cd.args.amount, l.cushion);
    assert.equal(ev.args.drawJunior, l.junior);
    assert.equal(ev.args.drawSenior, l.senior);
    assert.equal(t2.drawn, m.poolDraw, 'drawn counts every part');
    assert.equal(t2.drawnByClass[0] + t2.drawnByClass[1], l.junior + l.senior, 'drawnByClass, which P reads, excludes the Cushion');

    // A deposit after the opening changes no figure fixed there and lowers what the classes bear next.
    const mid = await classes(ctx);
    await deposit(ctx, 2_000n * ONE);
    F.toEpoch(ctx, t2.epoch + 4n);
    // A collapse: the measured severity clamps at 6,835 bps, above D_0.
    await ctx.oracle.send('set', [PRICE_SCALE, PRICE_SCALE, PRICE_SCALE]);
    const r2 = await ctx.s.send('settleSeverity');
    const [b] = ctx.s.events(r2, 'Trigger2Drawn');
    const [bc] = ctx.s.events(r2, 'CushionDrawn');
    assert.ok(b.args.drawQrl > 0n, 'a measured severity above the floor draws a balance');
    const lb = M.ark.layerDrawsOnPrincipal(b.args.drawQrl, 2_000n * ONE, mid.j, mid.s);
    assert.equal(bc.args.settlementId, T2_BALANCE);
    assert.equal(bc.args.amount, lb.cushion, 'the balance takes the Cushion first too');
    assert.equal(b.args.drawJunior, lb.junior);
    const t3 = await ctx.s.call('declaration');
    assert.equal(t3.fullSettlement, t2.fullSettlement);
    // P and P_rem: the class draws only, at the opening's price (yellow paper §5.3).
    const [residual] = await ctx.r.call('recoveryResidual', [CHAIN_ID, ESCROW]);
    const P = (BigInt(t3.drawnByClass[0]) * PRICE_SCALE) / t3.price + (BigInt(t3.drawnByClass[1]) * PRICE_SCALE) / t3.price;
    assert.equal(residual, P, 'the Cushion takes no share of a recovery');
    assert.ok(residual < (t3.drawn * PRICE_SCALE) / t3.price, 'below the whole draw by the Cushion\'s part');
    assert.ok(await covered(ctx));
  });

  test('I42 a held balance holds the Cushion first, and the classes only for the rest', async (t) => {
    if (needModel(t)) return;
    const ctx = await book({ term: TERM.QUARTER, vested: false, vestFirst: true });
    await F.declare(ctx, BigInt(ctx.chain.timestamp));
    await open2(ctx);
    const t2 = await ctx.s.call('declaration');
    const mid = await classes(ctx);
    const room = (await ctx.bond.call('laneInfo', [CUSHION])).room;
    assert.ok(room > 0n);
    await deposit(ctx, room);
    F.toEpoch(ctx, t2.epoch + 4n);
    await ctx.oracle.send('setReverting', [true]);
    const res = await ctx.s.send('settleSeverity');
    const [h] = ctx.s.events(res, 'SeverityHeld');
    const held = M.ark.trigger2HeldPrincipal(t2.weight, 6000, t2.pool, t2.price, t2.capUnits);
    const l = M.ark.layerDrawsOnPrincipal(held, room, mid.j, mid.s);
    assert.equal(h.args.heldQrl, held, 'the whole balance is held');
    assert.equal(h.args.heldJunior, l.junior, 'the classes hold only what the Cushion does not');
    assert.equal(h.args.heldSenior, l.senior);
    assert.equal(h.args.heldQrl - h.args.heldJunior - h.args.heldSenior, l.cushion, 'held from the Cushion first');
    // The residual draw waits for the whole settlement.
    await assert.rejects(() => ctx.s.send('drawCushionResidual'), /DeclaredPendingSettlement/);
    F.toEpoch(ctx, t2.epoch + 4n + 8n);
    const fixed = await ctx.court.send('fixSeverity', [7000n]);
    const [fc] = ctx.s.events(fixed, 'CushionDrawn');
    assert.ok(fc && fc.args.amount > 0n, 'the court-fixed draw takes the Cushion first');
  });

  test('I42 the censorship ground does not draw the Cushion; a declaration on its remainder does', async (t) => {
    if (needModel(t)) return;
    const ctx = await book({ term: TERM.QUARTER, vested: false, vestFirst: true });
    await deposit(ctx, 5_000n * ONE);
    const G = det(0x6c);
    await ctx.court.send('open', [G]);
    await ctx.court.send('openSlices', [G, 2, 2]);
    await ctx.court.send('closeSlice', [G, 0, true, coder.encode(['uint256'], [0n])]);
    await ctx.court.send('closeSlice', [G, 1, false, coder.encode(['uint256'], [0n])]);
    await ctx.court.send('close', [G]);
    await ctx.r.send('recordClaimants', [[ctx.pos[0].id]]);
    const before = await classes(ctx);
    const res = await ctx.s.send('settleDeclaration');
    const [ev] = ctx.s.events(res, 'Trigger2Drawn');
    assert.ok(ev.args.drawQrl > 0n);
    assert.equal(ctx.s.events(res, 'CushionDrawn').length, 0, 'no Cushion on the censorship ground');
    assert.equal(ev.args.drawJunior + ev.args.drawSenior, ev.args.drawQrl, 'the classes alone');
    const c = M.ark.layerDrawsOnPrincipal(ev.args.drawQrl, 0n, before.j, before.s);
    assert.equal(ev.args.drawJunior, c.junior);
    assert.equal(await ctx.bond.call('cushion'), 5_000n * ONE);
    await assert.rejects(() => ctx.s.send('drawCushionResidual'), /DeclarationNotRatified/, 'no residual draw on the censorship ground alone');
    // A declaration ratified after it opens on the remainder: Cushion first.
    await ctx.qday.send('declare', [BigInt(ctx.chain.timestamp)]);
    await assert.rejects(() => ctx.s.send('drawCushionResidual'), /DeclarationNotRatified/, 'not before the remainder opens');
    const r = await ctx.s.send('settleDeclaration');
    const [rc] = ctx.s.events(r, 'CushionDrawn');
    assert.equal(rc.args.settlementId, T2_REMAINDER);
    const [rd] = ctx.s.events(r, 'Trigger2Drawn');
    assert.equal(rc.args.amount, min(rd.args.drawQrl, 5_000n * ONE));
  });
});

/* ------------------------------------------------------------------ */
/* The close of the Cushion                                            */
/* ------------------------------------------------------------------ */

describe('I42 the residual draw closes the Cushion after a declaration (yellow paper §4.5, technical reference §1.7)', () => {
  test('I42 bounded by the vested value less the draws, paid on W, entering no P, and the lane closes', async (t) => {
    if (needModel(t)) return;
    // One unit of notional, 10,000 QRL: the vested value binds below the Cushion.
    const ctx = await book({ term: TERM.QUARTER, vested: false, vestFirst: true, positions: [{ owner: HOLDER, notional: ONE }] });
    const pos = ctx.pos[0];
    await deposit(ctx, 15_000n * ONE);
    await assert.rejects(() => ctx.s.send('drawCushionResidual'), /DeclarationNotRatified/, 'nothing before a declaration');
    await F.declare(ctx, BigInt(ctx.chain.timestamp));
    await open2(ctx);
    await assert.rejects(() => ctx.s.send('drawCushionResidual'), /DeclaredPendingSettlement/, 'not while the window runs');
    const t2 = await ctx.s.call('declaration');
    F.toEpoch(ctx, t2.epoch + 4n);
    await ctx.s.send('settleSeverity');
    const t3 = await ctx.s.call('declaration');
    assert.equal(t3.stage, 3n, 'settled');
    const [P0] = await ctx.r.call('recoveryResidual', [CHAIN_ID, ESCROW]);
    const c0 = await ctx.bond.call('cushion');
    const amount = M.ark.cushionResidualDraw(c0, t3.weight, t3.price, t3.drawn);
    const value = (t3.weight * t3.price) / (BPS * PRICE_SCALE);
    assert.equal(amount, value - t3.drawn, 'the vested notional less the draws binds');
    assert.ok(amount < c0);

    const res = await ctx.s.send('drawCushionResidual', [], { from: ACCOUNTS.mallory });
    const [cd] = ctx.s.events(res, 'CushionDrawn');
    assert.equal(cd.args.settlementId, T2_CUSHION);
    assert.equal(cd.args.amount, amount);
    assert.equal(await ctx.bond.call('cushion'), c0 - amount, 'what lies above stays in the pool');
    const [P1] = await ctx.r.call('recoveryResidual', [CHAIN_ID, ESCROW]);
    assert.equal(P1, P0, 'it enters no P');
    assert.equal((await ctx.s.call('declaration')).drawn, t3.drawn + amount);
    // The lane is closed for good.
    assert.equal((await ctx.bond.call('laneInfo', [CUSHION])).open, false);
    await assert.rejects(() => deposit(ctx, ONE), /LaneClosed/);
    await assert.rejects(() => ctx.s.send('drawCushionResidual'), /LaneClosed/);
    assert.equal(await ctx.bond.call('laneTotal', [CUSHION]), 15_000n * ONE, 'the lifetime total survives the close');
    // Paid to the claimants by vested weight, through claimSettlement.
    F.toNextEpoch(ctx);
    const claim = await ctx.s.send('claimSettlement', [T2_CUSHION, pos.id], { from: HOLDER });
    const w = M.ark.trigger2VestedWeight({ notional: ONE, vestingBps: 10000 });
    assert.equal(ctx.s.events(claim, 'SettlementClaimed')[0].args.amount, M.ark.trigger2Entitlement(amount, t3.weight, { notional: ONE, vestingBps: 10000 }));
    assert.equal(w, t3.weight, 'one claimant holds the whole weight');
    assert.ok(await covered(ctx));
  });
});

/* ------------------------------------------------------------------ */
/* The thickness condition                                             */
/* ------------------------------------------------------------------ */

describe('I42 the thickness condition counts the Cushion to its ceiling (yellow paper §4.5)', () => {
  test('I42 the credit admits a senior subscription the bare junior refuses; a junior subscription is always admitted', async (t) => {
    if (needModel(t)) return;
    const ctx = await book();
    const add = 10_000n * ONE;
    assert.equal(M.ark.seniorSubscriptionAdmissible(70_000n * ONE, 30_000n * ONE, 0n, add, 7000, Number(C_MAX)), false);
    await assert.rejects(() => F.subscribe(ctx, { from: OTHER, class_: CLASS.SENIOR, value: add }), /JuniorTooThin/);
    await deposit(ctx, 7_000n * ONE);
    assert.equal(M.ark.seniorSubscriptionAdmissible(70_000n * ONE, 30_000n * ONE, 7_000n * ONE, add, 7000, Number(C_MAX)), true);
    await F.subscribe(ctx, { from: OTHER, class_: CLASS.SENIOR, value: add });
    await F.subscribe(ctx, { from: HOLDER, class_: CLASS.JUNIOR, value: ONE });
  });

  test('I42 the credit is capped at c_max of the pool after the subscription', async (t) => {
    if (needModel(t)) return;
    const ctx = await book();
    await deposit(ctx, 15_000n * ONE);
    // c_max to 750 bps, one step (technical reference §3.3), in force at the next boundary.
    await F.voteParams(ctx.params, { 'cushionCeilingBps@0': 750 }); // the cell of the phase in force (item 129)
    F.toNextEpoch(ctx);
    await ctx.bond.send('closeEpoch');
    assert.equal((await ctx.bond.call('laneInfo', [CUSHION])).room, 0n, 'above the new ceiling: no room, and nothing is returned');
    assert.equal(await ctx.bond.call('cushion'), 15_000n * ONE);
    const ok = 12_000n * ONE;
    const capped = 13_000n * ONE;
    const s = await classes(ctx);
    assert.equal(M.ark.seniorSubscriptionAdmissible(s.j, s.s, 15_000n * ONE, capped, 7000, 750), false);
    assert.equal(M.ark.seniorSubscriptionAdmissible(s.j, s.s, 15_000n * ONE, capped, 7000, 1500), true, 'the whole Cushion would admit it');
    await assert.rejects(() => F.subscribe(ctx, { from: OTHER, class_: CLASS.SENIOR, value: capped }), /JuniorTooThin/);
    assert.equal(M.ark.seniorSubscriptionAdmissible(s.j, s.s, 15_000n * ONE, ok, 7000, 750), true);
    await F.subscribe(ctx, { from: OTHER, class_: CLASS.SENIOR, value: ok });
  });
});

/* ------------------------------------------------------------------ */
/* No other path                                                       */
/* ------------------------------------------------------------------ */

describe('I42 no coupon, maturity, staking or pricing path reaches the Cushion', () => {
  test('I42 principalOwedNow counts the Cushion, so recall asks for a maturity the Cushion cannot pay', async () => {
    const ctx = await book({ term: TERM.QUARTER, vested: false });
    await ctx.bond.send('placeWithStaking', [await ctx.bond.call('unencumbered')]);
    const owed0 = await ctx.bond.call('principalOwedNow');
    await deposit(ctx, 15_000n * ONE);
    assert.equal(await ctx.bond.call('principalOwedNow'), owed0 + 15_000n * ONE, 'the Cushion is netted out of the bond\'s cover');
    // Past maturity: 100,000 due, all of it placed; the bond holds only the Cushion.
    const m = (await ctx.bond.call('holdingOf', [ctx.junior])).maturityEpoch;
    F.toEpoch(ctx, BigInt(m) + 1n);
    await F.distributeDue(ctx);
    const owed = await ctx.bond.call('principalOwedNow');
    const cushion = await ctx.bond.call('cushion');
    assert.equal(cushion, 15_000n * ONE);
    const res = await ctx.staking.send('recall', [10n ** 30n]);
    const [r] = ctx.staking.events(res, 'Recalled');
    assert.equal(r.args.amount, owed - cushion, 'the whole maturity is recalled; the Cushion pays none of it');
    await assert.rejects(() => ctx.bond.send('redeem', [ctx.junior], { from: HOLDER }), /PrincipalNotLiquid|NotLiquid|Insufficient/,
      'a redemption is not paid from the Cushion');
    assert.equal(await ctx.bond.call('cushion'), 15_000n * ONE);
  });

  test('I42 capacity, utilisation, cover and the outstanding principal the coupon divides on are unmoved by a deposit', async () => {
    const ctx = await book();
    const read = async () => [
      await ctx.registry.call('capacity'),
      await ctx.registry.call('utilisationBps'),
      await ctx.registry.call('coveredBps'),
      await ctx.bond.call('outstandingPrincipal'),
    ];
    const before = await read();
    await deposit(ctx, 15_000n * ONE);
    assert.deepEqual(await read(), before);
  });
});
